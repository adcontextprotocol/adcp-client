// AdCP Client Library - Main Exports
// A comprehensive type-safe client library for the AdContext Protocol

// ====== REGISTRY LOOKUPS ======
export {
  RegistryClient,
  RegistrySync,
  PropertyRegistry,
  InMemoryCursorStore,
  FileCursorStore,
  buildCommunityMirrorAdagents,
} from './registry';
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
  ListBrandsOptions,
  ListOptions,
  ListAgentsOptions,
  ListAgentsResponse,
  ListPublishersResponse,
  ValidateAdagentsRequest,
  CreateAdagentsRequest,
  CreateAdagentsResponse,
  AdagentsAuthorizedAgent,
  AdagentsCatalogFormat,
  AdagentsPlacementDefinition,
  AdagentsPlacementFormatReference,
  AdagentsPlacementFormatOption,
  AdagentsPlacementTag,
  CreatedAdagentsJson,
  CommunityMirrorAdagentsConfig,
  CreateCommunityMirrorAdagentsConfig,
  CommunityMirrorAdagentsCatalog,
  PublishCommunityMirrorAdagentsResponse,
  CommunityMirrorAdagentsSummary,
  ListCommunityMirrorAdagentsResponse,
  GetCommunityMirrorAdagentsResponse,
  PublishCommunityMirrorAdagentsRequest,
  PublishCommunityMirrorAdagentsError,
  DeleteCommunityMirrorAdagentsResponse,
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

// ====== BRAND JSON HELPERS ======
export {
  COMMON_LOGO_SLOTS,
  applyBrandAssetMappings,
  checkLogoSlotCoverage,
  selectLogoForSlot,
  updateBrandJsonFromMappings,
  validateBrandAssetMappings,
} from './brand';
export type {
  AppliedBrandAssetMapping,
  ApplyBrandAssetMappingsOptions,
  ApplyBrandAssetMappingsResult,
  BrandAssetCandidate,
  BrandAssetCropBox,
  BrandAssetExtractionMethod,
  BrandAssetMapping,
  BrandAssetMappingIssue,
  BrandAssetMappingTarget,
  BrandAssetMappingValidationResult,
  BrandAssetReviewStatus,
  BrandJsonRecord,
  BrandLogoBackground,
  BrandLogoOrientation,
  BrandLogoProposal,
  BrandLogoVariant,
  LogoSelectionOptions,
  LogoSlotCoverage,
  LogoSlotCoverageOptions,
  ResolveBrandAssetUrl,
  SkippedBrandAssetMapping,
  UpdateBrandJsonFromMappingsOptions,
  UpdateBrandJsonFromMappingsResult,
} from './brand';

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
  AuthorizedAgent,
  AuthorizationType,
  // Aliased: the registry types also export a `PublisherPropertySelector`
  // (registry-flat shape with no `selection_type` discriminator). The
  // adagents.json schema's variant is a discriminated union, so we
  // expose it under a distinct name to avoid clobbering the registry
  // type that's been part of the public API longer.
  PublisherPropertySelector as AdAgentsPublisherPropertySelector,
  SinglePublisherPropertySelector,
  CompactPublisherPropertySelector,
} from './discovery/types';
export {
  parsePublisherPropertySelector,
  expandPublisherPropertySelector,
  expandPublisherPropertySelectors,
  isCompactPublisherPropertySelector,
  publisherDomainsCoveredBySelectors,
  PublisherPropertySelectorParseError,
  type PublisherPropertySelectorError,
} from './discovery/publisher-property-selector';
export {
  resolveAgentProperties,
  listAgentPropertyMap,
  canonicalizeAgentUrl,
  type ResolvedAgentScope,
  type ResolveUnresolvableReason,
} from './discovery/resolve-agent-properties';
export {
  resolveInlinePublisherProperties,
  resolveSingularInline,
  detectInlineFederatedDivergence,
  type InlineResolutionResult,
  type InlineFederatedDivergence,
} from './discovery/inline-publisher-properties';
export {
  fetchAgentAuthorizationsFromDirectory,
  type AgentAuthorizationsIterator,
  type FetchAgentAuthorizationsOptions,
  type DirectoryLookupPage,
  type DirectoryPublisherEntry,
  type DirectoryDiscoveryMethod,
  type DirectoryPublisherStatus,
} from './discovery/agent-directory';
export {
  validateAdAgents,
  parseManagerDomain,
  type DiscoveryMethod,
  type AdAgentsValidationResult,
  type ValidateAdAgentsOptions,
} from './discovery/validate-adagents';

