/**
 * Typed response builders for AdCP MCP servers.
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
 * import { capabilitiesResponse, productsResponse, adcpError } from '@adcp/client/server';
 * import { GetProductsRequestSchema } from '@adcp/client';
 *
 * const server = new McpServer({ name: 'My Agent', version: '1.0.0' });
 *
 * server.tool('get_adcp_capabilities', {}, async () =>
 *   capabilitiesResponse({ supported_protocols: ['media_buy'] })
 * );
 *
 * server.tool('get_products', GetProductsRequestSchema.shape, async (params) =>
 *   productsResponse({ products: myProducts })
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
export function capabilitiesResponse(data: GetAdCPCapabilitiesResponse, summary?: string): McpToolResponse {
  return {
    content: [{ type: 'text', text: summary ?? 'Agent capabilities retrieved' }],
    structuredContent: toStructuredContent(data),
  };
}

/**
 * Build a get_products response.
 */
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
export function listAccountsResponse(data: ListAccountsResponse, summary?: string): McpToolResponse {
  return {
    content: [{ type: 'text', text: summary ?? `Found ${data.accounts.length} accounts` }],
    structuredContent: toStructuredContent(data),
  };
}

/**
 * Build a list_creative_formats response.
 */
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
 * Build a successful build_creative response (single format). Validates that
 * `creative_manifest.format_id` is the `{ agent_url, id }` object shape the
 * schema demands — matrix runs caught Claude-built agents returning
 * `creative_manifest: { format_id: undefined }` which fails the `oneOf`
 * discriminator with a cryptic "expected object, received undefined" error.
 */
export function buildCreativeResponse(data: BuildCreativeSuccess, summary?: string): McpToolResponse {
  const manifest = data.creative_manifest;
  const formatId = manifest?.format_id as unknown;
  if (
    !formatId ||
    typeof formatId !== 'object' ||
    typeof (formatId as { agent_url?: unknown }).agent_url !== 'string' ||
    typeof (formatId as { id?: unknown }).id !== 'string'
  ) {
    throw new Error(
      `buildCreativeResponse: creative_manifest.format_id must be { agent_url: string, id: string }. ` +
        `Got: ${JSON.stringify(formatId)}. Copy the format_id object from the request or from list_creative_formats verbatim.`
    );
  }
  return {
    content: [{ type: 'text', text: summary ?? `Creative built: ${manifest.format_id.id}` }],
    structuredContent: toStructuredContent(data),
  };
}

/**
 * Build a successful build_creative response (multi-format).
 */
export function buildCreativeMultiResponse(data: BuildCreativeMultiSuccess, summary?: string): McpToolResponse {
  return {
    content: [{ type: 'text', text: summary ?? `Built ${data.creative_manifests.length} creative formats` }],
    structuredContent: toStructuredContent(data),
  };
}

/**
 * Build a preview_creative response.
 */
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
export function creativeDeliveryResponse(data: GetCreativeDeliveryResponse, summary?: string): McpToolResponse {
  return {
    content: [{ type: 'text', text: summary ?? `Creative delivery data for ${data.currency} report` }],
    structuredContent: toStructuredContent(data),
  };
}

