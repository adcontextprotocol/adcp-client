/**
 * Typed response builders for AdCP MCP servers.
 *
 * @deprecated For new code, use `createAdcpServerFromPlatform` from
 * `@adcp/sdk/server` instead — it constructs wire responses internally
 * from your typed `DecisioningPlatform` return values, so adopters don't
 * touch these builders. The functions below remain exported for v5
 * adopters wiring raw MCP tool handlers (mid-migration), and for adopters
 * shaping bespoke tools the platform interface doesn't yet model. For new
 * v6 adopters, ignore this whole module — the framework handles wire
 * shaping.
 *
 * Each function takes typed data (compile-time checked against AdCP schemas)
 * and returns an MCP-compatible tool response with `content` (text summary)
 * + `structuredContent` (typed payload).
 *
 * The input parameter enforces the AdCP schema shape at compile time.
 * The return type is compatible with MCP SDK's CallToolResult.
 *
 * @example
 * ```typescript
 * import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
 * import { capabilitiesResponse, productsResponse, adcpError } from '@adcp/sdk/server';
 * import { GetProductsRequestSchema } from '@adcp/sdk';
 *
 * const server = new McpServer({ name: 'My Agent', version: '1.0.0' });
 *
 * server.registerTool(
 *   'get_adcp_capabilities',
 *   { inputSchema: {} },
 *   async () => capabilitiesResponse({ supported_protocols: ['media_buy'] })
 * );
 *
 * server.registerTool(
 *   'get_products',
 *   { inputSchema: GetProductsRequestSchema.shape },
 *   async (params) => productsResponse({ products: myProducts })
 * );
 * ```
 */

import type { GetAdCPCapabilitiesResponse } from '../types/tools.generated';
import type { GetProductsResponse } from '../types/core.generated';
import type { CreateMediaBuySuccess } from '../types/core.generated';
import type { GetMediaBuyDeliveryResponse } from '../types/tools.generated';
import { validActionsForStatus } from './media-buy-helpers';
import type { CancelMediaBuyInput } from './media-buy-helpers';
import type {
  ListCreativeFormatsResponse,
  UpdateMediaBuySuccess,
  GetMediaBuysResponse,
  ProvidePerformanceFeedbackSuccess,
  BuildCreativeSuccess,
  BuildCreativeMultiSuccess,
  PreviewCreativeSingleResponse,
  PreviewCreativeBatchResponse,
  PreviewCreativeVariantResponse,
  GetCreativeDeliveryResponse,
  ListCreativesResponse,
  SyncCreativesSuccess,
  GetSignalsResponse,
  ActivateSignalSuccess,
  ListAccountsResponse,
  ListPropertyListsResponse,
  ListCollectionListsResponse,
  ListContentStandardsResponse,
  GetPlanAuditLogsResponse,
  ReportUsageRequest,
  ReportUsageResponse,
  SyncAccountsResponse,
  SyncGovernanceResponse,
} from '../types/tools.generated';
import type {
  AcquireRightsResponse,
  AcquireRightsAcquired,
  AcquireRightsPendingApproval,
  AcquireRightsRejected,
  UpdateRightsResponse,
  UpdateRightsSuccess,
  CreativeApprovalResponse,
  CreativeApproved,
  CreativeRejected,
  CreativePendingReview,
  CreativeApprovalError,
} from '../types/core.generated';

/**
 * MCP-compatible tool response shape.
 *
 * `structuredContent` is optional because error responses legitimately carry
 * only `content` (the human-readable error text) — forcing every wrapper to
 * fabricate an empty structuredContent obscures the success/error split.
 * All success builders in this file still populate it.
 *
 * Uses Record<string, unknown> for structuredContent to satisfy
 * MCP SDK's CallToolResult index signature requirement.
 */
export interface McpToolResponse {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
}

