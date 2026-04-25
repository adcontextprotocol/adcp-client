/**
 * Per-step validation engine for storyboard testing.
 *
 * Emits validation results conforming to the runner-output contract:
 * failed validations carry RFC 6901 `json_pointer`, machine-readable
 * `expected`/`actual`, and for `response_schema` checks the `schema_id`
 * plus resolvable `schema_url`. See
 * `static/compliance/source/universal/runner-output-contract.yaml`.
 */

import { TOOL_RESPONSE_SCHEMAS } from '../../utils/response-schemas';
import { TRANSPORT_SUFFIX_REGEX } from '../../utils/a2a-discovery';
import { validateResponse, type ValidationIssue } from '../../validation/schema-validator';
import { ADCP_VERSION } from '../../version';
import type { TaskResult } from '../types';
import type {
  A2ATaskEnvelope,
  HttpProbeResult,
  RunnerRequestRecord,
  RunnerResponseRecord,
  SchemaValidationError,
  StoryboardContext,
  StoryboardValidation,
  StrictValidationVerdict,
  ValidationResult,
} from './types';
import { resolvePath, resolvePathAll, toJsonPointer } from './path';
import { detectShapeDriftHints } from './shape-drift-hints';
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
  /**
   * Storyboard-declared response schema reference, e.g.
   * `"protocol/get-adcp-capabilities-response.json"`. When present the
   * runner emits schema_id / schema_url conforming to the contract.
   */
  responseSchemaRef?: string;
  /** Exact request the runner sent — echoed on failed validations. */
  request?: RunnerRequestRecord;
  /** Exact response observed — echoed on failed validations. */
  response?: RunnerResponseRecord;
  /**
   * Accumulated storyboard context from prior steps. Exposed to cross-step
   * checks (`refs_resolve`) that need to reference values extracted earlier
   * in the run. Single-step checks ignore it.
   */
  storyboardContext?: StoryboardContext;
  /**
   * Captured A2A wire shape — populated by the runner when the protocol
   * is `a2a` and the SDK fetch was wrapped with `withRawResponseCapture`.
   * `a2a_submitted_artifact` and other wire-shape checks read this to
   * assert on the JSON-RPC envelope; non-A2A runs leave it undefined and
   * those checks self-skip with `not_applicable`.
   */
  a2aEnvelope?: A2ATaskEnvelope;
  /**
   * Most recent A2A envelope captured by a PRIOR step in the same run.
   * Cross-step checks (`a2a_context_continuity`) read this to compare
   * the current step's `Task.contextId` against the prior step's
   * `Task.contextId` — A2A 0.3.0 mandates the server echo the
   * client-supplied `contextId` on follow-up sends. Absent on the
   * first A2A step in a run, on non-A2A runs, and when no prior step
   * captured an envelope (e.g. all priors were probe steps).
   */
  priorA2aEnvelope?: A2ATaskEnvelope;
  /**
   * Step id of the prior step whose A2A envelope `priorA2aEnvelope`
   * came from. Used by cross-step diagnostics to point operators at
   * the exact prior step the continuity assertion is comparing
   * against.
   */
  priorA2aStepId?: string;
}

/**
 * Run all validations for a storyboard step.
 */
export function runValidations(validations: StoryboardValidation[], context: ValidationContext): ValidationResult[] {
  return validations.map(v => attachOnFailure(runValidation(v, context), context));
}

/**
 * Attach request / response records to a failed validation so implementors
 * see the exact bytes the runner sent and observed. Passed validations stay
 * minimal — carrying the full payload on every passing check bloats the
 * JSON surface without diagnostic value.
 */
function attachOnFailure(result: ValidationResult, context: ValidationContext): ValidationResult {
  if (result.passed) return result;
  const augmented: ValidationResult = { ...result };
  if (context.request && augmented.request === undefined) augmented.request = context.request;
  if (context.response && augmented.response === undefined) augmented.response = context.response;
  return augmented;
}

