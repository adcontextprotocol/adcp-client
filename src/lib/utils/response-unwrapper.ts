/**
 * Response Unwrapper
 *
 * Extracts raw AdCP responses from protocol wrappers (MCP/A2A).
 * Follows canonical A2A response format per AdCP specification.
 */

import { z } from 'zod';
import { getBestUnionErrors } from './union-errors';

/**
 * Standard error codes for response unwrapping
 */
const ERROR_CODES = {
  MCP_ERROR: 'mcp_error',
  INVALID_RESPONSE: 'invalid_response',
  UNKNOWN: 'unknown',
} as const;

import type {
  GetProductsResponse,
  ListCreativeFormatsResponse,
  CreateMediaBuyResponse,
  SyncCreativesResponse,
  ListCreativesResponse,
  UpdateMediaBuyResponse,
  GetMediaBuysResponse,
  GetMediaBuyDeliveryResponse,
  ProvidePerformanceFeedbackResponse,
  BuildCreativeResponse,
  PreviewCreativeResponse,
  GetSignalsResponse,
  ActivateSignalResponse,
} from '../types/tools.generated';
import { prepareResponseForSchemaValidation, TOOL_RESPONSE_SCHEMAS } from './response-schemas';
import { injectLegacyEnvelopeStatus, normalizeLegacyMediaBuyStatusForReturn } from './envelope-status-compat';
import { getLatestA2ADataPartFromResponse } from './a2a-artifacts';

/**
 * Typed error thrown when the response unwrapper's Zod schema rejects an
 * agent response. Carries the structured rejection detail so the storyboard
 * runner can attribute the failure to its canonical `response_schema`
 * validation entry instead of silently falling through to whichever
 * step-level invariant fires next (e.g., `context.no_secret_echo`).
 *
 * Without this typed boundary, the runner can only catch a generic `Error`
 * with a freeform message — there's no stable way to distinguish a
 * schema rejection from a transport error or any other failure. The
 * misattribution this caused (every BidMachine `sync_accounts` failure
 * surfaced as `no_secret_echo`, masking the root cause across 10+ deploys)
 * is the canonical evidence for adcp-client#1709 and the reason this
 * class exists. The runner pattern-matches `err instanceof
 * ResponseSchemaValidationError` to synthesize the correct attribution.
 *
 * Stable wire surface: `name` is the literal string `'ResponseSchemaValidationError'`
 * so consumers that can't import the class (cross-bundle, dynamic
 * `require`) can still recognize it by string comparison.
 *
 * Spec: adcp-client#1709.
 */
export class ResponseSchemaValidationError extends Error {
  readonly name = 'ResponseSchemaValidationError';
  /** The AdCP tool name whose response failed validation (e.g., `'sync_accounts'`). */
  readonly toolName: string;
  /** The structured Zod issues from the failed `safeParse`. */
  readonly issues: z.core.$ZodIssue[];
  /** The raw response data that failed validation, for diagnostic reporting. */
  readonly data: unknown;

  constructor(toolName: string, issues: z.core.$ZodIssue[], data: unknown, summaryMessage: string) {
    super(`Response validation failed for ${toolName}: ${summaryMessage}`);
    this.toolName = toolName;
    this.issues = issues;
    this.data = data;
  }
}

/**
 * Union type of all possible AdCP responses
 * Each response type is a discriminated union of success | error
 */
export type AdCPResponse =
  | GetProductsResponse
  | ListCreativeFormatsResponse
  | CreateMediaBuyResponse
  | SyncCreativesResponse
  | ListCreativesResponse
  | UpdateMediaBuyResponse
  | GetMediaBuysResponse
  | GetMediaBuyDeliveryResponse
  | ProvidePerformanceFeedbackResponse
  | BuildCreativeResponse
  | PreviewCreativeResponse
  | GetSignalsResponse
  | ActivateSignalResponse;