// MCP SDK requires structuredContent to have an index signature ({ [x: string]: unknown }).
// Generated AdCP types are TypeScript interfaces without index signatures. At runtime,
// JSON objects are always Records — this bridge is safe.
export function toStructuredContent(data: object): Record<string, unknown> {
  return data as unknown as Record<string, unknown>;
}

// `setup` is only ever nested inside an `Account` (the IO-signing / pending_approval
// path). A top-level `setup` on a media buy response means the builder read the
// storyboard's "setup.url" shorthand as a top-level field. The strict handler types
// would catch this, but `DomainHandler` accepts `Record<string, unknown>` for DX,
// so the error has to move to runtime.
function assertNoTopLevelSetup(data: unknown, builder: string): void {
  if (data != null && typeof data === 'object' && 'setup' in data) {
    throw new Error(
      `${builder}: \`setup\` is not a field on the media buy — it belongs inside \`account.setup\`. ` +
        `Move \`{ setup: { url, message } }\` to \`{ account: { ..., setup: { url, message } } }\`. ` +
        `The setup URL is a property of the Account (returned alongside \`status: 'pending_approval'\`), not the MediaBuy.`
    );
  }
}

/**
 * Build a get_adcp_capabilities response.
 *
 * `supported_protocols` lists AdCP domain protocols (media_buy, signals, governance, etc.),
 * NOT transport protocols (mcp, a2a).
 */
/** @deprecated v6: `createAdcpServerFromPlatform` constructs wire responses from typed platform returns. Direct use is for v5 raw-handler adopters mid-migration only. */
export function capabilitiesResponse(data: GetAdCPCapabilitiesResponse, summary?: string): McpToolResponse {
  return {
    content: [{ type: 'text', text: summary ?? 'Agent capabilities retrieved' }],
    structuredContent: toStructuredContent(data),
  };
}

/**
 * Build a get_products response.
 */
/** @deprecated v6: `createAdcpServerFromPlatform` constructs wire responses from typed platform returns. Direct use is for v5 raw-handler adopters mid-migration only. */
export function productsResponse(data: GetProductsResponse, summary?: string): McpToolResponse {
  return {
    content: [{ type: 'text', text: summary ?? `Found ${data.products.length} products` }],
    structuredContent: toStructuredContent(data),
  };
}

/**
 * Build a successful create_media_buy response.
 *
 * Applies protocol defaults when not explicitly provided:
 * - `revision` defaults to `1` (initial revision for optimistic concurrency)
 * - `confirmed_at` defaults to the current ISO 8601 timestamp
 * - `valid_actions` populated from status via `validActionsForStatus()` when
 *   `status` is provided but `valid_actions` is not
 */
/** @deprecated v6: `createAdcpServerFromPlatform` constructs wire responses from typed platform returns. Direct use is for v5 raw-handler adopters mid-migration only. */
export function mediaBuyResponse(data: CreateMediaBuySuccess, summary?: string): McpToolResponse {
  assertNoTopLevelSetup(data, 'mediaBuyResponse');
  const withDefaults = { ...data };
  if (withDefaults.revision === undefined) {
    withDefaults.revision = 1;
  }
  if (withDefaults.confirmed_at === undefined) {
    withDefaults.confirmed_at = new Date().toISOString();
  }
  if (withDefaults.valid_actions === undefined && withDefaults.status != null) {
    withDefaults.valid_actions = validActionsForStatus(withDefaults.status);
  }
  return {
    content: [{ type: 'text', text: summary ?? `Media buy ${withDefaults.media_buy_id} created` }],
    structuredContent: toStructuredContent(withDefaults),
  };
}

/**
 * Build a get_media_buy_delivery response.
 */
/** @deprecated v6: `createAdcpServerFromPlatform` constructs wire responses from typed platform returns. Direct use is for v5 raw-handler adopters mid-migration only. */
export function deliveryResponse(data: GetMediaBuyDeliveryResponse, summary?: string): McpToolResponse {
  return {
    content: [
      {
        type: 'text',
        text:
          summary ??
          `Delivery data for ${data.media_buy_deliveries.length} media buy${data.media_buy_deliveries.length === 1 ? '' : 's'}`,
      },
    ],
    structuredContent: toStructuredContent(data),
  };
}

