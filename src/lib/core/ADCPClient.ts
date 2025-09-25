// Main ADCP Client - Type-safe conversation-aware client for AdCP agents

import type { AgentConfig } from '../types';
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

import { TaskExecutor, DeferredTaskError } from './TaskExecutor';
import type {
  InputHandler,
  TaskOptions,
  TaskResult,
  ConversationConfig,
  TaskInfo
} from './ConversationTypes';

/**
 * Configuration for ADCPClient
 */
export interface ADCPClientConfig extends ConversationConfig {
  /** Enable debug logging */
  debug?: boolean;
  /** Custom user agent string */
  userAgent?: string;
  /** Additional headers to include in requests */
  headers?: Record<string, string>;
}

/**
 * Main ADCP Client providing strongly-typed conversation-aware interface
 * 
 * This client handles individual agent interactions with full conversation context.
 * For multi-agent operations, use ADCPMultiAgentClient or compose multiple instances.
 * 
 * Key features:
 * - 🔒 Full type safety for all ADCP tasks
 * - 💬 Conversation management with context preservation  
 * - 🔄 Input handler pattern for clarifications
 * - ⏱️ Timeout and retry support
 * - 🐛 Debug logging and observability
 * - 🎯 Works with both MCP and A2A protocols
 */
export class ADCPClient {
  private executor: TaskExecutor;
  
  constructor(
    private agent: AgentConfig,
    private config: ADCPClientConfig = {}
  ) {
    this.executor = new TaskExecutor({
      workingTimeout: config.workingTimeout || 120000, // Max 120s for working status
      defaultMaxClarifications: config.defaultMaxClarifications || 3,
      enableConversationStorage: config.persistConversations !== false
    });
  }

  // ====== MEDIA BUY TASKS ======

