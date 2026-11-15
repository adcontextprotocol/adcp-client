/**
 * Explains a failing storyboard verdict (adcp#8576).
 *
 * `overall_passed` can be false while every visible step passed: a
 * storyboard-scoped invariant broke, a required phase never executed, the
 * controller seeding it needed never ran, or the runner itself could not
 * proceed. Consumers then saw a bare "storyboard-level verdict failed". This
 * module reads the finished result and names the cause as structured fields
 * (`verdict_reason`, `verdict_detail`, `verdict_contributing`).
 *
 * It is a pure function of the result. It never changes the verdict, the
 * counts, or any track or bundle grade. The runner calls it on every result
 * it returns; consumers holding a result from an older runner can call it
 * themselves.
 */

import type {
  AssertionResult,
  Storyboard,
  StoryboardPhaseResult,
  StoryboardResult,
  StoryboardStepResult,
  StoryboardVerdictContributor,
  StoryboardVerdictReason,
} from './types';

export interface StoryboardVerdictExplanation {
  verdict_reason: StoryboardVerdictReason;
  verdict_detail: string;
  verdict_contributing: StoryboardVerdictContributor[];
}

export interface ExplainStoryboardVerdictOptions {
  /**
   * The storyboard definition, when available. Used to tell required phases
   * from optional ones; without it every phase that did not pass is treated
   * as required.
   */
  storyboard?: Pick<Storyboard, 'phases'>;
  /**
   * The runner's coverage verdict for request-signing storyboards. The
   * runner decides it (`signingCoverageUnverified`); this module only
   * reports it.
   */
  coverageUnverified?: boolean;
}

/** Synthetic phase the runner prepends for pre-flight `comply_test_controller` seeding. */
export const CONTROLLER_SEEDING_PHASE_ID = '__controller_seeding__';

/** Synthetic phases that carry fixture resolution or preparation failures. */
const FIXTURE_PHASE_IDS: ReadonlySet<string> = new Set(['fixture_resolution', 'prepared_fixtures_preparation_failed']);

/** Validation checks that report the host or runner refusing to proceed, not agent behavior. */
const RUNNER_ERROR_CHECKS: ReadonlySet<string> = new Set(['prepared_fixtures_authorization']);

/** Skip reasons that mean a controller or controller seeding was needed and unavailable. */
const CONTROLLER_SKIP_REASONS: ReadonlySet<string> = new Set(['missing_test_controller', 'controller_seeding_failed']);

/** Requirements whose absence is a controller prerequisite gap. */
const CONTROLLER_REQUIREMENTS: ReadonlySet<string> = new Set(['controller', 'seeded_state']);

/**
 * Skip reasons that never fail a required phase on their own. A phase holding
 * only these did not cause the verdict, so they are not named as causes.
 */
const NEUTRAL_SKIP_REASONS: ReadonlySet<string> = new Set([
  'not_applicable',
  'peer_branch_taken',
  'peer_substituted',
  'missing_test_kit_contract',
  'fixture_unavailable',
  'fixture_unsatisfied',
  'fixture_seed_unsupported',
  'capability_unsupported',
]);

/** Primary-reason precedence: the first reason with a contributor wins. */
const REASON_PRECEDENCE: readonly StoryboardVerdictReason[] = [
  'runner_error',
  'step_failed',
  'fixture_error',
  'assertion_failed',
  'controller_prerequisite_unmet',
  'required_phase_not_executed',
  'no_executed_steps',
  'coverage_unverified',
];

const MAX_CONTRIBUTORS = 20;
const MAX_MESSAGE_LENGTH = 300;
const MAX_DETAIL_LENGTH = 600;

interface PhaseView {
  phase: StoryboardPhaseResult;
  passIndex?: number;
}

/**
 * Explain why `result.overall_passed` is false. Returns `undefined` for a
 * passing result.
 */
