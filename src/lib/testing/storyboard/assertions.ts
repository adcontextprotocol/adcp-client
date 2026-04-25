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
  StoryboardInvariants,
  StoryboardRunOptions,
  StoryboardStepHint,
  StoryboardStepResult,
  StepInvariantsObject,
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
  /**
   * When true, the assertion runs on every storyboard unless explicitly
   * disabled via `storyboard.invariants.disable`. Defaults to `false` —
   * non-default assertions are opt-in through `invariants.enable` (object
   * form) or `invariants: [id, ...]` (legacy additive array form). The
   * bundled assertions in `default-invariants.ts` all set this to `true`
   * so forks and new specialisms inherit baseline cross-step gating
   * automatically; consumers registering custom assertions can opt in by
   * setting it on their own specs.
   */
  default?: boolean;
  onStart?(ctx: AssertionContext): void | Promise<void>;
  onStep?(
    ctx: AssertionContext,
    stepResult: StoryboardStepResult
  ): Omit<AssertionResult, 'assertion_id' | 'scope'>[] | Promise<Omit<AssertionResult, 'assertion_id' | 'scope'>[]>;
  onEnd?(
    ctx: AssertionContext
  ): Omit<AssertionResult, 'assertion_id' | 'scope'>[] | Promise<Omit<AssertionResult, 'assertion_id' | 'scope'>[]>;
  /**
   * Optional hook called by the runner immediately after `onStep` to collect
   * non-fatal `StoryboardStepHint`s. Unlike `onStep` results (which gate
   * pass/fail), hints are advisory — they survive even when the assertion
   * marks the step as failed, giving renderers structured fields to build
   * fix plans without parsing the prose `AssertionResult.error`.
   *
   * Implementations typically store pending hints in `ctx.state` during
   * `onStep` and retrieve + clear them here. The runner merges returned hints
   * into `StoryboardStepResult.hints[]` so they reach the same surface as
   * the `context_value_rejected` hints emitted by the rejection-hint detector.
   *
   * Called only when the assertion's `onStep` was also called for this step
   * (respects per-step `invariants.disable` opt-outs). Synchronous-only —
   * hint collection must be a pure state read, not an async operation.
   *
   * **Implementations MUST clear any pending hint state from `ctx.state` on
   * every `onStep` call** (both on violation and on clean passes) — not only
   * when a violation is detected. Failing to clear on a passing `onStep` would
   * leave stale state that `getStepHints` would then drain on the NEXT step,
   * emitting a hint that belongs to a prior step's violation. The `status.monotonic`
   * implementation clears `s.pendingHint = undefined` at the top of every
   * `onStep` call as the reference pattern.
   */
  getStepHints?(ctx: AssertionContext, stepResult: StoryboardStepResult): StoryboardStepHint[];
}

// ────────────────────────────────────────────────────────────
// Registry
// ────────────────────────────────────────────────────────────

const registry = new Map<string, AssertionSpec>();

export interface RegisterAssertionOptions {
  /**
   * Replace an existing registration for the same id instead of throwing.
   * Intended for consumers that want to override a default assertion shipped
   * by this package (e.g. a stricter `context.no_secret_echo`) without
   * clearing the whole registry and re-registering every other default.
   * Defaults to `false` so the throw-on-duplicate behaviour still catches
   * two modules fighting over the same id unintentionally.
   */
  override?: boolean;
}

/**
 * Register an assertion. Throws on duplicate id unless `options.override` is
 * set — re-registration is almost always a sign of two modules fighting over
 * the same id, not an intent to override. Consumers that want to replace a
 * default shipped by this package should pass `{ override: true }`.
 */
