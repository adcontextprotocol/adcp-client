export { adcpError } from './errors';
export type { AdcpErrorOptions, AdcpErrorPayload, AdcpErrorResponse } from './errors';

export { normalizeError, normalizeErrors } from './normalize-errors';
export type { NormalizedError } from './normalize-errors';

export { pickSafeDetails } from './pick-safe-details';
export type { PickSafeDetailsOptions } from './pick-safe-details';

export { wrapEnvelope } from './wrap-envelope';
export type { WrapEnvelopeOptions } from './wrap-envelope';

export {
  ERROR_ENVELOPE_FIELD_ALLOWLIST,
  DEFAULT_ERROR_ENVELOPE_FIELDS,
  ADCP_ERROR_FIELD_ALLOWLIST,
  CONFLICT_ADCP_ERROR_ALLOWLIST,
} from './envelope-allowlist';

export {
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
  previewCreativeResponse,
  creativeDeliveryResponse,
  listCreativesResponse,
  listPropertyListsResponse,
  listCollectionListsResponse,
  listContentStandardsResponse,
  getPlanAuditLogsResponse,
  syncCreativesResponse,
  getSignalsResponse,
  activateSignalResponse,
  cancelMediaBuyResponse,
  acquireRightsResponse,
  acquireRightsAcquired,
  acquireRightsPendingApproval,
  acquireRightsRejected,
  updateRightsResponse,
  updateRightsSuccess,
  creativeApprovalResponse,
  creativeApprovalApproved,
  creativeApprovalRejected,
  creativeApprovalPendingReview,
  creativeApprovalError,
  syncAccountsResponse,
  syncGovernanceResponse,
  reportUsageResponse,
  toStructuredContent,
} from './responses';
export type { McpToolResponse } from './responses';

export { validActionsForStatus } from './media-buy-helpers';
export type { ValidAction, CancelMediaBuyInput } from './media-buy-helpers';

export { createMediaBuyStore, DEFAULT_MEDIA_BUY_STORE_COLLECTION } from './media-buy-store';
export type {
  MediaBuyStore,
  CreateMediaBuyStoreOptions,
  CreateMediaBuyInputForStore,
  CreateMediaBuyResultForStore,
  UpdateMediaBuyInputForStore,
  GetMediaBuysResultForStore,
} from './media-buy-store';

export {
  MEDIA_BUY_TRANSITIONS,
  CREATIVE_ASSET_TRANSITIONS,
  isLegalMediaBuyTransition,
  isLegalCreativeTransition,
  assertMediaBuyTransition,
  assertCreativeTransition,
} from './state-machine';

export { getAccountMode, isSandboxOrMockAccount, assertSandboxAccount } from './account-mode';
export type { AccountMode } from './account-mode';

export {
  taskToolResponse,
  registerAdcpTaskTool,
  createTaskCapableServer,
  InMemoryTaskStore,
  isTerminal,
} from './tasks';
export type {
  AdcpTaskToolConfig,
  TaskStore,
  TaskMessageQueue,
  CreateTaskOptions,
  ToolTaskHandler,
  CreateTaskRequestHandlerExtra,
  TaskRequestHandlerExtra,
  CreateTaskResult,
  GetTaskResult,
  Task,
} from './tasks';

export {
  PostgresTaskStore,
  cleanupExpiredTasks,
  getMcpTasksMigration,
  MCP_TASKS_MIGRATION,
} from './postgres-task-store';
export type { PgQueryable, PostgresTaskStoreOptions } from './postgres-task-store';

export {
  registerTestController,
  handleTestControllerRequest,
  TestControllerError,
  toMcpResponse,
  TOOL_INPUT_SHAPE,
  CONTROLLER_SCENARIOS,
  SEED_SCENARIOS,
  SEED_MESSAGES,
  SESSION_ENTRY_CAP,
  enforceMapCap,
  createSeedFixtureCache,
} from './test-controller';
export type {
  TestControllerStore,
  TestControllerStoreFactory,
  TestControllerStoreOrFactory,
  ControllerScenario,
  SeedScenario,
  SeedFixtureCache,
} from './test-controller';

export { serve, UnknownHostError, hostname, resolveHost } from './serve';
export type { ServeContext, ServeOptions, ProtectedResourceMetadata } from './serve';

export { createExpressAdapter } from './express-adapter';
export type { ExpressAdapter, ExpressAdapterOptions } from './express-adapter';

export {
  verifyApiKey,
  verifyBearer,
  anyOf,
  extractBearerToken,
  respondUnauthorized,
  signatureErrorCodeFromCause,
  AuthError,
  AUTH_NEEDS_RAW_BODY,
  tagAuthenticatorNeedsRawBody,
  authenticatorNeedsRawBody,
  AUTH_PRESENCE_GATED,
  tagAuthenticatorPresenceGated,
  isAuthenticatorPresenceGated,
  ADCP_SERVE_REQUEST_CONTEXT,
  getServeRequestContext,
  DEFAULT_JWT_ALGORITHMS,
  DEFAULT_JWT_CLOCK_TOLERANCE_SECONDS,
} from './auth';
export type {
  Authenticator,
  AuthPrincipal,
  AuthResult,
  VerifyApiKeyOptions,
  VerifyBearerOptions,
  RespondUnauthorizedOptions,
  ServeRequestContext,
} from './auth';