/**
 * Build a list_accounts response.
 */
/** @deprecated v6: `createAdcpServerFromPlatform` constructs wire responses from typed platform returns. Direct use is for v5 raw-handler adopters mid-migration only. */
export function listAccountsResponse(data: ListAccountsResponse, summary?: string): McpToolResponse {
  return {
    content: [{ type: 'text', text: summary ?? `Found ${data.accounts.length} accounts` }],
    structuredContent: toStructuredContent(data),
  };
}

/**
 * Build a list_creative_formats response.
 */
/** @deprecated v6: `createAdcpServerFromPlatform` constructs wire responses from typed platform returns. Direct use is for v5 raw-handler adopters mid-migration only. */
export function listCreativeFormatsResponse(data: ListCreativeFormatsResponse, summary?: string): McpToolResponse {
  return {
    content: [{ type: 'text', text: summary ?? `Found ${data.formats.length} creative formats` }],
    structuredContent: toStructuredContent(data),
  };
}

/**
 * Build a successful update_media_buy response.
 *
 * When `status` is provided but `valid_actions` is not, auto-populates
 * `valid_actions` from `validActionsForStatus()`.
 */
/** @deprecated v6: `createAdcpServerFromPlatform` constructs wire responses from typed platform returns. Direct use is for v5 raw-handler adopters mid-migration only. */
export function updateMediaBuyResponse(data: UpdateMediaBuySuccess, summary?: string): McpToolResponse {
  assertNoTopLevelSetup(data, 'updateMediaBuyResponse');
  const withDefaults = { ...data };
  if (withDefaults.valid_actions === undefined && withDefaults.status != null) {
    withDefaults.valid_actions = validActionsForStatus(withDefaults.status);
  }
  return {
    content: [{ type: 'text', text: summary ?? `Media buy ${withDefaults.media_buy_id} updated` }],
    structuredContent: toStructuredContent(withDefaults),
  };
}

/**
 * Build a get_media_buys response.
 */
/** @deprecated v6: `createAdcpServerFromPlatform` constructs wire responses from typed platform returns. Direct use is for v5 raw-handler adopters mid-migration only. */
export function getMediaBuysResponse(data: GetMediaBuysResponse, summary?: string): McpToolResponse {
  if (Array.isArray(data.media_buys)) {
    for (const buy of data.media_buys) {
      assertNoTopLevelSetup(buy, 'getMediaBuysResponse');
    }
  }
  return {
    content: [
      {
        type: 'text',
        text: summary ?? `Found ${data.media_buys.length} media buy${data.media_buys.length === 1 ? '' : 's'}`,
      },
    ],
    structuredContent: toStructuredContent(data),
  };
}

/**
 * Build a successful provide_performance_feedback response.
 */
/** @deprecated v6: `createAdcpServerFromPlatform` constructs wire responses from typed platform returns. Direct use is for v5 raw-handler adopters mid-migration only. */
export function performanceFeedbackResponse(
  data: ProvidePerformanceFeedbackSuccess,
  summary?: string
): McpToolResponse {
  return {
    content: [{ type: 'text', text: summary ?? 'Performance feedback accepted' }],
    structuredContent: toStructuredContent(data),
  };
}

/**
 * Build a successful build_creative response (single format).
 */
/** @deprecated v6: `createAdcpServerFromPlatform` constructs wire responses from typed platform returns. Direct use is for v5 raw-handler adopters mid-migration only. */
export function buildCreativeResponse(data: BuildCreativeSuccess, summary?: string): McpToolResponse {
  // Optional-chain the default summary — handler responses that drop
  // `format_id` still reach the wire-level schema validator (which names
  // the missing field), instead of crashing the dispatcher here with an
  // opaque `Cannot read properties of undefined (reading 'id')`.
  const formatId = data.creative_manifest?.format_id?.id;
  return {
    content: [{ type: 'text', text: summary ?? (formatId ? `Creative built: ${formatId}` : 'Creative built') }],
    structuredContent: toStructuredContent(data),
  };
}