const SUCCESS_PAYLOAD_FIELD_GROUPS_BY_TOOL: Readonly<Record<string, readonly (readonly string[])[]>> = {
  get_adcp_capabilities: [['adcp', 'supported_protocols']],
  list_accounts: [['accounts']],
  sync_accounts: [['accounts']],
  sync_governance: [['accounts']],
  report_usage: [['accepted']],
  get_account_financials: [['account', 'currency', 'period', 'timezone']],
  get_products: [['products'], ['unchanged']],
  list_creative_formats: [['formats']],
  create_media_buy: [['media_buy_id', 'packages']],
  update_media_buy: [['media_buy_id']],
  get_media_buys: [['media_buys']],
  get_media_buy_delivery: [['reporting_period', 'currency', 'media_buy_deliveries']],
  provide_performance_feedback: [['success']],
  sync_event_sources: [['event_sources']],
  log_event: [['events_received', 'events_processed']],
  sync_audiences: [['audiences']],
  sync_catalogs: [['catalogs']],
  sync_creatives: [['creatives']],
  list_creatives: [['query_summary', 'pagination', 'creatives']],
  build_creative: [['creative_manifest'], ['creative_manifests']],
  preview_creative: [['response_type', 'previews']],
  get_creative_delivery: [['currency', 'reporting_period', 'creatives']],
  validate_input: [['results']],
  get_signals: [['signals'], ['unchanged']],
  activate_signal: [['deployments']],
  create_property_list: [['list', 'auth_token']],
  update_property_list: [['list']],
  get_property_list: [['list']],
  list_property_lists: [['lists']],
  delete_property_list: [['deleted', 'list_id']],
  create_collection_list: [['list', 'auth_token']],
  update_collection_list: [['list']],
  get_collection_list: [['list']],
  list_collection_lists: [['lists']],
  delete_collection_list: [['deleted', 'list_id']],
  list_content_standards: [['standards']],
  create_content_standards: [['standards_id']],
  update_content_standards: [['success', 'standards_id']],
  calibrate_content: [['verdict']],
  validate_content_delivery: [['summary', 'results']],
  get_media_buy_artifacts: [['media_buy_id', 'artifacts']],
  get_creative_features: [['results']],
  sync_plans: [['plans']],
  check_governance: [['check_id', 'verdict', 'plan_id', 'explanation']],
  report_plan_outcome: [['outcome_id', 'outcome_state']],
  get_plan_audit_logs: [['plans']],
  si_get_offering: [['available']],
  si_initiate_session: [['session_id', 'session_status']],
  si_send_message: [['session_id', 'session_status']],
  si_terminate_session: [['session_id', 'terminated']],
  comply_test_controller: [['success']],
  validate_property_delivery: [['list_id', 'summary', 'results', 'validated_at']],
  get_brand_identity: [['brand_id', 'house', 'names']],
  verify_brand_claim: [['claim_type', 'verification_status']],
  get_rights: [['rights']],
  acquire_rights: [['rights_id', 'rights_status', 'brand_id']],
  update_rights: [['rights_id']],
  creative_approval: [['decision']],
  verify_brand_claims: [['results']],
  search_brands: [['brands']],
};

function hasOwnField(value: Record<string, unknown>, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, field);
}

/**
 * Top-level `errors[]` can be either a terminal Error arm or non-fatal
 * advisory diagnostics on a Success/Submitted arm. Envelope-only fields
 * (`status`, `context`, `ext`, version fields) do not prove success, so this
 * requires per-tool success-field evidence or the universal submitted envelope.
 * Completed payloads still flow through normal tool-schema validation after
 * this check.
 */
export function hasAdvisorySuccessPayload(response: unknown, toolName?: string): boolean {
  if (response == null || typeof response !== 'object' || Array.isArray(response)) return false;
  const obj = response as Record<string, unknown>;

  if (obj.status === 'failed' || obj.status === 'rejected') return false;
  if (obj.success === false) return false;

  if (obj.status === 'submitted' && (typeof obj.task_id === 'string' || typeof obj.taskId === 'string')) {
    return true;
  }

  if (!toolName) return false;

  const successFieldGroups = SUCCESS_PAYLOAD_FIELD_GROUPS_BY_TOOL[toolName];
  if (!successFieldGroups) return false;
  return successFieldGroups.some(group => group.every(field => hasOwnField(obj, field)));
}

export function isTerminalAdcpError(response: unknown, toolName?: string): boolean {
  const obj = response as Record<string, unknown> | null | undefined;
  if (obj?.status === 'failed' || obj?.status === 'rejected') return true;
  if (obj?.adcp_error && typeof (obj.adcp_error as { code?: unknown }).code === 'string') return true;
  if (typeof obj?.error_code === 'string') return true;
  if (Array.isArray(obj?.errors) && obj.errors.length > 0) {
    return !hasAdvisorySuccessPayload(obj, toolName);
  }
  return false;
}

