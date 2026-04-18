/**
 * Per-step validation engine for storyboard testing.
 *
 * Supports four validation types defined in storyboard YAML:
 * - response_schema: validate against Zod schemas
 * - field_present: check a JSON path exists and is not null/undefined
 * - field_value: check a JSON path equals an expected value
 * - status_code: check the TaskResult status
 */

import { TOOL_RESPONSE_SCHEMAS } from '../../utils/response-schemas';
import type { TaskResult } from '../types';
import type { HttpProbeResult, StoryboardValidation, ValidationResult } from './types';
import { resolvePath } from './path';

/**
 * Broader validation context that carries the run-level state a single
 * validation might need: the task result (for MCP tools), the HTTP probe
 * result (for raw tasks), the agent URL (for cross-cutting checks like
 * `resource_equals_agent_url`), and the accumulated contribution flags.
 */
export interface ValidationContext {
  taskName: string;
  taskResult?: TaskResult;
  httpResult?: HttpProbeResult;
  agentUrl: string;
  contributions: Set<string>;
}

/**
 * Run all validations for a storyboard step.
 */
export function runValidations(validations: StoryboardValidation[], context: ValidationContext): ValidationResult[] {
  return validations.map(v => runValidation(v, context));
}

function runValidation(validation: StoryboardValidation, ctx: ValidationContext): ValidationResult {
  switch (validation.check) {
    case 'response_schema':
      return requireTaskResult(ctx, validation, tr => validateResponseSchema(validation, ctx.taskName, tr));
    case 'field_present':
      return requireTaskResult(ctx, validation, tr => validateFieldPresent(validation, tr));
    case 'field_value':
      return requireTaskResult(ctx, validation, tr => validateFieldValue(validation, tr));
    case 'status_code':
      return requireTaskResult(ctx, validation, tr => validateStatusCode(validation, tr));
    case 'error_code':
      return requireTaskResult(ctx, validation, tr => validateErrorCode(validation, tr));
    case 'http_status':
      return requireHttpResult(ctx, validation, hr => validateHttpStatus(validation, hr));
    case 'http_status_in':
      return requireHttpResult(ctx, validation, hr => validateHttpStatusIn(validation, hr));
    case 'on_401_require_header':
      return requireHttpResult(ctx, validation, hr => validateOn401RequireHeader(validation, hr));
    case 'resource_equals_agent_url':
      return requireHttpResult(ctx, validation, hr => validateResourceEqualsAgentUrl(validation, hr, ctx.agentUrl));
    case 'any_of':
      return validateAnyOf(validation, ctx.contributions);
    default:
      return {
        check: validation.check,
        passed: false,
        description: validation.description,
        error: `Unknown validation check: ${validation.check}`,
      };
  }
}

function requireTaskResult(
  ctx: ValidationContext,
  validation: StoryboardValidation,
  fn: (tr: TaskResult) => ValidationResult
): ValidationResult {
  if (!ctx.taskResult) {
    return {
      check: validation.check,
      passed: false,
      description: validation.description,
      error: `Validation "${validation.check}" requires an MCP task result but this step was an HTTP probe.`,
    };
  }
  return fn(ctx.taskResult);
}

function requireHttpResult(
  ctx: ValidationContext,
  validation: StoryboardValidation,
  fn: (hr: HttpProbeResult) => ValidationResult
): ValidationResult {
  if (!ctx.httpResult) {
    return {
      check: validation.check,
      passed: false,
      description: validation.description,
      error: `Validation "${validation.check}" requires an HTTP probe result but this step was an MCP task.`,
    };
  }
  return fn(ctx.httpResult);
}

// ────────────────────────────────────────────────────────────
// response_schema: validate against Zod
// ────────────────────────────────────────────────────────────

function validateResponseSchema(
  validation: StoryboardValidation,
  taskName: string,
  taskResult: TaskResult
): ValidationResult {
  const schema = TOOL_RESPONSE_SCHEMAS[taskName];
  if (!schema) {
    return {
      check: 'response_schema',
      passed: false,
      description: validation.description,
      error: `No schema registered for task "${taskName}"`,
    };
  }

  // Strip _message from data before validation — it's added by the response
  // unwrapper as a text summary and is not part of the AdCP response schema.
  const { _message, ...dataWithoutMessage } = (taskResult.data ?? {}) as Record<string, unknown>;
  const parseResult = schema.safeParse(dataWithoutMessage);
  if (parseResult.success) {
    return {
      check: 'response_schema',
      passed: true,
      description: validation.description,
    };
  }

  // Format Zod errors
  const issues = parseResult.error.issues
    .slice(0, 5)
    .map(i => `${i.path.join('.')}: ${i.message}`)
    .join('; ');

  return {
    check: 'response_schema',
    passed: false,
    description: validation.description,
    error: issues,
  };
}

