/**
 * Storyboard execution engine.
 *
 * Two entry points:
 * - runStoryboard(): run all phases/steps sequentially
 * - runStoryboardStep(): run a single step (stateless, LLM-friendly)
 */

import { getOrCreateClient, getOrDiscoverProfile, runStep, type TestClient } from '../client';
import { closeConnections } from '../../protocols';
import { getCapturesFromError, withRawResponseCapture, type RawHttpCapture } from '../../protocols/rawResponseCapture';
import { executeStoryboardTask } from './task-map';
import {
  extractContextWithProvenance,
  injectContext,
  applyContextOutputsWithProvenance,
  applyContextInputs,
  forwardAliasCache,
  createRunnerVariables,
  type RunnerVariables,
} from './context';
import { detectContextRejectionHints } from './rejection-hints';
import { detectShapeDriftHints } from './shape-drift-hints';
import { detectStrictValidationHints } from './strict-validation-hints';
import { runValidations, type ValidationContext } from './validations';
import { enrichRequest, hasRequestEnricher } from './request-builder';
import { resolveAccount, resolveBrand } from '../client';
import { isMutatingTask, generateIdempotencyKey } from '../../utils/idempotency';
import { schemaAllowsTopLevelField } from '../../validation/schema-loader';
import {
  PROBE_TASKS,
  probeProtectedResourceMetadata,
  probeOauthAuthServerMetadata,
  rawMcpProbe,
  generateRandomInvalidApiKey,
  generateRandomInvalidJwt,
} from './probes';
import { validateTestKit } from './test-kit';
import { validateStoryboardShape } from './loader';
import { probeRequestSigningVector } from './request-signing/probe-dispatch';
import { createWebhookReceiver, type WebhookReceiver } from './webhook-receiver';
import { WEBHOOK_ASSERTION_TASKS, armWebhookAssertions, executeWebhookAssertionStep } from './webhook-assertions';
import { CONTROLLER_SEEDING_PHASE_ID, runControllerSeeding, type ControllerSeedingResult } from './seeding';

/**
 * Pre-computed controller-seeding outcome passed into `executeStoryboardPass`.
 * Populated by `runMultiPass` so seeding fires once at the run level instead
 * of once per pass (which would inflate `failed_count`/`skipped_count` when
 * the aggregator sums per-pass counts). `attach: true` on the first pass so
 * the synthetic `__controller_seeding__` phase appears in `phaseResults`
 * exactly once; subsequent passes inherit `allPassed` for cascade-skip
 * semantics but don't double-attach.
 */
interface PreSeededInput {
  result: ControllerSeedingResult | null;
  attach: boolean;
}
import type {
  A2ATaskEnvelope,
  AssertionResult,
  BranchSetSpec,
  ContextProvenanceEntry,
  HttpProbeResult,
  RunnerDetailedSkipReason,
  RunnerExtractionRecord,
  RunnerRequestRecord,
  RunnerResponseRecord,
  RunnerSkipReason,
  StepAuthDirective,
  Storyboard,
  StoryboardStep,
  StoryboardPhase,
  StoryboardContext,
  StoryboardRunOptions,
  StoryboardResult,
  StoryboardPassResult,
  StoryboardPhaseResult,
  StoryboardStepResult,
  StoryboardStepPreview,
  StrictValidationSummary,
  SchemaValidationError,
  ValidationResult,
} from './types';
import { DETAILED_SKIP_TO_CANONICAL } from './types';
import type { AgentProfile, TaskResult } from '../types';
import {
  type AssertionContext,
  type AssertionSpec,
  resolveAssertions,
  stepDisablesAssertion,
  validateStepInvariants,
} from './assertions';

// ────────────────────────────────────────────────────────────
// Runner-output contract helpers
// ────────────────────────────────────────────────────────────

const SKIP_DETAILS: Record<RunnerSkipReason, string> = {
  not_applicable: 'Not applicable: agent did not declare the protocol or specialism this storyboard targets.',
  no_phases: 'Storyboard has no executable phases (placeholder).',
  prerequisite_failed: 'Skipped: a prerequisite step or contract did not pass.',
  missing_tool: 'Skipped: agent did not advertise the required tool.',
  missing_test_controller:
    'Skipped: deterministic_testing phase requires comply_test_controller, which the agent did not advertise.',
  unsatisfied_contract: 'Skipped: test-kit contract is out of scope for this grading run.',
  peer_branch_taken: 'Skipped: a peer branch in the same any_of branch set already contributed the aggregation flag.',
};

const CONTROLLER_SEEDING_FAILED_DETAIL =
  'Skipped: pre-flight comply_test_controller seeding failed; the agent was not populated with the storyboard fixtures the remaining phases depend on.';

const OAUTH_NOT_ADVERTISED_DETAIL =
  'Skipped: agent does not advertise OAuth — /.well-known/oauth-protected-resource returned 404 (RFC 9728 §3). API-key path must carry auth_mechanism_verified for this storyboard to pass.';

/**
 * Per-reason override strings for detailed skip reasons that want a more
 * specific message than the canonical fallback. Used only when the probe
 * itself didn't emit an error-style detail.
 */
const DETAILED_SKIP_DETAILS: Partial<Record<RunnerDetailedSkipReason, string>> = {
  oauth_not_advertised: OAUTH_NOT_ADVERTISED_DETAIL,
  controller_seeding_failed: CONTROLLER_SEEDING_FAILED_DETAIL,
};

/**
 * Walk a dotted key path (e.g. `"adcp.idempotency.supported"`) through a
 * nested object. Returns `undefined` when any segment is missing or the
 * intermediate value is not an object — the caller treats `undefined` as
 * "path absent" and does NOT skip the storyboard (absence means the agent
 * hasn't explicitly opted out, so failing the storyboard surfaces the gap).
 *
 * Exported for direct testing. Inline copies of this logic in test code
 * silently drift from the runtime when edge cases (null prototypes,
 * Symbol keys, prototype-chain access) get tightened — testing the real
 * implementation forecloses that class of bug.
 */
