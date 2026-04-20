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
 *   resolveAccount: async (ref) => db.findAccount(ref),
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

import type { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createTaskCapableServer } from './tasks';
import type { TaskStore, TaskMessageQueue } from './tasks';
import { adcpError } from './errors';
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
  toStructuredContent,
  type McpToolResponse,
} from './responses';

import { TOOL_REQUEST_SCHEMAS } from '../utils/tool-request-schemas';
import { isMutatingTask, IDEMPOTENCY_KEY_PATTERN, MUTATING_TASKS } from '../utils/idempotency';
import type { IdempotencyStore } from './idempotency';
import {
  createWebhookEmitter,
  type WebhookEmitParams,
  type WebhookEmitResult,
  type WebhookEmitterOptions,
} from './webhook-emitter';
import { createExpressVerifier, type ExpressLike } from '../signing/middleware';
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
  GetProductsResponse,
  CreateMediaBuySuccess,
  UpdateMediaBuySuccess,
  GetMediaBuysResponse,
  GetMediaBuyDeliveryResponse,
  ListAccountsResponse,
  ListCreativeFormatsResponse,
  ProvidePerformanceFeedbackSuccess,
  BuildCreativeSuccess,
  BuildCreativeMultiSuccess,
  GetCreativeDeliveryResponse,
  ListCreativesResponse,
  SyncCreativesSuccess,
  GetSignalsResponse,
  ActivateSignalSuccess,
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
  LogEventSuccess,
  SyncAudiencesSuccess,
  SyncCatalogsSuccess,
  SyncAccountsSuccess,
  SyncGovernanceSuccess,
  GetAccountFinancialsSuccess,
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