/**
 * Extract raw AdCP response from protocol wrapper
 *
 * @param protocolResponse - Raw response from MCP or A2A protocol
 * @param toolName - Optional AdCP tool name for validation
 * @param protocol - Protocol type ('mcp' or 'a2a'), if known. If not provided, will auto-detect.
 * @param options - Optional validation behavior overrides
 * @returns Raw AdCP response data matching schema exactly
 * @throws {Error} If response doesn't match expected schema for the tool
 */
export function unwrapProtocolResponse(
  protocolResponse: any,
  toolName?: string,
  protocol?: 'mcp' | 'a2a',
  options?: { filterInvalidProducts?: boolean; responseAdcpVersion?: string }
): AdCPResponse & { _message?: string } {
  if (!protocolResponse) {
    throw new Error('Protocol response is null or undefined');
  }

  // Extract response from protocol wrapper
  let unwrapped: any;
  let mcpExtractionPath: McpExtractionPath | undefined;
  if (protocol === 'mcp') {
    const outcome = unwrapMCPResponse(protocolResponse);
    unwrapped = outcome.result;
    mcpExtractionPath = outcome.extractionPath;
  } else if (protocol === 'a2a') {
    unwrapped = unwrapA2AResponse(protocolResponse);
  } else {
    // Auto-detect protocol if not specified
    if (isMCPResponse(protocolResponse)) {
      const outcome = unwrapMCPResponse(protocolResponse);
      unwrapped = outcome.result;
      mcpExtractionPath = outcome.extractionPath;
    } else if (isA2AResponse(protocolResponse)) {
      unwrapped = unwrapA2AResponse(protocolResponse);
    } else {
      throw new Error('Unable to extract AdCP response from protocol wrapper');
    }
  }
  // Preserve the extraction path across Zod's `safeParse` (which returns a
  // fresh object). `retag` re-attaches the provenance to whichever object we
  // return so the tag survives validation, filtering, and _message merging.
  const retag = <T extends AdCPResponse & { _message?: string }>(value: T): T => {
    if (mcpExtractionPath !== undefined) tagExtractionPath(value, mcpExtractionPath);
    return value;
  };

  if (mcpExtractionPath !== undefined) {
    tagExtractionPath(unwrapped, mcpExtractionPath);
  }

  // Skip schema validation for error responses — they don't include
  // tool-specific fields like `products`. Handles both AdCP-standard
  // { errors: [...] } and legacy singular { error: "..." } patterns.
  if (isTerminalAdcpError(unwrapped, toolName) || (unwrapped?.error && typeof unwrapped.error === 'string')) {
    return retag(unwrapped);
  }

  // Validate success responses against tool schema if tool name provided
  if (toolName) {
    const schema = TOOL_RESPONSE_SCHEMAS[toolName];
    if (schema) {
      // Strip _message before validation — it's a text summary added by the unwrapper,
      // not part of the AdCP response schema. Intersection with union schemas fails in Zod v4.
      const { _message: _msg, ...stripped } = unwrapped as Record<string, unknown>;
      // Back-compat: 3.0.x sellers may omit envelope `status` (made REQUIRED
      // in 3.1.0-beta.2). Inject a synthetic status only when the response
      // declares itself as 3.0.x (or carries no version field at all).
      const dataToValidate = prepareResponseForSchemaValidation(
        toolName,
        injectLegacyEnvelopeStatus(stripped, { toolName }),
        options?.responseAdcpVersion
      ) as Record<string, unknown>;
      const result = schema.safeParse(dataToValidate);
      if (!result.success) {
        // When filterInvalidArrayItems is enabled and this is a get_products response,
        // try filtering invalid products individually rather than rejecting the entire response.
        if (options?.filterInvalidProducts && toolName === 'get_products') {
          const filtered = filterInvalidProducts(schema, dataToValidate);
          if (filtered) {
            let validated = filtered as unknown as AdCPResponse & { _message?: string };
            // Strip compat-injected `status` before returning — same rationale as
            // the main success path below. See adcp-client#1961.
            if (!('status' in stripped)) {
              const { status: _s, ...rest } = validated as unknown as Record<string, unknown>;
              validated = rest as unknown as typeof validated;
            } else {
              validated = restoreLegacyMediaBuyStatusForReturn(validated, stripped, dataToValidate, toolName);
            }
            if (!('adcp_version' in stripped)) {
              const { adcp_version: _v, ...rest } = validated as unknown as Record<string, unknown>;
              validated = rest as unknown as typeof validated;
            }
            if (_msg) validated._message = _msg as string;
            return retag(validated);
          }
        }

        // Union schemas produce a generic "Invalid input" at (root).
        // Try each variant to surface the actual missing/invalid fields.
        const firstIssue = result.error.issues[0];
        const isUnionError = result.error.issues.length === 1 && firstIssue?.code === 'invalid_union';

        if (isUnionError) {
          const betterErrors = getBestUnionErrors(schema, dataToValidate);
          if (betterErrors && betterErrors.length > 0) {
            const bestMessage = betterErrors.map(e => `${e.path}: ${e.message}`).join('; ');
            throw new ResponseSchemaValidationError(toolName, result.error.issues, dataToValidate, bestMessage);
          }
        }

        throw new ResponseSchemaValidationError(toolName, result.error.issues, dataToValidate, result.error.message);
      }

      // Re-attach _message after validation so it's available for text summaries.
      // Strip any compat-injected `status` before returning: the injection was
      // purely to let a 3.0.x seller pass the 3.1 envelope schema; propagating
      // it into taskResult.data causes storyboard field_value_or_absent checks
      // on the deprecated legacy `status` field to fail with a false positive
      // (sees injected "completed" instead of absent). See adcp-client#1961.
      let validated = result.data as AdCPResponse & { _message?: string };
      if (!('status' in stripped)) {
        const { status: _s, ...rest } = validated as unknown as Record<string, unknown>;
        validated = rest as unknown as typeof validated;
      } else {
        validated = restoreLegacyMediaBuyStatusForReturn(validated, stripped, dataToValidate, toolName);
      }
      if (!('adcp_version' in stripped)) {
        const { adcp_version: _v, ...rest } = validated as unknown as Record<string, unknown>;
        validated = rest as unknown as typeof validated;
      }
      if (_msg) validated._message = _msg as string;
      return retag(validated);
    }
  }

  // Return unwrapped response (no validation) — already tagged above.
  return unwrapped as AdCPResponse;
}

