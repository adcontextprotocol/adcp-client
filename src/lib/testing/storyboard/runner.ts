/**
 * Storyboard execution engine.
 *
 * Two entry points:
 * - runStoryboard(): run all phases/steps sequentially
 * - runStoryboardStep(): run a single step (stateless, LLM-friendly)
 */

import { getOrCreateClient, getOrDiscoverProfile, runStep } from '../client';
import { closeMCPConnections } from '../../protocols/mcp';
import { executeStoryboardTask } from './task-map';
import { extractContext, injectContext, applyContextOutputs, applyContextInputs } from './context';
import { runValidations } from './validations';
import { buildRequest, hasRequestBuilder } from './request-builder';
import type {
  Storyboard,
  StoryboardStep,
  StoryboardContext,
  StoryboardRunOptions,
  StoryboardResult,
  StoryboardPhaseResult,
  StoryboardStepResult,
  StoryboardStepPreview,
  ValidationResult,
} from './types';

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
  const start = Date.now();
  const client = getOrCreateClient(agentUrl, options);

  // Initialize MCP session — discovers agent profile, keeps the transport alive.
  // Without this, Streamable HTTP degrades to SSE after a few calls.
  if (!options._client) {
    const { profile } = await getOrDiscoverProfile(client, options);
    // Populate agentTools from discovered profile if not already set
    if (!options.agentTools && profile?.tools) {
      options = { ...options, agentTools: profile.tools };
    }
  }

  let context: StoryboardContext = { ...options.context };
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

      const result = await executeStep(client, step, phase.id, context, allSteps, options);
      stepResults.push(result);

      if (result.skipped) {
        skippedCount++;
        context = result.context;
      } else if (result.passed) {
        context = result.context;
        passedCount++;
      } else {
        phasePassed = false;
        failedCount++;
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

  const result: StoryboardResult = {
    storyboard_id: storyboard.id,
    storyboard_title: storyboard.title,
    agent_url: agentUrl,
    overall_passed: failedCount === 0 && passedCount > 0,
    phases: phaseResults,
    context,
    total_duration_ms: Date.now() - start,
    passed_count: passedCount,
    failed_count: failedCount,
    skipped_count: skippedCount,
    tested_at: new Date().toISOString(),
  };

  // Close MCP connections when the runner created its own client
  if (!options._client) {
    await closeMCPConnections();
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
  const client = getOrCreateClient(agentUrl, options);

  // Initialize MCP session for standalone step execution
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
    await closeMCPConnections();
  }

  return result;
}

// ────────────────────────────────────────────────────────────
// Internal: execute a single step
// ────────────────────────────────────────────────────────────

async function executeStep(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- client type varies (TestClient)
  client: any,
  step: StoryboardStep,
  phaseId: string,
  context: StoryboardContext,
  allSteps: FlatStep[],
  options: StoryboardRunOptions
): Promise<StoryboardStepResult> {
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
  if (options.agentTools && !options.agentTools.includes(step.task)) {
    const next = getNextStepPreview(step.id, allSteps, context);
    return {
      step_id: step.id,
      phase_id: phaseId,
      title: step.title,
      task: step.task,
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
  } else if (hasRequestBuilder(step.task)) {
    request = buildRequest(step, context, options);
  } else if (step.sample_request) {
    request = injectContext({ ...step.sample_request }, context);
  } else {
    request = {};
  }

  // Apply explicit context_inputs on top of whatever request source was used
  if (step.context_inputs?.length) {
    request = applyContextInputs(request, step.context_inputs, context);
  }

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

  // Execute the task
  // eslint-disable-next-line prefer-const -- stepResult is const but taskResult is reassigned below
  let { result: taskResult, step: stepResult } = await runStep(step.title, step.task, () =>
    executeStoryboardTask(client, step.task, request)
  );

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

  // For expect_error steps: extract error data so validations can check fields.
  // Error data may come from a thrown exception (stepResult.error) or from a
  // TaskResult with success: false but no data (TaskExecutor catches MCP throws).
  if (step.expect_error && !taskResult?.data) {
    const errorSource = stepResult.error || taskResult?.error;
    if (errorSource) {
      const errorData = extractErrorData(errorSource);
      if (errorData) {
        taskResult = { success: false, data: errorData, error: errorSource };
      }
    }
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
  if (taskResult && step.validations?.length) {
    validations = runValidations(step.validations, step.task, taskResult);
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
 * Extract adcp_error data from an error message string.
 *
 * When adcpError() responses are thrown as exceptions, the error message
 * contains JSON with the adcp_error structure. This extracts it so
 * expect_error step validations can check error fields.
 */
function extractErrorData(errorMessage: string): Record<string, unknown> | null {
  // Find a JSON object containing adcp_error by trying JSON.parse from each '{'
  if (errorMessage.includes('"adcp_error"')) {
    for (let i = errorMessage.indexOf('{'); i !== -1; i = errorMessage.indexOf('{', i + 1)) {
      try {
        const parsed = JSON.parse(errorMessage.slice(i)) as Record<string, unknown>;
        if (parsed.adcp_error) return parsed;
      } catch {
        // Not valid JSON from this position, keep looking
      }
    }
  }

  // Try to find just the adcp_error object embedded in the message
  const codeMatch = errorMessage.match(/"code"\s*:\s*"([A-Z_]+)"/);
  if (codeMatch) {
    return {
      adcp_error: {
        code: codeMatch[1],
        message: errorMessage,
      },
    };
  }

  // Handle comply_test_controller error responses: "Controller error: ERROR_CODE"
  const controllerMatch = errorMessage.match(/Controller error:\s*([A-Z_]+)/);
  if (controllerMatch) {
    return {
      success: false,
      error: controllerMatch[1],
      error_detail: errorMessage,
    };
  }

  return null;
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
