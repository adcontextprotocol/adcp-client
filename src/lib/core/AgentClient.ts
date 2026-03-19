// Per-agent client wrapper with conversation context preservation

import type { AgentConfig } from '../types';
import type { MCPWebhookPayload } from '../types/core.generated';
import type { Task as A2ATask, TaskStatusUpdateEvent } from '@a2a-js/sdk';
import { SingleAgentClient, type SingleAgentClientConfig } from './SingleAgentClient';
import type { InputHandler, TaskOptions, TaskResult, TaskInfo, Message } from './ConversationTypes';
import type { AdcpCapabilities } from '../utils/capabilities';
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
  GetMediaBuysRequest,
  GetMediaBuysResponse,
  GetMediaBuyDeliveryRequest,
  GetMediaBuyDeliveryResponse,
  ProvidePerformanceFeedbackRequest,
  ProvidePerformanceFeedbackResponse,
  GetSignalsRequest,
  GetSignalsResponse,
  ActivateSignalRequest,
  ActivateSignalResponse,
  GetAdCPCapabilitiesRequest,
  GetAdCPCapabilitiesResponse,
  PreviewCreativeRequest,
  PreviewCreativeResponse,
  BuildCreativeRequest,
  BuildCreativeResponse,
  ListAccountsRequest,
  ListAccountsResponse,
  SyncAccountsRequest,
  SyncAccountsResponse,
  SyncAudiencesRequest,
  SyncAudiencesResponse,
  CreatePropertyListRequest,
  CreatePropertyListResponse,
  GetPropertyListRequest,
  GetPropertyListResponse,
  UpdatePropertyListRequest,
  UpdatePropertyListResponse,
  ListPropertyListsRequest,
  ListPropertyListsResponse,
  DeletePropertyListRequest,
  DeletePropertyListResponse,
  ListContentStandardsRequest,
  ListContentStandardsResponse,
  GetContentStandardsRequest,
  GetContentStandardsResponse,
  CalibrateContentRequest,
  CalibrateContentResponse,
  ValidateContentDeliveryRequest,
  ValidateContentDeliveryResponse,
  SIGetOfferingRequest,
  SIGetOfferingResponse,
  SIInitiateSessionRequest,
  SIInitiateSessionResponse,
  SISendMessageRequest,
  SISendMessageResponse,
  SITerminateSessionRequest,
  SITerminateSessionResponse,
} from '../types/tools.generated';

/**
 * Type mapping for task names to their response types
 * Enables type-safe generic executeTask() calls
 */
export type TaskResponseTypeMap = {
  get_products: GetProductsResponse;
  list_creative_formats: ListCreativeFormatsResponse;
  create_media_buy: CreateMediaBuyResponse;
  update_media_buy: UpdateMediaBuyResponse;
  sync_creatives: SyncCreativesResponse;
  list_creatives: ListCreativesResponse;
  get_media_buys: GetMediaBuysResponse;
  get_media_buy_delivery: GetMediaBuyDeliveryResponse;
  provide_performance_feedback: ProvidePerformanceFeedbackResponse;
  get_signals: GetSignalsResponse;
  activate_signal: ActivateSignalResponse;
  get_adcp_capabilities: GetAdCPCapabilitiesResponse;
  preview_creative: PreviewCreativeResponse;
  build_creative: BuildCreativeResponse;
  list_accounts: ListAccountsResponse;
  sync_accounts: SyncAccountsResponse;
  sync_audiences: SyncAudiencesResponse;
  create_property_list: CreatePropertyListResponse;
  get_property_list: GetPropertyListResponse;
  update_property_list: UpdatePropertyListResponse;
  list_property_lists: ListPropertyListsResponse;
  delete_property_list: DeletePropertyListResponse;
  list_content_standards: ListContentStandardsResponse;
  get_content_standards: GetContentStandardsResponse;
  calibrate_content: CalibrateContentResponse;
  validate_content_delivery: ValidateContentDeliveryResponse;
  si_get_offering: SIGetOfferingResponse;
  si_initiate_session: SIInitiateSessionResponse;
  si_send_message: SISendMessageResponse;
  si_terminate_session: SITerminateSessionResponse;
};

