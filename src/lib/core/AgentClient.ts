// Per-agent client wrapper with conversation context preservation

import type { AgentConfig } from '../types';
import { ADCPClient, type ADCPClientConfig } from './ADCPClient';
import type {
  InputHandler,
  TaskOptions,
  TaskResult,
  Message
} from './ConversationTypes';
import type {
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
  ActivateSignalResponse
} from '../types/tools.generated';

/**
 * Per-agent client that maintains conversation context across calls
 * 
 * This wrapper provides a persistent conversation context for a single agent,
 * making it easy to have multi-turn conversations and maintain state.
 */
export class AgentClient {
  private client: ADCPClient;
  private currentContextId?: string;

  constructor(
    private agent: AgentConfig,
    private config: ADCPClientConfig = {}
  ) {
    this.client = new ADCPClient(agent, config);
  }

  // ====== MEDIA BUY TASKS ======

  /**
   * Discover available advertising products
   */
  async getProducts(
    params: GetProductsRequest,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<GetProductsResponse>> {
    const result = await this.client.getProducts(
      params,
      inputHandler,
      { ...options, contextId: this.currentContextId }
    );
    
    if (result.success) {
      this.currentContextId = result.metadata.taskId;
    }
    
    return result;
  }

  /**
   * List available creative formats
   */
  async listCreativeFormats(
    params: ListCreativeFormatsRequest,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<ListCreativeFormatsResponse>> {
    const result = await this.client.listCreativeFormats(
      params,
      inputHandler,
      { ...options, contextId: this.currentContextId }
    );
    
    if (result.success) {
      this.currentContextId = result.metadata.taskId;
    }
    
    return result;
  }

  /**
   * Create a new media buy
   */
  async createMediaBuy(
    params: CreateMediaBuyRequest,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<CreateMediaBuyResponse>> {
    const result = await this.client.createMediaBuy(
      params,
      inputHandler,
      { ...options, contextId: this.currentContextId }
    );
    
    if (result.success) {
      this.currentContextId = result.metadata.taskId;
    }
    
    return result;
  }

  /**
   * Update an existing media buy
   */
  async updateMediaBuy(
    params: UpdateMediaBuyRequest,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<UpdateMediaBuyResponse>> {
    const result = await this.client.updateMediaBuy(
      params,
      inputHandler,
      { ...options, contextId: this.currentContextId }
    );
    
    if (result.success) {
      this.currentContextId = result.metadata.taskId;
    }
    
    return result;
  }

  /**
   * Sync creative assets
   */
  async syncCreatives(
    params: SyncCreativesRequest,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<SyncCreativesResponse>> {
    const result = await this.client.syncCreatives(
      params,
      inputHandler,
      { ...options, contextId: this.currentContextId }
    );
    
    if (result.success) {
      this.currentContextId = result.metadata.taskId;
    }
    
    return result;
  }

  /**
   * List creative assets
   */
  async listCreatives(
    params: ListCreativesRequest,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<ListCreativesResponse>> {
    const result = await this.client.listCreatives(
      params,
      inputHandler,
      { ...options, contextId: this.currentContextId }
    );
    
    if (result.success) {
      this.currentContextId = result.metadata.taskId;
    }
    
    return result;
  }

  /**
   * Get media buy delivery information
   */
  async getMediaBuyDelivery(
    params: GetMediaBuyDeliveryRequest,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<GetMediaBuyDeliveryResponse>> {
    const result = await this.client.getMediaBuyDelivery(
      params,
      inputHandler,
      { ...options, contextId: this.currentContextId }
    );
    
    if (result.success) {
      this.currentContextId = result.metadata.taskId;
    }
    
    return result;
  }

  /**
   * List authorized properties
   */
  async listAuthorizedProperties(
    params: ListAuthorizedPropertiesRequest,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<ListAuthorizedPropertiesResponse>> {
    const result = await this.client.listAuthorizedProperties(
      params,
      inputHandler,
      { ...options, contextId: this.currentContextId }
    );
    
    if (result.success) {
      this.currentContextId = result.metadata.taskId;
    }
    
    return result;
  }

  /**
   * Provide performance feedback
   */
  async providePerformanceFeedback(
    params: ProvidePerformanceFeedbackRequest,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<ProvidePerformanceFeedbackResponse>> {
    const result = await this.client.providePerformanceFeedback(
      params,
      inputHandler,
      { ...options, contextId: this.currentContextId }
    );
    
    if (result.success) {
      this.currentContextId = result.metadata.taskId;
    }
    
    return result;
  }

  // ====== SIGNALS TASKS ======

  /**
   * Get audience signals
   */
  async getSignals(
    params: GetSignalsRequest,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<GetSignalsResponse>> {
    const result = await this.client.getSignals(
      params,
      inputHandler,
      { ...options, contextId: this.currentContextId }
    );
    
    if (result.success) {
      this.currentContextId = result.metadata.taskId;
    }
    
    return result;
  }

  /**
   * Activate audience signals
   */
  async activateSignal(
    params: ActivateSignalRequest,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<ActivateSignalResponse>> {
    const result = await this.client.activateSignal(
      params,
      inputHandler,
      { ...options, contextId: this.currentContextId }
    );
    
    if (result.success) {
      this.currentContextId = result.metadata.taskId;
    }
    
    return result;
  }

  // ====== CONVERSATION MANAGEMENT ======

  /**
   * Continue the conversation with a natural language message
   * 
   * @param message - Natural language message to send to the agent
   * @param inputHandler - Handler for any clarification requests
   * 
   * @example
   * ```typescript
   * const agent = multiClient.agent('my-agent');
   * await agent.getProducts({ brief: 'Tech products' });
   * 
   * // Continue the conversation
   * const refined = await agent.continueConversation(
   *   'Focus only on laptops under $1000'
   * );
   * ```
   */
  async continueConversation<T = any>(
    message: string,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<T>> {
    if (!this.currentContextId) {
      throw new Error('No active conversation to continue. Start with a task method first.');
    }

    const result = await this.client.continueConversation<T>(
      message,
      this.currentContextId,
      inputHandler
    );

    if (result.success) {
      this.currentContextId = result.metadata.taskId;
    }

    return result;
  }

  /**
   * Get the full conversation history
   */
  getHistory(): Message[] | undefined {
    if (!this.currentContextId) {
      return undefined;
    }
    return this.client.getConversationHistory(this.currentContextId);
  }

  /**
   * Clear the conversation context (start fresh)
   */
  clearContext(): void {
    if (this.currentContextId) {
      this.client.clearConversationHistory(this.currentContextId);
      this.currentContextId = undefined;
    }
  }

  /**
   * Get the current conversation context ID
   */
  getContextId(): string | undefined {
    return this.currentContextId;
  }

  /**
   * Set a specific conversation context ID
   */
  setContextId(contextId: string): void {
    this.currentContextId = contextId;
  }

  // ====== AGENT INFORMATION ======

  /**
   * Get the agent configuration
   */
  getAgent(): AgentConfig {
    return this.client.getAgent();
  }

  /**
   * Get the agent ID
   */
  getAgentId(): string {
    return this.client.getAgentId();
  }

  /**
   * Get the agent name
   */
  getAgentName(): string {
    return this.client.getAgentName();
  }

  /**
   * Get the agent protocol
   */
  getProtocol(): 'mcp' | 'a2a' {
    return this.client.getProtocol();
  }

  /**
   * Check if there's an active conversation
   */
  hasActiveConversation(): boolean {
    return this.currentContextId !== undefined;
  }

  /**
   * Get active tasks for this agent
   */
  getActiveTasks() {
    return this.client.getActiveTasks();
  }

  // ====== GENERIC TASK EXECUTION ======

  /**
   * Execute any task by name, maintaining conversation context
   */
  async executeTask<T = any>(
    taskName: string,
    params: any,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<T>> {
    const result = await this.client.executeTask<T>(
      taskName,
      params,
      inputHandler,
      { ...options, contextId: this.currentContextId }
    );

    if (result.success) {
      this.currentContextId = result.metadata.taskId;
    }

    return result;
  }
}