function restoreLegacyMediaBuyStatusForReturn<T extends AdCPResponse & { _message?: string }>(
  validated: T,
  original: Record<string, unknown>,
  compat: Record<string, unknown>,
  toolName: string
): T {
  if (
    (toolName === 'create_media_buy' || toolName === 'update_media_buy') &&
    typeof original.media_buy_id === 'string' &&
    typeof original.status === 'string' &&
    compat.status === 'completed' &&
    typeof compat.media_buy_status === 'string'
  ) {
    return normalizeLegacyMediaBuyStatusForReturn(
      { ...validated, status: original.status } as unknown as Record<string, unknown>,
      { toolName }
    ) as unknown as T;
  }
  return normalizeLegacyMediaBuyStatusForReturn(validated as unknown as Record<string, unknown>, {
    toolName,
  }) as unknown as T;
}

/**
 * Filter invalid products from a get_products response.
 *
 * Validates each product individually against the ProductSchema,
 * keeps only valid ones, and re-validates the full response.
 * Returns the filtered response, or null if filtering can't help.
 */
function filterInvalidProducts(schema: z.ZodType, data: Record<string, unknown>): Record<string, unknown> | null {
  const products = data.products;
  if (!Array.isArray(products)) return null;

  // `products` is optional on `get_products` since AdCP 3.1.0-beta.3 (the
  // `unchanged: true` wholesale-feed branch legitimately omits it). The Zod
  // shape is now `ZodOptional<ZodArray<...>>` rather than the bare
  // `ZodArray<...>` we used to see. Unwrap a level of `ZodOptional` /
  // `ZodNullable` before the array check so the helper still finds the
  // element schema.
  let ProductSchema = (schema as z.ZodObject<any>).shape?.products;
  if (ProductSchema instanceof z.ZodOptional || ProductSchema instanceof z.ZodNullable) {
    ProductSchema = (ProductSchema as z.ZodOptional<any>).unwrap();
  }
  if (!(ProductSchema instanceof z.ZodArray)) return null;

  const elementSchema = (ProductSchema as z.ZodArray<any>).element;
  const validProducts: unknown[] = [];
  for (const product of products) {
    if (elementSchema.safeParse(product).success) {
      validProducts.push(product);
    }
  }

  // Nothing was filtered — all products are individually valid, so the validation
  // error is at the response level (not caused by invalid products). Fall through
  // to the normal error path.
  if (validProducts.length === products.length) return null;

  const filtered = { ...data, products: validProducts };
  const revalidated = schema.safeParse(filtered);
  if (revalidated.success) {
    const droppedCount = products.length - validProducts.length;
    console.warn(
      `[adcp-client] Filtered ${droppedCount} invalid product(s) from get_products response (${validProducts.length} valid, ${products.length} total)`
    );
    return revalidated.data as Record<string, unknown>;
  }

  return null;
}