export { verifyIntrospection } from './auth-introspection';
export type {
  VerifyIntrospectionOptions,
  IntrospectionCacheOptions,
  IntrospectionResponse,
} from './auth-introspection';

export {
  verifySignatureAsAuthenticator,
  requireSignatureWhenPresent,
  requireAuthenticatedOrSigned,
  mcpToolNameResolver,
} from './auth-signature';
export type {
  VerifySignatureAsAuthenticatorOptions,
  RequireSignatureWhenPresentOptions,
  RequireAuthenticatedOrSignedOptions,
} from './auth-signature';

export {
  InMemoryStateStore,
  StateError,
  PatchConflictError,
  DEFAULT_MAX_DOCUMENT_BYTES,
  SESSION_KEY_FIELD,
  createSessionedStore,
  scopedStore,
  patchWithRetry,
  isPutIfMatchConflict,
  validateCollection,
  validateId,
  validatePayloadSize,
  validateWrite,
} from './state-store';
export type {
  AdcpStateStore,
  InMemoryStateStoreOptions,
  ListOptions,
  ListResult,
  PatchWithRetryOptions,
  PutIfMatchResult,
  StateErrorCode,
  VersionedDocument,
} from './state-store';

export { PostgresStateStore, getAdcpStateMigration, ADCP_STATE_MIGRATION } from './postgres-state-store';
export type { PostgresStateStoreOptions } from './postgres-state-store';

export { structuredSerialize, structuredDeserialize } from './structured-serialize';

// `createAdcpServer` is NOT re-exported from `@adcp/sdk/server` anymore —
// LLMs scaffolding from skills consistently latched onto it as the canonical
// entry point despite the @deprecated JSDoc. Removing the top-level export
// forces new code to either reach for `createAdcpServerFromPlatform` (the v6
// canonical) or import from `@adcp/sdk/server/legacy/v5` (mid-migration /
// escape-hatch only). Breaking change: v5 adopters see a hard import error
// and update their import path. The migration is one line; the LLM-output
// quality win is significant. See `docs/migration-5.x-to-6.x.md`.
export {
  requireSessionKey,
  ADCP_PRE_TRANSPORT,
  ADCP_SIGNED_REQUESTS_STATE,
  ADCP_INSTRUCTIONS_FN,
} from './create-adcp-server';
export type { SessionContext, OnInstructionsError, MaybePromise } from './create-adcp-server';
export type {
  AdcpServer,
  AdcpServerComplianceApi,
  AdcpServerTransport,
  AdcpTestRequest,
  AdcpTestToolsCallRequest,
  AdcpTestResponse,
} from './adcp-server';
export type {
  AdcpServerConfig,
  WebhooksConfig,
  AdcpToolMap,
  AdcpServerToolName,
  AdcpCapabilitiesConfig,
  AdcpCapabilitiesOverrides,
  AdcpCustomToolConfig,
  AdcpLogger,
  SignedRequestsConfig,
  AdcpPreTransport,
  AdcpSignedRequestsState,
  HandlerContext,
  SessionKeyContext,
  MediaBuyHandlers,
  SignalsHandlers,
  CreativeHandlers,
  GovernanceHandlers,
  AccountHandlers,
  EventTrackingHandlers,
  SponsoredIntelligenceHandlers,
  ResolveAccountContext,
} from './create-adcp-server';

export { DEFAULT_REPORTING_CAPABILITIES } from './product-defaults';

export {
  isSandboxRequest,
  mergeSeededProductsIntoResponse,
  filterValidSeededProducts,
  bridgeFromTestControllerStore,
  bridgeFromSessionStore,
} from './test-controller-bridge';
export type {
  TestControllerBridge,
  TestControllerBridgeContext,
  BridgeFromSessionStoreOptions,
} from './test-controller-bridge';

export {
  createIdempotencyStore,
  probeIdempotencyStore,
  memoryBackend,
  pgBackend,
  getIdempotencyMigration,
  IDEMPOTENCY_MIGRATION,
  cleanupExpiredIdempotency,
  hashPayload,
} from './idempotency';
export type {
  IdempotencyStore,
  IdempotencyStoreConfig,
  IdempotencyBackend,
  IdempotencyCacheEntry,
  IdempotencyCheckResult,
  MemoryBackendOptions,
  PgBackendOptions,
} from './idempotency';

export { createA2AAdapter, A2AInvocationError } from './a2a-adapter';
export type {
  A2AAdapter,
  A2AAdapterOptions,
  A2AAgentCardOverrides,
  A2AMountOptions,
  ExpressAppLike,
} from './a2a-adapter';