export function explainStoryboardVerdict(
  result: StoryboardResult,
  options: ExplainStoryboardVerdictOptions = {}
): StoryboardVerdictExplanation | undefined {
  if (result.overall_passed) return undefined;

  const knownPhases = options.storyboard?.phases ?? [];
  const optionalPhaseIds = new Set(knownPhases.filter(phase => phase.optional === true).map(phase => phase.id));
  // With no required phase, the runner grades the optional phases themselves
  // (`optionalOnlyHasExecutedPass`), so they can carry the verdict.
  const optionalOnly = knownPhases.length > 0 && knownPhases.every(phase => phase.optional === true);
  const isOptionalPhase = (phaseId: string): boolean => optionalPhaseIds.has(phaseId);
  const phaseViews: PhaseView[] = result.passes?.length
    ? result.passes.flatMap(pass => pass.phases.map(phase => ({ phase, passIndex: pass.pass_index })))
    : result.phases.map(phase => ({ phase }));

  const contributors: StoryboardVerdictContributor[] = [];
  const add = (row: StoryboardVerdictContributor): void => {
    contributors.push(row);
  };

  // 1. Executed failures, split by who owns them. A failure in an optional
  // phase, or one marked `counts_toward_failure: false`, is not in
  // `failed_count`; it is held back and named below only when nothing more
  // specific (an assertion) carries it.
  const countedFailures = new Set<StoryboardStepResult>();
  const uncountedFailures: Array<{ view: PhaseView; step: StoryboardStepResult }> = [];
  for (const view of phaseViews) {
    const { phase, passIndex } = view;
    for (const step of phase.steps) {
      if (step.passed || step.skipped) continue;
      if (step.counts_toward_failure === false || isOptionalPhase(phase.phase_id)) {
        uncountedFailures.push({ view, step });
        continue;
      }
      countedFailures.add(step);
      add({
        kind: 'step',
        id: step.step_id,
        reason: classifyFailedStep(phase, step),
        status: 'failed',
        phase_id: phase.phase_id,
        ...(passIndex !== undefined && { pass_index: passIndex }),
        ...messageOf(step.error ?? firstFailedValidationMessage(step)),
      });
    }
  }

  // 2. Assertions no counted step carries.
  const assertionOwners = new Set<StoryboardStepResult>();
  for (const assertion of result.assertions ?? []) {
    if (assertion.passed) continue;
    const owner = assertion.scope === 'step' ? findOwningStep(result, phaseViews, assertion) : undefined;
    if (owner) assertionOwners.add(owner);
    if (owner && countedFailures.has(owner)) continue;
    add({
      kind: 'assertion',
      id: assertion.assertion_id,
      reason: 'assertion_failed',
      status: 'failed',
      ...(owner && { phase_id: owner.phase_id }),
      ...(assertion.pass_index !== undefined && { pass_index: assertion.pass_index }),
      ...messageOf(assertionMessage(assertion, owner)),
    });
  }

  // 2b. Uncounted failures in a phase that did not pass, when no assertion
  // already names them: the visible failed step is the cause. An optional
  // phase next to required ones is not graded, so its failures are named only
  // when nothing else explains the verdict (step 6).
  const namedUncounted = new Set<StoryboardStepResult>();
  const ungradedUncounted: Array<{ view: PhaseView; step: StoryboardStepResult }> = [];
  const uncountedRow = ({
    view,
    step,
  }: {
    view: PhaseView;
    step: StoryboardStepResult;
  }): StoryboardVerdictContributor => ({
    kind: 'step',
    id: step.step_id,
    reason: 'step_failed',
    status: 'failed',
    phase_id: view.phase.phase_id,
    ...(view.passIndex !== undefined && { pass_index: view.passIndex }),
    ...messageOf(step.error ?? firstFailedValidationMessage(step)),
  });
  for (const failure of uncountedFailures) {
    if (failure.view.phase.passed || assertionOwners.has(failure.step)) continue;
    if (isOptionalPhase(failure.view.phase.phase_id) && !optionalOnly) {
      ungradedUncounted.push(failure);
      continue;
    }
    namedUncounted.add(failure.step);
    add(uncountedRow(failure));
  }

  // 3. Graded phases that did not pass without a named failure inside.
  // Optional phases are graded only when the storyboard has no required one.
  let requiredPhaseHasExecutedPass = false;
  const vacuousSkips: Array<{ view: PhaseView; step: StoryboardStepResult }> = [];
  for (const view of phaseViews) {
    const { phase, passIndex } = view;
    if (isSyntheticPhase(phase.phase_id) || (isOptionalPhase(phase.phase_id) && !optionalOnly)) continue;
    if (phase.passed) {
      if (phase.steps.some(step => !step.skipped && step.passed)) requiredPhaseHasExecutedPass = true;
      for (const step of phase.steps) if (step.skipped) vacuousSkips.push({ view, step });
      continue;
    }
    if (phase.steps.some(step => countedFailures.has(step) || namedUncounted.has(step) || assertionOwners.has(step))) {
      continue;
    }
    const skipped = phase.steps.filter(step => step.skipped);
    const causal = skipped.filter(step => !NEUTRAL_SKIP_REASONS.has(detailedSkipReason(step) ?? ''));
    const named = causal.length > 0 ? causal : skipped;
    if (named.length === 0) {
      add({
        kind: 'phase',
        id: phase.phase_id,
        reason: 'required_phase_not_executed',
        status: 'not_passed',
        phase_id: phase.phase_id,
        ...(passIndex !== undefined && { pass_index: passIndex }),
        message: `Phase '${phase.phase_id}' did not pass`,
      });
      continue;
    }
    for (const step of named) add(skippedStepContributor(phase, step, passIndex));
  }

  // 4. Nothing failed or went unexecuted in a required phase, yet nothing ran either.
  if (contributors.length === 0 && !requiredPhaseHasExecutedPass) {
    const named = vacuousSkips.filter(({ step }) => !NEUTRAL_SKIP_REASONS.has(detailedSkipReason(step) ?? ''));
    for (const { view, step } of named.length > 0 ? named : vacuousSkips) {
      const row = skippedStepContributor(view.phase, step, view.passIndex);
      // A controller gap stays a controller gap: the seller lacking
      // comply_test_controller is why nothing ran.
      add(row.reason === 'required_phase_not_executed' ? { ...row, reason: 'no_executed_steps' } : row);
    }
    if (contributors.length === 0 && !options.coverageUnverified) {
      add({
        kind: 'phase',
        id: 'storyboard',
        reason: 'no_executed_steps',
        status: 'not_passed',
        message: 'No required step executed and passed',
      });
    }
  }

  // 5. Coverage-asserting storyboards that never reached the agent.
  if (options.coverageUnverified) {
    const probes = phaseViews.flatMap(({ phase, passIndex }) =>
      phase.steps.filter(step => step.skipped).map(step => ({ phase, step, passIndex }))
    );
    if (probes.length === 0) {
      add({
        kind: 'phase',
        id: 'storyboard',
        reason: 'coverage_unverified',
        status: 'not_passed',
        message: 'No request-signing probe reached the agent',
      });
    }
    for (const { phase, step, passIndex } of probes) {
      add({ ...skippedStepContributor(phase, step, passIndex), reason: 'coverage_unverified' });
    }
  }

  // 6. Last resort before `unexplained`: a failed optional step.
  if (contributors.length === 0) for (const failure of ungradedUncounted) add(uncountedRow(failure));

  const reason =
    REASON_PRECEDENCE.find(candidate => contributors.some(row => row.reason === candidate)) ?? 'unexplained';
  const bounded = contributors.slice(0, MAX_CONTRIBUTORS);
  return {
    verdict_reason: reason,
    verdict_detail: buildDetail(reason, contributors),
    verdict_contributing: bounded,
  };
}

