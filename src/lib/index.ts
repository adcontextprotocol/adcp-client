// AdCP Client Library - Main Exports
// A comprehensive type-safe client library for the AdContext Protocol

// ====== REGISTRY LOOKUPS ======
export { RegistryClient } from './registry';
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
} from './registry';

// ====== PROPERTY DISCOVERY (AdCP v2.2.0) ======
export {
  PropertyIndex,
  getPropertyIndex,
  resetPropertyIndex,
  type PropertyMatch,
  type AgentAuthorization,
} from './discovery/property-index';
export { PropertyCrawler, type AgentInfo, type CrawlResult } from './discovery/property-crawler';
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
  type CreativeFormatType,
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
  TaskState,
  TaskStatus,
  ConversationConfig,
} from './core/ConversationTypes';

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
  isADCPError,
  isErrorOfType,
  extractErrorInfo,
  is401Error,
} from './errors';
export type { OAuthMetadataInfo } from './errors';
export { InputRequiredError } from './core/TaskExecutor';

// ====== CORE TYPES ======
export * from './types';

// ====== TOOL TYPES ======
// All ADCP task request/response types
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
  GetMediaBuyDeliveryRequest,
  GetMediaBuyDeliveryResponse,
  ProvidePerformanceFeedbackRequest,
  ProvidePerformanceFeedbackResponse,
  // Signals Domain
  GetSignalsRequest,
  GetSignalsResponse,
  ActivateSignalRequest,
  ActivateSignalResponse,
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
  // Core data structures
  Format,
  Product,
  Proposal,
  ProductAllocation,
  PackageRequest,
  CreativeAsset,
  CreativePolicy,
  BrandReference,
  BrandID,
  CPAPricingOption,
  EventType,
  ActionSource,
  // Catalog Domain
  Catalog,
  CatalogType,
  FeedFormat,
  UpdateFrequency,
  ContentIDType,
  CatalogAction,
  CatalogItemStatus,
  SyncCatalogsRequest,
  SyncCatalogsResponse,
  SyncCatalogsSuccess,
  SyncCatalogsError,
  // Creative Delivery Domain
  GetCreativeDeliveryRequest,
  GetCreativeDeliveryResponse,
  // Account Domain
  Account,
  ListAccountsRequest,
  ListAccountsResponse,
  SyncAccountsRequest,
  SyncAccountsResponse,
  // Pagination
  PaginationRequest,
  PaginationResponse,
} from './types/tools.generated';

// ====== BACKWARDS COMPATIBILITY ======
// Deprecated types from past protocol migrations
export type {
  BrandManifest,
  BrandManifestReference,
  AssetContentType,
  PromotedProducts,
  PromotedOfferings,
} from './types/compat';
export { brandManifestToBrandReference, promotedProductsToCatalog } from './types/compat';

// ====== ZOD SCHEMAS (for runtime validation) ======
// Re-export all Zod schemas for user validation needs
export * from './types/schemas.generated';

// ====== AUTHENTICATION ======
// Auth utilities for custom integrations
export { getAuthToken, createAdCPHeaders, createMCPAuthHeaders, createAuthenticatedFetch } from './auth';

// ====== VALIDATION ======
// Schema validation for requests/responses
export { validateAgentUrl, validateAdCPResponse, getExpectedSchema, handleAdCPResponse } from './validation';

// ====== PROTOCOL CLIENTS ======
// Low-level protocol clients for MCP and A2A (primarily for testing)
export { ProtocolClient, callMCPTool, callA2ATool, createMCPClient, createA2AClient } from './protocols';

// ====== RESPONSE UTILITIES ======
// Public utilities for working with AdCP responses
export { getStandardFormats, unwrapProtocolResponse, isAdcpError, isAdcpSuccess } from './utils';
export { REQUEST_TIMEOUT, MAX_CONCURRENT, STANDARD_FORMATS } from './utils';
export { detectProtocol, detectProtocolWithTimeout } from './utils';

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
  MEDIA_BUY_TOOLS,
  SIGNALS_TOOLS,
  GOVERNANCE_TOOLS,
  CREATIVE_TOOLS,
  EVENT_TRACKING_TOOLS,
  ACCOUNT_TOOLS,
  PROTOCOL_TOOLS,
} from './utils/capabilities';
export type {
  AdcpCapabilities,
  AdcpMajorVersion,
  AdcpProtocol,
  MediaBuyFeatures,
  ToolInfo,
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
  LIBRARY_VERSION,
  COMPATIBLE_ADCP_VERSIONS,
  VERSION_INFO,
} from './version';

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
} from './testing/index';