function runValidation(validation: StoryboardValidation, ctx: ValidationContext): ValidationResult {
  switch (validation.check) {
    case 'response_schema':
      return requireTaskResult(ctx, validation, tr => validateResponseSchema(validation, ctx, tr));
    case 'field_present':
      // field_present runs against either MCP task result data OR an HTTP probe body —
      // the storyboard's probe_protected_resource validates fields in the RFC 9728 JSON.
      return validateFieldPresent(validation, resolveTarget(ctx));
    case 'field_value':
      return validateFieldValue(validation, resolveTarget(ctx));
    case 'field_value_or_absent':
      return validateFieldValueOrAbsent(validation, resolveTarget(ctx));
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
    case 'a2a_submitted_artifact':
      return validateA2ASubmittedArtifact(validation, ctx);
    case 'a2a_context_continuity':
      return validateA2AContextContinuity(validation, ctx);
    case 'refs_resolve':
      return validateRefsResolve(validation, ctx);
    default:
      return {
        check: validation.check,
        passed: false,
        description: validation.description,
        error: `Unknown validation check: ${validation.check}`,
        json_pointer: null,
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
      json_pointer: null,
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
      json_pointer: null,
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
// Schema URL resolution
// ────────────────────────────────────────────────────────────

const SCHEMA_URL_BASE = 'https://adcontextprotocol.org';

/**
 * Build a `{ schema_id, schema_url }` pair from a storyboard-declared
 * `response_schema_ref`. The id follows the `/schemas/<version>/<path>.json`
 * convention used by `$id` in cached JSON schemas; the url dereferences
 * against the public docs origin so implementors can fetch it.
 */
function resolveSchemaIdentity(schemaRef: string | undefined): { schema_id: string | null; schema_url: string | null } {
  if (!schemaRef) return { schema_id: null, schema_url: null };
  const trimmed = schemaRef.replace(/^\/+/, '');
  const schemaId = `/schemas/${ADCP_VERSION}/${trimmed}`;
  const schemaUrl = `${SCHEMA_URL_BASE}${schemaId}`;
  return { schema_id: schemaId, schema_url: schemaUrl };
}

/**
 * Convert a Zod error into the AJV-shaped `SchemaValidationError[]` the
 * contract calls for. Each issue names the failing instance path, the
 * schema keyword that rejected it (best-effort from Zod's `code`), and
 * the original message.
 */
/**
 * Escape a single Zod path segment as an RFC 6901 reference token: `~` → `~0`
 * (done first), then `/` → `~1`. Numeric segments pass through as-is.
 */
function escapeJsonPointerSegment(seg: PropertyKey): string {
  return String(seg).replace(/~/g, '~0').replace(/\//g, '~1');
}

function zodIssuePathToJsonPointer(path: ReadonlyArray<PropertyKey>): string {
  return '/' + path.map(escapeJsonPointerSegment).join('/');
}

function zodIssuesToSchemaErrors(
  issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; code: string; message: string }>
): SchemaValidationError[] {
  return issues.map(issue => {
    const keyword = mapZodCodeToSchemaKeyword(issue.code);
    const instancePointer = issue.path.map(escapeJsonPointerSegment).join('/');
    return {
      instance_path: '/' + instancePointer,
      // Zod does not expose the schema-side pointer. Approximate AJV's
      // `schema_path` (a JSON pointer into the schema) as
      // `#/properties/<path>/<keyword>` so implementors can locate the
      // rejecting keyword inside their schema.
      schema_path: `#/properties/${instancePointer}/${keyword}`,
      keyword,
      message: issue.message,
    };
  });
}

function mapZodCodeToSchemaKeyword(code: string): string {
  switch (code) {
    case 'invalid_type':
      return 'type';
    case 'invalid_literal':
    case 'invalid_enum_value':
      return 'enum';
    case 'too_small':
      return 'minimum';
    case 'too_big':
      return 'maximum';
    case 'invalid_string':
      return 'format';
    case 'unrecognized_keys':
      return 'additionalProperties';
    case 'invalid_union':
      return 'oneOf';
    default:
      return code;
  }
}

// ────────────────────────────────────────────────────────────
// response_schema: validate against Zod
// ────────────────────────────────────────────────────────────

function validateResponseSchema(
  validation: StoryboardValidation,
  ctx: ValidationContext,
  taskResult: TaskResult
): ValidationResult {
  const taskName = ctx.taskName;
  const { schema_id, schema_url } = resolveSchemaIdentity(ctx.responseSchemaRef);
  const schema = TOOL_RESPONSE_SCHEMAS[taskName];
  if (!schema) {
    return {
      check: 'response_schema',
      passed: false,
      description: validation.description,
      error: `No schema registered for task "${taskName}"`,
      json_pointer: null,
      expected: schema_id ?? `response schema for ${taskName}`,
      // The runner failed before observing the agent — distinguish that from
      // "agent returned null" so implementors don't chase a phantom agent bug.
      actual: { reason: 'no_schema_registered', task: taskName },
      schema_id,
      schema_url,
    };
  }

  // Keep the raw payload separately from the object-form one below so the
  // shape-drift detector can recognize bare-array responses (a common drift
  // pattern for list tools). Strip _message when it's a top-level property —
  // bare arrays don't carry that field.
  const rawData = taskResult.data ?? {};
  const dataWithoutMessage = Array.isArray(rawData)
    ? rawData
    : (() => {
        const { _message, ...rest } = rawData as Record<string, unknown>;
        return rest;
      })();
  const parseResult = schema.safeParse(dataWithoutMessage);

  // Strict (AJV) verdict runs alongside the lenient Zod check so the run
  // report surfaces strictness deltas (issue #820 follow-up). The AJV path
  // enforces `format` keywords and `additionalProperties: false` that Zod's
  // `passthrough()` omits — a response can pass Zod and fail AJV. The step's
  // overall pass/fail stays Zod-driven to preserve backwards compatibility.
  const strict = computeStrictVerdict(taskName, dataWithoutMessage);

  // Shape-drift no longer rides on `ValidationResult.warning` — issue #935
  // moved that diagnostic to `StoryboardStepResult.hints[]` as a structured
  // `ShapeDriftHint`. The runner emits the structured hint via
  // `detectShapeDriftHints` directly; this layer focuses on the strict /
  // variant-fallback signal that doesn't yet have a hint kind.

  if (parseResult.success) {
    const base: ValidationResult = {
      check: 'response_schema',
      passed: true,
      description: validation.description,
      schema_id,
      schema_url,
    };
    // Surface strict-only / variant-fallback signal via `warning` so step-
    // level output (and LLM-driven self-correction that scans `error`/
    // `warning` fields) sees something without flipping `passed`.
    const warning = strict ? buildStrictWarning(strict) : undefined;
    if (!strict && !warning) return base;
    if (!strict) return { ...base, warning };
    return warning ? { ...base, strict, warning } : { ...base, strict };
  }

  const schemaErrors = zodIssuesToSchemaErrors(parseResult.error.issues);
  const firstIssue = parseResult.error.issues[0];
  const jsonPointer = firstIssue ? zodIssuePathToJsonPointer(firstIssue.path) : null;
  const issues = parseResult.error.issues
    .slice(0, 5)
    .map(i => `${i.path.join('.')}: ${i.message}`)
    .join('; ');

  const failed: ValidationResult = {
    check: 'response_schema',
    passed: false,
    description: validation.description,
    error: issues,
    json_pointer: jsonPointer,
    expected: schema_id ?? `response schema for ${taskName}`,
    actual: schemaErrors,
    schema_id,
    schema_url,
  };
  return strict ? { ...failed, strict } : failed;
}

/**
 * Run the strict AJV validator for `taskName` against the response payload.
 * Returns undefined when no AJV schema is available (the client can't
 * observe a strictness delta for tools whose JSON-schema doesn't ship with
 * the SDK — notably the brand-rights and governance schemas that live
 * outside the `bundled/` tree the loader walks today).
 */
function computeStrictVerdict(taskName: string, payload: unknown): StrictValidationVerdict | undefined {
  const outcome = validateResponse(taskName, payload);
  // `variant: 'skipped'` means no AJV validator compiled for this task (no
  // strictness signal to emit); treat the same as "no AJV schema available".
  if (outcome.variant === 'skipped') return undefined;
  const fallbackFields: Pick<StrictValidationVerdict, 'variant_fallback_applied' | 'requested_variant'> =
    outcome.variant_fallback_applied
      ? { variant_fallback_applied: true, requested_variant: outcome.requested_variant }
      : {};
  if (outcome.valid) {
    return { valid: true, variant: outcome.variant, ...fallbackFields };
  }
  return {
    valid: false,
    variant: outcome.variant,
    issues: outcome.issues.slice(0, 10).map(ajvIssueToSchemaError),
    ...fallbackFields,
  };
}

function ajvIssueToSchemaError(issue: ValidationIssue): SchemaValidationError {
  return {
    instance_path: issue.pointer,
    schema_path: issue.schemaPath,
    keyword: issue.keyword,
    message: issue.message,
  };
}

/**
 * Render the strict verdict into a non-fatal warning for step-level
 * output. Two cases produce signal (both preserve `passed`):
 *   - Strict-only failure: Zod accepted, AJV rejected. Top AJV issue.
 *   - Variant fallback: agent advertised an async variant without a
 *     compiled schema; validation fell back to sync. Conformance gap
 *     worth flagging even when AJV ultimately accepted.
 * When both apply, both are joined. Returns undefined when neither
 * applies (strict accepted and no fallback).
 */
function buildStrictWarning(strict: StrictValidationVerdict): string | undefined {
  const parts: string[] = [];
  if (strict.variant_fallback_applied && strict.requested_variant) {
    parts.push(
      `agent advertised status="${strict.requested_variant}" but the tool has no schema for that variant — validated against sync fallback`
    );
  }
  if (!strict.valid && strict.issues && strict.issues.length > 0) {
    // Group `required` keyword issues under their parent path so sellers see
    // "missing properties at /x: a, b, c" in one pass instead of one missing
    // field per storyboard run. This is the single biggest onramp cliff for
    // sellers filling out response schemas with N required fields —
    // previously they iterated N times, learning one required field per run.
    const requiredIssues = strict.issues.filter(i => i.keyword === 'required');
    const otherIssues = strict.issues.filter(i => i.keyword !== 'required');
    if (requiredIssues.length > 0) {
      const grouped = new Map<string, string[]>();
      for (const issue of requiredIssues) {
        const at = issue.instance_path || '/';
        // AJV's `required`-issue message format: `must have required property '<name>'`.
        const match = issue.message.match(/required property ['"]([^'"]+)['"]/);
        const field = match?.[1] ?? issue.message;
        const list = grouped.get(at) ?? [];
        list.push(field);
        grouped.set(at, list);
      }
      for (const [at, fields] of grouped) {
        parts.push(`strict JSON-schema missing required at ${at}: ${fields.join(', ')}`);
      }
    }
    const MAX_OTHER = 5;
    const shown = otherIssues.slice(0, MAX_OTHER);
    const remaining = otherIssues.length - shown.length;
    for (const issue of shown) {
      const pointer = issue.instance_path || '/';
      parts.push(`strict JSON-schema rejected ${pointer}: ${issue.message}`);
    }
    if (remaining > 0) {
      parts.push(`(+${remaining} more AJV issue${remaining === 1 ? '' : 's'})`);
    }
  }
  return parts.length > 0 ? parts.join('; ') : undefined;
}

/**
 * Recognize common payload-shape mistakes and return the human-readable
 * fix-recipe — `string` form retained for direct unit-test callers and
 * for any external consumer that imported the shim before issue #935
 * moved the canonical detector to `shape-drift-hints.ts`. Both forms
 * reuse the same detection logic; this shim returns `hints[0]?.message`.
 *
 * Covers four shape-inversion patterns observed in real integrations:
 *   - `build_creative` returning platform-native fields at the top level
 *     (scope3 agentic-adapters#100 — `tag_url`, `creative_id`, `media_type`)
 *   - `sync_creatives` returning a single creative's inner shape bubbled
 *     up without the `creatives` array wrapper, OR the wrong wrapper key
 *     (`{ results: [...] }` instead of `{ creatives: [...] }`)
 *   - `preview_creative` returning raw render fields (`preview_url`,
 *     `preview_html`) at the top level without the `previews[].renders[]`
 *     nesting and `response_type` discriminator
 *   - List tools (`list_creatives`, `list_creative_formats`, `list_accounts`,
 *     `get_products`, `get_media_buys`, `get_signals`, `list_property_lists`,
 *     `list_collection_lists`, `list_content_standards`) returning a bare
 *     array at the top level instead of the `{ <key>: [...] }` envelope
 *
 * Run-path callers should consume the structured hint via the runner's
 * `step.hints[]` surface (issue #935) — the structured fields drive
 * per-case fix plans without re-parsing the message.
 *
 * @param taskName — tool name (snake_case) the storyboard dispatched under
 * @param payload — raw response payload. `unknown` rather than
 *   `Record<string, unknown>` so bare-array payloads are recognizable at
 *   the top level.
 */
export function detectShapeDriftHint(taskName: string, payload: unknown): string | undefined {
  return detectShapeDriftHints(taskName, payload)[0]?.message;
}

export { LIST_WRAPPER_TOOLS } from './shape-drift-hints';

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
      json_pointer: null,
      expected: 'path must be set in storyboard validation entry',
      actual: null,
    };
  }

  const value = resolvePath(taskResult.data, validation.path);
  const present = value !== undefined && value !== null;
  const pointer = toJsonPointer(validation.path);

  if (present) {
    return {
      check: 'field_present',
      passed: true,
      description: validation.description,
      path: validation.path,
      json_pointer: pointer,
    };
  }

  return {
    check: 'field_present',
    passed: false,
    description: validation.description,
    path: validation.path,
    error: `Field not found at path: ${validation.path}`,
    json_pointer: pointer,
    expected: validation.path,
    actual: value ?? null,
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
      json_pointer: null,
      expected: 'path must be set in storyboard validation entry',
      actual: null,
    };
  }

  const actual = resolvePath(taskResult.data, validation.path);
  const pointer = toJsonPointer(validation.path);

  // allowed_values: pass if actual matches any value in the list
  if (validation.allowed_values?.length) {
    const passed = validation.allowed_values.some(v => valuesMatch(actual, v));
    if (passed) {
      return {
        check: 'field_value',
        passed: true,
        description: validation.description,
        path: validation.path,
        json_pointer: pointer,
      };
    }
    return {
      check: 'field_value',
      passed: false,
      description: validation.description,
      path: validation.path,
      error: `Expected one of ${JSON.stringify(validation.allowed_values)}, got ${JSON.stringify(actual)}`,
      json_pointer: pointer,
      expected: validation.allowed_values,
      actual: actual ?? null,
    };
  }

  // Exact match against value
  const passed = valuesMatch(actual, validation.value);

  if (passed) {
    return {
      check: 'field_value',
      passed: true,
      description: validation.description,
      path: validation.path,
      json_pointer: pointer,
    };
  }
  return {
    check: 'field_value',
    passed: false,
    description: validation.description,
    path: validation.path,
    error: `Expected ${JSON.stringify(validation.value)}, got ${JSON.stringify(actual)}`,
    json_pointer: pointer,
    expected: validation.value,
    actual: actual ?? null,
  };
}