/**
 * Check if response is MCP format
 */
function isMCPResponse(response: any): boolean {
  return 'structuredContent' in response || 'isError' in response || 'content' in response;
}

/**
 * Check if response is A2A format.
 * A2A errors are JSON-RPC objects ({ code, message }), not strings.
 */
function isA2AResponse(response: any): boolean {
  return 'result' in response || ('error' in response && typeof response.error === 'object' && response.error !== null);
}

/**
 * MCP response extraction provenance. Set as a non-enumerable `_extraction_path`
 * property on the unwrapped object so the storyboard runner can surface it in
 * its runner-output contract without leaking into JSON-serialized or spread
 * responses. See `src/lib/testing/storyboard/types.ts` → `RunnerExtractionPath`.
 */
export type McpExtractionPath = 'structured_content' | 'text_fallback' | 'error' | 'none';

export const EXTRACTION_PATH_KEY = '_extraction_path' as const;

interface McpUnwrapOutcome {
  result: AdCPResponse;
  extractionPath: McpExtractionPath;
}

/**
 * Unwrap MCP response - all MCP logic in one place.
 *
 * Also records which branch produced the parsed response (structuredContent
 * vs text content) so downstream tooling can tell a runner extraction bug
 * apart from an agent bug.
 */
function unwrapMCPResponse(response: any): McpUnwrapOutcome {
  // MCP error response — preserve full structured data (context, ext, adcp_error)
  if (response.isError === true) {
    // L3: structuredContent has the full error payload.
    // Trust boundary: this is untrusted agent content passed through as-is.
    // Consumers must sanitize fields like suggestion/details before rendering.
    if (response.structuredContent && typeof response.structuredContent === 'object') {
      return { result: response.structuredContent as AdCPResponse, extractionPath: 'error' };
    }

    // L2: JSON in text content
    if (Array.isArray(response.content)) {
      for (const item of response.content) {
        if (item?.type === 'text' && item.text) {
          try {
            const parsed = JSON.parse(item.text);
            if (parsed?.adcp_error && typeof parsed.adcp_error.code === 'string') {
              return { result: parsed as AdCPResponse, extractionPath: 'error' };
            }
          } catch {
            // not JSON, continue to raw text fallback
          }
        }
      }
    }

    // L1: Raw text fallback — no structured data available
    const errorContent = Array.isArray(response.content)
      ? response.content.find((c: any) => c.type === 'text')?.text
      : response.content?.text || 'Unknown error';

    return {
      result: {
        adcp_error: {
          code: ERROR_CODES.MCP_ERROR,
          message: errorContent || 'MCP tool call failed',
          synthetic: true,
        },
      } as unknown as AdCPResponse,
      extractionPath: 'error',
    };
  }

  // MCP success response with structuredContent
  if (response.structuredContent !== undefined && response.structuredContent !== null) {
    const data = response.structuredContent;

    // Extract text messages from content field (parallel to A2A TextParts)
    const textMessages: string[] = [];
    if (response.content && Array.isArray(response.content)) {
      for (const item of response.content) {
        if (item.type === 'text' && item.text) {
          textMessages.push(item.text);
        }
      }
    }

    // Include text messages if present (same pattern as A2A)
    if (textMessages.length > 0) {
      return {
        result: {
          ...data,
          _message: textMessages.join('\n'),
        },
        extractionPath: 'structured_content',
      };
    }

    return { result: data, extractionPath: 'structured_content' };
  }

  // MCP text content fallback (try parsing as JSON)
  if (response.content && Array.isArray(response.content)) {
    const textContent = response.content.find((c: any) => c.type === 'text');
    if (textContent?.text) {
      try {
        return { result: JSON.parse(textContent.text), extractionPath: 'text_fallback' };
      } catch {
        // Include snippet of text for debugging (max 100 chars)
        const snippet = textContent.text.length > 100 ? textContent.text.substring(0, 100) + '...' : textContent.text;

        return {
          result: {
            // AdCP 3.1.0-beta.2+: envelope `status` is REQUIRED on every
            // response. Synthetic error envelopes synthesized by the SDK
            // when the wire doesn't carry a valid AdCP payload need the
            // same. `failed` matches the error semantics of this branch.
            status: 'failed' as const,
            errors: [
              {
                code: ERROR_CODES.INVALID_RESPONSE,
                message: `Response does not contain structured AdCP data. Text content: "${snippet}"`,
              },
            ],
          } as AdCPResponse,
          extractionPath: 'text_fallback',
        };
      }
    }
  }

  throw new Error('Invalid MCP response format');
}