export interface AdcpToolMap {
  get_products: { params: z.input<typeof GetProductsRequestSchema>; result: GetProductsResponse };
  create_media_buy: { params: z.input<typeof CreateMediaBuyRequestSchema>; result: CreateMediaBuySuccess };
  update_media_buy: { params: z.input<typeof UpdateMediaBuyRequestSchema>; result: UpdateMediaBuySuccess };
  get_media_buys: { params: z.input<typeof GetMediaBuysRequestSchema>; result: GetMediaBuysResponse };
  get_media_buy_delivery: {
    params: z.input<typeof GetMediaBuyDeliveryRequestSchema>;
    result: GetMediaBuyDeliveryResponse;
  };
  provide_performance_feedback: {
    params: z.input<typeof ProvidePerformanceFeedbackRequestSchema>;
    result: ProvidePerformanceFeedbackSuccess;
  };
  list_creative_formats: {
    params: z.input<typeof ListCreativeFormatsRequestSchema>;
    result: ListCreativeFormatsResponse;
  };
  build_creative: {
    params: z.input<typeof BuildCreativeRequestSchema>;
    result: BuildCreativeSuccess | BuildCreativeMultiSuccess;
  };
  preview_creative: { params: z.input<typeof PreviewCreativeRequestSchema>; result: PreviewCreativeResponse };
  get_creative_delivery: {
    params: z.input<typeof GetCreativeDeliveryRequestSchema>;
    result: GetCreativeDeliveryResponse;
  };
  list_creatives: { params: z.input<typeof ListCreativesRequestSchema>; result: ListCreativesResponse };
  sync_creatives: { params: z.input<typeof SyncCreativesRequestSchema>; result: SyncCreativesSuccess };
  get_signals: { params: z.input<typeof GetSignalsRequestSchema>; result: GetSignalsResponse };
  activate_signal: { params: z.input<typeof ActivateSignalRequestSchema>; result: ActivateSignalSuccess };
  list_accounts: { params: z.input<typeof ListAccountsRequestSchema>; result: ListAccountsResponse };
  sync_accounts: { params: z.input<typeof SyncAccountsRequestSchema>; result: SyncAccountsSuccess };
  sync_governance: { params: z.input<typeof SyncGovernanceRequestSchema>; result: SyncGovernanceSuccess };
  get_account_financials: {
    params: z.input<typeof GetAccountFinancialsRequestSchema>;
    result: GetAccountFinancialsSuccess;
  };
  report_usage: { params: z.input<typeof ReportUsageRequestSchema>; result: ReportUsageResponse };
  sync_event_sources: { params: z.input<typeof SyncEventSourcesRequestSchema>; result: SyncEventSourcesSuccess };
  log_event: { params: z.input<typeof LogEventRequestSchema>; result: LogEventSuccess };
  sync_audiences: { params: z.input<typeof SyncAudiencesRequestSchema>; result: SyncAudiencesSuccess };
  sync_catalogs: { params: z.input<typeof SyncCatalogsRequestSchema>; result: SyncCatalogsSuccess };
  create_property_list: { params: z.input<typeof CreatePropertyListRequestSchema>; result: CreatePropertyListResponse };
  update_property_list: { params: z.input<typeof UpdatePropertyListRequestSchema>; result: UpdatePropertyListResponse };
  get_property_list: { params: z.input<typeof GetPropertyListRequestSchema>; result: GetPropertyListResponse };
  list_property_lists: { params: z.input<typeof ListPropertyListsRequestSchema>; result: ListPropertyListsResponse };
  delete_property_list: { params: z.input<typeof DeletePropertyListRequestSchema>; result: DeletePropertyListResponse };
  list_content_standards: {
    params: z.input<typeof ListContentStandardsRequestSchema>;
    result: ListContentStandardsResponse;
  };
  get_content_standards: {
    params: z.input<typeof GetContentStandardsRequestSchema>;
    result: GetContentStandardsResponse;
  };
  create_content_standards: {
    params: z.input<typeof CreateContentStandardsRequestSchema>;
    result: CreateContentStandardsResponse;
  };
  update_content_standards: {
    params: z.input<typeof UpdateContentStandardsRequestSchema>;
    result: UpdateContentStandardsResponse;
  };
  calibrate_content: { params: z.input<typeof CalibrateContentRequestSchema>; result: CalibrateContentResponse };
  validate_content_delivery: {
    params: z.input<typeof ValidateContentDeliveryRequestSchema>;
    result: ValidateContentDeliveryResponse;
  };
  get_media_buy_artifacts: {
    params: z.input<typeof GetMediaBuyArtifactsRequestSchema>;
    result: GetMediaBuyArtifactsResponse;
  };
  get_creative_features: {
    params: z.input<typeof GetCreativeFeaturesRequestSchema>;
    result: GetCreativeFeaturesResponse;
  };
  sync_plans: { params: z.input<typeof SyncPlansRequestSchema>; result: SyncPlansResponse };
  check_governance: { params: z.input<typeof CheckGovernanceRequestSchema>; result: CheckGovernanceResponse };
  report_plan_outcome: { params: z.input<typeof ReportPlanOutcomeRequestSchema>; result: ReportPlanOutcomeResponse };
  get_plan_audit_logs: { params: z.input<typeof GetPlanAuditLogsRequestSchema>; result: GetPlanAuditLogsResponse };
  si_get_offering: { params: z.input<typeof SIGetOfferingRequestSchema>; result: SIGetOfferingResponse };
  si_initiate_session: { params: z.input<typeof SIInitiateSessionRequestSchema>; result: SIInitiateSessionResponse };
  si_send_message: { params: z.input<typeof SISendMessageRequestSchema>; result: SISendMessageResponse };
  si_terminate_session: { params: z.input<typeof SITerminateSessionRequestSchema>; result: SITerminateSessionResponse };

  // Brand rights — response types are not yet code-generated. Handlers return
  // loose records which the framework wraps with `genericResponse`.
  get_brand_identity: { params: z.input<typeof GetBrandIdentityRequestSchema>; result: Record<string, unknown> };
  get_rights: { params: z.input<typeof GetRightsRequestSchema>; result: Record<string, unknown> };
  acquire_rights: { params: z.input<typeof AcquireRightsRequestSchema>; result: Record<string, unknown> };
}

export type AdcpServerToolName = keyof AdcpToolMap;

// ---------------------------------------------------------------------------
// Domain handler types
// ---------------------------------------------------------------------------

/** Handler that receives validated params and a resolved context.
 *  Return the exact response type for autocomplete, or a plain object —
 *  the response builder layer handles shaping either way. */