// ────────────────────────────────────────────────────────────
// field_value_or_absent: envelope-tolerant variant of field_value
//
// Pass when the field is absent OR present-and-matching. Fail only when the
// field is present with a disallowed value. Lets a storyboard keep positive
// coverage on a spec-optional field without penalizing agents that omit it.
// Spec: adcontextprotocol/adcp #3013 envelope `replayed` semantics.
// ────────────────────────────────────────────────────────────

function validateFieldValueOrAbsent(validation: StoryboardValidation, taskResult: TaskResult): ValidationResult {
  if (!validation.path) {
    return {
      check: 'field_value_or_absent',
      passed: false,
      description: validation.description,
      path: validation.path,
      error: 'No path specified for field_value_or_absent validation',
      json_pointer: null,
      expected: 'path must be set in storyboard validation entry',
      actual: null,
    };
  }

  const actual = resolvePath(taskResult.data, validation.path);
  const pointer = toJsonPointer(validation.path);

  // Absent → pass. The check only fires when the field is present.
  if (actual === undefined) {
    return {
      check: 'field_value_or_absent',
      passed: true,
      description: validation.description,
      path: validation.path,
      json_pointer: pointer,
    };
  }

  // Present → fall through to the same value / allowed_values semantics as field_value.
  if (validation.allowed_values?.length) {
    const passed = validation.allowed_values.some(v => valuesMatch(actual, v));
    if (passed) {
      return {
        check: 'field_value_or_absent',
        passed: true,
        description: validation.description,
        path: validation.path,
        json_pointer: pointer,
      };
    }
    return {
      check: 'field_value_or_absent',
      passed: false,
      description: validation.description,
      path: validation.path,
      error: `Expected absent or one of ${JSON.stringify(validation.allowed_values)}, got ${JSON.stringify(actual)}`,
      json_pointer: pointer,
      expected: validation.allowed_values,
      actual,
    };
  }

  const passed = valuesMatch(actual, validation.value);
  if (passed) {
    return {
      check: 'field_value_or_absent',
      passed: true,
      description: validation.description,
      path: validation.path,
      json_pointer: pointer,
    };
  }
  return {
    check: 'field_value_or_absent',
    passed: false,
    description: validation.description,
    path: validation.path,
    error: `Expected absent or ${JSON.stringify(validation.value)}, got ${JSON.stringify(actual)}`,
    json_pointer: pointer,
    expected: validation.value,
    actual,
  };
}

// ────────────────────────────────────────────────────────────
// status_code: check TaskResult status
// ────────────────────────────────────────────────────────────

