/**
 * Declarative AdCP server builder.
 *
 * `createAdcpServer` wires domain-grouped handler functions to Zod input
 * schemas, response builders, and account resolution.
 * Handlers only run when preconditions pass. `get_adcp_capabilities` is
 * auto-generated from the tools you register.
 *
 * For governance on financial tools (create_media_buy, update_media_buy,
 * activate_signal), use the composable `checkGovernance()` helper inside
 * your handler — see `governance.ts`.
 *
 * @example
 * ```typescript
 * import { createAdcpServer, serve } from '@adcp/client/server';
 *
 * serve(() => createAdcpServer({
 *   name: 'My Publisher',
 *   version: '1.0.0',
 *
 *   // Second argument carries `toolName` and (when `authenticate` is wired
 *   // on `serve()`) the caller's `authInfo`. Adapters that front an
 *   // upstream platform API can use the caller's token here to resolve
 *   // the platform account in one pass.
 *   resolveAccount: async (ref, { authInfo }) => db.findAccount(ref, authInfo),
 *
 *   mediaBuy: {
 *     getProducts: async (params, ctx) => ({ products: catalog.search(params) }),
 *     createMediaBuy: async (params, ctx) => ({
 *       media_buy_id: `mb_${Date.now()}`,
 *       packages: [],
 *     }),
 *   },
 * }));
 * ```
 */

import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ZodRawShapeCompat, AnySchema } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import {
  ADCP_CAPABILITIES,
  ADCP_STATE_STORE,
  wrapMcpServer,
  type AdcpServer,
  type AdcpServerInternal,
} from './adcp-server';
import { createTaskCapableServer } from './tasks';
import type { TaskStore, TaskMessageQueue } from './tasks';
import { adcpError } from './errors';
import { ADCP_ERROR_FIELD_ALLOWLIST } from './envelope-allowlist';
import { InMemoryStateStore } from './state-store';
import type { AdcpStateStore } from './state-store';
import {
  capabilitiesResponse,
  productsResponse,
  mediaBuyResponse,
  deliveryResponse,
  listAccountsResponse,
  listCreativeFormatsResponse,
  updateMediaBuyResponse,
  getMediaBuysResponse,
  performanceFeedbackResponse,
  buildCreativeResponse,
  buildCreativeMultiResponse,
  creativeDeliveryResponse,
  listCreativesResponse,
  syncCreativesResponse,
  getSignalsResponse,
  activateSignalResponse,
  acquireRightsResponse,
  syncAccountsResponse,
  syncGovernanceResponse,
  reportUsageResponse,
  toStructuredContent,
  type McpToolResponse,
} from './responses';

import { TOOL_REQUEST_SCHEMAS } from '../utils/tool-request-schemas';

// NOTE on `outputSchema`: the MCP SDK's client-side `callTool` validates
// `result.structuredContent` against the registered `outputSchema`
// whenever structuredContent is present — regardless of `isError`. See
// `node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js` line
// 504. AdCP's `adcpError()` envelope carries
// `structuredContent: { adcp_error: {...} }` with `isError: true`, which
// would fail every client-side outputSchema check (the error shape
// doesn't match the success schema). Until the SDK gates that client
// check on `!isError` too, we do not declare `outputSchema` on
// framework-registered tools — response drift is caught by the
// dispatcher's AJV validator (#727) instead, and custom tools opt in
// explicitly via `customTools[*].outputSchema`.

function hasIdempotencyClearAll(store: IdempotencyStore): boolean {
  // `clearAll` is optional on `IdempotencyStore` — only present when the
  // configured backend opts in (memory backend does; pg backend does not).
  return typeof store.clearAll === 'function';
}
import { isMutatingTask, IDEMPOTENCY_KEY_PATTERN, MUTATING_TASKS } from '../utils/idempotency';
import { validateRequest, validateResponse, formatIssues } from '../validation/schema-validator';
import { getRawRequestSchema } from '../validation/schema-loader';
import { buildAdcpValidationErrorPayload } from '../validation/schema-errors';
import type { IdempotencyStore } from './idempotency';
import {
  createWebhookEmitter,
  type WebhookEmitParams,
  type WebhookEmitResult,
  type WebhookEmitterOptions,
} from './webhook-emitter';
import { createExpressVerifier, type ExpressLike } from '../signing/middleware';
import {
  isSandboxRequest as isSandboxRequestForSeeding,
  mergeSeededProductsIntoResponse,
  filterValidSeededProducts,
  type TestControllerBridge,
  type TestControllerBridgeContext,
} from './test-controller-bridge';
import type { JwksResolver } from '../signing/jwks';
import type { ReplayStore } from '../signing/replay';
import type { RevocationStore } from '../signing/revocation';
import type { ContentDigestPolicy } from '../signing/types';

// Type-only imports for AdcpToolMap handler signatures (z.input<typeof ...>)
import type {
  GetProductsRequestSchema,
  CreateMediaBuyRequestSchema,
  UpdateMediaBuyRequestSchema,
  GetMediaBuysRequestSchema,
  GetMediaBuyDeliveryRequestSchema,
  ProvidePerformanceFeedbackRequestSchema,
  ListCreativeFormatsRequestSchema,
  BuildCreativeRequestSchema,
  GetCreativeDeliveryRequestSchema,
  ListCreativesRequestSchema,
  SyncCreativesRequestSchema,
  GetSignalsRequestSchema,
  ActivateSignalRequestSchema,
  ListAccountsRequestSchema,
  SyncAccountsRequestSchema,
  SyncGovernanceRequestSchema,
  GetAccountFinancialsRequestSchema,
  ReportUsageRequestSchema,
  SyncEventSourcesRequestSchema,
  LogEventRequestSchema,
  SyncAudiencesRequestSchema,
  SyncCatalogsRequestSchema,
  CreatePropertyListRequestSchema,
  UpdatePropertyListRequestSchema,
  GetPropertyListRequestSchema,
  ListPropertyListsRequestSchema,
  DeletePropertyListRequestSchema,
  ListContentStandardsRequestSchema,
  GetContentStandardsRequestSchema,
  CreateContentStandardsRequestSchema,
  UpdateContentStandardsRequestSchema,
  CalibrateContentRequestSchema,
  ValidateContentDeliveryRequestSchema,
  GetMediaBuyArtifactsRequestSchema,
  GetCreativeFeaturesRequestSchema,
  SyncPlansRequestSchema,
  CheckGovernanceRequestSchema,
  ReportPlanOutcomeRequestSchema,
  GetPlanAuditLogsRequestSchema,
  SIGetOfferingRequestSchema,
  SIInitiateSessionRequestSchema,
  SISendMessageRequestSchema,
  SITerminateSessionRequestSchema,
  PreviewCreativeRequestSchema,
  GetBrandIdentityRequestSchema,
  GetRightsRequestSchema,
  AcquireRightsRequestSchema,
} from '../types/schemas.generated';

import type {
  AcquireRightsAcquired,
  AcquireRightsPendingApproval,
  AcquireRightsRejected,
  GetBrandIdentitySuccess,
  GetRightsSuccess,
} from '../types/core.generated';
import type {
  GetProductsResponse,
  CreateMediaBuySuccess,
  CreateMediaBuyResponse,
  UpdateMediaBuySuccess,
  UpdateMediaBuyResponse,
  GetMediaBuysResponse,
  GetMediaBuyDeliveryResponse,
  ListAccountsResponse,
  ListCreativeFormatsResponse,
  ProvidePerformanceFeedbackSuccess,
  ProvidePerformanceFeedbackResponse,
  BuildCreativeSuccess,
  BuildCreativeMultiSuccess,
  BuildCreativeResponse,
  GetCreativeDeliveryResponse,
  ListCreativesResponse,
  SyncCreativesSuccess,
  SyncCreativesResponse,
  GetSignalsResponse,
  ActivateSignalSuccess,
  ActivateSignalResponse,
  GetAdCPCapabilitiesResponse,
  CreatePropertyListResponse,
  UpdatePropertyListResponse,
  GetPropertyListResponse,
  ListPropertyListsResponse,
  DeletePropertyListResponse,
  SyncPlansResponse,
  CheckGovernanceResponse,
  ReportPlanOutcomeResponse,
  GetPlanAuditLogsResponse,
  SIGetOfferingResponse,
  SIInitiateSessionResponse,
  SISendMessageResponse,
  SITerminateSessionResponse,
  SyncEventSourcesSuccess,
  SyncEventSourcesResponse,
  LogEventSuccess,
  LogEventResponse,
  SyncAudiencesSuccess,
  SyncAudiencesResponse,
  SyncCatalogsSuccess,
  SyncCatalogsResponse,
  SyncAccountsSuccess,
  SyncAccountsResponse,
  SyncGovernanceSuccess,
  SyncGovernanceResponse,
  GetAccountFinancialsSuccess,
  GetAccountFinancialsResponse,
  GetCreativeFeaturesResponse,
  ReportUsageResponse,
  PreviewCreativeResponse,
  AccountReference,
  ListContentStandardsResponse,
  GetContentStandardsResponse,
  CreateContentStandardsResponse,
  UpdateContentStandardsResponse,
  CalibrateContentResponse,
  ValidateContentDeliveryResponse,
  GetMediaBuyArtifactsResponse,
} from '../types/tools.generated';

import type { AdcpProtocol, MediaBuyFeatures, AccountCapabilities, CreativeCapabilities } from '../utils/capabilities';
import type { MediaChannel } from '../types/tools.generated';
import {
  MEDIA_BUY_TOOLS,
  SIGNALS_TOOLS,
  GOVERNANCE_TOOLS,
  CREATIVE_TOOLS,
  SPONSORED_INTELLIGENCE_TOOLS,
  BRAND_RIGHTS_TOOLS,
} from '../utils/capabilities';

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

