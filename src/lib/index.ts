// AdCP Client Library - Main Exports
// A comprehensive type-safe client library for the AdContext Protocol

// ====== REGISTRY LOOKUPS ======
export { RegistryClient, RegistrySync, PropertyRegistry, InMemoryCursorStore, FileCursorStore } from './registry';
export type {
  RegistrySyncConfig,
  RegistrySyncState,
  RegistrySyncEvents,
  AgentFilter,
  CursorStore,
  PropertyRegistryConfig,
} from './registry';
export type {
  ResolvedBrand,
  ResolvedProperty as ResolvedRegistryProperty,
  PropertyInfo,
  RegistryClientConfig,
  SaveBrandRequest,
  SaveBrandResponse,
  SavePropertyRequest,
  SavePropertyResponse,
  BrandRegistryItem,
  PropertyRegistryItem,
  ValidationResult as RegistryValidationResult,
  FederatedAgentWithDetails,
  FederatedPublisher,
  DomainLookupResult,
  ListOptions,
  ListAgentsOptions,
  PublisherPropertySelector,
  CompanySearchResult,
  FindCompanyResult,
  ListPoliciesQuery,
  ListPoliciesResponse,
  ResolvePolicyQuery,
  ResolvePolicyResponse,
  ResolvePoliciesBulkRequest,
  ResolvePoliciesBulkResponse,
  GetPolicyHistoryQuery,
  GetPolicyHistoryResponse,
  SavePolicyRequest,
  SavePolicyResponse,
  GetBrandHistoryQuery,
  GetBrandHistoryResponse,
  GetPropertyHistoryQuery,
  GetPropertyHistoryResponse,
  AgentCompliance,
  AgentComplianceDetail,
  StoryboardStatus,
  OperatorLookupResult,
  PublisherLookupResult,
  ComplianceChangedPayload,
  GetAgentStoryboardStatusResponse,
  GetAgentStoryboardStatusBulkResponse,
} from './registry';

// ====== PROPERTY DISCOVERY (AdCP v2.2.0) ======
export {
  PropertyIndex,
  getPropertyIndex,
  resetPropertyIndex,
  type PropertyMatch,
  type AgentAuthorization,
} from './discovery/property-index';
export {
  PropertyCrawler,
  type AgentInfo,
  type CrawlResult,
  type PropertyCrawlerConfig,
} from './discovery/property-crawler';
export {
  NetworkConsistencyChecker,
  type NetworkConsistencyCheckerConfig,
  type NetworkCheckReport,
  type CheckSummary,
  type CheckProgress,
  type OrphanedPointer,
  type StalePointer,
  type MissingPointer,
  type SchemaError,
  type AgentHealthResult,
  type DomainDetail,
  type DomainStatus,
} from './discovery/network-consistency-checker';
export type {
  Property,
  PropertyIdentifier,
  PropertyIdentifierType,
  PropertyType,
  AdAgentsJson,
} from './discovery/types';

// ====== CORE CONVERSATION-AWARE CLIENTS ======
// New conversation-aware clients with input handler pattern
export { SingleAgentClient, createSingleAgentClient, UnsupportedFeatureError } from './core/SingleAgentClient';
export type { SingleAgentClientConfig } from './core/SingleAgentClient';
export { AgentClient, type TaskResponseTypeMap, type AdcpTaskName } from './core/AgentClient';
export { ADCPMultiAgentClient, createADCPMultiAgentClient } from './core/ADCPMultiAgentClient';
export { ConfigurationManager } from './core/ConfigurationManager';
export {
  CreativeAgentClient,
  createCreativeAgentClient,
  STANDARD_CREATIVE_AGENTS,
  type CreativeFormat,
  type CreativeAgentClientConfig,
} from './core/CreativeAgentClient';
export { TaskExecutor } from './core/TaskExecutor';
export { ProtocolResponseParser, responseParser, ADCP_STATUS, type ADCPStatus } from './core/ProtocolResponseParser';
export {
  ResponseValidator,
  responseValidator,
  type ValidationResult,
  type ValidationOptions,
} from './core/ResponseValidator';
// ====== CONVERSATION TYPES ======
export type {
  Message,
  InputRequest,
  InputHandler,
  InputHandlerResponse,
  ConversationContext,
  TaskOptions,
  TaskResult,
  TaskResultCompleted,
  TaskResultIntermediate,
  TaskResultFailure,
  TaskResultMetadata,
  TaskState,
  TaskStatus,
  ConversationConfig,
  AdcpErrorInfo,
} from './core/ConversationTypes';