/**
 * Build a successful build_creative response (multi-format).
 */
/** @deprecated v6: `createAdcpServerFromPlatform` constructs wire responses from typed platform returns. Direct use is for v5 raw-handler adopters mid-migration only. */
export function buildCreativeMultiResponse(data: BuildCreativeMultiSuccess, summary?: string): McpToolResponse {
  const count = data.creative_manifests?.length ?? 0;
  return {
    content: [{ type: 'text', text: summary ?? `Built ${count} creative formats` }],
    structuredContent: toStructuredContent(data),
  };
}

/**
 * Build a preview_creative response.
 */
/** @deprecated v6: `createAdcpServerFromPlatform` constructs wire responses from typed platform returns. Direct use is for v5 raw-handler adopters mid-migration only. */
export function previewCreativeResponse(
  data: PreviewCreativeSingleResponse | PreviewCreativeBatchResponse | PreviewCreativeVariantResponse,
  summary?: string
): McpToolResponse {
  const defaultSummary =
    data.response_type === 'single'
      ? (() => {
          const n = (data as PreviewCreativeSingleResponse).previews.length;
          return `Preview generated: ${n} variant${n === 1 ? '' : 's'}`;
        })()
      : data.response_type === 'batch'
        ? (() => {
            const n = (data as PreviewCreativeBatchResponse).results.length;
            return `Batch preview: ${n} result${n === 1 ? '' : 's'}`;
          })()
        : `Variant preview generated`;
  return {
    content: [{ type: 'text', text: summary ?? defaultSummary }],
    structuredContent: toStructuredContent(data),
  };
}

/**
 * Build a get_creative_delivery response.
 */
/** @deprecated v6: `createAdcpServerFromPlatform` constructs wire responses from typed platform returns. Direct use is for v5 raw-handler adopters mid-migration only. */
export function creativeDeliveryResponse(data: GetCreativeDeliveryResponse, summary?: string): McpToolResponse {
  return {
    content: [{ type: 'text', text: summary ?? `Creative delivery data for ${data.currency} report` }],
    structuredContent: toStructuredContent(data),
  };
}

/**
 * Build a list_creatives response.
 */
/** @deprecated v6: `createAdcpServerFromPlatform` constructs wire responses from typed platform returns. Direct use is for v5 raw-handler adopters mid-migration only. */
export function listCreativesResponse(data: ListCreativesResponse, summary?: string): McpToolResponse {
  return {
    content: [
      {
        type: 'text',
        text:
          summary ?? `Found ${data.query_summary.total_matching} creatives (${data.query_summary.returned} returned)`,
      },
    ],
    structuredContent: toStructuredContent(data),
  };
}

/**
 * Build a list_property_lists response. The governance property-list catalog
 * is returned under the required `lists` wrapper — use this helper so
 * handlers can't accidentally emit a bare array at the top level (which the
 * storyboard runner flags as shape drift).
 */
/** @deprecated v6: `createAdcpServerFromPlatform` constructs wire responses from typed platform returns. Direct use is for v5 raw-handler adopters mid-migration only. */
export function listPropertyListsResponse(data: ListPropertyListsResponse, summary?: string): McpToolResponse {
  return {
    content: [
      {
        type: 'text',
        text: summary ?? `Found ${data.lists.length} property list${data.lists.length === 1 ? '' : 's'}`,
      },
    ],
    structuredContent: toStructuredContent(data),
  };
}

/**
 * Build a list_collection_lists response. Companion to
 * `listPropertyListsResponse` — same `lists` wrapper shape; parallel
 * governance surface for program-level collections.
 */
