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
}

/** Request metadata passed to `resolveSessionKey` so the hook can derive a key from any field. */
export interface SessionKeyContext<TAccount = unknown> {
  toolName: AdcpServerToolName;
  params: Record<string, unknown>;
  account?: TAccount;
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
  portfolio?: {
    publisher_domains: string[];
    primary_channels?: MediaChannel[];
    primary_countries?: string[];
    description?: string;
    advertising_policies?: string;
  };
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
  instructions?: string;
  taskStore?: TaskStore;
  taskMessageQueue?: TaskMessageQueue;
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
    stateStore = new InMemoryStateStore(),
    logger = noopLogger,
    capabilities: capConfig,
    instructions,
    taskStore,
    taskMessageQueue,
  } = config;

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
      const toolHandler = async (params: any, _extra: any) => {
        const ctx: HandlerContext<TAccount> = { store: stateStore };

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
            logger.error('Account resolution failed', {
              tool: toolName,
              error: err instanceof Error ? err.message : String(err),
            });
            return finalize(
              adcpError('SERVICE_UNAVAILABLE', {
                message: 'Account resolution failed',
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
            logger.error('Session key resolution failed', {
              tool: toolName,
              error: err instanceof Error ? err.message : String(err),
            });
            return finalize(
              adcpError('SERVICE_UNAVAILABLE', {
                message: 'Session key resolution failed',
              })
            );
          }
        }

        // --- Handler ---
        try {
          const result = await handler(params, ctx);
          const formatted: McpToolResponse = isFormattedResponse(result) ? result : wrap(result);
          return finalize(formatted);
        } catch (err) {
          logger.error('Handler failed', {
            tool: toolName,
            error: err instanceof Error ? err.message : String(err),
          });
          return finalize(
            adcpError('SERVICE_UNAVAILABLE', {
              message: `Tool ${toolName} encountered an internal error`,
            })
          );
        }
      };

      server.tool(toolName, schema.shape as any, toolHandler);
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

  // --- Auto-register get_adcp_capabilities ---
  const protocols = detectProtocols([...registeredToolNames]);

  const capabilitiesData: GetAdCPCapabilitiesResponse = {
    adcp: { major_versions: capConfig?.major_versions ?? [3] },
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

  const capSchema = TOOL_REQUEST_SCHEMAS['get_adcp_capabilities'] as { shape: Record<string, unknown> } | undefined;
  server.tool('get_adcp_capabilities', capSchema?.shape ?? {}, async (params: any) => {
    const data = { ...capabilitiesData };
    if (params?.context != null) {
      (data as any).context = params.context;
    }
    return capabilitiesResponse(data);
  });

  logger.info('AdCP server created', {
    tools: [...registeredToolNames],
    protocols,
  });

  return server;
}