// ====== GOVERNANCE ======
// Buyer-side: GovernanceConfig + GovernanceMiddleware handle check → execute → report automatically.
// Seller-side: GovernanceAdapter runs committed checks before executing media buys.
// Types: GovernanceCheckResult, GovernanceOutcome are attached to TaskResult when governance is active.

// Buyer-side middleware types
export type {
  GovernanceConfig,
  CampaignGovernanceConfig,
  GovernanceCheckResult,
  GovernanceOutcome,
  GovernanceFinding,
  GovernanceCondition,
  GovernanceEscalation,
} from './core/GovernanceTypes';
export { GovernanceMiddleware } from './core/GovernanceMiddleware';
export type { GovernanceDebugEntry } from './core/GovernanceMiddleware';

// ====== TASK EVENT TYPES ======
export type {
  BaseTaskEvent,
  ProtocolRequestEvent,
  ProtocolResponseEvent,
  TaskStatusEvent,
  ObjectEvent,
  TaskEvent,
  TaskEventCallbacks,
} from './core/TaskEventTypes';
export { createOperationId } from './core/TaskEventTypes';

// ====== ASYNC HANDLER ======
export type {
  AsyncHandlerConfig,
  WebhookMetadata,
  Activity,
  NotificationMetadata,
  MediaBuyDeliveryNotification,
  CreateMediaBuyStatusChangeHandler,
  UpdateMediaBuyStatusChangeHandler,
  SyncCreativesStatusChangeHandler,
  GetProductsStatusChangeHandler,
} from './core/AsyncHandler';
export { AsyncHandler, createAsyncHandler } from './core/AsyncHandler';

// ====== INPUT HANDLERS ======
export * from './handlers/types';

// ====== STORAGE INTERFACES ======
export type {
  Storage,
  BatchStorage,
  PatternStorage,
  AgentCapabilities,
  ConversationState,
  DeferredTaskState,
  StorageConfig,
  StorageFactory,
  StorageMiddleware,
} from './storage/interfaces';
export { MemoryStorage, createMemoryStorage, createMemoryStorageConfig } from './storage/MemoryStorage';

// ====== ERROR CLASSES ======
export {
  ADCPError,
  TaskTimeoutError,
  MaxClarificationError,
  DeferredTaskError,
  TaskAbortedError,
  AgentNotFoundError,
  UnsupportedTaskError,
  ProtocolError,
  ValidationError as ADCPValidationError, // Rename to avoid conflict
  MissingInputHandlerError,
  InvalidContextError,
  ConfigurationError,
  AuthenticationRequiredError,
  FeatureUnsupportedError,
  IdempotencyConflictError,
  IdempotencyExpiredError,
  isADCPError,
  isErrorOfType,
  extractErrorInfo,
  is401Error,
} from './errors';
export type { OAuthMetadataInfo } from './errors';
export { InputRequiredError } from './core/TaskExecutor';

// ====== IDEMPOTENCY ======
export {
  generateIdempotencyKey,
  isMutatingTask,
  isValidIdempotencyKey,
  IDEMPOTENCY_KEY_PATTERN,
  MUTATING_TASKS,
} from './utils/idempotency';
export type { MutatingRequestInput } from './utils/idempotency';
export { canonicalize, canonicalJsonSha256 } from './utils/jcs';

// ====== CORE TYPES ======
export * from './types';