/** @deprecated v6: `createAdcpServerFromPlatform` constructs wire responses from typed platform returns. Direct use is for v5 raw-handler adopters mid-migration only. */
export function listCollectionListsResponse(data: ListCollectionListsResponse, summary?: string): McpToolResponse {
  return {
    content: [
      {
        type: 'text',
        text: summary ?? `Found ${data.lists.length} collection list${data.lists.length === 1 ? '' : 's'}`,
      },
    ],
    structuredContent: toStructuredContent(data),
  };
}

/**
 * Build a list_content_standards response. The response type is a union
 * (success branch with `standards` array, error branch with `errors`) —
 * the helper wraps either shape verbatim; schema-level invariants are
 * enforced at wire validation, not here.
 *
 * Discriminates on `'standards' in data` rather than `'errors' in data` so
 * a legitimate success response that happens to carry advisory `errors`
 * still gets a counted summary. The error-only text fires only when
 * `standards` is absent. Mirrors `acquireRightsResponse`'s success-first
 * discrimination pattern a few screens down.
 */
/** @deprecated v6: `createAdcpServerFromPlatform` constructs wire responses from typed platform returns. Direct use is for v5 raw-handler adopters mid-migration only. */
export function listContentStandardsResponse(data: ListContentStandardsResponse, summary?: string): McpToolResponse {
  const defaultSummary =
    'standards' in data
      ? `Found ${data.standards.length} content standard${data.standards.length === 1 ? '' : 's'}`
      : 'Content standards lookup error';
  return {
    content: [{ type: 'text', text: summary ?? defaultSummary }],
    structuredContent: toStructuredContent(data),
  };
}

/**
 * Build a get_plan_audit_logs response. Wraps the audit data array under
 * the required `plans` key — handlers that return a bare array trip the
 * storyboard runner's shape-drift hint.
 */
/** @deprecated v6: `createAdcpServerFromPlatform` constructs wire responses from typed platform returns. Direct use is for v5 raw-handler adopters mid-migration only. */
export function getPlanAuditLogsResponse(data: GetPlanAuditLogsResponse, summary?: string): McpToolResponse {
  return {
    content: [
      {
        type: 'text',
        text: summary ?? `Audit data for ${data.plans.length} plan${data.plans.length === 1 ? '' : 's'}`,
      },
    ],
    structuredContent: toStructuredContent(data),
  };
}

/**
 * Build a successful sync_creatives response.
 */
/** @deprecated v6: `createAdcpServerFromPlatform` constructs wire responses from typed platform returns. Direct use is for v5 raw-handler adopters mid-migration only. */
export function syncCreativesResponse(data: SyncCreativesSuccess, summary?: string): McpToolResponse {
  return {
    content: [
      {
        type: 'text',
        text: summary ?? `Synced ${data.creatives.length} creative${data.creatives.length === 1 ? '' : 's'}`,
      },
    ],
    structuredContent: toStructuredContent(data),
  };
}

/**
 * Build a get_signals response.
 */
/** @deprecated v6: `createAdcpServerFromPlatform` constructs wire responses from typed platform returns. Direct use is for v5 raw-handler adopters mid-migration only. */
export function getSignalsResponse(data: GetSignalsResponse, summary?: string): McpToolResponse {
  return {
    content: [
      { type: 'text', text: summary ?? `Found ${data.signals.length} signal${data.signals.length === 1 ? '' : 's'}` },
    ],
    structuredContent: toStructuredContent(data),
  };
}

/**
 * Build a successful activate_signal response.
 */
/** @deprecated v6: `createAdcpServerFromPlatform` constructs wire responses from typed platform returns. Direct use is for v5 raw-handler adopters mid-migration only. */
export function activateSignalResponse(data: ActivateSignalSuccess, summary?: string): McpToolResponse {
  return {
    content: [
      {
        type: 'text',
        text:
          summary ??
          `Signal activated across ${data.deployments.length} deployment${data.deployments.length === 1 ? '' : 's'}`,
      },
    ],
    structuredContent: toStructuredContent(data),
  };
}