// ====== CORE CONVERSATION-AWARE CLIENTS ======
// New conversation-aware clients with input handler pattern
export {
  SingleAgentClient,
  WebhookDispatchError,
  createSingleAgentClient,
  UnsupportedFeatureError,
} from './core/SingleAgentClient';
export type {
  ClientProductPropertyPolicy,
  SingleAgentClientConfig,
  VerifyAndParseWebhookOptions,
  WebhookParseErrorCode,
  WebhookParseFailure,
  WebhookParseResult,
  WebhookParseSuccess,
} from './core/SingleAgentClient';
export {
  AgentClient,
  type TaskResponseTypeMap,
  type AdcpTaskName,
  type InProcessAgentClientConfig,
} from './core/AgentClient';
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
export { match, attachMatch } from './core/match';
export type { MatchHandlers, PartialMatchHandlers } from './core/match';
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
  WebhookToolPredicate,
  WebhookUrlTemplate,
  TaskResult,
  TaskResultCompleted,
  TaskResultIntermediate,
  TaskResultFailure,
  TaskResultMetadata,
  TaskState,
  TaskStatus,
  ConversationConfig,
  AdcpErrorInfo,
  AdcpValidationIssue,
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

// ====== GOVERNANCE PLAN HELPERS ======
// Invariants the schema encodes via if/then / oneOf that generated types
// typically drop: budget reallocation autonomy and regulated-vertical
// human review under GDPR Art 22 / EU AI Act Annex III.
export {
  buildHumanReviewPlan,
  buildHumanOverride,
  validateGovernancePlan,
  REGULATED_HUMAN_REVIEW_CATEGORIES,
  ANNEX_III_POLICY_IDS,
} from './governance';

// ====== NETWORKING / SSRF GUARDS ======
// Public so adopters can converge on the SDK's DNS-pinning and address
// classification behavior instead of copying partial guards. Use
// `ssrfSafeFetch` as the security boundary; address classifiers are advisory
// helpers and do not protect raw fetches from DNS rebinding.
export {
  ssrfSafeFetch,
  decodeBodyAsJsonOrText,
  SSRF_TRANSIENT_CODES,
  SsrfRefusedError,
  isPrivateIp,
  isAlwaysBlocked,
  isLikelyPrivateUrl,
  type SsrfRefusedCode,
  type SsrfFetchOptions,
  type SsrfFetchResult,
} from './net';

// ====== CANONICAL REFERENCE RESOLUTION ======
// Safe, structured resolver for AdCP 3.1 `format_schema` and
// `platform_extensions` URI+SHA-256 references.
export {
  createCanonicalReferenceCache,
  createCanonicalReferenceResolver,
  canonicalReferenceCacheKey,
  resolveCanonicalReference,
  resolveFormatSchemaReference,
  resolvePlatformExtensionsReference,
  type CanonicalReference,
  type CanonicalReferenceCache,
  type CanonicalReferenceError,
  type CanonicalReferenceErrorCode,
  type CanonicalReferenceFailureResult,
  type CanonicalReferenceKind,
  type CanonicalReferenceResolveOptions,
  type CanonicalReferenceResolvedResult,
  type CanonicalReferenceResolver,
  type CanonicalReferenceResolverOptions,
  type CanonicalReferenceResult,
  type CanonicalReferenceStatus,
  type ExternalRefDigestMap,
  type FormatSchemaReferenceResolvedResult,
  type FormatSchemaReferenceResult,
  type PlatformExtensionsReferenceResult,
} from './canonical-references';
export type {
  BuildHumanReviewPlanInput,
  BuildHumanOverrideInput,
  DataSubjectContestation,
  GovernancePlan,
  GovernanceValidationIssue,
  HumanOverride,
  PlanBudget,
  ReallocationAutonomy,
} from './governance';

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

// ====== WHOLESALE FEED WEBHOOKS ======
export {
  normalizeWholesaleFeedWebhookNotification,
  parseWholesaleFeedWebhookNotification,
  WholesaleFeedWebhookNotificationError,
} from './wholesale-feed-sync/webhook-notification';
export type {
  NormalizedWholesaleFeedWebhookNotification,
  WholesaleFeedWebhookAffectedEntityType,
  WholesaleFeedWebhookCacheScope,
  WholesaleFeedWebhookNotificationErrorCode,
  WholesaleFeedWebhookNotificationErrorDetails,
  WholesaleFeedWebhookNotificationType,
} from './wholesale-feed-sync/webhook-notification';

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
  ProtocolFeatureUnsupportedError,
  SDK_ERROR_TO_PROTOCOL_ERROR_CODE,
  VersionUnsupportedError,
  IdempotencyConflictError,
  IdempotencyExpiredError,
  ResponseTooLargeError,
  ActionNotAllowedError,
  adcpErrorToTypedError,
  getClientPreflightAdcpError,
  isADCPError,
  isErrorOfType,
  extractErrorInfo,
  is401Error,
  mapSdkErrorCodeToProtocolErrorCode,
} from './errors';
export type {
  OAuthMetadataInfo,
  ClientPreflightAdcpErrorInfo,
  ClientPreflightAdcpErrorRecovery,
  FeatureUnsupportedErrorOptions,
  ProtocolFeatureUnsupportedErrorOptions,
  ActionNotAllowedErrorDetails,
  ActionNotAllowedReasonValue,
  ActionNotAllowedAttemptedAction,
  ActionNotAllowedAvailableAction,
  ActionNotAllowedRecovery,
} from './errors';