// ────────────────────────────────────────────────────────────
// field_present: check a path exists
// ────────────────────────────────────────────────────────────

function validateFieldPresent(validation: StoryboardValidation, taskResult: TaskResult): ValidationResult {
  if (!validation.path) {
    return {
      check: 'field_present',
      passed: false,
      description: validation.description,
      path: validation.path,
      error: 'No path specified for field_present validation',
    };
  }

  const value = resolvePath(taskResult.data, validation.path);
  const present = value !== undefined && value !== null;

  return {
    check: 'field_present',
    passed: present,
    description: validation.description,
    path: validation.path,
    error: present ? undefined : `Field not found at path: ${validation.path}`,
  };
}

// ────────────────────────────────────────────────────────────
// field_value: check a path equals expected value
// ────────────────────────────────────────────────────────────

function valuesMatch(actual: unknown, expected: unknown): boolean {
  if (typeof actual === 'object' && actual !== null) {
    return JSON.stringify(actual) === JSON.stringify(expected);
  }
  return actual === expected;
}

function validateFieldValue(validation: StoryboardValidation, taskResult: TaskResult): ValidationResult {
  if (!validation.path) {
    return {
      check: 'field_value',
      passed: false,
      description: validation.description,
      path: validation.path,
      error: 'No path specified for field_value validation',
    };
  }

  const actual = resolvePath(taskResult.data, validation.path);

  // allowed_values: pass if actual matches any value in the list
  if (validation.allowed_values?.length) {
    const passed = validation.allowed_values.some(v => valuesMatch(actual, v));
    return {
      check: 'field_value',
      passed,
      description: validation.description,
      path: validation.path,
      error: passed
        ? undefined
        : `Expected one of ${JSON.stringify(validation.allowed_values)}, got ${JSON.stringify(actual)}`,
    };
  }

  // Exact match against value
  const passed = valuesMatch(actual, validation.value);

  return {
    check: 'field_value',
    passed,
    description: validation.description,
    path: validation.path,
    error: passed ? undefined : `Expected ${JSON.stringify(validation.value)}, got ${JSON.stringify(actual)}`,
  };
}

// ────────────────────────────────────────────────────────────
// status_code: check TaskResult status
// ────────────────────────────────────────────────────────────

function validateStatusCode(validation: StoryboardValidation, taskResult: TaskResult): ValidationResult {
  // Check success status
  const passed = taskResult.success;

  return {
    check: 'status_code',
    passed,
    description: validation.description,
    error: passed ? undefined : `Task failed: ${taskResult.error || 'unknown error'}`,
  };
}

// Strip the "CODE: message" prefix some transports produce, leaving just the
// code. Returns undefined when the input doesn't look like a coded error.
function extractCodeFromErrorString(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const match = /^([A-Z][A-Z0-9_]{2,}):\s/.exec(raw);
  return match ? match[1] : raw;
}

// ────────────────────────────────────────────────────────────
// error_code: check error code in error response
// ────────────────────────────────────────────────────────────

function validateErrorCode(validation: StoryboardValidation, taskResult: TaskResult): ValidationResult {
  // Extract error code from various locations agents might put it.
  // Prefer the L3 structured path (data.adcp_error.code) so we get a bare code
  // instead of the "CODE: message" string materialized on taskResult.error.
  const data = taskResult.data as Record<string, unknown> | undefined;
  const adcpError = data?.adcp_error as Record<string, unknown> | undefined;
  const errorCode =
    adcpError?.code ??
    data?.error_code ??
    data?.code ??
    (data?.error as Record<string, unknown> | undefined)?.code ??
    extractCodeFromErrorString(taskResult.error);

  if (validation.allowed_values?.length) {
    const actual = errorCode !== undefined && errorCode !== null ? String(errorCode) : undefined;
    const passed = actual !== undefined && validation.allowed_values.some(v => String(v) === actual);
    return {
      check: 'error_code',
      passed,
      description: validation.description,
      error: passed
        ? undefined
        : `Expected one of ${JSON.stringify(validation.allowed_values)}, got ${JSON.stringify(errorCode)}`,
    };
  }

  if (!validation.value) {
    // Just check that an error code exists
    const hasCode = errorCode !== undefined && errorCode !== null;
    return {
      check: 'error_code',
      passed: hasCode,
      description: validation.description,
      error: hasCode ? undefined : 'No error code found in response',
    };
  }

  const passed = String(errorCode) === String(validation.value);
  return {
    check: 'error_code',
    passed,
    description: validation.description,
    error: passed ? undefined : `Expected error code "${validation.value}", got "${errorCode}"`,
  };
}