/**
 * Build a cancel response for update_media_buy with action: 'cancel'.
 *
 * Eliminates the cancellation metadata trap by requiring `canceled_by`
 * and auto-setting `canceled_at`, `status: 'canceled'`, and `valid_actions: []`.
 *
 * Note: `cancellation` is not yet on the `UpdateMediaBuySuccess` generated type
 * (it exists on the full `MediaBuy` entity). This builder constructs the response
 * as a plain object to include it. When the upstream schema adds `cancellation`
 * to the update response, this can be tightened.
 *
 * @example
 * ```typescript
 * server.registerTool(
 *   'update_media_buy',
 *   { inputSchema: UpdateMediaBuyRequestSchema.shape },
 *   async (params) => {
 *     if (params.action === 'cancel') {
 *       return cancelMediaBuyResponse({
 *         media_buy_id: params.media_buy_id,
 *         canceled_by: 'buyer',
 *         revision: currentRevision + 1,
 *       });
 *     }
 *     // ... handle other actions
 *   }
 * );
 * ```
 */
/** @deprecated v6: `createAdcpServerFromPlatform` constructs wire responses from typed platform returns. Direct use is for v5 raw-handler adopters mid-migration only. */
export function cancelMediaBuyResponse(input: CancelMediaBuyInput, summary?: string): McpToolResponse {
  const cancellation: Record<string, unknown> = {
    canceled_at: input.canceled_at ?? new Date().toISOString(),
    canceled_by: input.canceled_by,
  };
  if (input.reason !== undefined) {
    cancellation.reason = input.reason;
  }

  const data: Record<string, unknown> = {
    media_buy_id: input.media_buy_id,
    status: 'canceled',
    valid_actions: [],
    revision: input.revision,
    cancellation,
  };
  if (input.affected_packages !== undefined) {
    data.affected_packages = input.affected_packages;
  }
  if (input.sandbox !== undefined) {
    data.sandbox = input.sandbox;
  }

  return {
    content: [{ type: 'text', text: summary ?? `Media buy ${input.media_buy_id} canceled` }],
    structuredContent: data,
  };
}

/**
 * Build an `acquire_rights` response. Thin envelope wrapper — enforces the
 * discriminated union on `status` at the type level, wraps the domain object
 * in `content` + `structuredContent`, nothing else. Schema-level constraints
 * (credential length, schemes cardinality, required-field presence) belong
 * in wire-level Zod validation, not here.
 *
 * Enable dev-time enforcement via
 * `createAdcpServer({ validation: { responses: 'strict' } })` until it
 * becomes the default.
 */
/** @deprecated v6: `createAdcpServerFromPlatform` constructs wire responses from typed platform returns. Direct use is for v5 raw-handler adopters mid-migration only. */
export function acquireRightsResponse(data: AcquireRightsResponse, summary?: string): McpToolResponse {
  const defaultSummary =
    'errors' in data
      ? 'Rights acquisition error'
      : data.status === 'acquired'
        ? `Rights ${data.rights_id} acquired`
        : data.status === 'rejected'
          ? `Rights ${data.rights_id} rejected`
          : `Rights ${data.rights_id} pending approval`;
  return {
    content: [{ type: 'text', text: summary ?? defaultSummary }],
    structuredContent: toStructuredContent(data),
  };
}

/**
 * Per-variant constructor — builds an `AcquireRightsAcquired` success response
 * and wraps it. Cleaner autocomplete than `acquireRightsResponse({ status: 'acquired', ... })`
 * because a coding agent typing `acquireRightsAcqu…` gets the required-fields
 * shape directly without reading a 4-variant union.
 */
/** @deprecated v6: `createAdcpServerFromPlatform` constructs wire responses from typed platform returns. Direct use is for v5 raw-handler adopters mid-migration only. */
export function acquireRightsAcquired(data: Omit<AcquireRightsAcquired, 'status'>, summary?: string): McpToolResponse {
  return acquireRightsResponse({ ...data, status: 'acquired' } as AcquireRightsAcquired, summary);
}

