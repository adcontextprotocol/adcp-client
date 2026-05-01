/**
 * Client-side hooks that run the schema validator around every AdCP tool
 * call. Pre-send validation blocks malformed requests; post-receive
 * validation catches field-name drift from agents (issue #688).
 */

import { validateRequest, validateResponse, formatIssues, type ValidationOutcome } from './schema-validator';
import { buildValidationError } from './schema-errors';

export type ValidationMode = 'strict' | 'warn' | 'off';

export interface ValidationHookConfig {
  /** Validate outgoing requests. Default: `warn` everywhere. */
  requests?: ValidationMode;
  /** Validate incoming responses. Default: `warn` everywhere. */
  responses?: ValidationMode;
}

/**
 * Resolve the effective request/response modes.
 *
 * Both default to `warn` everywhere — buyers get drift surfaced through
 * `result.debug_logs` without losing the response payload to a strict
 * rejection. v2.5 sellers in particular ship enough legacy drift
 * (envelope nulls, optional-required fields, enum mismatches) that
 * strict-by-default leaves callers staring at "0 products" with no
 * useful signal. Buyers and harnesses that want hard-stop behavior
 * (conformance suites, third-party validators) opt into strict via
 * `validation: { responses: 'strict' }` — explicit config always wins.
 *
 * This is the **client-side** default. `createAdcpServer` keeps its
 * stricter dev/test handler-validation contract — that catches our own
 * handler bugs, which strict mode is genuinely good at.
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
  let outcome: ValidationOutcome;
  try {
    outcome = validateRequest(taskName, params, version);
  } catch (err) {
    // Schema bundle missing (e.g. schemas not synced in CI). In strict mode
    // re-throw so misconfigured environments fail loudly; in warn mode treat
    // as non-fatal so the call proceeds without validation coverage.
    if (mode === 'strict') throw err;
    if (debugLogs) {
      debugLogs.push({
        type: 'warning',
        message: `Request validation skipped for ${taskName}: ${err instanceof Error ? err.message : String(err)}`,
        timestamp: new Date().toISOString(),
      });
    }
    return undefined;
  }
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
