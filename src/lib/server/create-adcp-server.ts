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
 * import { createAdcpServer, serve } from '@adcp/sdk/server/legacy/v5';
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
import { parseAdcpMajorVersion, toReleasePrecisionVersion, type AdcpVersion } from '../version';
import { resolveAdcpVersion } from '../utils/adcp-version-config';
import { resolveBundleKey } from '../validation/schema-loader';
import { TOOL_INPUT_SHAPES } from '../schemas';
import { bundleSupportsAdcpVersionField } from '../protocols';
import { getToolsWithErrorArm, type ErrorArmDescriptor } from './error-arm-tools';
import type { ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ZodRawShapeCompat, AnySchema } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import {
  ADCP_CAPABILITIES,
  ADCP_STATE_STORE,
  wrapMcpServer,
  setSdkServerInstructions,
  setMcpAppResources,
  wrapInitializeHandler,
  type AdcpServer,
  type AdcpServerInternal,
} from './adcp-server';
import {
  mcpAppResourceMetadata,
  normalizeMcpAppResources,
  readMcpAppResource,
  type AdcpMcpResourceDefinition,
} from './mcp-app';
import { createTaskCapableServer, InMemoryTaskStore } from './tasks';
import type { TaskStore, TaskMessageQueue } from './tasks';
import { adcpError, applyAdcpErrorAllowlist, sanitizeStructuredAdcpError } from './errors';
import type { BuyerAgent, BuyerAgentRegistry } from './decisioning/buyer-agent';
import type { ResolvedAuthInfo } from './decisioning/account';
import type { TaskRecord, TaskRegistry } from './decisioning/runtime/task-registry';
import { protocolForTool } from './decisioning/runtime/protocol-for-tool';
import { AdcpError } from './decisioning/async-outcome';
import { redactCredentialPatterns } from './redact';
import {
  scanArgsForCredentials,
  resolveCredentialPolicyForTool,
  validateCredentialPolicy,
  type CredentialPolicy,
} from './credential-policy';
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
  updateRightsResponse,
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
import { validateRequest, validateResponse, formatIssues, type ValidationIssue } from '../validation/schema-validator';
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
  mergeSeededCreativesIntoResponse,
  mergeSeededMediaBuysIntoResponse,
  mergeSeededMediaBuyDeliveryIntoResponse,
  mergeSeededAccountsIntoResponse,
  mergeSeededCreativeFormatsIntoResponse,
  mergeSeededPropertyListsIntoResponse,
  mergeSeededCollectionListsIntoResponse,
  mergeSeededContentStandardsIntoResponse,
  mergeSeededSignalsIntoResponse,
  mergeSeededCreativeDeliveryIntoResponse,
  mergeSeededCreativeFeaturesIntoResponse,
  mergeSeededRightsIntoResponse,
  replaceAccountFinancialsIfSeeded,
  replacePropertyListIfSeeded,
  replaceCollectionListIfSeeded,
  replaceContentStandardsIfSeeded,
  replaceBrandIdentityIfSeeded,
  replaceSiOfferingIfSeeded,
  filterValidSeededProducts,
  filterValidSeededCreatives,
  filterValidSeededMediaBuys,
  filterValidSeededMediaBuyDeliveries,
  filterValidSeededAccounts,
  filterValidSeededAccountFinancials,
  filterValidSeededCreativeFormats,
  filterValidSeededPropertyLists,
  filterValidSeededCollectionLists,
  filterValidSeededContentStandards,
  filterValidSeededSignals,
  filterValidSeededCreativeDelivery,
  filterValidSeededCreativeFeatures,
  filterValidSeededBrandIdentity,
  filterValidSeededRights,
  filterValidSeededSiOffering,
  type TestControllerBridge,
  type TestControllerBridgeContext,
} from './test-controller-bridge';
import type { JwksResolver } from '../signing/jwks';
import type { ReplayStore } from '../signing/replay';
import type { RevocationStore } from '../signing/revocation';
import type { ContentDigestPolicy } from '../signing/types';
import { LIBRARY_VERSION } from '../version';

// Type-only imports for AdcpToolMap handler signatures (z.input<typeof ...>)
import type {
  GetProductsRequestSchema,
  CreateMediaBuyRequestSchema,
  UpdateMediaBuyRequestSchema,
  GetMediaBuysRequestSchema,
  GetMediaBuyDeliveryRequestSchema,
  ProvidePerformanceFeedbackRequestSchema,
  GetTaskStatusRequestSchema,
  ListTasksRequestSchema,
  ListCreativeFormatsRequestSchema,
  ListTransformersRequestSchema,
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
  CreateCollectionListRequestSchema,
  UpdateCollectionListRequestSchema,
  GetCollectionListRequestSchema,
  ListCollectionListsRequestSchema,
  DeleteCollectionListRequestSchema,
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
  UpdateRightsRequestSchema,
} from '../types/schemas.generated';
import { AccountReferenceSchema } from '../types/schemas.generated';

import type {
  AcquireRightsAcquired,
  AcquireRightsPendingApproval,
  AcquireRightsRejected,
  UpdateRightsResponse,
  UpdateRightsSuccess,
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
  GetTaskStatusResponse,
  ListTasksResponse,
  ListAccountsResponse,
  ListCreativeFormatsResponse,
  ListTransformersResponse,
  ProvidePerformanceFeedbackSuccess,
  ProvidePerformanceFeedbackResponse,
  BuildCreativeSuccess,
  BuildCreativeMultiSuccess,
  BuildCreativeResponse,
  GetCreativeDeliveryResponse,
  ListCreativesResponse,
  SyncCreativesError,
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
  CreateCollectionListResponse,
  UpdateCollectionListResponse,
  GetCollectionListResponse,
  ListCollectionListsResponse,
  DeleteCollectionListResponse,
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
  BrandReference,
  ListContentStandardsResponse,
  GetContentStandardsResponse,
  CreateContentStandardsResponse,
  UpdateContentStandardsResponse,
  CalibrateContentResponse,
  ValidateContentDeliveryResponse,
  GetMediaBuyArtifactsResponse,
  ListTasksRequest,
  TaskStatus,
  TaskType,
  AdCPProtocol as WireAdcpProtocol,
} from '../types/tools.generated';

import type { AdcpProtocol, MediaBuyFeatures, AccountCapabilities, CreativeCapabilities } from '../utils/capabilities';
import type { MediaChannel } from '../types/tools.generated';
import type { RequireCacheScopeWhenProducts, ServerPayload } from '../types/server-payload';
import { STANDARD_ERROR_CODES, isStandardErrorCode } from '../types/error-codes';
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

/**
 * Module-singleton default `InMemoryStateStore`. Adopters who use the
 * factory pattern `serve(() => createAdcpServer({...}))` get a fresh
 * `createAdcpServer` invocation per request — without this singleton, the
 * destructured default `stateStore = new InMemoryStateStore()` would mint
 * a brand-new in-memory store per request, silently dropping every
 * `ctx.store.put(...)` between calls. Empirically reproduced in matrix
 * v3: an LLM-built SI agent that put session state in `ctx.store` on
 * `si_initiate_session` failed to find it on the next request's
 * `si_send_message`.
 *
 * Sharing one default store across the process is what every other Node
 * framework's "memory store" already does, and it's what the skills
 * (creative, SI, etc.) explicitly promise: "framework provides
 * InMemoryStateStore by default — no need for module-level Maps".
 *
 * Multi-tenant adopters and production deployments pass their own store
 * (`PostgresStateStore`, etc.); the default is for development and
 * single-tenant agents only.
 *
 * Tests that need isolation pass an explicit `stateStore: new
 * InMemoryStateStore()`. The module-level default does not break
 * existing test isolation because tests have always opted-in to a fresh
 * store per case.
 */
const DEFAULT_STATE_STORE = new InMemoryStateStore();

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
  /**
   * Resolved buyer agent for this request, populated by `BuyerAgentRegistry`
   * when an `agentRegistry` is configured on the server (Phase 1 of #1269).
   * Carries the durable commercial relationship — status, billing
   * capabilities, default account terms — distinct from the per-request
   * credential. Undefined when no registry is configured OR when the
   * registry returned `null` for the request's credential.
   */
  agent?: BuyerAgent;
  /** Session scoping key derived from the request. Populated when `resolveSessionKey` is configured. */
  sessionKey?: string;
  /** State store for persisting domain objects (media buys, accounts, creatives). */
  store: AdcpStateStore;
  /**
   * Authentication info for the caller, when `ServeOptions.authenticate` is
   * configured. Populated from the MCP SDK's `extra.authInfo`, which
   * `serve()` sets from the auth principal. Use this to enforce
   * per-principal authorization in handlers.
   *
   * Stage 3 of #1269 added the kind-discriminated `credential` and the
   * `operator` fields. The legacy `token` / `clientId` / `scopes` are
   * preserved as optional fields through the deprecation cycle; new code
   * should read `credential` and switch on its `kind`.
   *
   * Buyer-agent identity post-resolution is on `ctx.agent` (the resolved
   * `BuyerAgent` record), NOT here — this surface only carries
   * authentication information about the credential, not the registry
   * lookup result.
   */
  authInfo?: ResolvedAuthInfo;
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
  /** Resolved buyer agent (Phase 1 of #1269), when `agentRegistry` is configured. */
  agent?: BuyerAgent;
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
  /**
   * Resolved buyer agent (Phase 1 of #1269), when an `agentRegistry` is
   * configured on the server. Adopters whose `accounts.resolve` shape varies
   * with the buyer agent's commercial relationship (e.g., agency-mediated
   * vs. direct billing) read it here without re-resolving from `authInfo`.
   * Undefined when no registry is configured OR when the registry returned
   * null for the request's credential.
   */
  agent?: BuyerAgent;
  /**
   * Original tool arguments. Account resolvers that need request-scope
   * metadata for test overlays or dry-run/delete-missing behavior should read
   * it here rather than re-parsing transport envelopes.
   */
  input?: Readonly<Record<string, unknown>>;
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
    result: RequireCacheScopeWhenProducts<ServerPayload<GetProductsResponse>>;
    response: GetProductsResponse;
  };
  create_media_buy: {
    params: z.input<typeof CreateMediaBuyRequestSchema>;
    result: ServerPayload<CreateMediaBuySuccess>;
    response: CreateMediaBuyResponse;
  };
  update_media_buy: {
    params: z.input<typeof UpdateMediaBuyRequestSchema>;
    result: ServerPayload<UpdateMediaBuySuccess>;
    response: UpdateMediaBuyResponse;
  };
  get_media_buys: {
    params: z.input<typeof GetMediaBuysRequestSchema>;
    result: ServerPayload<GetMediaBuysResponse>;
    response: GetMediaBuysResponse;
  };
  get_media_buy_delivery: {
    params: z.input<typeof GetMediaBuyDeliveryRequestSchema>;
    result: ServerPayload<GetMediaBuyDeliveryResponse>;
    response: GetMediaBuyDeliveryResponse;
  };
  provide_performance_feedback: {
    params: z.input<typeof ProvidePerformanceFeedbackRequestSchema>;
    result: ServerPayload<ProvidePerformanceFeedbackSuccess>;
    response: ProvidePerformanceFeedbackResponse;
  };
  get_task_status: {
    params: z.input<typeof GetTaskStatusRequestSchema>;
    result: ServerPayload<GetTaskStatusResponse>;
    response: GetTaskStatusResponse;
  };
  list_tasks: {
    params: z.input<typeof ListTasksRequestSchema>;
    result: ServerPayload<ListTasksResponse>;
    response: ListTasksResponse;
  };
  list_creative_formats: {
    params: z.input<typeof ListCreativeFormatsRequestSchema>;
    result: ServerPayload<ListCreativeFormatsResponse>;
    response: ListCreativeFormatsResponse;
  };
  list_transformers: {
    params: z.input<typeof ListTransformersRequestSchema>;
    result: ServerPayload<ListTransformersResponse>;
    response: ListTransformersResponse;
  };
  build_creative: {
    params: z.input<typeof BuildCreativeRequestSchema>;
    result: ServerPayload<BuildCreativeSuccess> | ServerPayload<BuildCreativeMultiSuccess>;
    response: BuildCreativeResponse;
  };
  preview_creative: {
    params: z.input<typeof PreviewCreativeRequestSchema>;
    result: ServerPayload<PreviewCreativeResponse>;
    response: PreviewCreativeResponse;
  };
  get_creative_delivery: {
    params: z.input<typeof GetCreativeDeliveryRequestSchema>;
    result: ServerPayload<GetCreativeDeliveryResponse>;
    response: GetCreativeDeliveryResponse;
  };
  list_creatives: {
    params: z.input<typeof ListCreativesRequestSchema>;
    result: ServerPayload<ListCreativesResponse>;
    response: ListCreativesResponse;
  };
  sync_creatives: {
    params: z.input<typeof SyncCreativesRequestSchema>;
    result: ServerPayload<SyncCreativesSuccess> | ServerPayload<SyncCreativesError>;
    response: SyncCreativesResponse;
  };
  get_signals: {
    params: z.input<typeof GetSignalsRequestSchema>;
    result: ServerPayload<GetSignalsResponse>;
    response: GetSignalsResponse;
  };
  activate_signal: {
    params: z.input<typeof ActivateSignalRequestSchema>;
    result: ServerPayload<ActivateSignalSuccess>;
    response: ActivateSignalResponse;
  };
  list_accounts: {
    params: z.input<typeof ListAccountsRequestSchema>;
    result: ServerPayload<ListAccountsResponse>;
    response: ListAccountsResponse;
  };
  sync_accounts: {
    params: z.input<typeof SyncAccountsRequestSchema>;
    result: ServerPayload<SyncAccountsSuccess>;
    response: SyncAccountsResponse;
  };
  sync_governance: {
    params: z.input<typeof SyncGovernanceRequestSchema>;
    result: ServerPayload<SyncGovernanceSuccess>;
    response: SyncGovernanceResponse;
  };
  get_account_financials: {
    params: z.input<typeof GetAccountFinancialsRequestSchema>;
    result: ServerPayload<GetAccountFinancialsSuccess>;
    response: GetAccountFinancialsResponse;
  };
  report_usage: {
    params: z.input<typeof ReportUsageRequestSchema>;
    result: ServerPayload<ReportUsageResponse>;
    response: ReportUsageResponse;
  };
  sync_event_sources: {
    params: z.input<typeof SyncEventSourcesRequestSchema>;
    result: ServerPayload<SyncEventSourcesSuccess>;
    response: SyncEventSourcesResponse;
  };
  log_event: {
    params: z.input<typeof LogEventRequestSchema>;
    result: ServerPayload<LogEventSuccess>;
    response: LogEventResponse;
  };
  sync_audiences: {
    params: z.input<typeof SyncAudiencesRequestSchema>;
    result: ServerPayload<SyncAudiencesSuccess>;
    response: SyncAudiencesResponse;
  };
  sync_catalogs: {
    params: z.input<typeof SyncCatalogsRequestSchema>;
    result: ServerPayload<SyncCatalogsSuccess>;
    response: SyncCatalogsResponse;
  };
  create_property_list: {
    params: z.input<typeof CreatePropertyListRequestSchema>;
    result: ServerPayload<CreatePropertyListResponse>;
    response: CreatePropertyListResponse;
  };
  update_property_list: {
    params: z.input<typeof UpdatePropertyListRequestSchema>;
    result: ServerPayload<UpdatePropertyListResponse>;
    response: UpdatePropertyListResponse;
  };
  get_property_list: {
    params: z.input<typeof GetPropertyListRequestSchema>;
    result: ServerPayload<GetPropertyListResponse>;
    response: GetPropertyListResponse;
  };
  list_property_lists: {
    params: z.input<typeof ListPropertyListsRequestSchema>;
    result: ServerPayload<ListPropertyListsResponse>;
    response: ListPropertyListsResponse;
  };
  delete_property_list: {
    params: z.input<typeof DeletePropertyListRequestSchema>;
    result: ServerPayload<DeletePropertyListResponse>;
    response: DeletePropertyListResponse;
  };
  create_collection_list: {
    params: z.input<typeof CreateCollectionListRequestSchema>;
    result: ServerPayload<CreateCollectionListResponse>;
    response: CreateCollectionListResponse;
  };
  update_collection_list: {
    params: z.input<typeof UpdateCollectionListRequestSchema>;
    result: ServerPayload<UpdateCollectionListResponse>;
    response: UpdateCollectionListResponse;
  };
  get_collection_list: {
    params: z.input<typeof GetCollectionListRequestSchema>;
    result: ServerPayload<GetCollectionListResponse>;
    response: GetCollectionListResponse;
  };
  list_collection_lists: {
    params: z.input<typeof ListCollectionListsRequestSchema>;
    result: ServerPayload<ListCollectionListsResponse>;
    response: ListCollectionListsResponse;
  };
  delete_collection_list: {
    params: z.input<typeof DeleteCollectionListRequestSchema>;
    result: ServerPayload<DeleteCollectionListResponse>;
    response: DeleteCollectionListResponse;
  };
  list_content_standards: {
    params: z.input<typeof ListContentStandardsRequestSchema>;
    result: ServerPayload<ListContentStandardsResponse>;
    response: ListContentStandardsResponse;
  };
  get_content_standards: {
    params: z.input<typeof GetContentStandardsRequestSchema>;
    result: ServerPayload<GetContentStandardsResponse>;
    response: GetContentStandardsResponse;
  };
  create_content_standards: {
    params: z.input<typeof CreateContentStandardsRequestSchema>;
    result: ServerPayload<CreateContentStandardsResponse>;
    response: CreateContentStandardsResponse;
  };
  update_content_standards: {
    params: z.input<typeof UpdateContentStandardsRequestSchema>;
    result: ServerPayload<UpdateContentStandardsResponse>;
    response: UpdateContentStandardsResponse;
  };
  calibrate_content: {
    params: z.input<typeof CalibrateContentRequestSchema>;
    result: ServerPayload<CalibrateContentResponse>;
    response: CalibrateContentResponse;
  };
  validate_content_delivery: {
    params: z.input<typeof ValidateContentDeliveryRequestSchema>;
    result: ServerPayload<ValidateContentDeliveryResponse>;
    response: ValidateContentDeliveryResponse;
  };
  get_media_buy_artifacts: {
    params: z.input<typeof GetMediaBuyArtifactsRequestSchema>;
    result: ServerPayload<GetMediaBuyArtifactsResponse>;
    response: GetMediaBuyArtifactsResponse;
  };
  get_creative_features: {
    params: z.input<typeof GetCreativeFeaturesRequestSchema>;
    result: ServerPayload<GetCreativeFeaturesResponse>;
    response: GetCreativeFeaturesResponse;
  };
  sync_plans: {
    params: z.input<typeof SyncPlansRequestSchema>;
    result: ServerPayload<SyncPlansResponse>;
    response: SyncPlansResponse;
  };
  check_governance: {
    params: z.input<typeof CheckGovernanceRequestSchema>;
    result: ServerPayload<CheckGovernanceResponse>;
    response: CheckGovernanceResponse;
  };
  report_plan_outcome: {
    params: z.input<typeof ReportPlanOutcomeRequestSchema>;
    result: ServerPayload<ReportPlanOutcomeResponse>;
    response: ReportPlanOutcomeResponse;
  };
  get_plan_audit_logs: {
    params: z.input<typeof GetPlanAuditLogsRequestSchema>;
    result: ServerPayload<GetPlanAuditLogsResponse>;
    response: GetPlanAuditLogsResponse;
  };
  si_get_offering: {
    params: z.input<typeof SIGetOfferingRequestSchema>;
    result: ServerPayload<SIGetOfferingResponse>;
    response: SIGetOfferingResponse;
  };
  si_initiate_session: {
    params: z.input<typeof SIInitiateSessionRequestSchema>;
    result: ServerPayload<SIInitiateSessionResponse>;
    response: SIInitiateSessionResponse;
  };
  si_send_message: {
    params: z.input<typeof SISendMessageRequestSchema>;
    result: ServerPayload<SISendMessageResponse>;
    response: SISendMessageResponse;
  };
  si_terminate_session: {
    params: z.input<typeof SITerminateSessionRequestSchema>;
    result: ServerPayload<SITerminateSessionResponse>;
    response: SITerminateSessionResponse;
  };

  get_brand_identity: {
    params: z.input<typeof GetBrandIdentityRequestSchema>;
    result: ServerPayload<GetBrandIdentitySuccess>;
    response: GetBrandIdentitySuccess;
  };
  get_rights: {
    params: z.input<typeof GetRightsRequestSchema>;
    result: ServerPayload<GetRightsSuccess>;
    response: GetRightsSuccess;
  };
  acquire_rights: {
    params: z.input<typeof AcquireRightsRequestSchema>;
    result:
      | ServerPayload<AcquireRightsAcquired>
      | ServerPayload<AcquireRightsPendingApproval>
      | ServerPayload<AcquireRightsRejected>;
    response: AcquireRightsAcquired | AcquireRightsPendingApproval | AcquireRightsRejected;
  };
  update_rights: {
    params: z.input<typeof UpdateRightsRequestSchema>;
    result: ServerPayload<UpdateRightsSuccess>;
    response: UpdateRightsResponse;
  };
}

export type AdcpServerToolName = keyof AdcpToolMap;

/**
 * Parameter shape passed to `resolveIdempotencyPrincipal`. Wide enough to
 * carry any wire request (the framework calls every mutating tool through
 * the same resolver), narrow enough to surface the most-common scoping
 * fields (`account`, `brand`) using the canonical wire types.
 *
 * `account` and `brand` resolve to the same `AccountReference` /
 * `BrandReference` types the rest of the SDK uses. The
 * `account: AccountReference` discriminated union forces adopters scoping
 * by tenant to narrow before reading variant-specific fields:
 *
 * ```ts
 * resolveIdempotencyPrincipal: (ctx, params) => {
 *   if (params.account && 'account_id' in params.account) {
 *     return params.account.account_id; // narrowed to {account_id: string}
 *   }
 *   if (params.account?.brand?.domain) {
 *     return `${params.account.brand.domain}:${params.account.operator}`;
 *   }
 *   return ctx.account?.id ?? 'anon';
 * }
 * ```
 *
 * Tool-specific scoping (e.g., custom session header on `si_send_message`)
 * still has the open `Record<string, unknown>` index signature for
 * everything else.
 */
export interface IdempotencyPrincipalParams extends Record<string, unknown> {
  /** Buyer-supplied account reference. Most mutating tools carry this. */
  account?: AccountReference;
  /** Buyer-supplied brand reference (used by some tools without account). */
  brand?: BrandReference;
}

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
  listTransformers?: DomainHandler<'list_transformers', TAccount>;
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
  createCollectionList?: DomainHandler<'create_collection_list', TAccount>;
  updateCollectionList?: DomainHandler<'update_collection_list', TAccount>;
  getCollectionList?: DomainHandler<'get_collection_list', TAccount>;
  listCollectionLists?: DomainHandler<'list_collection_lists', TAccount>;
  deleteCollectionList?: DomainHandler<'delete_collection_list', TAccount>;
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
 * Brand rights covers identity and licensing workflows.
 *
 * `update_rights` is a first-class mutating tool — modify an existing rights
 * grant (extend dates, adjust impression caps, change pricing, pause/resume).
 * Schemas published in AdCP 3.0.x; framework dispatch parallels
 * `acquire_rights`.
 *
 * `creative_approval` is intentionally NOT in this handler bag — the spec
 * models it as an HTTP webhook (the buyer POSTs to the `approval_webhook`
 * URL returned from `acquire_rights`), not as an MCP/A2A tool. Adopters
 * wire the receiver to `BrandRightsPlatform.reviewCreativeApproval` and
 * use `creativeApproved` / `creativeApprovalRejected` /
 * `creativeApprovalPendingReview` / `creativeApprovalError` from
 * `@adcp/sdk/server` to build the webhook response.
 */