function validateStatusCode(validation: StoryboardValidation, taskResult: TaskResult): ValidationResult {
  const passed = taskResult.success;

  if (passed) {
    return {
      check: 'status_code',
      passed: true,
      description: validation.description,
    };
  }
  return {
    check: 'status_code',
    passed: false,
    description: validation.description,
    error: `Task failed: ${taskResult.error || 'unknown error'}`,
    json_pointer: null,
    expected: 'success',
    actual: taskResult.error ?? 'failure',
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
  // Prefer the spec-canonical `errors[0].code` envelope (core/error.json), then
  // fall back to legacy/structured locations so we get a bare code instead of
  // the "CODE: message" string materialized on taskResult.error.
  //
  // Guarded by `success === false` because AdCP async envelopes (`submitted`,
  // `input-required`) explicitly permit an advisory `errors[]` on non-failed
  // tasks for non-blocking warnings — reading it unconditionally would
  // false-positive `error_code` validations on successful responses.
  const data = taskResult.data as Record<string, unknown> | undefined;
  const errors = data?.errors;
  const firstError = !taskResult.success && Array.isArray(errors) ? errors[0] : undefined;
  const firstErrorCode =
    firstError && typeof firstError === 'object' && typeof (firstError as Record<string, unknown>).code === 'string'
      ? ((firstError as Record<string, unknown>).code as string)
      : undefined;
  const adcpError = data?.adcp_error as Record<string, unknown> | undefined;
  const errorCode =
    firstErrorCode ??
    adcpError?.code ??
    data?.error_code ??
    data?.code ??
    (data?.error as Record<string, unknown> | undefined)?.code ??
    extractCodeFromErrorString(taskResult.error);

  const pointer =
    firstErrorCode !== undefined
      ? '/errors/0/code'
      : adcpError?.code !== undefined
        ? '/adcp_error/code'
        : data?.error_code !== undefined
          ? '/error_code'
          : null;

  if (validation.allowed_values?.length) {
    const actualCode = errorCode !== undefined && errorCode !== null ? String(errorCode) : undefined;
    const passed = actualCode !== undefined && validation.allowed_values.some(v => String(v) === actualCode);
    if (passed) {
      return { check: 'error_code', passed: true, description: validation.description, json_pointer: pointer };
    }
    return {
      check: 'error_code',
      passed: false,
      description: validation.description,
      error: `Expected one of ${JSON.stringify(validation.allowed_values)}, got ${JSON.stringify(errorCode)}`,
      json_pointer: pointer,
      expected: validation.allowed_values,
      actual: errorCode ?? null,
    };
  }

  if (!validation.value) {
    // Just check that an error code exists
    const hasCode = errorCode !== undefined && errorCode !== null;
    if (hasCode) {
      return { check: 'error_code', passed: true, description: validation.description, json_pointer: pointer };
    }
    return {
      check: 'error_code',
      passed: false,
      description: validation.description,
      error: 'No error code found in response',
      json_pointer: pointer,
      expected: 'any error code',
      actual: null,
    };
  }

  const passed = String(errorCode) === String(validation.value);
  if (passed) {
    return { check: 'error_code', passed: true, description: validation.description, json_pointer: pointer };
  }
  return {
    check: 'error_code',
    passed: false,
    description: validation.description,
    error: `Expected error code "${validation.value}", got "${errorCode}"`,
    json_pointer: pointer,
    expected: validation.value,
    actual: errorCode ?? null,
  };
}

// ────────────────────────────────────────────────────────────
// http_status / http_status_in
// ────────────────────────────────────────────────────────────

function validateHttpStatus(validation: StoryboardValidation, hr: HttpProbeResult): ValidationResult {
  const expected = validation.value as number | undefined;
  const passed = typeof expected === 'number' && hr.status === expected;
  if (passed) {
    return { check: 'http_status', passed: true, description: validation.description };
  }
  return {
    check: 'http_status',
    passed: false,
    description: validation.description,
    error: `Expected HTTP ${expected}, got ${hr.status}${hr.error ? ` (${hr.error})` : ''}`,
    json_pointer: null,
    expected: expected ?? null,
    actual: hr.status,
  };
}

function validateHttpStatusIn(validation: StoryboardValidation, hr: HttpProbeResult): ValidationResult {
  const allowed = Array.isArray(validation.allowed_values) ? validation.allowed_values : [];
  const passed = allowed.some(v => v === hr.status);
  if (passed) {
    return { check: 'http_status_in', passed: true, description: validation.description };
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
      error:
        `Agent returned HTTP ${hr.status} with a schema-validation body before any auth response. ` +
        `Two possible causes: (1) \`test_kit.auth.probe_task\` points at a task that requires ` +
        `non-empty parameters, so schema validation rejected the probe before auth ran (fix: set ` +
        `\`probe_task\` to one of ${PROBE_TASK_ALLOWLIST.join(', ')}); or (2) the agent evaluates ` +
        `schema before auth, which is itself a conformance gap (protected endpoints must return ` +
        `401/403 on invalid credentials regardless of body shape).`,
      json_pointer: null,
      expected: allowed,
      actual: hr.status,
    };
  }
  return {
    check: 'http_status_in',
    passed: false,
    description: validation.description,
    error: `Expected HTTP status in ${JSON.stringify(allowed)}, got ${hr.status}${hr.error ? ` (${hr.error})` : ''}`,
    json_pointer: null,
    expected: allowed,
    actual: hr.status,
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
      json_pointer: null,
      expected: 'header name',
      actual: null,
    };
  }
  // Silent pass when the response isn't a 401 — the conditional is part of
  // the spec (RFC 6750 §3 only applies to 401s).
  if (hr.status !== 401) {
    return { check: 'on_401_require_header', passed: true, description: validation.description };
  }
  const value = hr.headers[header];
  const passed = typeof value === 'string' && value.length > 0;
  if (passed) {
    return { check: 'on_401_require_header', passed: true, description: validation.description };
  }
  return {
    check: 'on_401_require_header',
    passed: false,
    description: validation.description,
    error: `401 response missing required header "${header}".`,
    json_pointer: null,
    expected: `response header "${header}" present`,
    actual: value ?? null,
  };
}

// ────────────────────────────────────────────────────────────
// resource_equals_agent_url
// ────────────────────────────────────────────────────────────

/**
 * Normalize a URL for RFC 9728 resource identity checks:
 * lowercases scheme/host, strips userinfo, query, and fragment, and
 * collapses trailing slashes while preserving the path. RFC 9728
 * `resource` identifies the agent at its full endpoint, so paths are
 * significant here — use `canonicalizeAgentUrlForScope` for `refs_resolve`
 * scope comparisons where paths must be dropped.
 */
function normalizeAgentUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = '';
    u.search = '';
    u.username = '';
    u.password = '';
    // Drop trailing slash but keep the root "/".
    if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
      u.pathname = u.pathname.slice(0, -1);
    }
    return `${u.protocol.toLowerCase()}//${u.host.toLowerCase()}${u.pathname}`;
  } catch {
    return url;
  }
}

/**
 * Canonical form of an agent URL for `refs_resolve` scope comparisons.
 *
 * AdCP's `agent_url` identifies the agent — which may live under a subpath
 * like `https://publisher.com/.well-known/adcp/sales` (see core/format-id.json).
 * Path is therefore significant and MUST be preserved; collapsing to origin
 * would false-positive sibling agents on shared hosts.
 *
 * What must be stripped is the transport suffix the runner appends to reach
 * the protocol endpoint (`/mcp`, `/a2a`, `/sse`) and the well-known agent-card
 * path, so the runner's target URL canonicalizes to the same value the agent
 * advertises in its refs. Mirrors `SingleAgentClient.computeBaseUrl` but as a
 * pure string operation suitable for validation without an agent instance.
 *
 * Also: lowercase scheme/host, drop default ports, strip userinfo, query,
 * fragment — normal RFC 3986 §6.2 canonicalization. Closes adcp-client#710.
 */
const AGENT_CARD_SUFFIX_RE = /\/\.well-known\/agent(?:-card)?\.json$/i;
function canonicalizeAgentUrlForScope(url: string): string {
  try {
    const u = new URL(url);
    u.hash = '';
    u.search = '';
    u.username = '';
    u.password = '';
    let path = u.pathname;
    path = path.replace(AGENT_CARD_SUFFIX_RE, '');
    path = path.replace(TRANSPORT_SUFFIX_REGEX, '');
    // A bare `/` and the empty string denote the same origin-relative root;
    // collapse them so `https://host` and `https://host/` canonicalize equally.
    if (path === '/' || path === '') path = '';
    else if (path.endsWith('/')) path = path.slice(0, -1);
    const defaultPort = u.protocol === 'https:' ? '443' : u.protocol === 'http:' ? '80' : '';
    const host = u.hostname.toLowerCase();
    const port = u.port && u.port !== defaultPort ? `:${u.port}` : '';
    return `${u.protocol.toLowerCase()}//${host}${port}${path}`;
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
      json_pointer: '/resource',
      expected: normalizeAgentUrl(agentUrl),
      actual: null,
    };
  }
  const expected = normalizeAgentUrl(agentUrl);
  const actual = normalizeAgentUrl(resource);
  const passed = actual === expected;
  // Don't echo the advertised value verbatim in the human-readable message —
  // compliance reports may be shared publicly and the raw diff helps attackers
  // probe victim agents. Machine-readable expected/actual are fine: implementors
  // consuming the JSON already hold both URLs.
  let redactedError: string | undefined;
  if (!passed) {
    let actualHost = 'unknown';
    try {
      actualHost = new URL(resource).host;
    } catch {
      /* ignore */
    }
    const expectedHost = new URL(expected).host;
    const hostDiffers = actualHost !== expectedHost;
    redactedError =
      `RFC 9728 \`resource\` does not equal the URL clients call (${expected}). ` +
      (hostDiffers
        ? `Advertised host differs from the agent host — the most common cause is copying your authorization server origin into \`resource\`. `
        : `Advertised path differs from the agent path. `) +
      `Fix: set \`resource\` equal to the full agent URL in your protected-resource metadata document.`;
  }
  if (passed) {
    return {
      check: 'resource_equals_agent_url',
      passed: true,
      description: validation.description,
      json_pointer: '/resource',
    };
  }
  return {
    check: 'resource_equals_agent_url',
    passed: false,
    description: validation.description,
    error: redactedError,
    json_pointer: '/resource',
    expected,
    actual,
  };
}