/**
 * Return `result` with the verdict explanation fields set when it fails and
 * removed when it passes. Mutates and returns the same object.
 */
export function applyStoryboardVerdictExplanation<T extends StoryboardResult>(
  result: T,
  options: ExplainStoryboardVerdictOptions = {}
): T {
  delete result.verdict_reason;
  delete result.verdict_detail;
  delete result.verdict_contributing;
  const explanation = explainStoryboardVerdict(result, options);
  if (explanation) Object.assign(result, explanation);
  return result;
}

function classifyFailedStep(phase: StoryboardPhaseResult, step: StoryboardStepResult): StoryboardVerdictReason {
  if (step.validations.some(validation => !validation.passed && RUNNER_ERROR_CHECKS.has(validation.check))) {
    return 'runner_error';
  }
  if (phase.phase_id === CONTROLLER_SEEDING_PHASE_ID) return 'controller_prerequisite_unmet';
  if (FIXTURE_PHASE_IDS.has(phase.phase_id)) return 'fixture_error';
  return 'step_failed';
}

function skippedStepContributor(
  phase: StoryboardPhaseResult,
  step: StoryboardStepResult,
  passIndex: number | undefined
): StoryboardVerdictContributor {
  const skipReason = detailedSkipReason(step);
  const requirement = step.skip?.requirement;
  const controllerGap =
    (skipReason !== undefined && CONTROLLER_SKIP_REASONS.has(skipReason)) ||
    (requirement !== undefined && CONTROLLER_REQUIREMENTS.has(requirement));
  return {
    kind: 'step',
    id: step.step_id,
    reason: controllerGap ? 'controller_prerequisite_unmet' : 'required_phase_not_executed',
    status: 'skipped',
    phase_id: phase.phase_id,
    ...(passIndex !== undefined && { pass_index: passIndex }),
    ...(skipReason !== undefined && { skip_reason: skipReason }),
    ...(requirement !== undefined && { requirement }),
    ...messageOf(step.skip?.detail),
  };
}