/** Per-variant constructor for the `pending_approval` branch. */
/** @deprecated v6: `createAdcpServerFromPlatform` constructs wire responses from typed platform returns. Direct use is for v5 raw-handler adopters mid-migration only. */
export function acquireRightsPendingApproval(
  data: Omit<AcquireRightsPendingApproval, 'status'>,
  summary?: string
): McpToolResponse {
  return acquireRightsResponse({ ...data, status: 'pending_approval' } as AcquireRightsPendingApproval, summary);
}

/** Per-variant constructor for the `rejected` branch. */
/** @deprecated v6: `createAdcpServerFromPlatform` constructs wire responses from typed platform returns. Direct use is for v5 raw-handler adopters mid-migration only. */
export function acquireRightsRejected(data: Omit<AcquireRightsRejected, 'status'>, summary?: string): McpToolResponse {
  return acquireRightsResponse({ ...data, status: 'rejected' } as AcquireRightsRejected, summary);
}

/**
 * Build an `update_rights` response. Wraps a `UpdateRightsResponse` (success
 * or error arm — discriminated structurally on `errors` presence) in the
 * standard `content` + `structuredContent` envelope. The framework auto-
 * applies this wrapper for v6 typed-platform handlers; direct callers are
 * v5 raw-handler adopters only.
 *
 * Mirrors `acquireRightsResponse`'s shape conventions (success-first
 * default summary, error pass-through).
 */
/** @deprecated v6: `createAdcpServerFromPlatform` constructs wire responses from typed platform returns. Direct use is for v5 raw-handler adopters mid-migration only. */
export function updateRightsResponse(data: UpdateRightsResponse, summary?: string): McpToolResponse {
  const defaultSummary =
    'errors' in data
      ? 'Rights update error'
      : data.implementation_date == null
        ? `Rights ${data.rights_id} update pending approval`
        : `Rights ${data.rights_id} updated`;
  return {
    content: [{ type: 'text', text: summary ?? defaultSummary }],
    structuredContent: toStructuredContent(data),
  };
}

/**
 * Per-variant constructor for the success arm. The wire spec doesn't
 * carry a `status` discriminator on `update_rights` (unlike
 * `acquire_rights`); success is identified structurally by absence of
 * `errors`. The narrow constructor is still useful — it gives autocomplete
 * the success-shape fields (`terms`, `generation_credentials`,
 * `rights_constraint`) without crossing the union.
 */
/** @deprecated v6: `createAdcpServerFromPlatform` constructs wire responses from typed platform returns. Direct use is for v5 raw-handler adopters mid-migration only. */
export function updateRightsSuccess(data: UpdateRightsSuccess, summary?: string): McpToolResponse {
  return updateRightsResponse(data, summary);
}

/**
 * Build a `creative_approval` webhook response.
 *
 * Unlike the other builders in this module, `creative_approval` is NOT an
 * MCP/A2A tool — the spec models it as an HTTP webhook. The buyer POSTs
 * a `CreativeApprovalRequest` to the `approval_webhook` URL returned in
 * `acquire_rights`; the brand-rights agent reviews and returns one of four
 * arms (Approved / Rejected / PendingReview / Error). Adopters wire this
 * builder into their HTTP server's response path — see the
 * `BrandRightsPlatform.reviewCreativeApproval` Platform method and the
 * skill at `skills/build-brand-rights-agent/SKILL.md` for the receiver
 * pattern.
 *
 * Returns the raw JSON-serializable payload, NOT an `McpToolResponse` —
 * webhooks have no `content` envelope. Adopters serialize this to JSON and
 * write to the HTTP response body.
 */
export function creativeApprovalResponse(data: CreativeApprovalResponse): CreativeApprovalResponse {
  return data;
}

/** Per-variant constructor for the `approved` branch — webhook payload. */
export function creativeApproved(data: Omit<CreativeApproved, 'status'>): CreativeApproved {
  return { ...data, status: 'approved' } as CreativeApproved;
}