// ────────────────────────────────────────────────────────────
// any_of (contribution accumulator)
// ────────────────────────────────────────────────────────────

function validateAnyOf(validation: StoryboardValidation, contributions: Set<string>): ValidationResult {
  const flags = Array.isArray(validation.allowed_values) ? validation.allowed_values.map(String) : [];
  const passed = flags.some(f => contributions.has(f));
  if (passed) {
    return { check: 'any_of', passed: true, description: validation.description };
  }
  return {
    check: 'any_of',
    passed: false,
    description: validation.description,
    error: `None of the required contributions were recorded: ${JSON.stringify(flags)}`,
    json_pointer: null,
    expected: flags,
    actual: Array.from(contributions),
  };
}

// ────────────────────────────────────────────────────────────
// a2a_submitted_artifact (A2A wire-shape regression guard)
// ────────────────────────────────────────────────────────────

/**
 * Assert the A2A `Task` envelope produced by the seller for an AdCP
 * `submitted` arm matches the cross-transport contract established in
 * adcp-client#899:
 *
 *   1. `Task.state === 'completed'` — A2A Task.state tracks the HTTP
 *      transport call, not the AdCP work. The HTTP request returned
 *      successfully with a queued AdCP task; emitting `'submitted'`
 *      here would be a non-conformant terminal transition per A2A
 *      0.3.0 (`submitted` is the INITIAL state, never terminal).
 *
 *   2. `artifact.metadata.adcp_task_id` is a non-empty string — the
 *      AdCP-level async handle rides on the artifact's metadata field,
 *      not buried in `data.adcp_task_id`. Buyers resume the AdCP task
 *      by reading metadata; conflating it into the AdCP payload
 *      pollutes the typed response shape.
 *
 *   3. `artifact.parts[0].data.status === 'submitted'` — the AdCP
 *      payload preserves its native `status` discriminator so buyers
 *      can read the ad-tech state without parsing transport metadata.
 *
 * The check is A2A-specific: when no `a2aEnvelope` was captured (MCP
 * runs, or A2A runs where the SDK fetch was bypassed), the result
 * passes with `not_applicable: true` so the validation doesn't fail
 * the step on transports that don't carry the envelope.
 *
 * Failure messages name the offending field so an agent that
 * regressed to the pre-#899 shape (`Task.state: 'submitted'` with
 * `final: true`, `adcp_task_id` in `data` instead of `metadata`) gets
 * a specific diagnostic, not a generic "wire-shape rejected".
 */