export function resolveCapabilityPath(raw: unknown, dottedPath: string): unknown {
  const keys = dottedPath.split('.');
  let current: unknown = raw;
  for (const key of keys) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function buildSkip(reason: RunnerSkipReason, detail?: string): { reason: RunnerSkipReason; detail: string } {
  return { reason, detail: detail ?? SKIP_DETAILS[reason] };
}

/**
 * Resolve each phase's branch-set membership, combining explicit
 * `branch_set: { id, semantics }` declarations with the implicit detection
 * fallback the schema + adcp#2646 mandate: an `optional: true` phase with a
 * step declaring `contributes_to: <flag>` that matches a later
 * `assert_contribution check: any_of, allowed_values: [<flag>]` target is a
 * branch-set member even when the author hasn't migrated to the explicit
 * keyword. Explicit declarations take precedence. Returned map is keyed by
 * phase id; phases outside any branch set are absent from the map.
 *
 * First-match wins: if an optional phase has steps contributing to more
 * than one any_of flag, the earliest matching step (by storyboard
 * declaration order) decides the phase's branch-set membership. Authors
 * wanting a phase in multiple branch sets should declare `branch_set:`
 * explicitly — the implicit path does not synthesize multi-set membership.
 */
function resolveBranchSets(storyboard: Storyboard): Map<string, BranchSetSpec> {
  const resolved = new Map<string, BranchSetSpec>();
  for (const phase of storyboard.phases) {
    if (phase.branch_set) resolved.set(phase.id, phase.branch_set);
  }
  const anyOfFlags = new Set<string>();
  for (const phase of storyboard.phases) {
    for (const step of phase.steps) {
      if (step.task !== 'assert_contribution') continue;
      for (const v of step.validations ?? []) {
        if (v.check !== 'any_of') continue;
        for (const flag of v.allowed_values ?? []) {
          if (typeof flag === 'string') anyOfFlags.add(flag);
        }
      }
    }
  }
  for (const phase of storyboard.phases) {
    if (resolved.has(phase.id)) continue;
    if (!phase.optional) continue;
    for (const step of phase.steps) {
      if (!step.contributes_to) continue;
      if (!anyOfFlags.has(step.contributes_to)) continue;
      resolved.set(phase.id, { id: step.contributes_to, semantics: 'any_of' });
      break;
    }
  }
  return resolved;
}

/**
 * Re-grade non-contributing branch-set peers per the `any_of` semantics in
 * storyboard-schema.yaml ("Per-step grading in any_of branch patterns").
 *
 * Runs after the main phase loop because peer contribution status isn't
 * knowable until all peer phases have executed. For every phase in a
 * branch set (explicit `branch_set:` declaration or implicit detection via
 * `resolveBranchSets`) whose flag was contributed by a different phase,
 * this phase's raw step failures are moot — the agent took the other
 * branch. Each such failed step is rewritten to a skipped result with
 * `skip_reason: 'peer_branch_taken'` and the detail string the
 * runner-output-contract mandates:
 *
 *   "<flag> contributed by <peer_phase_id>.<peer_step_id> — <this_phase_id> is moot"
 *
 * The `<this_branch_id>` contract placeholder resolves to the non-chosen
 * peer's phase id — `branch_set.id` is shared across peers and could not
 * disambiguate. Only `any_of` semantics drives re-grading today; other
 * (reserved) values are rejected at parse in `validateBranchSet`.
 *
 * `countedAsFailed` names step results the main loop added to `failedCount`
 * as hard failures — either non-optional phases or the `presenceDetected`
 * PRM 2xx path (adcp-client#677: "an agent that serves PRM MUST serve it
 * correctly"). These stand: re-grading them would paper over the exact
 * invariants the hard-failure paths exist to enforce. The post-pass only
 * relabels swallowed optional-phase failures, which by construction are not
 * in `countedAsFailed`.
 */
function applyBranchSetGrading(
  phases: StoryboardPhase[],
  phaseResults: StoryboardPhaseResult[],
  branchSetByPhaseId: Map<string, BranchSetSpec>,
  contributions: Set<string>,
  contributionSources: Map<string, { phaseId: string; stepId: string }>,
  countedAsFailed: Set<StoryboardStepResult>
): { skippedDelta: number } {
  let skippedDelta = 0;
  for (let i = 0; i < phases.length; i++) {
    const phaseDef = phases[i];
    const phaseResult = phaseResults[i];
    if (!phaseDef || !phaseResult) continue;
    const branchSet = branchSetByPhaseId.get(phaseDef.id);
    if (!branchSet) continue;
    if (branchSet.semantics !== 'any_of') continue;
    const flag = branchSet.id;
    if (!contributions.has(flag)) continue;
    const source = contributionSources.get(flag);
    if (!source || source.phaseId === phaseDef.id) continue;
    const detail = `${flag} contributed by ${source.phaseId}.${source.stepId} — ${phaseDef.id} is moot`;
    let regraded = false;
    for (const step of phaseResult.steps) {
      if (step.passed || step.skipped) continue;
      if (countedAsFailed.has(step)) continue;
      step.passed = true;
      step.skipped = true;
      step.skip_reason = 'peer_branch_taken';
      step.skip = { reason: 'peer_branch_taken', detail };
      delete step.error;
      skippedDelta++;
      regraded = true;
    }
    if (regraded) {
      phaseResult.passed = phaseResult.steps.every(s => s.passed || s.skipped);
    }
  }
  return { skippedDelta };
}

function extractionFromTaskResult(taskResult: TaskResult | undefined): RunnerExtractionRecord {
  if (!taskResult) return { path: 'none' };
  // Prefer the explicit provenance stamped by the response unwrapper / raw
  // MCP probe. Fall back to inference only when the tag is missing (e.g.,
  // synthetic TaskResults built by validation harnesses).
  if (taskResult._extraction_path !== undefined) return { path: taskResult._extraction_path };
  if (!taskResult.success && taskResult.error) return { path: 'error' };
  return taskResult.data !== undefined && taskResult.data !== null ? { path: 'structured_content' } : { path: 'none' };
}

/**
 * Keys whose values must never appear verbatim in a compliance report.
 * Matching is case-insensitive and structural: any property whose final
 * path segment matches is replaced with `'[redacted]'` before the payload
 * is persisted on a step result. The contract spec calls for exactly this:
 * "Secrets SHOULD be redacted with the literal string '[redacted]'".
 */
const SECRET_KEY_PATTERN =
  /^(authorization|credentials?|token|api[_-]?key|password|secret|client[_-]secret|refresh[_-]token|access[_-]token|bearer|session[_-]token|session[_-]id|offering[_-]token|cookie|set[_-]cookie)$/i;

export function __redactSecretsForTest(value: unknown): unknown {
  return redactSecrets(value);
}

export function __filterResponseHeadersForTest(
  headers: Record<string, string> | undefined
): Record<string, string> | undefined {
  return filterResponseHeaders(headers);
}

export function __defaultAuthHeadersForRawProbeForTest(
  options: StoryboardRunOptions
): Record<string, string> | undefined {
  return defaultAuthHeadersForRawProbe(options);
}

function redactSecrets(value: unknown, depth = 0): unknown {
  if (depth > 32) return value; // cheap cycle guard
  if (Array.isArray(value)) return value.map(v => redactSecrets(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] =
        SECRET_KEY_PATTERN.test(k) && (typeof v === 'string' || typeof v === 'number')
          ? '[redacted]'
          : redactSecrets(v, depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * Response headers to echo on a RunnerResponseRecord. Everything else is
 * dropped — agents can (and do) include `set-cookie`, echoed `authorization`,
 * reverse-proxy breadcrumbs (`x-amz-*`, `x-azure-*`, `x-internal-*`) that a
 * hostile agent could use to bait us into publishing internal state in a
 * shared compliance report.
 */
const RESPONSE_HEADER_ALLOWLIST = new Set([
  'content-type',
  'content-length',
  'content-encoding',
  'www-authenticate',
  'location',
  'retry-after',
  'x-request-id',
  'x-correlation-id',
]);

function filterResponseHeaders(headers: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!headers) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (RESPONSE_HEADER_ALLOWLIST.has(k.toLowerCase())) out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// ────────────────────────────────────────────────────────────
// runStoryboard: execute all phases/steps
// ────────────────────────────────────────────────────────────

/**
 * Run an entire storyboard against an agent.
 *
 * Pass a single URL for the standard single-instance run. Pass an array of
 * URLs to engage multi-instance mode: the runner round-robins each step
 * across the provided URLs so that (brand, account)-scoped state created on
 * one instance must be visible on the next. Sellers whose state lives only
 * in-process will fail this mode — the failure signature is a prior write
 * succeeding on instance A while a subsequent read returns NOT_FOUND or
 * empty on instance B.
 */
export async function runStoryboard(
  agentUrlOrUrls: string | string[],
  storyboard: Storyboard,
  options: StoryboardRunOptions = {}
): Promise<StoryboardResult> {
  validateTestKit(options.test_kit);
  // Enforce authoring-time branch_set invariants regardless of how the
  // storyboard reached us. YAML callers already ran these rules in
  // parseStoryboard; programmatic callers (hand-built Storyboard objects or
  // alternative YAML loaders) reach this point without the loader having
  // fired, and the runtime's grading depends on the invariants holding.
  // `validateStoryboardShape` is idempotent so the double-pass is safe.
  validateStoryboardShape(storyboard);
  const agentUrls = Array.isArray(agentUrlOrUrls) ? agentUrlOrUrls : [agentUrlOrUrls];
  if (agentUrls.length === 0) {
    throw new Error('runStoryboard: at least one agent URL required');
  }
  const isMultiInstance = agentUrls.length > 1;
  if (isMultiInstance && options._client) {
    throw new Error(
      'runStoryboard: _client override is incompatible with multi-instance mode. ' +
        'Remove _client (or pass a single agent URL) to use round-robin dispatch.'
    );
  }

  const requestedStrategy = options.multi_instance_strategy ?? 'round-robin';
  if (requestedStrategy === 'multi-pass' && isMultiInstance) {
    // Webhook receivers bind a fresh ephemeral port per pass. Each pass would
    // advertise a different URL via `{{runner.webhook_base}}`; agents caching
    // the pass-1 URL would deliver into a dead port in pass 2. Reject rather
    // than silently mis-route. The spec-correct test for webhook retry /
    // idempotency is one pass.
    if (options.webhook_receiver) {
      throw new Error(
        'runStoryboard: webhook_receiver is incompatible with multi_instance_strategy: "multi-pass". ' +
          'Each pass would bind a fresh receiver URL, so agents caching the pass-1 URL would deliver ' +
          'to a dead port in pass 2. Use round-robin when the storyboard needs a webhook receiver, ' +
          'or run multi-pass on a storyboard without webhook observation.'
      );
    }
    return runMultiPass(agentUrls, storyboard, options);
  }
  return executeStoryboardPass(agentUrls, storyboard, options, 0);
}

/**
 * Build a minimal StoryboardResult for a storyboard skipped by a
 * `requires_capability` predicate. The single synthetic step carries
 * `skip_reason: 'capability_unsupported'` so CLI reports and JUnit
 * consumers render it as a skip rather than a pass or failure.
 */
function buildCapabilityUnsupportedResult(
  agentUrls: string[],
  storyboard: Storyboard,
  detail: string
): StoryboardResult {
  const syntheticStep: StoryboardStepResult = {
    storyboard_id: storyboard.id,
    step_id: 'capability_unsupported',
    phase_id: 'capability_unsupported',
    title: 'Storyboard skipped: capability not supported by this agent',
    task: '',
    passed: true,
    skipped: true,
    skip_reason: 'capability_unsupported',
    skip: { reason: 'unsatisfied_contract', detail },
    duration_ms: 0,
    validations: [],
    context: {},
    error: detail,
    extraction: { path: 'none' },
  };
  return {
    storyboard_id: storyboard.id,
    storyboard_title: storyboard.title,
    agent_url: agentUrls[0]!,
    overall_passed: true,
    phases: [
      {
        phase_id: 'capability_unsupported',
        phase_title: 'Capability unsupported',
        passed: true,
        steps: [syntheticStep],
        duration_ms: 0,
      },
    ],
    context: {},
    total_duration_ms: 0,
    passed_count: 0,
    failed_count: 0,
    skipped_count: 1,
    tested_at: new Date().toISOString(),
    strict_validation_summary: {
      observable: false,
      checked: 0,
      passed: 0,
      failed: 0,
      strict_only_failures: 0,
      lenient_also_failed: 0,
    },
  };
}

/**
 * Execute a single pass of the storyboard against the supplied replica URLs
 * using round-robin dispatch starting at `dispatchOffset`. Called directly
 * by `runStoryboard` (offset 0) and repeatedly by `runMultiPass` (offsets
 * 0..N-1). Taking the offset as an explicit parameter keeps the dispatcher
 * primitive out of the public `StoryboardRunOptions` type.
 */
async function executeStoryboardPass(
  agentUrls: string[],
  storyboard: Storyboard,
  options: StoryboardRunOptions,
  dispatchOffset: number,
  preSeeded?: PreSeededInput
): Promise<StoryboardResult> {
  const start = Date.now();
  const isMultiInstance = agentUrls.length > 1;

  // Build one client per URL. In single-URL mode `_client` (from comply()) is
  // honored so the shared MCP transport is reused across storyboards.
  const clients = agentUrls.map(url => getOrCreateClient(url, options));

  // Discover agent profile against the first instance; all instances are
  // expected to run the same code behind a shared state store, so one probe
  // is sufficient. For multi-instance runs, skipping N-1 redundant
  // get_agent_info calls also keeps CI output clean.
  let profile: AgentProfile | undefined;
  if (!options._client) {
    const discovered = await getOrDiscoverProfile(clients[0]!, options);
    profile = discovered.profile;
    // Populate agentTools from discovered profile if not already set
    if (!options.agentTools && profile?.tools) {
      options = { ...options, agentTools: profile.tools };
    }
  } else {
    profile = options._profile;
  }

  // Evaluate requires_capability predicate before any phase setup.
  // When the agent explicitly declared it doesn't support what this storyboard
  // tests (e.g. `adcp.idempotency.supported: false`), skip the whole storyboard
  // rather than producing a cascade of misleading per-phase failures.
  if (storyboard.requires_capability) {
    const rawCaps = profile?.raw_capabilities;
    if (rawCaps !== undefined) {
      const { path, equals } = storyboard.requires_capability;
      const actual = resolveCapabilityPath(rawCaps, path);
      // Absence semantics — load-bearing. `actual === undefined` means
      // the agent didn't declare the capability at all (field missing
      // from `get_adcp_capabilities` response). We deliberately RUN the
      // storyboard in that case rather than skip it: an agent that
      // pre-dates the capability field hasn't explicitly opted out, so
      // the storyboard's failures surface a real spec-coverage gap
      // (under-declared agent) rather than a behavior the agent
      // affirmatively refused. Skip ONLY when the agent declared a
      // value AND that value disagrees with the predicate.
      if (actual !== undefined && actual !== equals) {
        const detail =
          `Capability predicate \`${path} === ${JSON.stringify(equals)}\` not satisfied: ` +
          `agent declared ${JSON.stringify(actual)}.`;
        if (!options._client) await closeConnections(options.protocol);
        return buildCapabilityUnsupportedResult(agentUrls, storyboard, detail);
      }
    }
  }

  let context: StoryboardContext = { ...options.context };
  if (options.context) forwardAliasCache(options.context, context);
  const contributions = new Set<string>();
  // First phase/step that contributed each flag. Branch-set post-pass reads
  // this to emit the contract-mandated peer_branch_taken detail string
  // ("<flag> contributed by <peer_phase_id>.<peer_step_id> — …"). Only the
  // first contributor is recorded — downstream peers observing the same flag
  // are redundant and the contract calls out a single peer.
  const contributionSources = new Map<string, { phaseId: string; stepId: string }>();
  const priorStepResults = new Map<string, StoryboardStepResult>();
  const priorProbes = new Map<string, HttpProbeResult>();
  const contextProvenance = new Map<string, ContextProvenanceEntry>();
  const priorA2aEnvelopes = new Map<string, A2ATaskEnvelope>();
  const phaseResults: StoryboardPhaseResult[] = [];
  let passedCount = 0;
  let failedCount = 0;
  let skippedCount = 0;
  // Step results whose failures the main loop added to failedCount. The
  // branch-set post-pass decrements only for entries that were actually
  // counted, so an optional phase that hit `presenceDetected` (a PRM 2xx
  // inside an otherwise-optional phase) has its leak correctly reversed.
  const countedAsFailed = new Set<StoryboardStepResult>();

  // Start an ephemeral webhook receiver when the run opts in. The base URL
  // is exposed via `{{runner.webhook_base}}` / `{{runner.webhook_url:<id>}}`
  // substitutions so storyboards can inject per-step URLs into
  // `push_notification_config.url`. See adcontextprotocol/adcp#2431.
  const webhookReceiver = options.webhook_receiver
    ? await createWebhookReceiver({
        ...(options.webhook_receiver.mode && { mode: options.webhook_receiver.mode }),
        ...(options.webhook_receiver.host !== undefined && { host: options.webhook_receiver.host }),
        ...(options.webhook_receiver.port !== undefined && { port: options.webhook_receiver.port }),
        ...(options.webhook_receiver.public_url !== undefined && { public_url: options.webhook_receiver.public_url }),
      })
    : undefined;
  const runnerVars = createRunnerVariables({
    ...(webhookReceiver && { webhookBase: webhookReceiver.base_url }),
  });
  // Pre-arm retry-replay policies for any expect_webhook_retry_keys_stable
  // steps. Ordering matters: the receiver must be rejecting deliveries
  // before the triggering step fires its webhook, otherwise the first
  // delivery succeeds and the sender never retries.
  if (webhookReceiver) armWebhookAssertions(storyboard, runnerVars, webhookReceiver);

  // Flatten all steps for next-step preview lookups
  const allSteps = flattenSteps(storyboard);
  // Inner passes always dispatch round-robin; only the outer runMultiPass
  // caller knows about the multi-pass strategy. This keeps createDispatcher's
  // strategy parameter narrow.
  const dispatch = createDispatcher(agentUrls, clients, 'round-robin', dispatchOffset);

  // Resolve cross-step assertions declared on `storyboard.invariants`.
  // `resolveAssertions` throws on unknown ids — fail fast here rather than
  // silently skip, since a missing assertion means unknown conformance gaps.
  const assertions = resolveAssertions(storyboard.invariants);
  // Step-level `invariants.disable` uses the resolved set as its universe:
  // an id is only a valid step-level opt-out if it actually runs on this
  // storyboard. Typos and dead-code references (already disabled run-wide)
  // fail fast here for the same reason.
  validateStepInvariants(storyboard, assertions);
  const assertionContexts = new Map<string, AssertionContext>();
  for (const spec of assertions) {
    assertionContexts.set(spec.id, {
      storyboard,
      agentUrl: agentUrls[0]!,
      options,
      state: {},
    });
  }
  const assertionResults: AssertionResult[] = [];
  let assertionsFailed = false;
  for (const spec of assertions) {
    if (spec.onStart) await spec.onStart(assertionContexts.get(spec.id)!);
  }

  // Placeholder storyboards with no executable phases get a distinct skip
  // reason per the runner-output contract. Without this, the overall result
  // would pass vacuously — `passed_count === 0 && failed_count === 0` — and
  // an implementor reading the report can't tell "nothing tested" from
  // "everything passed".
  const hasExecutableSteps = storyboard.phases.some(p => p.steps.length > 0);
  if (!hasExecutableSteps) {
    const isScenarioComposed = (storyboard.requires_scenarios?.length ?? 0) > 0;
    const detail = isScenarioComposed
      ? `Storyboard "${storyboard.id}" has no local phases — its test surface is fully composed from the scenarios listed in \`requires_scenarios\`.`
      : `Storyboard "${storyboard.id}" has no executable phases — populate \`phases[].steps\` or remove the storyboard.`;
    const syntheticStep: StoryboardStepResult = {
      storyboard_id: storyboard.id,
      // Synthetic sentinel. Functionally non-colliding because downstream
      // consumers (CLI report, storyboard-tracks) key on `skip_reason`,
      // not `phase_id`/`step_id`. Matches the documented `RunnerSkipReason`
      // vocabulary in storyboard/types.ts.
      step_id: 'no_phases',
      phase_id: 'no_phases',
      title: 'Storyboard has no executable phases',
      task: '',
      passed: true,
      skipped: true,
      skip_reason: 'no_phases',
      skip: buildSkip('no_phases', detail),
      duration_ms: 0,
      validations: [],
      context,
      error: detail,
      extraction: { path: 'none' },
    };
    phaseResults.push({
      phase_id: 'no_phases',
      phase_title: 'No phases',
      passed: true, // skipped step is neutral — phase must not fail
      steps: [syntheticStep],
      duration_ms: 0,
    });
    skippedCount++;
  }

  // Pre-flight controller seeding (adcp-client#778). When the storyboard
  // declares `prerequisites.controller_seeding: true` and carries a
  // `fixtures:` block, fire the corresponding `seed_*` scenarios on
  // `comply_test_controller` so the seller's catalog / ledger holds every
  // fixture id the downstream phases reference. On any seed failure we
  // cascade-skip the remaining phases with `controller_seeding_failed` so
  // the report shows "setup broke" instead of a thicket of per-step
  // PRODUCT_NOT_FOUND / VALIDATION_ERROR failures. Runs against the first
  // client only: in multi-instance mode the seller is expected to share
  // state across replicas (that is what multi-instance tests exist to
  // verify). Sellers that hold per-replica state must opt out via
  // `skip_controller_seeding`.
  //
  // The seeding phase is held in a sidecar rather than pushed into
  // `phaseResults` up-front so every downstream consumer that indexes
  // `phaseResults[i]` against `storyboard.phases[i]` (branch-set grading,
  // `requiredPhasesPassed`) keeps working. It is spliced to the front of
  // `phaseResults` at the end so the report reads top-to-bottom in the
  // order the runner actually executed things.
  //
  // Multi-pass mode populates `preSeeded` so seeding fires exactly once
  // across all passes — see `runMultiPass`. Without the sidecar, every
  // pass would re-seed and the aggregator's cross-pass sum would inflate
  // `failed_count`/`skipped_count` by N when a single fixture broke.
  let seedingPhaseResult: StoryboardPhaseResult | null = null;
  let seedingFailed = false;
  let seedingMissingController = false;
  {
    const seeding =
      preSeeded !== undefined
        ? preSeeded.result
        : await runControllerSeeding(clients[0]!, storyboard, options, context);
    if (seeding) {
      const attach = preSeeded === undefined || preSeeded.attach;
      if (attach) {
        seedingPhaseResult = seeding.phase;
        passedCount += seeding.passedCount;
        failedCount += seeding.failedCount;
        if (seeding.missingController) skippedCount += seeding.phase.steps.length;
      }
      if (seeding.missingController) {
        seedingMissingController = true;
      } else if (!seeding.allPassed) {
        seedingFailed = true;
      }
    }
  }

  for (const phase of storyboard.phases) {
    const phaseStart = Date.now();
    const stepResults: StoryboardStepResult[] = [];
    let phasePassed = true;
    let statefulFailed = false;
    // PRM presence-probe state (adcp-client#677). `phaseAbsent` flips when
    // /.well-known/oauth-protected-resource returns 404 — subsequent steps
    // in this phase cascade-skip instead of failing their http_status:200
    // validations. `presenceDetected` flips when PRM returns a 2xx: the
    // agent IS advertising OAuth, so validation failures in this phase
    // become hard failures regardless of `optional: true`, closing the
    // spoofing path where a broken PRM + valid API key could silently pass.
    let phaseAbsent = false;
    let presenceDetected = false;

    if (shouldSkipPhase(phase, options)) {
      phaseResults.push({
        phase_id: phase.id,
        phase_title: phase.title,
        passed: true, // optional phase skipped — neutral
        steps: [],
        duration_ms: 0,
      });
      continue;
    }

    // Seeding-cascade skip: either the pre-flight seed phase failed (setup
    // break) or the agent doesn't advertise `comply_test_controller`
    // (coverage gap). Both paths emit skipped steps; the reasons differ so
    // compliance reports distinguish "agent misconfigured" from "agent not
    // graded against this storyboard". `controller_seeding_failed` is a
    // detailed reason mapped to canonical `prerequisite_failed`;
    // `missing_test_controller` is canonical on its own. Emits full step
    // rows (not an empty phase) so implementors see exactly which
    // buyer-side operations were elided.
    if (seedingMissingController || seedingFailed) {
      const cascadeSkip: Pick<StoryboardStepResult, 'skip_reason' | 'skip'> = seedingMissingController
        ? {
            skip_reason: 'missing_test_controller',
            skip: { reason: 'missing_test_controller', detail: SKIP_DETAILS.missing_test_controller },
          }
        : {
            skip_reason: 'controller_seeding_failed',
            skip: { reason: 'prerequisite_failed', detail: CONTROLLER_SEEDING_FAILED_DETAIL },
          };
      const cascadeSteps: StoryboardStepResult[] = phase.steps.map(step => ({
        storyboard_id: storyboard.id,
        step_id: step.id,
        phase_id: phase.id,
        title: step.title,
        task: step.task,
        passed: true,
        skipped: true,
        ...cascadeSkip,
        duration_ms: 0,
        validations: [],
        context,
        extraction: { path: 'none' },
      }));
      phaseResults.push({
        phase_id: phase.id,
        phase_title: phase.title,
        passed: true,
        steps: cascadeSteps,
        duration_ms: 0,
      });
      skippedCount += cascadeSteps.length;
      continue;
    }

    for (const step of phase.steps) {
      // Cascade-skip when the PRM presence probe declared the phase absent.
      if (phaseAbsent) {
        const cascadeResult: StoryboardStepResult = {
          storyboard_id: storyboard.id,
          step_id: step.id,
          phase_id: phase.id,
          title: step.title,
          task: step.task,
          passed: true,
          skipped: true,
          skip_reason: 'oauth_not_advertised',
          skip: { reason: 'not_applicable', detail: OAUTH_NOT_ADVERTISED_DETAIL },
          duration_ms: 0,
          validations: [],
          context,
          extraction: { path: 'none' },
        };
        stepResults.push(cascadeResult);
        priorStepResults.set(step.id, cascadeResult);
        skippedCount++;
        continue;
      }

      // Skip remaining steps if a stateful dependency failed
      if (statefulFailed && step.stateful) {
        const detail = 'Skipped: prior stateful step failed.';
        stepResults.push({
          storyboard_id: storyboard.id,
          step_id: step.id,
          phase_id: phase.id,
          title: step.title,
          task: step.task,
          passed: false,
          skipped: true,
          skip_reason: 'prerequisite_failed',
          skip: buildSkip('prerequisite_failed', detail),
          duration_ms: 0,
          validations: [],
          context,
          error: detail,
          extraction: { path: 'none' },
        });
        skippedCount++;
        phasePassed = false;
        continue;
      }

      const assignment = dispatch.nextFor(step);
      const rawResult = await executeStep(assignment.client, step, phase.id, context, allSteps, options, {
        contributions,
        priorStepResults,
        priorProbes,
        agentUrl: assignment.agentUrl,
        webhookReceiver,
        runnerVars,
        contextProvenance,
        priorA2aEnvelopes,
      });
      const result: StoryboardStepResult = { ...rawResult, storyboard_id: storyboard.id };
      if (isMultiInstance) {
        result.agent_url = assignment.agentUrl;
        result.agent_index = assignment.instanceIndex + 1;
      }
      stepResults.push(result);
      priorStepResults.set(step.id, result);

      // Fire per-step assertions. Each result is appended to the step's
      // `validations[]` under `check: "assertion"` so existing UI renders
      // them alongside inline checks, and mirrored into `assertionResults`
      // for the storyboard-level `assertions[]` surface. Any failure flips
      // `result.passed` so the counting below treats it like a validation
      // failure — that's what makes assertions gating, not advisory.
      for (const spec of assertions) {
        if (!spec.onStep) continue;
        // Per-step opt-out: authors use `step.invariants.disable: [id]` to
        // suppress a default invariant on a step that deliberately models
        // behavior the invariant would flag (validated at runner start).
        if (stepDisablesAssertion(step.invariants, spec.id)) continue;
        const raw = await spec.onStep(assertionContexts.get(spec.id)!, result);
        for (const r of raw) {
          const full: AssertionResult = { ...r, assertion_id: spec.id, scope: 'step', step_id: step.id };
          assertionResults.push(full);
          result.validations.push({
            check: 'assertion',
            passed: r.passed,
            description: `${spec.id}: ${r.description}`,
            ...(r.error !== undefined && { error: r.error }),
          });
          // Issue #935: assertions can attach a structured hint that the
          // runner mirrors into the owning step's `hints[]`. Today only
          // `status.monotonic` populates `hint`; the merge here keeps the
          // taxonomy unified so a single CLI/JUnit/Addie renderer can drive
          // off `step.hints[]` regardless of which subsystem produced it.
          if (r.hint) {
            const existing = result.hints ?? [];
            result.hints = [...existing, r.hint];
          }
          if (!r.passed) {
            result.passed = false;
            assertionsFailed = true;
          }
        }
      }

      // PRM presence accounting — must happen after the step result lands so
      // both the skipped-404 and 2xx paths are visible.
      if (step.task === 'protected_resource_metadata') {
        if (result.skipped && result.skip_reason === 'oauth_not_advertised') {
          phaseAbsent = true;
        } else {
          const status = (result.response as HttpProbeResult | undefined)?.status;
          if (typeof status === 'number' && status >= 200 && status < 300) {
            presenceDetected = true;
          }
        }
      }

      // Record contribution on success, honoring optional contributes_if predicate.
      if (!result.skipped && result.passed && step.contributes_to) {
        if (evalContributesIf(step.contributes_if, priorStepResults)) {
          const flag = step.contributes_to;
          if (!contributions.has(flag)) {
            contributionSources.set(flag, { phaseId: phase.id, stepId: step.id });
          }
          contributions.add(flag);
        }
      }

      if (result.skipped) {
        skippedCount++;
        context = result.context;
      } else if (result.passed) {
        context = result.context;
        passedCount++;
      } else {
        phasePassed = false;
        // Optional phases normally swallow step failures — the storyboard's
        // final assert_contribution gate decides pass/fail via the "API key
        // OR OAuth" logic. Exception: once a PRM presence probe has
        // detected the agent IS advertising OAuth, subsequent validation
        // failures in this phase are hard failures (adcp-client#677). An
        // agent that serves PRM MUST serve it correctly.
        if (!phase.optional || presenceDetected) {
          failedCount++;
          countedAsFailed.add(result);
        }
        if (step.stateful) statefulFailed = true;
        // In multi-instance mode, annotate the failure with the cross-instance
        // attribution block so CI readers pattern-match it as a deployment bug.
        if (isMultiInstance) {
          annotateMultiInstanceFailure(result, storyboard, stepResults);
        }
      }
    }

    phaseResults.push({
      phase_id: phase.id,
      phase_title: phase.title,
      passed: phasePassed,
      steps: stepResults,
      duration_ms: Date.now() - phaseStart,
    });
  }

  // Branch-set post-pass: phases in a branch set (explicit `branch_set:`
  // declaration or implicit detection via shared `contributes_to` + a later
  // any_of `assert_contribution`) whose flag was contributed by a peer have
  // their failed steps re-graded as skipped with `peer_branch_taken`. See
  // storyboard-schema.yaml (lines 205-223) and runner-output-contract.yaml
  // (reasons.peer_branch_taken). Done after all phases run — peer
  // contribution status isn't knowable inside the per-phase loop. Runs
  // before storyboard-scoped assertions so `onEnd` hooks see the finalized
  // per-step grades (a moot peer's "failure" should not trip a cross-step
  // invariant).
  const branchSetsByPhaseId = resolveBranchSets(storyboard);
  const branchSetDelta = applyBranchSetGrading(
    storyboard.phases,
    phaseResults,
    branchSetsByPhaseId,
    contributions,
    contributionSources,
    countedAsFailed
  );
  skippedCount += branchSetDelta.skippedDelta;

  // Fire storyboard-scoped assertions. These observe the full run and can
  // emit `scope: "storyboard"` findings that flip `overall_passed` without
  // being attributable to a single step (e.g. "saw >1 acquire for the same
  // replayed idempotency_key across the run").
  for (const spec of assertions) {
    if (!spec.onEnd) continue;
    const raw = await spec.onEnd(assertionContexts.get(spec.id)!);
    for (const r of raw) {
      assertionResults.push({ ...r, assertion_id: spec.id, scope: 'storyboard' });
      if (!r.passed) assertionsFailed = true;
    }
  }

  // Overall pass requires (a) no required-phase failures AND (b) at least one
  // required phase actually passed with at least one non-skipped step AND
  // (c) no assertion failures. Without (b) a storyboard where every phase is
  // marked optional and every required phase's steps are skipped (e.g.
  // required_tools filtered out everything) would pass vacuously. (c) makes
  // assertions gating — a run with all validations green but a cross-step
  // invariant broken is not conformant.
  // When no phases had executable steps the storyboard result is a skip, not a
  // failure. The index-aligned guard below would hit storyboard.phases[0] ===
  // undefined for an empty-phases storyboard and force requiredPhasesPassed to
  // false, flipping overall_passed to false. Short-circuit to true so the
  // no-phases sentinel produces overall_passed: true (consistent with how
  // buildNotApplicableStoryboardResult shapes its result in comply.ts).
  const requiredPhasesPassed =
    !hasExecutableSteps ||
    phaseResults.some((p, idx) => {
      const phaseDef = storyboard.phases[idx];
      if (!phaseDef || phaseDef.optional || !p.passed) return false;
      return p.steps.some(s => !s.skipped && s.passed);
    });
  // Prepend the pre-flight seeding phase now that every consumer that
  // index-aligns `phaseResults` with `storyboard.phases` has run. Reader
  // order matches execution order.
  if (seedingPhaseResult) phaseResults.unshift(seedingPhaseResult);
  const schemasUsed = collectSchemasUsed(phaseResults);
  const strictSummary = summarizeStrictValidation(phaseResults);
  const result: StoryboardResult = {
    storyboard_id: storyboard.id,
    storyboard_title: storyboard.title,
    agent_url: agentUrls[0]!,
    ...(isMultiInstance && { agent_urls: [...agentUrls] }),
    // Inner multi-pass passes surface as `round-robin` (that's what they are
    // individually); the aggregating wrapper relabels the top-level result
    // `multi-pass`.
    ...(isMultiInstance && { multi_instance_strategy: 'round-robin' as const }),
    overall_passed: failedCount === 0 && requiredPhasesPassed && !assertionsFailed,
    phases: phaseResults,
    context,
    total_duration_ms: Date.now() - start,
    passed_count: passedCount,
    failed_count: failedCount,
    skipped_count: skippedCount,
    tested_at: new Date().toISOString(),
    ...(schemasUsed.length > 0 ? { schemas_used: schemasUsed } : {}),
    ...(assertionResults.length > 0 ? { assertions: assertionResults } : {}),
    strict_validation_summary: strictSummary,
  };

  // Close protocol connections when the runner created its own client. The
  // connection pool is keyed by URL+auth, so a single closeConnections() call
  // evicts every instance's transport regardless of how many URLs we used.
  if (!options._client) {
    await closeConnections(options.protocol);
  }

  if (webhookReceiver) await webhookReceiver.close();

  return result;
}

/**
 * Run the storyboard N times — once per replica — with the round-robin
 * dispatcher starting at a different replica each pass. Lets each step hit
 * a different replica across passes, so a bug isolated to one replica
 * (stale config, divergent version, local cache miss) surfaces on the pass
 * that sends the relevant step there.
 *
 * Known limitation (follow-up adcontextprotocol/adcp-client#607 option 2):
 * for N=2, offset-shift preserves pair parity — a write→read pair whose
 * dispatch indices differ by an even amount lands same-replica in every
 * pass (the canonical property_lists case: write at step 0, read at step
 * 2). Cross-replica state-persistence testing at N=2 is primarily the job
 * of single-pass round-robin (which catches adjacent write→read pairs);
 * dependency-aware dispatch that reads `context_inputs` and assigns a
 * replica different from the writer of the specific state key being read
 * is the spec-aligned fix for non-adjacent pairs and should be preferred
 * over multi-pass for that purpose.
 *
 * The aggregated result AND-combines `overall_passed` across passes, sums
 * the pass/fail/skip counts, and exposes the per-pass detail via `passes[]`.
 * The top-level `phases` is the first pass's phases so single-pass consumers
 * keep working; richer consumers read `passes[]`.
 */
async function runMultiPass(
  agentUrls: string[],
  storyboard: Storyboard,
  options: StoryboardRunOptions
): Promise<StoryboardResult> {
  const start = Date.now();

  // Run pre-flight controller seeding ONCE at the run level (adcp-client#778)
  // so the aggregator doesn't sum N redundant seed batches into
  // `failed_count` / `skipped_count`. Every pass inherits the same outcome;
  // only the first pass attaches the synthetic `__controller_seeding__`
  // phase to its `phaseResults`, so the aggregated top-level counts reflect
  // a single seeding pass across the whole run.
  const preSeedClients = agentUrls.map(url => getOrCreateClient(url, options));
  const preSeedContext: StoryboardContext = { ...options.context };
  const preSeededResult = await runControllerSeeding(preSeedClients[0]!, storyboard, options, preSeedContext);

  const passes: StoryboardPassResult[] = [];
  const passResults: StoryboardResult[] = [];
  for (let passIdx = 0; passIdx < agentUrls.length; passIdx++) {
    const passSeeded: PreSeededInput = { result: preSeededResult, attach: passIdx === 0 };
    const result = await executeStoryboardPass(agentUrls, storyboard, options, passIdx, passSeeded);
    passResults.push(result);
    passes.push({
      pass_index: passIdx + 1,
      dispatch_offset: passIdx,
      overall_passed: result.overall_passed,
      phases: result.phases,
      passed_count: result.passed_count,
      failed_count: result.failed_count,
      skipped_count: result.skipped_count,
      duration_ms: result.total_duration_ms,
    });
  }

  const first = passResults[0]!;
  const overallPassed = passes.every(p => p.overall_passed);
  const passed = passes.reduce((sum, p) => sum + p.passed_count, 0);
  const failed = passes.reduce((sum, p) => sum + p.failed_count, 0);
  const skipped = passes.reduce((sum, p) => sum + p.skipped_count, 0);
  const schemasUsed = passResults.flatMap(r => r.schemas_used ?? []);
  const schemasDedup = [...new Map(schemasUsed.map(s => [s.schema_id, s])).values()];
  // Assertions are scoped per-pass — each pass's runner resolved them
  // independently and reported `assertion_id` identically. Concatenate so
  // readers see a per-pass timeline; de-duplicating would hide a real
  // "passed on pass 1, failed on pass 2" divergence.
  const assertionsAgg = passResults.flatMap(r => r.assertions ?? []);

  return {
    storyboard_id: storyboard.id,
    storyboard_title: storyboard.title,
    agent_url: agentUrls[0]!,
    agent_urls: [...agentUrls],
    multi_instance_strategy: 'multi-pass',
    overall_passed: overallPassed,
    phases: first.phases,
    passes,
    context: first.context,
    total_duration_ms: Date.now() - start,
    passed_count: passed,
    failed_count: failed,
    skipped_count: skipped,
    tested_at: new Date().toISOString(),
    ...(schemasDedup.length > 0 ? { schemas_used: schemasDedup } : {}),
    ...(assertionsAgg.length > 0 ? { assertions: assertionsAgg } : {}),
  };
}

/**
 * Collect a deduplicated list of schemas applied during this run. Drawn
 * from every validation result with a schema_id; dropping empties keeps
 * the list proportional to what actually ran.
 */
function collectSchemasUsed(phases: StoryboardPhaseResult[]): Array<{ schema_id: string; schema_url: string }> {
  const seen = new Set<string>();
  const out: Array<{ schema_id: string; schema_url: string }> = [];
  for (const phase of phases) {
    for (const step of phase.steps) {
      for (const v of step.validations) {
        if (v.schema_id && v.schema_url && !seen.has(v.schema_id)) {
          seen.add(v.schema_id);
          out.push({ schema_id: v.schema_id, schema_url: v.schema_url });
        }
      }
    }
  }
  return out;
}

/**
 * Walk every response_schema validation and aggregate the strict/lenient
 * delta. Always returns a summary; `observable: false` signals "run had
 * no strict-eligible checks" (distinct from strict-clean with zero
 * findings). See issue #820 follow-up.
 *
 * `checked` counts validations with a `strict` verdict attached.
 * `passed` / `failed` partition `checked` by `strict.valid`.
 * `strict_only_failures` = #(lenient-pass ∧ strict-fail) — the agent's
 * production-readiness gap.
 * `lenient_also_failed` = #(lenient-fail ∧ strict-fail) — step already
 * broken, strict-rejection isn't new signal.
 *
 * Exported so callers post-processing a `StoryboardResult` (dashboards,
 * CI formatters) can compute the same summary over a subset of phases
 * without re-running validation.
 */
/**
 * Flatten every `strict_only_failure` (lenient-pass ∧ strict-fail) into a
 * dashboard-friendly row list. Each row carries the step/phase context
 * needed for triage without re-walking the nested result tree:
 *
 *   { phase_id, step_id, task, variant, issues }
 *
 * Exported because the ValidationResult tree is four levels deep
 * (`phases[].steps[].validations[].strict.issues[]`) and a consumer
 * seeing `strict_only_failures: 7` in the summary needs a direct path
 * to the seven offending responses. This is that path.
 *
 * Returns `[]` on runs with no strict-only failures OR no AJV coverage
 * (both cases produce zero rows). Inspect `strict_validation_summary`
 * for the total counts.
 */
export function listStrictOnlyFailures(
  phases: StoryboardPhaseResult[]
): Array<{ phase_id: string; step_id: string; task: string; variant: string; issues: SchemaValidationError[] }> {
  const rows: Array<{
    phase_id: string;
    step_id: string;
    task: string;
    variant: string;
    issues: SchemaValidationError[];
  }> = [];
  for (const phase of phases) {
    for (const step of phase.steps) {
      for (const v of step.validations) {
        if (v.check !== 'response_schema') continue;
        if (v.strict === undefined) continue;
        if (v.strict.valid) continue;
        if (!v.passed) continue; // already counted by lenient path
        rows.push({
          phase_id: phase.phase_id,
          step_id: step.step_id,
          task: step.task,
          variant: v.strict.variant,
          issues: v.strict.issues ?? [],
        });
      }
    }
  }
  return rows;
}

export function summarizeStrictValidation(phases: StoryboardPhaseResult[]): StrictValidationSummary {
  let checked = 0;
  let passed = 0;
  let strictOnlyFailures = 0;
  for (const phase of phases) {
    for (const step of phase.steps) {
      for (const v of step.validations) {
        if (v.check !== 'response_schema' || v.strict === undefined) continue;
        checked++;
        if (v.strict.valid) {
          passed++;
        } else if (v.passed) {
          // Lenient Zod accepted this response; strict AJV rejected it.
          // That's the agent's strictness gap — the signal #820 wants.
          strictOnlyFailures++;
        }
      }
    }
  }
  const failed = checked - passed;
  return {
    observable: checked > 0,
    checked,
    passed,
    failed,
    strict_only_failures: strictOnlyFailures,
    lenient_also_failed: failed - strictOnlyFailures,
  };
}

// ────────────────────────────────────────────────────────────
// runStoryboardStep: execute a single step (stateless)
// ────────────────────────────────────────────────────────────

/**
 * Run a single storyboard step.
 *
 * This is the core primitive for stateless, LLM-friendly execution.
 * Context is passed in and returned, enabling step-by-step orchestration.
 */
export async function runStoryboardStep(
  agentUrl: string,
  storyboard: Storyboard,
  stepId: string,
  options: StoryboardRunOptions = {}
): Promise<StoryboardStepResult> {
  validateTestKit(options.test_kit);
  const client = getOrCreateClient(agentUrl, options);

  // Discover agent profile for standalone step execution
  if (!options._client) {
    await getOrDiscoverProfile(client, options);
  }

  const context: StoryboardContext = { ...options.context };
  if (options.context) forwardAliasCache(options.context, context);

  const webhookReceiver = options.webhook_receiver
    ? await createWebhookReceiver({
        ...(options.webhook_receiver.mode && { mode: options.webhook_receiver.mode }),
        ...(options.webhook_receiver.host !== undefined && { host: options.webhook_receiver.host }),
        ...(options.webhook_receiver.port !== undefined && { port: options.webhook_receiver.port }),
        ...(options.webhook_receiver.public_url !== undefined && { public_url: options.webhook_receiver.public_url }),
      })
    : undefined;
  const runnerVars = createRunnerVariables({
    ...(webhookReceiver && { webhookBase: webhookReceiver.base_url }),
  });
  if (webhookReceiver) armWebhookAssertions(storyboard, runnerVars, webhookReceiver);

  // Find the step
  const allSteps = flattenSteps(storyboard);
  const found = allSteps.find(s => s.step.id === stepId);
  if (!found) {
    if (webhookReceiver) await webhookReceiver.close();
    throw new Error(
      `Step "${stepId}" not found in storyboard "${storyboard.id}". ` +
        `Available steps: ${allSteps.map(s => s.step.id).join(', ')}`
    );
  }

  // Seed provenance from the caller-supplied map (threaded through from a
  // previous step's result). Storyboard-level runs build this internally;
  // here the caller owns accumulation across stateless invocations.
  const contextProvenance = new Map<string, ContextProvenanceEntry>(Object.entries(options.context_provenance ?? {}));
  const result = await executeStep(client, found.step, found.phaseId, context, allSteps, options, {
    contributions: new Set(),
    priorStepResults: new Map(),
    priorProbes: new Map(),
    agentUrl,
    webhookReceiver,
    runnerVars,
    contextProvenance,
    priorA2aEnvelopes: new Map(),
  });

  if (!options._client) {
    await closeConnections(options.protocol);
  }

  if (webhookReceiver) await webhookReceiver.close();

  return result;
}

// ────────────────────────────────────────────────────────────
// Internal: execute a single step
// ────────────────────────────────────────────────────────────

interface ExecutionState {
  contributions: Set<string>;
  priorStepResults: Map<string, StoryboardStepResult>;
  priorProbes: Map<string, HttpProbeResult>;
  agentUrl: string;
  /** Shared ephemeral webhook receiver, when the run has one enabled. */
  webhookReceiver?: WebhookReceiver;
  /** Shared runner-variable bag for `{{runner.*}}` substitution. */
  runnerVars?: RunnerVariables;
  /**
   * Context-key → write-provenance map, accumulated across the run so a
   * later step's rejection can cite the step that wrote the value. Issue
   * #870. Later writes shadow earlier ones under the same key, matching
   * the shallow-merge semantics of the context itself.
   */
  contextProvenance?: Map<string, ContextProvenanceEntry>;
  /**
   * Per-step A2A envelopes captured during the run, keyed by step id.
   * Cross-step A2A validators (`a2a_context_continuity`) read this to
   * compare consecutive `Task.contextId` values. The map is mutated
   * by `executeStep` after each step's capture; reads pick the most
   * recently inserted entry to seed `priorA2aEnvelope` on the
   * ValidationContext for the next step. Issue adcp-client#962.
   *
   * Map shared by reference across `executeStep` invocations — like
   * `priorStepResults`, this is the state that has to live one level
   * up from the per-step `ExecutionState` literal.
   */
  priorA2aEnvelopes?: Map<string, A2ATaskEnvelope>;
}

async function executeStep(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- client type varies (TestClient)
  client: any,
  step: StoryboardStep,
  phaseId: string,
  context: StoryboardContext,
  allSteps: FlatStep[],
  options: StoryboardRunOptions,
  state?: ExecutionState
): Promise<StoryboardStepResult> {
  // Default empty state when this function is called standalone (runStoryboardStep).
  const runState: ExecutionState = state ?? {
    contributions: new Set(),
    priorStepResults: new Map(),
    priorProbes: new Map(),
    agentUrl: '',
    contextProvenance: new Map(),
  };

  // HTTP probe tasks bypass the MCP client entirely.
  if (PROBE_TASKS.has(step.task)) {
    return executeProbeStep(step, phaseId, context, allSteps, options, runState);
  }

  // Webhook-assertion pseudo-tasks observe the shared receiver instead of
  // driving the agent. They never reach the MCP/A2A transport.
  if (WEBHOOK_ASSERTION_TASKS.has(step.task)) {
    return executeWebhookAssertionStep(step, phaseId, context, allSteps, options, runState);
  }

  // Resolve $test_kit.* task references before any downstream dispatch / skip checks.
  // When the reference resolves to nothing, fall back to `task_default`.
  const resolvedTask = resolveTaskName(step, options);
  if (!resolvedTask) {
    return {
      step_id: step.id,
      phase_id: phaseId,
      title: step.title,
      task: step.task,
      passed: false,
      duration_ms: 0,
      validations: [],
      context,
      error: `Step task "${step.task}" references a test-kit field that resolved to nothing and no task_default is set.`,
      extraction: { path: 'none' },
    };
  }
  const effectiveStep: StoryboardStep = resolvedTask === step.task ? step : { ...step, task: resolvedTask };

  // Check requires_tool — skip if agent doesn't have it
  if (step.requires_tool && options.agentTools && !options.agentTools.includes(step.requires_tool)) {
    const next = getNextStepPreview(step.id, allSteps, context, runState.runnerVars);
    const reason: RunnerSkipReason =
      step.requires_tool === 'comply_test_controller' ? 'missing_test_controller' : 'missing_tool';
    const detail =
      reason === 'missing_test_controller'
        ? `Deterministic-testing phase requires comply_test_controller; agent tools: [${(options.agentTools ?? []).join(', ')}].`
        : `Required tool "${step.requires_tool}" not advertised; agent tools: [${(options.agentTools ?? []).join(', ')}].`;
    return {
      step_id: step.id,
      phase_id: phaseId,
      title: step.title,
      task: step.task,
      passed: true,
      skipped: true,
      skip_reason: reason,
      skip: buildSkip(reason, detail),
      duration_ms: 0,
      validations: [],
      context,
      next,
      extraction: { path: 'none' },
    };
  }

  // Skip if agent doesn't implement the tool this step calls.
  if (options.agentTools && !options.agentTools.includes(effectiveStep.task)) {
    const next = getNextStepPreview(step.id, allSteps, context, runState.runnerVars);
    const detail = `Agent did not advertise tool "${effectiveStep.task}"; agent tools: [${(options.agentTools ?? []).join(', ')}].`;
    return {
      step_id: step.id,
      phase_id: phaseId,
      title: step.title,
      task: effectiveStep.task,
      passed: true,
      skipped: true,
      skip_reason: 'missing_tool',
      skip: buildSkip('missing_tool', detail),
      duration_ms: 0,
      validations: [],
      context,
      next,
      extraction: { path: 'none' },
    };
  }

  // Build request — priority (issue #820, fixture-authoritative):
  // 1. User-provided --request override
  // 2. For expect_error steps: sample_request directly (preserves intentionally invalid input)
  // 3. enrichRequest — fixture is the base, enricher fills gaps (fixture wins conflicts)
  // 4. sample_request with context injection when no enricher is registered
  // 5. Empty object (only reachable for non-mutating tasks with neither fixture nor enricher)
  let request: Record<string, unknown>;
  if (options.request) {
    request = { ...options.request };
  } else if (step.expect_error && step.sample_request) {
    request = injectContext({ ...step.sample_request }, context, runState.runnerVars);
  } else if (hasRequestEnricher(effectiveStep.task)) {
    request = enrichRequest(effectiveStep, context, options, runState.runnerVars);
  } else if (step.sample_request) {
    request = injectContext({ ...step.sample_request }, context, runState.runnerVars);
  } else {
    request = {};
  }

  // Apply explicit context_inputs on top of whatever request source was used
  if (step.context_inputs?.length) {
    request = applyContextInputs(request, step.context_inputs, context);
  }

  // Brand/account is a storyboard-run-scoped invariant: every step in a run
  // targets the same brand, so every outgoing request's brand context must
  // match the options. Enforcing this here (after builder + sample_request)
  // prevents session-key divergence across create/get/update/delete steps
  // when individual builders or sample_request YAML omit brand.
  request = applyBrandInvariant(request, options, effectiveStep.task);

  // Mutating AdCP requests require idempotency_key per spec. Storyboard
  // yamls generally omit it so authors don't have to remember it on every
  // mutating step — mint one here on the runner's behalf, matching how a
  // real buyer would operate. Suppressed when the step expects a missing-key
  // error (see `testsMissingIdempotencyKey` below) so that compliance
  // surfaces can still exercise the server's required-field check.
  request = applyIdempotencyInvariant(request, effectiveStep.task, step);

  // Detect unresolved $context placeholders — a prior step likely failed
  // and didn't produce the expected output. Skip rather than sending garbage.
  const unresolvedVars = findUnresolvedContextVars(request);
  if (unresolvedVars.length > 0 && !step.expect_error) {
    const next = getNextStepPreview(step.id, allSteps, context, runState.runnerVars);
    const detail = `Skipped: unresolved context variables from prior steps: ${unresolvedVars.join(', ')}.`;
    return {
      step_id: step.id,
      phase_id: phaseId,
      title: step.title,
      task: step.task,
      passed: false,
      skipped: true,
      skip_reason: 'prerequisite_failed',
      skip: buildSkip('prerequisite_failed', detail),
      duration_ms: 0,
      validations: [],
      context,
      error: detail,
      next,
      extraction: { path: 'none' },
    };
  }

  // Execute the task. When the step overrides auth, dispatch via the raw MCP
  // probe so we can (a) strip credentials or send arbitrary Bearer values
  // (which the SDK transport doesn't expose), and (b) capture the HTTP status
  // + `WWW-Authenticate` header for http_* validations.
  //
  // Tests for envelope validation on mutating tasks (e.g., "missing
  // idempotency_key returns INVALID_REQUEST") set `step.omit_idempotency_key`
  // to suppress both the runner's `applyIdempotencyInvariant` (above) and the
  // AdCP client's auto-inject — otherwise the SDK helpfully generates a UUID
  // and the server never sees a missing-key request. Paired flags so the two
  // layers agree; see `applyIdempotencyInvariant` for the runner-level skip.
  const testsMissingIdempotencyKey = step.omit_idempotency_key === true && isMutatingTask(effectiveStep.task);

  // Defense-in-depth for the missing-key vector: when a mutating step sets
  // `omit_idempotency_key: true` and `step.auth` is unset, route via
  // `rawMcpProbe` anyway so no SDK-layer normalization can slip a key onto the
  // wire. The SDK's `skipIdempotencyAutoInject` plumbing already honors this
  // flag, but the raw-HTTP path removes the escape hatch entirely. A2A and
  // oauth stay on the SDK path — their dispatch can't be replicated here
  // (A2A uses a different envelope; oauth needs refresh semantics).
  const rawProbeHeaders: Record<string, string> | undefined =
    step.auth !== undefined
      ? authHeadersForStep(step.auth, options)
      : testsMissingIdempotencyKey && options.protocol !== 'a2a'
        ? defaultAuthHeadersForRawProbe(options)
        : undefined;
  const useRawProbe = rawProbeHeaders !== undefined;

  let taskResult: TaskResult | undefined;
  let stepResult: { duration_ms: number; error?: string; passed: boolean };
  let httpResult: HttpProbeResult | undefined;
  let responseRecord: RunnerResponseRecord | undefined;
  let a2aEnvelope: A2ATaskEnvelope | undefined;

  if (useRawProbe) {
    const started = Date.now();
    try {
      const probe = await rawMcpProbe({
        agentUrl: runState.agentUrl,
        toolName: effectiveStep.task,
        args: request,
        headers: rawProbeHeaders,
        allowPrivateIp: options.allow_http === true,
      });
      httpResult = probe.httpResult;
      taskResult = probe.taskResult;
      const durationMs = Date.now() - started;
      stepResult = {
        duration_ms: durationMs,
        passed: !httpResult.error,
        error: httpResult.error,
      };
      const filteredHeaders = filterResponseHeaders(httpResult.headers);
      responseRecord = {
        transport: 'mcp',
        payload: redactSecrets(httpResult.body),
        ...(typeof httpResult.status === 'number' ? { status: httpResult.status } : {}),
        ...(filteredHeaders && { headers: filteredHeaders }),
        duration_ms: durationMs,
      };
    } catch (err) {
      stepResult = {
        duration_ms: Date.now() - started,
        passed: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  } else {
    // For A2A runs, wrap the SDK dispatch in `withRawResponseCapture`
    // so storyboard validations can assert on the JSON-RPC `Task`
    // envelope the seller emitted (e.g. `a2a_submitted_artifact`
    // checks `Task.state` + `artifact.metadata.adcp_task_id` placement).
    // MCP path stays unwrapped — the SDK envelope is reconstructed from
    // `taskResult` already and capture would only add overhead.
    //
    // Selection note: gate on `options.protocol === 'a2a'` because
    // that's the only signal available at this point — discovery
    // hasn't run yet in `runStoryboardStep` (the runner branches off
    // `agentTools` later). If a future "auto-detect protocol" flow
    // lands, key the capture off the negotiated transport instead.
    const captureA2a = options.protocol === 'a2a';
    let a2aCaptures: RawHttpCapture[] | undefined;
    const dispatch = () =>
      executeStoryboardTask(client, effectiveStep.task, request, {
        skipIdempotencyAutoInject: testsMissingIdempotencyKey,
      });
    const run = await runStep(step.title, effectiveStep.task, async () => {
      if (!captureA2a) return dispatch();
      try {
        const { result: dispatchResult, captures } = await withRawResponseCapture(dispatch);
        a2aCaptures = captures;
        return dispatchResult;
      } catch (err) {
        // `withRawResponseCapture` attaches partial captures to the
        // thrown error so we still get the wire-shape envelope when
        // the SDK threw mid-parse (e.g. agent emitted malformed JSON).
        // Bare-throw cases (network errors, no captures attached)
        // leave `a2aCaptures` undefined and the validator self-skips.
        const partial = getCapturesFromError(err);
        if (partial) a2aCaptures = partial;
        throw err;
      }
    });
    taskResult = run.result;
    stepResult = run.step;
    if (captureA2a && a2aCaptures) {
      a2aEnvelope = parseLastA2aMessageSendCapture(a2aCaptures);
    }
    if (taskResult) {
      responseRecord = {
        transport: options.protocol === 'a2a' ? 'a2a' : 'mcp',
        payload: redactSecrets(taskResult.data ?? taskResult.error ?? null),
        duration_ms: stepResult.duration_ms,
      };
    }
  }

  const requestRecord: RunnerRequestRecord = {
    transport: useRawProbe ? 'mcp' : options.protocol === 'a2a' ? 'a2a' : 'mcp',
    operation: effectiveStep.task,
    payload: redactSecrets(request),
    ...(runState.agentUrl ? { url: runState.agentUrl } : {}),
  };

  // Feature-unsupported or unknown-tool errors → treat as skip
  const isUnsupported = stepResult.error?.includes('does not support:');
  const isUnknownTool = stepResult.error && /Unknown tool[:\s]/i.test(stepResult.error);
  if (!taskResult && (isUnsupported || isUnknownTool)) {
    const next = getNextStepPreview(step.id, allSteps, context, runState.runnerVars);
    const reason: RunnerSkipReason = isUnknownTool ? 'missing_tool' : 'not_applicable';
    const detail = isUnknownTool
      ? `Agent rejected tool "${effectiveStep.task}" as unknown: ${stepResult.error}`
      : `Agent reported feature not supported: ${stepResult.error}`;
    return {
      step_id: step.id,
      phase_id: phaseId,
      title: step.title,
      task: step.task,
      passed: true,
      skipped: true,
      skip_reason: reason,
      skip: buildSkip(reason, detail),
      duration_ms: stepResult.duration_ms,
      validations: [],
      context,
      error: stepResult.error,
      next,
      extraction: { path: 'none' },
    };
  }

  // For expect_error steps where TaskResult has no data but has an error string,
  // wrap the error string so validations have something to check against.
  if (step.expect_error && !taskResult?.data && taskResult?.error) {
    taskResult = { ...taskResult, data: { error: taskResult.error } };
  }

  // Determine pass/fail — inverted when expect_error is set
  let passed: boolean;
  if (step.expect_error) {
    // Step passes when the task fails (returns an error)
    passed = !taskResult?.success || !!stepResult.error;
  } else {
    passed = stepResult.passed && (taskResult?.success ?? false);
  }

  // Run validations. Resolve `$context.<key>` placeholders in `value` and
  // `allowed_values` fields so expected values can reference prior steps
  // (e.g., replay tests assert `media_buy_id === $context.initial_media_buy_id`).
  let validations: ValidationResult[] = [];
  if (step.validations?.length && (taskResult || httpResult)) {
    const resolvedValidations = step.validations.map(v => {
      const resolved = { ...v };
      if (resolved.value !== undefined) {
        resolved.value = injectContext({ __v: resolved.value }, context, runState.runnerVars).__v;
      }
      if (Array.isArray(resolved.allowed_values)) {
        resolved.allowed_values = resolved.allowed_values.map(
          av => injectContext({ __v: av }, context, runState.runnerVars).__v
        );
      }
      return resolved;
    });
    const vctx: ValidationContext = {
      taskName: effectiveStep.task,
      ...(taskResult && { taskResult }),
      ...(httpResult && { httpResult }),
      agentUrl: runState.agentUrl,
      contributions: runState.contributions,
      ...(effectiveStep.response_schema_ref && { responseSchemaRef: effectiveStep.response_schema_ref }),
      request: requestRecord,
      ...(responseRecord && { response: responseRecord }),
      storyboardContext: context,
      ...(a2aEnvelope && { a2aEnvelope }),
      ...(() => {
        // Walk back through the run's captured A2A envelopes and use
        // the most recent prior step's envelope as the comparison
        // baseline. The map preserves insertion order, so the last
        // entry is the most recent prior step's capture.
        const map = runState.priorA2aEnvelopes;
        if (!map || map.size === 0) return {};
        let priorStepId: string | undefined;
        let priorEnv: A2ATaskEnvelope | undefined;
        for (const [stepId, env] of map) {
          priorStepId = stepId;
          priorEnv = env;
        }
        return {
          ...(priorEnv && { priorA2aEnvelope: priorEnv }),
          ...(priorStepId && { priorA2aStepId: priorStepId }),
        };
      })(),
    };
    validations = runValidations(resolvedValidations, vctx);
  }

  const allValidationsPassed = validations.every(v => v.passed);

  // Persist the captured A2A envelope keyed by step id so cross-step
  // validators (`a2a_context_continuity`) on subsequent steps can
  // compare against it. Only fires when this step actually captured
  // an envelope — probe steps, MCP steps, and capture-bypass paths
  // don't insert, so cross-step comparisons walk back to the most
  // recent A2A step automatically via insertion-order iteration.
  if (a2aEnvelope && runState.priorA2aEnvelopes) {
    runState.priorA2aEnvelopes.set(step.id, a2aEnvelope);
  }

  // Extract context from responses. Forward the alias cache so
  // `$generate:uuid_v4#<alias>` placeholders in subsequent steps resolve
  // to the same UUID as prior steps with the same alias.
  const updatedContext = { ...context };
  forwardAliasCache(context, updatedContext);
  const hasData = taskResult?.data !== undefined && taskResult?.data !== null;

  // Convention-based extraction (for non-error steps, or when expect_error succeeded)
  if (passed && hasData && taskResult) {
    const extracted = extractContextWithProvenance(effectiveStep.task, taskResult.data, step.id);
    Object.assign(updatedContext, extracted.values);
    if (runState.contextProvenance) {
      for (const [key, entry] of Object.entries(extracted.provenance)) {
        runState.contextProvenance.set(key, entry);
      }
    }
  }

  // Explicit context_outputs. `generate:` entries fire unconditionally —
  // including on failed steps — because the generated ID was already
  // determined (and may already be inline-substituted via $generate:…#<key>)
  // before the request went out. Propagating it even on failure lets the
  // next step use the same ID for a forced-completion or tasks/get follow-up.
  // `path:` entries are gated on a non-null response and skip silently when
  // data is absent. Both paths write into updatedContext and receive
  // updatedContext for alias-cache coherence — forwardAliasCache above
  // ensures the minted value from any same-step $generate:…#<key> inline
  // substitution is visible here.
  if (step.context_outputs?.length) {
    const explicit = applyContextOutputsWithProvenance(
      hasData && taskResult ? taskResult.data : undefined,
      step.context_outputs,
      step.id,
      effectiveStep.task,
      updatedContext
    );
    Object.assign(updatedContext, explicit.values);
    if (runState.contextProvenance) {
      for (const [key, entry] of Object.entries(explicit.provenance)) {
        runState.contextProvenance.set(key, entry);
      }
    }
  }

  // Emit context-value-rejected hints when the seller's error lists the
  // values it would have accepted and the rejected request value traces
  // back to a prior-step $context.* write. Non-fatal: doesn't flip
  // pass/fail; collapses "SDK bug vs seller bug" triage to one line.
  //
  // Gate fires on any step-level failure — task-level failure OR a
  // validation failure on a 200-OK response. Some sellers return 200 with
  // an advisory `errors[]` + `available:` list (success envelope with
  // warnings), and the hint is most useful on exactly that shape. Before
  // adcp-client#883 the gate was task-level only and missed schema-
  // rejected-but-200 flows.
  //
  //   - Normal steps: hints fire whenever the step failed.
  //   - `expect_error` steps: `passed` is inverted (true when the task
  //     failed), so a genuinely-failing `expect_error` step has
  //     `passed && allValidationsPassed === true`, gate stays shut —
  //     expected rejections don't chatter hints by design. When the
  //     validations DO fail (the caller's assertion about the error
  //     shape was wrong), hints fire and can point them at the source
  //     step that supplied the rejected value.
  //
  // Hints trace to context that existed BEFORE this step's own writes,
  // since the rejected value can't have come from this step's own
  // extraction.
  const stepFailed = !(passed && allValidationsPassed);
  const contextRejectionHints =
    stepFailed && runState.contextProvenance
      ? detectContextRejectionHints(taskResult, request, context, runState.contextProvenance, effectiveStep.task)
      : [];

  // Shape-drift and strict-AJV hints fire on any step that has a parsed
  // payload, regardless of pass/fail — issue #935 widened the gate so
  // these structured diagnostics surface alongside the runner's existing
  // `ValidationResult.warning` prose without depending on Zod rejection.
  // Pre-process identically to validateResponseSchema: bare-array payloads
  // pass through; object payloads have the SDK-internal `_message` field
  // stripped so the detector sees what AJV does.
  const driftPayload = (() => {
    if (!hasData || !taskResult) return undefined;
    const raw = taskResult.data;
    if (Array.isArray(raw)) return raw;
    if (raw && typeof raw === 'object') {
      const { _message, ...rest } = raw as Record<string, unknown>;
      return rest;
    }
    return raw;
  })();
  const shapeDriftHints = driftPayload === undefined ? [] : detectShapeDriftHints(effectiveStep.task, driftPayload);
  const strictHints = detectStrictValidationHints(effectiveStep.task, validations);
  // Same root cause MAY produce both a `shape_drift` hint and a
  // `format_mismatch` (keyword: 'type') hint — e.g. `list_creatives`
  // returning a bare array. That's intentional co-emission, not a bug:
  // shape_drift carries the fix recipe ("use listCreativesResponse() to
  // wrap"); format_mismatch carries the structured RFC 6901 pointer +
  // AJV schema_path so renderers can deep-link into the schema.
  // Complementary fix lenses on the same fault.
  const hints = [...contextRejectionHints, ...shapeDriftHints, ...strictHints];

  // Build next step preview
  const next = getNextStepPreview(step.id, allSteps, updatedContext, runState.runnerVars);

  return {
    step_id: step.id,
    phase_id: phaseId,
    title: step.title,
    task: step.task,
    passed: passed && allValidationsPassed,
    expect_error: step.expect_error,
    duration_ms: stepResult.duration_ms,
    // Legacy `response` field (new code reads `response_record`).
    // Redact in case a downstream consumer still keys off it; the
    // modern `response_record.payload` path is already redacted.
    response: redactSecrets(taskResult?.data),
    validations,
    context: updatedContext,
    ...(runState.contextProvenance &&
      runState.contextProvenance.size > 0 && {
        context_provenance: Object.fromEntries(runState.contextProvenance),
      }),
    error: step.expect_error ? undefined : truncateError(stepResult.error || taskResult?.error),
    next,
    request: requestRecord,
    ...(responseRecord && { response_record: responseRecord }),
    extraction: extractionFromTaskResult(taskResult),
    ...(hints.length > 0 && { hints }),
  };
}

// ────────────────────────────────────────────────────────────
// Probe dispatch (raw HTTP tasks)
// ────────────────────────────────────────────────────────────

async function executeProbeStep(
  step: StoryboardStep,
  phaseId: string,
  context: StoryboardContext,
  allSteps: FlatStep[],
  options: StoryboardRunOptions,
  runState: ExecutionState
): Promise<StoryboardStepResult> {
  const start = Date.now();
  let httpResult: HttpProbeResult | undefined;
  const probeOpts = { allowPrivateIp: options.allow_http === true };

  if (step.task === 'protected_resource_metadata') {
    httpResult = await probeProtectedResourceMetadata(runState.agentUrl, probeOpts);
    // RFC 9728 presence semantics (adcp-client#677): a 404 means the agent is
    // honestly not advertising OAuth. Convert to a clean step skip so the
    // phase loop can cascade-skip the rest of oauth_discovery instead of
    // failing the http_status:200 validation. Any other status (including
    // 200) runs validations unchanged — an agent that serves PRM MUST serve
    // it correctly, regardless of whether the test kit also declared an
    // API key. Fetch errors (status 0) fall through to the normal failure
    // path since we can't distinguish "agent down" from "misconfigured".
    if (!httpResult.error && httpResult.status === 404) {
      httpResult.skipped = true;
      httpResult.skip_reason = 'oauth_not_advertised';
    }
  } else if (step.task === 'oauth_auth_server_metadata') {
    const prior = runState.priorProbes.get('protected_resource_metadata') ?? findPriorProbe(runState.priorStepResults);
    httpResult = await probeOauthAuthServerMetadata(prior, probeOpts);
  } else if (step.task === 'assert_contribution') {
    // Synthetic: evaluate only through validations (any_of). No network call.
    httpResult = undefined;
  } else if (step.task === 'request_signing_probe') {
    httpResult = await probeRequestSigningVector(step.id, runState.agentUrl, options);
  }

  if (httpResult) runState.priorProbes.set(step.task, httpResult);

  const duration = Date.now() - start;
  const requestRecord: RunnerRequestRecord = {
    transport: 'http',
    operation: step.task,
    payload: null,
    ...(httpResult?.url ? { url: httpResult.url } : runState.agentUrl ? { url: runState.agentUrl } : {}),
  };
  const filteredProbeHeaders = filterResponseHeaders(httpResult?.headers);
  const responseRecord: RunnerResponseRecord | undefined = httpResult
    ? {
        transport: 'http',
        payload: redactSecrets(httpResult.body),
        status: httpResult.status,
        ...(filteredProbeHeaders && { headers: filteredProbeHeaders }),
        duration_ms: duration,
      }
    : undefined;

  // Probe may self-skip (request_signing_probe uses this for operator opt-outs
  // and capability-profile mismatches). Surface as a skipped step without
  // running validations — skip ≠ fail. The detailed reason goes on
  // `skip_reason`; the canonical spec reason goes on `skip` so contract
  // consumers see a stable enum.
  if (httpResult?.skipped) {
    const detailedReason = (httpResult.skip_reason ?? 'probe_skipped') as RunnerDetailedSkipReason;
    const canonicalReason = DETAILED_SKIP_TO_CANONICAL[detailedReason] ?? 'not_applicable';
    const detail = httpResult.error ?? DETAILED_SKIP_DETAILS[detailedReason] ?? SKIP_DETAILS[canonicalReason];
    return {
      step_id: step.id,
      phase_id: phaseId,
      title: step.title,
      task: step.task,
      passed: true,
      skipped: true,
      skip_reason: detailedReason,
      skip: { reason: canonicalReason, detail },
      duration_ms: duration,
      response: httpResult,
      validations: [],
      context,
      next: getNextStepPreview(step.id, allSteps, context, runState.runnerVars),
      request: requestRecord,
      ...(responseRecord && { response_record: responseRecord }),
      extraction: { path: 'none', note: 'probe self-skipped' },
    };
  }

  const vctx: ValidationContext = {
    taskName: step.task,
    httpResult,
    agentUrl: runState.agentUrl,
    contributions: runState.contributions,
    request: requestRecord,
    ...(responseRecord && { response: responseRecord }),
    storyboardContext: context,
  };
  const validations = step.validations?.length ? runValidations(step.validations, vctx) : [];
  const allValidationsPassed = validations.every(v => v.passed);

  // For probes, the "task passed" proxy is: fetch returned without error AND
  // all validations passed. For assert_contribution (no httpResult), we lean
  // on validations alone.
  const fetchOk = httpResult ? !httpResult.error : true;
  const passed = fetchOk && allValidationsPassed;

  const extraction: RunnerExtractionRecord = httpResult
    ? httpResult.error
      ? { path: 'error' }
      : { path: 'structured_content', note: 'http-probe body parsed as JSON' }
    : { path: 'none' };

  return {
    step_id: step.id,
    phase_id: phaseId,
    title: step.title,
    task: step.task,
    passed,
    duration_ms: duration,
    response: httpResult ?? undefined,
    validations,
    context,
    error: httpResult?.error ?? (passed ? undefined : 'Probe validations failed.'),
    next: getNextStepPreview(step.id, allSteps, context, runState.runnerVars),
    request: requestRecord,
    ...(responseRecord && { response_record: responseRecord }),
    extraction,
  };
}

function findPriorProbe(priorStepResults: Map<string, StoryboardStepResult>): HttpProbeResult | undefined {
  // Fallback for runStoryboardStep where priorProbes isn't populated — reach
  // into the step result's response, which we set to the HttpProbeResult above.
  for (const r of priorStepResults.values()) {
    const resp = r.response as HttpProbeResult | undefined;
    if (resp && typeof resp === 'object' && 'url' in resp && 'status' in resp) return resp;
  }
  return undefined;
}

/**
 * Reduce the captured fetch traffic for an A2A step into the
 * `A2ATaskEnvelope` validations consume. The A2A SDK fires multiple
 * requests per call (`/.well-known/agent-card.json` discovery on
 * fresh clients, then a `message/send` POST), and a single dispatch
 * may also poll `tasks/get` afterwards. We pick the capture whose
 * REQUEST body declares `method: 'message/send'`; if no capture
 * declares the method we fall back to the last POST with a
 * JSON-RPC-shaped body. GET captures and non-JSON bodies are
 * skipped — `undefined` here surfaces as `not_applicable` in the
 * validator, which is more useful than a garbage envelope.
 *
 * Captured response bodies pass through `redactSecrets` before
 * landing in `ValidationContext.a2aEnvelope`. The bearer-token
 * regex in `wrapFetchWithCapture` only catches `Bearer <token>`
 * substrings; AdCP-style secret-shaped fields (`api_key`,
 * `client_secret`, `access_token`) inside a DataPart payload only
 * get redacted here. Failure paths thread the envelope into
 * `ValidationResult.actual.failures[].actual` which lands in
 * persisted compliance reports — redacting at capture parse time
 * keeps that surface consistent with `responseRecord.payload`,
 * which the runner already redacts on the success path.
 */
function parseLastA2aMessageSendCapture(captures: readonly RawHttpCapture[]): A2ATaskEnvelope | undefined {
  let messageSendIdx = -1;
  let lastPostIdx = -1;
  for (let i = captures.length - 1; i >= 0; i--) {
    const cap = captures[i];
    if (!cap || cap.method !== 'POST') continue;
    if (lastPostIdx === -1) lastPostIdx = i;
    // The fetch wrapper doesn't capture the request body, so disambiguate
    // by parsing the response and checking for an A2A `Task` shape on
    // the result. `tasks/get` and `message/send` both return tasks, but
    // only `message/send` is the immediate response we want to assert
    // on for submitted-arm shape checks. When the runner adds polling,
    // we'd need request-body capture to distinguish reliably; for v0
    // the last POST is `message/send` because the SDK doesn't poll
    // synchronously after a Task with terminal state.
    if (messageSendIdx === -1) {
      const env = tryParseJsonRpcEnvelope(cap.body);
      if (env && env.result !== undefined && isTaskShape(env.result)) {
        messageSendIdx = i;
      }
    }
  }
  const idx = messageSendIdx !== -1 ? messageSendIdx : lastPostIdx;
  if (idx === -1) return undefined;
  const cap = captures[idx]!;
  const envelope = tryParseJsonRpcEnvelope(cap.body);
  if (!envelope) return undefined;
  // `envelope.result` mirrors the JSON-RPC envelope as observed —
  // present when the response carried a `result`, absent when it
  // carried `error`. The convenience `result` field at the top level
  // coalesces undefined to `null` so validators reading the typed
  // `A2ATaskEnvelope.result` get a stable shape; the inner
  // `envelope.result` keeps presence-of-key fidelity for validators
  // that need to distinguish "result was null" from "result was
  // omitted". Both paths run through `redactSecrets`.
  const redactedResult = envelope.result !== undefined ? redactSecrets(envelope.result) : null;
  return {
    result: redactedResult,
    envelope: {
      ...(envelope.jsonrpc !== undefined && { jsonrpc: envelope.jsonrpc }),
      ...(envelope.id !== undefined && { id: envelope.id }),
      ...(envelope.result !== undefined && { result: redactedResult }),
      ...(envelope.error !== undefined && { error: redactSecrets(envelope.error) }),
    },
    http_status: cap.status,
  };
}

function tryParseJsonRpcEnvelope(
  body: string
): { jsonrpc?: unknown; id?: unknown; result?: unknown; error?: unknown } | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const envelope = parsed as { jsonrpc?: unknown; id?: unknown; result?: unknown; error?: unknown };
  if (envelope.jsonrpc !== '2.0') return undefined;
  if (envelope.result === undefined && envelope.error === undefined) return undefined;
  return envelope;
}

function isTaskShape(result: unknown): boolean {
  return (
    result != null &&
    typeof result === 'object' &&
    !Array.isArray(result) &&
    (result as { kind?: unknown }).kind === 'task'
  );
}

// ────────────────────────────────────────────────────────────
// Phase / step skip predicates
// ────────────────────────────────────────────────────────────

/**
 * Evaluate a phase's `skip_if` expression against the runtime options. Only
 * a tiny grammar is supported today; unknown expressions fail closed (phase runs).
 */
function shouldSkipPhase(phase: StoryboardPhase, options: StoryboardRunOptions): boolean {
  const expr = phase.skip_if?.trim();
  if (!expr) return false;
  const match = /^(!?)test_kit\.([a-zA-Z0-9_.]+)$/.exec(expr);
  if (!match) return false; // unknown grammar → run the phase
  const negated = match[1] === '!';
  const path = match[2]!.split('.');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic test-kit shape
  let value: any = (options as { test_kit?: unknown }).test_kit;
  for (const segment of path) {
    if (value == null || typeof value !== 'object') {
      value = undefined;
      break;
    }
    value = (value as Record<string, unknown>)[segment];
  }
  const truthy = Boolean(value);
  return negated ? !truthy : truthy;
}

/**
 * Resolve a `$test_kit.<path>` task reference against the runtime options.
 * Falls back to `step.task_default`. Returns undefined when neither yields a string.
 */
function resolveTaskName(step: StoryboardStep, options: StoryboardRunOptions): string | undefined {
  if (!step.task.startsWith('$test_kit.')) return step.task;
  const path = step.task.slice('$test_kit.'.length).split('.');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic test-kit shape
  let value: any = options.test_kit;
  for (const segment of path) {
    if (value == null || typeof value !== 'object') {
      value = undefined;
      break;
    }
    value = (value as Record<string, unknown>)[segment];
  }
  if (typeof value === 'string' && value.length > 0) return value;
  return step.task_default;
}

/**
 * Build headers for the raw MCP probe when a step needs raw dispatch without
 * an explicit `auth` override (defense-in-depth for `omit_idempotency_key`).
 * Returns `undefined` for `oauth` so the caller falls back to the SDK path —
 * refreshable-token semantics can't be replicated here and the SDK honors
 * `skipIdempotencyAutoInject` on that path anyway.
 */
function defaultAuthHeadersForRawProbe(options: StoryboardRunOptions): Record<string, string> | undefined {
  // Reject control chars and non-printable ASCII. Without this, undici's header
  // validator throws a message that includes the offending value — landing
  // secrets in logs. Validate raw inputs before encoding so the field name in
  // the error identifies which input to fix without echoing the value.
  const assertSafe = (value: string, field: string) => {
    if (/[\r\n]|[^\x20-\x7E]/.test(value)) {
      throw new Error(`${field} contains invalid characters (control chars or non-printable ASCII)`);
    }
  };

  const headers: Record<string, string> = {};
  if (options.auth) {
    if (options.auth.type === 'bearer') {
      if (!options.auth.token) throw new Error('options.auth.token is required for bearer auth');
      assertSafe(options.auth.token, 'options.auth.token');
      headers.authorization = `Bearer ${options.auth.token}`;
    } else if (options.auth.type === 'basic') {
      // RFC 7617 bans `:` in the userid — a colon would decode ambiguously on
      // the server. Fail loudly rather than silently producing a mangled header.
      if (options.auth.username.includes(':')) {
        throw new Error('options.auth.username must not contain colon (RFC 7617)');
      }
      assertSafe(options.auth.username, 'options.auth.username');
      assertSafe(options.auth.password, 'options.auth.password');
      const encoded = Buffer.from(`${options.auth.username}:${options.auth.password}`).toString('base64');
      headers.authorization = `Basic ${encoded}`;
    } else {
      return undefined;
    }
  }
  // Match SDK header casing so a raw-probe request is byte-indistinguishable
  // from an SDK-shaped one at the transport boundary. HTTP is case-insensitive;
  // this is purely for parity with capture/diff tooling.
  if (options.test_session_id) {
    assertSafe(options.test_session_id, 'options.test_session_id');
    headers['X-Test-Session-ID'] = options.test_session_id;
  }
  if (options.userAgent) {
    assertSafe(options.userAgent, 'options.userAgent');
    headers['User-Agent'] = options.userAgent;
  }
  return headers;
}

/**
 * Translate a `StepAuthDirective` into HTTP headers for the raw MCP probe.
 * - `'none'` returns an empty object and the probe sends no `Authorization`.
 * - `api_key` / `oauth_bearer` resolve the value from `value`, `from_test_kit`,
 *   or `value_strategy` — in that order — and produce `Authorization: Bearer <value>`.
 */
function authHeadersForStep(directive: StepAuthDirective, options: StoryboardRunOptions): Record<string, string> {
  if (directive === 'none') return {};
  let value: string | undefined;
  if ('value' in directive && directive.value) {
    value = directive.value;
  } else if ('from_test_kit' in directive && directive.from_test_kit) {
    value = options.test_kit?.auth?.api_key;
  } else if ('value_strategy' in directive && directive.value_strategy) {
    if (directive.value_strategy === 'random_invalid') value = generateRandomInvalidApiKey();
    else if (directive.value_strategy === 'random_invalid_jwt') value = generateRandomInvalidJwt();
  }
  if (!value) return {};
  // Reject CR/LF/NUL and non-printable ASCII — a test-kit key with stray
  // whitespace would otherwise crash undici's header validator and the raw
  // exception (containing the secret) lands in the serialized compliance
  // report. Fail loudly with a non-echoing error instead.
  if (/[\r\n\x00]|[^\x20-\x7E]/.test(value)) {
    throw new Error('test_kit.auth.api_key contains invalid characters (control chars or non-printable ASCII)');
  }
  return { authorization: `Bearer ${value}` };
}

/**
 * Evaluate a step's `contributes_if` expression. Grammar:
 *   - `"prior_step.<step_id>.passed"` — prior step passed
 * Unknown expressions → false (contribution does NOT fire).
 */
function evalContributesIf(expr: string | undefined, priorStepResults: Map<string, StoryboardStepResult>): boolean {
  if (!expr) return true;
  const match = /^prior_step\.([A-Za-z0-9_]+)\.passed$/.exec(expr.trim());
  if (!match) return false;
  const stepId = match[1]!;
  const prior = priorStepResults.get(stepId);
  return !!prior?.passed && !prior.skipped;
}

// ────────────────────────────────────────────────────────────
// Brand/account invariant
// ────────────────────────────────────────────────────────────

/**
 * Force every outgoing request onto the storyboard's brand context.
 *
 * Sellers that scope session state by brand (spec-required for multi-tenant
 * isolation) derive a session key from `brand.domain` — or, when brand is
 * absent, from `account.brand.domain`. If any step in a run targets a
 * different brand, it lands in a different session and can't see state
 * created by earlier steps.
 *
 * This helper runs after builder / sample_request resolution and writes the
 * run-scoped brand into the addressing forms the tool's schema allows:
 *
 *   - Top-level `brand` — only when the tool's request schema declares it
 *     (e.g. `get_products`, `create_media_buy`, signal tools). Governance
 *     tools like `sync_plans` do not declare `brand` at the request root
 *     (brand belongs inside each `Plan` object) — injecting it would fail
 *     the framework's strict AJV validation (#940).
 *   - `account.brand` — merged into an existing `account` object only when
 *     it uses the natural-key variant (`{brand, operator, sandbox?}`). The
 *     `{account_id}` variant is closed (`additionalProperties: false`); merging
 *     `brand` into it produces a payload that matches neither `oneOf` branch
 *     and is rejected by AJV strict request validation. Detect the natural-key
 *     variant by looking for an existing `brand` or `operator` key.
 *   - Synthetic `account` — constructed only when the request has no
 *     `account` AND the tool's schema declares `account` (e.g. `get_media_buys`,
 *     `list_creatives`). Tools like `sync_plans` that declare neither
 *     `brand` nor `account` at the root are left unchanged.
 *
 * When `taskName` is omitted or the schema is unavailable (not synced yet),
 * the function fails open and injects as before. Schema checks use raw JSON
 * reads, not AJV internals.
 */
export function applyBrandInvariant(
  request: Record<string, unknown>,
  options: StoryboardRunOptions,
  taskName?: string
): Record<string, unknown> {
  // Only force the invariant when the caller has actually supplied a brand.
  // Storyboards that don't exercise brand-scoped tools (e.g. security
  // probes) legitimately run without one and should pass through unchanged.
  if (!options.brand && !options.brand_manifest) return request;
  const brand = resolveBrand(options);

  // Gate brand/account injection on the tool's request schema. Tools that
  // declare `additionalProperties: false` without listing the field will fail
  // the framework's strict AJV validator if we inject it (#940). Fails open
  // when taskName is absent or the schema isn't available.
  const topBrandOk = !taskName || schemaAllowsTopLevelField(taskName, 'brand');
  const topAccountOk = !taskName || schemaAllowsTopLevelField(taskName, 'account');

  const result: Record<string, unknown> = { ...request };
  if (topBrandOk) result.brand = brand;

  if ('account' in request) {
    // Caller sent an account — merge brand in only when it's a plain object
    // using AccountReference's natural-key variant (`{brand, operator, sandbox?}`).
    // The `{account_id}` variant is a closed object; merging `brand` would
    // produce a payload that matches neither `oneOf` branch under strict AJV.
    // Leave non-object values (null, array) and `{account_id}`-only payloads
    // alone so intentionally narrow or malformed requests aren't silently
    // "corrected."
    const existingAccount = request.account;
    if (existingAccount && typeof existingAccount === 'object' && !Array.isArray(existingAccount)) {
      const acct = existingAccount as Record<string, unknown>;
      const isNaturalKeyVariant = 'brand' in acct || 'operator' in acct;
      if (isNaturalKeyVariant) {
        result.account = { ...acct, brand };
      }
    }
  } else if (topAccountOk) {
    // No account on the request — construct one so tools whose schema
    // declares `account` but not top-level `brand` (e.g. get_media_buys,
    // list_creatives) still carry the run-scoped brand on the wire.
    result.account = resolveAccount(options);
  }
  return result;
}

/**
 * Mint an `idempotency_key` for mutating storyboard requests when one wasn't
 * supplied. Storyboard `sample_request` blocks generally omit it; the runner
 * fills it in so the server's required-field check doesn't short-circuit the
 * handler under test, including on `expect_error` steps that name specific
 * failure modes (GOVERNANCE_DENIED, UNAUTHORIZED, brand_mismatch, etc.).
 *
 * Skipped when:
 *   - `step.omit_idempotency_key === true` — the scenario is explicitly
 *     exercising the server's missing-key rejection path.
 *   - the task isn't mutating per {@link MUTATING_TASKS}.
 *   - the request already carries a key — typically a
 *     `$generate:uuid_v4#alias` the context injector has resolved to a
 *     concrete UUID for replay scenarios, or a BYOK key supplied inline.
 */
export function applyIdempotencyInvariant(
  request: Record<string, unknown>,
  taskName: string,
  step: StoryboardStep
): Record<string, unknown> {
  if (step.omit_idempotency_key === true) return request;
  if (!isMutatingTask(taskName)) return request;
  if (typeof request.idempotency_key === 'string' && request.idempotency_key.length > 0) return request;
  return { ...request, idempotency_key: generateIdempotencyKey() };
}

// ────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────

const MAX_ERROR_LENGTH = 2000;

function truncateError(error: string | undefined): string | undefined {
  if (!error) return undefined;
  return error.length > MAX_ERROR_LENGTH ? error.slice(0, MAX_ERROR_LENGTH) + '...[truncated]' : error;
}

interface FlatStep {
  step: StoryboardStep;
  phaseId: string;
  globalIndex: number;
}

/**
 * Find any "$context.xxx" strings that weren't resolved during injection.
 */
function findUnresolvedContextVars(obj: unknown): string[] {
  const vars: string[] = [];
  const walk = (val: unknown) => {
    if (typeof val === 'string') {
      const match = val.match(/^\$context\.(\w+)$/);
      if (match?.[1]) vars.push(match[1]);
    } else if (Array.isArray(val)) {
      val.forEach(walk);
    } else if (val !== null && typeof val === 'object') {
      Object.values(val as Record<string, unknown>).forEach(walk);
    }
  };
  walk(obj);
  return vars;
}

function flattenSteps(storyboard: Storyboard): FlatStep[] {
  const result: FlatStep[] = [];
  let index = 0;
  for (const phase of storyboard.phases) {
    for (const step of phase.steps) {
      result.push({ step, phaseId: phase.id, globalIndex: index++ });
    }
  }
  return result;
}

function getNextStepPreview(
  currentStepId: string,
  allSteps: FlatStep[],
  context: StoryboardContext,
  runnerVars?: RunnerVariables
): StoryboardStepPreview | undefined {
  const currentIdx = allSteps.findIndex(s => s.step.id === currentStepId);
  if (currentIdx === -1 || currentIdx >= allSteps.length - 1) return undefined;

  const nextFlat = allSteps[currentIdx + 1];
  if (!nextFlat) return undefined;
  const nextStep = nextFlat.step;

  // Inject context into the next step's sample_request for preview
  const previewRequest = nextStep.sample_request
    ? injectContext({ ...nextStep.sample_request }, context, runnerVars)
    : undefined;

  return {
    step_id: nextStep.id,
    phase_id: nextFlat.phaseId,
    title: nextStep.title,
    task: nextStep.task,
    narrative: nextStep.narrative,
    expected: nextStep.expected,
    sample_request: previewRequest,
  };
}

// ────────────────────────────────────────────────────────────
// Multi-instance dispatch
// ────────────────────────────────────────────────────────────

interface StepAssignment {
  client: TestClient;
  agentUrl: string;
  /** 0-based index into the agent URL list */
  instanceIndex: number;
}

interface Dispatcher {
  nextFor(step: StoryboardStep): StepAssignment;
}

/**
 * Build a dispatcher that picks an (agent URL, client) pair per step.
 *
 * Single-URL runs always return the same assignment. Multi-URL runs use
 * round-robin — step N hits `clients[(N + startOffset) % N_urls]`.
 * Deterministic and reproducible for bug reports.
 *
 * `startOffset` lets the `multi-pass` strategy run the same storyboard with
 * the dispatcher starting at a different replica each pass so write→read
 * pairs separated by an even number of stateful steps get exercised
 * cross-replica on at least one pass.
 */
function createDispatcher(
  agentUrls: string[],
  clients: TestClient[],
  _strategy: 'round-robin',
  startOffset = 0
): Dispatcher {
  let counter = startOffset;
  return {
    nextFor(_step: StoryboardStep): StepAssignment {
      const idx = ((counter % agentUrls.length) + agentUrls.length) % agentUrls.length;
      counter++;
      return {
        client: clients[idx]!,
        agentUrl: agentUrls[idx]!,
        instanceIndex: idx,
      };
    },
  };
}

const HORIZONTAL_SCALING_DOCS_URL =
  'https://adcontextprotocol.org/docs/building/validate-your-agent#verifying-cross-instance-state';
const NOT_FOUND_PATTERN = /not[_ ]found|not-found|\b404\b/i;

// Agent-controlled text (error messages, response payloads) lands in terminal
// output. Strip C0/C1 control chars so a hostile agent returning
// `\x1b[2J\x1b[H` (clear screen) or `\r` (overwrite prior line) can't mangle
// CI logs or forge terminal state. Tabs and newlines are preserved.
// The cap bounds JSON-stringification cost if an agent returns an enormous
// or deeply-nested response body.
const MAX_ATTRIBUTION_SNIPPET = 512;
function sanitizeAgentText(text: string): string {
  return text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '').slice(0, MAX_ATTRIBUTION_SNIPPET);
}

/**
 * Detect the canonical horizontal-scaling failure signature on a step result.
 *
 * Reads structured fields the runner commonly populates (error string,
 * nested response.error/code/message/status) rather than regex-matching the
 * full stringified response — structured lookup is cheaper, resistant to an
 * agent smuggling "NOT_FOUND" into an unrelated field to falsely trigger the
 * canonical wording, and doesn't blow up on circular or oversized payloads.
 */
function isNotFoundSignature(result: StoryboardStepResult): boolean {
  const candidates: Array<unknown> = [result.error];
  const resp = result.response as Record<string, unknown> | null | undefined;
  if (resp && typeof resp === 'object' && !Array.isArray(resp)) {
    candidates.push(resp.error, resp.code, resp.message, resp.status, resp.status_code);
  }
  for (const c of candidates) {
    if (typeof c === 'string' && NOT_FOUND_PATTERN.test(c)) return true;
    if (typeof c === 'number' && c === 404) return true;
  }
  return false;
}

/**
 * Mutate a failed step result to include cross-instance attribution.
 *
 * In multi-instance mode any step failure is worth attributing because the
 * failure signature may not be NOT_FOUND — it can surface as 500, an empty
 * array, PERMISSION_DENIED, or stale status. Attribution always emits:
 *   - which replica served this step and the immediate prior stateful write
 *   - a replica→step map for pattern-matching in CI logs
 *   - a single-replica repro command
 * When the signature matches the canonical horizontal-scaling case (prior
 * write on A, read fails on B with NOT_FOUND), the wording mirrors the
 * protocol docs verbatim so developers pattern-match the page they'll
 * eventually click through to.
 */
function annotateMultiInstanceFailure(
  result: StoryboardStepResult,
  storyboard: Storyboard,
  priorResults: StoryboardStepResult[]
): void {
  const currentInstance = result.agent_index;
  const currentUrl = result.agent_url;
  if (!currentInstance || !currentUrl) return;

  // Lookup stateful flag on step defs — needed to identify "prior writes".
  const stepDefs = new Map<string, StoryboardStep>();
  for (const phase of storyboard.phases) {
    for (const s of phase.steps) stepDefs.set(s.id, s);
  }

  const priorCrossInstanceWrite = [...priorResults].reverse().find(prior => {
    if (!prior.passed || prior.skipped) return false;
    if (!prior.agent_index || prior.agent_index === currentInstance) return false;
    return stepDefs.get(prior.step_id)?.stateful === true;
  });

  const replicaMap = priorResults
    .filter(r => !r.skipped && r.agent_index)
    .map(r => `    [#${r.agent_index}] ${r.step_id} — ${r.passed ? 'ok' : 'FAIL'}`)
    .join('\n');

  const lines: string[] = [];

  if (priorCrossInstanceWrite) {
    const writerIdx = priorCrossInstanceWrite.agent_index;
    const writerUrl = priorCrossInstanceWrite.agent_url;
    // Wording deliberately mirrors the failure example in the protocol docs
    // ("<write> on replica A returned …; <read> on replica B returned NOT_FOUND;
    // → Brand-scoped state is not shared across replicas.") so CI readers
    // pattern-match the page they'll click through to.
    lines.push(`${priorCrossInstanceWrite.step_id} on replica [#${writerIdx}] (${writerUrl}) succeeded.`);
    lines.push(
      `${result.step_id} on replica [#${currentInstance}] (${currentUrl}) failed${
        isNotFoundSignature(result) ? ' with NOT_FOUND' : ''
      }.`
    );
    lines.push('→ Brand-scoped state is not shared across replicas.');
    lines.push(`See: ${HORIZONTAL_SCALING_DOCS_URL}`);
  } else {
    lines.push(
      `Multi-instance failure on replica [#${currentInstance}] (${currentUrl}). ` +
        `No prior cross-replica stateful write found — the failure may be intrinsic to this replica.`
    );
  }

  if (replicaMap) {
    lines.push('Replica → step map:');
    lines.push(replicaMap);
  }
  lines.push(`Reproduce single-replica: adcp storyboard run ${currentUrl} ${storyboard.id}`);

  // Agent-controlled text goes in the base line; control chars are stripped
  // so a hostile agent can't forge terminal escape sequences in CI output.
  const base = sanitizeAgentText(result.error ?? 'Step failed');
  result.error = `${base}\n\n${lines.join('\n')}`;
}

/**
 * Get a preview of the first step in a storyboard (for showing what will happen).
 *
 * `{{runner.*}}` tokens are passed through unchanged since no receiver is
 * bound at preview time. They'll resolve when the step actually runs.
 */
export function getFirstStepPreview(
  storyboard: Storyboard,
  context: StoryboardContext = {}
): StoryboardStepPreview | undefined {
  const firstPhase = storyboard.phases[0];
  if (!firstPhase?.steps[0]) return undefined;

  const step = firstPhase.steps[0];
  const previewRequest = step.sample_request ? injectContext({ ...step.sample_request }, context) : undefined;

  return {
    step_id: step.id,
    phase_id: firstPhase.id,
    title: step.title,
    task: step.task,
    narrative: step.narrative,
    expected: step.expected,
    sample_request: previewRequest,
  };
}
