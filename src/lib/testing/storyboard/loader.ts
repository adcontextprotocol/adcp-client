/**
 * Storyboard YAML parser.
 *
 * Storyboards are pulled from the compliance cache populated by
 * `npm run sync-schemas`. See `./compliance.ts` for capability-driven
 * resolution and bundle loading.
 */

import { readFileSync } from 'fs';
import { parse } from 'yaml';
import type { Storyboard } from './types';
import { MUTATING_TASKS } from '../../utils/idempotency';

/**
 * Supported `branch_set.semantics` values. Extend when AdCP adds `all_of`,
 * `at_least_n`, etc. Exported so the runner can enforce the same whitelist
 * on programmatically-constructed storyboards that bypass the YAML parser.
 */
export const BRANCH_SET_SEMANTICS = ['any_of'] as const;

/** Parse a YAML string into a Storyboard. Throws if required fields are missing. */
export function parseStoryboard(yamlContent: string): Storyboard {
  const parsed = parse(yamlContent) as Storyboard;
  if (!parsed?.id || !parsed?.phases) {
    throw new Error('Invalid storyboard YAML: missing required fields (id, phases)');
  }
  for (const phase of parsed.phases) {
    // Specialism YAMLs may declare a phase with no `steps:` — the steps are
    // synthesized at runtime from fixtures (see request-signing/synthesize.ts).
    // Treat missing steps as an empty list so the parser stays phase-agnostic.
    if (!phase.steps) phase.steps = [];
    // YAML uses `name:` for context outputs but our runtime expects `key:`.
    for (const step of phase.steps) {
      if (!step.context_outputs) continue;
      for (const output of step.context_outputs) {
        const raw = output as unknown as Record<string, unknown>;
        if (raw.name && !raw.key) {
          output.key = raw.name as string;
        }
      }
    }
  }
  validateStoryboardShape(parsed);
  return parsed;
}

/** Load and parse a single storyboard file. Useful for ad-hoc testing of in-development YAMLs. */
export function loadStoryboardFile(filePath: string): Storyboard {
  return parseStoryboard(readFileSync(filePath, 'utf-8'));
}

/**
 * Enforce authoring-time invariants on a Storyboard. Called by
 * `parseStoryboard`, and should also be called by any runner entry point
 * that accepts a programmatically-built `Storyboard` object so the same
 * loud-fail-on-drift guarantee holds regardless of how the storyboard was
 * constructed. Mutates steps (resolves `contributes: true` to
 * `contributes_to`) and is idempotent on already-validated inputs.
 */
export function validateStoryboardShape(storyboard: Storyboard): void {
  for (const phase of storyboard.phases) {
    validateBranchSet(storyboard.id, phase);
    if (!phase.steps) continue;
    for (const step of phase.steps) {
      resolveContributesShorthand(storyboard.id, phase, step);
      validateFixtureForMutatingStep(storyboard.id, phase, step);
      validateContextOutputs(storyboard.id, phase, step);
      validatePeerSubstitutesFor(storyboard.id, phase, step);
    }
  }
}

/**
 * Issue #820: mutating tasks (per {@link MUTATING_TASKS}) must have a
 * `sample_request` authored. The fixture is authoritative at run time —
 * there's no sane default payload for a write, and silently fabricating
 * one was the bug factory that produced #780 / #792 / #793 / #802 / #805.
 *
 * Error messages point at the task name, the step id, the storyboard, and
 * suggest the concrete author action.
 *
 * Opt-out: steps with `expect_error: true` that deliberately exercise
 * missing-fixture / malformed-payload seller behavior skip this check —
 * the author is signaling the payload is the test condition.
 *
 * Synthesized phases (`request-signing/synthesize.ts`, controller seeding)
 * start with `phase.steps = []` in YAML and the loader doesn't see the
 * runtime-generated steps, so those paths are not affected.
 */