// ====== MEDIA BUY ACTIONS (AdCP 3.1 / RFC #4480) ======
// Wire-shape action types are generated; helper result/context types live in
// the media-buy helper module.
export type {
  ActionNotAllowedDetails,
  ActionNotAllowedReason,
  AvailableActionsResult,
  AvailableActionsSource,
  DecomposedUpdateMediaBuy,
  DecomposedUpdateMediaBuyMutation,
  LegacyCoarseAction,
  MediaBuyActionContext,
  MediaBuyActionMode,
  MediaBuyAvailableAction,
  MediaBuyMutationDirection,
  MediaBuyMutationScope,
  MediaBuyValidAction,
  ModeMismatchRecovery,
  PreflightAllowed,
  PreflightDenial,
  PreflightDenied,
  BuyerPropertyPolicy,
  NormalizedPolicyDomain,
  ProductPolicyProductLike,
  ProductPropertyPolicyDiagnostic,
  ProductPropertyPolicyDiagnosticCode,
  ProductPropertyPolicyDiagnosticSeverity,
  ProductPropertyPolicyMode,
  ProductPropertyPolicySelectorBehavior,
  ProductPropertyPolicyValidationResult,
  PreflightResult,
  ResolvedAction,
  SLAWindow,
  SlaWindow,
  ValidateProductsAgainstPropertyPolicyOptions,
  UpdateFieldEntry,
  UpdateMediaBuyRequestLike,
} from './media-buy';
export {
  ACTIONS_BY_FIELD,
  LEGACY_COARSE_ACTIONS,
  UPDATE_FIELDS_BY_ACTION,
  canAddPackages,
  canCancel,
  canDecreaseBudget,
  canExtendFlight,
  canIncreaseBudget,
  canPause,
  canReallocateBudget,
  canRemoveCreative,
  canRemovePackages,
  canReplaceCreative,
  canResume,
  canShortenFlight,
  canUpdateCreativeAssignments,
  canUpdateFlightDates,
  canUpdateFrequencyCaps,
  canUpdatePacing,
  canUpdateTargeting,
  decomposeUpdateMediaBuy,
  findAvailableAction,
  getActionForMutation,
  getAvailableActions,
  getRollupParent,
  ProductPropertyPolicyError,
  normalizeDomainForPropertyPolicy,
  preflightUpdateMediaBuy,
  recoveryForModeMismatch,
  validateProductsAgainstPropertyPolicy,
} from './media-buy';
export { InputRequiredError } from './core/TaskExecutor';