// ====== TOOL TYPES ======
// Request and response types for each AdCP tool.
//
// Naming convention:
//   {ToolName}Request  -- parameters for a tool call (e.g., CreateMediaBuyRequest)
//   {ToolName}Response -- return value; often a union of {ToolName}Success | {ToolName}Error
//
// Nested domain types within requests use a Request suffix when the shape
// differs from the response version:
//   PackageRequest  -- creation-shaped (required: buyer_ref, product_id, budget, pricing_option_id)
//   Package         -- response-shaped from core.generated (has package_id, most fields optional)
//
// Platform implementors: use Request types to type/validate incoming tool calls,
// Response types to shape your return values.
// Zod schemas for runtime validation are exported below (e.g., CreateMediaBuyRequestSchema).
export type {
  // Media Buy Domain
  GetProductsRequest,
  GetProductsResponse,
  ListCreativeFormatsRequest,
  ListCreativeFormatsResponse,
  CreateMediaBuyRequest,
  CreateMediaBuyResponse,
  UpdateMediaBuyRequest,
  UpdateMediaBuyResponse,
  SyncCreativesRequest,
  SyncCreativesResponse,
  ListCreativesRequest,
  ListCreativesResponse,
  CreativeFilters,
  GetMediaBuyDeliveryRequest,
  GetMediaBuyDeliveryResponse,
  ProvidePerformanceFeedbackRequest,
  ProvidePerformanceFeedbackResponse,
  // Signals Domain
  GetSignalsRequest,
  GetSignalsResponse,
  ActivateSignalRequest,
  ActivateSignalResponse,
  CpmPricing,
  PercentOfMediaPricing,
  FlatFeePricing,
  // Governance Domain - Property Lists
  CreatePropertyListRequest,
  CreatePropertyListResponse,
  UpdatePropertyListRequest,
  UpdatePropertyListResponse,
  GetPropertyListRequest,
  GetPropertyListResponse,
  ListPropertyListsRequest,
  ListPropertyListsResponse,
  DeletePropertyListRequest,
  DeletePropertyListResponse,
  PropertyList,
  PropertyListFilters,
  // Governance Domain - Content Standards
  ListContentStandardsRequest,
  ListContentStandardsResponse,
  GetContentStandardsRequest,
  GetContentStandardsResponse,
  CreateContentStandardsRequest,
  CreateContentStandardsResponse,
  UpdateContentStandardsRequest,
  UpdateContentStandardsResponse,
  CalibrateContentRequest,
  CalibrateContentResponse,
  ValidateContentDeliveryRequest,
  ValidateContentDeliveryResponse,
  ContentStandards,
  Artifact,
  // Governance Domain - Campaign Governance
  SyncPlansRequest,
  SyncPlansResponse,
  CheckGovernanceRequest,
  CheckGovernanceResponse,
  ReportPlanOutcomeRequest,
  ReportPlanOutcomeResponse,
  GetPlanAuditLogsRequest,
  GetPlanAuditLogsResponse,
  // Governance Domain - Types & Enums
  PlannedDelivery,
  GovernancePhase,
  EscalationSeverity,
  PolicyEnforcementLevel,
  OutcomeType,
  // Governance Domain - Creative Features
  GetCreativeFeaturesRequest,
  GetCreativeFeaturesResponse,
  // Sponsored Intelligence Domain
  SIGetOfferingRequest,
  SIGetOfferingResponse,
  SIInitiateSessionRequest,
  SIInitiateSessionResponse,
  SISendMessageRequest,
  SISendMessageResponse,
  SITerminateSessionRequest,
  SITerminateSessionResponse,
  SICapabilities,
  SIIdentity,
  // Protocol Domain
  GetAdCPCapabilitiesRequest,
  GetAdCPCapabilitiesResponse,
  // Event Tracking Domain
  SyncEventSourcesRequest,
  SyncEventSourcesResponse,
  LogEventRequest,
  LogEventResponse,
  // Enums
  CanceledBy,
  // Core data structures used within requests and responses
  Format,
  Product,
  Proposal,
  ProductAllocation,
  PackageRequest, // Creation params for packages — not Package (response-shaped, from core.generated)
  CreativeAsset,
  CreativePolicy,
  BrandReference,
  BrandID,
  AccountReference,
  CPAPricingOption,
  EventType,
  ActionSource,
  OptimizationGoal,
  ReachUnit,
  TargetingOverlay,
  OutcomeMeasurement,
  Duration,
  DeviceType,
  DigitalSourceType,
  FrequencyCap,
  GeographicBreakdownSupport,
  // Catalog Domain
  Catalog,
  CatalogType,
  FeedFormat,
  UpdateFrequency,
  ContentIDType,
  CatalogAction,
  CatalogItemStatus,
  CatalogFieldMapping,
  SyncCatalogsRequest,
  SyncCatalogsResponse,
  SyncCatalogsSuccess,
  SyncCatalogsError,
  // Format Assets
  Overlay,
  // Creative Agent Domain
  CreativeBrief,
  CreativeManifest,
  CreativeVariable,
  BuildCreativeRequest,
  BuildCreativeResponse,
  PreviewCreativeRequest,
  PreviewCreativeResponse,
  GetMediaBuysRequest,
  GetMediaBuysResponse,
  ImageAsset,
  VideoAsset,
  AudioAsset,
  TextAsset,
  URLAsset,
  HTMLAsset,
  VASTAsset,
  DAASTAsset,
  JavaScriptAsset,
  WebhookAsset,
  CSSAsset,
  MarkdownAsset,
  CatalogAsset,
  BriefAsset,
  ReferenceAsset,
  Provenance,
  PreviewOutputFormat,
  DisclosurePosition,
  // Event Tracking
  EventCustomData,
  // Creative Delivery Domain
  GetCreativeDeliveryRequest,
  GetCreativeDeliveryResponse,
  // Account Domain
  Account,
  ListAccountsRequest,
  ListAccountsResponse,
  SyncAccountsRequest,
  SyncAccountsResponse,
  GetAccountFinancialsRequest,
  GetAccountFinancialsResponse,
  GetAccountFinancialsSuccess,
  GetAccountFinancialsError,
  // Pagination
  PaginationRequest,
  PaginationResponse,
  // Nested domain types used as fields within request/response objects
  PackageUpdate,
  Package,
  Destination,
  SignalFilters,
  PricingOption,
  PriceGuidance,
} from './types/tools.generated';
export type { DelegationAuthority } from './types/core.generated';

