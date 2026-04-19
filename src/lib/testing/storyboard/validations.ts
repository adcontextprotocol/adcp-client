/**
 * Per-step validation engine for storyboard testing.
 *
 * Supports four validation types defined in storyboard YAML:
 * - response_schema: validate against Zod schemas
 * - field_present: check a JSON path exists and is not null/undefined
 * - field_value: check a JSON path equals an expected value
 * - status_code: check the TaskResult status
 */

import { TOOL_RESPONSE_SCHEMAS, getResponseSchemaLocator } from '../../utils/response-schemas';
import { ADCP_VERSION } from '../../version';
import type { TaskResult } from '../types';
import type { HttpProbeResult, StoryboardValidation, ValidationResult } from './types';
import { resolvePath, toJsonPointer } from './path';
import { PROBE_TASK_ALLOWLIST } from './test-kit';

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
      // field_present runs against either MCP task result data OR an HTTP probe body —
      // the storyboard's probe_protected_resource validates fields in the RFC 9728 JSON.
      return validateFieldPresent(validation, resolveTarget(ctx));
    case 'field_value':
      return validateFieldValue(validation, resolveTarget(ctx));
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

/**
 * Resolve the object path-style validations should walk. Prefers the MCP
 * task result's `data` and falls back to the HTTP probe body, so the same
 * `field_present` / `field_value` validations work for both MCP tool steps
 * and raw RFC 9728 / RFC 8414 metadata probes.
 */
function resolveTarget(ctx: ValidationContext): TaskResult {
  if (ctx.taskResult) return ctx.taskResult;
  if (ctx.httpResult) return { success: !ctx.httpResult.error, data: ctx.httpResult.body };
  return { success: false, data: undefined };
}

// ────────────────────────────────────────────────────────────
// response_schema: validate against Zod
// ────────────────────────────────────────────────────────────