/** Per-variant constructor for the `rejected` branch — webhook payload. */
export function creativeApprovalRejected(data: Omit<CreativeRejected, 'status'>): CreativeRejected {
  return { ...data, status: 'rejected' } as CreativeRejected;
}

/** Per-variant constructor for the `pending_review` branch — webhook payload. */
export function creativeApprovalPendingReview(data: Omit<CreativePendingReview, 'status'>): CreativePendingReview {
  return { ...data, status: 'pending_review' } as CreativePendingReview;
}

/** Per-variant constructor for the multi-error arm — webhook payload. */
export function creativeApprovalError(data: CreativeApprovalError): CreativeApprovalError {
  return data;
}

/**
 * Build a `sync_accounts` response. Thin envelope wrapper accepting the full
 * `SyncAccountsResponse` union; error payloads pass through.
 */
/** @deprecated v6: `createAdcpServerFromPlatform` constructs wire responses from typed platform returns. Direct use is for v5 raw-handler adopters mid-migration only. */
export function syncAccountsResponse(data: SyncAccountsResponse, summary?: string): McpToolResponse {
  const defaultSummary =
    'errors' in data
      ? 'Account sync error'
      : `Synced ${data.accounts?.length ?? 0} account${data.accounts?.length === 1 ? '' : 's'}`;
  return {
    content: [{ type: 'text', text: summary ?? defaultSummary }],
    structuredContent: toStructuredContent(data),
  };
}

/**
 * Build a sync_governance response. The spec permits two top-level shapes
 * (success / error); the type union enforces discrimination on `status`.
 */
/** @deprecated v6: `createAdcpServerFromPlatform` constructs wire responses from typed platform returns. Direct use is for v5 raw-handler adopters mid-migration only. */
export function syncGovernanceResponse(data: SyncGovernanceResponse, summary?: string): McpToolResponse {
  return {
    content: [{ type: 'text', text: summary ?? 'Governance registration synced' }],
    structuredContent: toStructuredContent(data),
  };
}

/**
 * Build a `report_usage` response. Thin envelope wrapper. Schema-level
 * `accepted` requiredness is enforced at the type level (via
 * `ReportUsageResponse.accepted: number`) and at wire-level validation;
 * this builder does not re-assert it.
 *
 * @example
 * ```typescript
 * // Explicit:
 * reportUsage: async (params) =>
 *   reportUsageResponse({ accepted: 8, errors: [{ usage_index: 2, message: 'invalid' }] })
 *
 * // Ack every usage[] row with optional errors (shortcut):
 * reportUsage: async (params) => reportUsageResponse.acceptAll(params)
 * ```
 */
/** @deprecated v6: `createAdcpServerFromPlatform` constructs wire responses from typed platform returns. Direct use is for v5 raw-handler adopters mid-migration only. */
export function reportUsageResponse(data: ReportUsageResponse, summary?: string): McpToolResponse {
  return {
    content: [
      { type: 'text', text: summary ?? `Accepted ${data.accepted} usage record${data.accepted === 1 ? '' : 's'}` },
    ],
    structuredContent: toStructuredContent(data),
  };
}

/**
 * Shortcut for the common case: accept all rows in the request, optionally
 * minus any `errors[]` the caller computed. Sets
 * `accepted = (request.usage?.length ?? 0) - errors.length`.
 *
 * Use with honest errors — passing no `errors` when rows failed validation
 * is lying to buyers and the audit trail.
 */
reportUsageResponse.acceptAll = function acceptAll(
  request: ReportUsageRequest,
  opts?: { errors?: ReportUsageResponse['errors']; summary?: string }
): McpToolResponse {
  const total = request.usage?.length ?? 0;
  const errors = opts?.errors ?? [];
  const accepted = Math.max(0, total - errors.length);
  return reportUsageResponse({ accepted, ...(errors.length > 0 ? { errors } : {}) }, opts?.summary);
};