// ====== ERROR CODES ======
// Standard error code vocabulary for programmatic error handling
export type { Error as TaskErrorDetail } from './types/core.generated';
export { STANDARD_ERROR_CODES, isStandardErrorCode, getErrorRecovery } from './types/error-codes';
export type { StandardErrorCode, ErrorRecovery } from './types/error-codes';

// ====== SERVER-SIDE HELPERS ======
// Helpers for building AdCP-compliant MCP servers
export {
  adcpError,
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
  syncCreativesResponse,
  getSignalsResponse,
  activateSignalResponse,
  cancelMediaBuyResponse,
  validActionsForStatus,
  taskToolResponse,
  registerAdcpTaskTool,
  createTaskCapableServer,
  InMemoryTaskStore,
  isTerminal,
  serve,
  registerTestController,
  TestControllerError,
  PostgresTaskStore,
  cleanupExpiredTasks,
  getMcpTasksMigration,
  MCP_TASKS_MIGRATION,
  createAdcpServer,
  checkGovernance,
  governanceDeniedError,
  DEFAULT_REPORTING_CAPABILITIES,
  InMemoryStateStore,
  PostgresStateStore,
  getAdcpStateMigration,
  ADCP_STATE_MIGRATION,
  StateError,
  PatchConflictError,
  SESSION_KEY_FIELD,
  createSessionedStore,
  scopedStore,
  patchWithRetry,
  isPutIfMatchConflict,
  requireSessionKey,
  structuredSerialize,
  structuredDeserialize,
} from './server';
export type {
  AdcpErrorOptions,
  AdcpErrorResponse,
  McpToolResponse,
  ValidAction,
  CancelMediaBuyInput,
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
  ServeContext,
  ServeOptions,
  PgQueryable,
  PostgresTaskStoreOptions,
  TestControllerStore,
  ControllerScenario,
  AdcpServerConfig,
  AdcpToolMap,
  AdcpServerToolName,
  AdcpCapabilitiesConfig,
  AdcpLogger,
  HandlerContext,
  MediaBuyHandlers,
  SignalsHandlers,
  CreativeHandlers,
  GovernanceHandlers,
  AccountHandlers,
  EventTrackingHandlers,
  SponsoredIntelligenceHandlers,
  CheckGovernanceOptions,
  GovernanceCallResult,
  GovernanceApproved,
  GovernanceDenied,
  GovernanceConditions,
  AdcpStateStore,
  ListOptions as StateListOptions,
  ListResult as StateListResult,
  PostgresStateStoreOptions,
  InMemoryStateStoreOptions,
  VersionedDocument,
  PutIfMatchResult,
  PatchWithRetryOptions,
  StateErrorCode,
  SessionKeyContext,
} from './server';

