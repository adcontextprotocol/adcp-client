/**
 * Storyboard execution engine.
 *
 * Two entry points:
 * - runStoryboard(): run all phases/steps sequentially
 * - runStoryboardStep(): run a single step (stateless, LLM-friendly)
 */

import { getOrCreateClient, getOrDiscoverProfile, runStep } from '../client';
import { closeConnections } from '../../protocols';
import { executeStoryboardTask } from './task-map';
import { extractContext, injectContext, applyContextOutputs, applyContextInputs } from './context';
import { runValidations, type ValidationContext } from './validations';
import { buildRequest, hasRequestBuilder } from './request-builder';
import { resolveBrand } from '../client';
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
import type { TaskResult } from '../types';

// ────────────────────────────────────────────────────────────
// runStoryboard: execute all phases/steps
// ────────────────────────────────────────────────────────────

/**
 * Run an entire storyboard against an agent.
 */
export async function runStoryboard(
  agentUrl: string,
  storyboard: Storyboard,
  options: StoryboardRunOptions = {}
): Promise<StoryboardResult> {
  validateTestKit(options.test_kit);
  const start = Date.now();
  const client = getOrCreateClient(agentUrl, options);

  // Discover agent profile and (for MCP) keep the transport alive.
  if (!options._client) {
    const { profile } = await getOrDiscoverProfile(client, options);
    // Populate agentTools from discovered profile if not already set
    if (!options.agentTools && profile?.tools) {
      options = { ...options, agentTools: profile.tools };
    }
  }

  let context: StoryboardContext = { ...options.context };
  const contributions = new Set<string>();
  const priorStepResults = new Map<string, StoryboardStepResult>();
  const priorProbes = new Map<string, HttpProbeResult>();
  const phaseResults: StoryboardPhaseResult[] = [];
  let passedCount = 0;
  let failedCount = 0;
  let skippedCount = 0;

  // Flatten all steps for next-step preview lookups
  const allSteps = flattenSteps(storyboard);

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
        stepResults.push({
          step_id: step.id,
          phase_id: phase.id,
          title: step.title,
          task: step.task,
          passed: false,
          skipped: true,
          skip_reason: 'dependency_failed',
          duration_ms: 0,
          validations: [],
          context,
          error: 'Skipped: prior stateful step failed',
        });
        skippedCount++;
        phasePassed = false;
        continue;
      }

      const result = await executeStep(client, step, phase.id, context, allSteps, options, {
        contributions,
        priorStepResults,
        priorProbes,
        agentUrl,
      });
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
  const result: StoryboardResult = {
    storyboard_id: storyboard.id,
    storyboard_title: storyboard.title,
    agent_url: agentUrl,
    overall_passed: failedCount === 0 && requiredPhasesPassed,
    phases: phaseResults,
    context,
    total_duration_ms: Date.now() - start,
    passed_count: passedCount,
    failed_count: failedCount,
    skipped_count: skippedCount,
    tested_at: new Date().toISOString(),
  };

  // Close protocol connections when the runner created its own client
  if (!options._client) {
    await closeConnections(options.protocol);
  }

  return result;
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

  // Find the step
  const allSteps = flattenSteps(storyboard);
  const found = allSteps.find(s => s.step.id === stepId);
  if (!found) {
    throw new Error(
      `Step "${stepId}" not found in storyboard "${storyboard.id}". ` +
        `Available steps: ${allSteps.map(s => s.step.id).join(', ')}`
    );
  }

  const result = await executeStep(client, found.step, found.phaseId, context, allSteps, options);

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
    };
  }
  const effectiveStep: StoryboardStep = resolvedTask === step.task ? step : { ...step, task: resolvedTask };

  // Check requires_tool — skip if agent doesn't have it
  if (step.requires_tool && options.agentTools && !options.agentTools.includes(step.requires_tool)) {
    const next = getNextStepPreview(step.id, allSteps, context);
    return {
      step_id: step.id,
      phase_id: phaseId,
      title: step.title,
      task: step.task,
      passed: true,
      skipped: true,
      skip_reason: step.requires_tool === 'comply_test_controller' ? 'missing_test_harness' : 'not_testable',
      duration_ms: 0,
      validations: [],
      context,
      next,
    };
  }

  // Skip if agent doesn't implement the tool this step calls.
  if (options.agentTools && !options.agentTools.includes(effectiveStep.task)) {
    const next = getNextStepPreview(step.id, allSteps, context);
    return {
      step_id: step.id,
      phase_id: phaseId,
      title: step.title,
      task: effectiveStep.task,
      passed: true,
      skipped: true,
      skip_reason: 'missing_tool',
      duration_ms: 0,
      validations: [],
      context,
      next,
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
    // don't include these, but storyboards define them for compliance testing.
    // Only context and ext are merged: they are opaque pass-through fields with
    // no schema validation. Other envelope fields (push_notification_config,
    // governance_context, idempotency_key) have structured schemas and are
    // handled by the request builder when needed.
    if (step.sample_request) {
      if (step.sample_request.context !== undefined && request.context === undefined) {
        request.context = injectContext({ context: step.sample_request.context }, context).context;
      }
      if (step.sample_request.ext !== undefined && request.ext === undefined) {
        request.ext = step.sample_request.ext;
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
    return {
      step_id: step.id,
      phase_id: phaseId,
      title: step.title,
      task: step.task,
      passed: false,
      skipped: true,
      skip_reason: 'dependency_failed',
      duration_ms: 0,
      validations: [],
      context,
      error: `Skipped: unresolved context variables: ${unresolvedVars.join(', ')}`,
      next,
    };
  }

  // Execute the task. When the step overrides auth, dispatch via the raw MCP
  // probe so we can (a) strip credentials or send arbitrary Bearer values
  // (which the SDK transport doesn't expose), and (b) capture the HTTP status
  // + `WWW-Authenticate` header for http_* validations.
  let taskResult: TaskResult | undefined;
  let stepResult: { duration_ms: number; error?: string; passed: boolean };
  let httpResult: HttpProbeResult | undefined;

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
      stepResult = {
        duration_ms: Date.now() - started,
        passed: !httpResult.error,
        error: httpResult.error,
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
      executeStoryboardTask(client, effectiveStep.task, request)
    );
    taskResult = run.result;
    stepResult = run.step;
  }

  // Feature-unsupported or unknown-tool errors → treat as skip
  const isUnsupported = stepResult.error?.includes('does not support:');
  const isUnknownTool = stepResult.error && /Unknown tool[:\s]/i.test(stepResult.error);
  if (!taskResult && (isUnsupported || isUnknownTool)) {
    const next = getNextStepPreview(step.id, allSteps, context);
    return {
      step_id: step.id,
      phase_id: phaseId,
      title: step.title,
      task: step.task,
      passed: true,
      skipped: true,
      skip_reason: isUnknownTool ? 'missing_tool' : 'not_testable',
      duration_ms: stepResult.duration_ms,
      validations: [],
      context,
      error: stepResult.error,
      next,
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

  // Run validations
  let validations: ValidationResult[] = [];
  if (step.validations?.length && (taskResult || httpResult)) {
    const vctx: ValidationContext = {
      taskName: effectiveStep.task,
      ...(taskResult && { taskResult }),
      ...(httpResult && { httpResult }),
      agentUrl: runState.agentUrl,
      contributions: runState.contributions,
    };
    validations = runValidations(step.validations, vctx);
  }

  const allValidationsPassed = validations.every(v => v.passed);

  // Extract context from responses
  const updatedContext = { ...context };
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

  const vctx: ValidationContext = {
    taskName: step.task,
    httpResult,
    agentUrl: runState.agentUrl,
    contributions: runState.contributions,
  };
  const validations = step.validations?.length ? runValidations(step.validations, vctx) : [];
  const allValidationsPassed = validations.every(v => v.passed);

  // For probes, the "task passed" proxy is: fetch returned without error AND
  // all validations passed. For assert_contribution (no httpResult), we lean
  // on validations alone.
  const fetchOk = httpResult ? !httpResult.error : true;
  const passed = fetchOk && allValidationsPassed;

  return {
    step_id: step.id,
    phase_id: phaseId,
    title: step.title,
    task: step.task,
    passed,
    duration_ms: Date.now() - start,
    response: httpResult ?? undefined,
    validations,
    context,
    error: httpResult?.error ?? (passed ? undefined : 'Probe validations failed.'),
    next: getNextStepPreview(step.id, allSteps, context),
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