export { createWebhookEmitter, memoryWebhookKeyStore } from './webhook-emitter';
export type {
  WebhookEmitter,
  WebhookEmitterOptions,
  WebhookEmitParams,
  WebhookEmitResult,
  WebhookEmitAttempt,
  WebhookEmitAttemptResult,
  WebhookIdempotencyKeyStore,
  WebhookRetryOptions,
  WebhookAuthentication,
} from './webhook-emitter';
export type { SigningProvider } from '../signing/provider';

export { createPinAndBindFetch, WEBHOOK_SSRF_POLICY, LOOPBACK_OK_WEBHOOK_SSRF_POLICY } from './pin-and-bind-fetch';
export type { PinAndBindFetchOptions, DnsLookupAll } from './pin-and-bind-fetch';

export { checkGovernance, governanceDeniedError } from './governance';
export type {
  CheckGovernanceOptions,
  GovernanceCallResult,
  GovernanceApproved,
  GovernanceDenied,
  GovernanceConditions,
} from './governance';

export {
  resolvePropertyList,
  resolveCollectionList,
  matchesPropertyList,
  matchesCollectionList,
} from './targeting-helpers';
export type {
  ResolvedPropertyList,
  ResolvedCollectionList,
  ResolvedCollection,
  ResolveListOptions,
} from './targeting-helpers';

// ---------------------------------------------------------------------------
// Platform-shaped server entry point (recommended for new agents)
// ---------------------------------------------------------------------------
//
// `createAdcpServerFromPlatform` wraps `createAdcpServer` (the lower-level
// handler-bag entry above) with compile-time specialism enforcement
// (`RequiredPlatformsFor<S>`), capability projection, idempotency wiring,
// async tasks, status normalization, multi-tenant routing, and webhook
// auto-emit. Adopters declare a typed `DecisioningPlatform` per-specialism
// and the framework wires the rest. See `docs/migration-5.x-to-6.x.md`
// and `skills/build-decisioning-platform/` for the full walkthrough.
//
// Both `createAdcpServer` and `createAdcpServerFromPlatform` live on the
// same import path so adopters discover them as siblings; pick the
// function shape that matches your agent. The platform path internally
// builds an `AdcpServerConfig` and calls `createAdcpServer` — they're
// not adjacent surfaces, they're parent-child layers of the same SDK.
//
// **Pin to v5 long-term?** Import from `@adcp/sdk/server/legacy/v5`
// instead. The subpath is the stable home for the v5 handler-bag
// constructor; the top-level re-export here may be removed in a
// future major. New code should not pin against `legacy/v5` either —
// reach for `createAdcpServerFromPlatform` first.
export * from './decisioning';

// ---------------------------------------------------------------------------
// Ctx-metadata store — opaque-blob round-trip for adapter-internal state
// ---------------------------------------------------------------------------
//
// Publishers attach platform-specific opaque blobs to any returned resource
// (product, media_buy, package, creative, audience, signal, rights_grant);
// the framework persists by `(account_id, kind, id)`, strips from buyer-
// facing wire payloads, threads back into the publisher's request context
// on subsequent calls referencing the same resource ID. See
// `docs/proposals/decisioning-platform-v6-1-ctx-metadata.md`.
export {
  createCtxMetadataStore,
  memoryCtxMetadataStore,
  pgCtxMetadataStore,
  getCtxMetadataMigration,
  cleanupExpiredCtxMetadata,
  CTX_METADATA_MIGRATION,
  CtxMetadataValidationError,
  ADCP_INTERNAL_TAG,
  DEFAULT_MAX_VALUE_BYTES,
  MAX_TTL_SECONDS,
  stripCtxMetadata,
  hasCtxMetadata,
  ctxMetadataResultKey,
  scopeCtxMetadataKey,
} from './ctx-metadata';
export type {
  CtxMetadataStore,
  CtxMetadataStoreConfig,
  CtxMetadataBackend,
  CtxMetadataEntry,
  CtxMetadataRef,
  ResourceKind as CtxMetadataResourceKind,
  MemoryCtxMetadataStoreOptions,
  PgCtxMetadataBackendOptions,
  WireShape,
} from './ctx-metadata';

export { createTranslationMap, createUpstreamHttpClient } from './upstream-helpers';
export type {
  TranslationMap,
  UpstreamAuth,
  AuthContext,
  UpstreamCallOptions,
  UpstreamHttpClientOptions,
  UpstreamHttpClient,
  UpstreamHttpResult,
} from './upstream-helpers';

// ---------------------------------------------------------------------------
// Server-side adapters
// ---------------------------------------------------------------------------
export {
  InMemoryImplicitAccountStore,
  defaultImplicitKeyFn,
  type ImplicitAccountStoreOptions,
} from '../adapters/implicit-account-store';

export {
  createOAuthPassthroughResolver,
  type OAuthPassthroughResolverOptions,
} from '../adapters/oauth-passthrough-resolver';

export { createRosterAccountStore, type RosterAccountStoreOptions } from '../adapters/roster-account-store';