// ====== ERROR HANDLING & RETRY ======
export { isRetryable, getRetryDelay } from './utils/retry';

// Public API: use these for programmatic error handling
export {
  extractAdcpErrorInfo,
  extractCorrelationId,
  resolveRecovery,
  getExpectedAction,
} from './utils/error-extraction';

// Internal: transport-level extraction (used by SDK internals; prefer result.adcpError instead)
export { extractAdcpErrorFromMcp, extractAdcpErrorFromTransport } from './utils/error-extraction';
export type { ExtractedAdcpError } from './utils/error-extraction';

// ====== BACKWARDS COMPATIBILITY ======
// Deprecated types from past protocol migrations
export type {
  BrandManifest,
  BrandManifestReference,
  AssetContentType,
  PromotedProducts,
  PromotedOfferings,
  Measurement,
} from './types/compat';
export { brandManifestToBrandReference, promotedProductsToCatalog, promotedOfferingsToCatalog } from './types/compat';

// Request parameter normalization (deprecated field auto-conversion)
export { normalizeRequestParams, normalizePackageParams } from './utils/request-normalizer';

// ====== ZOD SCHEMAS (for runtime validation) ======
// Re-export all Zod schemas for user validation needs
export * from './types/schemas.generated';

// PreviewCreativeRequestSchema is now a flat z.object() with request_type discriminant.
// The old variant exports (PreviewCreativeSingleRequestSchema, etc.) are no longer needed —
// use PreviewCreativeRequestSchema.shape directly with server.tool().

// ====== AUTHENTICATION ======
// Auth utilities for custom integrations
export { getAuthToken, createAdCPHeaders, createMCPAuthHeaders, createAuthenticatedFetch } from './auth';

// ====== TOOL SCHEMA MAPS ======
// Zod schemas keyed by tool name — use with server.tool(name, schema.shape, handler)
export { TOOL_REQUEST_SCHEMAS } from './utils/tool-request-schemas';
export { TOOL_RESPONSE_SCHEMAS } from './utils/response-schemas';

// ====== VALIDATION ======
// Schema validation for requests/responses
export { validateAgentUrl, validateAdCPResponse, getExpectedSchema, handleAdCPResponse } from './validation';

// ====== PROTOCOL CLIENTS ======
// Low-level protocol clients for MCP and A2A (primarily for testing)
export {
  ProtocolClient,
  callMCPTool,
  callA2ATool,
  createMCPClient,
  createA2AClient,
  closeMCPConnections,
} from './protocols';

// ====== RESPONSE UTILITIES ======
// Public utilities for working with AdCP responses
export { getStandardFormats, unwrapProtocolResponse, isAdcpError, isAdcpSuccess } from './utils';
export { REQUEST_TIMEOUT, MAX_CONCURRENT, STANDARD_FORMATS } from './utils';
export { detectProtocol, detectProtocolWithTimeout } from './utils';
export { A2A_CARD_PATHS, isAgentCardPath, isWellKnownAgentCardUrl, buildCardUrls, stripAgentCardPath } from './utils';

// ====== PRICING UTILITIES ======
// Pricing adapter for v2/v3 compatibility and CPA detection
export { isCPAPricing } from './utils';

