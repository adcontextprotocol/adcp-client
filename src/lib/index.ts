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
export {
  ADCPMultiAgentClient as ADCPClient,
  AgentCollection as NewAgentCollection,
} from './core/ADCPMultiAgentClient';
export type { ADCPClientConfig } from './core/ADCPClient';

/**
 * @deprecated Use ADCPClient instead. ADCPMultiAgentClient will be removed in v4.0.
 * @see ADCPClient
 */
export { ADCPMultiAgentClient } from './core/ADCPMultiAgentClient';
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
export * from './types';

// ====== TOOL TYPES ======
// All ADCP task request/response types
export type {
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
  GetSignalsRequest,
  GetSignalsResponse,
  ActivateSignalRequest,
  ActivateSignalResponse,
  // Core data structures
  Format,
  Product,
  PackageRequest,
  CreativeAsset,
  CreativePolicy,
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

// ====== LEGACY AGENT CLASSES ======
// Keep existing generated agent classes for backward compatibility
export { Agent, AgentCollection } from './agents/index.generated';
