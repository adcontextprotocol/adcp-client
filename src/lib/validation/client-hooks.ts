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
  /** Validate incoming responses. Default: warn everywhere. Use `'strict'` to hard-fail on drift (e.g. conformance runner, CI). */
  responses?: ValidationMode;
}

/**
 * Resolve the effective request/response modes.
 *
 * Both default to `warn` everywhere. Strict-by-default would break callers
 * that legitimately send partial payloads or receive v2.x responses that
 * don't satisfy 100% of the current schema — the client can't control what
 * a third-party seller sends back. Set `responses: 'strict'` (or
 * `requests: 'strict'`) explicitly when you want hard-stop enforcement,
 * e.g. the storyboard runner or a CI smoke test.
 */
export function resolveValidationModes(config?: ValidationHookConfig): Required<ValidationHookConfig> {
  return {
    requests: config?.requests ?? 'warn',
    responses: config?.responses ?? 'warn',
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
 *
 * `version` selects which AdCP version's schema bundle to validate against;
 * defaults to the SDK-pinned `ADCP_VERSION`. Pass the per-instance value from
 * `getAdcpVersion()` so a client/server validates against its own pinned bundle.
 */
export function validateOutgoingRequest(
  taskName: string,
  params: unknown,
  mode: ValidationMode,
  debugLogs?: DebugLogEntry[],
  version?: string
): ValidationOutcome | undefined {
  if (mode === 'off') return undefined;
  const outcome = validateRequest(taskName, params, version);
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
  debugLogs?: DebugLogEntry[],
  version?: string
): ValidationOutcome {
  if (mode === 'off') return { valid: true, issues: [], variant: 'sync' };
  const outcome = validateResponse(taskName, data, version);
  if (!outcome.valid && mode === 'warn') {
    logWarning(debugLogs, taskName, outcome);
  }
  return outcome;
}
