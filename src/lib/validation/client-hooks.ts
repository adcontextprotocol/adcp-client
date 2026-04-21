/**
 * Client-side hooks that run the schema validator around every AdCP tool
 * call. Pre-send validation blocks malformed requests; post-receive
 * validation catches field-name drift from agents (issue #688).
 */

import { validateRequest, validateResponse, formatIssues, type ValidationOutcome } from './schema-validator';
import { buildValidationError } from './schema-errors';

export type ValidationMode = 'strict' | 'warn' | 'off';

export interface ValidationHookConfig {
  /** Validate outgoing requests. Default: strict in dev/test, warn in prod. */
  requests?: ValidationMode;
  /** Validate incoming responses. Default: strict in dev/test, warn in prod. */
  responses?: ValidationMode;
}

function defaultResponseMode(): ValidationMode {
  // Responses have been validated strictly by default since the SDK shipped
  // Zod validation; preserve that in dev/test and soften to warn in prod.
  return process.env.NODE_ENV === 'production' ? 'warn' : 'strict';
}

/**
 * Resolve the effective request/response modes.
 *
 * Response default: strict in dev/test, warn in prod (preserves the
 * existing `strictSchemaValidation` contract).
 *
 * Request default: `warn` everywhere. Strict-by-default would break
 * existing callers that intentionally send partial payloads (error-path
 * tests, exploratory probes) — storyboards and third-party clients that
 * want hard-stop enforcement should set `requests: 'strict'` explicitly.
 */
export function resolveValidationModes(config?: ValidationHookConfig): Required<ValidationHookConfig> {
  return {
    requests: config?.requests ?? 'warn',
    responses: config?.responses ?? defaultResponseMode(),
  };
}

export interface DebugLogEntry {
  type: 'info' | 'success' | 'warning' | 'error';
  message: string;
  timestamp: string;
  [k: string]: unknown;
}

function logWarning(debugLogs: DebugLogEntry[] | undefined, taskName: string, outcome: ValidationOutcome): void {
  if (!debugLogs) return;
  debugLogs.push({
    type: 'warning',
    message: `Schema validation warning for ${taskName}: ${formatIssues(outcome.issues)}`,
    timestamp: new Date().toISOString(),
    schemaVariant: outcome.variant,
    issues: outcome.issues,
  });
}

/**
 * Run request validation per the configured mode.
 * - `off`: no-op (true).
 * - `warn`: log to debug + continue (true).
 * - `strict`: throw `ValidationError` with JSON Pointer to the first bad field.
 */
export function validateOutgoingRequest(
  taskName: string,
  params: unknown,
  mode: ValidationMode,
  debugLogs?: DebugLogEntry[]
): ValidationOutcome | undefined {
  if (mode === 'off') return undefined;
  const outcome = validateRequest(taskName, params);
  if (outcome.valid) return outcome;
  if (mode === 'warn') {
    logWarning(debugLogs, taskName, outcome);
    return outcome;
  }
  throw buildValidationError(taskName, 'request', outcome.issues);
}

/**
 * Run response validation per the configured mode.
 * - `off`: no-op (valid).
 * - `warn`: log + return invalid outcome so the caller can surface details.
 * - `strict`: return the invalid outcome so the caller fails the task.
 * Does NOT throw — matches the existing response-side contract where a
 * validation failure turns a task into `status: 'failed'` rather than
 * raising out of the SDK.
 */
export function validateIncomingResponse(
  taskName: string,
  data: unknown,
  mode: ValidationMode,
  debugLogs?: DebugLogEntry[]
): ValidationOutcome {
  if (mode === 'off') return { valid: true, issues: [], variant: 'sync' };
  const outcome = validateResponse(taskName, data);
  if (!outcome.valid && mode === 'warn') {
    logWarning(debugLogs, taskName, outcome);
  }
  return outcome;
}