// ====== IDEMPOTENCY ======
export {
  generateIdempotencyKey,
  isMutatingTask,
  isValidIdempotencyKey,
  useIdempotencyKey,
  redactIdempotencyKey,
  IDEMPOTENCY_KEY_PATTERN,
  MUTATING_TASKS,
} from './utils/idempotency';
export type { IdempotencyCapabilities } from './utils/capabilities';
export type { MutatingRequestInput } from './utils/idempotency';
export { canonicalize, canonicalJsonSha256 } from './utils/jcs';
export { rollupOptimizationMetricsFromProducts } from './utils/capability-rollups';

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
// Platform implementors: use Request types to type incoming tool calls,
// Response types to shape your return values.
// Runtime Zod schemas live at `@adcp/sdk/schemas` to keep ordinary root
// imports from loading the generated schema declaration bundle.
export type {
  // Media Buy Domain
  GetProductsRequest,
  GetProductsResponse,
  ListCreativeFormatsRequest,
  ListCreativeFormatsResponse,
  CreateMediaBuyRequest,
  CreateMediaBuyResponse,
  CreateMediaBuySuccess,
  CreateMediaBuyError,
  CreateMediaBuySubmitted,
  UpdateMediaBuyRequest,
  UpdateMediaBuyResponse,
  UpdateMediaBuySuccess,
  UpdateMediaBuyError,
  SyncCreativesRequest,
  SyncCreativesResponse,
  SyncCreativesSuccess,
  SyncCreativesError,
  SyncCreativesSubmitted,
  SyncAudiencesRequest,
  SyncAudiencesResponse,
  SyncAudiencesSuccess,
  SyncAudiencesError,
  ListCreativesRequest,
  ListCreativesResponse,
  CreativeFilters,
  GetMediaBuyDeliveryRequest,
  GetMediaBuyDeliveryResponse,
  ProvidePerformanceFeedbackRequest,
  ProvidePerformanceFeedbackResponse,
  ProvidePerformanceFeedbackSuccess,
  ProvidePerformanceFeedbackError,
  // Signals Domain
  GetSignalsRequest,
  GetSignalsResponse,
  ActivateSignalRequest,
  ActivateSignalResponse,
  ActivateSignalSuccess,
  ActivateSignalError,
  CpmPricing,
  PercentOfMediaPricing,
  FlatFeePricing,
  PerUnitPricing,
  CustomPricing,
  VendorPricing,
  VendorPricingOption,
  // Pricing variants for products (publisher rate cards in get_products etc.)
  // PricingOption + CPAPricingOption are exported below near the other tool types.
  CPMPricingOption,
  VCPMPricingOption,
  CPCPricingOption,
  CPCVPricingOption,
  CPVPricingOption,
  CPPPricingOption,
  FlatRatePricingOption,
  TimeBasedPricingOption,
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
  UpdateContentStandardsSuccess,
  UpdateContentStandardsError,
  CalibrateContentRequest,
  CalibrateContentResponse,
  ValidateContentDeliveryRequest,
  ValidateContentDeliveryResponse,
  ContentStandards,
  Artifact,
  // Governance Domain - Campaign Governance
  SyncPlansRequest,
  SyncPlansResponse,
  SyncGovernanceRequest,
  SyncGovernanceResponse,
  SyncGovernanceSuccess,
  SyncGovernanceError,
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
  SyncEventSourcesSuccess,
  SyncEventSourcesError,
  LogEventRequest,
  LogEventResponse,
  LogEventSuccess,
  LogEventError,
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
  // 3.1.0-beta.2 renamed `OutcomeMeasurement` → `OutcomeMeasurementDeprecated`
  // to signal the surface is on the 4.0 removal track. Re-export under both
  // names so adopters' existing `import { OutcomeMeasurement }` keeps working.
  OutcomeMeasurementDeprecated,
  OutcomeMeasurementDeprecated as OutcomeMeasurement,
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
  CatalogFieldMapping,
  SyncCatalogsRequest,
  SyncCatalogsResponse,
  SyncCatalogsSuccess,
  SyncCatalogsError,
  // Format Assets
  Overlay,
  // Creative Agent Domain
  CreativeManifest,
  CreativeVariable,
  BuildCreativeRequest,
  BuildCreativeResponse,
  BuildCreativeSuccess,
  BuildCreativeMultiSuccess,
  BuildCreativeError,
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
  SyncAccountsSuccess,
  SyncAccountsError,
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
export type {
  AccountStatus,
  CreativeStatus,
  DelegationAuthority,
  CatalogAction,
  CatalogItemStatus,
  MediaBuyStatus,
  // CreativeBrief is its own top-level schema (creative-brief.json) — emitted
  // in core.generated, no longer transitively pulled into tools.generated now
  // that BriefAsset merges its allOf[$ref] base inline.
  CreativeBrief,
} from './types/core.generated';

// ====== WELL-KNOWN FILE TYPES ======
// brand.json / adagents.json shapes inferred from the canonical Zod schemas.
// Re-exported explicitly here (in addition to the transitive `export * from
// './types'` above) so the top-level public API contract is visible at the
// main barrel and not dependent on the sub-barrel's wildcard re-export.
// Source of truth: schemas/cache/{version}/{brand,adagents}.json — regenerate
// with `npm run generate-wellknown-schemas` when the spec bumps.
export type { BrandJson, AdagentsJson } from './types/wellknown-schemas.generated';
export { BrandJsonSchema, AdagentsJsonSchema } from './types/wellknown-schemas.generated';

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
  syncAccountsResponse,
  syncGovernanceResponse,
  reportUsageResponse,
  validActionsForStatus,
  MEDIA_BUY_TRANSITIONS,
  CREATIVE_ASSET_TRANSITIONS,
  isLegalMediaBuyTransition,
  isLegalCreativeTransition,
  assertMediaBuyTransition,
  assertCreativeTransition,
  getAccountMode,
  isSandboxOrMockAccount,
  assertSandboxAccount,
  taskToolResponse,
  registerAdcpTaskTool,
  createTaskCapableServer,
  InMemoryTaskStore,
  isTerminal,
  serve,
  UnknownHostError,
  hostname,
  resolveHost,
  verifyIntrospection,
  registerTestController,
  handleTestControllerRequest,
  TestControllerError,
  toMcpResponse,
  TOOL_INPUT_SHAPE,
  CONTROLLER_SCENARIOS,
  DISCOVERY_ARM_SCENARIOS,
  SEED_SCENARIOS,
  SESSION_ENTRY_CAP,
  enforceMapCap,
  createSeedFixtureCache,
  PostgresTaskStore,
  cleanupExpiredTasks,
  getMcpTasksMigration,
  MCP_TASKS_MIGRATION,
  ADCP_PRE_TRANSPORT,
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
  createIdempotencyStore,
  memoryBackend,
  pgBackend,
  getIdempotencyMigration,
  IDEMPOTENCY_MIGRATION,
  cleanupExpiredIdempotency,
  redisBackend,
  createLazyBackend,
  hashPayload,
  getServeRequestContext,
  ADCP_SERVE_REQUEST_CONTEXT,
  createA2AAdapter,
  A2AInvocationError,
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
  TestControllerStoreFactory,
  TestControllerStoreOrFactory,
  ControllerScenario,
  SeedScenario,
  SeedFixtureCache,
  SessionContext,
  OnInstructionsError,
  MaybePromise,
  AdcpServerConfig,
  AdcpToolMap,
  AdcpServerToolName,
  AdcpCapabilitiesConfig,
  AdcpCustomToolConfig,
  AdcpLogger,
  HandlerContext,
  MediaBuyHandlers,
  SignalsHandlers,
  CreativeHandlers,
  GovernanceHandlers,
  AccountHandlers,
  EventTrackingHandlers,
  SponsoredIntelligenceHandlers,
  SignedRequestsConfig,
  AdcpPreTransport,
  AdcpServer,
  AdcpServerTransport,
  AdcpTestRequest,
  AdcpTestToolsCallRequest,
  AdcpTestResponse,
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
  IdempotencyStore,
  IdempotencyStoreConfig,
  IdempotencyBackend,
  IdempotencyCacheEntry,
  IdempotencyCheckResult,
  MemoryBackendOptions,
  PgBackendOptions,
  RedisBackendOptions,
  RedisBackendClient,
  RedisLikeClient,
  LazyBackendFactory,
  LazyBackendOptions,
  A2AAdapter,
  A2AAdapterOptions,
  A2AAgentCardOverrides,
  A2AMountOptions,
  ExpressAppLike,
  AccountMode,
  RequireCacheScopeWhenProducts,
  ServerPayload,
  ListCreativeFormatsPayload,
  ListCreativeFormatsResponsePayload,
  ListCreativeFormatsServerPayload,
  SyncCreativesPayload,
  SyncCreativesSuccessPayload,
  SyncCreativesErrorPayload,
} from './server';