/**
 * Attach the extraction path to an unwrapped object as a non-enumerable
 * property. Non-enumerable so `JSON.stringify`, `Object.keys`, and spread
 * ignore it — the storyboard runner reads it via a direct property access
 * but the rest of the system sees the unwrapped data unchanged.
 */
function tagExtractionPath(result: AdCPResponse, path: McpExtractionPath): AdCPResponse {
  if (result === null || typeof result !== 'object') return result;
  try {
    Object.defineProperty(result, EXTRACTION_PATH_KEY, {
      value: path,
      enumerable: false,
      configurable: true,
      writable: true,
    });
  } catch {
    // Frozen / sealed objects reject defineProperty; drop the tag silently —
    // the runner's fallback inference in extractionFromTaskResult still works.
  }
  return result;
}

/**
 * Read the extraction path from an unwrapped AdCP response, or `undefined`
 * if the response did not originate from an MCP unwrap path.
 */
export function readExtractionPath(data: unknown): McpExtractionPath | undefined {
  if (data === null || typeof data !== 'object') return undefined;
  const path = (data as Record<string, unknown>)[EXTRACTION_PATH_KEY];
  return typeof path === 'string' ? (path as McpExtractionPath) : undefined;
}

/**
 * Unwrap A2A response
 *
 * Called for terminal task states ("completed", "failed", "rejected",
 * "canceled"). All four carry the same artifact + DataPart envelope per
 * AdCP transport-errors §A2A Binding — failed tasks place `adcp_error`
 * into the DataPart alongside an optional terse TextPart.
 *
 * Intermediate statuses ("working", "submitted", "input-required",
 * "auth-required") do not yet have AdCP artifacts and are rejected here
 * so callers handle them at the response level.
 */
const TERMINAL_A2A_STATES: ReadonlySet<string> = new Set(['completed', 'failed', 'rejected', 'canceled']);

/**
 * Detect whether a response carries a spec-compliant terminal-state Task
 * with a structured DataPart artifact. Mirrors the protocol-layer guard in
 * `src/lib/protocols/a2a.ts` (`hasTerminalTaskWithDataArtifact`) so the
 * unwrapper defers to the canonical envelope when a non-conformant seller
 * surfaces both a top-level transport error and the AdCP artifact.
 */
function hasTerminalTaskWithDataArtifact(response: unknown): boolean {
  if (!response || typeof response !== 'object') return false;
  const result = (response as { result?: unknown }).result;
  if (!result || typeof result !== 'object') return false;
  const r = result as { kind?: unknown; status?: unknown; artifacts?: unknown };
  if (r.kind !== 'task') return false;
  const status = r.status as { state?: unknown } | undefined;
  if (typeof status?.state !== 'string' || !TERMINAL_A2A_STATES.has(status.state)) return false;
  return getLatestA2ADataPartFromResponse(response) !== undefined;
}