function validateA2ASubmittedArtifact(validation: StoryboardValidation, ctx: ValidationContext): ValidationResult {
  const envelope = ctx.a2aEnvelope;
  if (!envelope) {
    // Non-A2A transport (MCP), or A2A path where the SDK fetch wasn't
    // wrapped. Skip without failing — the storyboard step still grades
    // on its other validations (e.g. MCP `field_value status === submitted`).
    return {
      check: 'a2a_submitted_artifact',
      passed: true,
      description: validation.description,
      observations: [
        'a2a_envelope_not_captured: no JSON-RPC envelope recorded (non-A2A transport, or A2A dispatch threw before envelope was parsed)',
      ],
    };
  }

  const failures: Array<{ pointer: string; expected: unknown; actual: unknown; detail: string }> = [];

  // JSON-RPC error envelopes never satisfy the submitted-artifact
  // contract. We fail the check (skipping would silently hide a
  // server-side regression where submitted arms 500 instead of
  // returning Tasks), but emit a distinct error_code so dashboards
  // can separate transport rejections from submitted-arm shape drift.
  if (envelope.envelope.error !== undefined) {
    return {
      check: 'a2a_submitted_artifact',
      passed: false,
      description: validation.description,
      error: 'Expected a JSON-RPC success envelope carrying an A2A Task; observed an error envelope.',
      json_pointer: '/error',
      expected: { result: { kind: 'task', status: { state: 'completed' } } },
      actual: { error_code: 'a2a_jsonrpc_error_envelope', error: envelope.envelope.error },
    };
  }

  const result = envelope.result;
  if (result == null || typeof result !== 'object' || Array.isArray(result)) {
    return {
      check: 'a2a_submitted_artifact',
      passed: false,
      description: validation.description,
      error: 'JSON-RPC `result` is not an object — A2A `message/send` must return a Task.',
      json_pointer: '/result',
      expected: 'object (A2A Task)',
      actual: result,
    };
  }
  const task = result as Record<string, unknown>;

  if (task.kind !== 'task') {
    failures.push({
      pointer: '/result/kind',
      expected: 'task',
      actual: task.kind,
      detail: `Expected result.kind === 'task'; got ${JSON.stringify(task.kind)}.`,
    });
  }

  // Task.id non-empty — buyers can't address `tasks/get` or
  // `tasks/cancel` without it, so an empty / missing id is a
  // wire-shape regression even if the transport call succeeded.
  if (typeof task.id !== 'string' || task.id.length === 0) {
    failures.push({
      pointer: '/result/id',
      expected: 'non-empty string',
      actual: task.id,
      detail:
        'A2A `Task.id` must be a non-empty string — buyers address follow-up `tasks/get` / `tasks/cancel` calls by this id.',
    });
  }

  // Task.contextId non-empty — A2A 0.3.0 binds follow-ups (subsequent
  // sends, status streams) to the context; an empty contextId
  // breaks correlation across calls.
  if (typeof task.contextId !== 'string' || task.contextId.length === 0) {
    failures.push({
      pointer: '/result/contextId',
      expected: 'non-empty string',
      actual: task.contextId,
      detail:
        'A2A `Task.contextId` must be a non-empty string — A2A 0.3.0 requires it on every Task to correlate follow-up sends and status streams.',
    });
  }

  // Invariant 1 — A2A `Task.state` for a submitted AdCP arm is
  // `'completed'` (the HTTP call completed). Pre-#899 emitted
  // `'submitted'` with `final: true`, which is the regression we want
  // to catch.
  const status = task.status;
  const state =
    status != null && typeof status === 'object' && !Array.isArray(status)
      ? (status as Record<string, unknown>).state
      : undefined;
  if (state !== 'completed') {
    failures.push({
      pointer: '/result/status/state',
      expected: 'completed',
      actual: state,
      detail:
        `Expected Task.state === 'completed' (HTTP-call lifecycle); got ${JSON.stringify(state)}. ` +
        "A2A 0.3.0 forbids 'submitted' as a terminal state — for AdCP submitted arms the transport call has completed; the AdCP task lives on artifact metadata.",
    });
  }

  // Invariants 2 + 3 — artifact.metadata.adcp_task_id placement and
  // artifact.parts[0].data.status preservation. Walk the artifact
  // chain, collecting failures rather than short-circuiting so the
  // error block names every divergence at once.
  const artifacts = task.artifacts;
  if (!Array.isArray(artifacts) || artifacts.length === 0) {
    failures.push({
      pointer: '/result/artifacts',
      expected: 'non-empty array',
      actual: artifacts,
      detail: 'A2A submitted arm must produce at least one artifact carrying the AdCP response.',
    });
  } else {
    const artifact = artifacts[0] as Record<string, unknown> | null;
    if (artifact == null || typeof artifact !== 'object' || Array.isArray(artifact)) {
      failures.push({
        pointer: '/result/artifacts/0',
        expected: 'object',
        actual: artifact,
        detail: 'First artifact must be an object.',
      });
    } else {
      // artifact.artifactId non-empty — needed for chunked-artifact
      // resumption and for buyers that key local state by artifact
      // id (e.g. caching the AdCP payload while the task continues).
      if (typeof artifact.artifactId !== 'string' || artifact.artifactId.length === 0) {
        failures.push({
          pointer: '/result/artifacts/0/artifactId',
          expected: 'non-empty string',
          actual: artifact.artifactId,
          detail:
            'A2A `Artifact.artifactId` must be a non-empty string — chunked-artifact resumption and buyer-side caching key off this id.',
        });
      }

      // Invariant 2 — adcp_task_id on artifact.metadata.
      const metadata = artifact.metadata;
      const metadataTaskId =
        metadata != null && typeof metadata === 'object' && !Array.isArray(metadata)
          ? (metadata as Record<string, unknown>).adcp_task_id
          : undefined;
      if (typeof metadataTaskId !== 'string' || metadataTaskId.length === 0) {
        failures.push({
          pointer: '/result/artifacts/0/metadata/adcp_task_id',
          expected: 'non-empty string',
          actual: metadataTaskId,
          detail:
            'Expected `adcp_task_id` on `artifact.metadata` (per A2A 0.3.0 metadata-extension convention). Pre-#899 placed this in `artifact.parts[0].data.adcp_task_id` — that path is non-conformant; transport metadata pollutes the typed AdCP payload shape.',
        });
      }

      // Invariant 3 — artifact.parts[0].data.status === 'submitted'.
      const parts = artifact.parts;
      if (!Array.isArray(parts) || parts.length === 0) {
        failures.push({
          pointer: '/result/artifacts/0/parts',
          expected: 'non-empty array with a DataPart',
          actual: parts,
          detail: 'A2A submitted arm must include a DataPart carrying the AdCP response.',
        });
      } else {
        const firstPart = parts[0] as Record<string, unknown> | null;
        if (firstPart == null || typeof firstPart !== 'object' || Array.isArray(firstPart)) {
          failures.push({
            pointer: '/result/artifacts/0/parts/0',
            expected: 'object',
            actual: firstPart,
            detail: 'First artifact part must be an object.',
          });
        } else {
          if (firstPart.kind !== 'data') {
            failures.push({
              pointer: '/result/artifacts/0/parts/0/kind',
              expected: 'data',
              actual: firstPart.kind,
              detail: `Expected the first artifact part to be a DataPart (kind === 'data'); got ${JSON.stringify(firstPart.kind)}.`,
            });
          }
          const data = firstPart.data;
          const dataStatus =
            data != null && typeof data === 'object' && !Array.isArray(data)
              ? (data as Record<string, unknown>).status
              : undefined;
          if (dataStatus !== 'submitted') {
            failures.push({
              pointer: '/result/artifacts/0/parts/0/data/status',
              expected: 'submitted',
              actual: dataStatus,
              detail:
                `Expected the AdCP payload's status to round-trip as 'submitted'; got ${JSON.stringify(dataStatus)}. ` +
                'The DataPart must carry the AdCP tool response verbatim — buyers read the ad-tech state from `data.status`, not from `Task.state`.',
            });
          }
          // Dual-write detection: catches the pre-#899 regression
          // where the agent leaked the transport handle into the
          // payload. A future AdCP tool whose response schema
          // legitimately includes `adcp_task_id` is allowed to
          // surface it inside `data` AS LONG AS it equals the
          // metadata value — a divergent or solo-payload write is
          // still the regression class issue #904 catches.
          const dataAdcpTaskId =
            data != null && typeof data === 'object' && !Array.isArray(data)
              ? (data as Record<string, unknown>).adcp_task_id
              : undefined;
          if (dataAdcpTaskId !== undefined) {
            const equalsMetadata =
              typeof metadataTaskId === 'string' &&
              typeof dataAdcpTaskId === 'string' &&
              dataAdcpTaskId === metadataTaskId;
            if (!equalsMetadata) {
              failures.push({
                pointer: '/result/artifacts/0/parts/0/data/adcp_task_id',
                expected: 'absent OR equal to artifact.metadata.adcp_task_id',
                actual: dataAdcpTaskId,
                detail:
                  typeof metadataTaskId === 'string'
                    ? `Pre-#899 dual-write detected: \`data.adcp_task_id\` (${JSON.stringify(dataAdcpTaskId)}) diverges from \`artifact.metadata.adcp_task_id\` (${JSON.stringify(metadataTaskId)}).`
                    : 'Pre-#899 shape detected: `adcp_task_id` appeared inside `artifact.parts[0].data` without a matching `artifact.metadata.adcp_task_id`. Transport metadata belongs on `artifact.metadata`.',
              });
            }
          }
        }
      }
    }
  }

  if (failures.length === 0) {
    return {
      check: 'a2a_submitted_artifact',
      passed: true,
      description: validation.description,
    };
  }

  // Surface every failure at once. The first one anchors json_pointer /
  // expected / actual for tools that read those scalar fields; the full
  // list lands in `actual.failures` so all regressions are visible in
  // a single grading run. Multi-failure runs prepend the first detail
  // to the error string so consumers reading only `error` still get a
  // pointer to the most-actionable diagnostic.
  const first = failures[0]!;
  return {
    check: 'a2a_submitted_artifact',
    passed: false,
    description: validation.description,
    error:
      failures.length === 1
        ? first.detail
        : `${failures.length} A2A wire-shape invariants failed; first: ${first.detail}`,
    json_pointer: first.pointer,
    expected: first.expected,
    actual: { failures },
  };
}

// ────────────────────────────────────────────────────────────
// refs_resolve (cross-step integrity check)
// ────────────────────────────────────────────────────────────

// ────────────────────────────────────────────────────────────
// a2a_context_continuity (cross-step A2A session-binding guard)
// ────────────────────────────────────────────────────────────

/**
 * Assert that the A2A `Task.contextId` on this step's response
 * matches the prior step's response. A2A 0.3.0 §7.1 binds follow-up
 * sends to a server-side conversation via `Message.contextId`; the
 * server MUST echo it on the response Task. The `@a2a-js/sdk`'s
 * `DefaultRequestHandler` does this automatically — `createA2AAdapter`
 * passes through `requestContext.contextId`, so a passing seller built
 * on the SDK won't trip a single-call check. The regression class is
 * sellers that bypass the SDK's request handler and stamp their own
 * `contextId` on the response, breaking buyer-side correlation across
 * a multi-turn flow (proposal refinement, IO signing, async approval).
 *
 * The check compares the current step's
 * `ctx.a2aEnvelope.result.contextId` against the prior step's
 * `ctx.priorA2aEnvelope.result.contextId`. Skip semantics:
 *
 *   - Non-A2A run (`a2aEnvelope` undefined) → skip
 *   - First A2A step in a run (`priorA2aEnvelope` undefined) → skip
 *   - Either envelope had no extractable `contextId` → skip
 *   - JSON-RPC error envelope (`envelope.error` present) → skip
 *
 * Skips emit a single observation noting which condition triggered so
 * triage can distinguish "validator self-skipped" from "validator
 * passed because contexts matched".
 */