export interface AdcpLogger {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

const noopLogger: AdcpLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

// ---------------------------------------------------------------------------
// Handler context
// ---------------------------------------------------------------------------

/**
 * Context passed to every handler.
 *
 * If the tool has an account ref and `resolveAccount` is configured,
 * `account` is the resolved account object (guaranteed non-null —
 * the handler only runs if resolution succeeds).
 *
 * If `resolveSessionKey` is configured, `sessionKey` is the scoping key
 * derived from the request — usually tenant/brand/publisher-account id.
 * Handlers can pass it to `scopedStore(ctx.store, ctx.sessionKey!)` to get
 * a session-scoped view that works on any `AdcpStateStore` implementation.
 */
export interface HandlerContext<TAccount = unknown> {
  account?: TAccount;
  /** Session scoping key derived from the request. Populated when `resolveSessionKey` is configured. */
  sessionKey?: string;
  /** State store for persisting domain objects (media buys, accounts, creatives). */
  store: AdcpStateStore;
  /**
   * Authentication info for the caller, when `ServeOptions.authenticate` is configured.
   * Populated from the MCP SDK's `extra.authInfo`, which `serve()` sets from the auth
   * principal. Use this to enforce per-principal authorization in handlers.
   */
  authInfo?: {
    token: string;
    clientId: string;
    scopes: string[];
    expiresAt?: number;
    extra?: Record<string, unknown>;
  };
  /**
   * Emit a signed webhook to a buyer's `push_notification_config.url`.
   * Populated when `AdcpServerConfig.webhooks` is configured. Handles
   * RFC 9421 signing, stable `idempotency_key` across retries, and
   * retry/backoff per adcp#2417 + adcp#2423 + adcp#2478.
   *
   * Typical call from inside a completion handler:
   *
   *     await ctx.emitWebhook({
   *       url: push_notification_config.url,
   *       payload: { task: { task_id, status: 'completed', result } },
   *       operation_id: `create_media_buy.${media_buy_id}`,
   *     });
   */
  emitWebhook?: (params: WebhookEmitParams) => Promise<WebhookEmitResult>;
}

/** Request metadata passed to `resolveSessionKey` so the hook can derive a key from any field. */
export interface SessionKeyContext<TAccount = unknown> {
  toolName: AdcpServerToolName;
  params: Record<string, unknown>;
  account?: TAccount;
}

/**
 * Request context passed to `resolveAccount` so the resolver can inspect the
 * authenticated principal at resolution time. This matters for adapters that
 * front an upstream platform API (Snap, Meta, TikTok, retail media networks)
 * where the upstream account lookup requires the caller's platform OAuth
 * token — forwarding `authInfo` into `resolveAccount` lets the resolver put
 * platform identifiers (ad_account_id, upstream token state) directly on the
 * resolved `TAccount` rather than re-resolving inside every handler.
 */
export interface ResolveAccountContext {
  /** The AdCP tool being called. */
  toolName: AdcpServerToolName;
  /**
   * Authentication info for the caller, populated from `extra.authInfo` on the
   * MCP request. Undefined when no `authenticate` is configured on `serve()`.
   */
  authInfo?: HandlerContext['authInfo'];
}

/**
 * Narrow `ctx.sessionKey` from `string | undefined` to `string`. Use this in
 * handlers that require session scoping so you don't litter `!` assertions:
 *
 * ```ts
 * const sessionKey = requireSessionKey(ctx);
 * const sessionStore = scopedStore(ctx.store, sessionKey);
 * ```
 *
 * Throws a `SERVICE_UNAVAILABLE`-style error if `sessionKey` is missing — typically
 * meaning `resolveSessionKey` isn't configured or returned `undefined` for this tool.
 */
export function requireSessionKey<TAccount = unknown>(ctx: HandlerContext<TAccount>): string {
  if (ctx.sessionKey == null) {
    throw new Error(
      'ctx.sessionKey is undefined. Configure resolveSessionKey on createAdcpServer, or guard per-tool before calling requireSessionKey.'
    );
  }
  return ctx.sessionKey;
}

// ---------------------------------------------------------------------------
// Tool → type mapping (kept from v1 for type-level handler signatures)
// ---------------------------------------------------------------------------

/**
 * Per-tool param / result / response types.
 *
 * `result` is the narrow success arm — what the framework's response
 * builders (`mediaBuyResponse`, `syncCreativesResponse`, ...) expect.
 * `response` is the full AdCP response union (Success | Error | Submitted).
 * Handlers can return either shape: adapter patterns that produce
 * `Result<FooResponse, ...>` now type-check without `as any`, and the
 * dispatcher narrows Error / Submitted arms at runtime so the response
 * builder only fires on the Success arm.
 */
export interface AdcpToolMap {
  get_products: {
    params: z.input<typeof GetProductsRequestSchema>;
    result: GetProductsResponse;
    response: GetProductsResponse;
  };
  create_media_buy: {
    params: z.input<typeof CreateMediaBuyRequestSchema>;
    result: CreateMediaBuySuccess;
    response: CreateMediaBuyResponse;
  };
  update_media_buy: {
    params: z.input<typeof UpdateMediaBuyRequestSchema>;
    result: UpdateMediaBuySuccess;
    response: UpdateMediaBuyResponse;
  };
  get_media_buys: {
    params: z.input<typeof GetMediaBuysRequestSchema>;
    result: GetMediaBuysResponse;
    response: GetMediaBuysResponse;
  };
  get_media_buy_delivery: {
    params: z.input<typeof GetMediaBuyDeliveryRequestSchema>;
    result: GetMediaBuyDeliveryResponse;
    response: GetMediaBuyDeliveryResponse;
  };
  provide_performance_feedback: {
    params: z.input<typeof ProvidePerformanceFeedbackRequestSchema>;
    result: ProvidePerformanceFeedbackSuccess;
    response: ProvidePerformanceFeedbackResponse;
  };
  list_creative_formats: {
    params: z.input<typeof ListCreativeFormatsRequestSchema>;
    result: ListCreativeFormatsResponse;
    response: ListCreativeFormatsResponse;
  };
  build_creative: {
    params: z.input<typeof BuildCreativeRequestSchema>;
    result: BuildCreativeSuccess | BuildCreativeMultiSuccess;
    response: BuildCreativeResponse;
  };
  preview_creative: {
    params: z.input<typeof PreviewCreativeRequestSchema>;
    result: PreviewCreativeResponse;
    response: PreviewCreativeResponse;
  };
  get_creative_delivery: {
    params: z.input<typeof GetCreativeDeliveryRequestSchema>;
    result: GetCreativeDeliveryResponse;
    response: GetCreativeDeliveryResponse;
  };
  list_creatives: {
    params: z.input<typeof ListCreativesRequestSchema>;
    result: ListCreativesResponse;
    response: ListCreativesResponse;
  };
  sync_creatives: {
    params: z.input<typeof SyncCreativesRequestSchema>;
    result: SyncCreativesSuccess;
    response: SyncCreativesResponse;
  };
  get_signals: {
    params: z.input<typeof GetSignalsRequestSchema>;
    result: GetSignalsResponse;
    response: GetSignalsResponse;
  };
  activate_signal: {
    params: z.input<typeof ActivateSignalRequestSchema>;
    result: ActivateSignalSuccess;
    response: ActivateSignalResponse;
  };
  list_accounts: {
    params: z.input<typeof ListAccountsRequestSchema>;
    result: ListAccountsResponse;
    response: ListAccountsResponse;
  };
  sync_accounts: {
    params: z.input<typeof SyncAccountsRequestSchema>;
    result: SyncAccountsSuccess;
    response: SyncAccountsResponse;
  };
  sync_governance: {
    params: z.input<typeof SyncGovernanceRequestSchema>;
    result: SyncGovernanceSuccess;
    response: SyncGovernanceResponse;
  };
  get_account_financials: {
    params: z.input<typeof GetAccountFinancialsRequestSchema>;
    result: GetAccountFinancialsSuccess;
    response: GetAccountFinancialsResponse;
  };
  report_usage: {
    params: z.input<typeof ReportUsageRequestSchema>;
    result: ReportUsageResponse;
    response: ReportUsageResponse;
  };
  sync_event_sources: {
    params: z.input<typeof SyncEventSourcesRequestSchema>;
    result: SyncEventSourcesSuccess;
    response: SyncEventSourcesResponse;
  };
  log_event: {
    params: z.input<typeof LogEventRequestSchema>;
    result: LogEventSuccess;
    response: LogEventResponse;
  };
  sync_audiences: {
    params: z.input<typeof SyncAudiencesRequestSchema>;
    result: SyncAudiencesSuccess;
    response: SyncAudiencesResponse;
  };
  sync_catalogs: {
    params: z.input<typeof SyncCatalogsRequestSchema>;
    result: SyncCatalogsSuccess;
    response: SyncCatalogsResponse;
  };
  create_property_list: {
    params: z.input<typeof CreatePropertyListRequestSchema>;
    result: CreatePropertyListResponse;
    response: CreatePropertyListResponse;
  };
  update_property_list: {
    params: z.input<typeof UpdatePropertyListRequestSchema>;
    result: UpdatePropertyListResponse;
    response: UpdatePropertyListResponse;
  };
  get_property_list: {
    params: z.input<typeof GetPropertyListRequestSchema>;
    result: GetPropertyListResponse;
    response: GetPropertyListResponse;
  };
  list_property_lists: {
    params: z.input<typeof ListPropertyListsRequestSchema>;
    result: ListPropertyListsResponse;
    response: ListPropertyListsResponse;
  };
  delete_property_list: {
    params: z.input<typeof DeletePropertyListRequestSchema>;
    result: DeletePropertyListResponse;
    response: DeletePropertyListResponse;
  };
  list_content_standards: {
    params: z.input<typeof ListContentStandardsRequestSchema>;
    result: ListContentStandardsResponse;
    response: ListContentStandardsResponse;
  };
  get_content_standards: {
    params: z.input<typeof GetContentStandardsRequestSchema>;
    result: GetContentStandardsResponse;
    response: GetContentStandardsResponse;
  };
  create_content_standards: {
    params: z.input<typeof CreateContentStandardsRequestSchema>;
    result: CreateContentStandardsResponse;
    response: CreateContentStandardsResponse;
  };
  update_content_standards: {
    params: z.input<typeof UpdateContentStandardsRequestSchema>;
    result: UpdateContentStandardsResponse;
    response: UpdateContentStandardsResponse;
  };
  calibrate_content: {
    params: z.input<typeof CalibrateContentRequestSchema>;
    result: CalibrateContentResponse;
    response: CalibrateContentResponse;
  };
  validate_content_delivery: {
    params: z.input<typeof ValidateContentDeliveryRequestSchema>;
    result: ValidateContentDeliveryResponse;
    response: ValidateContentDeliveryResponse;
  };
  get_media_buy_artifacts: {
    params: z.input<typeof GetMediaBuyArtifactsRequestSchema>;
    result: GetMediaBuyArtifactsResponse;
    response: GetMediaBuyArtifactsResponse;
  };
  get_creative_features: {
    params: z.input<typeof GetCreativeFeaturesRequestSchema>;
    result: GetCreativeFeaturesResponse;
    response: GetCreativeFeaturesResponse;
  };
  sync_plans: {
    params: z.input<typeof SyncPlansRequestSchema>;
    result: SyncPlansResponse;
    response: SyncPlansResponse;
  };
  check_governance: {
    params: z.input<typeof CheckGovernanceRequestSchema>;
    result: CheckGovernanceResponse;
    response: CheckGovernanceResponse;
  };
  report_plan_outcome: {
    params: z.input<typeof ReportPlanOutcomeRequestSchema>;
    result: ReportPlanOutcomeResponse;
    response: ReportPlanOutcomeResponse;
  };
  get_plan_audit_logs: {
    params: z.input<typeof GetPlanAuditLogsRequestSchema>;
    result: GetPlanAuditLogsResponse;
    response: GetPlanAuditLogsResponse;
  };
  si_get_offering: {
    params: z.input<typeof SIGetOfferingRequestSchema>;
    result: SIGetOfferingResponse;
    response: SIGetOfferingResponse;
  };
  si_initiate_session: {
    params: z.input<typeof SIInitiateSessionRequestSchema>;
    result: SIInitiateSessionResponse;
    response: SIInitiateSessionResponse;
  };
  si_send_message: {
    params: z.input<typeof SISendMessageRequestSchema>;
    result: SISendMessageResponse;
    response: SISendMessageResponse;
  };
  si_terminate_session: {
    params: z.input<typeof SITerminateSessionRequestSchema>;
    result: SITerminateSessionResponse;
    response: SITerminateSessionResponse;
  };

  get_brand_identity: {
    params: z.input<typeof GetBrandIdentityRequestSchema>;
    result: GetBrandIdentitySuccess;
    response: GetBrandIdentitySuccess;
  };
  get_rights: {
    params: z.input<typeof GetRightsRequestSchema>;
    result: GetRightsSuccess;
    response: GetRightsSuccess;
  };
  acquire_rights: {
    params: z.input<typeof AcquireRightsRequestSchema>;
    result: AcquireRightsAcquired | AcquireRightsPendingApproval | AcquireRightsRejected;
    response: AcquireRightsAcquired | AcquireRightsPendingApproval | AcquireRightsRejected;
  };
}

export type AdcpServerToolName = keyof AdcpToolMap;

// ---------------------------------------------------------------------------
// Domain handler types
// ---------------------------------------------------------------------------

/** Handler that receives validated params and a resolved context.
 *
 *  Return any of:
 *  - The narrow Success arm (`result`) — framework applies the response builder.
 *  - The full response union (`response` = Success | Error | Submitted) — the
 *    dispatcher narrows Error / Submitted arms at runtime. Useful for adapters
 *    that already produce a `Result<FooResponse, ...>` and don't want to
 *    pre-narrow.
 *  - A pre-formatted `McpToolResponse` (e.g. from `adcpError(...)`) — passed
 *    through unchanged.
 */
type DomainHandler<K extends AdcpServerToolName, TAccount> = (
  params: AdcpToolMap[K]['params'],
  ctx: HandlerContext<TAccount>
) => Promise<AdcpToolMap[K]['result'] | AdcpToolMap[K]['response'] | McpToolResponse>;

export interface MediaBuyHandlers<TAccount = unknown> {
  getProducts?: DomainHandler<'get_products', TAccount>;
  createMediaBuy?: DomainHandler<'create_media_buy', TAccount>;
  updateMediaBuy?: DomainHandler<'update_media_buy', TAccount>;
  getMediaBuys?: DomainHandler<'get_media_buys', TAccount>;
  getMediaBuyDelivery?: DomainHandler<'get_media_buy_delivery', TAccount>;
  providePerformanceFeedback?: DomainHandler<'provide_performance_feedback', TAccount>;
  listCreativeFormats?: DomainHandler<'list_creative_formats', TAccount>;
  syncCreatives?: DomainHandler<'sync_creatives', TAccount>;
  listCreatives?: DomainHandler<'list_creatives', TAccount>;
}

export interface EventTrackingHandlers<TAccount = unknown> {
  syncEventSources?: DomainHandler<'sync_event_sources', TAccount>;
  logEvent?: DomainHandler<'log_event', TAccount>;
  syncAudiences?: DomainHandler<'sync_audiences', TAccount>;
  syncCatalogs?: DomainHandler<'sync_catalogs', TAccount>;
}

export interface SignalsHandlers<TAccount = unknown> {
  getSignals?: DomainHandler<'get_signals', TAccount>;
  activateSignal?: DomainHandler<'activate_signal', TAccount>;
}

export interface CreativeHandlers<TAccount = unknown> {
  listCreativeFormats?: DomainHandler<'list_creative_formats', TAccount>;
  buildCreative?: DomainHandler<'build_creative', TAccount>;
  previewCreative?: DomainHandler<'preview_creative', TAccount>;
  listCreatives?: DomainHandler<'list_creatives', TAccount>;
  syncCreatives?: DomainHandler<'sync_creatives', TAccount>;
  getCreativeDelivery?: DomainHandler<'get_creative_delivery', TAccount>;
}

export interface GovernanceHandlers<TAccount = unknown> {
  createPropertyList?: DomainHandler<'create_property_list', TAccount>;
  updatePropertyList?: DomainHandler<'update_property_list', TAccount>;
  getPropertyList?: DomainHandler<'get_property_list', TAccount>;
  listPropertyLists?: DomainHandler<'list_property_lists', TAccount>;
  deletePropertyList?: DomainHandler<'delete_property_list', TAccount>;
  listContentStandards?: DomainHandler<'list_content_standards', TAccount>;
  getContentStandards?: DomainHandler<'get_content_standards', TAccount>;
  createContentStandards?: DomainHandler<'create_content_standards', TAccount>;
  updateContentStandards?: DomainHandler<'update_content_standards', TAccount>;
  calibrateContent?: DomainHandler<'calibrate_content', TAccount>;
  validateContentDelivery?: DomainHandler<'validate_content_delivery', TAccount>;
  getMediaBuyArtifacts?: DomainHandler<'get_media_buy_artifacts', TAccount>;
  getCreativeFeatures?: DomainHandler<'get_creative_features', TAccount>;
  syncPlans?: DomainHandler<'sync_plans', TAccount>;
  checkGovernance?: DomainHandler<'check_governance', TAccount>;
  reportPlanOutcome?: DomainHandler<'report_plan_outcome', TAccount>;
  getPlanAuditLogs?: DomainHandler<'get_plan_audit_logs', TAccount>;
}

export interface AccountHandlers<TAccount = unknown> {
  listAccounts?: DomainHandler<'list_accounts', TAccount>;
  syncAccounts?: DomainHandler<'sync_accounts', TAccount>;
  syncGovernance?: DomainHandler<'sync_governance', TAccount>;
  getAccountFinancials?: DomainHandler<'get_account_financials', TAccount>;
  reportUsage?: DomainHandler<'report_usage', TAccount>;
}

export interface SponsoredIntelligenceHandlers<TAccount = unknown> {
  getOffering?: DomainHandler<'si_get_offering', TAccount>;
  initiateSession?: DomainHandler<'si_initiate_session', TAccount>;
  sendMessage?: DomainHandler<'si_send_message', TAccount>;
  terminateSession?: DomainHandler<'si_terminate_session', TAccount>;
}

/**
 * Brand rights covers identity and licensing workflows. `update_rights` and
 * `creative_approval` are intentionally not exposed here — the spec models
 * creative approval as a webhook (POST to `approval_webhook` returned from
 * `acquire_rights`), and neither has published JSON schemas yet. Implement
 * those as regular HTTP endpoints outside the MCP surface until schemas land.
 */
export interface BrandRightsHandlers<TAccount = unknown> {
  getBrandIdentity?: DomainHandler<'get_brand_identity', TAccount>;
  getRights?: DomainHandler<'get_rights', TAccount>;
  acquireRights?: DomainHandler<'acquire_rights', TAccount>;
}

// ---------------------------------------------------------------------------
// Capabilities config
// ---------------------------------------------------------------------------

export interface AdcpCapabilitiesConfig {
  major_versions?: number[];
  features?: Partial<MediaBuyFeatures>;
  account?: Partial<AccountCapabilities>;
  creative?: Partial<CreativeCapabilities>;
  extensions_supported?: string[];
  /**
   * RFC 9421 request-signing verifier capability. See
   * docs/building/implementation/security.mdx#signed-requests-transport-layer.
   * Emitted verbatim in `get_adcp_capabilities.request_signing`. Omit unless
   * the agent actually verifies incoming signatures — a `supported: true`
   * claim without a working verifier is graded as FAIL by the conformance
   * runner (see `@adcp/client/testing/storyboard/request-signing`).
   */
  request_signing?: NonNullable<GetAdCPCapabilitiesResponse['request_signing']>;
  /**
   * Specialism claims the agent supports. Each entry maps to a storyboard
   * bundle under `/compliance/{version}/specialisms/{id}/`; the AAO
   * compliance runner executes the matching storyboards to verify. Only
   * list specialisms the agent actually implements.
   */
  specialisms?: NonNullable<GetAdCPCapabilitiesResponse['specialisms']>;
  /**
   * Seller-declared idempotency replay window, required on `get_adcp_capabilities`
   * responses per AdCP spec. Defaults to 86400 (24h). Spec bounds are 3600
   * (1h) to 604800 (7d); `clampReplayTtl` enforces the range on output.
   *
   * When using `createIdempotencyStore` from `@adcp/client/server`, omit
   * this — the framework reads `idempotency.ttlSeconds` from the wired
   * store so the declared capability always matches actual behavior.
   */
  idempotency?: {
    replay_ttl_seconds?: number;
  };
  portfolio?: {
    publisher_domains: string[];
    primary_channels?: MediaChannel[];
    primary_countries?: string[];
    description?: string;
    advertising_policies?: string;
  };
  /**
   * Per-domain capability blocks deep-merged on top of the framework's
   * auto-derived response. Use when you need to surface fields the top-level
   * `AdcpCapabilitiesConfig` doesn't model — execution.targeting,
   * audience_targeting, content_standards channels, conversion_tracking
   * identifier types, compliance_testing scenarios, etc.
   *
   * Deep-merge semantics:
   * - nested objects merge recursively;
   * - arrays REPLACE (not concat) so callers stay in control of cardinality;
   * - primitive overrides replace the auto-derived value.
   *
   * Top-level fields the framework owns (`adcp`, `supported_protocols`,
   * `specialisms`, `extensions_supported`) are not accepted here — configure
   * them via their dedicated fields on {@link AdcpCapabilitiesConfig}.
   */
  overrides?: AdcpCapabilitiesOverrides;
}

/**
 * Per-domain capability overrides. See {@link AdcpCapabilitiesConfig.overrides}.
 *
 * Each field accepts the same shape as the corresponding block on
 * {@link GetAdCPCapabilitiesResponse}. A value of `null` explicitly removes
 * the auto-derived block; `undefined` (omission) is a no-op.
 *
 * **Values must be JSON-serializable plain objects.** Class instances, `Date`,
 * `Map`, `Set`, or any value with a non-`Object.prototype` prototype are
 * treated as opaque leaves and replace their target rather than merging.
 */
export interface AdcpCapabilitiesOverrides {
  media_buy?: Partial<NonNullable<GetAdCPCapabilitiesResponse['media_buy']>> | null;
  creative?: Partial<NonNullable<GetAdCPCapabilitiesResponse['creative']>> | null;
  signals?: Partial<NonNullable<GetAdCPCapabilitiesResponse['signals']>> | null;
  governance?: Partial<NonNullable<GetAdCPCapabilitiesResponse['governance']>> | null;
  brand?: Partial<NonNullable<GetAdCPCapabilitiesResponse['brand']>> | null;
  sponsored_intelligence?: Partial<NonNullable<GetAdCPCapabilitiesResponse['sponsored_intelligence']>> | null;
  account?: Partial<NonNullable<GetAdCPCapabilitiesResponse['account']>> | null;
  compliance_testing?: GetAdCPCapabilitiesResponse['compliance_testing'] | null;
  webhook_signing?: GetAdCPCapabilitiesResponse['webhook_signing'] | null;
  identity?: GetAdCPCapabilitiesResponse['identity'] | null;
  request_signing?: GetAdCPCapabilitiesResponse['request_signing'] | null;
}

// ---------------------------------------------------------------------------
// Signed-requests auto-wiring
// ---------------------------------------------------------------------------

/**
 * Inputs for the auto-wired RFC 9421 request-signature verifier. When set on
 * {@link AdcpServerConfig}, `createAdcpServer` builds an Express-shaped
 * verifier middleware and attaches it to the returned `McpServer` via
 * {@link ADCP_PRE_TRANSPORT}. `serve()` discovers the attached middleware and
 * mounts it as the transport-layer `preTransport` hook, so every inbound MCP
 * request passes the verifier before reaching the JSON-RPC router.
 *
 * A seller that declares the `signed-requests` specialism in
 * `capabilities.specialisms` MUST provide this config, and vice-versa — both
 * together or neither. `createAdcpServer` throws at construction time when
 * only one is set, closing the footgun where claiming the specialism
 * accepts unsigned mutating traffic.
 *
 * `jwks`, `replayStore`, and `revocationStore` should be hoisted outside
 * the agent factory so a single verifier instance serves every request —
 * otherwise each request would build a fresh replay store and the rate-
 * abuse / replay-detection guards would be per-request (i.e. broken).
 */
export interface SignedRequestsConfig {
  /** Resolves verification keys by `keyid`. */
  jwks: JwksResolver;
  /** Stores `(keyid, signature-bytes, expires)` tuples for replay detection. */
  replayStore: ReplayStore;
  /** Consulted for revoked `kid` / `jti` before accepting a signature. */
  revocationStore: RevocationStore;
  /**
   * Operation names that MUST arrive signed. Defaults to every mutating
   * AdCP tool (per the framework's {@link MUTATING_TASKS}). Read-only tools
   * are optional — callers can sign them for authenticity but the verifier
   * accepts unsigned traffic outside this list.
   */
  required_for?: string[];
  /** Default `'either'` — accept signatures with or without Content-Digest. */
  covers_content_digest?: ContentDigestPolicy;
  /**
   * Resolve the `agent_url` claim the verifier stamps on successful results.
   * Useful when a single seller hosts multiple brands and the buyer's
   * signing key is scoped to a brand identifier rather than the root.
   */
  agentUrlForKeyid?: (keyid: string) => string | undefined;
}

/**
 * Symbol under which `createAdcpServer` attaches the auto-wired `preTransport`
 * function to the returned `McpServer`. `serve()` reads this symbol to mount
 * the verifier. Consumers typically don't need to touch it; it's exported for
 * tests and for downstream frameworks that want the same wiring.
 */
export const ADCP_PRE_TRANSPORT: unique symbol = Symbol.for('@adcp/client.preTransport');

/**
 * Diagnostic snapshot of the signed-requests wiring on a returned server.
 * Read via `server[ADCP_SIGNED_REQUESTS_STATE]` so integration tests and
 * operator boot diagnostics can assert on the claim/config pairing without
 * parsing log output. Populated on every `createAdcpServer` call.
 */
export interface AdcpSignedRequestsState {
  /** True when `signedRequests: {...}` was passed and the verifier is auto-wired. */
  autoWired: boolean;
  /** True when `capabilities.specialisms` includes `'signed-requests'`. */
  specialismClaimed: boolean;
  /** True when `capabilities.request_signing.supported === true`. */
  capabilitySupported: boolean;
  /**
   * Non-fatal mismatch state. `'ok'` when wiring + claim + supported are
   * all aligned (or all off); `'claim_without_config'` when the claim is
   * set but no `signedRequests` config was passed (legacy manual
   * `serve({ preTransport })` path — logged but not thrown).
   */
  mismatch: 'ok' | 'claim_without_config';
}

/**
 * Symbol under which `createAdcpServer` attaches the `AdcpSignedRequestsState`
 * snapshot. Use `server[ADCP_SIGNED_REQUESTS_STATE]` to inspect wiring from
 * tests or boot diagnostics.
 */
export const ADCP_SIGNED_REQUESTS_STATE: unique symbol = Symbol.for('@adcp/client.signedRequestsState');

/**
 * Shape of the preTransport function attached by `createAdcpServer` when
 * `signedRequests` is configured. Returns `true` if the middleware has already
 * sent a response (e.g., 401 on verification failure), `false` to continue
 * into MCP dispatch.
 */
export type AdcpPreTransport = (
  req: import('http').IncomingMessage & { rawBody?: string },
  res: import('http').ServerResponse
) => Promise<boolean>;

// ---------------------------------------------------------------------------
// Custom tool config
// ---------------------------------------------------------------------------

/**
 * Declarative registration for a tool outside {@link AdcpToolMap} — seller
 * extensions (e.g. collection-list helpers), test-harness endpoints
 * (`comply_test_controller`), or AdCP surfaces whose JSON Schemas haven't
 * landed in the framework yet (`creative_approval`, `update_rights`).
 *
 * These tools **bypass the framework's spec-tool pipeline**:
 * idempotency middleware, governance pre-checks, account resolution,
 * and response wrapping are all skipped. The handler receives the
 * SDK-validated arguments and must return a `CallToolResult` directly.
 * If you need any of those behaviors, call the framework helpers from
 * inside the handler (e.g., `checkGovernance(...)`, `adcpError(...)`).
 *
 * Type parameters match the SDK's `McpServer.registerTool` signature so
 * argument and response types infer from the declared schemas.
 */
export interface AdcpCustomToolConfig<
  InputArgs extends undefined | ZodRawShapeCompat | AnySchema = undefined,
  OutputArgs extends ZodRawShapeCompat | AnySchema | undefined = undefined,
> {
  /** Human-readable description — surfaced in `tools/list`. */
  description?: string;
  /** Optional title hint for the MCP inspector. */
  title?: string;
  /** Zod raw shape or schema for argument validation. */
  inputSchema?: InputArgs;
  /**
   * Zod raw shape or schema for the declared response payload.
   *
   * Forwarded verbatim to `registerTool`. The MCP SDK validates every
   * non-error response's `structuredContent` against this schema on the
   * server AND on the buyer's client (the latter fires regardless of
   * `isError` — see the `NOTE on outputSchema` block earlier in this
   * file). Framework-registered AdCP tools skip this field for that
   * reason; custom tools opt in here and own the trade-off.
   *
   * Footgun: a too-strict schema (e.g. `z.never()`, or one that
   * accidentally rejects the caller's own valid shape) turns the tool
   * into a silent client-side validation error for every buyer. The
   * seller sees a successful response go out; the buyer receives an
   * `Output validation error`. Test against a real buyer call before
   * relying on this.
   */
  outputSchema?: OutputArgs;
  /** Tool annotations (readOnlyHint / destructiveHint / idempotentHint / openWorldHint). */
  annotations?: ToolAnnotations;
  /**
   * Tool handler. Gets SDK-validated `args` based on `inputSchema` and
   * must return a `CallToolResult`. Use `capabilitiesResponse`,
   * `mediaBuyResponse`, `adcpError`, or a hand-built `{ content, structuredContent? }`.
   */
  handler: ToolCallback<InputArgs>;
}

// ---------------------------------------------------------------------------
// Server config
// ---------------------------------------------------------------------------

export interface AdcpServerConfig<TAccount = unknown> {
  name: string;
  version: string;