function unwrapA2AResponse(response: any): AdCPResponse {
  const taskState = response.result?.status?.state;
  if (taskState && !TERMINAL_A2A_STATES.has(taskState)) {
    throw new Error(
      `Cannot unwrap A2A response with intermediate status: ${taskState}. ` +
        'Only terminal responses (completed, failed, rejected, canceled) should be unwrapped.'
    );
  }
  // A2A error response (JSON-RPC error). adcp-client#1575: when a
  // non-conformant seller surfaces both a top-level JSON-RPC error AND a
  // terminal-state Task with a structured DataPart artifact, the artifact
  // is canonical per AdCP transport-errors §A2A Binding — defer to the
  // artifact extraction below. Mirrors the protocol-layer guard at
  // `src/lib/protocols/a2a.ts` so the two layers stay symmetric and
  // direct callers (storyboard fixtures, cached responses, webhook
  // payloads) inherit the same defensive behavior.
  if (response.error && !hasTerminalTaskWithDataArtifact(response)) {
    return {
      // AdCP 3.1.0-beta.2+: envelope `status` is REQUIRED. Synthetic error
      // envelopes for A2A JSON-RPC failures carry `failed` to match the
      // error semantics.
      status: 'failed' as const,
      errors: [
        {
          code: response.error.code?.toString() || ERROR_CODES.UNKNOWN,
          message: response.error.message || 'A2A JSON-RPC error occurred',
          ...(response.error.data && { data: response.error.data }),
        },
      ],
    } as AdCPResponse;
  }

  // A2A terminal response — same shape regardless of success or failure:
  // - MUST have result.artifacts array with at least one artifact
  // - Artifact MUST have at least one DataPart (kind: 'data') with the AdCP payload
  //   (success payload for `completed`, `adcp_error` envelope for `failed`)
  // - MAY have TextParts (kind: 'text') with optional messages

  const artifacts = response.result?.artifacts;
  if (!Array.isArray(artifacts) || artifacts.length === 0) {
    throw new Error('A2A response must have at least one artifact');
  }

  const artifact = artifacts[artifacts.length - 1];
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) {
    throw new Error('A2A response must have at least one artifact');
  }

  if (!('parts' in artifact) || !Array.isArray((artifact as { parts?: unknown }).parts)) {
    throw new Error('A2A artifact missing parts array');
  }

  // Extract DataPart (required) and TextParts (optional). Use the shared
  // latest structured DataPart helper so parser and validator agree.
  const extracted = getLatestA2ADataPartFromResponse(response);
  if (!extracted) {
    throw new Error('A2A response must have a DataPart with AdCP data');
  }

  const parts = (artifact as { parts: unknown[] }).parts;
  const textParts = parts
    .filter((p: any) => p && typeof p === 'object' && p.kind === 'text' && p.text)
    .map((p: any) => p.text);

  // Unwrap nested response field if present (some agents wrap AdCP responses)
  let data: any = extracted.data;
  if (data?.response && typeof data.response === 'object' && !Array.isArray(data.response)) {
    data = data.response;
  }

  // Return data with optional message
  if (textParts.length > 0) {
    return {
      ...data,
      _message: textParts.join('\n'),
    };
  }

  return data;
}

/**
 * Check if a response is an AdCP error response.
 * Recognizes both `{ adcp_error: { code: string } }` (MCP structured errors)
 * and `{ errors: [{ code, message }] }` (legacy/A2A format).
 *
 * This helper is structural and intentionally does not know which tool
 * produced the payload. For AdCP 3.1 success/submitted payloads that can
 * carry advisory `errors[]`, prefer {@link isTerminalAdcpError} with a
 * `toolName`.
 */
export function isAdcpError(response: any): boolean {
  if (Array.isArray(response?.errors) && response.errors.length > 0) return true;
  if (response?.adcp_error && typeof response.adcp_error.code === 'string') return true;
  return false;
}

/**
 * Check if a response is an AdCP success response for a specific task
 *
 * Uses Zod schemas to validate the response structure matches the expected
 * success response format for the given task.
 */
export function isAdcpSuccess(response: any, taskName: string, responseAdcpVersion?: string): boolean {
  // First check if it's an error response
  if (isTerminalAdcpError(response, taskName)) {
    return false;
  }

  // Try to validate with Zod schema if available
  const schema = TOOL_RESPONSE_SCHEMAS[taskName];
  if (schema) {
    const { _message: _, ...stripped } = (response ?? {}) as Record<string, unknown>;
    // Apply the same 3.0.x envelope-status leniency as unwrapProtocolResponse
    // so success detection stays consistent across the two entry points.
    const dataToValidate = prepareResponseForSchemaValidation(
      taskName,
      injectLegacyEnvelopeStatus(stripped, { toolName: taskName }),
      responseAdcpVersion
    );
    const result = schema.safeParse(dataToValidate);
    return result.success;
  }

  // Unknown task - can't validate, assume success if no errors
  return true;
}