function validateA2AContextContinuity(validation: StoryboardValidation, ctx: ValidationContext): ValidationResult {
  const current = ctx.a2aEnvelope;
  const prior = ctx.priorA2aEnvelope;
  const passResult = (observation: string): ValidationResult => ({
    check: 'a2a_context_continuity',
    passed: true,
    description: validation.description,
    observations: [observation],
  });

  if (!current)
    return passResult('a2a_envelope_not_captured: skipped on non-A2A transport (or capture-bypassing dispatch path)');
  if (!prior) return passResult('first_a2a_step: no prior A2A envelope to compare against; skipped');
  if (current.envelope.error !== undefined || prior.envelope.error !== undefined) {
    return passResult('jsonrpc_error_envelope: skipped — continuity is undefined for transport-rejected calls');
  }

  const currentContextId = extractContextIdFromEnvelope(current);
  const priorContextId = extractContextIdFromEnvelope(prior);

  if (priorContextId == null)
    return passResult('prior_contextId_absent: prior step did not surface a Task.contextId; skipped');
  if (currentContextId == null) {
    return {
      check: 'a2a_context_continuity',
      passed: false,
      description: validation.description,
      error:
        `Current step's response Task is missing \`contextId\` (prior step had ${JSON.stringify(priorContextId)}). ` +
        'A2A 0.3.0 requires the server to echo the client-supplied contextId on every follow-up send; an empty/missing ' +
        'contextId on a non-first send breaks buyer-side session correlation.',
      json_pointer: '/result/contextId',
      expected: priorContextId,
      actual: currentContextId,
    };
  }
  if (currentContextId !== priorContextId) {
    const priorStepNote = ctx.priorA2aStepId ? ` (prior step: ${ctx.priorA2aStepId})` : '';
    return {
      check: 'a2a_context_continuity',
      passed: false,
      description: validation.description,
      error:
        `A2A \`Task.contextId\` diverged across steps${priorStepNote}: expected ${JSON.stringify(priorContextId)}, got ${JSON.stringify(currentContextId)}. ` +
        "Per A2A 0.3.0 §7.1 the server MUST echo the client-supplied contextId on follow-up sends. A divergent value indicates the seller bypassed the SDK's request handler and stamped its own contextId — buyer-side session correlation is broken.",
      json_pointer: '/result/contextId',
      expected: priorContextId,
      actual: currentContextId,
    };
  }
  return { check: 'a2a_context_continuity', passed: true, description: validation.description };
}

function extractContextIdFromEnvelope(envelope: A2ATaskEnvelope): string | undefined {
  const result = envelope.result;
  if (result == null || typeof result !== 'object' || Array.isArray(result)) return undefined;
  const ctxId = (result as Record<string, unknown>).contextId;
  return typeof ctxId === 'string' && ctxId.length > 0 ? ctxId : undefined;
}

/**
 * Assert every ref in a source set resolves to a member of a target set.
 *
 * Used by `media_buy_seller` to check that every `format_id` returned on
 * `get_products` products actually resolves to a format in the subsequent
 * `list_creative_formats` response — catches invalid references before
 * `sync_creatives` fails at runtime.
 *
 * `scope` lets the check distinguish refs the agent under test owns
 * (`agent_url` matches) from third-party refs (pointing at a different
 * creative agent). Third-party refs can't be verified without calling
 * that agent's `list_creative_formats`, so `on_out_of_scope` controls
 * whether they pass (`warn` with observations, `ignore` silently) or
 * fail.
 */
function validateRefsResolve(validation: StoryboardValidation, ctx: ValidationContext): ValidationResult {
  const source = validation.source;
  const target = validation.target;
  const matchKeys = validation.match_keys;

  if (!source || !target || !matchKeys?.length) {
    return {
      check: 'refs_resolve',
      passed: false,
      description: validation.description,
      error: '`source`, `target`, and `match_keys` are all required for refs_resolve.',
      json_pointer: null,
      expected: '{ source, target, match_keys }',
      actual: {
        source: source ?? null,
        target: target ?? null,
        match_keys: matchKeys ?? null,
      },
    };
  }

  const sourceRoot = resolveRefsRoot(source.from, ctx);
  const targetRoot = resolveRefsRoot(target.from, ctx);
  const sourceRaw = resolvePathAll(sourceRoot, source.path);
  const targetRaw = resolvePathAll(targetRoot, target.path);
  const sourceRefs = sourceRaw.filter(isRefObject);
  const targetRefs = targetRaw.filter(isRefObject);

  const metaObservations: Array<Record<string, unknown>> = [];
  if (sourceRaw.length > 0 && sourceRefs.length === 0) {
    metaObservations.push({ kind: 'non_object_values_filtered', side: 'source', count: sourceRaw.length });
  }
  if (targetRaw.length > 0 && targetRefs.length === 0) {
    metaObservations.push({ kind: 'non_object_values_filtered', side: 'target', count: targetRaw.length });
  }

  // adcp-client#712: when the current-step target response carries
  // pagination metadata with more pages available, the target set is
  // incomplete and missing refs may legitimately live on later pages.
  // Surface a meta-observation AND demote unresolved refs to
  // observations so partial-page reads don't false-fail the check.
  // The stricter fix (spec Option A: "compliance mode returns everything
  // referenced by products") needs an AdCP spec change — until that
  // lands, the runner must not penalize conformant paginating sellers.
  const targetPaginated = target.from === 'current_step' && hasMorePages(targetRoot);
  if (targetPaginated) {
    metaObservations.push({ kind: 'target_paginated', side: 'target' });
  }

  const scope = validation.scope;
  const outOfScopeMode = validation.on_out_of_scope ?? 'warn';
  const scopeEquals = scope ? resolveScopeEquals(scope.equals, scope.key, ctx.agentUrl) : undefined;

  const inScope: Array<Record<string, unknown>> = [];
  const outOfScope: Array<Record<string, unknown>> = [];

  for (const ref of sourceRefs) {
    if (!scope) {
      inScope.push(ref);
      continue;
    }
    const refValue = ref[scope.key];
    const normalized = normalizeIfUrlKey(refValue, scope.key);
    if (scopeEquals !== undefined && normalized === scopeEquals) {
      inScope.push(ref);
    } else {
      outOfScope.push(ref);
    }
  }

  // adcp-client#711: catch the silent-no-op case where a scope filter
  // excludes 100% of source refs. Independent of whether the partition
  // is "correct" — if every ref falls out of scope, the check enforces
  // nothing and the grader deserves to see that structural smell.
  // Suppressed under `on_out_of_scope: 'ignore'` because that mode
  // explicitly opts out of scope-related warnings.
  if (scope && outOfScopeMode !== 'ignore' && sourceRefs.length > 0 && inScope.length === 0) {
    metaObservations.push({
      kind: 'scope_excluded_all_refs',
      count: sourceRefs.length,
      scope_key: scope.key,
    });
  }

  const unresolved = dedupRefs(
    inScope.filter(s => !targetRefs.some(t => refsMatch(s, t, matchKeys))),
    matchKeys
  );

  // When the target was paginated and refs are unresolved, demote those
  // refs from `missing` to `unresolved_with_pagination` observations so a
  // conformant paginating seller passes. The meta-observation still fires.
  const missing = targetPaginated ? [] : unresolved;
  const paginatedUnresolved = targetPaginated ? unresolved : [];

  // `fail` mode promotes out-of-scope refs into the missing set so compliance
  // reports name them the same way they name truly broken refs.
  const failOutOfScope = outOfScopeMode === 'fail' ? dedupRefs(outOfScope, matchKeys) : [];
  const allMissing = [...missing, ...failOutOfScope];

  const warnObservations =
    outOfScopeMode === 'warn' && outOfScope.length > 0
      ? dedupRefs(outOfScope, matchKeys).map(ref => ({
          kind: 'out_of_scope_ref',
          ref: projectRefForReport(ref, matchKeys),
        }))
      : [];
  const paginatedObservations = paginatedUnresolved.map(ref => ({
    kind: 'unresolved_with_pagination',
    ref: projectRefForReport(ref, matchKeys),
  }));

  // adcp-client#718: when target_paginated AND at least one ref is
  // unresolved-with-pagination, emit a neutral structural meta-observation
  // naming the co-occurrence. A seller that unconditionally returns
  // pagination.has_more: true masks unresolved refs via the pagination
  // demotion (#712/#717) and passes refs_resolve cleanly; graders keying
  // on `passed` alone wouldn't see the problem. This gives dashboards an
  // independent signal without changing pass/fail semantics. Becomes
  // redundant when adcp#2601's "compliance mode returns everything
  // referenced" rule lands.
  if (targetPaginated && paginatedUnresolved.length > 0) {
    metaObservations.push({
      kind: 'unresolved_hidden_by_pagination',
      unresolved_count: paginatedUnresolved.length,
    });
  }

  // Meta-observations precede per-ref observations so the array cap never
  // drops the grader-signal primitives (scope_excluded_all_refs,
  // target_paginated, unresolved_hidden_by_pagination) in favor of
  // redundant out-of-scope entries.
  const observations = capObservations([...metaObservations, ...paginatedObservations, ...warnObservations]);

  if (allMissing.length === 0) {
    return {
      check: 'refs_resolve',
      passed: true,
      description: validation.description,
      ...(observations && { observations }),
    };
  }

  const preview = allMissing
    .slice(0, 3)
    .map(r => JSON.stringify(projectRefForReport(r, matchKeys)))
    .join(', ');
  const errorMsg =
    allMissing.length > 3
      ? `${allMissing.length} ref(s) did not resolve; first 3: ${preview}`
      : `${allMissing.length} ref(s) did not resolve: ${preview}`;

  return {
    check: 'refs_resolve',
    passed: false,
    description: validation.description,
    path: source.path,
    error: errorMsg,
    json_pointer: null,
    expected: `every source ref resolves to a target ref matched on [${matchKeys.join(', ')}]`,
    actual: {
      missing: allMissing.map(r => projectRefForReport(r, matchKeys)),
      ...(failOutOfScope.length > 0 && {
        out_of_scope_failed: failOutOfScope.map(r => projectRefForReport(r, matchKeys)),
      }),
    },
    ...(observations && { observations }),
  };
}