  /**
   * Resolve an account from an AccountReference.
   * Called on every request that has an `account` field.
   * Return null if the account doesn't exist — framework responds ACCOUNT_NOT_FOUND.
   *
   * The second argument carries the AdCP `toolName` and, when `serve()` is
   * configured with `authenticate`, the caller's `authInfo`. Adapters that
   * need the caller's upstream platform token to look up the account can
   * read it from `ctx.authInfo` here and attach anything they want to the
   * resolved account.
   *
   * Single-argument resolvers (`async (ref) => ...`) are valid — TypeScript
   * allows a shorter parameter list.
   *
   * **Do not persist `authInfo` outside the returned account object.** The
   * framework makes no isolation guarantees about values closed over by the
   * resolver; caching `authInfo` into shared state can leak the caller's
   * principal across requests.
   */
  resolveAccount?: (ref: AccountReference, ctx: ResolveAccountContext) => Promise<TAccount | null>;

  /**
   * Derive a session-scoping key from the request. Populates `ctx.sessionKey`
   * so handlers don't re-implement key derivation (tenant, brand, publisher
   * account id, etc.). Called after `resolveAccount`, so the resolved account
   * is available.
   *
   * Return `undefined` to leave `ctx.sessionKey` unset (e.g., for anonymous
   * or public tools).
   */
  resolveSessionKey?: (ctx: SessionKeyContext<TAccount>) => string | undefined | Promise<string | undefined>;

  /**
   * When `true`, framework-produced `SERVICE_UNAVAILABLE` errors include the
   * underlying `err.message` in `details.reason` (helpful in dev, but can leak
   * DB driver messages, file paths, or schema info to remote callers).
   *
   * Defaults:
   *   - `NODE_ENV === 'production'` → `false` (safe default for live agents).
   *   - Otherwise → `true` (dev/test/CI surface the cause chain so
   *     `SERVICE_UNAVAILABLE: encountered an internal error` becomes
   *     `SERVICE_UNAVAILABLE: Cannot find module '@adcp/client/foo'`.
   *     Matrix runs spent weeks on opaque SU errors before this default flipped).
   *
   * Explicit `exposeErrorDetails: true | false` always wins.
   */
  exposeErrorDetails?: boolean;

  /** Logger for framework decisions. Defaults to no-op. */
  logger?: AdcpLogger;

  /**
   * State store for persisting domain objects across requests.
   * Defaults to InMemoryStateStore. Use PostgresStateStore for production.
   */
  stateStore?: AdcpStateStore;

  // Domain handler groups — register only what you support
  mediaBuy?: MediaBuyHandlers<TAccount>;
  signals?: SignalsHandlers<TAccount>;
  creative?: CreativeHandlers<TAccount>;
  governance?: GovernanceHandlers<TAccount>;
  accounts?: AccountHandlers<TAccount>;
  eventTracking?: EventTrackingHandlers<TAccount>;
  sponsoredIntelligence?: SponsoredIntelligenceHandlers<TAccount>;
  brandRights?: BrandRightsHandlers<TAccount>;

  /** Explicit capabilities overrides (merged on top of auto-detected). */
  capabilities?: AdcpCapabilitiesConfig;
  /**
   * Idempotency store for mutating requests. When configured, the framework:
   *
   * - Requires `idempotency_key` on every mutating request (returns
   *   `INVALID_REQUEST` when missing)
   * - Replays the cached response for matching `(principal, key, payload)`
   *   and injects `replayed: true` on the envelope
   * - Returns `IDEMPOTENCY_CONFLICT` for same-key-different-payload
   * - Returns `IDEMPOTENCY_EXPIRED` when the key is past the TTL
   * - Declares `adcp.idempotency.replay_ttl_seconds` on `get_adcp_capabilities`
   *
   * Scoping: by default uses `ctx.sessionKey` as the principal. Override
   * via `resolveIdempotencyPrincipal`.
   *
   * Pass the literal string `'disabled'` to suppress idempotency
   * enforcement end-to-end: schema validation tolerates a missing
   * `idempotency_key` on mutating tools, the replay/conflict middleware
   * is skipped, and the missing-store guardrail log is silenced. Intended
   * for non-production test fleets that don't model idempotency replay
   * — production servers should always wire a real store. The framework
   * logs an info-level warning at construction when this mode is used
   * outside `NODE_ENV=test` so the choice is visible.
   */
  idempotency?: IdempotencyStore | 'disabled';
  /**
   * Derive the idempotency principal from the handler context, the
   * request params, and the tool name. Defaults to `ctx.sessionKey`. Two
   * buyers that share a sessionKey would share cache entries — if that's
   * not what you want, return something more specific (e.g., an
   * operator_id) from this hook.
   *
   * Receives `params` and `toolName` so callers can fold request-shape
   * identity into the principal when needed (e.g., scoping by a custom
   * tenant header). For per-session scoping (`si_send_message`), the
   * framework already folds `params.session_id` into the scope tuple —
   * the principal is still the authenticated buyer.
   */
  resolveIdempotencyPrincipal?: (
    ctx: HandlerContext<TAccount>,
    params: Record<string, unknown>,
    toolName: AdcpServerToolName
  ) => string | undefined;
  instructions?: string;
  taskStore?: TaskStore;
  taskMessageQueue?: TaskMessageQueue;
  /**
   * Webhook-emission config. When set, `ctx.emitWebhook` is populated on
   * every handler's context — handlers post signed, retried,
   * idempotency-stable webhooks without hand-rolling the pipeline. Omit
   * if your server never emits webhooks.
   *
   * The `signerKey` MUST have `adcp_use: "webhook-signing"` — a
   * request-signing key is a conformance violation per adcp#2423 (key
   * purpose discriminator). Publishers publishing their JWKS at the
   * `jwks_uri` on brand.json's `agents[]` entry reuse the same key across
   * every buyer they deliver to.
   */
  webhooks?: Pick<
    WebhookEmitterOptions,
    'signerKey' | 'retries' | 'idempotencyKeyStore' | 'generateIdempotencyKey' | 'fetch' | 'userAgent' | 'tag'
  > & {
    /** Observability: emitter-wide onAttempt hook. */
    onAttempt?: WebhookEmitterOptions['onAttempt'];
    /** Observability: emitter-wide onAttemptResult hook. */
    onAttemptResult?: WebhookEmitterOptions['onAttemptResult'];
  };
  /**
   * Auto-wire the RFC 9421 request-signature verifier onto the HTTP transport.
   * When set together with `capabilities.specialisms` containing
   * `signed-requests`, `serve()` mounts the verifier as `preTransport` so
   * every inbound MCP request is verified before JSON-RPC dispatch. Setting
   * one without the other throws at construction time — the spec requires
   * the specialism claim and a working verifier to stay in lock-step.
   *
   * Omit entirely when the seller doesn't verify inbound signatures. Servers
   * that wire the verifier manually via `serve({ preTransport })` are
   * unaffected — auto-wiring only kicks in through this field.
   */
  signedRequests?: SignedRequestsConfig;