type DomainHandler<K extends AdcpServerToolName, TAccount> = (
  params: AdcpToolMap[K]['params'],
  ctx: HandlerContext<TAccount>
) => Promise<AdcpToolMap[K]['result'] | McpToolResponse | Record<string, unknown>>;

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
// Server config
// ---------------------------------------------------------------------------

export interface AdcpServerConfig<TAccount = unknown> {
  name: string;
  version: string;

  /**
   * Resolve an account from an AccountReference.
   * Called on every request that has an `account` field.
   * Return null if the account doesn't exist — framework responds ACCOUNT_NOT_FOUND.
   */
  resolveAccount?: (ref: AccountReference) => Promise<TAccount | null>;

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
   * Defaults to `false`. Enable in trusted environments when you want
   * debuggable failures at the call site.
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
   */
  idempotency?: IdempotencyStore;
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
 * Set `replayed` on the response envelope (MCP structuredContent).
 * Both fresh executions (`false`) and replays (`true`) carry the field,
 * per spec — a buyer that checks `replayed` to decide whether side
 * effects already fired needs the field present on every mutating
 * response, not just replays.
 */
function injectReplayed(response: McpToolResponse, value: boolean): void {
  if (response.structuredContent && typeof response.structuredContent === 'object') {
    (response.structuredContent as Record<string, unknown>).replayed = value;
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
  sync_accounts: { wrap: null, annotations: IDEMP },
  sync_governance: { wrap: null, annotations: IDEMP },
  get_account_financials: { wrap: null, annotations: RO },
  report_usage: { wrap: null, annotations: MUT },

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
  acquire_rights: { wrap: null, annotations: MUT },
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

// Echo the request context into a formatted MCP tool response so buyers can
// trace correlation_id across both success and error responses.
function injectContextIntoResponse(response: McpToolResponse, context: unknown): void {
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
function buildSignedRequestsPreTransport(signedRequests: SignedRequestsConfig): AdcpPreTransport {
  const verifier = createExpressVerifier({
    capability: {
      supported: true,
      covers_content_digest: signedRequests.covers_content_digest ?? 'either',
      required_for: signedRequests.required_for ?? [...MUTATING_TASKS],
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
    await new Promise<void>(resolve =>
      verifier(reqShim, resShim, err => {
        if (err) {
          // Log internally; a leaked stack trace to the caller would enumerate
          // the verifier pipeline (js/stack-trace-exposure).
          console.error('[adcp/signed-requests] verifier middleware error:', err);
          if (!res.writableEnded) {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'verifier_error' }));
          }
          handled = true;
        }
        // createExpressVerifier's 401 path ends the response directly.
        if (res.writableEnded) handled = true;
        resolve();
      })
    );
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
export function createAdcpServer<TAccount = unknown>(config: AdcpServerConfig<TAccount>): McpServer {
  const {
    name,
    version,
    resolveAccount,
    resolveSessionKey,
    exposeErrorDetails = false,
    stateStore = new InMemoryStateStore(),
    logger = noopLogger,
    capabilities: capConfig,
    idempotency,
    resolveIdempotencyPrincipal,
    instructions,
    taskStore,
    taskMessageQueue,
    webhooks,
    signedRequests,
  } = config;

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
        'and omitting the claim means they won\'t sign their requests.'
    );
  }
  if (claimsSignedRequests && !signedRequests) {
    logger.error(
      'createAdcpServer: `capabilities.specialisms` claims "signed-requests" but no `signedRequests` config was provided. ' +
        'Either pass `signedRequests: { jwks, replayStore, revocationStore }` to auto-wire the verifier, or ensure you wire ' +
        'one manually via `serve({ preTransport })`. Claiming the specialism without verifying signatures is a spec violation.'
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
        const finalize = (response: McpToolResponse): McpToolResponse => {
          if (params.context !== undefined && params.context !== null) {
            injectContextIntoResponse(response, params.context);
          }
          return response;
        };

        // --- Account resolution ---
        if (hasAccount && params.account != null && resolveAccount) {
          try {
            const account = await resolveAccount(params.account);
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

        // --- Idempotency (mutating tools only) ---
        const toolIsMutating = isMutatingTask(toolName);
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
          // Enforce the spec pattern server-side — defense-in-depth against
          // buyers that bypass MCP schema validation (different transport,
          // bespoke client). Low-entropy keys pollute the cache and enable
          // enumeration; keys containing \u0000 would collide with the
          // internal scope separator.
          if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
            return finalize(
              adcpError('INVALID_REQUEST', {
                message: 'idempotency_key must match the spec pattern ^[A-Za-z0-9_.:-]{16,255}$',
                field: 'idempotency_key',
              })
            );
          }
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
              injectReplayed(cachedFormatted, true);
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
          const formatted: McpToolResponse = isFormattedResponse(result) ? result : wrap(result);
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
              // Stamp replayed:false AFTER caching so the cached copy has
              // no pre-baked value. On replay we inject replayed:true
              // from the replay path, overwriting anything.
              injectReplayed(formatted, false);
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
          const reason = err instanceof Error ? err.message : String(err);
          logger.error('Handler failed', { tool: toolName, error: reason });
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
          return finalize(
            adcpError('SERVICE_UNAVAILABLE', {
              message: `Tool ${toolName} encountered an internal error`,
              ...(exposeErrorDetails && { details: { reason } }),
            })
          );
        }
      };

      // When idempotency is wired and the tool is mutating, relax
      // `idempotency_key` to optional in the MCP-level input schema. The
      // middleware is authoritative for this field and returns a properly-
      // shaped `adcp_error` (with `code`, `field`, `recovery`) on missing
      // or malformed keys. If we let the MCP SDK's schema validator
      // reject the request first, buyers get a text-only `-32602` error
      // instead of the structured compliance error — breaking the
      // idempotency storyboard's `error_code` validation.
      const registersAsMutating = isMutatingTask(toolName);
      const idempKeyField = (schema.shape as any).idempotency_key;
      const toolShape =
        idempotency && registersAsMutating && typeof idempKeyField?.optional === 'function'
          ? { ...(schema.shape as any), idempotency_key: idempKeyField.optional() }
          : schema.shape;
      server.tool(toolName, toolShape as any, toolHandler);
      if (meta?.annotations) {
        const registered = (server as any)._registeredTools[toolName];
        if (registered?.update) {
          registered.update({ annotations: meta.annotations });
        }
      }

      registeredToolNames.add(toolName);
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
  if (registeredMutatingTools.length > 0 && !idempotency && !capConfig?.idempotency?.replay_ttl_seconds) {
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

  const capabilitiesData: GetAdCPCapabilitiesResponse = {
    adcp: {
      major_versions: capConfig?.major_versions ?? [3],
      // When an idempotency store is wired, pull the TTL from the store
      // (so declared capability matches actual behavior). Fall back to
      // explicit capConfig, else to the 24h spec-recommended default.
      // clampReplayTtl guards against out-of-spec values in capConfig.
      idempotency: {
        supported: true,
        replay_ttl_seconds: clampReplayTtl(
          capConfig?.idempotency?.replay_ttl_seconds ?? idempotency?.ttlSeconds ?? 86400
        ),
      },
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

  const capSchema = TOOL_REQUEST_SCHEMAS['get_adcp_capabilities'] as { shape: Record<string, unknown> } | undefined;
  server.tool('get_adcp_capabilities', capSchema?.shape ?? {}, async (params: any) => {
    const data = { ...capabilitiesData };
    if (params?.context != null) {
      (data as any).context = params.context;
    }
    return capabilitiesResponse(data);
  });

  // Attach the auto-wired preTransport so `serve()` mounts the verifier
  // on the HTTP transport. A non-enumerable symbol property keeps this off
  // the normal McpServer surface — it's a private contract between this
  // function and `serve()` for wiring, not part of the McpServer public API.
  if (signedRequests) {
    const preTransport = buildSignedRequestsPreTransport(signedRequests);
    Object.defineProperty(server, ADCP_PRE_TRANSPORT, {
      value: preTransport,
      enumerable: false,
      writable: false,
      configurable: true,
    });
  }

  logger.info('AdCP server created', {
    tools: [...registeredToolNames],
    protocols,
    signedRequestsAutoWired: Boolean(signedRequests),
  });

  return server;
}