// ====== ERROR HANDLING & RETRY ======
export { isRetryable, getRetryDelay } from './utils/retry';
export { decideRetry, BuyerRetryPolicy } from './utils/buyer-retry-policy';
export type { RetryDecision, RetryContext, RetryDecisionOverride } from './utils/buyer-retry-policy';

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
export { extractVersionUnsupportedDetails } from './utils/error-extraction';
export type { VersionUnsupportedDetails } from './utils/error-extraction';

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

// get_products response cache-scope helpers
export {
  ensureGetProductsCacheScope,
  validateGetProductsCacheScope,
  type EnsureGetProductsCacheScopeOptions,
  type GetProductsCacheScope,
  type GetProductsResponseWithCacheScope,
  type GetProductsCacheScopeValidation,
} from './utils/get-products-cache-scope';

// ====== ENUM VALUE ARRAYS ======
// `${TypeName}Values` const arrays for every named string-literal union in
// the spec. Consumers can enumerate or validate against these without
// duplicating literal lists from the Zod unions.
export * from './types/enums.generated';

// `${ParentSchema}_${PropertyName}Values` const arrays for inline
// anonymous unions inside named schemas — e.g.
// `ImageAssetRequirements_FormatsValues`,
// `VideoAssetRequirements_ContainersValues`. Companion to enums.generated;
// see scripts/generate-inline-enum-arrays.ts for naming + scoping rules.
export * from './types/inline-enums.generated';

// PreviewCreativeRequestSchema is now a flat z.object() with request_type discriminant.
// The old variant exports (PreviewCreativeSingleRequestSchema, etc.) are no longer needed —
// use PreviewCreativeRequestSchema.shape directly with server.registerTool().

// ====== AUTHENTICATION ======
// Auth utilities for custom integrations
export { getAuthToken, createAdCPHeaders, createMCPAuthHeaders, createAuthenticatedFetch } from './auth';

// OAuth diagnostics utilities (see src/lib/auth/oauth/diagnostics.ts)
export {
  parseWWWAuthenticate,
  decodeAccessTokenClaims,
  validateTokenAudience,
  type WWWAuthenticateChallenge,
  type DecodedJWTHeader,
  type DecodedJWTClaims,
  type DecodedAccessToken,
  type TokenAudienceResult,
  InvalidTokenError,
  InsufficientScopeError,
} from './auth/oauth';

// End-to-end OAuth handshake diagnosis — powers `adcp diagnose-auth`
export {
  runAuthDiagnosis,
  AUTH_DIAGNOSIS_SCHEMA_VERSION,
  type DiagnoseOptions,
  type HttpCapture as DiagnosisHttpCapture,
  type DiagnosisStep,
  type Hypothesis as DiagnosisHypothesis,
  type HypothesisVerdict as DiagnosisHypothesisVerdict,
  type AuthDiagnosisReport,
} from './auth/oauth';

// Zero-config OAuth: actionable error + discovery + file storage + per-agent binding
export {
  NeedsAuthorizationError,
  discoverAuthorizationRequirements,
  createFileOAuthStorage,
  bindAgentStorage,
  getAgentStorage,
  unbindAgentStorage,
  type AuthorizationRequirements,
  type DiscoverAuthorizationOptions,
  type FileOAuthStorageOptions,
} from './auth/oauth';