/**
 * Detect whether the response at `root` advertises additional pages.
 * Accepts the AdCP-standard `pagination.has_more` flag; conservative
 * otherwise (false on non-objects, missing fields, or unparseable shapes).
 */
function hasMorePages(root: unknown): boolean {
  if (!root || typeof root !== 'object' || Array.isArray(root)) return false;
  const pagination = (root as Record<string, unknown>).pagination;
  if (!pagination || typeof pagination !== 'object' || Array.isArray(pagination)) return false;
  return (pagination as Record<string, unknown>).has_more === true;
}

function resolveRefsRoot(from: 'current_step' | 'context', ctx: ValidationContext): unknown {
  if (from === 'context') return ctx.storyboardContext ?? {};
  if (ctx.taskResult) return ctx.taskResult.data;
  if (ctx.httpResult) return ctx.httpResult.body;
  return undefined;
}

function resolveScopeEquals(equals: string, key: string, agentUrl: string): string {
  const raw = equals === '$agent_url' ? agentUrl : equals;
  return key.toLowerCase().endsWith('url') ? canonicalizeAgentUrlForScope(raw) : raw;
}

function normalizeIfUrlKey(value: unknown, key: string): unknown {
  return typeof value === 'string' && key.toLowerCase().endsWith('url') ? canonicalizeAgentUrlForScope(value) : value;
}

function isRefObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function refsMatch(a: Record<string, unknown>, b: Record<string, unknown>, keys: string[]): boolean {
  for (const key of keys) {
    // Own-property only: a storyboard author supplying `match_keys: ['constructor']`
    // must not match every object via prototype chain.
    if (!Object.prototype.hasOwnProperty.call(a, key) || !Object.prototype.hasOwnProperty.call(b, key)) {
      return false;
    }
    const av = a[key];
    const bv = b[key];
    // Missing match-key on either side is NOT a match — agents that omit a
    // key shouldn't fuzzy-match other agents that also happen to omit it.
    if (av === undefined || bv === undefined) return false;
    // URL-ish fields get trailing-slash / case normalization so declared
    // and probed URLs compare equal even when one side includes a trailing
    // "/". `format_id` fields are exact-compare.
    const normA = normalizeIfUrlKey(av, key);
    const normB = normalizeIfUrlKey(bv, key);
    if (normA !== normB) return false;
  }
  return true;
}

function projectRef(ref: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(ref, key)) out[key] = ref[key];
  }
  return out;
}

// Observation hygiene caps (adcp-client#714). Compliance reports may be
// published or forwarded to third parties, so every ref field emitted in
// observations / actual.missing is length-bounded and URL fields have
// credentials scrubbed before they leave the runner.
const REF_FIELD_MAX_LEN = 512;
const MAX_OBSERVATIONS = 50;

/**
 * Projection of a ref intended for grader-visible output (observations,
 * `actual.missing`). Strips userinfo from URL fields, caps string length,
 * and passes non-string values through untouched. Kept distinct from the
 * internal `projectRef` because dedup relies on stable JSON projection —
 * truncating strings would false-collapse refs that differ only in their
 * truncated suffix.
 */
function projectRefForReport(ref: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(ref, key)) continue;
    const v = ref[key];
    if (typeof v === 'string') {
      out[key] = sanitizeFieldString(v, key.toLowerCase().endsWith('url'));
    } else {
      out[key] = v;
    }
  }
  return out;
}

// Regex fallback that scrubs `scheme://user:pass@host` credential shapes
// in free-text fields — covers cases where `new URL()` can't parse the value
// (partial URL, extra prose, trailing whitespace) but a user:pass@ substring
// still leaks credentials to grader reports.
const CREDENTIAL_SHAPE_RE = /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^/\s@]+@/g;

function sanitizeFieldString(value: string, isUrlField: boolean): string {
  // Truncate first so a multi-MB hostile string doesn't force URL parsing
  // over the whole payload. Truncation uses code points so surrogate pairs
  // aren't cleaved into invalid UTF-16 strings.
  let out = value;
  if (out.length > REF_FIELD_MAX_LEN) {
    out =
      Array.from(out)
        .slice(0, REF_FIELD_MAX_LEN - 1)
        .join('') + '…';
  }
  if (isUrlField) {
    try {
      const u = new URL(out);
      // Reject dangerous schemes in URL-keyed fields: downstream compliance
      // UIs that render `agent_url` as a clickable link otherwise inherit
      // `javascript:` / `data:` / `file:` as a stored-XSS vector.
      if (u.protocol !== 'https:' && u.protocol !== 'http:') {
        return `<non-http scheme: ${u.protocol.replace(/[^a-z+.-]/gi, '')}>`;
      }
      if (u.username || u.password) {
        u.username = '';
        u.password = '';
        out = u.toString();
      }
    } catch {
      // Not a parseable URL — fall through to the regex scrub below.
    }
  }
  // Belt-and-suspenders: strip any remaining `scheme://user:pass@` shapes,
  // whether or not the field is URL-keyed. A hostile agent may plant
  // credential-shaped substrings inside an `id` or a non-URL ref field.
  out = out.replace(CREDENTIAL_SHAPE_RE, '$1');
  return out;
}

function capObservations(observations: Array<Record<string, unknown>>): Array<Record<string, unknown>> | undefined {
  if (observations.length === 0) return undefined;
  if (observations.length <= MAX_OBSERVATIONS) return observations;
  const kept = observations.slice(0, MAX_OBSERVATIONS - 1);
  kept.push({ kind: 'observations_truncated', dropped: observations.length - kept.length });
  return kept;
}

/**
 * Deduplicate refs by their projected match-key tuple so a single broken
 * reference in a 50-product response doesn't show up 50× in `actual.missing`.
 */
function dedupRefs(refs: Array<Record<string, unknown>>, keys: string[]): Array<Record<string, unknown>> {
  const seen = new Map<string, Record<string, unknown>>();
  for (const ref of refs) {
    const k = JSON.stringify(projectRef(ref, keys));
    if (!seen.has(k)) seen.set(k, ref);
  }
  return Array.from(seen.values());
}

// resolvePath re-exported from ./path for backwards compat
export { resolvePath } from './path';
