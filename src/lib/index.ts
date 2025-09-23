// AdCP Client Library - Main Exports
// A comprehensive type-safe client library for the AdContext Protocol

// ====== CORE CONVERSATION-AWARE CLIENTS ======
// New conversation-aware clients with input handler pattern
export { ADCPClient, createADCPClient } from './core/ADCPClient';
export type { ADCPClientConfig } from './core/ADCPClient';
export { AgentClient, type TaskResponseTypeMap, type AdcpTaskName } from './core/AgentClient';
export { ADCPMultiAgentClient, AgentCollection as NewAgentCollection, createADCPMultiAgentClient } from './core/ADCPMultiAgentClient';
export { ConfigurationManager } from './core/ConfigurationManager';
export { TaskExecutor } from './core/TaskExecutor';
export { ProtocolResponseParser, responseParser, ADCP_STATUS, type ADCPStatus } from './core/ProtocolResponseParser';
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
  ConversationConfig
} from './core/ConversationTypes';

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
  StorageMiddleware
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
  extractErrorInfo
} from './errors';
export { InputRequiredError } from './core/TaskExecutor';

// ====== CORE TYPES ======
export * from './types';

// ====== TOOL TYPES ======
// All ADCP task request/response types
export type {
  GetProductsRequest, GetProductsResponse,
  ListCreativeFormatsRequest, ListCreativeFormatsResponse,
  CreateMediaBuyRequest, CreateMediaBuyResponse,
  UpdateMediaBuyRequest, UpdateMediaBuyResponse,
  SyncCreativesRequest, SyncCreativesResponse,
  ListCreativesRequest, ListCreativesResponse,
  GetMediaBuyDeliveryRequest, GetMediaBuyDeliveryResponse,
  ListAuthorizedPropertiesRequest, ListAuthorizedPropertiesResponse,
  ProvidePerformanceFeedbackRequest, ProvidePerformanceFeedbackResponse,
  GetSignalsRequest, GetSignalsResponse,
  ActivateSignalRequest, ActivateSignalResponse
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

// ====== LEGACY AGENT CLASSES ======
// Keep existing generated agent classes for backward compatibility
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

  constructor(agents?: AgentConfig[]) {
    this.multiClient = new ADCPMultiAgentClient(agents || []);
  }

  agent(id: string) { return this.multiClient.agent(id); }
  agents(ids: string[]) { return this.multiClient.agents(ids); }
  allAgents() { return this.multiClient.allAgents(); }
  addAgent(agent: AgentConfig) { this.multiClient.addAgent(agent); }
  getAgents() { return this.multiClient.getAgentConfigs(); }
  get agentCount() { return this.multiClient.agentCount; }
  get agentIds() { return this.multiClient.getAgentIds(); }
  
  getStandardFormats() {
    const { getStandardFormats } = require('./utils');
    return getStandardFormats();
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