// ────────────────────────────────────────────────────────────
// http_status / http_status_in
// ────────────────────────────────────────────────────────────

function validateHttpStatus(validation: StoryboardValidation, hr: HttpProbeResult): ValidationResult {
  const expected = validation.value as number | undefined;
  const passed = typeof expected === 'number' && hr.status === expected;
  return {
    check: 'http_status',
    passed,
    description: validation.description,
    error: passed ? undefined : `Expected HTTP ${expected}, got ${hr.status}${hr.error ? ` (${hr.error})` : ''}`,
  };
}

function validateHttpStatusIn(validation: StoryboardValidation, hr: HttpProbeResult): ValidationResult {
  const allowed = Array.isArray(validation.allowed_values) ? validation.allowed_values : [];
  const passed = allowed.some(v => v === hr.status);
  return {
    check: 'http_status_in',
    passed,
    description: validation.description,
    error: passed
      ? undefined
      : `Expected HTTP status in ${JSON.stringify(allowed)}, got ${hr.status}${hr.error ? ` (${hr.error})` : ''}`,
  };
}

// ────────────────────────────────────────────────────────────
// on_401_require_header
// ────────────────────────────────────────────────────────────

function validateOn401RequireHeader(validation: StoryboardValidation, hr: HttpProbeResult): ValidationResult {
  const header = typeof validation.value === 'string' ? validation.value.toLowerCase() : undefined;
  if (!header) {
    return {
      check: 'on_401_require_header',
      passed: false,
      description: validation.description,
      error: '`value` is required (the header name to require on 401 responses).',
    };
  }
  // Silent pass when the response isn't a 401 — the conditional is part of
  // the spec (RFC 6750 §3 only applies to 401s).
  if (hr.status !== 401) {
    return { check: 'on_401_require_header', passed: true, description: validation.description };
  }
  const value = hr.headers[header];
  const passed = typeof value === 'string' && value.length > 0;
  return {
    check: 'on_401_require_header',
    passed,
    description: validation.description,
    error: passed ? undefined : `401 response missing required header "${header}".`,
  };
}

// ────────────────────────────────────────────────────────────
// resource_equals_agent_url
// ────────────────────────────────────────────────────────────

function normalizeAgentUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = '';
    u.search = '';
    // Drop trailing slash but keep the root "/".
    if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
      u.pathname = u.pathname.slice(0, -1);
    }
    return `${u.protocol.toLowerCase()}//${u.host.toLowerCase()}${u.pathname}`;
  } catch {
    return url;
  }
}

function validateResourceEqualsAgentUrl(
  validation: StoryboardValidation,
  hr: HttpProbeResult,
  agentUrl: string
): ValidationResult {
  const body = (hr.body ?? {}) as { resource?: unknown };
  const resource = typeof body.resource === 'string' ? body.resource : undefined;
  if (!resource) {
    return {
      check: 'resource_equals_agent_url',
      passed: false,
      description: validation.description,
      error: 'Response body missing string `resource` field.',
    };
  }
  const expected = normalizeAgentUrl(agentUrl);
  const actual = normalizeAgentUrl(resource);
  const passed = actual === expected;
  return {
    check: 'resource_equals_agent_url',
    passed,
    description: validation.description,
    // Don't echo the agent-advertised value verbatim — compliance reports may
    // be shared publicly and the raw diff helps attackers probe victim agents.
    // Report mismatch in a redacted shape.
    error: passed ? undefined : 'Advertised `resource` does not match agent URL.',
  };
}

// ────────────────────────────────────────────────────────────
// any_of (contribution accumulator)
// ────────────────────────────────────────────────────────────

function validateAnyOf(validation: StoryboardValidation, contributions: Set<string>): ValidationResult {
  const flags = Array.isArray(validation.allowed_values) ? validation.allowed_values.map(String) : [];
  const passed = flags.some(f => contributions.has(f));
  return {
    check: 'any_of',
    passed,
    description: validation.description,
    error: passed ? undefined : `None of the required contributions were recorded: ${JSON.stringify(flags)}`,
  };
}

// resolvePath re-exported from ./path for backwards compat
export { resolvePath } from './path';