// ====== PAGINATION UTILITIES ======
// Auto-pagination helpers for cursor-based AdCP endpoints
export { paginate, paginatePages, type PaginateOptions } from './utils';

// ====== FORMAT ASSET UTILITIES ======
// Access to format assets (v3 `assets` field)
export {
  getFormatAssets,
  getRequiredAssets,
  getOptionalAssets,
  getIndividualAssets,
  getRepeatableGroups,
  usesDeprecatedAssetsField,
  getAssetCount,
  hasAssets,
} from './utils/format-assets';

// ====== V3.0 COMPATIBILITY UTILITIES ======
// Capabilities detection and synthetic capabilities for v2 servers
export {
  buildSyntheticCapabilities,
  parseCapabilitiesResponse,
  supportsV3,
  supportsProtocol,
  supportsPropertyListFiltering,
  supportsContentStandards,
  requiresOperatorAuth,
  requiresAccountForProducts,
  supportsSandbox,
  resolveFeature,
  listDeclaredFeatures,
  MEDIA_BUY_TOOLS,
  SIGNALS_TOOLS,
  GOVERNANCE_TOOLS,
  CREATIVE_TOOLS,
  EVENT_TRACKING_TOOLS,
  ACCOUNT_TOOLS,
  PROTOCOL_TOOLS,
  BRAND_RIGHTS_TOOLS,
  TASK_FEATURE_MAP,
} from './utils/capabilities';
export type {
  AdcpCapabilities,
  AdcpMajorVersion,
  AdcpProtocol,
  AccountCapabilities,
  MediaBuyFeatures,
  ToolInfo,
  FeatureName,
} from './utils/capabilities';

// Creative assignment adapter (v2 creative_ids ↔ v3 creative_assignments)
export {
  adaptPackageRequestForV2,
  adaptCreateMediaBuyRequestForV2,
  adaptUpdateMediaBuyRequestForV2,
  normalizePackageResponse,
  normalizeMediaBuyResponse,
  usesV2CreativeIds,
  usesV3CreativeAssignments,
  getCreativeIds,
  getCreativeAssignments,
} from './utils/creative-adapter';
export type { CreativeAssignment } from './utils/creative-adapter';

// Format renders normalizer (v2 dimensions ↔ v3 renders)
export {
  normalizeFormatRenders,
  normalizeFormatsResponse,
  getFormatRenders,
  getPrimaryRender,
  getCompanionRenders,
  isMultiRenderFormat,
  usesV2Dimensions,
  usesV3Renders,
  getFormatDimensions,
} from './utils/format-renders';
export type { FormatRender, RenderDimensions } from './utils/format-renders';

// Preview response normalizer (v2 output_id ↔ v3 render_id)
export {
  normalizePreviewRender,
  normalizePreview,
  normalizePreviewCreativeResponse,
  usesV2RenderFields,
  usesV3RenderFields,
  getRenderId,
  getRenderRole,
  getPrimaryPreviewRender,
  getPreviewUrl,
  getPreviewHtml,
} from './utils/preview-normalizer';
export type { PreviewRenderV3 } from './utils/preview-normalizer';

// ====== TYPE GUARD UTILITIES ======
// Type guards for automatic TypeScript type narrowing in webhook handlers
export {
  // Generic status checks
  isStatusCompleted,
  isStatusWorking,
  isStatusInputRequired,
  isStatusSubmitted,
  isStatusFailed,
  isStatusRejected,
  // GetProducts type guards
  isGetProductsCompleted,
  isGetProductsWorking,
  isGetProductsInputRequired,
  isGetProductsSubmitted,
  isGetProductsFailed,
  // CreateMediaBuy type guards
  isCreateMediaBuyCompleted,
  isCreateMediaBuyWorking,
  isCreateMediaBuyInputRequired,
  isCreateMediaBuySubmitted,
  isCreateMediaBuyFailed,
  // UpdateMediaBuy type guards
  isUpdateMediaBuyCompleted,
  isUpdateMediaBuyWorking,
  isUpdateMediaBuyInputRequired,
  isUpdateMediaBuySubmitted,
  isUpdateMediaBuyFailed,
  // SyncCreatives type guards
  isSyncCreativesCompleted,
  isSyncCreativesWorking,
  isSyncCreativesInputRequired,
  isSyncCreativesSubmitted,
  isSyncCreativesFailed,
} from './utils/typeGuards';