// OAuth 2.0 client credentials (RFC 6749 §4.4) — machine-to-machine token
// exchange used by programmatic CC consumers and by the CLI's `--save-auth
// --oauth-token-url ...` flow. The library call path pre-refreshes before
// every request automatically when `AgentConfig.oauth_client_credentials`
// is set; these symbols are exposed for consumers that need explicit
// control (building custom AgentConfigs, testing, or implementing
// server-side `save_agent` endpoints like Addie's).
export {
  exchangeClientCredentials,
  ensureClientCredentialsTokens,
  ClientCredentialsExchangeError,
  MissingEnvSecretError,
  resolveSecret,
  isEnvSecretReference,
  toEnvSecretReference,
  extractEnvSecretName,
  type ExchangeClientCredentialsOptions,
  type EnsureClientCredentialsOptions,
  type AgentOAuthClientCredentials,
} from './auth/oauth';

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
  closeOAuthConnections,
  bundleSupportsAdcpVersionField,
} from './protocols';
export { toReleasePrecisionWire, validateAdcpVersionWire } from './validation/schema-loader';
export type { CallToolOptions, TransportOptions } from './protocols';

// ====== WIRE VERSION HELPERS (NAMESPACE) ======
// Grouped re-exports of the three AdCP `adcp_version` envelope helpers
// (spec PR adcontextprotocol/adcp#3493). Prefer this surface over the
// individual top-level exports — the namespace stays stable as helpers
// are added (a fourth helper drops in here without churning the barrel).
// The top-level exports are kept for back-compat and aren't deprecated.
import { bundleSupportsAdcpVersionField as _isSupported } from './protocols';
import { toReleasePrecisionWire as _normalize, validateAdcpVersionWire as _validate } from './validation/schema-loader';
export const wireVersion = {
  isSupported: _isSupported,
  normalize: _normalize,
  validate: _validate,
} as const;

// ====== RESPONSE UTILITIES ======
// Public utilities for working with AdCP responses
export {
  getStandardFormats,
  unwrapProtocolResponse,
  isAdcpError,
  isAdcpSuccess,
  isTerminalAdcpError,
  hasAdvisorySuccessPayload,
  getAuthoritativeMediaBuyStatus,
  isMediaBuyStatus,
} from './utils';
export { injectLegacyEnvelopeStatus } from './utils/envelope-status-compat';
export { extractResult, type ToolCallResultLike } from './utils';
export { REQUEST_TIMEOUT, MAX_CONCURRENT, STANDARD_FORMATS } from './utils';
export {
  batchPreviewProducts,
  batchPreviewFormats,
  clearPreviewCache,
  type PreviewResult,
  type BatchPreviewOptions,
  type PreviewCacheBackend,
  type PreviewCacheEntry,
} from './utils';
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

// ====== CREATIVE ASSET BUILDERS ======
// Typed factories that inject the `asset_type` discriminator.
// `imageAsset({ url, width, height })` returns a valid `ImageAsset`
// without repeating `asset_type: 'image'` at every call site.
// Prefer the named exports; use `Asset.image({...})` when constructing
// several asset types together (assets-by-role manifests).
export {
  Asset,
  imageAsset,
  videoAsset,
  audioAsset,
  textAsset,
  urlAsset,
  htmlAsset,
  javascriptAsset,
  cssAsset,
  markdownAsset,
  webhookAsset,
} from './utils/asset-builders';

// ====== FORMAT ASSET SLOT BUILDERS ======
// Typed factories for the slot definitions inside `Format.assets[]` — what a
// seller/publisher declares it accepts. Each builder injects the `item_type`
// and `asset_type` discriminators, and the `requirements` object is strictly
// typed per asset_type: misnamed fields (`file_types` vs `formats`) and wrong
// units (`min_duration_seconds` vs `min_duration_ms`) fail type-check.
// Use `repeatableGroup({...})` (or `FormatAsset.group(...)`) to wrap assets
// that repeat — that's the correct home for `min_count` / `max_count`.
export {
  FormatAsset,
  imageAssetSlot,
  videoAssetSlot,
  audioAssetSlot,
  textAssetSlot,
  markdownAssetSlot,
  htmlAssetSlot,
  cssAssetSlot,
  javascriptAssetSlot,
  vastAssetSlot,
  daastAssetSlot,
  urlAssetSlot,
  webhookAssetSlot,
  briefAssetSlot,
  catalogAssetSlot,
  repeatableGroup,
  imageGroupAsset,
  videoGroupAsset,
  audioGroupAsset,
  textGroupAsset,
  markdownGroupAsset,
  htmlGroupAsset,
  cssGroupAsset,
  javascriptGroupAsset,
  vastGroupAsset,
  daastGroupAsset,
  urlGroupAsset,
  webhookGroupAsset,
} from './utils/format-asset-slot-builders';

// ====== PREVIEW RENDER BUILDERS ======
// Typed factories that inject the `output_format` discriminator on
// `PreviewRender` objects. `urlRender({ render_id, preview_url, role })`
// returns a valid url-variant render without repeating
// `output_format: 'url'` at every call site. Matrix runs consistently
// saw this drift: Claude emitted renders that omitted the discriminator
// or its required sibling field.
export { Render, urlRender, htmlRender, bothRender } from './utils/render-builders';

