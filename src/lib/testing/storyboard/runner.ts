/**
 * Storyboard execution engine.
 *
 * Two entry points:
 * - runStoryboard(): run all phases/steps sequentially
 * - runStoryboardStep(): run a single step (stateless, LLM-friendly)
 */

import { getOrCreateClient, getOrDiscoverProfile, runStep, type TestClient } from '../client';
import { closeConnections } from '../../protocols';
import { executeStoryboardTask } from './task-map';
import { extractContext, injectContext, applyContextOutputs, applyContextInputs, forwardAliasCache } from './context';
import { runValidations, type ValidationContext } from './validations';
import { buildRequest, hasRequestBuilder } from './request-builder';
import { resolveBrand } from '../client';
import { isMutatingTask } from '../../utils/idempotency';
import {
  PROBE_TASKS,
  probeProtectedResourceMetadata,
  probeOauthAuthServerMetadata,
  rawMcpProbe,
  generateRandomInvalidApiKey,
  generateRandomInvalidJwt,
} from './probes';
import { validateTestKit } from './test-kit';
import { probeRequestSigningVector } from './request-signing/probe-dispatch';
import type {
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
  StoryboardPhaseResult,
  StoryboardStepResult,
  StoryboardStepPreview,
  ValidationResult,
} from './types';
import { DETAILED_SKIP_TO_CANONICAL } from './types';
import type { TaskResult } from '../types';

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
};