  /**
   * Discover available advertising products
   * 
   * @param params - Product discovery parameters
   * @param inputHandler - Handler for clarification requests
   * @param options - Task execution options
   * 
   * @example
   * ```typescript
   * const products = await client.getProducts(
   *   { 
   *     brief: 'Premium coffee brands for millennials',
   *     promoted_offering: 'Artisan coffee blends' 
   *   },
   *   (context) => {
   *     if (context.inputRequest.field === 'budget') return 50000;
   *     return context.deferToHuman();
   *   }
   * );
   * ```
   */
  async getProducts(
    params: GetProductsRequest,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<GetProductsResponse>> {
    return this.executor.executeTask<GetProductsResponse>(
      this.agent,
      'get_products',
      params,
      inputHandler,
      options
    );
  }

  /**
   * List available creative formats
   * 
   * @param params - Format listing parameters
   * @param inputHandler - Handler for clarification requests
   * @param options - Task execution options
   */
  async listCreativeFormats(
    params: ListCreativeFormatsRequest,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<ListCreativeFormatsResponse>> {
    return this.executor.executeTask<ListCreativeFormatsResponse>(
      this.agent,
      'list_creative_formats',
      params,
      inputHandler,
      options
    );
  }

  /**
   * Create a new media buy
   * 
   * @param params - Media buy creation parameters
   * @param inputHandler - Handler for clarification requests
   * @param options - Task execution options
   */
  async createMediaBuy(
    params: CreateMediaBuyRequest,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<CreateMediaBuyResponse>> {
    return this.executor.executeTask<CreateMediaBuyResponse>(
      this.agent,
      'create_media_buy',
      params,
      inputHandler,
      options
    );
  }

  /**
   * Update an existing media buy
   * 
   * @param params - Media buy update parameters
   * @param inputHandler - Handler for clarification requests
   * @param options - Task execution options
   */
  async updateMediaBuy(
    params: UpdateMediaBuyRequest,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<UpdateMediaBuyResponse>> {
    return this.executor.executeTask<UpdateMediaBuyResponse>(
      this.agent,
      'update_media_buy',
      params,
      inputHandler,
      options
    );
  }

  /**
   * Sync creative assets
   * 
   * @param params - Creative sync parameters
   * @param inputHandler - Handler for clarification requests
   * @param options - Task execution options
   */
  async syncCreatives(
    params: SyncCreativesRequest,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<SyncCreativesResponse>> {
    return this.executor.executeTask<SyncCreativesResponse>(
      this.agent,
      'sync_creatives',
      params,
      inputHandler,
      options
    );
  }

  /**
   * List creative assets
   * 
   * @param params - Creative listing parameters
   * @param inputHandler - Handler for clarification requests
   * @param options - Task execution options
   */
  async listCreatives(
    params: ListCreativesRequest,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<ListCreativesResponse>> {
    return this.executor.executeTask<ListCreativesResponse>(
      this.agent,
      'list_creatives',
      params,
      inputHandler,
      options
    );
  }

  /**
   * Get media buy delivery information
   * 
   * @param params - Delivery information parameters
   * @param inputHandler - Handler for clarification requests
   * @param options - Task execution options
   */
  async getMediaBuyDelivery(
    params: GetMediaBuyDeliveryRequest,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<GetMediaBuyDeliveryResponse>> {
    return this.executor.executeTask<GetMediaBuyDeliveryResponse>(
      this.agent,
      'get_media_buy_delivery',
      params,
      inputHandler,
      options
    );
  }

  /**
   * List authorized properties
   * 
   * @param params - Property listing parameters
   * @param inputHandler - Handler for clarification requests
   * @param options - Task execution options
   */
  async listAuthorizedProperties(
    params: ListAuthorizedPropertiesRequest,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<ListAuthorizedPropertiesResponse>> {
    return this.executor.executeTask<ListAuthorizedPropertiesResponse>(
      this.agent,
      'list_authorized_properties',
      params,
      inputHandler,
      options
    );
  }

  /**
   * Provide performance feedback
   * 
   * @param params - Performance feedback parameters
   * @param inputHandler - Handler for clarification requests
   * @param options - Task execution options
   */
  async providePerformanceFeedback(
    params: ProvidePerformanceFeedbackRequest,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<ProvidePerformanceFeedbackResponse>> {
    return this.executor.executeTask<ProvidePerformanceFeedbackResponse>(
      this.agent,
      'provide_performance_feedback',
      params,
      inputHandler,
      options
    );
  }

  // ====== SIGNALS TASKS ======

  /**
   * Get audience signals
   * 
   * @param params - Signals request parameters
   * @param inputHandler - Handler for clarification requests
   * @param options - Task execution options
   */
  async getSignals(
    params: GetSignalsRequest,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<GetSignalsResponse>> {
    return this.executor.executeTask<GetSignalsResponse>(
      this.agent,
      'get_signals',
      params,
      inputHandler,
      options
    );
  }

  /**
   * Activate audience signals
   * 
   * @param params - Signal activation parameters
   * @param inputHandler - Handler for clarification requests
   * @param options - Task execution options
   */
  async activateSignal(
    params: ActivateSignalRequest,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<ActivateSignalResponse>> {
    return this.executor.executeTask<ActivateSignalResponse>(
      this.agent,
      'activate_signal',
      params,
      inputHandler,
      options
    );
  }

  // ====== GENERIC TASK EXECUTION ======

  /**
   * Execute any task by name with type safety
   * 
   * @param taskName - Name of the task to execute
   * @param params - Task parameters
   * @param inputHandler - Handler for clarification requests
   * @param options - Task execution options
   * 
   * @example
   * ```typescript
   * const result = await client.executeTask(
   *   'get_products',
   *   { brief: 'Coffee brands' },
   *   handler
   * );
   * ```
   */
  async executeTask<T = any>(
    taskName: string,
    params: any,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<T>> {
    return this.executor.executeTask<T>(
      this.agent,
      taskName,
      params,
      inputHandler,
      options
    );
  }

  // ====== DEFERRED TASK MANAGEMENT ======

  /**
   * Resume a deferred task using its token
   * 
   * @param token - Deferred task token
   * @param inputHandler - Handler to provide the missing input
   * 
   * @example
   * ```typescript
   * try {
   *   await client.createMediaBuy(params, handler);
   * } catch (error) {
   *   if (error instanceof DeferredTaskError) {
   *     // Get human input and resume
   *     const result = await client.resumeDeferredTask(
   *       error.token,
   *       (context) => humanProvidedValue
   *     );
   *   }
   * }
   * ```
   */
  async resumeDeferredTask<T = any>(
    token: string,
    inputHandler: InputHandler
  ): Promise<TaskResult<T>> {
    // This is a simplified implementation
    // In a full implementation, you'd need to store deferred task state
    // and restore it here
    throw new Error('Deferred task resumption requires storage configuration');
  }

  // ====== CONVERSATION MANAGEMENT ======

  /**
   * Continue an existing conversation with the agent
   * 
   * @param message - Message to send to the agent
   * @param contextId - Conversation context ID to continue
   * @param inputHandler - Handler for any clarification requests
   * 
   * @example
   * ```typescript
   * const agent = new ADCPClient(config);
   * const initial = await agent.getProducts({ brief: 'Tech products' });
   * 
   * // Continue the conversation
   * const refined = await agent.continueConversation(
   *   'Focus only on laptops under $1000',
   *   initial.metadata.taskId
   * );
   * ```
   */
  async continueConversation<T = any>(
    message: string,
    contextId: string,
    inputHandler?: InputHandler
  ): Promise<TaskResult<T>> {
    return this.executor.executeTask<T>(
      this.agent,
      'continue_conversation',
      { message },
      inputHandler,
      { contextId }
    );
  }

  /**
   * Get conversation history for a task
   */
  getConversationHistory(taskId: string) {
    return this.executor.getConversationHistory(taskId);
  }

  /**
   * Clear conversation history for a task
   */
  clearConversationHistory(taskId: string): void {
    this.executor.clearConversationHistory(taskId);
  }

  // ====== AGENT INFORMATION ======

  /**
   * Get the agent configuration
   */
  getAgent(): AgentConfig {
    return { ...this.agent };
  }

  /**
   * Get the agent ID
   */
  getAgentId(): string {
    return this.agent.id;
  }

  /**
   * Get the agent name
   */
  getAgentName(): string {
    return this.agent.name;
  }

  /**
   * Get the agent protocol
   */
  getProtocol(): 'mcp' | 'a2a' {
    return this.agent.protocol;
  }

  /**
   * Get active tasks for this agent
   */
  getActiveTasks() {
    return this.executor.getActiveTasks().filter(
      (task: any) => task.agent.id === this.agent.id
    );
  }

  // ====== TASK MANAGEMENT & NOTIFICATIONS ======

  /**
   * List all tasks for this agent with detailed information
   * 
   * @returns Promise resolving to array of task information
   * 
   * @example
   * ```typescript
   * const tasks = await client.listTasks();
   * tasks.forEach(task => {
   *   console.log(`${task.taskName}: ${task.status}`);
   * });
   * ```
   */
  async listTasks(): Promise<TaskInfo[]> {
    return this.executor.getTaskList(this.agent.id);
  }

  /**
   * Get detailed information about a specific task
   * 
   * @param taskId - ID of the task to get information for
   * @returns Promise resolving to task information
   */
  async getTaskInfo(taskId: string): Promise<TaskInfo | null> {
    return this.executor.getTaskInfo(taskId);
  }

  /**
   * Subscribe to task notifications for this agent
   * 
   * @param callback - Function to call when task status changes
   * @returns Unsubscribe function
   * 
   * @example
   * ```typescript
   * const unsubscribe = client.onTaskUpdate((task) => {
   *   console.log(`Task ${task.taskName} is now ${task.status}`);
   *   if (task.status === 'completed') {
   *     // Handle completion
   *   }
   * });
   * 
   * // Later, stop listening
   * unsubscribe();
   * ```
   */
  onTaskUpdate(callback: (task: TaskInfo) => void): () => void {
    return this.executor.onTaskUpdate(this.agent.id, callback);
  }

  /**
   * Subscribe to all task events (create, update, complete, error)
   * 
   * @param callbacks - Event callbacks for different task events
   * @returns Unsubscribe function
   */
  onTaskEvents(callbacks: {
    onTaskCreated?: (task: TaskInfo) => void;
    onTaskUpdated?: (task: TaskInfo) => void;  
    onTaskCompleted?: (task: TaskInfo) => void;
    onTaskFailed?: (task: TaskInfo, error: string) => void;
  }): () => void {
    return this.executor.onTaskEvents(this.agent.id, callbacks);
  }

  /**
   * Register webhook URL for receiving task notifications
   * 
   * @param webhookUrl - URL to receive webhook notifications
   * @param taskTypes - Optional array of task types to watch (defaults to all)
   * 
   * @example
   * ```typescript
   * await client.registerWebhook('https://myapp.com/webhook', ['create_media_buy']);
   * ```
   */
  async registerWebhook(webhookUrl: string, taskTypes?: string[]): Promise<void> {
    return this.executor.registerWebhook(this.agent, webhookUrl, taskTypes);
  }

  /**
   * Unregister webhook notifications
   */
  async unregisterWebhook(): Promise<void> {
    return this.executor.unregisterWebhook(this.agent);
  }
}

/**
 * Factory function to create an ADCP client
 * 
 * @param agent - Agent configuration
 * @param config - Client configuration
 * @returns Configured ADCPClient instance
 */
export function createADCPClient(
  agent: AgentConfig,
  config?: ADCPClientConfig
): ADCPClient {
  return new ADCPClient(agent, config);
}