  /**
   * Schema-driven validation of requests and responses against the bundled
   * AdCP JSON schemas. When enabled, the dispatcher rejects bad requests
   * with `VALIDATION_ERROR` before the handler runs and catches drift in
   * handler-returned responses before they leave the server.
   *
   * Defaults:
   *   - When `NODE_ENV === 'production'` → both sides `'off'` (zero overhead
   *     in prod; trust the handler after its test suite has exercised it).
   *   - Otherwise (dev, test, CI) → `responses: 'strict'`, `requests: 'warn'`.
   *     Strict on responses turns handler-returned drift into a
   *     `VALIDATION_ERROR` with the offending field path — surfaces the
   *     "handler returned a sparse object that fails the wire schema" class
   *     of bug at development time instead of letting it ship and surface
   *     downstream as a cryptic `SERVICE_UNAVAILABLE` or `oneOf`
   *     discriminator failure. Warn on requests logs incoming payloads that
   *     don't match the bundled AdCP schema but still dispatches, so
   *     upstream schema tightenings show up as diagnostics without breaking
   *     clients that haven't caught up.
   *
   * Pass an explicit `validation: { requests: 'off', responses: 'off' }` to
   * override the dev-mode default. Set `responses: 'warn'` to keep the
   * logger diagnostic without failing the request — useful while
   * migrating a handler set from sparse fixtures to spec-compliant
   * responses. (The logger warning fires in both `'warn'` and `'strict'`
   * modes; `'strict'` additionally promotes the failure to a
   * `VALIDATION_ERROR` envelope.)
   *
   * Per-side modes:
   *   - `requests: 'strict'` — reject malformed requests with VALIDATION_ERROR.
   *     `'warn'` — log a warning, allow the handler to run.
   *     `'off'` — skip.
   *   - `responses: 'strict'` — handler-returned drift throws (dev/test canary).
   *     `'warn'` — log a warning, return the response unchanged.
   *     `'off'` — skip.
   *
   * Cost: one AJV compile per tool on cold start, one validator invocation
   * per call. The dev-mode default trades that for field-level diagnostics
   * when handlers drift from the wire contract.
   */
  validation?: {
    requests?: import('../validation/client-hooks').ValidationMode;
    responses?: import('../validation/client-hooks').ValidationMode;
  };

  /**
   * Register tools outside {@link AdcpToolMap}. Keys are the public tool
   * names; values follow {@link AdcpCustomToolConfig}.
   *
   * Gives sellers a declarative extension point without reaching for the
   * `getSdkServer()` escape hatch. Typical callers:
   *
   *   - AdCP surfaces whose JSON Schemas haven't landed yet
   *     (`creative_approval`, `update_rights`).
   *   - Governance specialism helpers (`*_collection_list` family).
   *   - Test-harness tools (`comply_test_controller` — prefer
   *     {@link registerTestController} which wraps this).
   *   - Seller-specific extensions outside the AdCP spec.
   *
   * **Custom tools bypass the framework's spec-tool pipeline.** No
   * idempotency middleware, no governance pre-check, no account
   * resolution, no response wrapping. The handler receives SDK-validated
   * args and must return a `CallToolResult`. Call framework helpers
   * (`checkGovernance`, `adcpError`, `capabilitiesResponse`, …) from
   * inside the handler if you need those behaviors.
   *
   * Name collisions with registered AdcpToolMap tools (from `mediaBuy`,
   * `signals`, `creative`, `governance`, `accounts`, `eventTracking`,
   * `sponsoredIntelligence`) or with `get_adcp_capabilities` throw at
   * construction time — the spec handler wins by convention.
   */
  customTools?: Record<string, AdcpCustomToolConfig<any, any>>;

