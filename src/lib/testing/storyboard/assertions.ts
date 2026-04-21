/**
 * Storyboard cross-step assertion registry.
 *
 * Storyboards express per-step checks inline (response_schema, field_value,
 * http_status, etc.). Assertions encode properties that must hold *across*
 * a whole run: idempotency dedup, governance denial never mutates, status
 * monotonic, context never echoes secrets on error. They're specialism- or
 * protocol-wide, so encoding them per-step duplicates path setup and
 * catches timing-dependent violations only by accident.
 *
 * Assertions are programmatic (TS), not declarative — the paths they walk,
 * the state they carry across steps, and the outcomes they report are too
 * varied for a uniform YAML schema. Storyboards reference them by id on
 * the top-level `invariants: [...]` array; the runner resolves the ids at
 * start and fails fast on unknowns.
 *
 * Registration is explicit: modules that define assertions call
 * `registerAssertion(...)` at import time, and the code driving `runStoryboard`
 * imports those modules before invoking the runner. No auto-discovery.
 *
 * See adcontextprotocol/adcp#2639 for the originating design.
 */

import type {
  AssertionResult,
  Storyboard,
  StoryboardRunOptions,
  StoryboardStepResult,
} from './types';

// ────────────────────────────────────────────────────────────
// Public types
// ────────────────────────────────────────────────────────────

/**
 * Context passed to every assertion callback. `state` is the assertion's
 * private scratch space for the current run — the runner constructs one
 * per-assertion, per-run, so separate assertions and separate runs never
 * see each other's state.
 */
export interface AssertionContext {
  storyboard: Storyboard;
  agentUrl: string;
  options: StoryboardRunOptions;
  state: Record<string, unknown>;
}

/**
 * An assertion definition. All three hooks are optional — most assertions
 * only need one (e.g. idempotency dedup observes `onStep`; governance
 * denial mutation-block may do an `onEnd` scan over prior step results).
 *
 * Hook semantics:
 *   - `onStart`: fires once after runner init, before the first step.
 *   - `onStep`: fires after each step completes (including skips). Return
 *     step-scoped `AssertionResult[]`; the runner appends each result's
 *     pass/fail into the step's `validations[]` under `check: "assertion"`
 *     AND into `StoryboardResult.assertions[]` with `scope: "step"`.
 *   - `onEnd`: fires once after the last phase, before `overall_passed` is
 *     computed. Return storyboard-scoped `AssertionResult[]`; they land in
 *     `StoryboardResult.assertions[]` with `scope: "storyboard"`.
 *
 * The runner flips `overall_passed` to false when any assertion fails —
 * that's what makes them gating conformance signal, not advisory output.
 */
export interface AssertionSpec {
  id: string;
  description: string;
  onStart?(ctx: AssertionContext): void | Promise<void>;
  onStep?(
    ctx: AssertionContext,
    stepResult: StoryboardStepResult
  ): Omit<AssertionResult, 'assertion_id' | 'scope'>[] | Promise<Omit<AssertionResult, 'assertion_id' | 'scope'>[]>;
  onEnd?(
    ctx: AssertionContext
  ): Omit<AssertionResult, 'assertion_id' | 'scope'>[] | Promise<Omit<AssertionResult, 'assertion_id' | 'scope'>[]>;
}

// ────────────────────────────────────────────────────────────
// Registry
// ────────────────────────────────────────────────────────────

const registry = new Map<string, AssertionSpec>();

/**
 * Register an assertion. Throws on duplicate id — re-registration is almost
 * always a sign of two modules fighting over the same id, not an intent to
 * override. Tests that want to replace a registration should call
 * `clearAssertionRegistry()` first.
 */
export function registerAssertion(spec: AssertionSpec): void {
  if (!spec.id) throw new Error('registerAssertion: spec.id is required');
  if (registry.has(spec.id)) {
    throw new Error(`registerAssertion: "${spec.id}" is already registered`);
  }
  registry.set(spec.id, spec);
}

/** Look up a registered assertion. Returns undefined if the id is unknown. */
export function getAssertion(id: string): AssertionSpec | undefined {
  return registry.get(id);
}

/** List every registered assertion id. Useful for diagnostics / tooling. */
export function listAssertions(): string[] {
  return [...registry.keys()];
}

/**
 * Remove all registrations. Scoped for tests — production runs rely on
 * module-init registration, and clearing the registry mid-run would break
 * any in-flight storyboard.
 */
export function clearAssertionRegistry(): void {
  registry.clear();
}

/**
 * Resolve a list of ids to their registered specs. Throws with a single
 * aggregated error naming every unknown id — fails fast at runner start
 * rather than silently dropping ids.
 */
export function resolveAssertions(ids: string[] | undefined): AssertionSpec[] {
  if (!ids || ids.length === 0) return [];
  const resolved: AssertionSpec[] = [];
  const missing: string[] = [];
  for (const id of ids) {
    const spec = registry.get(id);
    if (spec) resolved.push(spec);
    else missing.push(id);
  }
  if (missing.length > 0) {
    throw new Error(
      `Storyboard references unregistered assertion${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}. ` +
        `Import the module that calls registerAssertion(...) for each id before running the storyboard.`
    );
  }
  return resolved;
}
