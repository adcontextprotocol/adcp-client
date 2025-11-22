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
// New conversation-aware clients with input handler pattern
export { SingleAgentClient, createSingleAgentClient } from './core/SingleAgentClient';
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

// ====== ZOD SCHEMAS (for runtime validation) ======
// Re-export all Zod schemas for user validation needs
export * from './types/schemas.generated';

// ====== AUTHENTICATION ======
// Auth utilities for custom integrations
export { getAuthToken, createAdCPHeaders, createMCPAuthHeaders, createAuthenticatedFetch } from './auth';

// ====== VALIDATION ======
// Schema validation for requests/responses
export { validateAgentUrl, validateAdCPResponse, getExpectedSchema, handleAdCPResponse } from './validation';

// ====== RESPONSE UTILITIES ======
// Public utilities for working with AdCP responses
export { getStandardFormats, unwrapProtocolResponse, isAdcpError, isAdcpSuccess } from './utils';
export { REQUEST_TIMEOUT, MAX_CONCURRENT, STANDARD_FORMATS } from './utils';

// ====== AGENT CLASSES ======
// Primary agent interface - returns raw AdCP responses
export { Agent, AgentCollection } from './agents/index.generated';

// ====== BACKWARD COMPATIBILITY & ENVIRONMENT LOADING ======

import type { AgentConfig } from './types';
import { ADCPMultiAgentClient } from './core/ADCPMultiAgentClient';

/**
 * Legacy AdCPClient for backward compatibility - now redirects to ADCPMultiAgentClient
 * @deprecated Use ADCPMultiAgentClient instead for new code
 */
export class AdCPClient {
  private multiClient: ADCPMultiAgentClient;

  constructor(agents?: AgentConfig[], config?: any) {
    this.multiClient = new ADCPMultiAgentClient(agents || [], config);
  }

  agent(id: string) {
    return this.multiClient.agent(id);
  }
  agents(ids: string[]) {
    return this.multiClient.agents(ids);
  }
  allAgents() {
    return this.multiClient.allAgents();
  }
  addAgent(agent: AgentConfig) {
    this.multiClient.addAgent(agent);
  }
  getAgents() {
    return this.multiClient.getAgentConfigs();
  }
  getAgentConfigs() {
    return this.multiClient.getAgentConfigs();
  } // Alias for compatibility
  get agentCount() {
    return this.multiClient.agentCount;
  }
  get agentIds() {
    return this.multiClient.getAgentIds();
  }

  getStandardFormats() {
    const { getStandardFormats } = require('./utils');
    return getStandardFormats();
  }

  static fromEnv(): AdCPClient {
    const multiClient = ADCPMultiAgentClient.fromEnv();
    const client = new AdCPClient();
    client.multiClient = multiClient;
    return client;
  }
}

// Legacy configuration manager maintained for backward compatibility
// The enhanced ConfigurationManager is exported above

/**
 * Legacy createAdCPClient function for backward compatibility
 * @deprecated Use new ADCPMultiAgentClient constructor instead
 */
export function createAdCPClient(agents?: AgentConfig[]): AdCPClient {
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