function detailedSkipReason(step: StoryboardStepResult): string | undefined {
  return step.skip_reason ?? step.skip?.reason;
}

function isSyntheticPhase(phaseId: string): boolean {
  return phaseId === CONTROLLER_SEEDING_PHASE_ID || FIXTURE_PHASE_IDS.has(phaseId);
}

function findOwningStep(
  result: StoryboardResult,
  phaseViews: readonly PhaseView[],
  assertion: AssertionResult
): StoryboardStepResult | undefined {
  const phases =
    assertion.pass_index === undefined
      ? result.phases
      : phaseViews.filter(view => view.passIndex === assertion.pass_index).map(view => view.phase);
  for (const phase of phases) {
    const step = phase.steps.find(candidate => candidate.step_id === assertion.step_id);
    if (step) return step;
  }
  return undefined;
}

function assertionMessage(assertion: AssertionResult, owner: StoryboardStepResult | undefined): string {
  const base = assertion.error ?? assertion.description;
  if (owner?.skipped) return `${base} (on skipped step '${owner.step_id}')`;
  return base;
}

function firstFailedValidationMessage(step: StoryboardStepResult): string | undefined {
  const failed = step.validations.find(validation => !validation.passed);
  if (!failed) return undefined;
  return failed.error ? `${failed.description}: ${failed.error}` : failed.description;
}

function messageOf(text: string | undefined): { message?: string } {
  if (typeof text !== 'string') return {};
  const trimmed = text.replace(/\s+/g, ' ').trim();
  if (trimmed.length === 0) return {};
  return { message: truncate(trimmed, MAX_MESSAGE_LENGTH) };
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

const REASON_LEADS: Record<StoryboardVerdictReason, string> = {
  step_failed: 'A step failed',
  assertion_failed: 'A storyboard-level assertion failed',
  controller_prerequisite_unmet:
    'Required steps did not run because comply_test_controller or its seeding was unavailable',
  required_phase_not_executed: 'A required phase did not run',
  no_executed_steps: 'No required step executed and passed, so the run proves nothing',
  fixture_error: 'Fixture resolution or preparation failed before the behavior under test could run',
  coverage_unverified: 'No request-signing probe reached the agent, so signing coverage is unverified',
  runner_error: 'The runner or host could not proceed; this is not an agent failure',
  unexplained: 'The runner could not attribute this verdict; please report it as a runner bug',
};

function buildDetail(reason: StoryboardVerdictReason, contributors: readonly StoryboardVerdictContributor[]): string {
  const primary = contributors.filter(row => row.reason === reason);
  const parts: string[] = [REASON_LEADS[reason]];
  const described = primary.slice(0, 3).map(describeContributor);
  if (described.length > 0) parts[0] += `: ${described.join('; ')}`;
  if (primary.length > described.length) parts[0] += ` (+${primary.length - described.length} more)`;
  const others = REASON_PRECEDENCE.filter(
    candidate => candidate !== reason && contributors.some(row => row.reason === candidate)
  );
  if (others.length > 0) parts.push(`Also: ${others.join(', ')}`);
  if (contributors.length > MAX_CONTRIBUTORS) {
    parts.push(`${contributors.length - MAX_CONTRIBUTORS} contributor(s) omitted`);
  }
  return truncate(`${parts.map(stripTrailingPeriods).join('. ')}.`, MAX_DETAIL_LENGTH);
}

function stripTrailingPeriods(text: string): string {
  let out = text.trimEnd();
  while (out.endsWith('.')) out = out.slice(0, -1).trimEnd();
  return out;
}

function describeContributor(row: StoryboardVerdictContributor): string {
  const where = row.pass_index !== undefined ? ` (pass ${row.pass_index})` : '';
  if (row.kind === 'assertion') return `${row.id}${where}${row.message ? ` — ${row.message}` : ''}`;
  if (row.status === 'skipped') {
    const why = row.requirement
      ? `${row.skip_reason ?? 'skipped'}: ${row.requirement}`
      : (row.skip_reason ?? 'skipped');
    return `${row.id}${where} skipped (${why})`;
  }
  // A failed step's message can quote the agent's own response; the step row
  // already carries it, so the one-line detail names the step only.
  if (row.status === 'failed') return `${row.id}${where} failed`;
  return `${row.id}${where}${row.message ? ` — ${row.message}` : ''}`;
}