/**
 * Valid ADCP task names
 */
export type AdcpTaskName = keyof TaskResponseTypeMap;

/**
 * Per-agent client that maintains conversation context across calls
 *
 * This wrapper provides a persistent conversation context for a single agent,
 * making it easy to have multi-turn conversations and maintain state.
 */
export class AgentClient {
  private client: SingleAgentClient;
  private currentContextId?: string;

  constructor(
    private agent: AgentConfig,
    private config: SingleAgentClientConfig = {}
  ) {
    this.client = new SingleAgentClient(agent, config);
  }

  /**
   * Handle webhook from agent (async task completion or notifications)
   *
   * @param payload - Webhook payload from agent
   * @param taskType - Task type (e.g create_media_buy) from url param or url part of the webhook delivery
   * @param operationId - Operation id (e.g used for client app to track the operation) from the param or url part of the webhook delivery
   * @param signature - Optional signature for verification (X-ADCP-Signature)
   * @param timestamp - Optional timestamp for verification (X-ADCP-Timestamp)
   * @param taskType - Task type from URL path (e.g., 'create_media_buy')
   * @returns Whether webhook was handled successfully
   */
  async handleWebhook(
    payload: MCPWebhookPayload | A2ATask | TaskStatusUpdateEvent,
    taskType: string,
    operationId: string,
    signature?: string,
    timestamp?: string | number,
    rawBody?: string
  ): Promise<boolean> {
    return this.client.handleWebhook(payload, taskType, operationId, signature, timestamp, rawBody);
  }

  /**
   * Generate webhook URL for a specific task and operation
   *
   * @param taskType - Type of task (e.g., 'get_products', 'media_buy_delivery')
   * @param operationId - Operation ID for this request
   * @returns Full webhook URL
   */
  getWebhookUrl(taskType: string, operationId: string): string {
    return this.client.getWebhookUrl(taskType, operationId);
  }

  /**
   * Verify webhook signature using HMAC-SHA256 per AdCP spec.
   *
   * Prefer passing the raw HTTP body string for correct cross-language interop.
   * Passing a parsed object still works but re-serializes with JSON.stringify,
   * which may not match the sender's byte representation.
   *
   * @param rawBodyOrPayload - Raw HTTP body string (preferred) or parsed payload object (deprecated)
   * @param signature - X-ADCP-Signature header value (format: "sha256=...")
   * @param timestamp - X-ADCP-Timestamp header value (Unix timestamp)
   * @returns true if signature is valid
   */
  verifyWebhookSignature(rawBodyOrPayload: string | unknown, signature: string, timestamp: string | number): boolean {
    return this.client.verifyWebhookSignature(rawBodyOrPayload, signature, timestamp);
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
    const result = await this.client.getProducts(params, inputHandler, {
      ...options,
      contextId: this.currentContextId,
    });

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
    const result = await this.client.listCreativeFormats(params, inputHandler, {
      ...options,
      contextId: this.currentContextId,
    });

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
    const result = await this.client.createMediaBuy(params, inputHandler, {
      ...options,
      contextId: this.currentContextId,
    });

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
    const result = await this.client.updateMediaBuy(params, inputHandler, {
      ...options,
      contextId: this.currentContextId,
    });

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
    const result = await this.client.syncCreatives(params, inputHandler, {
      ...options,
      contextId: this.currentContextId,
    });

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
    const result = await this.client.listCreatives(params, inputHandler, {
      ...options,
      contextId: this.currentContextId,
    });

    if (result.success) {
      this.currentContextId = result.metadata.taskId;
    }

    return result;
  }