// ====== VERSION INFORMATION ======
export {
  getAdcpVersion,
  getLibraryVersion,
  isCompatibleWith,
  getCompatibleVersions,
  ADCP_VERSION,
  ADCP_MAJOR_VERSION,
  LIBRARY_VERSION,
  COMPATIBLE_ADCP_VERSIONS,
  VERSION_INFO,
} from './version';

// ====== OBSERVABILITY ======
// OpenTelemetry tracing utilities (no-op if @opentelemetry/api not installed)
export {
  getTracer,
  isTracingEnabled,
  injectTraceHeaders,
  withSpan,
  addSpanAttributes,
  recordSpanException,
} from './observability';

// ====== AGENT CLASSES ======
// Primary agent interface - returns raw AdCP responses
export { Agent, AgentCollection } from './agents/index.generated';

// ====== SERVER-SIDE ADAPTERS ======
// Adapters for building AdCP servers with customizable business logic
export {
  // Content Standards
  ContentStandardsAdapter,
  type IContentStandardsAdapter,
  type ContentEvaluationResult,
  ContentStandardsErrorCodes,
  isContentStandardsError,
  defaultContentStandardsAdapter,
  // Property Lists
  PropertyListAdapter,
  type IPropertyListAdapter,
  type ResolvedProperty,
  PropertyListErrorCodes,
  isPropertyListError,
  defaultPropertyListAdapter,
  // Proposal Management
  ProposalManager,
  AIProposalManager,
  type IProposalManager,
  type ProposalContext,
  ProposalErrorCodes,
  defaultProposalManager,
  // Sponsored Intelligence Sessions
  SISessionManager,
  AISISessionManager,
  type ISISessionManager,
  type SISession,
  SIErrorCodes,
  defaultSISessionManager,
  // Governance (seller-side committed checks)
  GovernanceAdapter,
  defaultGovernanceAdapter,
  type IGovernanceAdapter,
  type GovernanceAdapterConfig,
  type GovernanceAdapterErrorCode,
  type CommittedCheckRequest,
  GovernanceAdapterErrorCodes,
  isGovernanceAdapterError,
} from './adapters';

// ====== BACKWARD COMPATIBILITY & ENVIRONMENT LOADING ======

import type { AgentConfig } from './types';
import { ADCPMultiAgentClient } from './core/ADCPMultiAgentClient';

/**
 * Legacy AdCPClient alias for backward compatibility
 * @deprecated Use ADCPMultiAgentClient instead for new code
 */
export const AdCPClient = ADCPMultiAgentClient;

// Legacy configuration manager maintained for backward compatibility
// The enhanced ConfigurationManager is exported above

/**
 * Legacy createAdCPClient function for backward compatibility
 * @deprecated Use new ADCPMultiAgentClient constructor instead
 */
export function createAdCPClient(agents?: AgentConfig[]): ADCPMultiAgentClient {
  return new AdCPClient(agents);
}

/**
 * Load agents from environment and create multi-agent client
 * @deprecated Use ADCPMultiAgentClient.fromEnv() instead
 */
export function createAdCPClientFromEnv(): ADCPMultiAgentClient {
  return ADCPMultiAgentClient.fromEnv();
}

// ====== TEST HELPERS ======
// Re-export test helpers for convenience (also available via @adcp/client/testing)
export {
  testAgent,
  testAgentA2A,
  testAgentClient,
  createTestAgent,
  TEST_AGENT_TOKEN,
  TEST_AGENT_MCP_CONFIG,
  TEST_AGENT_A2A_CONFIG,
  testAgentNoAuth,
  testAgentNoAuthA2A,
  TEST_AGENT_NO_AUTH_MCP_CONFIG,
  TEST_AGENT_NO_AUTH_A2A_CONFIG,
  creativeAgent,
  testBrandRightsFlow,
  hasBrandRightsTools,
} from './testing/index';