/**
 * Build a list_creatives response.
 */
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
 * Build a successful sync_creatives response.
 */
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
 * server.tool('update_media_buy', UpdateMediaBuyRequestSchema.shape, async (params) => {
 *   if (params.action === 'cancel') {
 *     return cancelMediaBuyResponse({
 *       media_buy_id: params.media_buy_id,
 *       canceled_by: 'buyer',
 *       revision: currentRevision + 1,
 *     });
 *   }
 *   // ... handle other actions
 * });
 * ```
 */
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
 * Build an acquire_rights response. Accepts the full
 * `AcquireRightsResponse` union (`acquired | pending_approval | rejected`
 * + an error variant that carries `errors[]` instead of `rights_id`). Error
 * payloads pass through as an `errors` structuredContent so the framework
 * surfaces them the same way `adcpError(...)` does.
 *
 * Validates `approval_webhook.authentication.credentials` AND
 * `revocation_webhook.authentication.credentials` length at runtime (spec:
 * ≥32 chars). Zod tolerates shorter strings until full validation kicks
 * in; this builder fails loudly at response-construction time with a
 * pointer at the easy fix.
 */
export function acquireRightsResponse(data: AcquireRightsResponse, summary?: string): McpToolResponse {
  if ('errors' in data) {
    return {
      content: [{ type: 'text', text: summary ?? 'Rights acquisition error' }],
      structuredContent: toStructuredContent(data),
    };
  }
  if (data.status === 'acquired') {
    assertWebhookCredentials('approval_webhook', data.approval_webhook);
  }
  const defaultSummary =
    data.status === 'acquired'
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
export function acquireRightsAcquired(
  data: Omit<AcquireRightsAcquired, 'status'>,
  summary?: string
): McpToolResponse {
  return acquireRightsResponse({ ...data, status: 'acquired' } as AcquireRightsAcquired, summary);
}

/** Per-variant constructor for the `pending_approval` branch. */
export function acquireRightsPendingApproval(
  data: Omit<AcquireRightsPendingApproval, 'status'>,
  summary?: string
): McpToolResponse {
  return acquireRightsResponse({ ...data, status: 'pending_approval' } as AcquireRightsPendingApproval, summary);
}

/** Per-variant constructor for the `rejected` branch. */
export function acquireRightsRejected(
  data: Omit<AcquireRightsRejected, 'status'>,
  summary?: string
): McpToolResponse {
  return acquireRightsResponse({ ...data, status: 'rejected' } as AcquireRightsRejected, summary);
}

function assertWebhookCredentials(
  fieldName: string,
  webhook: { authentication?: { credentials?: string; schemes?: unknown[] } } | undefined
): void {
  const auth = webhook?.authentication;
  if (!auth) return;
  const cred = auth.credentials;
  if (cred !== undefined && cred.length < 32) {
    throw new Error(
      `acquireRightsResponse: ${fieldName}.authentication.credentials must be ≥32 chars (got ${cred.length}). ` +
        `Use a high-entropy token (e.g., randomUUID().replace(/-/g, "") returns 32 hex chars).`
    );
  }
  // push-notification-config.json requires schemes: exactly one entry.
  const schemes = auth.schemes;
  if (schemes !== undefined && (!Array.isArray(schemes) || schemes.length !== 1)) {
    throw new Error(
      `acquireRightsResponse: ${fieldName}.authentication.schemes must be a 1-item array (got ${
        Array.isArray(schemes) ? `length ${schemes.length}` : typeof schemes
      }). ` + `Spec: authentication.schemes has minItems=1, maxItems=1.`
    );
  }
}

/**
 * Build a sync_accounts response. Accepts the full
 * `SyncAccountsResponse` union — error payloads pass through. On the
 * success branch, validates every account has an `account_id`; matrix runs
 * caught fresh agents echoing request fields without stamping a
 * server-generated id, which fails the "platform-assigned ID"
 * storyboard step.
 */
export function syncAccountsResponse(data: SyncAccountsResponse, summary?: string): McpToolResponse {
  if ('errors' in data) {
    return {
      content: [{ type: 'text', text: summary ?? 'Account sync error' }],
      structuredContent: toStructuredContent(data),
    };
  }
  if (Array.isArray(data.accounts)) {
    for (let i = 0; i < data.accounts.length; i++) {
      if (!data.accounts[i]?.account_id) {
        throw new Error(
          `syncAccountsResponse: accounts[${i}].account_id is required. ` +
            `Generate a platform-assigned id when the account is first created — don't leave it empty.`
        );
      }
    }
  }
  return {
    content: [
      {
        type: 'text',
        text: summary ?? `Synced ${data.accounts?.length ?? 0} account${data.accounts?.length === 1 ? '' : 's'}`,
      },
    ],
    structuredContent: toStructuredContent(data),
  };
}

/**
 * Build a sync_governance response. The spec permits two top-level shapes
 * (success / error); the type union enforces discrimination on `status`.
 */
export function syncGovernanceResponse(data: SyncGovernanceResponse, summary?: string): McpToolResponse {
  return {
    content: [{ type: 'text', text: summary ?? 'Governance registration synced' }],
    structuredContent: toStructuredContent(data),
  };
}

/**
 * Build a report_usage response. Requires an explicit `accepted` count —
 * defaulting to `0` would silently mis-report a failed ingest as "nothing
 * accepted," which is the opposite of what a forgetful handler needs.
 * Throws at response-construction time with a pointer at the
 * `.acceptAll(request, opts?)` shortcut below.
 *
 * Imported from `'@adcp/client/server'`.
 *
 * @example
 * ```typescript
 * // Explicit count (when the handler rejected some rows):
 * reportUsage: async (params) =>
 *   reportUsageResponse({ accepted: 8, errors: [{ usage_index: 2, message: 'invalid currency' }] })
 *
 * // Ack every usage[] row as accepted (no validation failures):
 * reportUsage: async (params) => reportUsageResponse.acceptAll(params)
 *
 * // Per-row validation — pass the errors you computed, the shortcut
 * // computes `accepted = usage.length - errors.length`:
 * reportUsage: async (params) => {
 *   const errors = validateRows(params.usage);
 *   return reportUsageResponse.acceptAll(params, { errors });
 * }
 * ```
 */
export function reportUsageResponse(data: ReportUsageResponse, summary?: string): McpToolResponse {
  if (typeof data?.accepted !== 'number') {
    throw new Error(
      `reportUsageResponse: data.accepted is required (number). ` +
        `Use reportUsageResponse.acceptAll(request) for the "ack every usage[] row" case, ` +
        `or pass { accepted: <count>, errors?: [...] } explicitly. ` +
        `Imported from '@adcp/client/server'.`
    );
  }
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