  /**
   * Get media buy status, creative approvals, and optional delivery snapshots
   */
  async getMediaBuys(
    params: GetMediaBuysRequest,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<GetMediaBuysResponse>> {
    const result = await this.client.getMediaBuys(params, inputHandler, {
      ...options,
      contextId: this.currentContextId,
    });

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
    const result = await this.client.getMediaBuyDelivery(params, inputHandler, {
      ...options,
      contextId: this.currentContextId,
    });

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
    const result = await this.client.providePerformanceFeedback(params, inputHandler, {
      ...options,
      contextId: this.currentContextId,
    });

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
    const result = await this.client.getSignals(params, inputHandler, { ...options, contextId: this.currentContextId });

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
    const result = await this.client.activateSignal(params, inputHandler, {
      ...options,
      contextId: this.currentContextId,
    });

    if (result.success) {
      this.currentContextId = result.metadata.taskId;
    }

    return result;
  }

  // ====== PROTOCOL TASKS ======

  /**
   * Get AdCP capabilities (v3 tool call)
   */
  async getAdcpCapabilities(
    params: GetAdCPCapabilitiesRequest,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<GetAdCPCapabilitiesResponse>> {
    const result = await this.client.getAdcpCapabilities(params, inputHandler, {
      ...options,
      contextId: this.currentContextId,
    });

    if (result.success) {
      this.currentContextId = result.metadata.taskId;
    }

    return result;
  }

  /**
   * Get normalized capabilities with v2/v3 fallback
   *
   * For v3 servers: calls get_adcp_capabilities tool
   * For v2 servers: builds synthetic capabilities from tool list
   */
  async getCapabilities(): Promise<AdcpCapabilities> {
    return this.client.getCapabilities();
  }

  /**
   * Preview a creative
   */
  async previewCreative(
    params: PreviewCreativeRequest,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<PreviewCreativeResponse>> {
    const result = await this.client.previewCreative(params, inputHandler, {
      ...options,
      contextId: this.currentContextId,
    });
    if (result.success) {
      this.currentContextId = result.metadata.taskId;
    }
    return result;
  }

  /**
   * Build a creative from format and brand context
   */
  async buildCreative(
    params: BuildCreativeRequest,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<BuildCreativeResponse>> {
    const result = await this.client.buildCreative(params, inputHandler, {
      ...options,
      contextId: this.currentContextId,
    });
    if (result.success) {
      this.currentContextId = result.metadata.taskId;
    }
    return result;
  }

  // ====== ACCOUNT & AUDIENCE TASKS ======

  /**
   * List accounts
   */
  async listAccounts(
    params: ListAccountsRequest,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<ListAccountsResponse>> {
    const result = await this.client.listAccounts(params, inputHandler, {
      ...options,
      contextId: this.currentContextId,
    });
    if (result.success) {
      this.currentContextId = result.metadata.taskId;
    }
    return result;
  }

  /**
   * Sync accounts
   */
  async syncAccounts(
    params: SyncAccountsRequest,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<SyncAccountsResponse>> {
    const result = await this.client.syncAccounts(params, inputHandler, {
      ...options,
      contextId: this.currentContextId,
    });
    if (result.success) {
      this.currentContextId = result.metadata.taskId;
    }
    return result;
  }

  /**
   * Sync audiences
   */
  async syncAudiences(
    params: SyncAudiencesRequest,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<SyncAudiencesResponse>> {
    const result = await this.client.syncAudiences(params, inputHandler, {
      ...options,
      contextId: this.currentContextId,
    });
    if (result.success) {
      this.currentContextId = result.metadata.taskId;
    }
    return result;
  }

  // ====== GOVERNANCE TASKS ======

  /**
   * Create a property list
   */
  async createPropertyList(
    params: CreatePropertyListRequest,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<CreatePropertyListResponse>> {
    const result = await this.client.createPropertyList(params, inputHandler, {
      ...options,
      contextId: this.currentContextId,
    });
    if (result.success) {
      this.currentContextId = result.metadata.taskId;
    }
    return result;
  }

  /**
   * Get a property list
   */
  async getPropertyList(
    params: GetPropertyListRequest,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<GetPropertyListResponse>> {
    const result = await this.client.getPropertyList(params, inputHandler, {
      ...options,
      contextId: this.currentContextId,
    });
    if (result.success) {
      this.currentContextId = result.metadata.taskId;
    }
    return result;
  }

  /**
   * Update a property list
   */
  async updatePropertyList(
    params: UpdatePropertyListRequest,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<UpdatePropertyListResponse>> {
    const result = await this.client.updatePropertyList(params, inputHandler, {
      ...options,
      contextId: this.currentContextId,
    });
    if (result.success) {
      this.currentContextId = result.metadata.taskId;
    }
    return result;
  }

  /**
   * List property lists
   */
  async listPropertyLists(
    params: ListPropertyListsRequest,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<ListPropertyListsResponse>> {
    const result = await this.client.listPropertyLists(params, inputHandler, {
      ...options,
      contextId: this.currentContextId,
    });
    if (result.success) {
      this.currentContextId = result.metadata.taskId;
    }
    return result;
  }

  /**
   * Delete a property list
   */
  async deletePropertyList(
    params: DeletePropertyListRequest,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<DeletePropertyListResponse>> {
    const result = await this.client.deletePropertyList(params, inputHandler, {
      ...options,
      contextId: this.currentContextId,
    });
    if (result.success) {
      this.currentContextId = result.metadata.taskId;
    }
    return result;
  }

  /**
   * List content standards
   */
  async listContentStandards(
    params: ListContentStandardsRequest,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<ListContentStandardsResponse>> {
    const result = await this.client.listContentStandards(params, inputHandler, {
      ...options,
      contextId: this.currentContextId,
    });
    if (result.success) {
      this.currentContextId = result.metadata.taskId;
    }
    return result;
  }

  /**
   * Get content standards
   */
  async getContentStandards(
    params: GetContentStandardsRequest,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<GetContentStandardsResponse>> {
    const result = await this.client.getContentStandards(params, inputHandler, {
      ...options,
      contextId: this.currentContextId,
    });
    if (result.success) {
      this.currentContextId = result.metadata.taskId;
    }
    return result;
  }

  /**
   * Calibrate content against standards
   */
  async calibrateContent(
    params: CalibrateContentRequest,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<CalibrateContentResponse>> {
    const result = await this.client.calibrateContent(params, inputHandler, {
      ...options,
      contextId: this.currentContextId,
    });
    if (result.success) {
      this.currentContextId = result.metadata.taskId;
    }
    return result;
  }

  /**
   * Validate content delivery
   */
  async validateContentDelivery(
    params: ValidateContentDeliveryRequest,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<ValidateContentDeliveryResponse>> {
    const result = await this.client.validateContentDelivery(params, inputHandler, {
      ...options,
      contextId: this.currentContextId,
    });
    if (result.success) {
      this.currentContextId = result.metadata.taskId;
    }
    return result;
  }

  // ====== SPONSORED INTELLIGENCE TASKS ======

  /**
   * Get an SI offering
   */
  async siGetOffering(
    params: SIGetOfferingRequest,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<SIGetOfferingResponse>> {
    const result = await this.client.siGetOffering(params, inputHandler, {
      ...options,
      contextId: this.currentContextId,
    });
    if (result.success) {
      this.currentContextId = result.metadata.taskId;
    }
    return result;
  }

  /**
   * Initiate an SI session
   */
  async siInitiateSession(
    params: SIInitiateSessionRequest,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<SIInitiateSessionResponse>> {
    const result = await this.client.siInitiateSession(params, inputHandler, {
      ...options,
      contextId: this.currentContextId,
    });
    if (result.success) {
      this.currentContextId = result.metadata.taskId;
    }
    return result;
  }

  /**
   * Send a message in an SI session
   */
  async siSendMessage(
    params: SISendMessageRequest,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<SISendMessageResponse>> {
    const result = await this.client.siSendMessage(params, inputHandler, {
      ...options,
      contextId: this.currentContextId,
    });
    if (result.success) {
      this.currentContextId = result.metadata.taskId;
    }
    return result;
  }

  /**
   * Terminate an SI session
   */
  async siTerminateSession(
    params: SITerminateSessionRequest,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<SITerminateSessionResponse>> {
    const result = await this.client.siTerminateSession(params, inputHandler, {
      ...options,
      contextId: this.currentContextId,
    });
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

    const result = await this.client.continueConversation<T>(message, this.currentContextId, inputHandler);

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
   * Get the canonical base URL for this agent
   *
   * Returns the canonical URL if already resolved, or computes it synchronously.
   * For guaranteed canonical URL (especially for A2A), use resolveCanonicalUrl() first.
   */
  getCanonicalUrl(): string {
    return this.client.getCanonicalUrl();
  }

  /**
   * Resolve and return the canonical base URL for this agent
   *
   * For A2A: Fetches the agent card and uses its 'url' field
   * For MCP: Performs endpoint discovery and strips /mcp suffix
   */
  async resolveCanonicalUrl(): Promise<string> {
    return this.client.resolveCanonicalUrl();
  }

  /**
   * Check if this agent is the same as another agent by canonical URL
   */
  isSameAgent(other: AgentConfig | AgentClient): boolean {
    if (other instanceof AgentClient) {
      // Compare using the other client's agent config
      return this.client.isSameAgent(other.getAgent());
    }
    return this.client.isSameAgent(other);
  }

  /**
   * Async version that resolves canonical URLs first for more accurate comparison
   */
  async isSameAgentResolved(other: AgentConfig | AgentClient): Promise<boolean> {
    if (other instanceof AgentClient) {
      // Resolve both sides first
      await this.resolveCanonicalUrl();
      await other.resolveCanonicalUrl();
      // Then compare using the resolved agent config
      return this.client.isSameAgent(other.getAgent());
    }
    return this.client.isSameAgentResolved(other);
  }

  /**
   * Get the fully resolved agent configuration with canonical URL
   */
  async getResolvedAgent(): Promise<AgentConfig> {
    return this.client.getResolvedAgent();
  }

  /**
   * Get agent information including capabilities
   */
  async getAgentInfo() {
    return this.client.getAgentInfo();
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
   * Execute any ADCP task by name with full type safety
   *
   * @example
   * ```typescript
   * // ✅ TYPE-SAFE: Automatic response type inference
   * const result = await agent.executeTask('get_products', params);
   * // result is TaskResult<GetProductsResponse> - no casting needed!
   *
   * // ✅ CUSTOM TYPES: For non-standard tasks
   * const customResult = await agent.executeTask<MyCustomResponse>('custom_task', params);
   * ```
   */
  async executeTask<K extends AdcpTaskName>(
    taskName: K,
    params: Record<string, unknown>,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<TaskResponseTypeMap[K]>>;

  /**
   * Execute a task by name with custom response type
   */
  async executeTask<T = unknown>(
    taskName: string,
    params: Record<string, unknown>,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<T>>;

  async executeTask<T = unknown>(
    taskName: string,
    params: Record<string, unknown>,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<T>> {
    const result = await this.client.executeTask<T>(taskName, params, inputHandler, {
      ...options,
      contextId: this.currentContextId,
    });

    if (result.success) {
      this.currentContextId = result.metadata.taskId;
    }

    return result;
  }

  // ====== TASK MANAGEMENT DELEGATION ======

  /**
   * List all tasks for this agent
   */
  async listTasks(): Promise<TaskInfo[]> {
    return this.client.listTasks();
  }

  /**
   * Get detailed information about a specific task
   */
  async getTaskInfo(taskId: string): Promise<TaskInfo | null> {
    return this.client.getTaskInfo(taskId);
  }

  /**
   * Subscribe to task notifications for this agent
   */
  onTaskUpdate(callback: (task: TaskInfo) => void): () => void {
    return this.client.onTaskUpdate(callback);
  }

  /**
   * Subscribe to all task events
   */
  onTaskEvents(callbacks: {
    onTaskCreated?: (task: TaskInfo) => void;
    onTaskUpdated?: (task: TaskInfo) => void;
    onTaskCompleted?: (task: TaskInfo) => void;
    onTaskFailed?: (task: TaskInfo, error: string) => void;
  }): () => void {
    return this.client.onTaskEvents(callbacks);
  }

  /**
   * Register webhook for task notifications
   */
  async registerWebhook(webhookUrl: string, taskTypes?: string[]): Promise<void> {
    return this.client.registerWebhook(webhookUrl, taskTypes);
  }

  /**
   * Unregister webhook notifications
   */
  async unregisterWebhook(): Promise<void> {
    return this.client.unregisterWebhook();
  }
}