function validateFixtureForMutatingStep(
  storyboardId: string,
  phase: Storyboard['phases'][number],
  step: Storyboard['phases'][number]['steps'][number]
): void {
  if (!MUTATING_TASKS.has(step.task)) return;
  if (step.sample_request !== undefined) return;
  if (step.expect_error === true) return;
  throw new Error(
    `[${storyboardId}] phase '${phase.id}' step '${step.id}' (task=${step.task}): ` +
      `mutating tasks require a sample_request fixture — the runner no longer fabricates ` +
      `write payloads. Author sample_request in the step or, for intentionally malformed ` +
      `payloads, set expect_error: true.`
  );
}

/**
 * Each `context_outputs` entry must declare exactly one source: either
 * `path` (extract from response) or `generate` (mint at run time). An entry
 * with neither is a silent no-op; one with both would silently pick `generate`
 * and ignore `path`. Both are authoring foot-guns that should fail loud.
 */
function validateContextOutputs(
  storyboardId: string,
  phase: Storyboard['phases'][number],
  step: Storyboard['phases'][number]['steps'][number]
): void {
  if (!step.context_outputs?.length) return;
  for (const output of step.context_outputs) {
    const hasPath = output.path !== undefined;
    const hasGenerate = output.generate !== undefined;
    if (!hasPath && !hasGenerate) {
      throw new Error(
        `[${storyboardId}] phase '${phase.id}' step '${step.id}': context_outputs entry ` +
          `'${output.key}' must set exactly one of 'path' or 'generate'.`
      );
    }
    if (hasPath && hasGenerate) {
      throw new Error(
        `[${storyboardId}] phase '${phase.id}' step '${step.id}': context_outputs entry ` +
          `'${output.key}' sets both 'path' and 'generate' — they are mutually exclusive.`
      );
    }
    // Validate generator name. The runtime resolver also checks but the loader
    // catches typos at storyboard-load time so authors see the failure on
    // build, not on the first run.
    if (hasGenerate && output.generate !== 'uuid_v4' && output.generate !== 'opaque_id') {
      throw new Error(
        `[${storyboardId}] phase '${phase.id}' step '${step.id}': context_outputs entry ` +
          `'${output.key}' has unknown generate value '${output.generate}'. ` +
          `Supported: 'uuid_v4', 'opaque_id'.`
      );
    }
  }
}

/**
 * Authoring-time validation for `peer_substitutes_for` (#1144). The runner
 * treats the field as same-phase-only and substitution-only-when-stateful;
 * surface those constraints at parse time so storyboard authors see typos
 * and cross-phase references on build, not as a silent no-rescue at run
 * time.
 *
 * Rules:
 *   - Each target must reference a step that exists in the same phase.
 *   - A step cannot substitute for itself.
 *   - The substitute step itself must be `stateful: true` — non-stateful
 *     passes don't establish state per the cascade contract.
 *   - The target step must be `stateful: true` — non-stateful targets
 *     don't participate in cascade gating, so a substitution declaration
 *     would be a no-op.
 */
function validatePeerSubstitutesFor(
  storyboardId: string,
  phase: Storyboard['phases'][number],
  step: Storyboard['phases'][number]['steps'][number]
): void {
  if (step.peer_substitutes_for === undefined) return;
  const targets = Array.isArray(step.peer_substitutes_for) ? step.peer_substitutes_for : [step.peer_substitutes_for];
  if (!step.stateful) {
    throw new Error(
      `[${storyboardId}] phase '${phase.id}' step '${step.id}': peer_substitutes_for is only legal on stateful steps`
    );
  }
  const phaseStepIds = new Map(phase.steps.map(s => [s.id, s]));
  for (const target of targets) {
    if (typeof target !== 'string' || target.length === 0) {
      throw new Error(
        `[${storyboardId}] phase '${phase.id}' step '${step.id}': peer_substitutes_for entries must be non-empty strings`
      );
    }
    if (target === step.id) {
      throw new Error(
        `[${storyboardId}] phase '${phase.id}' step '${step.id}': peer_substitutes_for cannot reference itself`
      );
    }
    const targetStep = phaseStepIds.get(target);
    if (!targetStep) {
      throw new Error(
        `[${storyboardId}] phase '${phase.id}' step '${step.id}': peer_substitutes_for target '${target}' is not a step in this phase (same-phase only)`
      );
    }
    if (!targetStep.stateful) {
      throw new Error(
        `[${storyboardId}] phase '${phase.id}' step '${step.id}': peer_substitutes_for target '${target}' must be stateful`
      );
    }
  }
}