// ====== FORMAT RENDER BUILDERS ======
// Typed factories for `Format.renders[]` entries on format declarations.
// The item schema's `oneOf` forces a render to satisfy exactly one branch —
// either `dimensions` (display/video) OR `parameters_from_format_id: true`
// (audio, template formats). A render with only `{ role }` fails validation.
// Audio specifically cannot use `{ role, duration_seconds }` — duration is
// not a recognized `renders[]` field and wouldn't satisfy the oneOf anyway.
// Use `parameterizedRender({ role })` (or the alias `templateRender`) so
// format_id parameters carry duration.
//
// `FormatRender` below is the grouped namespace (value export). The v3
// structural interface by the same name is re-exported from
// `utils/format-renders` further down — TypeScript keeps type and value
// namespaces separate, so both are available under the single import.
export {
  FormatRender,
  displayRender,
  parameterizedRender,
  templateRender,
  type DimensionsRender,
  type ParameterizedRender,
  type RenderItem,
} from './utils/format-render-builders';

// ====== CANONICAL CREATIVE FORMAT MIGRATION HELPERS ======
// Author `Product.format_options[]`, v1 `format_id` references, and product
// cards from one obvious namespace while migrating away from local Format.type
// and product_card.format_id conventions.
export {
  CanonicalFormat,
  type CanonicalFormatDeclaration,
  type CanonicalFormatDeclarationFields,
  type CanonicalFormatKind,
  type CanonicalFormatParams,
  type FormatReferenceInput,
  type ProductCardDetailedFields,
  type ProductCardFields,
} from './v2/projection';

export {
  augmentProductWithFormatOptions,
  withFormatOptions,
  packageRefsForCapabilities,
  legacyFormatIdsFromOptions,
  tryLegacyFormatIdsFromOptions,
  legacyFormatIdsForCapability,
  CapabilityIdsLookupError,
  type CapabilityIdsLookupErrorCode,
  type PackageFormatRefs,
  type ProjectionDiagnostic,
  type V1FormatId,
  type V1Product,
  type V2Product,
} from './v2/projection';

// ====== ACTIVATION KEY BUILDERS ======
// Typed factories that inject the `type` discriminator on `ActivationKey`.
// SHAPE-GOTCHAS §1 — `key`/`value` flatten on the activation key itself.
export { activationKey, segmentIdActivationKey, keyValueActivationKey } from './utils/activation-key-builders';

// ====== SIGNAL ID BUILDERS AND ACCESSORS ======
// Typed factories that inject the `source` discriminator on `SignalID`.
// Used in `signal_ids` filter arrays and as the `signal_id` provenance
// field on every `Signal` returned by `get_signals`. SHAPE-GOTCHAS §2.
// To read fields from a received `SignalID`, use `getSignalId` (segment id)
// and `getSignalIssuer` (data_provider_domain or agent_url).
export { signalId, catalogSignalId, agentSignalId, getSignalId, getSignalIssuer } from './utils/signal-id-builders';
export {
  buildActivateSignalRequest,
  getSignalActivationId,
  getSignalPricingOptionIds,
  normalizeDiscoveredSignal,
} from './utils/signal-discovery-helpers';
export type {
  BuildActivateSignalRequestOptions,
  DiscoveredSignal,
  NormalizedDiscoveredSignal,
} from './utils/signal-discovery-helpers';

// ====== BUILD CREATIVE RETURN BUILDERS ======
// Typed factories for the four return shapes accepted by the framework
// from `build_creative` handlers. `.single` / `.multi` emit bare manifests
// the framework auto-wraps; `.singleEnveloped` / `.multiEnveloped` emit
// the shaped envelope when the handler needs to attach `sandbox` /
// `expires_at` / `preview`. SHAPE-GOTCHAS §5.
export {
  buildCreativeReturn,
  singleBuildCreativeReturn,
  multiBuildCreativeReturn,
  singleEnvelopedBuildCreativeReturn,
  multiEnvelopedBuildCreativeReturn,
} from './utils/build-creative-return-builders';

// ====== PREVIEW CREATIVE BUILDERS ======
// Typed factories that inject the `response_type` discriminator on
// `PreviewCreativeResponse`. Three-way oneOf — `single | batch | variant`.
// Pair with `urlRender` / `htmlRender` / `bothRender` for the per-render
// `output_format`. SHAPE-GOTCHAS §4.
export {
  previewCreative,
  singlePreviewCreativeResponse,
  batchPreviewCreativeResponse,
  variantPreviewCreativeResponse,
} from './utils/preview-creative-builders';

// ====== MEDIA BUY DELIVERY NOTIFICATION BUILDERS ======
// Typed factories that inject the `notification_type` discriminator on
// `GetMediaBuyDeliveryResponse` for webhook deliveries. Five variants:
// `scheduled` / `final` / `delayed` / `adjusted` / `window_update`.
export {
  mediaBuyDeliveryNotification,
  scheduledMediaBuyDeliveryNotification,
  finalMediaBuyDeliveryNotification,
  delayedMediaBuyDeliveryNotification,
  adjustedMediaBuyDeliveryNotification,
  windowUpdateMediaBuyDeliveryNotification,
} from './utils/media-buy-delivery-notification-builders';