function validateResponseSchema(
  validation: StoryboardValidation,
  taskName: string,
  taskResult: TaskResult
): ValidationResult {
  const locator = getResponseSchemaLocator(taskName, ADCP_VERSION);
  const schema = TOOL_RESPONSE_SCHEMAS[taskName];
  if (!schema) {
    return {
      check: 'response_schema',
      passed: false,
      description: validation.description,
      error: `No schema registered for task "${taskName}"`,
      expected: locator?.schema_id,
      ...(locator && { schema_id: locator.schema_id, schema_url: locator.schema_url }),
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
      ...(locator && { schema_id: locator.schema_id, schema_url: locator.schema_url }),
    };
  }

  // AJV-style structured actual per runner-output contract.
  const actual = parseResult.error.issues.slice(0, 20).map(i => ({
    instance_path: i.path.length > 0 ? '/' + i.path.map(p => String(p).replace(/~/g, '~0').replace(/\//g, '~1')).join('/') : '',
    keyword: i.code,
    message: i.message,
  }));

  // Pin the json_pointer to the first offending field for the actionability
  // "one-line read" the contract calls out. Multiple issues are still in `actual`.
  const firstIssue = parseResult.error.issues[0];
  const json_pointer =
    firstIssue && firstIssue.path.length > 0
      ? '/' + firstIssue.path.map(p => String(p).replace(/~/g, '~0').replace(/\//g, '~1')).join('/')
      : '';

  return {
    check: 'response_schema',
    passed: false,
    description: validation.description,
    error: parseResult.error.issues
      .slice(0, 5)
      .map(i => `${i.path.join('.')}: ${i.message}`)
      .join('; '),
    json_pointer,
    expected: locator?.schema_id,
    actual,
    ...(locator && { schema_id: locator.schema_id, schema_url: locator.schema_url }),
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
    json_pointer: toJsonPointer(validation.path),
    expected: 'present',
    actual: present ? value : null,
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
  const json_pointer = toJsonPointer(validation.path);

  // allowed_values: pass if actual matches any value in the list
  if (validation.allowed_values?.length) {
    const passed = validation.allowed_values.some(v => valuesMatch(actual, v));
    return {
      check: 'field_value',
      passed,
      description: validation.description,
      path: validation.path,
      json_pointer,
      expected: validation.allowed_values,
      actual,
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
    json_pointer,
    expected: validation.value,
    actual,
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
    expected: 'success',
    actual: passed ? 'success' : 'failed',
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
    const actualStr = errorCode !== undefined && errorCode !== null ? String(errorCode) : undefined;
    const passed = actualStr !== undefined && validation.allowed_values.some(v => String(v) === actualStr);
    return {
      check: 'error_code',
      passed,
      description: validation.description,
      json_pointer: '/adcp_error/code',
      expected: validation.allowed_values,
      actual: errorCode ?? null,
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
      json_pointer: '/adcp_error/code',
      expected: 'present',
      actual: errorCode ?? null,
      error: hasCode ? undefined : 'No error code found in response',
    };
  }

  const passed = String(errorCode) === String(validation.value);
  return {
    check: 'error_code',
    passed,
    description: validation.description,
    json_pointer: '/adcp_error/code',
    expected: validation.value,
    actual: errorCode ?? null,
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
    expected,
    actual: hr.status,
    error: passed ? undefined : `Expected HTTP ${expected}, got ${hr.status}${hr.error ? ` (${hr.error})` : ''}`,
  };
}

function validateHttpStatusIn(validation: StoryboardValidation, hr: HttpProbeResult): ValidationResult {
  const allowed = Array.isArray(validation.allowed_values) ? validation.allowed_values : [];
  const passed = allowed.some(v => v === hr.status);
  if (passed) {
    return {
      check: 'http_status_in',
      passed: true,
      description: validation.description,
      expected: allowed,
      actual: hr.status,
    };
  }
  // Disambiguate two failure modes that produce the same HTTP-status mismatch:
  // (a) the kit's `probe_task` requires non-empty params, so the agent 400s on
  // schema before auth ever runs (operator's fault), or (b) the agent really
  // does evaluate schema before auth (agent's fault — itself a conformance
  // gap). Both are real; the text names both so compliance reports don't
  // unilaterally blame the operator for an agent that games the probe by
  // returning a schema-shaped body.
  const expectedAuthReject = allowed.includes(401) || allowed.includes(403);
  const schemaRejected = (hr.status === 400 || hr.status === 422) && looksLikeSchemaValidationBody(hr.body);
  if (expectedAuthReject && schemaRejected) {
    return {
      check: 'http_status_in',
      passed: false,
      description: validation.description,
      expected: allowed,
      actual: hr.status,
      error:
        `Agent returned HTTP ${hr.status} with a schema-validation body before any auth response. ` +
        `Two possible causes: (1) \`test_kit.auth.probe_task\` points at a task that requires ` +
        `non-empty parameters, so schema validation rejected the probe before auth ran (fix: set ` +
        `\`probe_task\` to one of ${PROBE_TASK_ALLOWLIST.join(', ')}); or (2) the agent evaluates ` +
        `schema before auth, which is itself a conformance gap (protected endpoints must return ` +
        `401/403 on invalid credentials regardless of body shape).`,
    };
  }
  return {
    check: 'http_status_in',
    passed: false,
    description: validation.description,
    expected: allowed,
    actual: hr.status,
    error: `Expected HTTP status in ${JSON.stringify(allowed)}, got ${hr.status}${hr.error ? ` (${hr.error})` : ''}`,
  };
}

const SCHEMA_KEYWORD_RE = /invalid[_ ]?params|validation|schema|required|must be/i;
const SCHEMA_CODE_RE = /VALIDATION|INVALID|SCHEMA|BAD_REQUEST/i;

/**
 * Detect bodies that look like JSON-RPC / MCP schema-validation rejections.
 *
 * Conservative: only returns true when the body has a recognizable error
 * envelope AND either a JSON-RPC invalid-params code (-32602) or a
 * message/field-level hint pointing at schema/validation. Returning true
 * on a real auth response would hide genuine agent bugs, so we over-reject.
 *
 * Handles both parsed JSON object bodies and plain-text bodies — the HTTP
 * probe returns a decoded string when content-type isn't JSON, and agents
 * that 400 with `text/plain` short messages like "missing required field"
 * deserve the same kit-config diagnostic. String detection is deliberately
 * tight: a recognizable schema-keyword substring in a short body (≤ 1 KiB).
 */
function looksLikeSchemaValidationBody(body: unknown): boolean {
  if (typeof body === 'string') {
    return body.length > 0 && body.length <= 1024 && SCHEMA_KEYWORD_RE.test(body);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const obj = body as Record<string, unknown>;
  // JSON-RPC error envelope
  const rpcError = obj.error as Record<string, unknown> | undefined;
  if (rpcError && typeof rpcError === 'object') {
    const code = rpcError.code;
    if (typeof code === 'number' && (code === -32602 || code === -32600)) return true;
    const msg = rpcError.message;
    if (typeof msg === 'string' && SCHEMA_KEYWORD_RE.test(msg)) return true;
  }
  // AdCP / REST-style validation envelope
  if (Array.isArray(obj.errors) && obj.errors.length > 0) return true;
  if (Array.isArray(obj.validation_errors) && obj.validation_errors.length > 0) return true;
  const topCode = obj.error_code ?? obj.code;
  if (typeof topCode === 'string' && SCHEMA_CODE_RE.test(topCode)) return true;
  return false;
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
    return {
      check: 'on_401_require_header',
      passed: true,
      description: validation.description,
      expected: 'not_applicable',
      actual: hr.status,
    };
  }
  const value = hr.headers[header];
  const passed = typeof value === 'string' && value.length > 0;
  return {
    check: 'on_401_require_header',
    passed,
    description: validation.description,
    json_pointer: `/headers/${header}`,
    expected: `non-empty ${header} header`,
    actual: value ?? null,
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
  const expectedUrl = normalizeAgentUrl(agentUrl);
  const actualUrl = normalizeAgentUrl(resource);
  const passed = actualUrl === expectedUrl;
  // Don't echo the advertised value verbatim — compliance reports may be
  // shared publicly and the raw diff helps attackers probe victim agents.
  // Surface just enough for the operator to self-diagnose: their own URL,
  // which part of the advertised URL differs, and a pointer to the fix.
  let redactedError: string | undefined;
  if (!passed) {
    let actualHost = 'unknown';
    try {
      actualHost = new URL(resource).host;
    } catch {
      /* ignore */
    }
    const expectedHost = new URL(expectedUrl).host;
    const hostDiffers = actualHost !== expectedHost;
    redactedError =
      `RFC 9728 \`resource\` does not equal the URL clients call (${expectedUrl}). ` +
      (hostDiffers
        ? `Advertised host differs from the agent host — the most common cause is copying your authorization server origin into \`resource\`. `
        : `Advertised path differs from the agent path. `) +
      `Fix: set \`resource\` equal to the full agent URL in your protected-resource metadata document.`;
  }
  return {
    check: 'resource_equals_agent_url',
    passed,
    description: validation.description,
    json_pointer: '/resource',
    expected: expectedUrl,
    // Pass through the host-diff signal only; don't echo the raw advertised
    // URL to avoid leaking victim-agent probe targets in shared reports.
    actual: passed ? expectedUrl : '<differs>',
    error: redactedError,
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
    expected: flags,
    actual: [...contributions],
    error: passed ? undefined : `None of the required contributions were recorded: ${JSON.stringify(flags)}`,
  };
}

// resolvePath re-exported from ./path for backwards compat
export { resolvePath } from './path';
