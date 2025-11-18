// AdCP Client Library - Main Exports
// A comprehensive type-safe client library for the AdContext Protocol

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
// Primary client for all use cases - single or multi-agent
export { ADCPMultiAgentClient as AdCPClient, AgentCollection as NewAgentCollection } from './core/ADCPMultiAgentClient';
export type { SingleAgentClientConfig as AdCPClientConfig } from './core/SingleAgentClient';

/**
 * @deprecated Use AdCPClient instead. ADCPMultiAgentClient will be removed in v4.0.
 * @see AdCPClient
 */
export { ADCPMultiAgentClient } from './core/ADCPMultiAgentClient';

// NOTE: SingleAgentClient is intentionally NOT exported - it's an internal implementation detail.
// All users should use AdCPClient (alias for ADCPMultiAgentClient) which supports both
// single-agent operations via agent(id) and multi-agent operations via agents([ids]).
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
  WebhookPayload,
  Activity,
  NotificationMetadata,
  MediaBuyDeliveryNotification,
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
  isADCPError,
  isErrorOfType,
  extractErrorInfo,
} from './errors';
export { InputRequiredError } from './core/TaskExecutor';

// ====== CORE TYPES ======
// Curated exports from types - not all internal types
export type {
  // Agent configuration
  AgentConfig,
  // Testing types
  TestResult,
  TestRequest,
  ApiResponse,
  // Data models (user-facing from adcp.ts, not generated duplicates)
  CreativeAsset,  // User-facing type with practical fields
  AdvertisingProduct,
  MediaBuy,
  Targeting,
  GeographicTargeting,
  DemographicTargeting,
  BehavioralTargeting,
  ContextualTargeting,
  DeviceTargeting,
  FrequencyCap,
  DeliverySchedule,
  DayParting,
  // NOTE: Property, PropertyIdentifier, PropertyType exported above from discovery/types
  // NOTE: CreativeFormat exported above from core/CreativeAgentClient
} from './types';

// ====== ZOD SCHEMAS ======
// Re-export curated Zod schemas for runtime validation (curated in types/index.ts)
export {
  // Media Buy Tool Schemas
  GetProductsRequestSchema,
  GetProductsResponseSchema,
  ListCreativeFormatsRequestSchema,
  ListCreativeFormatsResponseSchema,
  CreateMediaBuyRequestSchema,
  CreateMediaBuyResponseSchema,
  UpdateMediaBuyRequestSchema,
  UpdateMediaBuyResponseSchema,
  SyncCreativesRequestSchema,
  SyncCreativesResponseSchema,
  ListCreativesRequestSchema,
  ListCreativesResponseSchema,
  GetMediaBuyDeliveryRequestSchema,
  GetMediaBuyDeliveryResponseSchema,
  ListAuthorizedPropertiesRequestSchema,
  ListAuthorizedPropertiesResponseSchema,
  ProvidePerformanceFeedbackRequestSchema,
  ProvidePerformanceFeedbackResponseSchema,
  // Creative Tool Schemas
  BuildCreativeRequestSchema,
  BuildCreativeResponseSchema,
  PreviewCreativeRequestSchema,
  PreviewCreativeResponseSchema,
  // Signals Tool Schemas
  GetSignalsRequestSchema,
  GetSignalsResponseSchema,
  ActivateSignalRequestSchema,
  ActivateSignalResponseSchema,
  // Core data model schemas (frequently validated)
  FormatIDSchema,
  ProductSchema,
  PackageRequestSchema,
  CreativeAssetSchema,
} from './types';

// ====== TOOL TYPES ======
// All ADCP task request/response types from generated schemas
export type {
  // Media Buy Tools
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
  ListAuthorizedPropertiesRequest,
  ListAuthorizedPropertiesResponse,
  ProvidePerformanceFeedbackRequest,
  ProvidePerformanceFeedbackResponse,
  // Creative Tools
  BuildCreativeRequest,
  BuildCreativeResponse,
  PreviewCreativeRequest,
  PreviewCreativeResponse,
  // Signals Tools
  GetSignalsRequest,
  GetSignalsResponse,
  ActivateSignalRequest,
  ActivateSignalResponse,
  // Core data structures from generated schemas
  FormatID,  // Core identifier type
  Format,
  Product,
  PackageRequest,
  CreativePolicy,
  // NOTE: CreativeAsset is exported from types/adcp.ts to avoid conflicts
  // The generated CreativeAsset from tools.generated.ts is for internal use only
} from './types/tools.generated';

// ====== PROTOCOL CLIENTS ======
export * from './protocols';

// ====== AUTHENTICATION ======
export * from './auth';

// ====== VALIDATION ======
export * from './validation';

// ====== UTILITIES ======
export * from './utils';
export { getStandardFormats } from './utils';
export { detectProtocol, detectProtocolWithTimeout } from './utils/protocol-detection';

// ====== TEST HELPERS ======
export * from './testing';

// ====== LEGACY AGENT CLASSES ======
// Keep existing generated agent classes for backward compatibility
export { Agent, AgentCollection } from './agents/index.generated';