function validateBranchSet(storyboardId: string, phase: Storyboard['phases'][number]): void {
  if (phase.branch_set === undefined) return;
  const bs = phase.branch_set as unknown;
  if (!bs || typeof bs !== 'object') {
    throw new Error(`[${storyboardId}] phase '${phase.id}': branch_set must be an object with { id, semantics }`);
  }
  const { id, semantics } = bs as Record<string, unknown>;
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error(`[${storyboardId}] phase '${phase.id}': branch_set.id must be a non-empty string`);
  }
  if (typeof semantics !== 'string' || semantics.length === 0) {
    throw new Error(`[${storyboardId}] phase '${phase.id}': branch_set.semantics must be a non-empty string`);
  }
  // Only `any_of` is defined in AdCP today (adcp#2646 lint rule 2 —
  // `at_least_n` and `all_of` are reserved but not defined). Reject unknown
  // values at parse rather than silently skipping grading at runtime, so
  // spec-drift typos fail loud instead of degrading to raw `failed` peers.
  if (!(BRANCH_SET_SEMANTICS as readonly string[]).includes(semantics)) {
    throw new Error(
      `[${storyboardId}] phase '${phase.id}': branch_set.semantics='${semantics}' is not supported (valid: ${BRANCH_SET_SEMANTICS.join(', ')})`
    );
  }
  // Schema constraint: every phase in a branch set MUST be optional. A
  // non-optional branch-set phase would fail the storyboard on any step
  // failure regardless of peer contribution, defeating the any_of gate.
  if (phase.optional !== true) {
    throw new Error(`[${storyboardId}] phase '${phase.id}': phases declaring branch_set must set 'optional: true'`);
  }
}

/**
 * Resolve the `contributes: true` boolean shorthand introduced alongside the
 * first-class `branch_set:` phase field (adcp-client#693, adcp#2646).
 *
 * Rules:
 *   - `contributes: true` is legal only inside a phase that declares `branch_set:`.
 *   - A step MUST NOT set both `contributes` and `contributes_to` (ambiguous).
 *   - A string `contributes_to` inside a branch_set phase MUST equal `branch_set.id`
 *     (otherwise the aggregation target drifts — same invariant the spec lint enforces).
 *
 * After resolution, `step.contributes_to` carries the flag name and `step.contributes`
 * is cleared, so the runner reads a single field regardless of authoring form.
 */
function resolveContributesShorthand(
  storyboardId: string,
  phase: Storyboard['phases'][number],
  step: Storyboard['phases'][number]['steps'][number]
): void {
  const hasBoolean = step.contributes !== undefined;
  const hasString = step.contributes_to !== undefined;

  if (hasBoolean && hasString) {
    throw new Error(`[${storyboardId}] step '${step.id}' declares both 'contributes' and 'contributes_to' — pick one`);
  }

  if (hasBoolean) {
    if (step.contributes === true) {
      if (!phase.branch_set) {
        throw new Error(
          `[${storyboardId}] step '${step.id}': 'contributes: true' is only legal inside a phase that declares branch_set`
        );
      }
      step.contributes_to = phase.branch_set.id;
    }
    delete step.contributes;
    return;
  }

  if (hasString && phase.branch_set && step.contributes_to !== phase.branch_set.id) {
    throw new Error(
      `[${storyboardId}] step '${step.id}': contributes_to='${step.contributes_to}' must equal enclosing phase's branch_set.id='${phase.branch_set.id}'`
    );
  }
}