  /**
   * Opt-in bridge between the `comply_test_controller` seed store and the
   * spec-tool pipeline. When `getSeededProducts` is provided, seeded
   * products flow into `get_products` responses on sandbox requests — the
   * Group A compliance storyboards rely on this end-to-end flow.
   * Production traffic (no sandbox marker, or a resolved non-sandbox
   * account) bypasses the bridge entirely; omit the field in production
   * configs to be explicit about it.
   *
   * See `src/lib/server/test-controller-bridge.ts` for the sandbox-marker
   * predicate and the merge contract.
   *
   * @example
   * ```ts
   * import { createAdcpServer, bridgeFromTestControllerStore } from '@adcp/client';
   *
   * const seedStore = new Map<string, unknown>();
   * const server = createAdcpServer({
   *   mediaBuy: { getProducts: handleGetProducts },
   *   testController: bridgeFromTestControllerStore(seedStore, {
   *     delivery_type: 'guaranteed',
   *     channels: ['display'],
   *   }),
   * });
   * ```
   */
  testController?: TestControllerBridge<TAccount>;
}

// ---------------------------------------------------------------------------
// Tool metadata registry
// ---------------------------------------------------------------------------

interface ToolAnnotation {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

interface ToolMeta {
  wrap: ((data: any, summary?: string) => McpToolResponse) | null;
  annotations?: ToolAnnotation;
}

/**
 * Clamp idempotency replay TTL to spec bounds (1h–7d).
 */
function clampReplayTtl(seconds: number): number {
  const MIN = 3600;
  const MAX = 604800;
  if (!Number.isFinite(seconds) || seconds < MIN) return MIN;
  if (seconds > MAX) return MAX;
  return Math.floor(seconds);
}

/**
 * Deep-merge the per-domain blocks from `overrides` onto `target`. Nested
 * objects merge recursively; arrays and primitives replace. `null` at the
 * top-level field explicitly drops the block; `undefined` is a no-op.
 */
function applyCapabilityOverrides(target: GetAdCPCapabilitiesResponse, overrides: AdcpCapabilitiesOverrides): void {
  const targetAny = target as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) continue;
    if (value === null) {
      delete targetAny[key];
      continue;
    }
    targetAny[key] = deepMergePlainObjects(targetAny[key], value);
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object') return false;
  if (Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function deepMergePlainObjects(target: unknown, source: unknown): unknown {
  if (source === undefined) return target;
  if (source === null) return null;
  if (!isPlainObject(source)) return source;
  if (!isPlainObject(target)) return { ...(source as Record<string, unknown>) };
  const out: Record<string, unknown> = { ...target };
  for (const [k, v] of Object.entries(source as Record<string, unknown>)) {
    if (v === undefined) continue;
    if (v === null) {
      delete out[k];
      continue;
    }
    out[k] = deepMergePlainObjects(out[k], v);
  }
  return out;
}

/**
 * Stamp `replayed: true` on the response envelope for replay paths only.
 * `protocol-envelope.json` permits the field to be "omitted when the
 * request was executed fresh" — fresh-path responses therefore carry no
 * `replayed` field, and the field's presence implies `true`. Buyers read
 * the field to distinguish cached replays from new executions for billing
 * and audit.
 *
 * Mirrors the marker into both L3 `structuredContent` and the L2
 * `content[0].text` JSON fallback so A2A/REST adapters that consume the
 * text body see the same envelope MCP does — matching the lockstep
 * pattern in `injectContextIntoResponse` / `sanitizeAdcpErrorEnvelope`.
 */
function stampReplayed(response: McpToolResponse): void {
  if (!response.structuredContent || typeof response.structuredContent !== 'object') return;
  const sc = response.structuredContent as Record<string, unknown>;
  sc.replayed = true;
  if (Array.isArray(response.content)) {
    const first = response.content[0];
    if (first && first.type === 'text' && typeof first.text === 'string') {
      try {
        const parsed = JSON.parse(first.text);
        if (parsed && typeof parsed === 'object') {
          parsed.replayed = true;
          first.text = JSON.stringify(parsed);
        }
      } catch {
        // Text isn't JSON — leave it alone (implausible for AdCP responses).
      }
    }
  }
}

/**
 * Remove per-request echo fields (`context`) from a formatted MCP response
 * before caching. The buyer's `correlation_id` is scoped to the individual
 * retry attempt and must not be baked into the cached envelope — replays
 * need to echo back the CURRENT retry's context, not the first caller's.
 * Other fields (media_buy_id, status, timestamps) are part of the pinned
 * response and stay put.
 */
function stripEnvelopeEcho(response: McpToolResponse): McpToolResponse {
  const cloned = cloneFormattedResponse(response);
  if (cloned.structuredContent && typeof cloned.structuredContent === 'object') {
    const sc = cloned.structuredContent as Record<string, unknown>;
    delete sc.context;
  }
  if (Array.isArray(cloned.content)) {
    for (const item of cloned.content) {
      if (item && item.type === 'text' && typeof item.text === 'string') {
        try {
          const parsed = JSON.parse(item.text);
          if (parsed && typeof parsed === 'object') {
            delete parsed.context;
            item.text = JSON.stringify(parsed);
          }
        } catch {
          // Text isn't JSON — leave it alone
        }
      }
    }
  }
  return cloned;
}

/**
 * Shallow-clone a formatted MCP response so callers can mutate envelope
 * fields (`replayed`, echo-back `context`) without stomping on the cache
 * entry. The backend returns a fresh object (memory clones, pg
 * serializes) but re-wrapping via `wrap()` can still alias pieces of the
 * handler's return value — belt-and-suspenders against mutation leaks.
 */
function cloneFormattedResponse(response: McpToolResponse): McpToolResponse {
  const cloned: McpToolResponse = { ...response };
  if (cloned.structuredContent && typeof cloned.structuredContent === 'object') {
    cloned.structuredContent = { ...(cloned.structuredContent as Record<string, unknown>) };
  }
  if (Array.isArray(cloned.content)) {
    cloned.content = cloned.content.map(item => ({ ...item }));
  }
  return cloned;
}

/**
 * Detect whether a formatted MCP response represents a failure. Failures
 * are NOT cached — a retry should re-execute rather than replay a
 * transient error. Checks all three shapes the framework emits:
 * `isError: true`, `structuredContent.adcp_error`, or envelope
 * `status: 'failed'` (the envelope example in the spec for failed async
 * tasks doesn't always include `adcp_error`).
 */
function isErrorResponse(response: McpToolResponse): boolean {
  if (response.isError === true) return true;
  const sc = response.structuredContent;
  if (sc && typeof sc === 'object') {
    if ('adcp_error' in sc) return true;
    const status = (sc as Record<string, unknown>).status;
    if (status === 'failed' || status === 'canceled' || status === 'rejected') return true;
  }
  return false;
}

/**
 * Detect a thrown `adcpError(...)` envelope. Handlers that `throw` an
 * envelope (instead of `return`-ing it) would otherwise surface as
 * `[object Object]` inside a SERVICE_UNAVAILABLE wrapper — the dispatcher
 * unwraps and returns the envelope directly when the shape matches.
 */
function isThrownAdcpError(value: unknown): value is McpToolResponse {
  if (!value || typeof value !== 'object') return false;
  const sc = (value as { structuredContent?: unknown }).structuredContent;
  if (!sc || typeof sc !== 'object') return false;
  const env = (sc as { adcp_error?: unknown }).adcp_error;
  if (!env || typeof env !== 'object') return false;
  // `adcpError()` guarantees both `code` and `message` as strings — assert
  // both so a malformed envelope throw doesn't produce a half-formed
  // response. Also rules out MCP SDK `McpError` (numeric `code`) and any
  // other thrown object with a coincidentally-shaped sub-tree.
  if (typeof (env as { code?: unknown }).code !== 'string') return false;
  if (typeof (env as { message?: unknown }).message !== 'string') return false;
  return Array.isArray((value as { content?: unknown }).content) && (value as { isError?: unknown }).isError === true;
}

/**
 * Resolve the extra scope segment for tools with per-session semantics.
 *
 * For `si_send_message`, the request `session_id` enters the scope so
 * the same idempotency_key used across two sessions doesn't false-replay
 * (or false-conflict) across them. Other tools return `undefined` and
 * use the default `(principal, key)` scope.
 */
function resolveExtraScope(toolName: string, params: Record<string, unknown>): string | undefined {
  if (toolName === 'si_send_message') {
    const sessionId = params.session_id;
    return typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : undefined;
  }
  return undefined;
}

function genericResponse(toolName: string, data: object, summary?: string): McpToolResponse {
  return {
    content: [{ type: 'text', text: summary ?? `${toolName} completed` }],
    structuredContent: toStructuredContent(data),
  };
}

function wrapBuildCreative(data: any, summary?: string): McpToolResponse {
  if ('creative_manifests' in data) {
    return buildCreativeMultiResponse(data, summary);
  }
  return buildCreativeResponse(data, summary);
}

// Shorthand annotation constants
const RO: ToolAnnotation = { readOnlyHint: true };
const MUT: ToolAnnotation = { readOnlyHint: false, destructiveHint: false };
const DEST: ToolAnnotation = { readOnlyHint: false, destructiveHint: true };
const IDEMP: ToolAnnotation = { readOnlyHint: false, idempotentHint: true };

// Passthrough schema for every framework-registered tool (#909). See
// the comment at the registerTool call sites for rationale — short
// version: makes our AJV validator authoritative on both transports
// without destroying args on MCP when the SDK's tool dispatcher would
// otherwise coerce `undefined` into the handler for schemaless tools.
const PASSTHROUGH_INPUT_SCHEMA = z.object({}).passthrough();

const TOOL_META: Record<string, ToolMeta> = {
  // Media Buy
  get_products: { wrap: productsResponse, annotations: RO },
  create_media_buy: { wrap: mediaBuyResponse, annotations: MUT },
  update_media_buy: { wrap: updateMediaBuyResponse, annotations: MUT },
  get_media_buys: { wrap: getMediaBuysResponse, annotations: RO },
  get_media_buy_delivery: { wrap: deliveryResponse, annotations: RO },
  provide_performance_feedback: { wrap: performanceFeedbackResponse, annotations: MUT },

  // Creative
  list_creative_formats: { wrap: listCreativeFormatsResponse, annotations: RO },
  build_creative: { wrap: wrapBuildCreative, annotations: MUT },
  preview_creative: { wrap: null, annotations: RO },
  get_creative_delivery: { wrap: creativeDeliveryResponse, annotations: RO },
  list_creatives: { wrap: listCreativesResponse, annotations: RO },
  sync_creatives: { wrap: syncCreativesResponse, annotations: IDEMP },

  // Signals
  get_signals: { wrap: getSignalsResponse, annotations: RO },
  activate_signal: { wrap: activateSignalResponse, annotations: MUT },

  // Accounts
  list_accounts: { wrap: listAccountsResponse, annotations: RO },
  sync_accounts: { wrap: syncAccountsResponse, annotations: IDEMP },
  sync_governance: { wrap: syncGovernanceResponse, annotations: IDEMP },
  get_account_financials: { wrap: null, annotations: RO },
  report_usage: { wrap: reportUsageResponse, annotations: MUT },

  // Event Tracking
  sync_event_sources: { wrap: null, annotations: IDEMP },
  log_event: { wrap: null, annotations: MUT },

  // Audiences & Catalogs
  sync_audiences: { wrap: null, annotations: IDEMP },
  sync_catalogs: { wrap: null, annotations: IDEMP },

  // Governance - Property Lists
  create_property_list: { wrap: null, annotations: MUT },
  update_property_list: { wrap: null, annotations: MUT },
  get_property_list: { wrap: null, annotations: RO },
  list_property_lists: { wrap: null, annotations: RO },
  delete_property_list: { wrap: null, annotations: DEST },

  // Governance - Content Standards
  list_content_standards: { wrap: null, annotations: RO },
  get_content_standards: { wrap: null, annotations: RO },
  create_content_standards: { wrap: null, annotations: MUT },
  update_content_standards: { wrap: null, annotations: MUT },
  calibrate_content: { wrap: null, annotations: MUT },
  validate_content_delivery: { wrap: null, annotations: RO },
  get_media_buy_artifacts: { wrap: null, annotations: RO },

  // Governance - Campaign
  get_creative_features: { wrap: null, annotations: RO },
  sync_plans: { wrap: null, annotations: IDEMP },
  check_governance: { wrap: null, annotations: RO },
  report_plan_outcome: { wrap: null, annotations: MUT },
  get_plan_audit_logs: { wrap: null, annotations: RO },

  // Sponsored Intelligence
  si_get_offering: { wrap: null, annotations: RO },
  si_initiate_session: { wrap: null, annotations: MUT },
  si_send_message: { wrap: null, annotations: MUT },
  si_terminate_session: { wrap: null, annotations: DEST },

  // Brand Rights
  get_brand_identity: { wrap: null, annotations: RO },
  get_rights: { wrap: null, annotations: RO },
  acquire_rights: { wrap: acquireRightsResponse, annotations: MUT },
};

// ---------------------------------------------------------------------------
// Domain → tool name mapping
// ---------------------------------------------------------------------------

type HandlerEntry = { handlerKey: string; toolName: string };

const MEDIA_BUY_ENTRIES: HandlerEntry[] = [
  { handlerKey: 'getProducts', toolName: 'get_products' },
  { handlerKey: 'createMediaBuy', toolName: 'create_media_buy' },
  { handlerKey: 'updateMediaBuy', toolName: 'update_media_buy' },
  { handlerKey: 'getMediaBuys', toolName: 'get_media_buys' },
  { handlerKey: 'getMediaBuyDelivery', toolName: 'get_media_buy_delivery' },
  { handlerKey: 'providePerformanceFeedback', toolName: 'provide_performance_feedback' },
  { handlerKey: 'listCreativeFormats', toolName: 'list_creative_formats' },
  { handlerKey: 'syncCreatives', toolName: 'sync_creatives' },
  { handlerKey: 'listCreatives', toolName: 'list_creatives' },
];

const EVENT_TRACKING_ENTRIES: HandlerEntry[] = [
  { handlerKey: 'syncEventSources', toolName: 'sync_event_sources' },
  { handlerKey: 'logEvent', toolName: 'log_event' },
  { handlerKey: 'syncAudiences', toolName: 'sync_audiences' },
  { handlerKey: 'syncCatalogs', toolName: 'sync_catalogs' },
];

const SIGNALS_ENTRIES: HandlerEntry[] = [
  { handlerKey: 'getSignals', toolName: 'get_signals' },
  { handlerKey: 'activateSignal', toolName: 'activate_signal' },
];

const CREATIVE_ENTRIES: HandlerEntry[] = [
  { handlerKey: 'listCreativeFormats', toolName: 'list_creative_formats' },
  { handlerKey: 'buildCreative', toolName: 'build_creative' },
  { handlerKey: 'previewCreative', toolName: 'preview_creative' },
  { handlerKey: 'listCreatives', toolName: 'list_creatives' },
  { handlerKey: 'syncCreatives', toolName: 'sync_creatives' },
  { handlerKey: 'getCreativeDelivery', toolName: 'get_creative_delivery' },
];

const GOVERNANCE_ENTRIES: HandlerEntry[] = [
  { handlerKey: 'createPropertyList', toolName: 'create_property_list' },
  { handlerKey: 'updatePropertyList', toolName: 'update_property_list' },
  { handlerKey: 'getPropertyList', toolName: 'get_property_list' },
  { handlerKey: 'listPropertyLists', toolName: 'list_property_lists' },
  { handlerKey: 'deletePropertyList', toolName: 'delete_property_list' },
  { handlerKey: 'listContentStandards', toolName: 'list_content_standards' },
  { handlerKey: 'getContentStandards', toolName: 'get_content_standards' },
  { handlerKey: 'createContentStandards', toolName: 'create_content_standards' },
  { handlerKey: 'updateContentStandards', toolName: 'update_content_standards' },
  { handlerKey: 'calibrateContent', toolName: 'calibrate_content' },
  { handlerKey: 'validateContentDelivery', toolName: 'validate_content_delivery' },
  { handlerKey: 'getMediaBuyArtifacts', toolName: 'get_media_buy_artifacts' },
  { handlerKey: 'getCreativeFeatures', toolName: 'get_creative_features' },
  { handlerKey: 'syncPlans', toolName: 'sync_plans' },
  { handlerKey: 'checkGovernance', toolName: 'check_governance' },
  { handlerKey: 'reportPlanOutcome', toolName: 'report_plan_outcome' },
  { handlerKey: 'getPlanAuditLogs', toolName: 'get_plan_audit_logs' },
];

const ACCOUNT_ENTRIES: HandlerEntry[] = [
  { handlerKey: 'listAccounts', toolName: 'list_accounts' },
  { handlerKey: 'syncAccounts', toolName: 'sync_accounts' },
  { handlerKey: 'syncGovernance', toolName: 'sync_governance' },
  { handlerKey: 'getAccountFinancials', toolName: 'get_account_financials' },
  { handlerKey: 'reportUsage', toolName: 'report_usage' },
];

const SI_ENTRIES: HandlerEntry[] = [
  { handlerKey: 'getOffering', toolName: 'si_get_offering' },
  { handlerKey: 'initiateSession', toolName: 'si_initiate_session' },
  { handlerKey: 'sendMessage', toolName: 'si_send_message' },
  { handlerKey: 'terminateSession', toolName: 'si_terminate_session' },
];

const BRAND_RIGHTS_ENTRIES: HandlerEntry[] = [
  { handlerKey: 'getBrandIdentity', toolName: 'get_brand_identity' },
  { handlerKey: 'getRights', toolName: 'get_rights' },
  { handlerKey: 'acquireRights', toolName: 'acquire_rights' },
];

// ---------------------------------------------------------------------------
// Protocol detection
// ---------------------------------------------------------------------------

const TOOL_PROTOCOL_MAP: [readonly string[], AdcpProtocol][] = [
  [MEDIA_BUY_TOOLS, 'media_buy'],
  [SIGNALS_TOOLS, 'signals'],
  [GOVERNANCE_TOOLS, 'governance'],
  [CREATIVE_TOOLS, 'creative'],
  [SPONSORED_INTELLIGENCE_TOOLS, 'sponsored_intelligence'],
  [BRAND_RIGHTS_TOOLS, 'brand'],
];

function detectProtocols(toolNames: string[]): AdcpProtocol[] {
  const nameSet = new Set(toolNames);
  const protocols: AdcpProtocol[] = [];
  for (const [tools, protocol] of TOOL_PROTOCOL_MAP) {
    if (tools.some(t => nameSet.has(t))) {
      protocols.push(protocol);
    }
  }
  return protocols;
}

// ---------------------------------------------------------------------------
// Tool coherence warnings
// ---------------------------------------------------------------------------

const COHERENCE_RULES: [string, string, string][] = [
  [
    'create_media_buy',
    'get_products',
    'create_media_buy without get_products — buyers cannot discover products before purchasing',
  ],
  [
    'update_media_buy',
    'get_media_buys',
    'update_media_buy without get_media_buys — buyers cannot look up what to modify',
  ],
  [
    'activate_signal',
    'get_signals',
    'activate_signal without get_signals — buyers cannot discover signals before activating',
  ],
  [
    'sync_creatives',
    'list_creative_formats',
    'sync_creatives without list_creative_formats — buyers cannot discover valid formats',
  ],
];

function checkCoherence(toolNames: Set<string>, logger: AdcpLogger): void {
  for (const [tool, requires, message] of COHERENCE_RULES) {
    if (toolNames.has(tool) && !toolNames.has(requires)) {
      logger.warn(message);
    }
  }
}

// ---------------------------------------------------------------------------
// Response detection
// ---------------------------------------------------------------------------

function isFormattedResponse(value: unknown): value is McpToolResponse {
  if (value == null || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  return Array.isArray(obj.content) && 'structuredContent' in obj;
}

/**
 * Detect an AdCP Submitted envelope (async task acknowledgement).
 *
 * Every *Submitted arm in the generated types has `status: 'submitted'`
 * plus a required `task_id: string`. The discriminant is stable enough
 * to use for routing at dispatch time without per-tool knowledge.
 */
function isSubmittedEnvelope(value: unknown): value is { status: 'submitted'; task_id: string; message?: string } {
  if (value == null || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  return obj.status === 'submitted' && typeof obj.task_id === 'string';
}

/**
 * Detect an AdCP *Error arm (union member, not the framework `adcp_error`
 * envelope). Every *Error interface in the generated types carries a
 * required `errors: Error[]` and a narrow set of allowed siblings
 * (`context`, `ext`, plus a couple of tool-specific extras). Success
 * arms may have optional advisory fields but never a required `errors`
 * array — the `status === 'submitted'` exclusion keeps us from
 * confusing a Submitted envelope that advisory-echoes errors as an
 * Error arm. The set of allowed sibling keys is intentionally narrow:
 * any other top-level key means the payload carries Success-only fields
 * (`media_buy_id`, `creatives`, `signal_id`, ...) and should fall
 * through to the response builder.
 */
const ERROR_ARM_ALLOWED_KEYS = new Set(['errors', 'context', 'ext', 'success', 'conflicting_standards_id']);
function isErrorArm(value: unknown): value is { errors: unknown[]; context?: unknown; ext?: unknown } {
  if (value == null || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  if (!Array.isArray(obj.errors)) return false;
  if ('status' in obj) return false;
  for (const key of Object.keys(obj)) {
    if (!ERROR_ARM_ALLOWED_KEYS.has(key)) return false;
  }
  return true;
}

/**
 * Wrap a Submitted envelope returned directly by a handler. Skips the
 * Success-builder defaults (`revision`, `confirmed_at`, `valid_actions`)
 * — those fields are specific to `CreateMediaBuySuccess` and would
 * corrupt the async-task shape if applied.
 */
function wrapSubmittedEnvelope(value: { status: 'submitted'; task_id: string; message?: string }): McpToolResponse {
  const summary = value.message ?? `Task ${value.task_id} submitted`;
  return {
    content: [{ type: 'text', text: summary }],
    structuredContent: value as unknown as Record<string, unknown>,
  };
}

/**
 * Wrap an *Error arm returned directly by a handler. Preserves the
 * generated-type shape (`errors: Error[]`) on `structuredContent` so
 * buyers reading the typed response union see the exact branch the
 * spec defines; also sets `isError: true` so the MCP-level signal
 * matches `adcp_error` envelopes, which keeps `isErrorResponse()` and
 * `response-validation: strict` consistent across both error paths.
 */
function wrapErrorArm(value: { errors: unknown[] }): McpToolResponse {
  const firstError = value.errors[0] as { code?: unknown; message?: unknown } | undefined;
  const summary =
    firstError && typeof firstError === 'object'
      ? `${typeof firstError.code === 'string' ? firstError.code : 'ERROR'}: ${typeof firstError.message === 'string' ? firstError.message : 'operation failed'}`
      : 'operation failed';
  return {
    content: [{ type: 'text', text: summary }],
    isError: true,
    structuredContent: value as unknown as Record<string, unknown>,
  };
}

/**
 * Defence-in-depth sanitizer for handler-returned error envelopes.
 *
 * `adcpError()` filters its own output against `ADCP_ERROR_FIELD_ALLOWLIST`,
 * but a handler that hand-rolls `{ isError: true, structuredContent: {
 * adcp_error: {...} } }` (or constructs the envelope through a different
 * builder) bypasses that sanitizer. The storyboard invariant
 * `idempotency.conflict_no_payload_leak` catches this at conformance-test
 * time, but production traffic would be unprotected — so we re-apply the
 * allowlist here too. Silent no-op when the code has no registered entry,
 * or when `structuredContent.adcp_error` is missing its `code` field.
 *
 * Keeps L2 (`content[0].text`) and L3 (`structuredContent`) in lockstep —
 * both transport layers get the same filtered payload.
 */
function sanitizeAdcpErrorEnvelope(response: McpToolResponse): void {
  const sc = response.structuredContent as Record<string, unknown> | undefined;
  if (!sc || typeof sc !== 'object') return;
  const err = sc.adcp_error as Record<string, unknown> | undefined;
  if (!err || typeof err !== 'object') return;
  const code = err.code;
  if (typeof code !== 'string') return;
  const allow = ADCP_ERROR_FIELD_ALLOWLIST[code];
  if (!allow) return;

  const filtered: Record<string, unknown> = {};
  let droppedAny = false;
  for (const [k, v] of Object.entries(err)) {
    if (allow.has(k)) {
      filtered[k] = v;
    } else {
      droppedAny = true;
    }
  }
  if (!droppedAny) return;

  sc.adcp_error = filtered;
  if (Array.isArray(response.content)) {
    const first = response.content[0];
    if (first && first.type === 'text' && typeof first.text === 'string') {
      try {
        const parsed = JSON.parse(first.text);
        if (parsed && typeof parsed === 'object') {
          parsed.adcp_error = filtered;
          first.text = JSON.stringify(parsed);
        }
      } catch {
        // Text isn't JSON — leave it alone. adcpError()-emitted envelopes
        // always serialize to JSON, so the only hit here would be a seller
        // who hand-rolled a non-JSON content[0] (implausible for AdCP).
      }
    }
  }
}

// Echo the request context into a formatted MCP tool response so buyers can
// trace correlation_id across both success and error responses. Only plain
// objects are echoed: `si_get_offering` and `si_initiate_session` override
// the request schema's `context` to a domain-specific string, while the
// response schema still requires the protocol echo object — copying a
// string there would fail response validation.
function injectContextIntoResponse(response: McpToolResponse, context: unknown): void {
  if (context === null || typeof context !== 'object' || Array.isArray(context)) return;
  const sc = response.structuredContent as Record<string, unknown> | undefined;
  if (sc && typeof sc === 'object' && !('context' in sc)) {
    sc.context = context;
    // Keep the L2 text fallback (JSON body) in sync with structuredContent
    if (Array.isArray(response.content)) {
      const first = response.content[0];
      if (first && first.type === 'text' && typeof first.text === 'string') {
        try {
          const parsed = JSON.parse(first.text);
          if (parsed && typeof parsed === 'object' && !('context' in parsed)) {
            parsed.context = context;
            first.text = JSON.stringify(parsed);
          }
        } catch {
          // Text isn't JSON — leave it alone
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Signed-requests preTransport builder
// ---------------------------------------------------------------------------

/**
 * Build a `preTransport` middleware that runs `createExpressVerifier` against
 * the incoming Node request/response. The returned function matches the shape
 * `serve({ preTransport })` expects: it resolves to `true` when the verifier
 * has already written a 401 (headers sent), `false` otherwise.
 *
 * `serve()` buffers the request body into `req.rawBody` before invoking the
 * preTransport hook, so the verifier sees the exact bytes the signer hashed
 * for Content-Digest. For MCP the operation name comes from the JSON-RPC
 * `params.name`; the resolver below falls back to `undefined` for non-JSON or
 * non-`tools/call` bodies, which makes the verifier treat them as not-in-
 * `required_for` rather than rejecting (discovery probes, health checks).
 */
function buildSignedRequestsPreTransport(
  signedRequests: SignedRequestsConfig,
  capabilityRequiredFor?: string[]
): AdcpPreTransport {
  // Precedence: explicit signedRequests.required_for > capabilities.request_signing.required_for
  // > fallback to every mutating task. Buyers read required_for from
  // get_adcp_capabilities to decide which calls to sign — defaulting to
  // MUTATING_TASKS when the seller advertised a narrower list would cause
  // buyers to get request_signature_required on tools they had no contractual
  // duty to sign.
  const requiredFor = signedRequests.required_for ?? capabilityRequiredFor ?? [...MUTATING_TASKS];
  const verifier = createExpressVerifier({
    capability: {
      supported: true,
      covers_content_digest: signedRequests.covers_content_digest ?? 'either',
      required_for: requiredFor,
    },
    jwks: signedRequests.jwks,
    replayStore: signedRequests.replayStore,
    revocationStore: signedRequests.revocationStore,
    ...(signedRequests.agentUrlForKeyid ? { agentUrlForKeyid: signedRequests.agentUrlForKeyid } : {}),
    resolveOperation: req => {
      const raw = (req as { rawBody?: string }).rawBody;
      if (!raw) return undefined;
      try {
        const parsed = JSON.parse(raw) as { method?: string; params?: { name?: string } };
        if (parsed.method === 'tools/call' && typeof parsed.params?.name === 'string') {
          return parsed.params.name;
        }
      } catch {
        // Non-JSON or malformed body — let transport handle rejection.
      }
      return undefined;
    },
  });

  return async function adcpPreTransport(req, res) {
    const reqShim: ExpressLike = {
      method: req.method ?? 'POST',
      url: req.url ?? '/mcp',
      originalUrl: req.url ?? '/mcp',
      headers: req.headers,
      rawBody: req.rawBody ?? '',
      protocol: 'http',
      get(name: string) {
        const v = req.headers[name.toLowerCase()];
        return Array.isArray(v) ? v.join(', ') : v;
      },
    };
    const resShim = {
      status(code: number) {
        res.statusCode = code;
        return {
          set(k: string, v: string) {
            res.setHeader(k, v);
            return {
              json(body: unknown) {
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify(body));
              },
            };
          },
        };
      },
    };

    let handled = false;
    let verifierCompleted = false;
    // The verifier calls `next(err?)` in the success / error path, but the
    // 401 RequestSignatureError path writes the response and returns WITHOUT
    // calling next. Race the next-callback against the response's 'finish' /
    // 'close' events so a terminal 401 resolves the promise; otherwise the
    // wrapper hangs forever and the agent server leaks (one McpServer per
    // unsigned request under attack).
    //
    // Security: if 'close' fires before the verifier completes (client
    // aborted the TCP connection mid-JWKS-fetch), we MUST NOT fall through
    // to the MCP transport — doing so would execute the tool handler
    // without a verified signature on an attacker-dropped connection. Mark
    // handled=true so serve.ts skips dispatch.
    await new Promise<void>(resolve => {
      let resolved = false;
      const done = () => {
        if (resolved) return;
        resolved = true;
        resolve();
      };
      res.once('finish', () => {
        if (res.writableEnded) handled = true;
        done();
      });
      res.once('close', () => {
        if (!verifierCompleted) handled = true;
        done();
      });
      verifier(reqShim, resShim, err => {
        verifierCompleted = true;
        if (err) {
          // Log internally; a leaked stack trace to the caller would
          // enumerate the verifier pipeline (js/stack-trace-exposure).
          // Narrow to name+code only — full error stringification can embed
          // JWKS URLs from transport failures, which leaks counterparty
          // key-discovery topology on shared log aggregators.
          const errName = (err as Error).name || 'Error';
          const errCode = (err as { code?: string }).code ?? 'unknown';
          console.error(`[adcp/signed-requests] verifier middleware error: ${errName} (${errCode})`);
          if (!res.writableEnded) {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'verifier_error' }));
          }
          handled = true;
        }
        if (res.writableEnded) handled = true;
        done();
      });
    });
    return handled;
  };
}

// ---------------------------------------------------------------------------
// createAdcpServer
// ---------------------------------------------------------------------------

/**
 * Create an AdCP-compliant MCP server from domain-grouped handler functions.
 *
 * Before each handler runs, the framework:
 * 1. Validates the request against the tool's Zod schema (MCP SDK)
 * 2. Resolves the account (if the tool has an `account` field and `resolveAccount` is configured)
 *
 * The handler only runs when all preconditions pass. It receives the validated
 * params and a context with the resolved account and state store.
 *
 * `get_adcp_capabilities` is auto-generated from registered tools.
 */
export function createAdcpServer<TAccount = unknown>(config: AdcpServerConfig<TAccount>): AdcpServer {
  const {
    name,
    version,
    resolveAccount,
    resolveSessionKey,
    exposeErrorDetails = process.env.NODE_ENV !== 'production',
    stateStore = new InMemoryStateStore(),
    logger = noopLogger,
    capabilities: capConfig,
    idempotency: idempotencyConfig,
    resolveIdempotencyPrincipal,
    instructions,
    taskStore,
    taskMessageQueue,
    webhooks,
    signedRequests,
    validation: validationConfig,
    testController: testControllerBridge,
  } = config;

  // Defaults gated on `process.env.NODE_ENV`:
  //   - Production → both sides `'off'` (zero AJV overhead; trust the
  //     handler after its test suite has exercised it).
  //   - Dev/test/CI → BOTH sides `'strict'`. Request validation is now
  //     authoritative on both transports (#909) — we dropped the SDK
  //     Zod from `registerTool` inputSchema, so if our framework validator
  //     doesn't reject malformed payloads they reach the handler
  //     unchecked over A2A. Matching responses' existing `'strict'`
  //     default keeps behavior consistent across the wire in both
  //     directions.
  // Explicit `validation: { requests, responses }` on the config always
  // wins. `process.env.NODE_ENV` matches the convention every other SDK
  // consumer already tunes (Express, React, etc.); containers/CI that
  // want prod-like behavior set NODE_ENV=production before start.
  const isProduction = process.env.NODE_ENV === 'production';
  const requestValidationMode = validationConfig?.requests ?? (isProduction ? 'off' : 'strict');
  const responseValidationMode = validationConfig?.responses ?? (isProduction ? 'off' : 'strict');

  // Split the `idempotency` config field into "the active store" and
  // "explicitly opted out" so existing call sites keep working with a
  // single nullable variable while the disabled-mode branches stay
  // surgical. `idempotencyDisabled` gates: schema-level missing-key
  // tolerance, the missing-store guardrail log, the capability
  // declaration shift to `IdempotencyUnsupported`, and the runtime
  // production check below.
  const idempotencyDisabled = idempotencyConfig === 'disabled';
  const idempotency: IdempotencyStore | undefined = idempotencyDisabled ? undefined : idempotencyConfig;
  if (idempotencyDisabled) {
    // Allowlist gate. The earlier draft refused the flag only when
    // NODE_ENV === 'production', which is a footgun: NODE_ENV defaults to
    // unset in raw Lambda, custom containers, and many K8s deployments,
    // so the strict equality returned `false` in exactly the
    // hard-to-debug environments where disabled mode is most dangerous.
    // Inverted to an allowlist of dev/test environments; any other value
    // (unset, 'production', 'staging', 'qa', custom names) requires the
    // operator to explicitly acknowledge the risk via
    // `ADCP_IDEMPOTENCY_DISABLED_ACK=1`. Hard to set by accident, makes
    // the choice deliberate, and turns a missing-NODE_ENV config into a
    // startup crash instead of a silent money-flow incident on retry.
    const env = process.env.NODE_ENV;
    const acknowledged = process.env.ADCP_IDEMPOTENCY_DISABLED_ACK === '1';
    const isAllowlistedDevEnv = env === 'test' || env === 'development';
    if (!isAllowlistedDevEnv && !acknowledged) {
      throw new Error(
        "createAdcpServer: idempotency: 'disabled' refuses to start with NODE_ENV=" +
          (env === undefined ? '<unset>' : JSON.stringify(env)) +
          '. Disabled mode skips replay enforcement and silently double-executes mutating handlers on retry, ' +
          'so the SDK only allows it under NODE_ENV=test or NODE_ENV=development by default. ' +
          'Either: (a) wire a real store via `createIdempotencyStore({ backend, ttlSeconds })`, ' +
          '(b) set NODE_ENV=test or NODE_ENV=development if this is a dev-only environment, or ' +
          '(c) set ADCP_IDEMPOTENCY_DISABLED_ACK=1 to explicitly acknowledge the risk for non-standard environments.'
      );
    }
    logger.warn(
      "createAdcpServer: idempotency: 'disabled' is set. Mutating requests will not be replay-checked and " +
        '`get_adcp_capabilities` will declare `idempotency.supported: false`. Use only in non-production test fleets.'
    );
  }

  // Enforce lock-step between the `signed-requests` specialism claim and the
  // verifier config for the auto-wiring path. When `signedRequests` is set
  // but the specialism isn't declared, buyers can't discover the signing
  // requirement from `get_adcp_capabilities` — they won't sign, the
  // verifier rejects every mutating call, and the agent is dead on arrival.
  // That's unambiguously wrong, so we throw.
  //
  // The opposite direction — claiming the specialism without a
  // `signedRequests` config — is only wrong when the agent also doesn't
  // wire a verifier via `serve({ preTransport })`. Legacy servers that
  // hand-build the middleware fall into this case and are still conformant.
  // We log a loud error so operators notice (matching the idempotency
  // guardrail precedent) but don't throw, leaving the manual path working.
  const specialismsClaimed = capConfig?.specialisms ?? [];
  const claimsSignedRequests = specialismsClaimed.includes('signed-requests');
  if (signedRequests && !claimsSignedRequests) {
    throw new Error(
      'createAdcpServer: `signedRequests` is configured but `capabilities.specialisms` does not include "signed-requests". ' +
        'Add "signed-requests" to the specialisms list — buyers discover the signing requirement from get_adcp_capabilities, ' +
        "and omitting the claim means they won't sign their requests."
    );
  }
  if (claimsSignedRequests && !signedRequests) {
    logger.error(
      'createAdcpServer: `capabilities.specialisms` claims "signed-requests" but no `signedRequests` config was provided. ' +
        'Either pass `signedRequests: { jwks, replayStore, revocationStore }` to auto-wire the verifier, or ensure you wire ' +
        'one manually via `serve({ preTransport })`. Claiming the specialism without verifying signatures is a spec violation.'
    );
  }
  // The specialism is only meaningful when `capabilities.request_signing.supported`
  // is true — the compliance storyboard treats a missing or false `supported`
  // flag as "not opted in" and silently skips the whole conformance run. Claim
  // + supported:false is the worst failure mode: the claim advertises
  // signature enforcement while the capability block tells buyers the agent
  // doesn't verify. Fail fast so the mismatch is caught at construction.
  if (claimsSignedRequests && capConfig?.request_signing?.supported !== true) {
    throw new Error(
      'createAdcpServer: `capabilities.specialisms` claims "signed-requests" but `capabilities.request_signing.supported` is not true. ' +
        'Set `capabilities.request_signing = { supported: true, ... }` — the compliance storyboard skips conformance entirely when ' +
        '`supported` is falsy, and buyers cannot discover the signing requirement without the capability block.'
    );
  }

  // Instantiate the emitter once — handler contexts expose its `emit`
  // bound method so per-request code calls `ctx.emitWebhook(...)` without
  // knowing about the emitter's construction or options.
  const webhookEmitter = webhooks ? createWebhookEmitter(webhooks) : undefined;

  const server = createTaskCapableServer(name, version, {
    taskStore,
    taskMessageQueue,
    instructions,
  });

  const registeredToolNames = new Set<string>();

  // Collect all domain handlers into a flat toolName → handler map
  const domainGroups: [Record<string, Function> | undefined, HandlerEntry[]][] = [
    [config.mediaBuy as Record<string, Function> | undefined, MEDIA_BUY_ENTRIES],
    [config.signals as Record<string, Function> | undefined, SIGNALS_ENTRIES],
    [config.creative as Record<string, Function> | undefined, CREATIVE_ENTRIES],
    [config.governance as Record<string, Function> | undefined, GOVERNANCE_ENTRIES],
    [config.accounts as Record<string, Function> | undefined, ACCOUNT_ENTRIES],
    [config.eventTracking as Record<string, Function> | undefined, EVENT_TRACKING_ENTRIES],
    [config.sponsoredIntelligence as Record<string, Function> | undefined, SI_ENTRIES],
    [config.brandRights as Record<string, Function> | undefined, BRAND_RIGHTS_ENTRIES],
  ];

  for (const [handlers, entries] of domainGroups) {
    if (!handlers) continue;

    // Warn on unrecognized handler keys (likely typos)
    const knownKeys = new Set(entries.map(e => e.handlerKey));
    for (const key of Object.keys(handlers)) {
      if (typeof (handlers as Record<string, unknown>)[key] === 'function' && !knownKeys.has(key)) {
        logger.warn(`Unknown handler key "${key}" — will not be registered. Check for typos.`);
      }
    }

    for (const { handlerKey, toolName } of entries) {
      const handler = (handlers as Record<string, Function>)[handlerKey];
      if (!handler) continue;

      if (registeredToolNames.has(toolName)) {
        // Tool already registered by another domain (e.g., list_creative_formats
        // in both mediaBuy and creative). First domain wins.
        logger.warn(`Tool "${toolName}" already registered by another domain, skipping`);
        continue;
      }

      const meta = TOOL_META[toolName];
      const schema = TOOL_REQUEST_SCHEMAS[toolName] as { shape: Record<string, unknown> } | undefined;
      if (!schema?.shape) {
        logger.warn(`No schema found for tool "${toolName}" in TOOL_REQUEST_SCHEMAS, skipping`);
        continue;
      }
      const hasAccount = 'account' in schema.shape;

      const wrap = meta?.wrap ?? ((data: any, summary?: string) => genericResponse(toolName, data, summary));
      const toolHandler = async (params: any, extra: any) => {
        const ctx: HandlerContext<TAccount> = { store: stateStore };
        if (extra?.authInfo) ctx.authInfo = extra.authInfo;
        if (webhookEmitter) ctx.emitWebhook = webhookEmitter.emit.bind(webhookEmitter);

        // Echo params.context into any response (success or error) so buyers
        // can trace correlation_id end-to-end. Framework-generated errors
        // (ACCOUNT_NOT_FOUND, SERVICE_UNAVAILABLE) go through this too.
        // `injectContextIntoResponse` skips non-object values so SI tools
        // that override `context` as a string on the request don't leak the
        // string into the response envelope.
        //
        // `sanitizeAdcpErrorEnvelope` re-applies `ADCP_ERROR_FIELD_ALLOWLIST`
        // as a runtime belt-and-suspenders for handlers that build an error
        // envelope outside `adcpError()` — `adcpError()` already filters its
        // own output, but a hand-rolled `{ isError, structuredContent:
        // { adcp_error: ... } }` would otherwise ship unfiltered.
        const finalize = (response: McpToolResponse): McpToolResponse => {
          sanitizeAdcpErrorEnvelope(response);
          injectContextIntoResponse(response, params.context);
          return response;
        };

        const toolIsMutating = isMutatingTask(toolName);

        // --- Request schema validation (opt-in) ---
        // Runs before idempotency so drifted payloads never touch the
        // replay cache. `off` short-circuits without calling AJV.
        if (requestValidationMode !== 'off') {
          const outcome = validateRequest(toolName, params);
          if (!outcome.valid) {
            // When `idempotency: 'disabled'` is set, drop the synthetic
            // "missing idempotency_key" failure on mutating tools — the
            // operator has explicitly opted out of enforcement and would
            // otherwise need to UUID-inject every test payload to satisfy
            // the spec-required field. All other schema issues still fail.
            //
            // The exact-match `pointer === '/idempotency_key'` is
            // load-bearing: AJV builds the pointer from `instancePath +
            // /missingProperty`, so today every mutating tool's
            // idempotency_key sits at the top level (instancePath = '',
            // pointer = '/idempotency_key'). If a future spec revision
            // ever nests this field under another object, the new pointer
            // (`/foo/idempotency_key`) won't match this filter and the
            // strict-mode failure will correctly bubble up — drift is
            // surfaced rather than silently swallowed.
            const issues =
              idempotencyDisabled && toolIsMutating
                ? outcome.issues.filter(i => !(i.keyword === 'required' && i.pointer === '/idempotency_key'))
                : outcome.issues;
            if (issues.length > 0) {
              if (requestValidationMode === 'strict') {
                // Thread `exposeSchemaPath` the same way response-side does
                // so request-side schemaPath also ships in dev and stays
                // gated in production. Prior to this, request-side silently
                // stripped schemaPath even in dev — asymmetric with response-side.
                const payload = buildAdcpValidationErrorPayload(toolName, 'request', issues, {
                  exposeSchemaPath: exposeErrorDetails,
                });
                return finalize(adcpError('VALIDATION_ERROR', payload));
              }
              logger.warn(`Schema validation warning (request) for ${toolName}: ${formatIssues(issues)}`, {
                tool: toolName,
                issues,
              });
            }
          }
        }

        // --- Account resolution ---
        if (hasAccount && params.account != null && resolveAccount) {
          try {
            const account = await resolveAccount(params.account, {
              toolName: toolName as AdcpServerToolName,
              authInfo: ctx.authInfo,
            });
            if (account == null) {
              logger.warn('Account not found', { tool: toolName, account: params.account });
              return finalize(
                adcpError('ACCOUNT_NOT_FOUND', {
                  message: 'The specified account does not exist',
                  field: 'account',
                  suggestion: 'Use list_accounts to discover available accounts, or sync_accounts to create one',
                })
              );
            }
            ctx.account = account;
          } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            logger.error('Account resolution failed', { tool: toolName, error: reason });
            return finalize(
              adcpError('SERVICE_UNAVAILABLE', {
                message: 'Account resolution failed',
                ...(exposeErrorDetails && { details: { reason } }),
              })
            );
          }
        }

        // --- Session key resolution ---
        if (resolveSessionKey) {
          try {
            const sessionKey = await resolveSessionKey({
              toolName: toolName as AdcpServerToolName,
              params,
              account: ctx.account,
            });
            if (sessionKey !== undefined) ctx.sessionKey = sessionKey;
          } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            logger.error('Session key resolution failed', { tool: toolName, error: reason });
            return finalize(
              adcpError('SERVICE_UNAVAILABLE', {
                message: 'Session key resolution failed',
                ...(exposeErrorDetails && { details: { reason } }),
              })
            );
          }
        }

        // --- idempotency_key shape gate (runs even in disabled mode) ---
        // Defense-in-depth against buyers that bypass MCP schema
        // validation (different transport, bespoke client) AND against
        // disabled-mode environments where the replay middleware below is
        // skipped. Low-entropy keys pollute the cache and enable
        // enumeration; keys containing the internal scope-separator byte
        // would collide with the cache's scope tuple. Even in disabled
        // mode (no cache, no enforcement) a malformed key flowing into
        // handler logs is a debuggability hazard — so we reject the
        // shape whenever a key was supplied, regardless of whether the
        // replay middleware will execute. Missing-key enforcement
        // remains scoped to the middleware below (gated on `idempotency`),
        // so disabled mode tolerates absence per the schema-filter
        // contract earlier in this dispatcher.
        if (
          toolIsMutating &&
          typeof params.idempotency_key === 'string' &&
          !IDEMPOTENCY_KEY_PATTERN.test(params.idempotency_key)
        ) {
          return finalize(
            adcpError('INVALID_REQUEST', {
              message: 'idempotency_key must match the spec pattern ^[A-Za-z0-9_.:-]{16,255}$',
              field: 'idempotency_key',
            })
          );
        }

        // --- Idempotency (mutating tools only) ---
        let idempotencyCheck: { key: string; principal: string; payloadHash: string; extraScope?: string } | undefined;
        if (idempotency && toolIsMutating) {
          const key = typeof params.idempotency_key === 'string' ? params.idempotency_key : undefined;
          if (!key) {
            return finalize(
              adcpError('INVALID_REQUEST', {
                message: 'idempotency_key is required on mutating requests',
                field: 'idempotency_key',
              })
            );
          }
          // Pattern check already ran in the shape gate above. By this
          // point `key` is guaranteed to match IDEMPOTENCY_KEY_PATTERN.
          const principal =
            (resolveIdempotencyPrincipal
              ? resolveIdempotencyPrincipal(ctx, params, toolName as AdcpServerToolName)
              : ctx.sessionKey) ?? '';
          if (!principal) {
            logger.error('Idempotency principal unresolved', { tool: toolName });
            return finalize(
              adcpError('SERVICE_UNAVAILABLE', {
                message:
                  'Idempotency principal could not be resolved — configure resolveSessionKey or resolveIdempotencyPrincipal',
              })
            );
          }
          // SI `si_send_message` is scoped per-session — the same key under
          // two different sessions must not replay into each other. The
          // caller's session_id enters the scope tuple so each session has
          // its own idempotency namespace.
          const extraScope = resolveExtraScope(toolName, params);

          try {
            const checkResult = await idempotency.check({ principal, key, payload: params, extraScope });
            if (checkResult.kind === 'replay') {
              // The cache stores the already-formatted envelope (so
              // non-deterministic wrap fields like `confirmed_at` are
              // pinned to the first execution's values). Clone before
              // mutating so envelope stamps (replayed, echo-back context)
              // don't leak into the cache — the backend also clones on
              // read, but belt-and-suspenders: handler-returned objects
              // can alias pieces of the formatted envelope.
              const cachedFormatted = cloneFormattedResponse(checkResult.response as McpToolResponse);
              // Only stamp `replayed: true` on success envelopes — the
              // field is defined for successful replays, and transient
              // error cache entries (VALIDATION_ERROR from strict-mode
              // drift) are retry-storm guards, not spec replays.
              if (!isErrorResponse(cachedFormatted)) {
                stampReplayed(cachedFormatted);
              }
              return finalize(cachedFormatted);
            }
            if (checkResult.kind === 'conflict') {
              return finalize(
                adcpError('IDEMPOTENCY_CONFLICT', {
                  message:
                    'idempotency_key was used earlier with a different canonical payload. Use a fresh UUID v4, or resend the exact original payload.',
                })
              );
            }
            if (checkResult.kind === 'expired') {
              return finalize(
                adcpError('IDEMPOTENCY_EXPIRED', {
                  message: `idempotency_key is past the seller's replay window (${idempotency.ttlSeconds}s). Use a fresh UUID v4, or look up the resource by natural key if the prior call succeeded.`,
                })
              );
            }
            if (checkResult.kind === 'in-flight') {
              // A parallel request is currently executing this same key.
              // Tell the client to retry — returning SERVICE_UNAVAILABLE
              // with a short retry_after is transient-classified and the
              // buyer SDK auto-retries. Eventually the other request
              // completes and this retry either replays the cached
              // response or hits IDEMPOTENCY_CONFLICT.
              return finalize(
                adcpError('SERVICE_UNAVAILABLE', {
                  message: 'A parallel request with the same idempotency_key is still in flight. Retry shortly.',
                  retry_after: 1,
                })
              );
            }
            idempotencyCheck = { key, principal, payloadHash: checkResult.payloadHash, extraScope };
          } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            logger.error('Idempotency check failed', { tool: toolName, error: reason });
            return finalize(
              adcpError('SERVICE_UNAVAILABLE', {
                message: 'Idempotency check failed',
                ...(exposeErrorDetails && { details: { reason } }),
              })
            );
          }
        }

        // --- Handler ---
        try {
          const result = await handler(params, ctx);
          // Narrow Error / Submitted arms of the *Response union before
          // reaching the success-arm builder: wrap() on an Error payload
          // would still serialize it but apply success-shaped defaults
          // (revision, confirmed_at, 'Media buy undefined created') to
          // a shape that doesn't have those fields. Routing here keeps
          // the wire shape correct regardless of which arm the handler
          // chose to return.
          let formatted: McpToolResponse;
          if (isFormattedResponse(result)) {
            formatted = result;
          } else if (isSubmittedEnvelope(result)) {
            formatted = wrapSubmittedEnvelope(result);
          } else if (isErrorArm(result)) {
            // Log-warn (always) on spec-violating Error items — required
            // `code`/`message` are spec-mandatory on core/error.json. We
            // don't fail the response: response-schema validation is
            // already skipped for `isError: true` envelopes and flipping
            // a handler-returned Error arm into a framework VALIDATION_ERROR
            // would obscure the seller's intended error. A steady-state
            // warn is enough to surface drift in dev/test logs.
            const malformed = (result.errors as unknown[]).some(
              e =>
                e == null ||
                typeof e !== 'object' ||
                typeof (e as Record<string, unknown>).code !== 'string' ||
                typeof (e as Record<string, unknown>).message !== 'string'
            );
            if (malformed) {
              logger.warn(`Handler returned ${toolName} Error arm with spec-violating errors[]`, {
                tool: toolName,
                errors: result.errors,
              });
            }
            formatted = wrapErrorArm(result);
          } else {
            formatted = wrap(result);
          }

          // --- Test-controller bridge: augment get_products with seeded fixtures. ---
          // Only runs when the seller opted in via `testController.getSeededProducts`
          // AND the request carries a sandbox marker (account.sandbox === true or
          // context.sandbox === true). When `resolveAccount` returned a concrete
          // account, we additionally require `ctx.account.sandbox === true` so a
          // request that happens to include `account.sandbox: true` can't leak
          // fixtures into a non-sandbox resolved account (belt-and-suspenders).
          // Seeded products append to whatever the handler returned; `product_id`
          // collisions resolve with the seeded entry winning, so storyboards that
          // override default inventory see their fixture.
          if (
            toolName === 'get_products' &&
            testControllerBridge?.getSeededProducts &&
            !isErrorResponse(formatted) &&
            isSandboxRequestForSeeding(params) &&
            // If resolveAccount produced a record, require it to be flagged
            // sandbox too. If no account was resolved, the request-signal
            // check above is the only line of defense — keep that contract.
            (ctx.account === undefined ||
              (typeof ctx.account === 'object' &&
                ctx.account !== null &&
                (ctx.account as { sandbox?: unknown }).sandbox === true))
          ) {
            try {
              const bridgeCtx: TestControllerBridgeContext<TAccount> = { input: params };
              if (ctx.account !== undefined) bridgeCtx.account = ctx.account;
              const rawSeeded = await testControllerBridge.getSeededProducts(bridgeCtx);
              const seeded = filterValidSeededProducts(rawSeeded, logger);
              if (seeded.length > 0) {
                const sc = formatted.structuredContent as
                  | import('../types/tools.generated').GetProductsResponse
                  | undefined;
                if (sc && typeof sc === 'object') {
                  const merged = mergeSeededProductsIntoResponse(sc, seeded);
                  formatted = wrap(merged);
                }
              }
            } catch (err) {
              // Bridge failures are sandbox-only by construction, so logging +
              // returning the handler's response is the right default — a broken
              // test fixture shouldn't tank the request under test.
              const reason = err instanceof Error ? err.message : String(err);
              logger.warn('testController.getSeededProducts failed; returning handler response unchanged', {
                tool: toolName,
                error: reason,
              });
            }
          }

          // --- Response schema validation (opt-in) ---
          // Runs on the structured payload the handler produced. Errors
          // have their own envelope (`adcp_error`) and are skipped here —
          // their shape is enforced by the adcpError() builder.
          if (responseValidationMode !== 'off' && !isErrorResponse(formatted)) {
            const payload = formatted.structuredContent;
            const outcome = validateResponse(toolName, payload);
            if (!outcome.valid) {
              logger.warn(`Schema validation warning (response) for ${toolName}: ${formatIssues(outcome.issues)}`, {
                tool: toolName,
                issues: outcome.issues,
                variant: outcome.variant,
              });
              if (responseValidationMode === 'strict') {
                const errPayload = buildAdcpValidationErrorPayload(toolName, 'response', outcome.issues, {
                  exposeSchemaPath: exposeErrorDetails,
                });
                const errEnvelope = adcpError('VALIDATION_ERROR', errPayload);
                if (idempotencyCheck && idempotency) {
                  // Cache the VALIDATION_ERROR briefly so a buyer SDK
                  // retrying on the same key doesn't trigger unbounded
                  // re-execution — strict-mode drift is deterministic,
                  // the next handler call would return the same error.
                  // Short TTL (10s) absorbs a typical retry burst.
                  //
                  // Stores that pre-date #758 may not implement
                  // `saveTransientError`; fall back to `release` so the
                  // claim is at least freed for a fresh retry.
                  try {
                    if (idempotency.saveTransientError) {
                      await idempotency.saveTransientError({
                        principal: idempotencyCheck.principal,
                        key: idempotencyCheck.key,
                        payloadHash: idempotencyCheck.payloadHash,
                        response: errEnvelope,
                        extraScope: idempotencyCheck.extraScope,
                      });
                    } else {
                      await idempotency.release({
                        principal: idempotencyCheck.principal,
                        key: idempotencyCheck.key,
                        extraScope: idempotencyCheck.extraScope,
                      });
                    }
                  } catch (err) {
                    const reason = err instanceof Error ? err.message : String(err);
                    logger.warn('Idempotency transient-error cache failed — retry storm may re-execute handler', {
                      tool: toolName,
                      error: reason,
                    });
                  }
                }
                return finalize(errEnvelope);
              }
            }
          }
          // Cache successful mutations for replay. Errors re-execute on
          // retry, not replayed — only cache when the wrapped response is
          // not an error shape. Release the in-flight claim on error so a
          // retry can re-execute rather than replay the transient failure.
          //
          // Cache the FORMATTED envelope, not the raw handler return:
          // some wrap functions inject non-deterministic fields
          // (`confirmed_at = new Date().toISOString()`) when the handler
          // omits them. Re-wrapping on replay would produce a different
          // `confirmed_at` each time, breaking the "same response on
          // replay" contract. Caching the formatted envelope pins those
          // fields to their first-execution values.
          if (idempotencyCheck && idempotency) {
            if (!isErrorResponse(formatted)) {
              try {
                // Strip `context` before caching — it's a per-request echo
                // field (buyer's correlation_id), not part of the cached
                // payload. If we cached it, replays would return the
                // FIRST caller's correlation_id to every subsequent
                // retry, breaking end-to-end request tracing. On replay,
                // `finalize()` re-injects the current request's context.
                const cacheable = stripEnvelopeEcho(formatted);
                await idempotency.save({
                  principal: idempotencyCheck.principal,
                  key: idempotencyCheck.key,
                  payloadHash: idempotencyCheck.payloadHash,
                  response: cacheable,
                  extraScope: idempotencyCheck.extraScope,
                });
              } catch (err) {
                const reason = err instanceof Error ? err.message : String(err);
                logger.warn('Idempotency save failed — response will not be cached', {
                  tool: toolName,
                  error: reason,
                });
              }
              // Fresh-path responses omit `replayed` — per envelope spec,
              // absence signals fresh execution. The replay path stamps
              // `replayed: true` on the cached copy at retrieval.
            } else {
              try {
                await idempotency.release({
                  principal: idempotencyCheck.principal,
                  key: idempotencyCheck.key,
                  extraScope: idempotencyCheck.extraScope,
                });
              } catch (err) {
                // Best-effort release; if it fails the claim TTL will
                // eventually evict. Log and move on.
                const reason = err instanceof Error ? err.message : String(err);
                logger.warn('Idempotency release failed — in-flight claim will expire on TTL', {
                  tool: toolName,
                  error: reason,
                });
              }
            }
          }
          return finalize(formatted);
        } catch (err) {
          // Release the idempotency claim on any thrown path — whether
          // we unwrap a typed envelope or fall through to SERVICE_UNAVAILABLE,
          // the handler did not produce a cached response and the next retry
          // should proceed normally.
          if (idempotencyCheck && idempotency) {
            try {
              await idempotency.release({
                principal: idempotencyCheck.principal,
                key: idempotencyCheck.key,
                extraScope: idempotencyCheck.extraScope,
              });
            } catch (releaseErr) {
              const releaseReason = releaseErr instanceof Error ? releaseErr.message : String(releaseErr);
              logger.warn('Idempotency release failed — in-flight claim will expire on TTL', {
                tool: toolName,
                error: releaseReason,
              });
            }
          }
          // Auto-unwrap `throw adcpError(...)`. Handlers that throw an
          // envelope (instead of returning it) should behave identically —
          // otherwise the envelope surfaces as `[object Object]` inside
          // SERVICE_UNAVAILABLE and the buyer loses the typed domain code.
          // Matrix harnesses and fresh-built agents consistently get this
          // wrong; unwrapping at the dispatcher closes the class of bugs
          // instead of relying on every skill to show `return` over `throw`.
          if (isThrownAdcpError(err)) {
            const env = (err.structuredContent as { adcp_error: { code: string; message: string } }).adcp_error;
            // Log message + stack so forensic review sees what was thrown
            // (not just the code). The thrown envelope is a plain object so
            // `.stack` is typically absent, but authors sometimes subclass
            // `Error` and attach envelope fields; capture it defensively.
            logger.warn('Handler threw an adcpError envelope — prefer `return` over `throw` for typed errors', {
              tool: toolName,
              handler: handlerKey,
              code: env.code,
              message: env.message,
              stack: err instanceof Error ? err.stack : undefined,
            });
            return finalize(err);
          }
          const reason = err instanceof Error ? err.message : String(err);
          // Log the full stack — `logger.error` with just the message turned
          // every "Handler failed" into a guessing game for agent authors.
          // Stack tells you which import/typo/access chain blew up.
          logger.error('Handler failed', {
            tool: toolName,
            handler: handlerKey,
            error: reason,
            stack: err instanceof Error ? err.stack : undefined,
          });
          return finalize(
            adcpError('SERVICE_UNAVAILABLE', {
              // Include the cause message directly in the response text when
              // `exposeErrorDetails` is on. The opaque
              // "Tool X encountered an internal error" string cost us weeks
              // of diagnostic time on the matrix harness — dev callers want
              // the real reason at the call site, not hidden in server logs.
              message: exposeErrorDetails
                ? `Tool ${toolName} handler threw: ${reason}`
                : `Tool ${toolName} encountered an internal error`,
              ...(exposeErrorDetails && { details: { reason, handler: handlerKey } }),
            })
          );
        }
      };

      // Register a PASSTHROUGH input schema (#909). The MCP SDK's Zod
      // validator only fires on the MCP transport — A2A calls the
      // handler via AdcpServer.invoke(), bypassing it. Registering the
      // real per-tool Zod schema meant MCP and A2A produced different
      // verdicts and different error shapes for the same malformed
      // request. Our framework request validator (AJV, loaded from
      // schemas/cache/<version>/) runs inside the handler closure on
      // BOTH transports and produces a structured adcp_error envelope;
      // make it authoritative.
      //
      // Passthrough (not omit): the SDK's `validateToolInput` returns
      // `undefined` when `inputSchema` is absent (see @modelcontextprotocol/sdk
      // server/mcp.js), and passes that `undefined` verbatim to the
      // handler — destroying the actual arguments. `z.object({}).passthrough()`
      // keeps every key intact, so args still reach the closure.
      //
      // For `tools/list` advertising, use the raw JSON request schema from
      // `schemas/cache/{version}/bundled/` when available (#954). Only bundled
      // (pre-resolved) schemas are safe — flat-tree schemas have unresolved
      // `$ref`s that would appear as broken fragments to buyer clients.
      // `getRawRequestSchema` relaxes `additionalProperties: false` at the
      // root so the SDK does not reject envelope fields if it validates.
      // Falls back to the passthrough Zod schema for flat-tree tools and
      // when schemas are not yet synced.
      // `AnySchema` (from @modelcontextprotocol/sdk/server/zod-compat.js) accepts
      // both Zod objects and raw JSON Schema objects. The cast is safe: when a
      // raw JSON Schema is passed, the SDK uses it for tools/list serialisation
      // only and does not call .parse() on it — argument delivery falls through
      // to the handler unchanged, same as the Zod passthrough path.
      const advertisedInputSchema =
        (getRawRequestSchema(toolName) as Parameters<typeof server.registerTool>[1]['inputSchema']) ??
        PASSTHROUGH_INPUT_SCHEMA;
      server.registerTool(
        toolName,
        {
          inputSchema: advertisedInputSchema,
          ...(meta?.annotations != null && { annotations: meta.annotations }),
        },
        toolHandler as Parameters<typeof server.registerTool>[2]
      );

      registeredToolNames.add(toolName);
    }
  }

  // ─── Custom tools ──────────────────────────────────────────
  // Seller extensions outside AdcpToolMap. No idempotency / governance /
  // response-wrapping — handlers own those concerns directly. Registered
  // after spec tools so the collision check can authoritatively block
  // overlap with framework-owned names.
  if (config.customTools) {
    const customNames = Object.keys(config.customTools);
    for (const customName of customNames) {
      if (registeredToolNames.has(customName)) {
        throw new Error(
          `createAdcpServer: customTools["${customName}"] collides with a framework-registered tool. ` +
            `Rename the custom tool or remove the handler from the conflicting domain group.`
        );
      }
      if (customName === 'get_adcp_capabilities') {
        throw new Error(
          `createAdcpServer: customTools["get_adcp_capabilities"] is not allowed. ` +
            `The framework auto-generates this tool from registered handlers and capability config.`
        );
      }
      const custom = config.customTools[customName];
      if (!custom) continue;
      const { description, title, inputSchema, outputSchema, annotations, handler } = custom;
      server.registerTool(
        customName,
        {
          ...(description != null && { description }),
          ...(title != null && { title }),
          ...(inputSchema != null && { inputSchema }),
          ...(outputSchema != null && { outputSchema }),
          ...(annotations != null && { annotations }),
        } as Parameters<typeof server.registerTool>[1],
        handler as Parameters<typeof server.registerTool>[2]
      );
      registeredToolNames.add(customName);
    }
  }

  // Tool coherence warnings
  checkCoherence(registeredToolNames, logger);

  // --- Idempotency configuration guardrails ---
  //
  // A seller that registers mutating handlers but doesn't supply an
  // `idempotency` store cannot honor the v3 retry contract: buyer
  // retries will double-book because there's no replay cache. The
  // framework logs a loud error at server-creation time so operators
  // notice before shipping to production, but doesn't throw — that
  // would make the framework unusable in testing contexts where
  // idempotency isn't the unit-under-test. Operators who've thought
  // about it can suppress the error by setting
  // `capabilities.idempotency.replay_ttl_seconds` directly.
  const registeredMutatingTools = [...registeredToolNames].filter(t => MUTATING_TASKS.has(t));
  if (
    registeredMutatingTools.length > 0 &&
    !idempotency &&
    !idempotencyDisabled &&
    !capConfig?.idempotency?.replay_ttl_seconds
  ) {
    logger.error(
      `createAdcpServer: ${registeredMutatingTools.length} mutating tools registered ` +
        `(${registeredMutatingTools.slice(0, 3).join(', ')}${
          registeredMutatingTools.length > 3 ? ', ...' : ''
        }) without an idempotency store. AdCP v3 requires sellers to support idempotent replay ` +
        `on mutating requests — buyer retries will double-book without it. ` +
        `Pass \`idempotency: createIdempotencyStore({ backend, ttlSeconds })\`, ` +
        `or set \`capabilities.idempotency.replay_ttl_seconds\` to acknowledge the non-compliance.`
    );
  }

  // MUTATING_TASKS is derived at module load by introspecting Zod
  // schemas. If Zod's internals change or the tool-request-schemas map
  // shifts, the derivation can silently return an empty set — which
  // would make every mutating request bypass idempotency enforcement.
  // Fail loud at server startup if the introspection produced
  // surprisingly few results.
  if (MUTATING_TASKS.size < 20) {
    throw new Error(
      `createAdcpServer: MUTATING_TASKS set has only ${MUTATING_TASKS.size} entries — expected at least 20. ` +
        `Schema introspection likely broke (Zod upgrade? tool-request-schemas change?). ` +
        `Check \`src/lib/utils/idempotency.ts:deriveMutatingTasks\`.`
    );
  }

  // --- Auto-register get_adcp_capabilities ---
  const protocols = detectProtocols([...registeredToolNames]);

  // Idempotency capability declaration. Spec defines a discriminated
  // union (`get-adcp-capabilities-response.json` `adcp.idempotency.oneOf`):
  //   - `IdempotencySupported`  → `{ supported: true,  replay_ttl_seconds: N }`
  //   - `IdempotencyUnsupported` → `{ supported: false }` (replay_ttl_seconds MUST be absent)
  // Disabled mode flips to `IdempotencyUnsupported` so the wire contract
  // matches actual behavior — buyers reading capabilities can fall back to
  // natural-key dedup before retrying spend-committing operations. Lying
  // here (declaring `supported: true` while skipping replay) is a
  // money-flow footgun: a 504-retry under the same key double-books.
  const idempotencyCapability: GetAdCPCapabilitiesResponse['adcp']['idempotency'] = idempotencyDisabled
    ? { supported: false }
    : {
        supported: true,
        replay_ttl_seconds: clampReplayTtl(
          capConfig?.idempotency?.replay_ttl_seconds ?? idempotency?.ttlSeconds ?? 86400
        ),
      };

  const capabilitiesData: GetAdCPCapabilitiesResponse = {
    adcp: {
      major_versions: capConfig?.major_versions ?? [3],
      idempotency: idempotencyCapability,
    },
    supported_protocols: protocols as GetAdCPCapabilitiesResponse['supported_protocols'],
  };

  if (protocols.includes('media_buy') || capConfig?.features) {
    capabilitiesData.media_buy = {
      features: {
        inline_creative_management: capConfig?.features?.inlineCreativeManagement ?? false,
        property_list_filtering: capConfig?.features?.propertyListFiltering ?? false,
        content_standards: capConfig?.features?.contentStandards ?? false,
        conversion_tracking: capConfig?.features?.conversionTracking ?? false,
        audience_targeting: capConfig?.features?.audienceTargeting ?? false,
      },
      ...(capConfig?.portfolio && { portfolio: capConfig.portfolio }),
    };
  }

  if (capConfig?.account) {
    capabilitiesData.account = {
      require_operator_auth: capConfig.account.requireOperatorAuth ?? false,
      ...(capConfig.account.authorizationEndpoint && {
        authorization_endpoint: capConfig.account.authorizationEndpoint,
      }),
      supported_billing: capConfig.account.supportedBilling ?? [],
      ...(capConfig.account.defaultBilling && { default_billing: capConfig.account.defaultBilling }),
      required_for_products: capConfig.account.requiredForProducts ?? false,
      sandbox: capConfig.account.sandbox ?? false,
    };
  }

  if (capConfig?.creative) {
    capabilitiesData.creative = {
      supports_compliance: capConfig.creative.supportsCompliance ?? false,
      has_creative_library: capConfig.creative.hasCreativeLibrary ?? false,
      supports_generation: capConfig.creative.supportsGeneration ?? false,
      supports_transformation: capConfig.creative.supportsTransformation ?? false,
    };
  }

  if (capConfig?.extensions_supported?.length) {
    capabilitiesData.extensions_supported = capConfig.extensions_supported;
  }

  if (capConfig?.request_signing) {
    capabilitiesData.request_signing = capConfig.request_signing;
  }

  if (capConfig?.specialisms?.length) {
    capabilitiesData.specialisms = capConfig.specialisms;
  }

  if (capConfig?.overrides) {
    applyCapabilityOverrides(capabilitiesData, capConfig.overrides);
  }

  // Passthrough inputSchema — framework validation is authoritative on
  // both transports (#909). Same rationale as the domain-tool loop above.
  server.registerTool(
    'get_adcp_capabilities',
    {
      inputSchema: PASSTHROUGH_INPUT_SCHEMA,
      annotations: { readOnlyHint: true },
    },
    (async (params: any) => {
      const data = { ...capabilitiesData };
      const ctx = params?.context;
      if (ctx !== null && typeof ctx === 'object' && !Array.isArray(ctx)) {
        (data as any).context = ctx;
      }
      return capabilitiesResponse(data);
    }) as Parameters<typeof server.registerTool>[2]
  );

  const compliance = {
    async reset({
      force = false,
      allowProduction = false,
    }: { force?: boolean; allowProduction?: boolean } = {}): Promise<void> {
      // Check NODE_ENV BEFORE store-shape probes: the environment guard
      // is the strongest signal that "this is not a test harness." An
      // operator who reached this call in production by mistake hits the
      // env gate regardless of which backend they wired.
      if (!allowProduction && process.env.NODE_ENV === 'production') {
        throw new Error(
          'AdcpServer.compliance.reset: refused to run with NODE_ENV=production. ' +
            'Pass `{ allowProduction: true }` if you deliberately set NODE_ENV=production in a test environment, ' +
            'or unset NODE_ENV before running storyboards.'
        );
      }
      // Positive allowlist for stores, not method-presence. A
      // PostgresStateStore might expose `.clear()` for its own test
      // utility needs — we don't want method-existence alone to permit
      // a flush that would take out a shared test cluster. `force: true`
      // is the documented opt-in for non-memory backends.
      const stateStoreIsMemory = stateStore instanceof InMemoryStateStore;
      const idempotencyIsFlushable = !idempotency || hasIdempotencyClearAll(idempotency);
      if (!force) {
        if (!stateStoreIsMemory) {
          throw new Error(
            'AdcpServer.compliance.reset: configured stateStore is not InMemoryStateStore. ' +
              'Pass `{ force: true }` to acknowledge that flushing the configured backend is safe for this environment ' +
              '(e.g., a disposable test Postgres).'
          );
        }
        if (!idempotencyIsFlushable) {
          throw new Error(
            'AdcpServer.compliance.reset: configured idempotency backend does not expose `clearAll()`. ' +
              'Use `memoryBackend()` for test harnesses, or pass `{ force: true }` to skip idempotency flush.'
          );
        }
      }
      // `force` bypasses the allowlist checks but never the flush
      // itself — if we reached here, the caller wants the flush to
      // happen. `clear()` is only called when the store exposes it;
      // a store without `clear()` reaching here under `force: true`
      // is a no-op for the state side, which matches the shape the
      // caller opted into.
      const storeWithClear = stateStore as unknown as { clear?: () => void };
      if (typeof storeWithClear.clear === 'function') storeWithClear.clear();
      if (idempotency && idempotency.clearAll) await idempotency.clearAll();
    },
  };
  const wrapped: AdcpServerInternal = wrapMcpServer(server, compliance);

  // Attach the auto-wired preTransport so `serve()` mounts the verifier
  // on the HTTP transport. Stashed under a non-enumerable symbol property
  // on the wrapper — it's a private contract between this function and
  // `serve()` for wiring, not part of the AdcpServer public API.
  if (signedRequests) {
    const preTransport = buildSignedRequestsPreTransport(signedRequests, capConfig?.request_signing?.required_for);
    Object.defineProperty(wrapped, ADCP_PRE_TRANSPORT, {
      value: preTransport,
      enumerable: false,
      writable: false,
      configurable: true,
    });
  }

  const signedRequestsState: AdcpSignedRequestsState = {
    autoWired: Boolean(signedRequests),
    specialismClaimed: claimsSignedRequests,
    capabilitySupported: capConfig?.request_signing?.supported === true,
    mismatch: claimsSignedRequests && !signedRequests ? 'claim_without_config' : 'ok',
  };
  Object.defineProperty(wrapped, ADCP_SIGNED_REQUESTS_STATE, {
    value: signedRequestsState,
    enumerable: false,
    configurable: true,
    writable: false,
  });
  Object.defineProperty(wrapped, ADCP_STATE_STORE, {
    value: stateStore,
    enumerable: false,
    configurable: true,
    writable: false,
  });
  // Expose the capabilitiesData object so post-registration helpers
  // (registerTestController) can add spec-defined capability blocks
  // — comply_test_controller is registered AFTER createAdcpServer,
  // so the compliance_testing block can't be emitted eagerly.
  Object.defineProperty(wrapped, ADCP_CAPABILITIES, {
    value: capabilitiesData,
    enumerable: false,
    configurable: true,
    writable: false,
  });

  logger.info('AdCP server created', {
    tools: [...registeredToolNames],
    protocols,
    signedRequests: signedRequestsState,
  });

  return wrapped;
}