export interface BrandRightsHandlers<TAccount = unknown> {
  getBrandIdentity?: DomainHandler<'get_brand_identity', TAccount>;
  getRights?: DomainHandler<'get_rights', TAccount>;
  acquireRights?: DomainHandler<'acquire_rights', TAccount>;
  updateRights?: DomainHandler<'update_rights', TAccount>;
}

// ---------------------------------------------------------------------------
// Capabilities config
// ---------------------------------------------------------------------------

export interface AdcpCapabilitiesConfig {
  major_versions?: number[];
  /**
   * Release-precision versions this seller supports (AdCP 3.1+ per spec PR
   * `adcontextprotocol/adcp#3493`). Each entry parses to a major via
   * `parseAdcpMajorVersion` — the union of these majors and `major_versions`
   * defines the seller's accepted set for the wire-level
   * `adcp_major_version` / `adcp_version` claim a buyer may carry.
   *
   * 3.0-pinned sellers can ignore this field. 3.1+ sellers should declare
   * here the same release-precision strings they emit in `adcp_version` on
   * responses, so buyers receiving `VERSION_UNSUPPORTED` can read the
   * supported set off the error envelope and downgrade their pin.
   */
  supported_versions?: string[];
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
   * runner (see `@adcp/sdk/testing/storyboard/request-signing`).
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
   * When using `createIdempotencyStore` from `@adcp/sdk/server`, omit
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
  measurement?: Partial<NonNullable<GetAdCPCapabilitiesResponse['measurement']>> | null;
  experimental_features?: GetAdCPCapabilitiesResponse['experimental_features'] | null;
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
 * A seller wiring this config MUST also publish a buyer-visible discovery
 * surface in `capabilities`, one of:
 *
 * - **3.1+ canonical (recommended):** set
 *   `capabilities.request_signing.supported: true`. Buyers learn the agent
 *   verifies signatures from `get_adcp_capabilities`; no deprecated specialism
 *   claim required. The universal `signed_requests` storyboard grades on this
 *   signal alone.
 * - **Back-compat:** add `'signed-requests'` to `capabilities.specialisms`.
 *   The 3.0-era enum value is preserved through the AdCP 4.0 deprecation cycle
 *   (adcp#3075); when this path is taken the runner emits
 *   `signed_requests_specialism_deprecated` (adcp-client#2082, adcp#4796).
 *
 * `createAdcpServer` throws at construction time when `signedRequests` is set
 * but neither discovery surface is declared, closing the footgun where the
 * verifier silently rejects every signed request from buyers who never learned
 * to sign. The inverse (specialism or capability declared without a
 * `signedRequests` config) is logged loudly but not thrown — legacy servers
 * that hand-build the middleware via `serve({ preTransport })` stay
 * conformant.
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
  /**
   * JSON-RPC protocol method names that MUST arrive signed. Separate from
   * AdCP tool names in `required_for`; examples include `tasks/cancel`.
   */
  protocol_methods_required_for?: string[];
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
 * Symbol marking that a server's `instructions` was supplied as a function
 * (lazy / per-session form) rather than a static string. `serve()` reads
 * this to refuse `reuseAgent: true` — the function is captured once at
 * construction and would not re-evaluate per session under server reuse.
 *
 * Internal contract between `createAdcpServer` and `serve()`. Adopters
 * who instantiate `McpServer` directly (without `createAdcpServer`) and
 * want their own marker semantics should not import this symbol.
 */
export const ADCP_INSTRUCTIONS_FN: unique symbol = Symbol.for('@adcp/client.instructionsFn');

/**
 * Resolve function-form instructions for transports without a legacy
 * `initialize` handshake (notably MCP 2026-07-28). Internal contract between
 * `createAdcpServer` and transport adapters.
 */
export const ADCP_INSTRUCTIONS_RESOLVER: unique symbol = Symbol.for('@adcp/client.instructionsResolver');

/**
 * Pre-resolution session context passed to a function-form `instructions`.
 * Slim by design — no `account` (resolution hasn't run yet at MCP `initialize`
 * time, which is the natural eval moment for per-session instructions).
 *
 * Both fields are reserved: today they are always `undefined` because the
 * framework's `serve()` does not yet plumb auth + registry state into the
 * factory before MCP `initialize`. Adopters who need tenant identity should
 * use closures captured in their factory's HTTP-scoped state. The shape is
 * forward-compatible: when the framework wires authInfo/agent through, the
 * fields will populate without breaking existing function bodies.
 *
 * @see AdcpServerConfig.instructions
 * @public
 */
export interface SessionContext {
  /**
   * @reserved Always `undefined` in v6.x. The framework does not yet plumb
   * `authInfo` into the factory before MCP `initialize` — use closures
   * captured in your factory's HTTP-scoped state for tenant identity today.
   * Forward-compatible: when the framework wires this through, your
   * `ctx.authInfo?.…` reads start returning real values without breaking
   * existing function bodies.
   */
  readonly authInfo?: ResolvedAuthInfo;

  /**
   * @reserved Always `undefined` in v6.x. The framework does not yet plumb
   * the resolved `BuyerAgent` into the factory before MCP `initialize` —
   * use closures captured in your factory's HTTP-scoped state for tenant
   * identity today. Forward-compatible: when the framework wires this
   * through, your `ctx.agent?.…` reads start returning real values without
   * breaking existing function bodies.
   */
  readonly agent?: BuyerAgent;
}

/**
 * Behavior when a function-form `instructions` callback throws or its
 * returned Promise rejects.
 *
 * - `'skip'` (default) — log server-side, treat as `undefined` (no
 *   instructions). Right for prose-of-flavor (brand manifests, marketing
 *   copy) where a registry fetch failure must not kill the buyer's session.
 * - `'fail'` — rethrow (sync) / re-reject (async). The MCP `initialize`
 *   handshake then fails at the transport layer (this is NOT an
 *   `adcp_error` envelope — it kills the session). Right for adopters
 *   whose instructions carry load-bearing policy where stale/missing
 *   guidance is worse than a connection retry.
 *
 * @public
 */
export type OnInstructionsError = 'skip' | 'fail';

/**
 * A value that is either `T` directly or a `Promise<T>`.
 *
 * Used in callback signatures that support both synchronous and asynchronous
 * returns (e.g. `instructions`), so adopters can return either a plain
 * string or an `async` function without separate overloads.
 *
 * @public
 */
export type MaybePromise<T> = T | Promise<T>;

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

/** UI hints for a custom tool backed by an MCP App. */
export interface McpAppUiMeta {
  /** URI of the MCP App resource rendered when the tool is invoked. */
  resourceUri?: string;
  /** Audiences a compliant host exposes the tool to. Routing metadata, not authorization. */
  visibility?: Array<'model' | 'app'>;
}

/** Typed MCP App metadata forwarded unchanged in `tools/list`. */
export interface McpAppMeta {
  ui?: McpAppUiMeta;
}

/**
 * Declarative registration for a tool outside {@link AdcpToolMap} — seller
 * extensions (e.g. collection-list helpers), test-harness endpoints
 * (`comply_test_controller`), or AdCP surfaces whose JSON Schemas haven't
 * landed in the framework yet.
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
  /** Portable MCP App metadata surfaced unchanged in `tools/list`. */
  _meta?: McpAppMeta;
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

/**
 * Public shape for the `webhooks` option on {@link AdcpServerConfig}.
 * Concrete name + export so adopters can write `webhooks: WebhooksConfig`
 * without reaching for a `Pick<WebhookEmitterOptions, ...>` reproduction
 * (and without falling back to `as any` when they typed it loosely).
 *
 * Subset of {@link WebhookEmitterOptions} the framework lifts to the
 * server config: signing key/provider, retry policy, idempotency-key
 * store, fetch override, user-agent + tag, and the per-emit observability
 * hooks. Other emitter-internal knobs (rate limits, transport pool
 * sizing) stay on `WebhookEmitterOptions` for direct emitter callers.
 *
 * @public
 */
export type WebhooksConfig = Pick<
  WebhookEmitterOptions,
  | 'signerKey'
  | 'signerProvider'
  | 'retries'
  | 'idempotencyKeyStore'
  | 'generateIdempotencyKey'
  | 'fetch'
  | 'userAgent'
  | 'tag'
> & {
  /** Observability: emitter-wide onAttempt hook. */
  onAttempt?: WebhookEmitterOptions['onAttempt'];
  /** Observability: emitter-wide onAttemptResult hook. */
  onAttemptResult?: WebhookEmitterOptions['onAttemptResult'];
};

export interface AdcpServerConfig<TAccount = unknown> {
  name: string;
  version: string;

  /**
   * Expose generated top-level AdCP request shapes in MCP `tools/list`.
   *
   * Defaults to `false`, preserving the long-standing passthrough schema so
   * the framework AJV validator remains the only validation gate shared by
   * MCP and A2A. Set to `true` when generic MCP clients need argument hints
   * from `tools/list`; known AdCP tools use shallow key hints derived from
   * `TOOL_INPUT_SHAPES` and unknown/custom framework surfaces fall back to
   * passthrough.
   */
  exposeToolSchemas?: boolean;

  /**
   * AdCP protocol version this server speaks. Defaults to {@link ADCP_VERSION}
   * — the GA version the SDK ships against. Override to pin to an older
   * stable (e.g., `'3.0.0'`) or opt into a beta channel (`'3.1.0-beta.1'`)
   * once that registry ships.
   *
   * Not the same as `version` (the publisher's app version, e.g., `'1.4.2'`).
   *
   * Stage 2 plumbs the option through and validates it at construction
   * time; cross-major pins (e.g. `'4.0.0-beta.1'` while the SDK ships
   * against major 3) throw `ConfigurationError`. Stage 3 wires per-instance
   * schema/validator selection off this field.
   *
   * Typed as `AdcpVersion | (string & {})` so editors autocomplete
   * canonical values from {@link COMPATIBLE_ADCP_VERSIONS} while still
   * accepting forward-compatible strings.
   */
  adcpVersion?: AdcpVersion | (string & {});

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
   * Resolve an account when the wire request doesn't carry one.
   *
   * For tools whose request schema lacks an `account` field
   * (`provide_performance_feedback`, `list_creative_formats`, the
   * `tasks/get` polling path, etc.), the framework can't extract a wire
   * ref. When this resolver is configured, the framework calls it with the
   * caller's `authInfo` instead so single-tenant agents (`resolution: 'derived'`)
   * and principal-keyed agents (`resolution: 'implicit'`) still get a
   * tenant-scoped `ctx.account`.
   *
   * Returns `null` when no account can be derived. The handler then runs
   * with `ctx.account` undefined — appropriate for tools that legitimately
   * don't need tenant scoping (publisher-wide format catalogs).
   */
  resolveAccountFromAuth?: (ctx: ResolveAccountContext) => Promise<TAccount | null>;

  /**
   * Buyer-agent identity registry. Optional. When
   * configured, framework calls `agentRegistry.resolve(authInfo)` once per
   * request after `authInfo` is populated and before `resolveAccount`. The
   * resolved {@link BuyerAgent} is threaded through `ctx.agent` to
   * `resolveAccount`, `resolveAccountFromAuth`, `resolveSessionKey`, and
   * the specialism handlers.
   *
   * Adopters construct via {@link BuyerAgentRegistry.signingOnly},
   * {@link BuyerAgentRegistry.bearerOnly}, or {@link BuyerAgentRegistry.mixed}.
   * When omitted, `ctx.agent` stays `undefined` and the framework's request
   * flow is unchanged — strict opt-in.
   *
   * Behavior:
   * - Registry returns a `BuyerAgent` → framework freezes the record (and
   *   its `billing_capabilities` Set) and sets `ctx.agent`.
   * - Registry returns `null` → `ctx.agent` stays undefined; dispatch
   *   continues. For `sync_accounts.billing`, an unresolved agent under a
   *   configured registry gets the oracle-safe `BILLING_NOT_SUPPORTED`
   *   surface rather than `BILLING_NOT_PERMITTED_FOR_AGENT`.
   * - Registry throws → framework returns `SERVICE_UNAVAILABLE`. Inner
   *   error logged server-side.
   *
   * Resolved records drive status/sandbox enforcement and
   * `sync_accounts.billing` capability gates.
   */
  agentRegistry?: BuyerAgentRegistry;

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
   *     `SERVICE_UNAVAILABLE: Cannot find module '@adcp/sdk/foo'`.
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

  /**
   * Task registry for async task lifecycle records.
   *
   * Usually supplied by `createAdcpServerFromPlatform`; low-level callers
   * only need this when they want `compliance.reset()` to flush in-memory
   * task records between repeated test runs.
   */
  taskRegistry?: TaskRegistry;

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
    params: IdempotencyPrincipalParams,
    toolName: AdcpServerToolName
  ) => string | undefined;
  /**
   * Server-level prose surfaced on MCP `initialize`. Two forms:
   *
   * 1. **Static string** (the historical form) — captured at construction,
   *    same value for every session.
   * 2. **Function** `(ctx: SessionContext) => string | undefined` — re-evaluated
   *    each time `createAdcpServer` is called. Under the canonical
   *    `serve({ reuseAgent: false })` flow (the default) the factory
   *    runs per HTTP request, which under streamable-HTTP MCP is per
   *    session — so the closure can surface tenant-shaped prose (per-buyer
   *    brand manifests, storefront copy, "premium vs standard" partner
   *    guidance).
   *
   * **Eval moment.** Strictly: once per `createAdcpServer` invocation.
   * `serve({ reuseAgent: false })` makes that "per HTTP request, which is
   * per session for streamable-HTTP MCP." Custom transports / hand-rolled
   * dispatch must invoke `createAdcpServer` per session themselves to
   * preserve the per-session semantic. `reuseAgent: true` would fire the
   * function once for the lifetime of the shared agent — which defeats
   * the purpose, so `serve()` refuses that combination at the first
   * request.
   *
   * **`SessionContext` is reserved.** `authInfo` and `agent` are typed for
   * forward compatibility but currently always `undefined` — the framework
   * does not yet plumb auth/registry state into the factory. **Use closures
   * captured in your factory's HTTP-scoped state for tenant identity today;
   * `ctx.agent`/`ctx.authInfo` reads silently return `undefined` and ship
   * empty prose to prod.** The function body will pick up populated fields
   * when the framework wires them through.
   *
   * @example Per-tenant prose via factory closure (recommended pattern):
   * ```ts
   * serve(({ taskStore, host }) => createAdcpServer({
   *   // host is HTTP-scoped — captured in the closure, NOT from ctx.
   *   instructions: () => brandManifests.get(host)?.intro ?? defaultProse,
   *   // ... rest of config
   * }));
   * ```
   *
   * **Async functions are supported.** The framework awaits the returned
   * Promise during MCP `initialize` — the session does not proceed until
   * the promise settles. A slow fetch adds session-establishment latency,
   * not per-tool latency; add a timeout inside your function if needed
   * (e.g. `Promise.race([fetchProse(), timeout(2000)])`). A rejected
   * promise is governed by `onInstructionsError`: `'skip'` (default) logs
   * and sends no instructions; `'fail'` causes the `initialize` handshake
   * to fail, dropping the session.
   *
   * @see SessionContext
   * @see onInstructionsError
   */
  instructions?: string | ((ctx: SessionContext) => MaybePromise<string | undefined>);
  /**
   * Behavior when a function-form `instructions` callback throws. Defaults
   * to `'skip'` — best-effort prose (brand manifests, marketing copy)
   * should not kill the buyer's session on a registry fetch failure.
   * Set `'fail'` for adopters whose instructions carry load-bearing
   * policy. See {@link OnInstructionsError}.
   */
  onInstructionsError?: OnInstructionsError;
  taskStore?: TaskStore;
  taskMessageQueue?: TaskMessageQueue;
  /**
   * Webhook-emission config. When set, `ctx.emitWebhook` is populated on
   * every handler's context — handlers post signed, retried,
   * idempotency-stable webhooks without hand-rolling the pipeline. Omit
   * if your server never emits webhooks.
   *
   * Provide exactly one of `signerKey` (in-process JWK) or `signerProvider`
   * (KMS-backed async signing). The signing key or provider key MUST have
   * `adcp_use: "webhook-signing"` — a request-signing key is a conformance
   * violation per adcp#2423 (key purpose discriminator). Publishers publishing
   * their JWKS at the `jwks_uri` on brand.json's `agents[]` entry reuse the
   * same key across every buyer they deliver to.
   */
  webhooks?: WebhooksConfig;
  /**
   * Optional callback that can mutate MCP tool responses before they are
   * returned. Runs for framework tools, custom tools, and generated discovery
   * responses registered by `createAdcpServer`.
   */
  responseEnhancer?: (response: McpToolResponse) => void;
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
   * Reject buyer requests that smuggle credential-shaped keys through
   * the args bag. Closes the bug class observed in storefront fan-out
   * paths where keys like `<platform>_access_token` (top-level, in
   * `context`, or in `ext`) flow through to upstream calls under the
   * storefront's TLS / IP reputation — confused-deputy by default.
   *
   * Modes:
   *   - `'lax'` (default) — no scan; preserves existing behavior.
   *   - `'authInfo-only'` — scan args for credential-shaped keys at any
   *     depth and reject with `INVALID_REQUEST`. Credentials must arrive
   *     on `authInfo` (resolved by the framework's authenticator) and
   *     never on the args bag.
   *
   * Pass the object form for pattern customization or per-tool overrides:
   *
   * ```ts
   * credentialPolicy: {
   *   policy: 'authInfo-only',
   *   patterns: { extend: [/^bearer$/i, /credentials/i] },
   *   tools: { activate_signal: 'lax' },  // legitimate buyer-creds tool
   * }
   * ```
   *
   * Default patterns: `_access_token$`, `_secret$`, `_password$`,
   * `accessToken`, `refreshToken`. The next platform-specific vector
   * lives in adopter config, not in the SDK.
   *
   * @see {@link CredentialPolicy}
   * @see docs/guides/CTX-METADATA-SAFETY.md
   */
  credentialPolicy?: CredentialPolicy;

  /**
   * Register tools outside {@link AdcpToolMap}. Keys are the public tool
   * names; values follow {@link AdcpCustomToolConfig}.
   *
   * Gives sellers a declarative extension point without reaching for the
   * `getSdkServer()` escape hatch. Typical callers:
   *
   *   - AdCP surfaces whose JSON Schemas haven't landed yet.
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
   * Portable HTML MCP Apps served through standard MCP resources.
   *
   * Each definition is registered on both the legacy MCP server and every
   * modern per-request server reconstruction. A custom tool links to a
   * resource with `_meta.ui.resourceUri`; a startup warning identifies any
   * link whose URI is absent here. Hosts without MCP Apps support can ignore
   * the metadata and consume the tool's normal text result.
   */
  resources?: readonly AdcpMcpResourceDefinition[];

  /**
   * Opt-in bridge between the `comply_test_controller` seed store and the
   * spec-tool pipeline. When `getSeededProducts` is provided, seeded
   * products flow into `get_products` responses on sandbox requests — the
   * Group A compliance storyboards rely on this end-to-end flow.
   * Production traffic (no sandbox marker, or a resolved non-sandbox
   * account) bypasses the bridge entirely; omit the field in production
   * configs to be explicit about it.
   *
   * ## Do you need the bridge?
   *
   * The bridge is one of two mechanisms for closing the seed→read loop in
   * compliance testing. Pick by where your read handlers fetch from — not
   * by seller class:
   *
   *   - **Handler reads from a store you control** (most SSPs, most
   *     creative agents). `comply_test_controller.seed_product` writes to
   *     your DB; your handler reads from your DB; the seed→read loop
   *     closes naturally. **Don't wire the bridge** — test mode alone
   *     covers you.
   *   - **Handler reads from a system you don't control** (DSPs proxying
   *     to Meta/Snap/TikTok, retail-media networks reading retailer
   *     catalog APIs, signals agents brokering third-party data
   *     marketplaces). `comply_test_controller.seed_product` is a dead
   *     write for you because the handler will never see it. **Wire the
   *     bridge.** The real handler still runs first (so a broken upstream
   *     call still fails the conformance gate — adapter exercise is
   *     preserved), and the SDK merges seeded fixtures into the response
   *     after.
   *
   * Either path earns wire-conformance credit when storyboards pass; it
   * is *not* a separate certification category. Live-integration credit
   * requires marker-free passes against a real test surface (sandbox
   * credentials, real catalog data, real adapter traffic) — independent
   * of whether the bridge is wired. See `docs/guides/VALIDATE-YOUR-AGENT.md`
   * § "Platform-proxy sellers" for the wiring mechanics, and
   * [`adcp-client#1782`](https://github.com/adcontextprotocol/adcp-client/issues/1782)
   * plus the upstream taxonomy proposal at
   * [`adcontextprotocol/adcp#4593`](https://github.com/adcontextprotocol/adcp/issues/4593)
   * for the certification model under review.
   *
   * ## Security — trust boundary
   *
   * The bridge is gated by `isSandboxRequest(params) && (ctx.account ===
   * undefined || ctx.account.sandbox === true)`. The second clause is the
   * authority boundary; the first is caller-supplied (`account.sandbox` or
   * `context.sandbox` on the request body) and is NOT a trust boundary on
   * its own. If you register `testController` WITHOUT configuring
   * `resolveAccount` (so `ctx.account` stays `undefined`), an attacker who
   * sets `account.sandbox = true` on production traffic gets seeded
   * fixtures merged into responses and the `_bridge` marker stamped.
   *
   * Production deployments that register `testController` MUST:
   *   1. Configure `resolveAccount` so the framework can refuse the merge
   *      when the resolved account is not flagged `sandbox: true`, or
   *   2. Omit `testController` entirely outside test / staging environments.
   *
   * The `createAdcpServerFromPlatform` flow already enforces this via the
   * sandbox-authority gate (see Phase 2 of #1435 — resolved-account `mode`
   * is the trust boundary, not buyer-supplied `account.sandbox`). The
   * direct `createAdcpServer` flow does not; adopters wiring the bridge
   * here are responsible for the gate. See the top-of-file JSDoc on
   * `TestControllerBridge` for the full adopter-responsibility note (#1779).
   *
   * See `src/lib/server/test-controller-bridge.ts` for the sandbox-marker
   * predicate and the merge contract.
   *
   * @example
   * ```ts
   * import { createAdcpServer, bridgeFromTestControllerStore } from '@adcp/sdk/server/legacy/v5';
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
 * Shape of the `_bridge` marker stamped on responses where the
 * `testController` bridge merged seeded fixtures into the handler's reply.
 *
 * The marker is non-normative — every bridge-augmented response schema in
 * AdCP 3.0 allows additional top-level properties (verified across the 13
 * bridge-touching response schemas), and the underscore prefix advertises
 * "internal / out-of-spec" to validators that round-trip unknown fields.
 * Consumers (storyboard runners, compliance leaderboards, audit pipelines)
 * read this marker to distinguish "this pass exercised the adopter's
 * adapter against upstream" from "this pass exercised wire conformance
 * against fixture data merged by the SDK". See `adcp-client#1775` for the
 * cross-repo coordination context.
 *
 * ## Why on the response body, not MCP `_meta`?
 *
 * MCP defines `result._meta` as the canonical place for non-normative
 * server-side annotations, and `_meta` would be the textbook home for this
 * marker on MCP-only deployments. We put it on the response body instead
 * for three reasons:
 *
 *   1. **Cross-transport parity.** A2A has no `_meta` equivalent —
 *      `structuredContent` passes through the A2A artifact pipeline
 *      verbatim, but a hypothetical envelope-level marker would have to be
 *      duplicated or lost. One wire location across both transports keeps
 *      the storyboard runner's read logic uniform.
 *   2. **L2-text-body parity.** Buyers consuming the L2 text body (the
 *      JSON-stringified `content[0].text`) see the same envelope MCP does,
 *      because the opportunistic text-body mirror copies the marker into
 *      both.
 *   3. **Precedent.** `replayed: true` already lives on the response body
 *      via the same `stampReplayed` pattern this marker mirrors. Splitting
 *      framework-emitted annotations across `_meta` and the body would
 *      create two conventions for the same job.
 */
export interface BridgeMarker {
  /** Bridge callback that produced the seeded entries (e.g. `getSeededCreatives`). */
  callback: string;
  /** Tool name whose response was augmented (mirrors envelope context). */
  tool: string;
  /** Count of seeded entries the callback returned (post-validation). */
  merged_count: number;
}

/**
 * Stamp a non-normative `_bridge` marker on a response that the
 * `testController` bridge augmented with seeded fixtures.
 *
 * Mirrors {@link stampReplayed} — sets `_bridge` on `structuredContent`
 * AND on the parsed JSON in `content[0].text`, so A2A/REST adapters that
 * consume the text body see the same envelope MCP does.
 *
 * Only call this AFTER a successful merge — for singleton-replace tools
 * (`get_account_financials`, `get_brand_identity`, `si_get_offering`,
 * `get_property_list`, `get_collection_list`, `get_content_standards`)
 * gate on `merged !== sc` so the marker only fires when the seeded fixture
 * actually replaced the handler payload.
 */
function stampBridge(response: McpToolResponse, callback: string, tool: string, mergedCount: number): void {
  if (!response.structuredContent || typeof response.structuredContent !== 'object') return;
  const marker: BridgeMarker = { callback, tool, merged_count: mergedCount };
  const sc = response.structuredContent as Record<string, unknown>;
  sc._bridge = marker;
  if (Array.isArray(response.content)) {
    const first = response.content[0];
    if (first && first.type === 'text' && typeof first.text === 'string') {
      try {
        const parsed = JSON.parse(first.text);
        if (parsed && typeof parsed === 'object') {
          parsed._bridge = marker;
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

const UNCACHEABLE_SYNC_ACCOUNT_ERROR_CODES = new Set([
  'BILLING_NOT_SUPPORTED',
  'BILLING_NOT_PERMITTED_FOR_AGENT',
  'PAYMENT_TERMS_NOT_SUPPORTED',
]);

function hasUncacheableSyncAccountRejection(response: McpToolResponse): boolean {
  const sc = response.structuredContent;
  if (!sc || typeof sc !== 'object') return false;
  const accounts = (sc as Record<string, unknown>).accounts;
  if (!Array.isArray(accounts)) return false;
  return accounts.some(row => {
    if (!row || typeof row !== 'object') return false;
    const record = row as Record<string, unknown>;
    if (record.status !== 'rejected' && record.action !== 'failed') return false;
    const errors = record.errors;
    if (!Array.isArray(errors)) return false;
    return errors.some(error => {
      if (!error || typeof error !== 'object') return false;
      return UNCACHEABLE_SYNC_ACCOUNT_ERROR_CODES.has(String((error as Record<string, unknown>).code));
    });
  });
}

function shouldCacheIdempotencyResponse(response: McpToolResponse): boolean {
  return !isErrorResponse(response) && !hasUncacheableSyncAccountRejection(response);
}

/**
 * Detect a thrown `adcpError(...)` envelope. Handlers that `throw` an
 * envelope (instead of `return`-ing it) would otherwise surface as
 * `[object Object]` inside a SERVICE_UNAVAILABLE wrapper — the dispatcher
 * unwraps and returns the envelope directly when the shape matches.
 */
/**
 * Project a thrown {@link AdcpError} to the wire envelope. Used by the
 * account-resolution and tool-handler catch blocks so adopters can throw
 * typed errors at any depth and have the framework project the structured
 * fields verbatim — without coercion to `SERVICE_UNAVAILABLE`. Mirrors the
 * `isThrownAdcpError` unwrap, but for the in-process class throw rather
 * than the already-projected envelope throw.
 */
function projectThrownAdcpError(err: AdcpError): McpToolResponse {
  return adcpError(err.code, {
    recovery: err.recovery,
    message: err.message,
    ...(err.field !== undefined && { field: err.field }),
    ...(err.suggestion !== undefined && { suggestion: err.suggestion }),
    ...(err.retry_after !== undefined && { retry_after: err.retry_after }),
    ...(err.details !== undefined && { details: err.details }),
  });
}

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
  const structuredContent = { ...toStructuredContent(data) };
  if (structuredContent.status === undefined) structuredContent.status = 'completed';
  return {
    content: [{ type: 'text', text: summary ?? `${toolName} completed` }],
    structuredContent,
  };
}

const ADCP_TASK_TYPES = new Set<TaskType>([
  'get_products',
  'create_media_buy',
  'update_media_buy',
  'media_buy_delivery',
  'sync_creatives',
  'activate_signal',
  'get_signals',
  'create_property_list',
  'update_property_list',
  'get_property_list',
  'list_property_lists',
  'delete_property_list',
  'sync_accounts',
  'get_account_financials',
  'get_creative_delivery',
  'sync_event_sources',
  'sync_audiences',
  'sync_catalogs',
  'log_event',
  'get_brand_identity',
  'search_brands',
  'get_rights',
  'acquire_rights',
]);

const PROTOCOL_TASK_TYPE_TO_PROTOCOL: Partial<Record<TaskType, WireAdcpProtocol>> = {
  get_products: 'media-buy',
  create_media_buy: 'media-buy',
  update_media_buy: 'media-buy',
  media_buy_delivery: 'media-buy',
  sync_creatives: 'creative',
  get_creative_delivery: 'creative',
  activate_signal: 'signals',
  get_signals: 'signals',
  sync_accounts: 'media-buy',
  get_account_financials: 'media-buy',
  sync_event_sources: 'media-buy',
  sync_audiences: 'media-buy',
  sync_catalogs: 'media-buy',
  log_event: 'media-buy',
  get_brand_identity: 'brand',
  search_brands: 'brand',
  get_rights: 'brand',
  acquire_rights: 'brand',
  create_property_list: 'governance',
  update_property_list: 'governance',
  get_property_list: 'governance',
  list_property_lists: 'governance',
  delete_property_list: 'governance',
};

function readRegistryTaskType(task: TaskRecord): TaskType | undefined {
  return ADCP_TASK_TYPES.has(task.tool as TaskType) ? (task.tool as TaskType) : undefined;
}

function toProtocolTaskStatus(task: TaskRecord): GetTaskStatusResponse | undefined {
  const taskType = readRegistryTaskType(task);
  if (taskType === undefined) return undefined;
  const protocol = PROTOCOL_TASK_TYPE_TO_PROTOCOL[taskType] ?? 'media-buy';
  return {
    task_id: task.taskId,
    task_type: taskType,
    protocol,
    status: task.status as TaskStatus,
    created_at: task.createdAt,
    updated_at: task.updatedAt,
    ...(task.status === 'completed' || task.status === 'failed' || task.status === 'canceled'
      ? { completed_at: task.updatedAt }
      : {}),
    ...(task.hasWebhook !== undefined ? { has_webhook: task.hasWebhook === true } : {}),
    ...(task.progress !== undefined ? { progress: task.progress } : {}),
    ...(task.error !== undefined
      ? { error: sanitizeStructuredAdcpError(task.error) as GetTaskStatusResponse['error'] }
      : task.statusMessage !== undefined
        ? {
            error: {
              code: task.status === 'failed' ? 'TASK_FAILED' : 'TASK_STATUS_MESSAGE',
              message: task.statusMessage,
            },
          }
        : {}),
  };
}

function toProtocolTaskListItem(task: TaskRecord): ListTasksResponse['tasks'][number] | undefined {
  const taskType = readRegistryTaskType(task);
  if (taskType === undefined) return undefined;
  const protocol = PROTOCOL_TASK_TYPE_TO_PROTOCOL[taskType] ?? 'media-buy';
  return {
    task_id: task.taskId,
    task_type: taskType,
    domain: protocol === 'signals' ? 'signals' : 'media-buy',
    status: task.status as TaskStatus,
    created_at: task.createdAt,
    updated_at: task.updatedAt,
    ...(task.status === 'completed' || task.status === 'failed' || task.status === 'canceled'
      ? { completed_at: task.updatedAt }
      : {}),
    ...(task.hasWebhook !== undefined ? { has_webhook: task.hasWebhook === true } : {}),
  };
}

function appendSearchableTaskValue(values: string[], value: unknown): void {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    values.push(String(value));
  }
}

function appendSearchableResultIdentifiers(values: string[], value: unknown, depth = 0): void {
  if (depth > 3 || value == null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) appendSearchableResultIdentifiers(values, item, depth + 1);
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (/(^|_)(id|ids|ref|refs)$/.test(key)) {
      if (Array.isArray(child)) {
        for (const item of child) appendSearchableTaskValue(values, item);
      } else {
        appendSearchableTaskValue(values, child);
      }
    }
    if (child != null && typeof child === 'object') {
      appendSearchableResultIdentifiers(values, child, depth + 1);
    }
  }
}

function taskSearchHaystack(task: TaskRecord, item: ListTasksResponse['tasks'][number]): string {
  const values = [item.task_id, item.task_type, item.status, item.domain, task.accountId];
  appendSearchableResultIdentifiers(values, task.result);
  appendSearchableResultIdentifiers(values, task.progress);
  return values.join('\n');
}

function taskMatchesFilters(task: TaskRecord, filters: ListTasksRequest['filters']): boolean {
  if (!isPlainObject(filters)) return true;
  const item = toProtocolTaskListItem(task);
  if (item === undefined) return false;
  const protocol = PROTOCOL_TASK_TYPE_TO_PROTOCOL[item.task_type] ?? 'media-buy';
  if (typeof filters.protocol === 'string' && protocol !== filters.protocol) return false;
  if (Array.isArray(filters.protocols) && !filters.protocols.includes(protocol)) return false;
  if (typeof filters.status === 'string' && item.status !== filters.status) return false;
  if (Array.isArray(filters.statuses) && !filters.statuses.includes(item.status)) return false;
  if (typeof filters.task_type === 'string' && item.task_type !== filters.task_type) return false;
  if (Array.isArray(filters.task_types) && !filters.task_types.includes(item.task_type)) return false;
  if (Array.isArray(filters.task_ids) && !filters.task_ids.includes(item.task_id)) return false;
  if (!taskTimestampMatches(item.created_at, filters.created_after, 'after')) return false;
  if (!taskTimestampMatches(item.created_at, filters.created_before, 'before')) return false;
  if (!taskTimestampMatches(item.updated_at, filters.updated_after, 'after')) return false;
  if (!taskTimestampMatches(item.updated_at, filters.updated_before, 'before')) return false;
  if (typeof filters.has_webhook === 'boolean' && (task.hasWebhook === true) !== filters.has_webhook) return false;
  if (typeof filters.context_contains === 'string' && filters.context_contains.length > 0) {
    if (!taskSearchHaystack(task, item).includes(filters.context_contains)) return false;
  }
  return true;
}

function taskTimestampMatches(value: string, boundary: unknown, direction: 'after' | 'before'): boolean {
  if (typeof boundary !== 'string') return true;
  const valueMs = Date.parse(value);
  const boundaryMs = Date.parse(boundary);
  if (!Number.isFinite(valueMs) || !Number.isFinite(boundaryMs)) return false;
  return direction === 'after' ? valueMs > boundaryMs : valueMs < boundaryMs;
}

function taskBelongsToCaller(task: TaskRecord, accountId: string, ownerScope: string | undefined): boolean {
  if (task.accountId !== accountId) return false;
  if (ownerScope === undefined) return false;
  if (task.ownerScope === undefined) return ownerScope === `account:${accountId}`;
  return task.ownerScope === ownerScope;
}

function taskOwnerScopeForContext(
  authInfo: ResolvedAuthInfo | undefined,
  sessionKey: string | undefined,
  agent: BuyerAgent | undefined,
  accountId: string
): string {
  if (sessionKey !== undefined) return `session:${sessionKey}`;
  if (agent?.agent_url) return `agent:${agent.agent_url}`;
  const credential = authInfo?.credential;
  if (credential?.kind === 'http_sig') return `http_sig:${credential.agent_url}`;
  if (credential?.kind === 'oauth') return `oauth:${credential.client_id}`;
  if (credential?.kind === 'api_key') return `api_key:${credential.key_id}`;
  if (typeof authInfo?.clientId === 'string' && authInfo.clientId.length > 0) return `client:${authInfo.clientId}`;
  return `account:${accountId}`;
}

function compareProtocolTaskItems(
  left: ListTasksResponse['tasks'][number],
  right: ListTasksResponse['tasks'][number],
  sort: ListTasksRequest['sort']
): number {
  const field = isPlainObject(sort) && typeof sort.field === 'string' ? sort.field : 'created_at';
  const direction = isPlainObject(sort) && sort.direction === 'asc' ? 'asc' : 'desc';
  const multiplier = direction === 'asc' ? 1 : -1;
  let result = 0;
  if (field === 'updated_at') result = left.updated_at.localeCompare(right.updated_at);
  else if (field === 'status') result = left.status.localeCompare(right.status);
  else if (field === 'task_type') result = left.task_type.localeCompare(right.task_type);
  else if (field === 'protocol') {
    const leftProtocol = PROTOCOL_TASK_TYPE_TO_PROTOCOL[left.task_type] ?? 'media-buy';
    const rightProtocol = PROTOCOL_TASK_TYPE_TO_PROTOCOL[right.task_type] ?? 'media-buy';
    result = leftProtocol.localeCompare(rightProtocol);
  } else {
    result = left.created_at.localeCompare(right.created_at);
  }
  return result === 0 ? left.task_id.localeCompare(right.task_id) * multiplier : result * multiplier;
}

function parseTaskListCursor(cursor: unknown): number | undefined {
  if (cursor === undefined) return undefined;
  if (typeof cursor !== 'string' || !/^(0|[1-9]\d*)$/.test(cursor)) {
    throw new Error('Invalid task list cursor');
  }
  return Number.parseInt(cursor, 10);
}

function taskListPageSize(pagination: unknown): number {
  if (!isPlainObject(pagination) || typeof pagination.max_results !== 'number') return 50;
  return Math.min(Math.max(Math.floor(pagination.max_results), 1), 100);
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

// Passthrough schema for framework-registered tools by default (#909). See
// the comment at the registerTool call sites for rationale — short version:
// makes our AJV validator authoritative on both transports without destroying
// args on MCP when the SDK's tool dispatcher would otherwise coerce
// `undefined` into the handler for schemaless tools. Servers can opt into
// shallow MCP discovery hints derived from `TOOL_INPUT_SHAPES` with
// config.exposeToolSchemas.
const PASSTHROUGH_INPUT_SCHEMA = z.object({}).passthrough();
type ToolInputShapeMap = Readonly<Record<string, ZodRawShapeCompat | undefined>>;
let cachedToolInputShapes: ToolInputShapeMap | undefined;
const SHALLOW_HINT_FIELD_SCHEMA = z.unknown().optional();
const SHALLOW_HINT_SCHEMAS = new Map<string, AnySchema>();

function getToolInputShapes(): ToolInputShapeMap {
  cachedToolInputShapes ??= TOOL_INPUT_SHAPES as unknown as ToolInputShapeMap;
  return cachedToolInputShapes;
}

function shallowToolInputHintSchema(toolName: string): AnySchema | undefined {
  const inputShape = getToolInputShapes()[toolName];
  if (inputShape === undefined) return undefined;

  const cached = SHALLOW_HINT_SCHEMAS.get(toolName);
  if (cached !== undefined) return cached;

  const hintShape = Object.fromEntries(Object.keys(inputShape).map(key => [key, SHALLOW_HINT_FIELD_SCHEMA]));
  const schema = z.object(hintShape).passthrough();
  SHALLOW_HINT_SCHEMAS.set(toolName, schema);
  return schema;
}

const TOOL_META: Record<string, ToolMeta> = {
  // Media Buy
  get_products: { wrap: productsResponse, annotations: RO },
  create_media_buy: { wrap: mediaBuyResponse, annotations: MUT },
  update_media_buy: { wrap: updateMediaBuyResponse, annotations: MUT },
  get_media_buys: { wrap: getMediaBuysResponse, annotations: RO },
  get_media_buy_delivery: { wrap: deliveryResponse, annotations: RO },
  provide_performance_feedback: { wrap: performanceFeedbackResponse, annotations: MUT },

  // Protocol
  get_task_status: { wrap: null, annotations: RO },
  list_tasks: { wrap: null, annotations: RO },

  // Creative
  list_creative_formats: { wrap: listCreativeFormatsResponse, annotations: RO },
  list_transformers: { wrap: null, annotations: RO },
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

  // Governance - Collection Lists
  create_collection_list: { wrap: null, annotations: MUT },
  update_collection_list: { wrap: null, annotations: MUT },
  get_collection_list: { wrap: null, annotations: RO },
  list_collection_lists: { wrap: null, annotations: RO },
  delete_collection_list: { wrap: null, annotations: DEST },

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
  update_rights: { wrap: updateRightsResponse, annotations: MUT },
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
  { handlerKey: 'listTransformers', toolName: 'list_transformers' },
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
  { handlerKey: 'createCollectionList', toolName: 'create_collection_list' },
  { handlerKey: 'updateCollectionList', toolName: 'update_collection_list' },
  { handlerKey: 'getCollectionList', toolName: 'get_collection_list' },
  { handlerKey: 'listCollectionLists', toolName: 'list_collection_lists' },
  { handlerKey: 'deleteCollectionList', toolName: 'delete_collection_list' },
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
  { handlerKey: 'updateRights', toolName: 'update_rights' },
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

function sanitizePayloadError(value: unknown): unknown {
  if (!isPlainObject(value)) return value;
  const code = value.code;
  if (typeof code !== 'string') return value;
  const sanitized = applyAdcpErrorAllowlist(code, value);
  if (!isStandardErrorCode(code)) return sanitized;

  const safe = sanitized as unknown as Record<string, unknown>;
  const projected: Record<string, unknown> = {
    code,
    message: typeof safe.message === 'string' ? safe.message : 'operation failed',
    recovery: STANDARD_ERROR_CODES[code].recovery,
  };
  for (const key of ['field', 'suggestion', 'retry_after', 'issues']) {
    if (safe[key] !== undefined) projected[key] = safe[key];
  }
  if (safe.details !== undefined) {
    projected.details = safe.details;
  }
  return projected;
}

function sanitizePayloadErrors(sc: Record<string, unknown>): boolean {
  if (!Array.isArray(sc.errors)) return false;
  const sanitized = sc.errors.map(sanitizePayloadError);
  const changed = sanitized.some((value, index) => value !== (sc.errors as unknown[])[index]);
  if (changed) sc.errors = sanitized;
  return changed;
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
  const sanitizedErrors = value.errors.map(sanitizePayloadError);
  const firstError = sanitizedErrors[0] as { code?: unknown; message?: unknown } | undefined;
  const summary =
    firstError && typeof firstError === 'object'
      ? `${typeof firstError.code === 'string' ? firstError.code : 'ERROR'}: ${typeof firstError.message === 'string' ? firstError.message : 'operation failed'}`
      : 'operation failed';
  return {
    content: [{ type: 'text', text: summary }],
    isError: true,
    structuredContent: { ...value, errors: sanitizedErrors } as unknown as Record<string, unknown>,
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

  const filtered = applyAdcpErrorAllowlist(code, err);
  const filteredRecord = filtered as unknown as Record<string, unknown>;
  let changed = false;
  for (const key of new Set([...Object.keys(err), ...Object.keys(filtered)])) {
    if (err[key] !== filteredRecord[key]) {
      changed = true;
      break;
    }
  }
  if (!changed) return;

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

/**
 * Fields valid on a payload-layer `errors[]` item per the bundled
 * `core/error.json` schema. Both layers of the AdCP error model carry
 * the same conceptual fields, so the dispatcher projects from one to
 * the other 1:1 — but the projection still needs to know which keys
 * are part of the contract.
 *
 * `recovery` is included even though the schema marks it optional: it
 * is the autonomous-buyer dispatch signal, and dropping it on the
 * payload while keeping it on the envelope would force callers to read
 * both layers to classify the failure. Mirroring matches the spec's
 * intent (both layers carry the same data) without surprising adopters
 * who rely on either side.
 */
const PAYLOAD_ERROR_FIELDS: ReadonlySet<string> = new Set([
  'code',
  'message',
  'recovery',
  'field',
  'suggestion',
  'retry_after',
  'issues',
  'details',
]);

function projectEnvelopeToPayloadError(envelope: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(envelope)) {
    if (PAYLOAD_ERROR_FIELDS.has(key)) out[key] = envelope[key];
  }
  return out;
}

function projectPayloadErrorToEnvelope(payloadError: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(payloadError)) {
    if (PAYLOAD_ERROR_FIELDS.has(key)) out[key] = payloadError[key];
  }
  return out;
}

/**
 * Two-layer error emission for tools whose response schema declares a
 * typed Error arm (`errors[]` required) at the top level.
 *
 * The AdCP spec (RFC `docs/proposals/adcperror-two-layer-emission.md`,
 * `error-code.json#GOVERNANCE_DENIED`) requires both layers on the
 * failure path:
 *
 *   - **Envelope layer**: `structuredContent.adcp_error: {code, message, ...}`
 *     — the cross-protocol marker, programmatic extraction.
 *   - **Payload layer**: `structuredContent.errors: [{code, message, ...}]`
 *     — the typed Error arm of the response union.
 *
 * `adcpError()` emits the envelope only; `wrapErrorArm()` emits the
 * payload only. This dispatcher seam fills in whichever layer is
 * missing so the wire is two-layer regardless of which helper the
 * adopter used. Idempotent on already-two-layer payloads (presence of
 * both `adcp_error` and `errors[]` is a no-op).
 *
 * Gated on `toolsWithErrorArm` derived from the bundled schema cache:
 * tools whose schema doesn't define `errors[]` (`get_adcp_capabilities`,
 * `tasks/get`, `get_products`, etc.) are left unchanged.
 *
 * Scope is the failure path only — early returns when neither layer is
 * present. Success-arm responses pass through untouched.
 */
function enrichErrorTwoLayer(
  response: McpToolResponse,
  toolName: string,
  toolsWithErrorArm: ReadonlyMap<string, ErrorArmDescriptor>
): void {
  const descriptor = toolsWithErrorArm.get(toolName);
  if (!descriptor) return;
  const sc = response.structuredContent as Record<string, unknown> | undefined;
  if (!sc || typeof sc !== 'object') return;

  const env = sc.adcp_error as Record<string, unknown> | undefined;
  const envValid = env != null && typeof env === 'object' && typeof env.code === 'string';
  const payloadList = sc.errors;
  const payloadValid = Array.isArray(payloadList) && payloadList.length > 0;
  if (payloadValid && sanitizePayloadErrors(sc)) syncContentJsonText(response, sc);

  // Path A: envelope present, payload missing → synthesise payload-layer
  // `errors[]` from the envelope. The `adcpError()` builder always lands
  // here; hand-rolled `{adcp_error: {...}}` envelopes too.
  if (envValid && !payloadValid) {
    sc.errors = [projectEnvelopeToPayloadError(env)];
    applyArmDiscriminators(sc, descriptor);
    syncContentJsonText(response, sc);
    return;
  }

  // Path B: payload present, envelope missing → synthesise envelope from
  // the first payload item. `wrapErrorArm()` lands here when adopters
  // return a typed Error arm directly.
  if (!envValid && payloadValid) {
    const first = (sc.errors as unknown[])[0];
    if (first && typeof first === 'object') {
      const projected = projectPayloadErrorToEnvelope(first as Record<string, unknown>);
      // Only stamp the envelope if the payload's first item carries the
      // minimum spec-required `code` + `message`. A malformed Error arm
      // (already warned about by the dispatcher's `isErrorArm` branch)
      // shouldn't synthesise a half-formed envelope.
      if (typeof projected.code === 'string' && typeof projected.message === 'string') {
        sc.adcp_error = projected;
        applyArmDiscriminators(sc, descriptor);
        syncContentJsonText(response, sc);
      }
    }
    return;
  }

  // Path C: both layers present (handler emitted a fully-formed
  // two-layer payload). Idempotent passthrough — adopters that already
  // ship the correct shape are not mutated. Discriminator constants
  // are NOT stamped here: an adopter that built both layers also chose
  // their own discriminator value, and overriding it could break the
  // arm they intended to land in.
}

/**
 * Stamp a tool's Error-arm discriminator constants on the response
 * payload. For most tools the descriptor is empty (the arm requires
 * `errors[]` only) and this is a no-op. `update_content_standards` is
 * the canonical case: its Error arm declares `success: { const: false }`
 * — without this stamp, the synthesised payload would still match the
 * Success arm's `success: false` value (absent → undefined, neither
 * `const: true` nor `const: false`), so the schema would reject the
 * response on either branch.
 *
 * Only stamps fields that are NOT already set on the payload — adopters
 * who deliberately set the discriminator (e.g. mid-migration) keep
 * their choice.
 */
function applyArmDiscriminators(sc: Record<string, unknown>, descriptor: ErrorArmDescriptor): void {
  for (const [key, value] of Object.entries(descriptor.extraRequired)) {
    if (!(key in sc)) sc[key] = value;
  }
}

/**
 * Mirror a mutated `structuredContent` back into the L2 JSON text fallback
 * so MCP clients reading either transport layer see the same shape. Silent
 * no-op when the L2 text isn't a JSON envelope (legitimate for non-JSON
 * `content[0].text` summaries from `wrapErrorArm`).
 */
function syncContentJsonText(response: McpToolResponse, structuredContent: Record<string, unknown>): void {
  if (!Array.isArray(response.content)) return;
  const first = response.content[0];
  if (!first || first.type !== 'text' || typeof first.text !== 'string') return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(first.text);
  } catch {
    // Not a JSON-bodied L2 fallback (e.g. wrapErrorArm's "CODE: message"
    // summary). Leave it alone — the L3 structuredContent is the
    // authoritative carrier; readers that fall back to L2 prose can
    // still extract the code via pattern match.
    return;
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return;
  first.text = JSON.stringify(structuredContent);
}

function missingGetProductsCacheScopeIssue(): ValidationIssue {
  return {
    pointer: '/cache_scope',
    message: "must have required property 'cache_scope'",
    keyword: 'required',
    schemaPath: '#/required',
    hint: '`get_products` responses with `products` or `unchanged: true` must include `cache_scope`: use `public` for the universal rate card, `account` for account-specific overlays.',
  };
}

function normalizeGetProductsCacheScope(
  response: McpToolResponse,
  params: unknown,
  account: unknown,
  authInfo: unknown,
  exposeSchemaPath: boolean
): McpToolResponse | undefined {
  const sc = response.structuredContent as Record<string, unknown> | undefined;
  if (!sc || typeof sc !== 'object') return undefined;
  if (!Array.isArray(sc.products) && sc.unchanged !== true) return undefined;
  if (sc.cache_scope !== undefined) return undefined;

  const request =
    params && typeof params === 'object' && !Array.isArray(params) ? (params as Record<string, unknown>) : {};
  if (request.account != null || account != null || authInfo != null) {
    return adcpError(
      'VALIDATION_ERROR',
      buildAdcpValidationErrorPayload('get_products', 'response', [missingGetProductsCacheScopeIssue()], {
        exposeSchemaPath,
      })
    );
  }

  // Safe inference only: a product feed with neither an inline account nor an
  // auth context cannot contain an account-specific overlay, so it is cacheable
  // as the public layer. Any account or auth context makes omission ambiguous;
  // strict response validation should surface that.
  sc.cache_scope = 'public';
  syncContentJsonText(response, sc);
  return undefined;
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

/**
 * Inject `adcp_version` into the response body so the seller echoes the
 * release served per spec PR `adcontextprotocol/adcp#3493`. Mirrors
 * `injectContextIntoResponse`'s structuredContent + L2-text-fallback dual
 * write so MCP clients reading either layer see the field. Only injects on
 * AdCP 3.1+ — 3.0 schemas don't define the field.
 *
 * `servedVersion` is the seller's release-precision identifier (output of
 * `resolveBundleKey(adcpVersion)`). For now it always reflects the seller's
 * own pin; downshift (3.1 seller serving a 3.0 buyer at 3.0) is a follow-up.
 */
/**
 * Stamp the v3 protocol envelope's required `status` field on success
 * responses. Per AdCP #4876, every task response envelope MUST carry
 * `status`; synchronous calls emit `"completed"`. Mirrors
 * `injectContextIntoResponse`'s structuredContent + L2-text-fallback
 * dual write so MCP clients reading either layer see the field.
 *
 * Skipped when:
 * - `isError: true` — error envelopes carry their own status semantics
 *   (`failed` / `rejected` / etc.). Wired separately by the adcp_error
 *   path; not this seam's concern.
 * - `structuredContent.status` already present — handler-declared status
 *   takes precedence. Preserves:
 *     • the Submitted envelope's `status: 'submitted'`,
 *     • payloads whose typed shape carries its own top-level `status`
 *       discriminator (`CreateMediaBuySuccess.status: MediaBuyStatus`,
 *       `UpdateMediaBuySuccess.status: MediaBuyStatus`, the
 *       `cancelMediaBuyResponse` builder's hard-coded `status: 'canceled'`).
 *   The MediaBuyStatus/TaskStatus collision at the same top-level key is
 *   a spec ambiguity tracked at adcp-client#1897; this seam refuses to
 *   destroy payload semantics until the spec disambiguates.
 */
function injectEnvelopeStatusIntoResponse(response: McpToolResponse): void {
  const sc = response.structuredContent as Record<string, unknown> | undefined;
  if (!sc || typeof sc !== 'object') return;
  if ('status' in sc) return;
  // AdCP 3.1.0-beta.2+ requires envelope `status` on EVERY response, error
  // or otherwise. Map MCP's `isError` to the wire-level task state:
  //   - `isError: true`           → `'failed'`  (task explicitly failed)
  //   - `isError: false`/absent   → `'completed'` (default for success path)
  // Tools that need richer states (`submitted`, `working`, `input-required`)
  // should set `status` themselves; this injector only fills in the default
  // when the handler hasn't.
  const status = response.isError === true ? 'failed' : 'completed';
  sc.status = status;
  if (Array.isArray(response.content)) {
    const first = response.content[0];
    if (first && first.type === 'text' && typeof first.text === 'string') {
      try {
        const parsed = JSON.parse(first.text);
        if (parsed && typeof parsed === 'object' && !('status' in parsed)) {
          parsed.status = status;
          first.text = JSON.stringify(parsed);
        }
      } catch {
        // Text isn't JSON — leave it alone
      }
    }
  }
}

const MEDIA_BUY_RESPONSE_TOOLS_REQUIRING_STATUS_SPLIT = new Set([
  'create_media_buy',
  'update_media_buy',
  'cancel_media_buy',
]);

const MEDIA_BUY_STATUS_VALUES = new Set([
  'pending_creatives',
  'pending_start',
  'active',
  'paused',
  'completed',
  'rejected',
  'canceled',
]);

function normalizeMediaBuyStatusCollision(response: McpToolResponse, toolName: string): void {
  if (!MEDIA_BUY_RESPONSE_TOOLS_REQUIRING_STATUS_SPLIT.has(toolName)) return;
  const sc = response.structuredContent as Record<string, unknown> | undefined;
  if (!sc || typeof sc !== 'object') return;
  const status = sc.status;
  if (typeof status !== 'string' || !MEDIA_BUY_STATUS_VALUES.has(status)) return;
  const looksLikeMediaBuyPayload =
    typeof sc.media_buy_id === 'string' || 'media_buy_status' in sc || Array.isArray(sc.packages);
  if (!looksLikeMediaBuyPayload) return;
  if (sc.media_buy_status === undefined) sc.media_buy_status = status;
  delete sc.status;
  syncContentJsonText(response, sc);
}

function injectVersionIntoResponse(response: McpToolResponse, servedVersion: string | undefined): void {
  if (!servedVersion) return;
  // Normalize to release-precision (`3.1-beta.3`) before emitting — the wire
  // regex rejects full-semver (`3.1.0-beta.3`). Bundle metadata is published
  // with the patch digit; on-the-wire `adcp_version` is not. See the spec
  // note on `adcp_version` in `core.generated.ts` and the helper itself.
  const wireVersion = toReleasePrecisionVersion(servedVersion);
  const sc = response.structuredContent as Record<string, unknown> | undefined;
  if (sc && typeof sc === 'object' && !('adcp_version' in sc)) {
    sc.adcp_version = wireVersion;
    if (Array.isArray(response.content)) {
      const first = response.content[0];
      if (first && first.type === 'text' && typeof first.text === 'string') {
        try {
          const parsed = JSON.parse(first.text);
          if (parsed && typeof parsed === 'object' && !('adcp_version' in parsed)) {
            parsed.adcp_version = wireVersion;
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
  capabilityRequestSigning?: NonNullable<GetAdCPCapabilitiesResponse['request_signing']>
): AdcpPreTransport {
  // Precedence: explicit signedRequests.required_for > capabilities.request_signing.required_for
  // > fallback to every mutating task. Buyers read required_for from
  // get_adcp_capabilities to decide which calls to sign — defaulting to
  // MUTATING_TASKS when the seller advertised a narrower list would cause
  // buyers to get request_signature_required on tools they had no contractual
  // duty to sign.
  const requiredFor = signedRequests.required_for ?? capabilityRequestSigning?.required_for ?? [...MUTATING_TASKS];
  const protocolMethodsRequiredFor =
    signedRequests.protocol_methods_required_for ?? capabilityRequestSigning?.protocol_methods_required_for;
  const verifier = createExpressVerifier({
    capability: {
      supported: true,
      covers_content_digest: signedRequests.covers_content_digest ?? 'either',
      required_for: requiredFor,
      ...(protocolMethodsRequiredFor ? { protocol_methods_required_for: protocolMethodsRequiredFor } : {}),
    },
    jwks: signedRequests.jwks,
    replayStore: signedRequests.replayStore,
    revocationStore: signedRequests.revocationStore,
    ...(signedRequests.agentUrlForKeyid ? { agentUrlForKeyid: signedRequests.agentUrlForKeyid } : {}),
    resolveOperation: req => {
      const raw = (req as { rawBody?: string }).rawBody;
      if (!raw) return undefined;
      try {
        const parsed = JSON.parse(raw) as unknown;
        const messages = Array.isArray(parsed) ? parsed : [parsed];
        const operations = messages.flatMap(message => {
          if (message == null || typeof message !== 'object') return [];
          const candidate = message as { method?: unknown; params?: { name?: unknown } };
          return candidate.method === 'tools/call' && typeof candidate.params?.name === 'string'
            ? [candidate.params.name]
            : [];
        });
        return operations.find(operation => requiredFor.includes(operation)) ?? operations[0];
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
// Version-claim validation helpers
// ---------------------------------------------------------------------------

/**
 * Compute the set of `adcp_major_version` integers this seller accepts on
 * inbound requests. Used by the single-field VERSION_UNSUPPORTED check
 * (issue #1075) to reject buyer claims outside the seller's advertised
 * window.
 *
 * Sources, in priority order:
 * 1. `capConfig.major_versions` — deprecated integer list (AdCP <3.1).
 * 2. `capConfig.supported_versions` — release-precision strings (AdCP 3.1+
 *    per spec PR `adcontextprotocol/adcp#3493`); each entry's parsed major
 *    is added to the set.
 * 3. Fallback to the major of `serverPin` so a seller that omits both lists
 *    still rejects out-of-window claims rather than silently dispatching.
 */
function getAdvertisedSupportedMajors(capConfig: AdcpCapabilitiesConfig | undefined, serverPin: string): Set<number> {
  const out = new Set<number>();
  for (const m of capConfig?.major_versions ?? []) {
    if (Number.isFinite(m)) out.add(m);
  }
  for (const v of capConfig?.supported_versions ?? []) {
    const m = parseAdcpMajorVersion(v);
    if (Number.isFinite(m)) out.add(m);
  }
  if (out.size === 0) {
    const pinMajor = parseAdcpMajorVersion(serverPin);
    if (Number.isFinite(pinMajor)) out.add(pinMajor);
  }
  return out;
}

/**
 * Build the `supported_versions` string array shipped on the
 * `VERSION_UNSUPPORTED` error envelope so buyers can downgrade their pin
 * and retry. Mirrors `getAdvertisedSupportedMajors` precedence:
 *
 * 1. `capConfig.supported_versions` — emit verbatim (release-precision strings).
 * 2. Else `capConfig.major_versions` — stringify each integer.
 * 3. Else fall back to the server pin's major as a single-entry list.
 *
 * Strings are preferred over integers because release-precision strings
 * round-trip more information; emitting a single-source listing avoids
 * confusing buyers with both integer and string shapes for the same major.
 * (`getAdvertisedSupportedMajors` unions both sources for the accepted-set
 * check, but this function picks one to avoid that ambiguity on the wire.)
 *
 * Buyer-side parser (`extractVersionUnsupportedDetails`) already filters
 * non-strings, so a `String(N)` fallback round-trips cleanly across 3.0
 * and 3.1 sellers.
 */
function buildSupportedVersionsList(capConfig: AdcpCapabilitiesConfig | undefined, serverPin: string): string[] {
  if (capConfig?.supported_versions?.length) {
    return [...capConfig.supported_versions];
  }
  if (capConfig?.major_versions?.length) {
    return capConfig.major_versions.filter(m => Number.isFinite(m)).map(m => String(m));
  }
  const pinMajor = parseAdcpMajorVersion(serverPin);
  return Number.isFinite(pinMajor) ? [String(pinMajor)] : [];
}

// ---------------------------------------------------------------------------
// createAdcpServer
// ---------------------------------------------------------------------------

/**
 * Create an AdCP-compliant MCP server from domain-grouped handler functions.
 *
 * @deprecated New adopters should use `createAdcpServerFromPlatform` from
 * `@adcp/sdk/server` instead. This v5 handler-bag entry point is kept for
 * legacy / mid-migration code; LLM-generated platforms scaffolding from
 * any of the v6 skills should NEVER call this. The v6 path
 * (`createAdcpServerFromPlatform`) wraps this function with: typed
 * specialism interfaces (`SalesPlatform`, `CreativeBuilderPlatform`, etc.),
 * compile-time capability enforcement (`RequiredPlatformsFor<S>`), the
 * `ctx_metadata` round-trip cache for adapter-internal state,
 * auto-hydration of `req.packages[i].product` on createMediaBuy,
 * default `resolveIdempotencyPrincipal` synthesis, capability projection,
 * async-task envelopes, status normalization via `StatusMappers`,
 * multi-tenant routing via `TenantRegistry`, and webhook auto-emit on
 * sync responses with `push_notification_config.url`.
 *
 * Reach for `createAdcpServer` directly only when you need fine control
 * over individual handlers, are mid-migration from a v5 codebase, or
 * have custom-shaped tools the platform interface doesn't yet model.
 *
 * @see {@link createAdcpServerFromPlatform} — the canonical v6 entry.
 * @see `@adcp/sdk/server/legacy/v5` — the stable subpath for long-term
 *   v5 pinning. The top-level re-export here may be removed in a
 *   future major; the subpath is the supported home.
 * See `docs/migration-5.x-to-6.x.md`.
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
    adcpVersion: configuredAdcpVersion,
    resolveAccount,
    resolveAccountFromAuth,
    resolveSessionKey,
    agentRegistry,
    exposeErrorDetails = process.env.NODE_ENV !== 'production',
    stateStore = DEFAULT_STATE_STORE,
    taskRegistry,
    logger = noopLogger,
    capabilities: capConfig,
    idempotency: idempotencyConfig,
    resolveIdempotencyPrincipal,
    instructions: instructionsOption,
    onInstructionsError = 'skip',
    taskStore,
    taskMessageQueue,
    webhooks,
    signedRequests,
    validation: validationConfig,
    credentialPolicy,
    testController: testControllerBridge,
    responseEnhancer,
  } = config;
  const frameworkInputSchemaFor = (toolName: string) =>
    config.exposeToolSchemas === true
      ? (shallowToolInputHintSchema(toolName) ?? PASSTHROUGH_INPUT_SCHEMA)
      : PASSTHROUGH_INPUT_SCHEMA;
  const mcpAppResources = normalizeMcpAppResources(config.resources);
  const mcpAppResourceUris = new Set<string>(mcpAppResources.map(resource => resource.uri));
  for (const [toolName, tool] of Object.entries(config.customTools ?? {})) {
    const resourceUri = tool?._meta?.ui?.resourceUri;
    if (resourceUri === undefined || mcpAppResourceUris.has(resourceUri)) continue;
    const message =
      `[adcp/createAdcpServer] customTools["${toolName}"]._meta.ui.resourceUri references ` +
      `"${resourceUri}", but no matching MCP App resource is configured in resources[].`;
    process.emitWarning(message, { type: 'AdcpServerConfigWarning', code: 'ADCP_MCP_APP_RESOURCE_MISSING' });
    logger.warn(message);
  }

  // One-shot construction-time warn when `testController` is wired without
  // any account resolver. The dispatch-time sandbox gate admits requests
  // where `ctx.account === undefined`, so without a resolver the only
  // remaining check is buyer-supplied `account.sandbox` / `context.sandbox`
  // on the request — caller-controlled, not a trust boundary. Storyboard
  // runners legitimately have no account scoping and should ignore this
  // warning; production bindings need to wire `resolveAccount` (or
  // `resolveAccountFromAuth` for OAuth-passthrough setups) so the gate's
  // account-side check has teeth.
  //
  // Dual-emit: `process.emitWarning` writes to stderr by default so the
  // signal is visible even when `logger` is the default `noopLogger`
  // (the day-one case where the misconfig is most likely). `logger.warn`
  // also fires so adopters with configured logging pipelines see it in
  // their normal channel. The `code` lets adopters silence it via
  // `--no-warnings=ADCP_BRIDGE_NO_RESOLVER` if they're knowingly running
  // a storyboard-runner config. See `AdcpServerConfig.testController`
  // JSDoc § "Security — trust boundary" and #1784.
  if (testControllerBridge != null && resolveAccount === undefined && resolveAccountFromAuth === undefined) {
    const message =
      '[adcp/createAdcpServer] testController is wired but no account resolver — configure resolveAccount (or resolveAccountFromAuth) for production. Storyboard runners without account scoping can ignore. Details: https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/VALIDATE-YOUR-AGENT.md';
    process.emitWarning(message, { type: 'AdcpServerConfigWarning', code: 'ADCP_BRIDGE_NO_RESOLVER' });
    logger.warn(message);
  }

  // Pre-resolve credential-policy patterns once. The patterns config is
  // a stable property of `CredentialPolicyConfig`; pulling it out here
  // keeps the per-call hot path (`scanArgsForCredentials`) free of the
  // string-vs-object discrimination on every dispatch.
  const credentialPolicyPatterns =
    credentialPolicy === undefined || typeof credentialPolicy === 'string' ? undefined : credentialPolicy.patterns;

  // Resolve `adcpVersion` early — the validator-call closures below capture
  // it by reference and would hit a TDZ ReferenceError if any of them ran
  // synchronously during setup. They don't today (`createAdcpServer`
  // registers handlers; the handlers fire on incoming requests after
  // `wrapMcpServer` returns), but the ordering hides a sharp edge for
  // future refactors. Throws `ConfigurationError` on cross-major pins
  // whose schema bundle isn't shipped — see utils/adcp-version-config.ts.
  const adcpVersion = resolveAdcpVersion(configuredAdcpVersion);

  // Pre-resolved release-precision identifier the seller echoes on every
  // response per AdCP 3.1 spec PR `adcontextprotocol/adcp#3493`. `undefined`
  // when this seller pins a 3.0 bundle (3.0 schemas don't define the field).
  // Computed once at construction since the seller's pin is fixed for the
  // server's lifetime — every dispatch reuses the same value. Downshift
  // (3.1 seller serving a 3.0 buyer at 3.0) is a follow-up; today this
  // always reflects the seller's own pin.
  const protocolBundleKey = resolveBundleKey(adcpVersion);
  const servedAdcpVersion = (() => {
    const bundleKey = protocolBundleKey;
    return bundleSupportsAdcpVersionField(bundleKey) ? bundleKey : undefined;
  })();
  const supportsProtocolTaskTools =
    protocolBundleKey === '3.1.0-rc.7' ||
    protocolBundleKey === '3.1-rc.7' ||
    protocolBundleKey === '3.1.0-rc.8' ||
    protocolBundleKey === '3.1-rc.8' ||
    protocolBundleKey === '3.1.0-rc.9' ||
    protocolBundleKey === '3.1-rc.9' ||
    protocolBundleKey === '3.1.0-rc.10' ||
    protocolBundleKey === '3.1-rc.10' ||
    protocolBundleKey === '3.1.0-rc.13' ||
    protocolBundleKey === '3.1-rc.13' ||
    protocolBundleKey === '3.1.0-rc.14' ||
    protocolBundleKey === '3.1-rc.14' ||
    protocolBundleKey === '3.1-rc' ||
    protocolBundleKey === '3.1';

  // Tool-name set for two-layer error emission. Computed once at server
  // build from the bundled response schemas: any tool whose top-level
  // `oneOf`/`anyOf` declares an arm with `required: ["errors"]` joins
  // the set, and the dispatcher mirrors `errors[]` ↔ `adcp_error` on
  // the failure path so both spec-mandated layers ride on every
  // failing response. Tools without an Error arm are untouched.
  // RFC: docs/proposals/adcperror-two-layer-emission.md.
  const toolsWithErrorArm = getToolsWithErrorArm(adcpVersion);

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

  // Production gate on the default in-memory `stateStore`. Mirrors
  // `buildDefaultTaskRegistry` policy in `from-platform.ts` and the
  // `idempotency: 'disabled'` allowlist above: the module-singleton
  // default is correct for dev and single-tenant agents, but
  // multi-tenant production deployments that mint one
  // `createAdcpServer` per resolved tenant would silently share state
  // across tenants. Refuse outside `{NODE_ENV=test, NODE_ENV=development}`
  // unless the adopter sets `ADCP_DECISIONING_ALLOW_INMEMORY_STATE=1` as
  // an explicit ops escape hatch. v6.0 shipped this as a one-time warn;
  // 6.0.1 promotes it to a hard refusal so the production footgun closes
  // before any adopter trips on it.
  //
  // Ordered AFTER the idempotency-disabled gate so adopters who hit
  // both surface the higher-severity error (idempotency-disabled
  // double-executes mutations on retry; state-store sharing leaks
  // tenant data — both bad, idempotency goes first because the
  // recovery is "wire a store" while state-store recovery is "pass
  // your own").
  if (stateStore === DEFAULT_STATE_STORE) {
    const env = process.env.NODE_ENV;
    const safe = env === 'test' || env === 'development';
    const ack = process.env.ADCP_DECISIONING_ALLOW_INMEMORY_STATE === '1';
    if (!safe && !ack) {
      throw new Error(
        'createAdcpServer: in-memory state store refused outside ' +
          '{NODE_ENV=test, NODE_ENV=development}. The default ' +
          '`InMemoryStateStore` is a process-shared module singleton — ' +
          'single-tenant agents get the documented `ctx.store` cross-request ' +
          'persistence, but multi-tenant deployments would silently share ' +
          'state across resolved tenants. Pick one of:\n' +
          '  1. (Recommended) Pass `stateStore: new PostgresStateStore({ pool })` ' +
          'to keep state across restarts AND partition across tenants. See ' +
          '`@adcp/sdk/server` for the migration helper.\n' +
          '  2. Pass `stateStore: new InMemoryStateStore()` explicitly if you ' +
          'accept that state is per-process and shared across all resolved ' +
          'tenants. Single-tenant agents only.\n' +
          '  3. ADCP_DECISIONING_ALLOW_INMEMORY_STATE=1 env flag is the ops ' +
          'escape hatch (same effect as #2 but config-only); prefer #2 in ' +
          'adopter code so the choice is visible at the call site.'
      );
    }
  }

  // Enforce that the verifier config has a buyer-visible discovery surface.
  // When `signedRequests` is set but neither the deprecated `signed-requests`
  // specialism claim NOR `capabilities.request_signing.supported: true` is
  // declared, buyers can't discover the signing requirement from
  // `get_adcp_capabilities` — they won't sign, the verifier rejects every
  // mutating call, and the agent is dead on arrival. Two discovery surfaces
  // are accepted:
  //
  // - **3.1+ canonical (recommended):** `capabilities.request_signing.supported: true`.
  //   The universal signed_requests storyboard runs on this signal alone and
  //   the runner emits `request_signing.required` notices for buyers.
  // - **Back-compat:** `specialisms: ['signed-requests']`. The 3.0-era enum
  //   is preserved through the AdCP 4.0 deprecation cycle (adcp#3075). The
  //   runner emits `signed_requests_specialism_deprecated` notice when this
  //   path is taken (adcp-client#2082, adcp#4796).
  //
  // The opposite direction — advertising signing without a `signedRequests`
  // config — is only wrong when the agent also doesn't wire a verifier via
  // `serve({ preTransport })`. Legacy servers that hand-build the middleware
  // fall into this case and are still conformant. We log a loud error so
  // operators notice (matching the idempotency guardrail precedent) but
  // don't throw, leaving the manual path working.
  const specialismsClaimed = capConfig?.specialisms ?? [];
  const claimsSignedRequests = specialismsClaimed.includes('signed-requests');
  const declaresRequestSigningCapability = capConfig?.request_signing?.supported === true;
  if (signedRequests && !claimsSignedRequests && !declaresRequestSigningCapability) {
    throw new Error(
      'createAdcpServer: `signedRequests` is configured but neither ' +
        '`capabilities.request_signing.supported: true` nor `capabilities.specialisms: ["signed-requests"]` is declared. ' +
        'Buyers discover the signing requirement from get_adcp_capabilities — ' +
        'set `capabilities.request_signing = { supported: true, ... }` (canonical 3.1+ form, recommended) ' +
        'or claim the deprecated `signed-requests` specialism (back-compat). ' +
        "Omitting both surfaces means buyers won't sign their requests."
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

  // Cross-domain specialism declaration check. When a domain handler group
  // is wired, `capabilities.specialisms` SHOULD include at least one of that
  // domain's specialisms — otherwise the conformance runner grades the agent
  // as "No applicable tracks found for this agent" silently, even when every
  // tool works. The matrix v18 run (issue #785) had this drift class account
  // for ~30% of "agent built every tool but storyboard reports no applicable
  // tracks" cases.
  //
  // Logged via `logger.error` (matching the idempotency-disabled precedent)
  // rather than thrown because middleware-only test harnesses legitimately
  // wire handlers without declaring specialisms — production agents will see
  // the warning and conformance fail loudly, but tests stay passing.
  //
  // mediaBuy is intentionally excluded — its specialism choices
  // (sales-non-guaranteed vs sales-guaranteed vs sales-broadcast-tv vs
  // sales-social etc.) are commercially significant and an agent wiring
  // `mediaBuy.getProducts` may legitimately defer the specialism
  // declaration to a follow-up. The skill examples in build-seller-agent
  // already cover the right declaration; the runtime guardrail floor is
  // set at "if you wire creative/signals/brand/governance handlers,
  // you SHOULD claim a specialism."
  //
  // governance is intentionally COARSE: any governance specialism
  // satisfies the check even though individual handlers map to specific
  // specialisms (createPropertyList → property-lists, calibrateContent →
  // content-standards, etc.). Per-handler-subgroup mapping is a
  // follow-up; the coarse rule catches the drift class (governance
  // handlers wired, no claim at all) without false-positives on
  // legitimate cross-cutting reads (e.g., a sales agent that calls
  // getPropertyList for read-only joins and claims its sales specialism).
  const isWired = (handlers: Record<string, unknown> | undefined): boolean => {
    // Filter to function-valued keys so `{ listCreativeFormats: undefined }`
    // (a key set to undefined, e.g. via `{ ...maybeHandlers }` spread) is
    // treated as not wired. `Object.keys` would otherwise count the key.
    if (!handlers) return false;
    return Object.values(handlers).some(v => typeof v === 'function');
  };

  const DOMAIN_SPECIALISM_REQUIREMENTS = [
    {
      domain: 'creative' as const,
      wired: isWired(config.creative as Record<string, unknown> | undefined),
      specialisms: ['creative-ad-server', 'creative-generative', 'creative-template', 'creative-transformers'] as const,
    },
    {
      domain: 'signals' as const,
      wired: isWired(config.signals as Record<string, unknown> | undefined),
      specialisms: ['signal-marketplace', 'signal-owned'] as const,
    },
    {
      domain: 'brandRights' as const,
      wired: isWired(config.brandRights as Record<string, unknown> | undefined),
      specialisms: ['brand-rights'] as const,
    },
    {
      domain: 'governance' as const,
      wired: isWired(config.governance as Record<string, unknown> | undefined),
      specialisms: [
        'governance-spend-authority',
        'governance-delivery-monitor',
        'property-lists',
        'collection-lists',
        'content-standards',
      ] as const,
    },
  ];

  for (const req of DOMAIN_SPECIALISM_REQUIREMENTS) {
    if (!req.wired) continue;
    const claimedFromDomain = req.specialisms.filter(s => (specialismsClaimed as readonly string[]).includes(s));
    if (claimedFromDomain.length === 0) {
      logger.error(
        `createAdcpServer: ${req.domain} handlers are wired but capabilities.specialisms ` +
          `does not include any ${req.domain} specialism. Add at least one of ` +
          `${req.specialisms.map(s => `'${s}'`).join(', ')} to capabilities.specialisms — ` +
          `without it, the conformance runner reports "No applicable tracks found" and ` +
          `the agent grades as failing despite working tools.`
      );
    }
  }

  // Instantiate the emitter once — handler contexts expose its `emit`
  // bound method so per-request code calls `ctx.emitWebhook(...)` without
  // knowing about the emitter's construction or options.
  const webhookEmitter = webhooks ? createWebhookEmitter(webhooks) : undefined;

  // Resolve `instructions` — sync function form is evaluated at construction.
  // Under `serve({ reuseAgent: false })` (the default) the factory runs
  // per HTTP request, so the function fires per session. Under
  // `reuseAgent: true` the function would fire once and never again —
  // `serve()` refuses that combination via `ADCP_INSTRUCTIONS_FN`.
  // Async function form: a Promise return is stored here; resolution is
  // deferred to the MCP `initialize` handler via `wrapInitializeHandler`.
  const instructionsIsFn = typeof instructionsOption === 'function';
  let resolvedInstructions: string | undefined;
  let pendingInstructions: Promise<string | undefined> | undefined;
  let resolveInstructionsForTransport: (() => Promise<string | undefined>) | undefined;
  if (typeof instructionsOption === 'string') {
    resolvedInstructions = instructionsOption;
  } else if (instructionsIsFn) {
    try {
      const result = (instructionsOption as (ctx: SessionContext) => string | undefined | Promise<string | undefined>)(
        {}
      );
      // Promise detection — must guard for null + non-object before reading
      // `.then`, otherwise `typeof null.then` throws TypeError and the user
      // sees a confusing framework-internal stack instead of their own bug.
      const isThenable =
        result !== null && typeof result === 'object' && typeof (result as { then?: unknown }).then === 'function';
      if (isThenable) {
        // Async return: store the running Promise; resolution happens in the
        // wrapInitializeHandler block below, just before the MCP response.
        pendingInstructions = Promise.resolve(result as Promise<string | undefined>);
        // Mark eager rejection as observed immediately. The original promise
        // remains rejected and is awaited by the transport resolver later,
        // where onInstructionsError decides fail vs skip. Without this
        // observer, stateless modern tool requests that never run discovery
        // could surface an unhandled rejection from an async instructions fn.
        void pendingInstructions.catch(() => {});
      } else {
        // Reject non-string non-undefined sync returns instead of silently coercing
        // (`String({})` → "[object Object]" would ship as instructions otherwise).
        // The TS signature constrains return to `string | undefined`; this catches
        // `as any` escapees and untyped JS callers.
        if (result !== undefined && typeof result !== 'string') {
          throw new Error(
            `function-form \`instructions\` must return string | undefined, got ${result === null ? 'null' : typeof result}. ` +
              `Return a string for the prose, or undefined for "no instructions on this session."`
          );
        }
        resolvedInstructions = result;
      }
    } catch (err) {
      if (onInstructionsError === 'fail') {
        throw err;
      }
      // 'skip' — log server-side, surface no instructions to MCP `initialize`.
      logger.warn('[adcp/createAdcpServer] instructions() threw; skipping (onInstructionsError: "skip")', {
        error: err instanceof Error ? err.message : String(err),
      });
      resolvedInstructions = undefined;
    }
  } else {
    resolvedInstructions = undefined;
  }

  const mcpTaskStore = taskStore ?? new InMemoryTaskStore();
  const server = createTaskCapableServer(name, version, {
    taskStore: mcpTaskStore,
    taskMessageQueue,
    instructions: resolvedInstructions,
  });

  // The v1 SDK server remains the canonical legacy path. The modern adapter
  // separately mirrors these validated definitions onto every per-request
  // MCP v2 server reconstruction.
  for (const resource of mcpAppResources) {
    server.registerResource(
      resource.name,
      resource.uri,
      mcpAppResourceMetadata(resource) as Parameters<typeof server.registerResource>[2],
      async (uri, extra) =>
        readMcpAppResource(resource, uri, {
          signal: extra.signal,
        })
    );
  }

  // Wire async instructions resolution into the MCP `initialize` handler.
  // The function returned a Promise at construction time; await it here
  // (just before the initialize response) so the resolved string is included
  // in the MCP handshake without making createAdcpServer itself async.
  if (pendingInstructions !== undefined) {
    const pending = pendingInstructions;
    let resolvedOnce: Promise<string | undefined> | undefined;
    resolveInstructionsForTransport = () => {
      resolvedOnce ??= (async () => {
        try {
          const resolved = await pending;
          if (resolved !== undefined && typeof resolved !== 'string') {
            throw new Error(
              `function-form \`instructions\` resolved to ${typeof resolved}, expected string | undefined. ` +
                `Return a string for the prose, or undefined for "no instructions on this session."`
            );
          }
          setSdkServerInstructions(server, resolved);
          return resolved;
        } catch (err) {
          if (onInstructionsError === 'fail') throw err;
          logger.warn('[adcp/createAdcpServer] async instructions threw; skipping (onInstructionsError: "skip")', {
            error: err instanceof Error ? err.message : String(err),
          });
          return undefined;
        }
      })();
      return resolvedOnce;
    };
    wrapInitializeHandler(server, async (origHandler, req, extra) => {
      await resolveInstructionsForTransport?.();
      return origHandler(req, extra);
    });
  }

  const registeredToolNames = new Set<string>();

  const applyResponseEnhancer = (response: McpToolResponse): McpToolResponse => {
    responseEnhancer?.(response);
    return response;
  };

  const finalizeProtocolTaskToolResponse = (
    toolName: 'get_task_status' | 'list_tasks',
    params: Record<string, unknown>,
    response: McpToolResponse,
    opts: { echoContext?: boolean } = {}
  ): McpToolResponse => {
    sanitizeAdcpErrorEnvelope(response);
    enrichErrorTwoLayer(response, toolName, toolsWithErrorArm);
    if (!isErrorResponse(response)) {
      normalizeMediaBuyStatusCollision(response, toolName);
      injectEnvelopeStatusIntoResponse(response);
      const validationError = protocolTaskResponseValidationError(toolName, response);
      if (validationError) return finalizeProtocolTaskToolResponse(toolName, params, validationError, opts);
    }
    if (opts.echoContext !== false) injectContextIntoResponse(response, params.context);
    injectVersionIntoResponse(response, servedAdcpVersion);
    return applyResponseEnhancer(response);
  };

  const unsupportedVersionResponse = (params: Record<string, unknown>): McpToolResponse | undefined => {
    const reqAdcpVersion = (params as { adcp_version?: unknown }).adcp_version;
    const reqAdcpMajorRaw = (params as { adcp_major_version?: unknown }).adcp_major_version;
    const reqAdcpMajor =
      typeof reqAdcpMajorRaw === 'number'
        ? reqAdcpMajorRaw
        : typeof reqAdcpMajorRaw === 'string'
          ? Number.parseInt(reqAdcpMajorRaw, 10)
          : undefined;
    if (typeof reqAdcpVersion === 'string' && reqAdcpMajor !== undefined && Number.isFinite(reqAdcpMajor)) {
      const stringMajor = parseAdcpMajorVersion(reqAdcpVersion);
      if (Number.isFinite(stringMajor) && stringMajor !== reqAdcpMajor) {
        return adcpError('VERSION_UNSUPPORTED', {
          message:
            `Request carries adcp_version="${reqAdcpVersion}" (major ${stringMajor}) and ` +
            `adcp_major_version=${JSON.stringify(reqAdcpMajorRaw)}; majors must agree.`,
          details: { supported_versions: buildSupportedVersionsList(capConfig, adcpVersion) },
        });
      }
    }

    const effectiveReqMajor =
      reqAdcpMajor !== undefined && Number.isFinite(reqAdcpMajor)
        ? reqAdcpMajor
        : typeof reqAdcpVersion === 'string'
          ? parseAdcpMajorVersion(reqAdcpVersion)
          : undefined;
    if (effectiveReqMajor !== undefined && Number.isFinite(effectiveReqMajor)) {
      const supportedMajors = getAdvertisedSupportedMajors(capConfig, adcpVersion);
      if (!supportedMajors.has(effectiveReqMajor)) {
        const claimed =
          typeof reqAdcpVersion === 'string'
            ? `adcp_version="${reqAdcpVersion}"`
            : `adcp_major_version=${JSON.stringify(reqAdcpMajorRaw)}`;
        const supportedList = [...supportedMajors].sort((a, b) => a - b).join(', ');
        return adcpError('VERSION_UNSUPPORTED', {
          message: `Request claims ${claimed} (major ${effectiveReqMajor}); this seller supports major ${supportedList}.`,
          details: { supported_versions: buildSupportedVersionsList(capConfig, adcpVersion) },
        });
      }
    }
    return undefined;
  };

  const protocolTaskAccountExtensionIssues = (params: Record<string, unknown>): ValidationIssue[] => {
    if (params.account === undefined) return [];
    const parsed = AccountReferenceSchema.safeParse(params.account);
    if (parsed.success) return [];
    return [
      {
        pointer: '/account',
        message: 'must be a valid AccountReference',
        keyword: 'oneOf',
        schemaPath: '#/properties/account',
      },
    ];
  };

  const protocolTaskRequestValidationError = (
    toolName: 'get_task_status' | 'list_tasks',
    params: Record<string, unknown>
  ): McpToolResponse | undefined => {
    const accountIssues = protocolTaskAccountExtensionIssues(params);
    const outcome =
      requestValidationMode === 'off'
        ? ({ valid: true, issues: [], schemaId: undefined } as const)
        : validateRequest(toolName, params, adcpVersion);
    const issues = [...(outcome.valid ? [] : outcome.issues), ...accountIssues];
    if (issues.length === 0) return undefined;
    if (requestValidationMode === 'strict' || accountIssues.length > 0) {
      return adcpError(
        'VALIDATION_ERROR',
        buildAdcpValidationErrorPayload(toolName, 'request', issues, {
          exposeSchemaPath: exposeErrorDetails,
          rootSchemaId: outcome.schemaId,
        })
      );
    }
    logger.warn(
      `Schema validation warning (request) for ${toolName}: ${formatIssues(issues, 3, { rootSchemaId: outcome.schemaId })}`,
      {
        tool: toolName,
        issues,
      }
    );
    return undefined;
  };

  const protocolTaskResponseValidationError = (
    toolName: 'get_task_status' | 'list_tasks',
    response: McpToolResponse
  ): McpToolResponse | undefined => {
    if (responseValidationMode === 'off') return undefined;
    const outcome = validateResponse(toolName, response.structuredContent, adcpVersion);
    if (outcome.valid) return undefined;
    logger.warn(
      `Schema validation warning (response) for ${toolName}: ${formatIssues(outcome.issues, 3, { rootSchemaId: outcome.schemaId })}`,
      {
        tool: toolName,
        issues: outcome.issues,
        variant: outcome.variant,
      }
    );
    if (responseValidationMode !== 'strict') return undefined;
    return adcpError(
      'VALIDATION_ERROR',
      buildAdcpValidationErrorPayload(toolName, 'response', outcome.issues, {
        exposeSchemaPath: exposeErrorDetails,
        rootSchemaId: outcome.schemaId,
      })
    );
  };

  const protocolTaskBoundsError = (
    toolName: 'get_task_status' | 'list_tasks',
    params: Record<string, unknown>
  ): McpToolResponse | undefined => {
    if (params.include_history === true) {
      return adcpError('INVALID_REQUEST', {
        message: 'include_history is not supported by this task registry',
        field: 'include_history',
      });
    }
    if (toolName === 'get_task_status') {
      if (typeof params.task_id !== 'string' || params.task_id.length === 0) {
        return adcpError('INVALID_REQUEST', {
          message: 'task_id must be a non-empty string',
          field: 'task_id',
        });
      }
    }
    const filters = params.filters;
    if (isPlainObject(filters) && Array.isArray(filters.task_ids)) {
      if (
        filters.task_ids.length > 100 ||
        filters.task_ids.some(taskId => typeof taskId !== 'string' || taskId.length === 0)
      ) {
        return adcpError('INVALID_REQUEST', {
          message: 'filters.task_ids must contain at most 100 non-empty strings',
          field: 'filters.task_ids',
        });
      }
    }
    return undefined;
  };

  const taskToolCredentialPolicyError = (
    toolName: 'get_task_status' | 'list_tasks',
    params: Record<string, unknown>,
    mcpExtra: any
  ): McpToolResponse | undefined => {
    if (credentialPolicy === undefined) return undefined;
    const effectivePolicy =
      typeof credentialPolicy === 'string' || credentialPolicy.tools?.[toolName] !== undefined
        ? resolveCredentialPolicyForTool(credentialPolicy, toolName)
        : (credentialPolicy.tools?.tasks_get ?? credentialPolicy.policy);
    if (effectivePolicy !== 'lax') {
      const hits = scanArgsForCredentials(params, credentialPolicyPatterns);
      const blockedPaths =
        typeof effectivePolicy === 'object' ? hits.filter(p => !effectivePolicy.allow.includes(p)) : hits;
      if (blockedPaths.length > 0) {
        return adcpError('PERMISSION_DENIED', {
          message:
            'Request args carry credential-shaped keys. Credentials must arrive on authInfo, not in the request body.',
          recovery: 'correctable',
          details: { scope: 'credentials', credential_paths: blockedPaths },
        });
      }
    }
    if (
      typeof credentialPolicy !== 'string' &&
      credentialPolicy.scanAuthInfo === true &&
      mcpExtra?.authInfo?.extra !== null &&
      mcpExtra?.authInfo?.extra !== undefined &&
      typeof mcpExtra.authInfo.extra === 'object'
    ) {
      const authInfoHits = scanArgsForCredentials(mcpExtra.authInfo.extra, credentialPolicyPatterns);
      if (authInfoHits.length > 0) {
        try {
          logger.warn('credentialPolicy: authInfo.extra carries credential-shaped keys', {
            tool: toolName,
            paths: authInfoHits.map(p => `authInfo.extra.${p}`),
          });
        } catch {
          // Ignore logger failures on the rejection path.
        }
        return adcpError('PERMISSION_DENIED', {
          message:
            'Request authentication context carries credential-shaped keys. Configure your authenticator to keep credentials off authInfo.extra.',
          recovery: 'terminal',
          details: { scope: 'credentials' },
        });
      }
    }
    return undefined;
  };

  const resolveTaskQueryAccountId = async (
    params: Record<string, unknown>,
    extra: any,
    toolName: 'get_task_status' | 'list_tasks'
  ): Promise<{
    accountId?: string;
    ownerScope?: string;
    accountResolutionAttempted: boolean;
    error?: McpToolResponse;
  }> => {
    const ctx: HandlerContext<TAccount> = { store: stateStore };
    let accountResolutionAttempted = false;
    if (extra?.authInfo) {
      const authInfo = extra.authInfo as ResolvedAuthInfo;
      ctx.authInfo = authInfo;
      const inboundCredential = authInfo.extra?.credential;
      if (inboundCredential !== undefined && authInfo.credential === undefined) {
        authInfo.credential = inboundCredential as ResolvedAuthInfo['credential'];
      }
    }

    if (agentRegistry !== undefined) {
      try {
        const resolved = await agentRegistry.resolve({
          ...(ctx.authInfo?.credential !== undefined && { credential: ctx.authInfo.credential }),
          ...(ctx.authInfo?.extra !== undefined && { extra: ctx.authInfo.extra }),
          input: params,
        });
        if (resolved != null) {
          if (!Object.isFrozen(resolved)) {
            if (resolved.billing_capabilities instanceof Set) {
              Object.freeze(resolved.billing_capabilities);
            }
            Object.freeze(resolved);
          }
          ctx.agent = resolved;
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        logger.error('Buyer-agent registry resolution failed during task poll', { tool: toolName, error: reason });
        return {
          accountResolutionAttempted,
          error: adcpError('SERVICE_UNAVAILABLE', {
            message: 'Buyer-agent registry resolution failed',
            ...(exposeErrorDetails && { details: { reason: redactCredentialPatterns(reason) } }),
          }),
        };
      }
    }

    const accountRef = params.account;
    if (accountRef != null) {
      accountResolutionAttempted = true;
      if (!resolveAccount) {
        return {
          accountResolutionAttempted,
          error: adcpError('ACCOUNT_NOT_FOUND', {
            message: 'The specified account does not exist',
            field: 'account',
          }),
        };
      }
      try {
        const account = await resolveAccount(accountRef as AccountReference, {
          toolName: toolName as AdcpServerToolName,
          authInfo: ctx.authInfo,
          ...(ctx.agent != null && { agent: ctx.agent }),
          input: params,
        });
        if (account != null) ctx.account = account;
        if (account == null) {
          return {
            accountResolutionAttempted,
            error: adcpError('ACCOUNT_NOT_FOUND', {
              message: 'The specified account does not exist',
              field: 'account',
            }),
          };
        }
      } catch (err) {
        if (isThrownAdcpError(err)) return { accountResolutionAttempted, error: err };
        if (err instanceof AdcpError) {
          return { accountResolutionAttempted, error: projectThrownAdcpError(err) };
        }
        const reason = err instanceof Error ? err.message : String(err);
        logger.error('Account resolution failed', { tool: toolName, error: reason });
        return {
          accountResolutionAttempted,
          error: adcpError('SERVICE_UNAVAILABLE', {
            message: 'Account resolution failed',
            ...(exposeErrorDetails && { details: { reason: redactCredentialPatterns(reason) } }),
          }),
        };
      }
    } else if (resolveAccountFromAuth) {
      try {
        const account = await resolveAccountFromAuth({
          toolName,
          authInfo: ctx.authInfo,
          ...(ctx.agent != null && { agent: ctx.agent }),
          input: params,
        });
        accountResolutionAttempted = true;
        if (account != null) {
          ctx.account = account;
        }
      } catch (err) {
        accountResolutionAttempted = true;
        if (isThrownAdcpError(err)) return { accountResolutionAttempted, error: err };
        if (err instanceof AdcpError) {
          return { accountResolutionAttempted, error: projectThrownAdcpError(err) };
        }
        const reason = err instanceof Error ? err.message : String(err);
        logger.error('Auth-derived account resolution failed', { tool: toolName, error: reason });
        return {
          accountResolutionAttempted,
          error: adcpError('SERVICE_UNAVAILABLE', {
            message: 'Account resolution failed',
            ...(exposeErrorDetails && { details: { reason: redactCredentialPatterns(reason) } }),
          }),
        };
      }
    }

    if (resolveSessionKey) {
      try {
        const sessionKey = await resolveSessionKey({
          toolName: toolName as AdcpServerToolName,
          params,
          account: ctx.account,
          ...(ctx.agent != null && { agent: ctx.agent }),
        });
        if (sessionKey !== undefined) ctx.sessionKey = sessionKey;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        logger.error('Session key resolution failed during task poll', { tool: toolName, error: reason });
        return {
          accountResolutionAttempted,
          error: adcpError('SERVICE_UNAVAILABLE', {
            message: 'Session key resolution failed',
            ...(exposeErrorDetails && { details: { reason: redactCredentialPatterns(reason) } }),
          }),
        };
      }
    }

    const accountLike = ctx.account as { id?: unknown; account_id?: unknown } | undefined;
    const accountId =
      typeof accountLike?.id === 'string'
        ? accountLike.id
        : typeof accountLike?.account_id === 'string'
          ? accountLike.account_id
          : undefined;
    const ownerScope =
      accountId !== undefined
        ? taskOwnerScopeForContext(ctx.authInfo, ctx.sessionKey, ctx.agent, accountId)
        : undefined;
    return { accountId, ownerScope, accountResolutionAttempted };
  };

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
      const schema = (TOOL_REQUEST_SCHEMAS as Readonly<Record<string, { shape: Record<string, unknown> }>>)[toolName];
      if (!schema?.shape) {
        logger.warn(`No schema found for tool "${toolName}" in TOOL_REQUEST_SCHEMAS, skipping`);
        continue;
      }
      const hasAccount = 'account' in schema.shape;

      const wrap = meta?.wrap ?? ((data: any, summary?: string) => genericResponse(toolName, data, summary));
      const toolHandler = async (params: any, extra: any) => {
        const ctx: HandlerContext<TAccount> = { store: stateStore };
        if (extra?.authInfo) {
          ctx.authInfo = extra.authInfo;
          // Hoist the kind-discriminated credential from MCP's `extra`
          // shape onto top-level `ctx.authInfo.credential` so adopter
          // `resolveAccount` callbacks and the `BuyerAgentRegistry` can
          // route on it directly without unpacking `extra`. Stage 3 of
          // #1269 — the built-in authenticators stamp this in
          // `serve.ts:attachAuthInfo`. Custom `authenticate` callbacks
          // that don't populate `credential` see `ctx.authInfo.credential`
          // stay undefined; downstream code branches on `credential
          // !== undefined` for the new path and falls back to the
          // `@deprecated` legacy fields (`token`, `clientId`, `scopes`)
          // for the old path. Both paths coexist for two minors.
          const authInfo = ctx.authInfo;
          if (authInfo !== undefined) {
            const inboundCredential = authInfo.extra?.credential;
            if (inboundCredential !== undefined && authInfo.credential === undefined) {
              authInfo.credential = inboundCredential as ResolvedAuthInfo['credential'];
            }
          }
        }
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
          // Two-layer error emission: when the tool's response schema
          // declares an Error arm (`errors: [...]` required), mirror
          // `adcp_error` ↔ `errors[]` so both spec-mandated layers are
          // present on the wire. Order: AFTER sanitize so we project
          // the allowlist-filtered envelope; BEFORE context/version
          // injection so those run on the final two-layer payload.
          enrichErrorTwoLayer(response, toolName, toolsWithErrorArm);
          normalizeMediaBuyStatusCollision(response, toolName);
          injectEnvelopeStatusIntoResponse(response);
          injectContextIntoResponse(response, params.context);
          injectVersionIntoResponse(response, servedAdcpVersion);
          return applyResponseEnhancer(response);
        };

        // --- Buyer-agent registry resolution (#1269 / #1292) ---
        // Runs after `authInfo` is populated and before account resolution
        // so adopters' `resolveAccount` callbacks see `ctx.agent`. The
        // registry receives the kind-discriminated `credential` (Stage 3)
        // synthesized by the framework's built-in authenticators in
        // `serve.ts:attachAuthInfo`; factories route on `credential.kind`
        // and return null when no credential was stamped (custom adopter
        // auth callbacks that haven't migrated).
        if (agentRegistry !== undefined) {
          try {
            // Stage 3 of #1269: pass the kind-discriminated `credential`
            // synthesized in `serve.ts:attachAuthInfo` (and hoisted to
            // top-level above) into the registry. Factory functions
            // (`signingOnly` / `bearerOnly` / `mixed`) route on
            // `credential.kind`; absent credential → factories return
            // null → ctx.agent stays undefined.
            const resolved = await agentRegistry.resolve({
              ...(ctx.authInfo?.credential !== undefined && { credential: ctx.authInfo.credential }),
              ...(ctx.authInfo?.extra !== undefined && { extra: ctx.authInfo.extra }),
              input: params,
            });
            if (resolved != null) {
              // Shallow-freeze the resolved record so downstream code cannot
              // accidentally mutate `status`, `agent_url`, or other own
              // properties. NOTE: `Object.freeze` on the `billing_capabilities`
              // Set locks the Set object's own properties but does NOT
              // protect the internal `[[SetData]]` slot — `.add()` /
              // `.delete()` / `.clear()` still mutate. `ReadonlySet` is a
              // TypeScript-only contract; adopters constructing a Set MUST
              // NOT rely on freeze preventing membership changes at runtime.
              // The billing-capability check only reads via `.has()`,
              // so adopter mis-mutation would only affect the same request's
              // own logic — no cross-request leak.
              if (!Object.isFrozen(resolved)) {
                // Map-backed wrappers and other Set-shaped types skip the
                // Set-freeze branch; the outer record's freeze still applies.
                if (resolved.billing_capabilities instanceof Set) {
                  Object.freeze(resolved.billing_capabilities);
                }
                Object.freeze(resolved);
              }
              ctx.agent = resolved;
              // Adopters reading the registry's view of `agent_url` get it
              // from `ctx.agent.agent_url` (the resolved `BuyerAgent`
              // record). Stage 3 of #1269 deliberately does NOT stamp a
              // top-level `agent_url` on `ctx.authInfo` — that would
              // invite handler code to gate on a non-cryptographically-
              // verified URL while the spec (adcontextprotocol/adcp#3831)
              // requires verified `agent_url` reads to come from the
              // `http_sig` credential variant. Adopters who use bearer or
              // OAuth credentials get a registry-resolved `ctx.agent` but
              // NO verified `agent_url` — that's correct: bearer auth
              // doesn't prove the agent_url cryptographically.

              // --- Status enforcement (Stage 4 of #1269) ---
              // Reject new requests from `suspended` / `blocked` agents
              // with the dedicated 3.1 codes `AGENT_SUSPENDED` /
              // `AGENT_BLOCKED` (adcp#3906 consolidates the 3.0.5
              // `PERMISSION_DENIED + details.status` placeholder shape).
              // In-flight tasks owned by a now-suspended agent are NOT
              // retroactively cancelled — this seam runs once per
              // synchronous request, not on `tasks_get` polls or
              // background webhook deliveries. Sellers who need hard
              // cutoff implement that in their platform method via
              // `BuyerAgent.status` checks (the resolved record is
              // available on every method that takes ctx.agent).
              //
              // Recovery is `terminal` for both — a buyer cannot
              // "wait out" a suspension by retrying the same request.
              // The transient-vs-permanent distinction lives at the
              // seller's `BuyerAgent.status` record (suspension may
              // lift via re-onboarding), not on the wire envelope.
              // The placeholder shape's `recovery: 'transient'` for
              // suspended contradicted the no-retry MUST.
              if (resolved.status === 'suspended' || resolved.status === 'blocked') {
                return finalize(
                  adcpError(resolved.status === 'suspended' ? 'AGENT_SUSPENDED' : 'AGENT_BLOCKED', {
                    message:
                      resolved.status === 'suspended'
                        ? 'Buyer agent is suspended. Contact the seller to restore access.'
                        : 'Buyer agent is blocked.',
                    recovery: 'terminal',
                  })
                );
              }
            }
          } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            logger.error('Buyer-agent registry resolution failed', { tool: toolName, error: reason });
            return finalize(
              adcpError('SERVICE_UNAVAILABLE', {
                message: 'Buyer-agent registry resolution failed',
                ...(exposeErrorDetails && { details: { reason: redactCredentialPatterns(reason) } }),
              })
            );
          }
        }

        const toolIsMutating = isMutatingTask(toolName);

        // Field-disagreement detection per spec PR `adcontextprotocol/adcp#3493`:
        // when the request carries both `adcp_version` (string, AdCP 3.1+)
        // and `adcp_major_version` (integer, deprecated) and the majors
        // disagree, the server MUST return `VERSION_UNSUPPORTED`. Catches
        // a buyer that pinned a string but kept a stale integer in their
        // call-site config — the discrepancy is silent drift otherwise.
        //
        // Intentionally runs before the `requestValidationMode === 'off'`
        // short-circuit below: this is a spec MUST, not opt-in validation.
        // Production servers run with validation off by default; without
        // this check, a stale-integer drift on those servers would silently
        // dispatch to the wrong schema bundle.
        //
        // Coerces a stringified `adcp_major_version` (e.g. `"3"` from a
        // buyer that JSON-stringified a number) before comparing — AJV
        // strict-mode rejects this in dev, but production-default off-mode
        // would otherwise let the bypass through.
        const reqAdcpVersion = (params as { adcp_version?: unknown }).adcp_version;
        const reqAdcpMajorRaw = (params as { adcp_major_version?: unknown }).adcp_major_version;
        const reqAdcpMajor =
          typeof reqAdcpMajorRaw === 'number'
            ? reqAdcpMajorRaw
            : typeof reqAdcpMajorRaw === 'string'
              ? Number.parseInt(reqAdcpMajorRaw, 10)
              : undefined;
        if (typeof reqAdcpVersion === 'string' && reqAdcpMajor !== undefined && Number.isFinite(reqAdcpMajor)) {
          const stringMajor = parseAdcpMajorVersion(reqAdcpVersion);
          if (Number.isFinite(stringMajor) && stringMajor !== reqAdcpMajor) {
            return finalize(
              adcpError('VERSION_UNSUPPORTED', {
                message:
                  `Request carries adcp_version="${reqAdcpVersion}" (major ${stringMajor}) and ` +
                  `adcp_major_version=${JSON.stringify(reqAdcpMajorRaw)}; majors must agree.`,
                details: { supported_versions: buildSupportedVersionsList(capConfig, adcpVersion) },
              })
            );
          }
        }

        // Single-field rejection (issue #1075). The dual-field check above
        // catches drift between `adcp_version` and `adcp_major_version` when
        // both are present. A buyer that sends only one field — typically a
        // conformance harness probing the seller's `VERSION_UNSUPPORTED`
        // path — bypasses that check; the seller would otherwise dispatch
        // against its server-pinned bundle and the buyer's claim would
        // silently no-op. Resolve the effective major from whichever field
        // the buyer set, then reject if it falls outside the seller's
        // advertised window.
        //
        // The advertised window is the union of `major_versions` and parsed
        // majors from `supported_versions` (3.1+ release-precision strings),
        // with a fallback to the server pin's major when both lists are
        // absent — see `getAdvertisedSupportedMajors`. Same precedence
        // governs the `supported_versions` echo in the error envelope so
        // buyers can downgrade and retry.
        const effectiveReqMajor =
          reqAdcpMajor !== undefined && Number.isFinite(reqAdcpMajor)
            ? reqAdcpMajor
            : typeof reqAdcpVersion === 'string'
              ? parseAdcpMajorVersion(reqAdcpVersion)
              : undefined;
        if (effectiveReqMajor !== undefined && Number.isFinite(effectiveReqMajor)) {
          const supportedMajors = getAdvertisedSupportedMajors(capConfig, adcpVersion);
          if (!supportedMajors.has(effectiveReqMajor)) {
            const claimed =
              typeof reqAdcpVersion === 'string'
                ? `adcp_version="${reqAdcpVersion}"`
                : `adcp_major_version=${JSON.stringify(reqAdcpMajorRaw)}`;
            const supportedList = [...supportedMajors].sort((a, b) => a - b).join(', ');
            return finalize(
              adcpError('VERSION_UNSUPPORTED', {
                message: `Request claims ${claimed} (major ${effectiveReqMajor}); this seller supports major ${supportedList}.`,
                details: { supported_versions: buildSupportedVersionsList(capConfig, adcpVersion) },
              })
            );
          }
        }

        // --- Credential discipline scan (opt-in) ---
        // Runs before request validation so the rejection is uniform
        // whether validation is `'off'`, `'warn'`, or `'strict'`. Closes
        // the buyer-args credential-smuggling vector class — round-1
        // top-level, round-2 nested-context, round-3 nested-ext from
        // PR scope3data/agentic-adapters#248. Args-bag scan only;
        // `authInfo` and `ctx_metadata` are not scanned (those are the
        // blessed credential channels). `'lax'` short-circuits.
        //
        // Bypasses `finalize` deliberately — `injectContextIntoResponse`
        // echoes `params.context` back into every response, which would
        // re-export the credential the scan just caught. The rejection
        // envelope reports paths (not values) and skips correlation_id
        // / version injection on this path.
        if (credentialPolicy !== undefined) {
          const effectivePolicy = resolveCredentialPolicyForTool(credentialPolicy, toolName);
          if (effectivePolicy !== 'lax') {
            const hits = scanArgsForCredentials(params, credentialPolicyPatterns);
            // Granular allow-list: filter hits by the per-tool
            // allowlist. Adopters whose tool legitimately accepts a
            // specific buyer-presented credential field list it here;
            // other credential-shaped keys still reject. String mode
            // ('authInfo-only') means no allowlist — every hit blocks.
            const blockedPaths =
              typeof effectivePolicy === 'object' ? hits.filter(p => !effectivePolicy.allow.includes(p)) : hits;
            if (blockedPaths.length > 0) {
              // Spec-correct code: the caller is authenticated and the
              // payload is schema-valid (every AdCP request schema sets
              // `additionalProperties: true`). What's refused is the
              // SELLER POLICY of "credentials must arrive on authInfo,
              // not in args". That's `PERMISSION_DENIED` per
              // `enums/error-code.json`, not `INVALID_REQUEST` (which
              // is for malformed/schema violations). `details.scope:
              // 'credentials'` mirrors the existing agent-status
              // rejection's `details.scope: 'agent'`.
              //
              // Deliberately omit `field` — it implies a single offending
              // path, which under-discloses when several vectors are
              // present together. Full list lives in
              // `details.credential_paths`.
              return applyResponseEnhancer(
                adcpError('PERMISSION_DENIED', {
                  message:
                    'Request args carry credential-shaped keys. Credentials must arrive on authInfo, not in the request body.',
                  recovery: 'correctable',
                  details: { scope: 'credentials', credential_paths: blockedPaths },
                })
              );
            }
          }
        }

        // --- authInfo.extra credential scan (opt-in via #1539) ---
        // FULLY ORTHOGONAL to the args-bag scan above. Whereas the args
        // scan branches on `policy` mode and per-tool overrides
        // (`'lax'` short-circuits), `scanAuthInfo: true` ALWAYS fires
        // when set. The two settings answer different questions:
        //
        //   - `policy` / `tools` — does this server / tool accept buyer
        //     credentials in the args bag?
        //   - `scanAuthInfo` — does authInfo.extra carry credential-
        //     shaped keys that adopter handler code or log lines could
        //     leak?
        //
        // Per-tool `'lax'` opt-out only affects args. authInfo.extra
        // is server-internal; adopters who legitimately stamp
        // credential-shaped values into it should restructure the
        // authenticator (extra is the wrong layer for credentials)
        // rather than per-tool-disable the scan.
        //
        // Wire-envelope discipline (per #1539 design): args-bag hits
        // surface in `details.credential_paths` (the buyer already
        // knows what they sent); authInfo.extra hits are LOG-ONLY.
        // Disclosing authInfo.extra paths to the buyer would create
        // a probing oracle for an internal value the buyer has no
        // read access to. The wire envelope reports a coarse signal:
        // `details.scope: 'credentials'`, generic message, no paths.
        if (
          credentialPolicy !== undefined &&
          typeof credentialPolicy !== 'string' &&
          credentialPolicy.scanAuthInfo === true
        ) {
          const extra = ctx.authInfo?.extra;
          if (extra !== null && extra !== undefined && typeof extra === 'object') {
            const authInfoHits = scanArgsForCredentials(extra, credentialPolicyPatterns);
            if (authInfoHits.length > 0) {
              // Wrap the log call defensively. Adopter loggers that throw
              // on serialization (Pino circular-ref edge cases, custom
              // transports that reject deep nesting, OTel exporters
              // mid-flush) would otherwise fault the rejection path and
              // surface as a generic 500 / unhandled rejection instead of
              // the intended PERMISSION_DENIED. The asymmetry with the
              // args-scan rejection (which doesn't log) made this a
              // logger-misconfig DoS vector before this guard.
              try {
                logger.warn('credentialPolicy: authInfo.extra carries credential-shaped keys', {
                  tool: toolName,
                  paths: authInfoHits.map(p => `authInfo.extra.${p}`),
                });
              } catch {
                // Swallow — the rejection envelope is the load-bearing
                // signal; losing the diagnostic log is acceptable when
                // the alternative is failing the request entirely.
              }
              return applyResponseEnhancer(
                adcpError('PERMISSION_DENIED', {
                  message:
                    'Request authentication context carries credential-shaped keys. Configure your authenticator to keep credentials off authInfo.extra.',
                  recovery: 'terminal',
                  details: { scope: 'credentials' },
                })
              );
            }
          }
        }

        // --- Request schema validation (opt-in) ---
        // Runs before idempotency so drifted payloads never touch the
        // replay cache. `off` short-circuits without calling AJV.
        if (requestValidationMode !== 'off') {
          const outcome = validateRequest(toolName, params, adcpVersion);
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
                  rootSchemaId: outcome.schemaId,
                });
                return finalize(adcpError('VALIDATION_ERROR', payload));
              }
              logger.warn(
                `Schema validation warning (request) for ${toolName}: ${formatIssues(issues, 3, { rootSchemaId: outcome.schemaId })}`,
                {
                  tool: toolName,
                  issues,
                }
              );
            }
          }
        }

        // --- Account resolution ---
        if (hasAccount && params.account != null && resolveAccount) {
          try {
            const account = await resolveAccount(params.account, {
              toolName: toolName as AdcpServerToolName,
              authInfo: ctx.authInfo,
              ...(ctx.agent != null && { agent: ctx.agent }),
              input: params,
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
            // Typed errors propagate verbatim — both the already-projected
            // envelope shape (`isThrownAdcpError`) and the raw class throw
            // (`AdcpError instanceof`). Resolvers can surface
            // `INVALID_REQUEST` for inline `account_id` against an
            // `'implicit'`-resolution platform (#1364), or any other typed
            // wire error, without coercion. Generic exceptions still
            // project to SERVICE_UNAVAILABLE so upstream leaks don't cross
            // the trust boundary.
            if (isThrownAdcpError(err)) return finalize(err);
            if (err instanceof AdcpError) {
              return finalize(projectThrownAdcpError(err));
            }
            const reason = err instanceof Error ? err.message : String(err);
            logger.error('Account resolution failed', { tool: toolName, error: reason });
            return finalize(
              adcpError('SERVICE_UNAVAILABLE', {
                message: 'Account resolution failed',
                ...(exposeErrorDetails && { details: { reason: redactCredentialPatterns(reason) } }),
              })
            );
          }
        } else if ((!hasAccount || params.account == null) && resolveAccountFromAuth) {
          // Auth-derived path for tools whose wire schema lacks an `account`
          // field (provide_performance_feedback, list_creative_formats, the
          // `tasks/get` polling path). Single-tenant agents return their
          // singleton; principal-keyed agents look up by authInfo. A `null`
          // return is allowed — handler sees ctx.account undefined and
          // either tolerates it (publisher-wide reads) or throws AdcpError.
          try {
            const account = await resolveAccountFromAuth({
              toolName: toolName as AdcpServerToolName,
              authInfo: ctx.authInfo,
              ...(ctx.agent != null && { agent: ctx.agent }),
              input: params,
            });
            if (account != null) ctx.account = account;
          } catch (err) {
            // Same typed-error pass-through as the explicit `resolveAccount`
            // catch above — both the already-projected envelope shape and
            // the raw `AdcpError` class throw propagate verbatim. Generic
            // exceptions project to SERVICE_UNAVAILABLE.
            if (isThrownAdcpError(err)) return finalize(err);
            if (err instanceof AdcpError) {
              return finalize(projectThrownAdcpError(err));
            }
            const reason = err instanceof Error ? err.message : String(err);
            logger.error('Auth-derived account resolution failed', { tool: toolName, error: reason });
            return finalize(
              adcpError('SERVICE_UNAVAILABLE', {
                message: 'Account resolution failed',
                ...(exposeErrorDetails && { details: { reason: redactCredentialPatterns(reason) } }),
              })
            );
          }
        }

        // --- Sandbox-only enforcement (Phase 1.5 of #1269) ---
        // Runs after account resolution so we can compare the resolved
        // account's `sandbox` flag against the agent's `sandbox_only`
        // capability. Account-less tools (provide_performance_feedback,
        // list_creative_formats, etc.) pass the gate — they don't
        // operate on a specific account, so the sandbox/production axis
        // doesn't apply.
        //
        // Defense-in-depth for test agents (CI runners, internal QA
        // agents, partner pre-prod environments): if a sandbox-only
        // agent's credential leaks, blast radius is bounded to sandbox
        // accounts. Production agents leave `sandbox_only` unset.
        // Strict-by-default: any non-Account shape (legacy v5 adopters,
        // bespoke account types) lacking the `sandbox` field reads as
        // `undefined !== true → reject`. That's correct: a sandbox-only
        // agent operating against an unknown-shape account is the
        // case where rejection is the safe default — adopters who want
        // to opt in either flip the agent's `sandbox_only` off or
        // populate `sandbox: true` on their resolved account.
        if (
          ctx.agent?.sandbox_only === true &&
          ctx.account !== undefined &&
          (ctx.account as { sandbox?: boolean }).sandbox !== true
        ) {
          return finalize(
            adcpError('PERMISSION_DENIED', {
              message: 'Buyer agent is sandbox-only; this request targets a non-sandbox account.',
              recovery: 'terminal',
              details: { scope: 'agent', reason: 'sandbox-only' },
            })
          );
        }

        // --- Session key resolution ---
        if (resolveSessionKey) {
          try {
            const sessionKey = await resolveSessionKey({
              toolName: toolName as AdcpServerToolName,
              params,
              account: ctx.account,
              ...(ctx.agent != null && { agent: ctx.agent }),
            });
            if (sessionKey !== undefined) ctx.sessionKey = sessionKey;
          } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            logger.error('Session key resolution failed', { tool: toolName, error: reason });
            return finalize(
              adcpError('SERVICE_UNAVAILABLE', {
                message: 'Session key resolution failed',
                ...(exposeErrorDetails && { details: { reason: redactCredentialPatterns(reason) } }),
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
              // Surface AdCP 3.1's `IDEMPOTENCY_IN_FLIGHT` with a transient
              // recovery + store-derived `retry_after`. Buyer SDKs that
              // already auto-retry transient + retry_after replay shortly;
              // the prior request either lands the cached response or
              // (different payload) triggers IDEMPOTENCY_CONFLICT.
              return finalize(
                adcpError('IDEMPOTENCY_IN_FLIGHT', {
                  message: 'A parallel request with the same idempotency_key is still in flight. Retry shortly.',
                  recovery: 'transient',
                  retry_after: checkResult.retryAfterSeconds,
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
                ...(exposeErrorDetails && { details: { reason: redactCredentialPatterns(reason) } }),
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
            // must fail closed here: error envelopes skip response-schema
            // validation, and blindly wrapping malformed primitives can leak
            // secret-bearing strings in `errors[]`.
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
                count: (result.errors as unknown[]).length,
              });
              const errPayload = buildAdcpValidationErrorPayload(
                toolName,
                'response',
                [
                  {
                    pointer: '/errors',
                    message: 'must contain Error objects with string code and message fields',
                    keyword: 'type',
                    schemaPath: '#/properties/errors/items',
                    hint: 'Return errors as `{ code, message }` objects; do not return raw strings or exception values.',
                  },
                ],
                { exposeSchemaPath: exposeErrorDetails }
              );
              formatted = adcpError('VALIDATION_ERROR', errPayload);
            } else {
              formatted = wrapErrorArm(result);
            }
          } else {
            formatted = wrap(result);
          }

          // --- Test-controller bridge: augment read-side tools with seeded fixtures. ---
          // Each per-tool callback (`getSeededProducts`, `getSeededCreatives`, ...)
          // is opt-in by presence on the bridge interface. All callbacks share the
          // same triply-gated contract:
          //   1. The bridge is registered AND has the matching callback;
          //   2. The handler returned a success envelope (not an `adcp_error`);
          //   3. The request carries a sandbox marker (account.sandbox === true or
          //      context.sandbox === true) AND, if `resolveAccount` produced a
          //      record, that record is flagged `sandbox: true` too.
          // For array-collection tools, seeded entries append to the handler's
          // response with seeded winning on id collision (same as `getSeededProducts`).
          // `get_account_financials` is the exception — singleton response, so the
          // seeded entry REPLACES the handler payload when its `account.account_id`
          // matches the request's `account.account_id`.
          // Diagnostic for adopters chasing "why aren't my fixtures showing":
          // when the request carries a sandbox marker but the resolved account
          // is explicitly non-sandbox, the gate rejects silently. Emit a
          // `debug` line so the rejection is observable in dev logs without
          // adding noise to production traffic (where the gate's first check
          // — `isSandboxRequestForSeeding` — fails first and never reaches
          // this branch).
          if (
            testControllerBridge &&
            !isErrorResponse(formatted) &&
            isSandboxRequestForSeeding(params) &&
            ctx.account !== undefined &&
            !(
              typeof ctx.account === 'object' &&
              ctx.account !== null &&
              (ctx.account as { sandbox?: unknown }).sandbox === true
            )
          ) {
            // Include the resolved account_id so the log line is self-
            // diagnostic — an adopter chasing "why aren't my fixtures
            // showing" can match the rejected account against their
            // resolveAccount source without correlating across log lines.
            // account_ids appear in normal request logs already; no new
            // PII surface.
            const resolvedAccountId =
              typeof ctx.account === 'object' &&
              ctx.account !== null &&
              typeof (ctx.account as { account_id?: unknown }).account_id === 'string'
                ? ((ctx.account as { account_id?: unknown }).account_id as string)
                : undefined;
            logger.debug(
              'test-controller bridge: request is sandbox-flagged but resolved account is not sandbox; skipping merge',
              { tool: toolName, resolved_account_id: resolvedAccountId }
            );
          }

          if (
            testControllerBridge &&
            !isErrorResponse(formatted) &&
            isSandboxRequestForSeeding(params) &&
            (ctx.account === undefined ||
              (typeof ctx.account === 'object' &&
                ctx.account !== null &&
                (ctx.account as { sandbox?: unknown }).sandbox === true))
          ) {
            const bridgeCtx: TestControllerBridgeContext<TAccount> = { input: params };
            if (ctx.account !== undefined) bridgeCtx.account = ctx.account;

            // get_products
            if (toolName === 'get_products' && testControllerBridge.getSeededProducts) {
              try {
                const rawSeeded = await testControllerBridge.getSeededProducts(bridgeCtx);
                const seeded = filterValidSeededProducts(rawSeeded, logger);
                if (seeded.length > 0) {
                  const sc = formatted.structuredContent as
                    | import('../types/tools.generated').GetProductsResponse
                    | undefined;
                  if (sc && typeof sc === 'object') {
                    const merged = mergeSeededProductsIntoResponse(sc, seeded);
                    formatted = wrap(merged);
                    stampBridge(formatted, 'getSeededProducts', toolName, seeded.length);
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

            // list_creatives
            else if (toolName === 'list_creatives' && testControllerBridge.getSeededCreatives) {
              try {
                const rawSeeded = await testControllerBridge.getSeededCreatives(bridgeCtx);
                const seeded = filterValidSeededCreatives(rawSeeded, logger);
                if (seeded.length > 0) {
                  const sc = formatted.structuredContent as
                    | import('../types/tools.generated').ListCreativesResponse
                    | undefined;
                  if (sc && typeof sc === 'object') {
                    const merged = mergeSeededCreativesIntoResponse(sc, seeded);
                    formatted = wrap(merged);
                    stampBridge(formatted, 'getSeededCreatives', toolName, seeded.length);
                  }
                }
              } catch (err) {
                const reason = err instanceof Error ? err.message : String(err);
                logger.warn('testController.getSeededCreatives failed; returning handler response unchanged', {
                  tool: toolName,
                  error: reason,
                });
              }
            }

            // get_media_buys
            else if (toolName === 'get_media_buys' && testControllerBridge.getSeededMediaBuys) {
              try {
                const rawSeeded = await testControllerBridge.getSeededMediaBuys(bridgeCtx);
                const seeded = filterValidSeededMediaBuys(rawSeeded, logger);
                if (seeded.length > 0) {
                  const sc = formatted.structuredContent as
                    | import('../types/tools.generated').GetMediaBuysResponse
                    | undefined;
                  if (sc && typeof sc === 'object') {
                    const merged = mergeSeededMediaBuysIntoResponse(sc, seeded);
                    formatted = wrap(merged);
                    stampBridge(formatted, 'getSeededMediaBuys', toolName, seeded.length);
                  }
                }
              } catch (err) {
                const reason = err instanceof Error ? err.message : String(err);
                logger.warn('testController.getSeededMediaBuys failed; returning handler response unchanged', {
                  tool: toolName,
                  error: reason,
                });
              }
            }

            // get_media_buy_delivery
            else if (toolName === 'get_media_buy_delivery' && testControllerBridge.getSeededMediaBuyDelivery) {
              try {
                const rawSeeded = await testControllerBridge.getSeededMediaBuyDelivery(bridgeCtx);
                const seeded = filterValidSeededMediaBuyDeliveries(rawSeeded, logger);
                if (seeded.length > 0) {
                  const sc = formatted.structuredContent as
                    | import('../types/tools.generated').GetMediaBuyDeliveryResponse
                    | undefined;
                  if (sc && typeof sc === 'object') {
                    const merged = mergeSeededMediaBuyDeliveryIntoResponse(sc, seeded);
                    formatted = wrap(merged);
                    stampBridge(formatted, 'getSeededMediaBuyDelivery', toolName, seeded.length);
                  }
                }
              } catch (err) {
                const reason = err instanceof Error ? err.message : String(err);
                logger.warn('testController.getSeededMediaBuyDelivery failed; returning handler response unchanged', {
                  tool: toolName,
                  error: reason,
                });
              }
            }

            // list_accounts
            else if (toolName === 'list_accounts' && testControllerBridge.getSeededAccounts) {
              try {
                const rawSeeded = await testControllerBridge.getSeededAccounts(bridgeCtx);
                const seeded = filterValidSeededAccounts(rawSeeded, logger);
                if (seeded.length > 0) {
                  const sc = formatted.structuredContent as
                    | import('../types/tools.generated').ListAccountsResponse
                    | undefined;
                  if (sc && typeof sc === 'object') {
                    const merged = mergeSeededAccountsIntoResponse(sc, seeded);
                    formatted = wrap(merged);
                    stampBridge(formatted, 'getSeededAccounts', toolName, seeded.length);
                  }
                }
              } catch (err) {
                const reason = err instanceof Error ? err.message : String(err);
                logger.warn('testController.getSeededAccounts failed; returning handler response unchanged', {
                  tool: toolName,
                  error: reason,
                });
              }
            }

            // get_account_financials (singleton — replace, not append)
            else if (toolName === 'get_account_financials' && testControllerBridge.getSeededAccountFinancials) {
              try {
                const rawSeeded = await testControllerBridge.getSeededAccountFinancials(bridgeCtx);
                const seeded = filterValidSeededAccountFinancials(rawSeeded, logger);
                if (seeded.length > 0) {
                  const sc = formatted.structuredContent as
                    | import('../types/tools.generated').GetAccountFinancialsResponse
                    | undefined;
                  if (sc && typeof sc === 'object') {
                    // Brand+operator `AccountReference` variants don't carry
                    // `account_id` on the wire — the framework's resolved
                    // account does, so prefer it for the match key.
                    const resolvedAccountId =
                      ctx.account && typeof ctx.account === 'object' && !Array.isArray(ctx.account)
                        ? ((ctx.account as { account_id?: unknown }).account_id as string | undefined)
                        : undefined;
                    const merged = replaceAccountFinancialsIfSeeded(
                      params as import('../types/tools.generated').GetAccountFinancialsRequest,
                      sc,
                      seeded,
                      typeof resolvedAccountId === 'string' && resolvedAccountId.length > 0
                        ? resolvedAccountId
                        : undefined
                    );
                    if (merged !== sc) {
                      formatted = wrap(merged);
                      stampBridge(formatted, 'getSeededAccountFinancials', toolName, seeded.length);
                    }
                  }
                }
              } catch (err) {
                const reason = err instanceof Error ? err.message : String(err);
                logger.warn('testController.getSeededAccountFinancials failed; returning handler response unchanged', {
                  tool: toolName,
                  error: reason,
                });
              }
            }

            // list_creative_formats
            else if (toolName === 'list_creative_formats' && testControllerBridge.getSeededCreativeFormats) {
              try {
                const rawSeeded = await testControllerBridge.getSeededCreativeFormats(bridgeCtx);
                const seeded = filterValidSeededCreativeFormats(rawSeeded, logger);
                if (seeded.length > 0) {
                  const sc = formatted.structuredContent as
                    | import('../types/tools.generated').ListCreativeFormatsResponse
                    | undefined;
                  if (sc && typeof sc === 'object') {
                    const merged = mergeSeededCreativeFormatsIntoResponse(sc, seeded);
                    formatted = wrap(merged);
                    stampBridge(formatted, 'getSeededCreativeFormats', toolName, seeded.length);
                  }
                }
              } catch (err) {
                const reason = err instanceof Error ? err.message : String(err);
                logger.warn('testController.getSeededCreativeFormats failed; returning handler response unchanged', {
                  tool: toolName,
                  error: reason,
                });
              }
            }

            // list_property_lists / get_property_list — one seeded fixture array
            // feeds both. List path: append-merge with seeded-wins on `list_id`
            // collision. Get path: pick by request.list_id and replace the
            // response's `list` field, preserving handler's resolved data
            // (`identifiers` / `pagination` / `resolved_at` / `cache_valid_until`
            // / `coverage_gaps` / `context` / `ext`).
            else if (
              (toolName === 'list_property_lists' || toolName === 'get_property_list') &&
              testControllerBridge.getSeededPropertyLists
            ) {
              try {
                const rawSeeded = await testControllerBridge.getSeededPropertyLists(bridgeCtx);
                const seeded = filterValidSeededPropertyLists(rawSeeded, logger);
                if (seeded.length > 0) {
                  if (toolName === 'list_property_lists') {
                    const sc = formatted.structuredContent as
                      | import('../types/tools.generated').ListPropertyListsResponse
                      | undefined;
                    if (sc && typeof sc === 'object') {
                      const merged = mergeSeededPropertyListsIntoResponse(sc, seeded);
                      formatted = wrap(merged);
                      stampBridge(formatted, 'getSeededPropertyLists', toolName, seeded.length);
                    }
                  } else {
                    const sc = formatted.structuredContent as
                      | import('../types/tools.generated').GetPropertyListResponse
                      | undefined;
                    if (sc && typeof sc === 'object') {
                      const merged = replacePropertyListIfSeeded(
                        params as import('../types/tools.generated').GetPropertyListRequest,
                        sc,
                        seeded
                      );
                      if (merged !== sc) {
                        formatted = wrap(merged);
                        stampBridge(formatted, 'getSeededPropertyLists', toolName, seeded.length);
                      }
                    }
                  }
                }
              } catch (err) {
                const reason = err instanceof Error ? err.message : String(err);
                logger.warn('testController.getSeededPropertyLists failed; returning handler response unchanged', {
                  tool: toolName,
                  error: reason,
                });
              }
            }

            // list_collection_lists / get_collection_list — symmetric with
            // property lists.
            else if (
              (toolName === 'list_collection_lists' || toolName === 'get_collection_list') &&
              testControllerBridge.getSeededCollectionLists
            ) {
              try {
                const rawSeeded = await testControllerBridge.getSeededCollectionLists(bridgeCtx);
                const seeded = filterValidSeededCollectionLists(rawSeeded, logger);
                if (seeded.length > 0) {
                  if (toolName === 'list_collection_lists') {
                    const sc = formatted.structuredContent as
                      | import('../types/tools.generated').ListCollectionListsResponse
                      | undefined;
                    if (sc && typeof sc === 'object') {
                      const merged = mergeSeededCollectionListsIntoResponse(sc, seeded);
                      formatted = wrap(merged);
                      stampBridge(formatted, 'getSeededCollectionLists', toolName, seeded.length);
                    }
                  } else {
                    const sc = formatted.structuredContent as
                      | import('../types/tools.generated').GetCollectionListResponse
                      | undefined;
                    if (sc && typeof sc === 'object') {
                      const merged = replaceCollectionListIfSeeded(
                        params as import('../types/tools.generated').GetCollectionListRequest,
                        sc,
                        seeded
                      );
                      if (merged !== sc) {
                        formatted = wrap(merged);
                        stampBridge(formatted, 'getSeededCollectionLists', toolName, seeded.length);
                      }
                    }
                  }
                }
              } catch (err) {
                const reason = err instanceof Error ? err.message : String(err);
                logger.warn('testController.getSeededCollectionLists failed; returning handler response unchanged', {
                  tool: toolName,
                  error: reason,
                });
              }
            }

            // get_signals — append-merge by signal_id. Works uniformly across
            // signal-marketplace and signal-owned specialisms (one bridge, both
            // dispatched on the same tool; the per-signal `signal_type` field
            // is the marketplace-vs-owned discriminator).
            else if (toolName === 'get_signals' && testControllerBridge.getSeededSignals) {
              try {
                const rawSeeded = await testControllerBridge.getSeededSignals(bridgeCtx);
                const seeded = filterValidSeededSignals(rawSeeded, logger);
                if (seeded.length > 0) {
                  const sc = formatted.structuredContent as
                    | import('../types/tools.generated').GetSignalsResponse
                    | undefined;
                  if (sc && typeof sc === 'object') {
                    const merged = mergeSeededSignalsIntoResponse(sc, seeded);
                    formatted = wrap(merged);
                    stampBridge(formatted, 'getSeededSignals', toolName, seeded.length);
                  }
                }
              } catch (err) {
                const reason = err instanceof Error ? err.message : String(err);
                logger.warn('testController.getSeededSignals failed; returning handler response unchanged', {
                  tool: toolName,
                  error: reason,
                });
              }
            }

            // get_creative_delivery — append-merge by creative_id;
            // `pagination.total` (when set by the handler) updates by the
            // count of new non-colliding seeded entries. No aggregated-totals
            // recomputation — this response has no top-level totals envelope.
            else if (toolName === 'get_creative_delivery' && testControllerBridge.getSeededCreativeDelivery) {
              try {
                const rawSeeded = await testControllerBridge.getSeededCreativeDelivery(bridgeCtx);
                const seeded = filterValidSeededCreativeDelivery(rawSeeded, logger);
                if (seeded.length > 0) {
                  const sc = formatted.structuredContent as
                    | import('../types/tools.generated').GetCreativeDeliveryResponse
                    | undefined;
                  if (sc && typeof sc === 'object') {
                    const merged = mergeSeededCreativeDeliveryIntoResponse(sc, seeded);
                    formatted = wrap(merged);
                    stampBridge(formatted, 'getSeededCreativeDelivery', toolName, seeded.length);
                  }
                }
              } catch (err) {
                const reason = err instanceof Error ? err.message : String(err);
                logger.warn('testController.getSeededCreativeDelivery failed; returning handler response unchanged', {
                  tool: toolName,
                  error: reason,
                });
              }
            }

            // get_creative_features — `oneOf` envelope. Success arm: merge
            // seeded `CreativeFeatureResult[]` into `results` (dedup by
            // `feature_id`, seeded wins). Error arm: no-op (the helper
            // discriminates by presence of `results: []`).
            else if (toolName === 'get_creative_features' && testControllerBridge.getSeededCreativeFeatures) {
              try {
                const rawSeeded = await testControllerBridge.getSeededCreativeFeatures(bridgeCtx);
                const seeded = filterValidSeededCreativeFeatures(rawSeeded, logger);
                if (seeded.length > 0) {
                  const sc = formatted.structuredContent as
                    | import('../types/tools.generated').GetCreativeFeaturesResponse
                    | undefined;
                  if (sc && typeof sc === 'object') {
                    const merged = mergeSeededCreativeFeaturesIntoResponse(sc, seeded);
                    if (merged !== sc) {
                      formatted = wrap(merged);
                      stampBridge(formatted, 'getSeededCreativeFeatures', toolName, seeded.length);
                    }
                  }
                }
              } catch (err) {
                const reason = err instanceof Error ? err.message : String(err);
                logger.warn('testController.getSeededCreativeFeatures failed; returning handler response unchanged', {
                  tool: toolName,
                  error: reason,
                });
              }
            }

            // get_brand_identity — singleton replace keyed by `brand_id`.
            // Seeded fixture is authoritative on the GetBrandIdentitySuccess
            // body; handler's `context` / `ext` round-trip. The response is
            // a union (success | error) — the dispatcher already gated on
            // `!isErrorResponse`, so we narrow defensively when reading.
            else if (toolName === 'get_brand_identity' && testControllerBridge.getSeededBrandIdentity) {
              try {
                const rawSeeded = await testControllerBridge.getSeededBrandIdentity(bridgeCtx);
                const seeded = filterValidSeededBrandIdentity(rawSeeded, logger);
                if (seeded.length > 0) {
                  const sc = formatted.structuredContent as
                    | import('../types/core.generated').GetBrandIdentityResponse
                    | undefined;
                  if (sc && typeof sc === 'object') {
                    const merged = replaceBrandIdentityIfSeeded(
                      params as import('../types/core.generated').GetBrandIdentityRequest,
                      sc,
                      seeded
                    );
                    if (merged !== sc) {
                      formatted = wrap(merged);
                      stampBridge(formatted, 'getSeededBrandIdentity', toolName, seeded.length);
                    }
                  }
                }
              } catch (err) {
                const reason = err instanceof Error ? err.message : String(err);
                logger.warn('testController.getSeededBrandIdentity failed; returning handler response unchanged', {
                  tool: toolName,
                  error: reason,
                });
              }
            }

            // get_rights — append-merge keyed by `rights_id`. Discovery /
            // search tool (NL `query`); the response carries `rights[]`.
            // Drops to a no-op on the error arm of the response union.
            else if (toolName === 'get_rights' && testControllerBridge.getSeededRights) {
              try {
                const rawSeeded = await testControllerBridge.getSeededRights(bridgeCtx);
                const seeded = filterValidSeededRights(rawSeeded, logger);
                if (seeded.length > 0) {
                  const sc = formatted.structuredContent as
                    | import('../types/core.generated').GetRightsResponse
                    | undefined;
                  if (sc && typeof sc === 'object') {
                    const merged = mergeSeededRightsIntoResponse(sc, seeded);
                    if (merged !== sc) {
                      formatted = wrap(merged);
                      stampBridge(formatted, 'getSeededRights', toolName, seeded.length);
                    }
                  }
                }
              } catch (err) {
                const reason = err instanceof Error ? err.message : String(err);
                logger.warn('testController.getSeededRights failed; returning handler response unchanged', {
                  tool: toolName,
                  error: reason,
                });
              }
            }

            // si_get_offering — singleton replace keyed by `offering_id`.
            // Stateless catalog lookup; the response's `offering_token` is
            // produced for a future session but the lookup itself does not
            // consume one. Handler's `context` / `ext` round-trip.
            else if (toolName === 'si_get_offering' && testControllerBridge.getSeededSiOffering) {
              try {
                const rawSeeded = await testControllerBridge.getSeededSiOffering(bridgeCtx);
                const seeded = filterValidSeededSiOffering(rawSeeded, logger);
                if (seeded.length > 0) {
                  const sc = formatted.structuredContent as
                    | import('../types/tools.generated').SIGetOfferingResponse
                    | undefined;
                  if (sc && typeof sc === 'object') {
                    const merged = replaceSiOfferingIfSeeded(
                      params as import('../types/tools.generated').SIGetOfferingRequest,
                      sc,
                      seeded
                    );
                    if (merged !== sc) {
                      formatted = wrap(merged);
                      stampBridge(formatted, 'getSeededSiOffering', toolName, seeded.length);
                    }
                  }
                }
              } catch (err) {
                const reason = err instanceof Error ? err.message : String(err);
                logger.warn('testController.getSeededSiOffering failed; returning handler response unchanged', {
                  tool: toolName,
                  error: reason,
                });
              }
            }

            // list_content_standards / get_content_standards — list returns
            // `{ standards: ContentStandards[] }` (success arm of a union; the
            // error arm is gated out upstream). Get returns `ContentStandards`
            // directly (success arm); replace the ContentStandards body and
            // round-trip handler's `context` / `ext` (both are framework-
            // managed envelope fields per the spec).
            else if (
              (toolName === 'list_content_standards' || toolName === 'get_content_standards') &&
              testControllerBridge.getSeededContentStandards
            ) {
              try {
                const rawSeeded = await testControllerBridge.getSeededContentStandards(bridgeCtx);
                const seeded = filterValidSeededContentStandards(rawSeeded, logger);
                if (seeded.length > 0) {
                  if (toolName === 'list_content_standards') {
                    const sc = formatted.structuredContent as
                      | import('../types/tools.generated').ListContentStandardsResponse
                      | undefined;
                    if (sc && typeof sc === 'object') {
                      const merged = mergeSeededContentStandardsIntoResponse(sc, seeded);
                      if (merged !== sc) {
                        formatted = wrap(merged);
                        stampBridge(formatted, 'getSeededContentStandards', toolName, seeded.length);
                      }
                    }
                  } else {
                    const sc = formatted.structuredContent as
                      | import('../types/tools.generated').GetContentStandardsResponse
                      | undefined;
                    if (sc && typeof sc === 'object') {
                      const merged = replaceContentStandardsIfSeeded(
                        params as import('../types/tools.generated').GetContentStandardsRequest,
                        sc,
                        seeded
                      );
                      if (merged !== sc) {
                        formatted = wrap(merged);
                        stampBridge(formatted, 'getSeededContentStandards', toolName, seeded.length);
                      }
                    }
                  }
                }
              } catch (err) {
                const reason = err instanceof Error ? err.message : String(err);
                logger.warn('testController.getSeededContentStandards failed; returning handler response unchanged', {
                  tool: toolName,
                  error: reason,
                });
              }
            }
          }

          if (!isErrorResponse(formatted)) {
            if (toolName === 'get_products') {
              formatted =
                normalizeGetProductsCacheScope(formatted, params, ctx.account, ctx.authInfo, exposeErrorDetails) ??
                formatted;
            }
            if (!isErrorResponse(formatted)) {
              normalizeMediaBuyStatusCollision(formatted, toolName);
              injectEnvelopeStatusIntoResponse(formatted);
            }
          }

          // --- Response schema validation (opt-in) ---
          // Runs on the structured payload the handler produced. Errors
          // have their own envelope (`adcp_error`) and are skipped here —
          // their shape is enforced by the adcpError() builder.
          if (responseValidationMode !== 'off' && !isErrorResponse(formatted)) {
            const payload = formatted.structuredContent;
            const outcome = validateResponse(toolName, payload, adcpVersion);
            if (!outcome.valid) {
              logger.warn(
                `Schema validation warning (response) for ${toolName}: ${formatIssues(outcome.issues, 3, { rootSchemaId: outcome.schemaId })}`,
                {
                  tool: toolName,
                  issues: outcome.issues,
                  variant: outcome.variant,
                }
              );
              if (responseValidationMode === 'strict') {
                const errPayload = buildAdcpValidationErrorPayload(toolName, 'response', outcome.issues, {
                  exposeSchemaPath: exposeErrorDetails,
                  rootSchemaId: outcome.schemaId,
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
          // Cache successful mutations for replay. Errors and commercial
          // rejection rows re-execute on retry, not replayed — capability /
          // status changes in the seller's ledger must take effect without
          // waiting for an idempotency TTL to expire. Release the in-flight
          // claim on uncacheable responses so a retry can re-execute.
          //
          // Cache the FORMATTED envelope, not the raw handler return:
          // some wrap functions inject non-deterministic fields
          // (`confirmed_at = new Date().toISOString()`) when the handler
          // omits them. Re-wrapping on replay would produce a different
          // `confirmed_at` each time, breaking the "same response on
          // replay" contract. Caching the formatted envelope pins those
          // fields to their first-execution values.
          if (idempotencyCheck && idempotency) {
            if (shouldCacheIdempotencyResponse(formatted)) {
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
          // Raw `AdcpError` class throws — distinct from the
          // already-projected envelope above. The framework has long
          // documented `throw new AdcpError(...)` as the canonical way
          // to signal structured rejection from any specialism method
          // (see `AdcpError` JSDoc). Project to the typed envelope so
          // the buyer sees the typed code, not `SERVICE_UNAVAILABLE`.
          if (err instanceof AdcpError) {
            logger.warn('Handler threw an AdcpError', {
              tool: toolName,
              handler: handlerKey,
              code: err.code,
              message: err.message,
              stack: err.stack,
            });
            return finalize(projectThrownAdcpError(err));
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
                ? `Tool ${toolName} handler threw: ${redactCredentialPatterns(reason)}`
                : `Tool ${toolName} encountered an internal error`,
              ...(exposeErrorDetails && {
                details: { reason: redactCredentialPatterns(reason), handler: handlerKey },
              }),
            })
          );
        }
      };

      // Register a PASSTHROUGH input schema by default (#909). The MCP
      // SDK's Zod validator only fires on the MCP transport — A2A calls
      // the handler via AdcpServer.invoke(), bypassing it. Registering the
      // real per-tool Zod schema meant MCP and A2A produced different
      // verdicts and different error shapes for the same malformed request.
      // Our framework request validator (AJV, loaded from
      // schemas/cache/<version>/) runs inside the handler closure on BOTH
      // transports and produces a structured adcp_error envelope; make it
      // authoritative unless the adopter opts into MCP discovery schemas.
      //
      // Passthrough (not omit): the SDK's `validateToolInput` returns
      // `undefined` when `inputSchema` is absent (see @modelcontextprotocol/sdk
      // server/mcp.js), and passes that `undefined` verbatim to the
      // handler — destroying the actual arguments. `z.object({}).passthrough()`
      // keeps every key intact, so args still reach the closure.
      //
      // Trade-off: default MCP `tools/list` publishes `{ type: 'object' }`
      // for every tool (no per-tool parameter schema). This is intentional,
      // not a wiring gap — inlining full request schemas in `tools/list`
      // would balloon the context window for LLM consumers. Tool shapes
      // live in `docs/llms.txt`, the SKILL.md files, and `schemas/cache/`,
      // which curated agents read on demand instead of paying the cost
      // every connection. AdCP-native discovery via `get_adcp_capabilities`
      // already works over both transports; upstream #3057 proposes a
      // `get_schema` capability tool for programmatic per-tool shape
      // discovery. For generic MCP clients that need hints directly in
      // `tools/list`, set `exposeToolSchemas: true` to publish shallow
      // top-level key hints derived from `TOOL_INPUT_SHAPES`. Those hint
      // schemas use optional `unknown` fields plus passthrough so MCP keeps
      // all args intact and leaves substantive validation under the
      // framework validator.
      //
      // Implication for downstream consumers: if you need a tool's shape
      // (cross-version field-stripping, gating, validation), read raw
      // JSON from `schemas/cache/{version}/` via `schema-loader.ts` —
      // see `schemaAllowsTopLevelField` for the canonical pattern (#940).
      // Don't try to recover the canonical shape from `tools/list` when
      // `exposeToolSchemas` is off; it's empty by design and will fail open.
      server.registerTool(
        toolName,
        {
          inputSchema: frameworkInputSchemaFor(toolName),
          ...(meta?.annotations != null && { annotations: meta.annotations }),
        },
        toolHandler as Parameters<typeof server.registerTool>[2]
      );

      registeredToolNames.add(toolName);
    }
  }

  if (supportsProtocolTaskTools && taskRegistry !== undefined) {
    server.registerTool(
      'get_task_status',
      {
        inputSchema: frameworkInputSchemaFor('get_task_status'),
        annotations: RO,
      },
      (async (params: any, extra: any) => {
        const credentialError = taskToolCredentialPolicyError('get_task_status', params ?? {}, extra);
        if (credentialError) {
          return finalizeProtocolTaskToolResponse('get_task_status', params ?? {}, credentialError, {
            echoContext: false,
          });
        }
        const validationError = protocolTaskRequestValidationError('get_task_status', params ?? {});
        if (validationError) return finalizeProtocolTaskToolResponse('get_task_status', params ?? {}, validationError);
        const boundsError = protocolTaskBoundsError('get_task_status', params ?? {});
        if (boundsError) return finalizeProtocolTaskToolResponse('get_task_status', params ?? {}, boundsError);
        const versionError = unsupportedVersionResponse(params ?? {});
        if (versionError) return finalizeProtocolTaskToolResponse('get_task_status', params ?? {}, versionError);
        const taskId = typeof params?.task_id === 'string' ? params.task_id : '';
        const { accountId, ownerScope, error } = await resolveTaskQueryAccountId(
          params ?? {},
          extra,
          'get_task_status'
        );
        if (error) return finalizeProtocolTaskToolResponse('get_task_status', params ?? {}, error);
        let task: TaskRecord | null = null;
        try {
          task = taskId && taskRegistry !== undefined ? await taskRegistry.getTask(taskId) : null;
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          logger.error('Task registry read failed during task poll', { tool: 'get_task_status', error: reason });
          return finalizeProtocolTaskToolResponse(
            'get_task_status',
            params ?? {},
            adcpError('SERVICE_UNAVAILABLE', {
              message: 'Task registry read failed',
              ...(exposeErrorDetails && { details: { reason: redactCredentialPatterns(reason) } }),
            })
          );
        }
        if (task == null || accountId === undefined || !taskBelongsToCaller(task, accountId, ownerScope)) {
          return finalizeProtocolTaskToolResponse(
            'get_task_status',
            params ?? {},
            adcpError('REFERENCE_NOT_FOUND', {
              message: taskId ? `Task ${taskId} not found` : 'Task not found',
              field: 'task_id',
            })
          );
        }

        const response = toProtocolTaskStatus(task);
        if (response === undefined) {
          return finalizeProtocolTaskToolResponse(
            'get_task_status',
            params ?? {},
            adcpError('REFERENCE_NOT_FOUND', {
              message: taskId ? `Task ${taskId} not found` : 'Task not found',
              field: 'task_id',
            })
          );
        }
        if (params?.include_result === true && response.status === 'completed') {
          response.result = task.result as GetTaskStatusResponse['result'];
        }
        if (isPlainObject(params?.context)) response.context = params.context;
        return finalizeProtocolTaskToolResponse(
          'get_task_status',
          params ?? {},
          genericResponse('get_task_status', response)
        );
      }) as Parameters<typeof server.registerTool>[2]
    );
    registeredToolNames.add('get_task_status');
  }

  if (supportsProtocolTaskTools && taskRegistry?.list !== undefined) {
    server.registerTool(
      'list_tasks',
      {
        inputSchema: frameworkInputSchemaFor('list_tasks'),
        annotations: RO,
      },
      (async (params: any, extra: any) => {
        const credentialError = taskToolCredentialPolicyError('list_tasks', params ?? {}, extra);
        if (credentialError) {
          return finalizeProtocolTaskToolResponse('list_tasks', params ?? {}, credentialError, { echoContext: false });
        }
        const validationError = protocolTaskRequestValidationError('list_tasks', params ?? {});
        if (validationError) return finalizeProtocolTaskToolResponse('list_tasks', params ?? {}, validationError);
        const boundsError = protocolTaskBoundsError('list_tasks', params ?? {});
        if (boundsError) return finalizeProtocolTaskToolResponse('list_tasks', params ?? {}, boundsError);
        const versionError = unsupportedVersionResponse(params ?? {});
        if (versionError) return finalizeProtocolTaskToolResponse('list_tasks', params ?? {}, versionError);
        const { accountId, ownerScope, error } = await resolveTaskQueryAccountId(params ?? {}, extra, 'list_tasks');
        if (error) return finalizeProtocolTaskToolResponse('list_tasks', params ?? {}, error);
        let cursorStart = 0;
        try {
          cursorStart =
            parseTaskListCursor(isPlainObject(params?.pagination) ? params.pagination.cursor : undefined) ?? 0;
        } catch (err) {
          return finalizeProtocolTaskToolResponse(
            'list_tasks',
            params ?? {},
            adcpError('INVALID_REQUEST', {
              message: err instanceof Error ? err.message : 'Invalid task list cursor',
              field: 'pagination.cursor',
            })
          );
        }

        let listed: { tasks: TaskRecord[] };
        try {
          listed =
            accountId !== undefined && ownerScope !== undefined && taskRegistry?.list !== undefined
              ? await taskRegistry.list({ accountId, ownerScope })
              : { tasks: [] };
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          logger.error('Task registry list failed during task poll', { tool: 'list_tasks', error: reason });
          return finalizeProtocolTaskToolResponse(
            'list_tasks',
            params ?? {},
            adcpError('SERVICE_UNAVAILABLE', {
              message: 'Task registry list failed',
              ...(exposeErrorDetails && { details: { reason: redactCredentialPatterns(reason) } }),
            })
          );
        }
        const filteredTasks = listed.tasks.filter(
          task =>
            accountId !== undefined &&
            taskBelongsToCaller(task, accountId, ownerScope) &&
            taskMatchesFilters(task, params?.filters)
        );
        const sortedTasks = filteredTasks
          .map(toProtocolTaskListItem)
          .filter((task): task is ListTasksResponse['tasks'][number] => task !== undefined)
          .sort((left, right) => compareProtocolTaskItems(left, right, params?.sort));
        const pageSize = taskListPageSize(params?.pagination);
        const tasks = sortedTasks.slice(cursorStart, cursorStart + pageSize);
        const nextOffset = cursorStart + tasks.length;
        const hasMore = nextOffset < sortedTasks.length;
        const status_breakdown = sortedTasks.reduce<Record<string, number>>((counts, task) => {
          counts[task.status] = (counts[task.status] ?? 0) + 1;
          return counts;
        }, {});
        const domain_breakdown = sortedTasks.reduce<Record<string, number>>((counts, task) => {
          counts[task.domain] = (counts[task.domain] ?? 0) + 1;
          return counts;
        }, {});
        const response: ListTasksResponse = {
          status: 'completed',
          query_summary: {
            total_matching: sortedTasks.length,
            returned: tasks.length,
            domain_breakdown,
            status_breakdown,
            filters_applied: isPlainObject(params?.filters) ? Object.keys(params.filters) : [],
            sort_applied: {
              field:
                isPlainObject(params?.sort) && typeof params.sort.field === 'string' ? params.sort.field : 'created_at',
              direction: isPlainObject(params?.sort) && params.sort.direction === 'asc' ? 'asc' : 'desc',
            },
          },
          tasks,
          pagination: {
            has_more: hasMore,
            ...(hasMore && { cursor: String(nextOffset) }),
            total_count: sortedTasks.length,
          },
        };
        if (isPlainObject(params?.context)) response.context = params.context;
        return finalizeProtocolTaskToolResponse('list_tasks', params ?? {}, genericResponse('list_tasks', response));
      }) as Parameters<typeof server.registerTool>[2]
    );
    registeredToolNames.add('list_tasks');
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
            `If this customTool worked in an earlier SDK version, the tool was promoted to first-class — ` +
            `remove the customTools entry and wire the corresponding platform handler instead ` +
            `(e.g. BrandRightsPlatform.updateRights for "update_rights" as of 6.7.0). ` +
            `If you intended a new tool, rename it to avoid the framework name.`
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
      const { description, title, inputSchema, outputSchema, annotations, _meta, handler } = custom;
      // Wrap the adopter-supplied handler so `throw new AdcpError(...)` and
      // `throw adcpError(...)` from inside it project to the typed envelope —
      // matching the behavior framework-registered tools get from the catch
      // at line ~3494. Without the wrap, AdcpError throws escape to the MCP
      // SDK as generic JSON-RPC errors and the buyer loses the typed code.
      // The framework's own `tasks_get` is registered through this path.
      const rawHandler = handler as (...args: unknown[]) => Promise<McpToolResponse> | McpToolResponse;
      const wrappedHandler = (async (...args: unknown[]) => {
        try {
          return applyResponseEnhancer(await rawHandler(...args));
        } catch (err) {
          if (isThrownAdcpError(err)) return applyResponseEnhancer(err);
          if (err instanceof AdcpError) return applyResponseEnhancer(projectThrownAdcpError(err));
          throw err;
        }
      }) as Parameters<typeof server.registerTool>[2];
      server.registerTool(
        customName,
        {
          ...(description != null && { description }),
          ...(title != null && { title }),
          ...(inputSchema != null && { inputSchema }),
          ...(outputSchema != null && { outputSchema }),
          ...(annotations != null && { annotations }),
          ...(_meta != null && { _meta }),
        } as Parameters<typeof server.registerTool>[1],
        wrappedHandler
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
    status: 'completed',
    adcp: {
      major_versions: capConfig?.major_versions ?? [3],
      ...(capConfig?.supported_versions?.length && { supported_versions: [...capConfig.supported_versions] }),
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

  if (
    capabilitiesData.measurement !== undefined &&
    Array.isArray(capabilitiesData.experimental_features) &&
    capabilitiesData.experimental_features.includes('measurement.core') &&
    !capabilitiesData.supported_protocols.includes('measurement' as never)
  ) {
    capabilitiesData.supported_protocols = [
      ...capabilitiesData.supported_protocols,
      'measurement',
    ] as GetAdCPCapabilitiesResponse['supported_protocols'];
  }

  // Stamp the SDK version so conformance tooling can surface version-staleness
  // hints when the agent's reported version predates recommended helpers.
  // Cast needed because GetAdCPCapabilitiesResponse is generated and lacks
  // this field; it remains a forward-compatible extension until the spec
  // formally defines library_version in a future AdCP minor.
  (capabilitiesData as unknown as Record<string, unknown>).library_version = `@adcp/client@${LIBRARY_VERSION}`;

  // Passthrough inputSchema — framework validation is authoritative on
  // both transports (#909). Same rationale as the domain-tool loop above.
  server.registerTool(
    'get_adcp_capabilities',
    {
      inputSchema: frameworkInputSchemaFor('get_adcp_capabilities'),
      annotations: { readOnlyHint: true },
    },
    (async (params: any, extra: { authInfo?: ResolvedAuthInfo } = {}) => {
      if (agentRegistry !== undefined && extra.authInfo !== undefined) {
        const authInfo = extra.authInfo;
        const inboundCredential = authInfo.extra?.credential;
        const credential = authInfo.credential ?? (inboundCredential as ResolvedAuthInfo['credential'] | undefined);
        try {
          const resolved = await agentRegistry.resolve({
            ...(credential !== undefined && { credential }),
            ...(authInfo.extra !== undefined && { extra: authInfo.extra }),
            input: params,
          });
          if (resolved?.status === 'suspended' || resolved?.status === 'blocked') {
            return adcpError(resolved.status === 'suspended' ? 'AGENT_SUSPENDED' : 'AGENT_BLOCKED', {
              message:
                resolved.status === 'suspended'
                  ? 'Buyer agent is suspended. Contact the seller to restore access.'
                  : 'Buyer agent is blocked.',
              recovery: 'terminal',
            });
          }
        } catch (err) {
          logger.warn('Buyer-agent registry resolution failed for get_adcp_capabilities', {
            error: err instanceof Error ? redactCredentialPatterns(err.message) : redactCredentialPatterns(String(err)),
          });
          return adcpError('SERVICE_UNAVAILABLE', {
            message: 'Buyer-agent registry is unavailable',
            recovery: 'transient',
          });
        }
      }
      const data = { ...capabilitiesData };
      const ctx = params?.context;
      if (ctx !== null && typeof ctx === 'object' && !Array.isArray(ctx)) {
        (data as any).context = ctx;
      }
      const response = capabilitiesResponse(data);
      injectVersionIntoResponse(response, servedAdcpVersion);
      return applyResponseEnhancer(response);
    }) as Parameters<typeof server.registerTool>[2]
  );
  registeredToolNames.add('get_adcp_capabilities');

  // Validate `credentialPolicy.tools` keys against the FULL registered
  // tool set, including `get_adcp_capabilities` (registered just above).
  // Earlier placement (before this tool was added) made
  // `tools: { get_adcp_capabilities: 'lax' }` spuriously throw — low
  // real-world impact (the tool never carries credentials) but the
  // typo-check claim "the registered tool set is authoritative" was
  // false for that one tool. Catches typos at construction so an
  // adopter's `tools: { activte_signal: 'lax' }` (missing 'a') doesn't
  // silently no-op the per-tool override and start fail-closing
  // legitimate buyer-creds traffic in production. Also re-validates
  // the `patterns.matcher`/`patterns.extend` mutual-exclusion at
  // construction so the diagnostic doesn't wait for first traffic.
  validateCredentialPolicy(credentialPolicy, registeredToolNames);

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
      if (taskRegistry?.clear) await taskRegistry.clear();
    },
  };
  const wrapped: AdcpServerInternal = wrapMcpServer(server, compliance, adcpVersion);
  setMcpAppResources(wrapped, mcpAppResources);

  // Attach the auto-wired preTransport so `serve()` mounts the verifier
  // on the HTTP transport. Stashed under a non-enumerable symbol property
  // on the wrapper — it's a private contract between this function and
  // `serve()` for wiring, not part of the AdcpServer public API.
  if (signedRequests) {
    const preTransport = buildSignedRequestsPreTransport(signedRequests, capConfig?.request_signing);
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
  // Mark when `instructions` was supplied as a function, so `serve()` can
  // refuse `reuseAgent: true` — the function is captured once at construction
  // and would not re-evaluate per session under server reuse.
  if (instructionsIsFn) {
    Object.defineProperty(wrapped, ADCP_INSTRUCTIONS_FN, {
      value: true,
      enumerable: false,
      configurable: true,
      writable: false,
    });
    if (resolveInstructionsForTransport) {
      Object.defineProperty(wrapped, ADCP_INSTRUCTIONS_RESOLVER, {
        value: resolveInstructionsForTransport,
        enumerable: false,
        configurable: true,
        writable: false,
      });
    }
  }
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