export function registerAssertion(spec: AssertionSpec, options: RegisterAssertionOptions = {}): void {
  if (!spec.id) throw new Error('registerAssertion: spec.id is required');
  if (registry.has(spec.id) && !options.override) {
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
 * List every assertion id registered with `default: true`. Used by
 * `resolveAssertions` to build the baseline set that applies when a
 * storyboard omits `invariants:` entirely or uses the object form's
 * `disable: [...]` escape hatch.
 */
export function listDefaultAssertions(): string[] {
  const out: string[] = [];
  for (const [id, spec] of registry) {
    if (spec.default) out.push(id);
  }
  return out;
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
 * Resolve a storyboard's `invariants` declaration to the ordered list of
 * `AssertionSpec`s the runner will drive. Every assertion registered with
 * `default: true` is in the result unless the object form explicitly
 * disables it; any ids supplied (legacy array form, or the object form's
 * `enable`) are merged in on top.
 *
 * Fails fast at runner start on:
 *   - any unknown id in the caller-supplied enable / legacy-array list,
 *   - any id in `disable` that is not registered as a default (typo guard —
 *     silently no-opping would mask real coverage gaps).
 *
 * The return order is: default specs (in registration order, with disabled
 * ones filtered out) followed by the enable / legacy-array specs in the
 * order the caller supplied them. Duplicates are collapsed.
 *
 * Accepts `string[]` (legacy additive form) and the `{ disable?, enable? }`
 * object form from `Storyboard.invariants`; `undefined` means "apply all
 * defaults". The looser `StoryboardInvariants | undefined` parameter type
 * exists so callers can forward `storyboard.invariants` directly.
 */
export function resolveAssertions(invariants: StoryboardInvariants | undefined): AssertionSpec[] {
  const { disable, enable } = normaliseInvariants(invariants);

  const resolved = new Map<string, AssertionSpec>();
  const defaultIds: string[] = [];
  for (const [id, spec] of registry) {
    if (!spec.default) continue;
    defaultIds.push(id);
    if (!disable.includes(id)) resolved.set(id, spec);
  }

  const unknownEnable: string[] = [];
  for (const id of enable) {
    const spec = registry.get(id);
    if (!spec) unknownEnable.push(id);
    else resolved.set(id, spec);
  }

  const defaultIdSet = new Set(defaultIds);
  const unknownDisable: string[] = disable.filter(id => !defaultIdSet.has(id));

  if (unknownEnable.length > 0 || unknownDisable.length > 0) {
    const lines: string[] = [];
    if (unknownEnable.length > 0) {
      const registered = [...registry.keys()].sort().join(', ') || '(none registered)';
      lines.push(
        `Storyboard references unregistered assertion${unknownEnable.length > 1 ? 's' : ''}: ${unknownEnable.join(', ')}. ` +
          suggestionClause(unknownEnable, [...registry.keys()]) +
          `Registered ids: ${registered}. ` +
          `Import the module that calls registerAssertion(...) for each id before running the storyboard.`
      );
    }
    if (unknownDisable.length > 0) {
      const known = defaultIds.slice().sort().join(', ') || '(none registered)';
      lines.push(
        `Storyboard invariants.disable names id${unknownDisable.length > 1 ? 's' : ''} that are not default-on: ${unknownDisable.join(', ')}. ` +
          suggestionClause(unknownDisable, defaultIds) +
          `Known default-on ids: ${known}. Non-default assertions don't need to be disabled — omit them instead.`
      );
    }
    throw new Error(lines.join(' '));
  }

  return [...resolved.values()];
}

interface NormalisedInvariants {
  disable: string[];
  enable: string[];
}

// Object form keys. Any other top-level key (common typo: `disabled`) is a
// silent-no-op trap under the permissive spread, so we catch it at parse-time.
const INVARIANTS_OBJECT_KEYS: ReadonlySet<string> = new Set(['disable', 'enable']);

// Step-level form accepts only `disable`. Enabling an assertion for one step
// has no coherent meaning (assertions reason across steps), so `enable` at
// this scope is a parse-time authoring error.
const STEP_INVARIANTS_OBJECT_KEYS: ReadonlySet<string> = new Set(['disable']);

/**
 * Validate every step's `invariants.disable` against the resolved assertion
 * set for this run, and against the storyboard-level disable. Throws on
 * unknown fields, unknown ids, and ids that are dead code because they're
 * already disabled storyboard-wide. Called once at runner start so
 * authoring mistakes surface before the first step runs.
 *
 * Accepts the resolved specs rather than the registry so a step can only
 * reference assertions that actually run for this storyboard — same
 * principle as the storyboard-level check.
 */
export function validateStepInvariants(storyboard: Storyboard, resolvedAssertions: AssertionSpec[]): void {
  const resolvedIds = new Set(resolvedAssertions.map(spec => spec.id));
  const storyboardDisable = new Set<string>();
  if (storyboard.invariants && !Array.isArray(storyboard.invariants)) {
    for (const id of storyboard.invariants.disable ?? []) storyboardDisable.add(id);
  }

  const problems: string[] = [];
  for (const phase of storyboard.phases) {
    for (const step of phase.steps) {
      const stepInvariants = step.invariants;
      if (!stepInvariants) continue;
      const unknownField = Object.keys(stepInvariants).filter(k => !STEP_INVARIANTS_OBJECT_KEYS.has(k));
      if (unknownField.length > 0) {
        problems.push(
          `Step "${step.id}" invariants has unknown field${unknownField.length > 1 ? 's' : ''}: ${unknownField.join(', ')}. ` +
            `Supported step-level fields are: ${[...STEP_INVARIANTS_OBJECT_KEYS].sort().join(', ')}.`
        );
        continue;
      }
      for (const id of stepInvariants.disable ?? []) {
        // Check the run-wide `disable` first — an id there is filtered out
        // of the resolved set, so without this the "dead code" case would
        // fall through to the more generic "not in resolved set" message.
        if (storyboardDisable.has(id)) {
          problems.push(
            `Step "${step.id}" invariants.disable names "${id}", but the storyboard already disables it run-wide. ` +
              `The step-level directive is dead code — remove one.`
          );
          continue;
        }
        if (!resolvedIds.has(id)) {
          const candidates = [...resolvedIds];
          const suggestion = suggestionClause([id], candidates);
          problems.push(
            `Step "${step.id}" invariants.disable names "${id}", which is not in the resolved assertion set for this run. ` +
              suggestion +
              `Resolved ids: ${candidates.sort().join(', ') || '(none)'}.`
          );
        }
      }
    }
  }

  if (problems.length > 0) throw new Error(problems.join(' '));
}

/**
 * Test whether a step's `invariants.disable` names the given assertion id.
 * Used by the runner to skip calling `onStep` for disabled invariants on
 * the step — a single choke point that keeps individual assertion code
 * unaware of the escape hatch.
 */
export function stepDisablesAssertion(stepInvariants: StepInvariantsObject | undefined, assertionId: string): boolean {
  if (!stepInvariants?.disable) return false;
  return stepInvariants.disable.includes(assertionId);
}

function normaliseInvariants(invariants: StoryboardInvariants | undefined): NormalisedInvariants {
  if (!invariants) return { disable: [], enable: [] };
  if (Array.isArray(invariants)) return { disable: [], enable: invariants };
  const unknown = Object.keys(invariants).filter(k => !INVARIANTS_OBJECT_KEYS.has(k));
  if (unknown.length > 0) {
    throw new Error(
      `Storyboard invariants has unknown field${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}. ` +
        `Supported fields are: ${[...INVARIANTS_OBJECT_KEYS].sort().join(', ')}.`
    );
  }
  return { disable: invariants.disable ?? [], enable: invariants.enable ?? [] };
}

/**
 * Render a `Did you mean "X"?` clause when one of the unknown ids has a
 * close Levenshtein match in the candidate set. Kept narrow (distance ≤ 2,
 * first hit wins) so typo suggestions don't bleed into legitimate near-
 * collisions between registered ids.
 */
function suggestionClause(unknown: string[], candidates: string[]): string {
  for (const id of unknown) {
    const hit = closestMatch(id, candidates);
    if (hit) return `Did you mean "${hit}"? `;
  }
  return '';
}

function closestMatch(input: string, candidates: string[]): string | null {
  let best: { id: string; distance: number } | null = null;
  for (const c of candidates) {
    const d = levenshtein(input, c);
    if (d === 0) continue;
    if (d > 2) continue;
    if (!best || d < best.distance) best = { id: c, distance: d };
  }
  return best ? best.id : null;
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length]!;
}