// ====== V3.0 COMPATIBILITY UTILITIES ======
// Capabilities detection, version negotiation, and v3 enforcement.
// See also:
//   - `VersionUnsupportedError` in errors — thrown by requireV3()/requireV3ForMutations
//   - `SyncCreativesItemSchema` in validation — per-item sync_creatives validator
//   - `ADCP_MAJOR_VERSION` / `COMPATIBLE_ADCP_VERSIONS` in version information
//   - `SingleAgentClient#requireV3()` / `AgentClient#requireV3()` — runtime gate
export {
  buildSyntheticCapabilities,
  buildSyntheticV3Capabilities,
  parseCapabilitiesResponse,
  supportsV3,
  supportsProtocol,
  supportsPropertyListFiltering,
  supportsContentStandards,
  supportsSyncCreatives,
  requiresOperatorAuth,
  requiresAccountForProducts,
  supportsSandbox,
  supportsExperimentalFeature,
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

// Buyer-side creative delivery helpers
export { inlineCreativesForPackages } from './utils/creative-delivery';
export type {
  InlineCreativeAssignment,
  InlineCreativePackage,
  InlineCreativePackagePatch,
  InlineCreativesForPackagesOptions,
} from './utils/creative-delivery';

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
// FormatRender (the v3 structural interface) was renamed to FormatRenderEntry
// so the `FormatRender` name at the barrel becomes the factory namespace
// exported from `./utils/format-render-builders` above. The deprecated type
// alias `FormatRender = FormatRenderEntry` still lives in `utils/format-renders`
// for callers importing the sub-module directly; it's not re-exported here.
export type { FormatRenderEntry, RenderDimensions } from './utils/format-renders';

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
  parseAdcpMajorVersion,
  ADCP_VERSION,
  ADCP_MAJOR_VERSION,
  LIBRARY_VERSION,
  COMPATIBLE_ADCP_VERSIONS,
  VERSION_INFO,
} from './version';
export type { AdcpVersion } from './version';
export { resolveAdcpVersion } from './utils/adcp-version-config';

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
  // Implicit Account Store (resolution: 'implicit') — Shape A reference adapter
  InMemoryImplicitAccountStore,
  defaultImplicitKeyFn,
  type ImplicitAccountStoreOptions,
  // OAuth pass-through resolver — Shape B accounts.resolve factory
  createOAuthPassthroughResolver,
  type OAuthPassthroughResolverOptions,
  // Roster-backed AccountStore — Shape C factory for publisher-curated explicit platforms
  createRosterAccountStore,
  type RosterAccountStoreOptions,
  // Derived AccountStore — Shape D factory for single-tenant `resolution: 'derived'` agents
  createDerivedAccountStore,
  type DerivedAccountStoreOptions,
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

// ====== SUBSTITUTION OBSERVER / ENCODER ======
// Primitives backing the `substitution-observer-runner` test-kit contract.
// Runners (conformance graders) import the observer side; sales/retail-
// media agents implementing the #2620 catalog-item macro encoding rule
// import `SubstitutionEncoder`. Re-exported here for discoverability;
// the full surface is also available via `@adcp/sdk/substitution`.
export {
  SubstitutionObserver,
  SubstitutionEncoder,
  PreviewFetchError,
  MacroInRawValueError,
  CATALOG_MACRO_VECTORS,
  getCatalogMacroVector,
  extractTrackerUrls,
  matchBindings,
  assertRfc3986Safe,
  assertUnreservedOnly,
  assertNoNestedExpansion,
  assertSchemePreserved,
  DEFAULT_MACRO_PROHIBITED_PATTERN,
  enforceSsrfPolicy,
  enforceSsrfPolicyResolved,
  DEFAULT_SSRF_POLICY,
  encodeUnreserved,
  equalUnderHexCasePolicy,
  isUnreservedOnly,
  divergenceOffset,
} from './substitution';
export type {
  ObserverFetchOptions,
  ObserverDispatcher,
  CatalogMacroVectorName,
  AssertionOptions as SubstitutionAssertionOptions,
  AssertionResult as SubstitutionAssertionResult,
  BindingMatch,
  CatalogBinding,
  CatalogMacroVector,
  PolicyResult as SubstitutionPolicyResult,
  SsrfPolicy,
  TrackerUrlRecord,
} from './substitution';

// ====== TEST HELPERS ======
// Re-export test helpers for convenience (also available via @adcp/sdk/testing)
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
  expectControllerError,
  expectControllerSuccess,
  RateLimitTripObserver,
  RATE_LIMIT_TRIP_CONTRACT,
  RATE_LIMIT_TRIP_DEFAULT_REPLAY_MAX_WAIT_SECONDS,
  RATE_LIMIT_TRIP_MAX_ATTEMPTS_MAX,
  RATE_LIMIT_TRIP_MAX_ATTEMPTS_MIN,
  validateRateLimitTripSpec,
} from './testing/index';
export type {
  ControllerErrorWithDetail,
  TestClient,
  RateLimitTripSpec,
  RateLimitTripClient,
  RateLimitTripFailureCode,
  RateLimitTripObservation,
  RateLimitTripObserverOptions,
  RateLimitTripResponseSnapshot,
  RateLimitTripStructuredResult,
  RateLimitTripTaskOptions,
} from './testing/index';