function buildSkip(reason: RunnerSkipReason, detail?: string): { reason: RunnerSkipReason; detail: string } {
  return { reason, detail: detail ?? SKIP_DETAILS[reason] };
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
  /^(authorization|credentials?|token|api[_-]?key|password|secret|client[_-]secret|refresh[_-]token|access[_-]token|bearer|session[_-]token|offering[_-]token|cookie|set[_-]cookie)$/i;

export function __redactSecretsForTest(value: unknown): unknown {
  return redactSecrets(value);
}

export function __filterResponseHeadersForTest(
  headers: Record<string, string> | undefined
): Record<string, string> | undefined {
  return filterResponseHeaders(headers);
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
  const start = Date.now();
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

  // Build one client per URL. In single-URL mode `_client` (from comply()) is
  // honored so the shared MCP transport is reused across storyboards.
  const clients = agentUrls.map(url => getOrCreateClient(url, options));

  // Discover agent profile against the first instance; all instances are
  // expected to run the same code behind a shared state store, so one probe
  // is sufficient. For multi-instance runs, skipping N-1 redundant
  // get_agent_info calls also keeps CI output clean.
  if (!options._client) {
    const { profile } = await getOrDiscoverProfile(clients[0]!, options);
    // Populate agentTools from discovered profile if not already set
    if (!options.agentTools && profile?.tools) {
      options = { ...options, agentTools: profile.tools };
    }
  }

  let context: StoryboardContext = { ...options.context };
  if (options.context) forwardAliasCache(options.context, context);
  const contributions = new Set<string>();
  const priorStepResults = new Map<string, StoryboardStepResult>();
  const priorProbes = new Map<string, HttpProbeResult>();
  const phaseResults: StoryboardPhaseResult[] = [];
  let passedCount = 0;
  let failedCount = 0;
  let skippedCount = 0;

  // Flatten all steps for next-step preview lookups
  const allSteps = flattenSteps(storyboard);
  const dispatch = createDispatcher(agentUrls, clients, options.multi_instance_strategy ?? 'round-robin');

  // Placeholder storyboards with no executable phases get a distinct skip
  // reason per the runner-output contract. Without this, the overall result
  // would pass vacuously — `passed_count === 0 && failed_count === 0` — and
  // an implementor reading the report can't tell "nothing tested" from
  // "everything passed".
  const hasExecutableSteps = storyboard.phases.some(p => p.steps.length > 0);
  if (!hasExecutableSteps) {
    const detail = `Storyboard "${storyboard.id}" has no executable phases — populate \`phases[].steps\` or remove the storyboard.`;
    const syntheticStep: StoryboardStepResult = {
      storyboard_id: storyboard.id,
      step_id: '__no_phases__',
      phase_id: '__no_phases__',
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
      phase_id: '__no_phases__',
      phase_title: 'No phases',
      passed: false,
      steps: [syntheticStep],
      duration_ms: 0,
    });
    skippedCount++;
  }

  for (const phase of storyboard.phases) {
    const phaseStart = Date.now();
    const stepResults: StoryboardStepResult[] = [];
    let phasePassed = true;
    let statefulFailed = false;

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

    for (const step of phase.steps) {
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
      });
      const result: StoryboardStepResult = { ...rawResult, storyboard_id: storyboard.id };
      if (isMultiInstance) {
        result.agent_url = assignment.agentUrl;
        result.agent_index = assignment.instanceIndex + 1;
      }
      stepResults.push(result);
      priorStepResults.set(step.id, result);

      // Record contribution on success, honoring optional contributes_if predicate.
      if (!result.skipped && result.passed && step.contributes_to) {
        if (evalContributesIf(step.contributes_if, priorStepResults)) {
          contributions.add(step.contributes_to);
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
        // Optional phases contribute their failures to reporting but NOT to
        // overall pass/fail — the storyboard's final assert_contribution
        // phase is the gate. The "API key OR OAuth" logic lives there, so a
        // failing optional phase (e.g., OAuth discovery when only API key is
        // configured) must not fail the storyboard by itself.
        if (!phase.optional) failedCount++;
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

  // Overall pass requires (a) no required-phase failures AND (b) at least one
  // required phase actually passed with at least one non-skipped step.
  // Without the second clause, a storyboard where every phase is marked
  // optional, every required phase's steps are skipped (e.g. required_tools
  // filtered out everything), would pass vacuously. The storyboard's own gate
  // (assert_contribution in security_baseline) must live in a required phase.
  const requiredPhasesPassed = phaseResults.some((p, idx) => {
    const phaseDef = storyboard.phases[idx];
    if (!phaseDef || phaseDef.optional || !p.passed) return false;
    return p.steps.some(s => !s.skipped && s.passed);
  });
  const schemasUsed = collectSchemasUsed(phaseResults);
  const result: StoryboardResult = {
    storyboard_id: storyboard.id,
    storyboard_title: storyboard.title,
    agent_url: agentUrls[0]!,
    ...(isMultiInstance && { agent_urls: [...agentUrls] }),
    ...(isMultiInstance && { multi_instance_strategy: options.multi_instance_strategy ?? 'round-robin' }),
    overall_passed: failedCount === 0 && requiredPhasesPassed,
    phases: phaseResults,
    context,
    total_duration_ms: Date.now() - start,
    passed_count: passedCount,
    failed_count: failedCount,
    skipped_count: skippedCount,
    tested_at: new Date().toISOString(),
    ...(schemasUsed.length > 0 ? { schemas_used: schemasUsed } : {}),
  };

  // Close protocol connections when the runner created its own client. The
  // connection pool is keyed by URL+auth, so a single closeConnections() call
  // evicts every instance's transport regardless of how many URLs we used.
  if (!options._client) {
    await closeConnections(options.protocol);
  }

  return result;
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

  // Find the step
  const allSteps = flattenSteps(storyboard);
  const found = allSteps.find(s => s.step.id === stepId);
  if (!found) {
    throw new Error(
      `Step "${stepId}" not found in storyboard "${storyboard.id}". ` +
        `Available steps: ${allSteps.map(s => s.step.id).join(', ')}`
    );
  }

  const result = await executeStep(client, found.step, found.phaseId, context, allSteps, options, {
    contributions: new Set(),
    priorStepResults: new Map(),
    priorProbes: new Map(),
    agentUrl,
  });

  if (!options._client) {
    await closeConnections(options.protocol);
  }

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
  };

  // HTTP probe tasks bypass the MCP client entirely.
  if (PROBE_TASKS.has(step.task)) {
    return executeProbeStep(step, phaseId, context, allSteps, options, runState);
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
    const next = getNextStepPreview(step.id, allSteps, context);
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
    const next = getNextStepPreview(step.id, allSteps, context);
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

  // Build request — priority:
  // 1. User-provided --request override
  // 2. For expect_error steps: use sample_request directly (preserves intentionally invalid input)
  // 3. Request builder (builds from context + options, like hand-written scenarios)
  // 4. sample_request from YAML with context injection (fallback)
  let request: Record<string, unknown>;
  if (options.request) {
    request = { ...options.request };
  } else if (step.expect_error && step.sample_request) {
    request = injectContext({ ...step.sample_request }, context);
  } else if (hasRequestBuilder(effectiveStep.task)) {
    request = buildRequest(effectiveStep, context, options);
    // Merge pass-through envelope fields from sample_request — builders
    // don't include these, but storyboards define them for compliance
    // testing. `context` and `ext` are opaque pass-through. `idempotency_key`
    // must be forwarded so compliance storyboards can test replay semantics:
    // the same `$generate:uuid_v4#<alias>` across two steps resolves to the
    // same UUID, and the server sees both calls with that UUID (no auto-
    // generated UUID overriding it at the client layer).
    if (step.sample_request) {
      if (step.sample_request.context !== undefined && request.context === undefined) {
        request.context = injectContext({ context: step.sample_request.context }, context).context;
      }
      if (step.sample_request.ext !== undefined && request.ext === undefined) {
        request.ext = step.sample_request.ext;
      }
      if (step.sample_request.idempotency_key !== undefined && request.idempotency_key === undefined) {
        const resolved = injectContext(
          { idempotency_key: step.sample_request.idempotency_key },
          context
        ).idempotency_key;
        if (typeof resolved === 'string') request.idempotency_key = resolved;
      }
    }
  } else if (step.sample_request) {
    request = injectContext({ ...step.sample_request }, context);
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
  request = applyBrandInvariant(request, options);

  // Detect unresolved $context placeholders — a prior step likely failed
  // and didn't produce the expected output. Skip rather than sending garbage.
  const unresolvedVars = findUnresolvedContextVars(request);
  if (unresolvedVars.length > 0 && !step.expect_error) {
    const next = getNextStepPreview(step.id, allSteps, context);
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
  // idempotency_key returns INVALID_REQUEST") need to suppress the AdCP
  // client's auto-inject — otherwise the client helpfully generates a
  // UUID and the server never sees a missing-key request. Narrow trigger:
  // the step expects an error, the task is mutating, and the request
  // doesn't provide idempotency_key.
  const testsMissingIdempotencyKey =
    step.expect_error === true &&
    isMutatingTask(effectiveStep.task) &&
    (request as Record<string, unknown>).idempotency_key === undefined;

  let taskResult: TaskResult | undefined;
  let stepResult: { duration_ms: number; error?: string; passed: boolean };
  let httpResult: HttpProbeResult | undefined;
  let responseRecord: RunnerResponseRecord | undefined;

  if (step.auth !== undefined) {
    const started = Date.now();
    try {
      const headers = authHeadersForStep(step.auth, options);
      const probe = await rawMcpProbe({
        agentUrl: runState.agentUrl,
        toolName: effectiveStep.task,
        args: request,
        headers,
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
    const run = await runStep(step.title, effectiveStep.task, () =>
      executeStoryboardTask(client, effectiveStep.task, request, {
        skipIdempotencyAutoInject: testsMissingIdempotencyKey,
      })
    );
    taskResult = run.result;
    stepResult = run.step;
    if (taskResult) {
      responseRecord = {
        transport: options.protocol === 'a2a' ? 'a2a' : 'mcp',
        payload: redactSecrets(taskResult.data ?? taskResult.error ?? null),
        duration_ms: stepResult.duration_ms,
      };
    }
  }

  const requestRecord: RunnerRequestRecord = {
    transport: step.auth !== undefined ? 'mcp' : options.protocol === 'a2a' ? 'a2a' : 'mcp',
    operation: effectiveStep.task,
    payload: redactSecrets(request),
    ...(runState.agentUrl ? { url: runState.agentUrl } : {}),
  };

  // Feature-unsupported or unknown-tool errors → treat as skip
  const isUnsupported = stepResult.error?.includes('does not support:');
  const isUnknownTool = stepResult.error && /Unknown tool[:\s]/i.test(stepResult.error);
  if (!taskResult && (isUnsupported || isUnknownTool)) {
    const next = getNextStepPreview(step.id, allSteps, context);
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
        resolved.value = injectContext({ __v: resolved.value }, context).__v;
      }
      if (Array.isArray(resolved.allowed_values)) {
        resolved.allowed_values = resolved.allowed_values.map(av => injectContext({ __v: av }, context).__v);
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
    };
    validations = runValidations(resolvedValidations, vctx);
  }

  const allValidationsPassed = validations.every(v => v.passed);

  // Extract context from responses. Forward the alias cache so
  // `$generate:uuid_v4#<alias>` placeholders in subsequent steps resolve
  // to the same UUID as prior steps with the same alias.
  const updatedContext = { ...context };
  forwardAliasCache(context, updatedContext);
  const hasData = taskResult?.data !== undefined && taskResult?.data !== null;

  // Convention-based extraction (for non-error steps, or when expect_error succeeded)
  if (passed && hasData && taskResult) {
    const extracted = extractContext(step.task, taskResult.data);
    Object.assign(updatedContext, extracted);
  }

  // Explicit context_outputs (always applied when data exists)
  if (hasData && taskResult && step.context_outputs?.length) {
    const explicit = applyContextOutputs(taskResult.data, step.context_outputs);
    Object.assign(updatedContext, explicit);
  }

  // Build next step preview
  const next = getNextStepPreview(step.id, allSteps, updatedContext);

  return {
    step_id: step.id,
    phase_id: phaseId,
    title: step.title,
    task: step.task,
    passed: passed && allValidationsPassed,
    expect_error: step.expect_error,
    duration_ms: stepResult.duration_ms,
    response: taskResult?.data,
    validations,
    context: updatedContext,
    error: step.expect_error ? undefined : truncateError(stepResult.error || taskResult?.error),
    next,
    request: requestRecord,
    ...(responseRecord && { response_record: responseRecord }),
    extraction: extractionFromTaskResult(taskResult),
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
    const detail = httpResult.error ?? SKIP_DETAILS[canonicalReason];
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
      next: getNextStepPreview(step.id, allSteps, context),
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
    next: getNextStepPreview(step.id, allSteps, context),
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
 * This helper runs after builder / sample_request resolution and overwrites
 * any conflicting brand on the request with `options.brand`. When the
 * request carries an `account` object, we also set `account.brand` so both
 * addressing forms converge.
 *
 * `AccountReference` is a union of `{account_id}` or `{brand, operator, sandbox?}`.
 * Injecting `brand` into an `{account_id}`-branch account still passes schema
 * validation (request schemas use `.passthrough()`) but is semantically
 * redundant. No storyboard currently uses the `{account_id}` branch.
 */
export function applyBrandInvariant(
  request: Record<string, unknown>,
  options: StoryboardRunOptions
): Record<string, unknown> {
  // Only force the invariant when the caller has actually supplied a brand.
  // Storyboards that don't exercise brand-scoped tools (e.g. security
  // probes) legitimately run without one and should pass through unchanged.
  if (!options.brand && !options.brand_manifest) return request;
  const brand = resolveBrand(options);
  const result: Record<string, unknown> = { ...request, brand };
  const existingAccount = request.account;
  if (existingAccount && typeof existingAccount === 'object' && !Array.isArray(existingAccount)) {
    result.account = { ...(existingAccount as Record<string, unknown>), brand };
  }
  return result;
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
  context: StoryboardContext
): StoryboardStepPreview | undefined {
  const currentIdx = allSteps.findIndex(s => s.step.id === currentStepId);
  if (currentIdx === -1 || currentIdx >= allSteps.length - 1) return undefined;

  const nextFlat = allSteps[currentIdx + 1];
  if (!nextFlat) return undefined;
  const nextStep = nextFlat.step;

  // Inject context into the next step's sample_request for preview
  const previewRequest = nextStep.sample_request ? injectContext({ ...nextStep.sample_request }, context) : undefined;

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
 * Single-URL runs always return the same assignment. Multi-URL runs use the
 * configured strategy — currently round-robin only (other strategies reserved
 * in the enum; see tracking issue adcontextprotocol/adcp-client#607 for a
 * dependency-aware variant that closes the 2-replica coverage gap). Each
 * step increments the counter so step N hits `clients[N % N_urls]`,
 * deterministic and reproducible for bug reports.
 */
function createDispatcher(agentUrls: string[], clients: TestClient[], _strategy: 'round-robin'): Dispatcher {
  let counter = 0;
  return {
    nextFor(_step: StoryboardStep): StepAssignment {
      const idx = counter % agentUrls.length;
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
