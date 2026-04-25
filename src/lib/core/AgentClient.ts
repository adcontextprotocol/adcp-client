// Per-agent client wrapper with conversation context preservation

import type { Client as MCPClient } from '@modelcontextprotocol/sdk/client/index.js';
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
import type { MutatingRequestInput } from '../utils/idempotency';

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
 * Configuration for `AgentClient.fromMCPClient()`.
 *
 * A narrowed subset of `SingleAgentClientConfig` — only includes options that
 * are meaningful for in-process transport. HTTP-only fields (`userAgent`, `headers`,
 * `webhookUrlTemplate`, OAuth paths) are excluded because they have no effect when
 * the client dispatches directly to an in-process MCP `Client`.
 *
 * The fields you most likely want:
 * - `validation` — `requests`/`responses` validation mode (`strict` | `warn` | `off`)
 * - `governance` — buyer-side governance config
 * - `requireV3ForMutations` — enforce AdCP v3 before dispatching mutating tools
 */
export type InProcessAgentClientConfig = Pick<
  SingleAgentClientConfig,
  | 'debug'
  | 'validation'
  | 'governance'
  | 'onActivity'
  | 'validateFeatures'
  | 'requireV3ForMutations'
  | 'allowV2'
  | 'workingTimeout'
  | 'defaultMaxClarifications'
  | 'persistConversations'
> & {
  /**
   * Human-readable name for this agent, used in debug logs and
   * `getAgentName()`. Defaults to `'in-process'`.
   */
  agentName?: string;
  /**
   * Stable identifier for this agent, used in `getAgentId()`.
   * Defaults to a random string prefixed with `'in-process-'`.
   */
  agentId?: string;
};

/**
 * Task result states where the server is still holding the task open. While
 * the last response was in one of these states the AgentClient retains the
 * server-returned `taskId` so a follow-up call can resume the same
 * server-side task (HITL approvals, long-running workflows).
 */
const NON_TERMINAL_STATES: ReadonlySet<string> = new Set([
  'working',
  'input-required',
  'submitted',
  'auth-required',
  'deferred',
]);

/**
 * Per-agent client that maintains conversation context across calls.
 *
 * **One AgentClient per conversation.** The client retains `contextId` and
 * `pendingTaskId` in-memory so subsequent calls ride the same A2A session.
 * Sharing an AgentClient across concurrent conversations will interleave
 * their contexts (last-write-wins). Create a fresh AgentClient — or call
 * {@link resetContext} — per logical conversation.
 *
 * **Resume across process restart** — persist `getContextId()` after a
 * non-terminal response and pass it to `resetContext(id)` on rehydration.
 * The server will route the next call back to the same session.
 */
export class AgentClient {
  private client: SingleAgentClient;
  private currentContextId?: string;
  private pendingTaskId?: string;
  private readonly _isInProcess: boolean;

  constructor(
    private agent: AgentConfig,
    private config: SingleAgentClientConfig = {}
  ) {
    this.client = new SingleAgentClient(agent, config);
    this._isInProcess = agent._inProcessMcpClient !== undefined;
  }

  /**
   * Create an `AgentClient` backed by a pre-connected MCP `Client` instead of
   * an HTTP endpoint. Useful for in-process compliance testing without spinning
   * up a loopback HTTP server.
   *
   * **What this gives you over `dispatchTestRequest`:**
   * All client-side pipeline stages still apply — idempotency key auto-injection,
   * request/response schema validation hooks, governance middleware, and the typed
   * `TaskResult<T>` discriminated-union response shape. None of these apply when
   * calling `dispatchTestRequest()` directly.
   *
   * **Usage:**
   * ```ts
   * import { Client } from '@modelcontextprotocol/sdk/client/index.js';
   * import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
   * import { AgentClient } from '@adcp/client';
   *
   * const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
   * const mcpClient = new Client({ name: 'test', version: '1.0.0' });
   * await Promise.all([
   *   mcpClient.connect(clientTransport),
   *   adcpServer.connect(serverTransport),
   * ]);
   *
   * const agent = AgentClient.fromMCPClient(mcpClient, {
   *   validation: { requests: 'strict' },
   * });
   * const result = await agent.createMediaBuy({ ... });
   * ```
   *
   * **Unsupported methods on in-process instances:** `resolveCanonicalUrl`,
   * `getWebhookUrl`, `registerWebhook`, `unregisterWebhook` — these require HTTP
   * and will throw `Error` with a descriptive message. Use `getAgentId()` /
   * `getAgentName()` for identification instead.
   *
   * @param mcpClient - An already-connected MCP `Client` (see example above).
   * @param config - Optional narrowed config. HTTP-only fields are excluded.
   */
  static fromMCPClient(mcpClient: MCPClient, config: InProcessAgentClientConfig = {}): AgentClient {
    const { agentName, agentId, ...rest } = config;
    const id = agentId ?? `in-process-${Math.random().toString(36).slice(2, 10)}`;
    const syntheticAgent: AgentConfig = {
      id,
      name: agentName ?? 'in-process',
      agent_uri: `adcp-in-process://${id}`,
      protocol: 'mcp',
      _inProcessMcpClient: mcpClient,
    };
    return new AgentClient(syntheticAgent, rest as SingleAgentClientConfig);
  }

  /**
   * Absorb the session ids the server returned on `result.metadata`:
   * retain `contextId` whenever one is present, and retain `serverTaskId`
   * only while the response was non-terminal. Terminal responses clear
   * `pendingTaskId` so the next call starts a fresh server-side task.
   *
   * The `deferred` case is deliberately asymmetric: deferred results don't
   * surface a new `serverTaskId` on metadata (the caller holds a resume
   * token, not a task-id), so the `if (serverTaskId)` guard preserves the
   * pre-defer `pendingTaskId` — which is exactly what a later resume needs.
   */
  private retainSession<T>(result: TaskResult<T>): void {
    const meta = result.metadata;
    if (meta?.contextId) {
      this.currentContextId = meta.contextId;
    }
    if (NON_TERMINAL_STATES.has(meta?.status as string)) {
      if (meta?.serverTaskId) {
        this.pendingTaskId = meta.serverTaskId;
      }
    } else {
      this.pendingTaskId = undefined;
    }
  }

  /**
   * Merge the caller's `TaskOptions` with the retained session ids so the
   * outbound request carries whatever session continuity is in scope.
   * Caller-supplied ids win (explicit > implicit); unset caller fields fall
   * back to the retained ones.
   *
   * Switching conversations: if the caller explicitly supplies a
   * `contextId` that differs from the retained one, the retained
   * `pendingTaskId` is dropped from the merge. Carrying a stale taskId
   * from a previous conversation into a new one is never what you want —
   * it either resumes the wrong task or confuses the server.
   */
  private withSession(options?: TaskOptions): TaskOptions {
    const explicitSwitch = options?.contextId !== undefined && options.contextId !== this.currentContextId;
    return {
      ...options,
      contextId: options?.contextId ?? this.currentContextId,
      taskId: options?.taskId ?? (explicitSwitch ? undefined : this.pendingTaskId),
    };
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
      ...this.withSession(options),
    });

    this.retainSession(result);

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
      ...this.withSession(options),
    });

    this.retainSession(result);

    return result;
  }

  /**
   * Create a new media buy
   */
  async createMediaBuy(
    params: MutatingRequestInput<CreateMediaBuyRequest>,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<CreateMediaBuyResponse>> {
    const result = await this.client.createMediaBuy(params, inputHandler, {
      ...this.withSession(options),
    });

    this.retainSession(result);

    return result;
  }

  /**
   * Update an existing media buy
   */
  async updateMediaBuy(
    params: MutatingRequestInput<UpdateMediaBuyRequest>,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<UpdateMediaBuyResponse>> {
    const result = await this.client.updateMediaBuy(params, inputHandler, {
      ...this.withSession(options),
    });

    this.retainSession(result);

    return result;
  }

  /**
   * Sync creative assets
   */
  async syncCreatives(
    params: MutatingRequestInput<SyncCreativesRequest>,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<SyncCreativesResponse>> {
    const result = await this.client.syncCreatives(params, inputHandler, {
      ...this.withSession(options),
    });

    this.retainSession(result);

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
      ...this.withSession(options),
    });

    this.retainSession(result);

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
      ...this.withSession(options),
    });

    this.retainSession(result);

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
      ...this.withSession(options),
    });

    this.retainSession(result);

    return result;
  }

  /**
   * Provide performance feedback
   */
  async providePerformanceFeedback(
    params: MutatingRequestInput<ProvidePerformanceFeedbackRequest>,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<ProvidePerformanceFeedbackResponse>> {
    const result = await this.client.providePerformanceFeedback(params, inputHandler, {
      ...this.withSession(options),
    });

    this.retainSession(result);

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
    const result = await this.client.getSignals(params, inputHandler, this.withSession(options));

    this.retainSession(result);

    return result;
  }

  /**
   * Activate audience signals
   */
  async activateSignal(
    params: MutatingRequestInput<ActivateSignalRequest>,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<ActivateSignalResponse>> {
    const result = await this.client.activateSignal(params, inputHandler, {
      ...this.withSession(options),
    });

    this.retainSession(result);

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
      ...this.withSession(options),
    });

    this.retainSession(result);

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
   * Return the seller's declared `adcp.idempotency.replay_ttl_seconds`, or
   * throw when a v3 seller omits the (required) declaration.
   *
   * Returns `undefined` for v2 agents — v2 pre-dates the idempotency envelope.
   */
  async getIdempotencyReplayTtlSeconds(): Promise<number | undefined> {
    return this.client.getIdempotencyReplayTtlSeconds();
  }

  /**
   * Assert that the seller's capabilities report AdCP v3. Throws
   * `VersionUnsupportedError` otherwise. Set `ADCP_ALLOW_V2=1` to bypass.
   */
  async requireV3(taskType: string = 'request'): Promise<void> {
    return this.client.requireV3(taskType);
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
      ...this.withSession(options),
    });
    this.retainSession(result);
    return result;
  }

  /**
   * Build a creative from format and brand context
   */
  async buildCreative(
    params: MutatingRequestInput<BuildCreativeRequest>,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<BuildCreativeResponse>> {
    const result = await this.client.buildCreative(params, inputHandler, {
      ...this.withSession(options),
    });
    this.retainSession(result);
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
      ...this.withSession(options),
    });
    this.retainSession(result);
    return result;
  }

  /**
   * Sync accounts
   */
  async syncAccounts(
    params: MutatingRequestInput<SyncAccountsRequest>,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<SyncAccountsResponse>> {
    const result = await this.client.syncAccounts(params, inputHandler, {
      ...this.withSession(options),
    });
    this.retainSession(result);
    return result;
  }

  /**
   * Sync audiences
   */
  async syncAudiences(
    params: MutatingRequestInput<SyncAudiencesRequest>,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<SyncAudiencesResponse>> {
    const result = await this.client.syncAudiences(params, inputHandler, {
      ...this.withSession(options),
    });
    this.retainSession(result);
    return result;
  }

  // ====== GOVERNANCE TASKS ======

  /**
   * Create a property list
   */
  async createPropertyList(
    params: MutatingRequestInput<CreatePropertyListRequest>,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<CreatePropertyListResponse>> {
    const result = await this.client.createPropertyList(params, inputHandler, {
      ...this.withSession(options),
    });
    this.retainSession(result);
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
      ...this.withSession(options),
    });
    this.retainSession(result);
    return result;
  }

  /**
   * Update a property list
   */
  async updatePropertyList(
    params: MutatingRequestInput<UpdatePropertyListRequest>,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<UpdatePropertyListResponse>> {
    const result = await this.client.updatePropertyList(params, inputHandler, {
      ...this.withSession(options),
    });
    this.retainSession(result);
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
      ...this.withSession(options),
    });
    this.retainSession(result);
    return result;
  }

  /**
   * Delete a property list
   */
  async deletePropertyList(
    params: MutatingRequestInput<DeletePropertyListRequest>,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<DeletePropertyListResponse>> {
    const result = await this.client.deletePropertyList(params, inputHandler, {
      ...this.withSession(options),
    });
    this.retainSession(result);
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
      ...this.withSession(options),
    });
    this.retainSession(result);
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
      ...this.withSession(options),
    });
    this.retainSession(result);
    return result;
  }

  /**
   * Calibrate content against standards
   */
  async calibrateContent(
    params: MutatingRequestInput<CalibrateContentRequest>,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<CalibrateContentResponse>> {
    const result = await this.client.calibrateContent(params, inputHandler, {
      ...this.withSession(options),
    });
    this.retainSession(result);
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
      ...this.withSession(options),
    });
    this.retainSession(result);
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
      ...this.withSession(options),
    });
    this.retainSession(result);
    return result;
  }

  /**
   * Initiate an SI session
   */
  async siInitiateSession(
    params: MutatingRequestInput<SIInitiateSessionRequest>,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<SIInitiateSessionResponse>> {
    const result = await this.client.siInitiateSession(params, inputHandler, {
      ...this.withSession(options),
    });
    this.retainSession(result);
    return result;
  }

  /**
   * Send a message in an SI session
   */
  async siSendMessage(
    params: MutatingRequestInput<SISendMessageRequest>,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<SISendMessageResponse>> {
    const result = await this.client.siSendMessage(params, inputHandler, {
      ...this.withSession(options),
    });
    this.retainSession(result);
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
      ...this.withSession(options),
    });
    this.retainSession(result);
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

    this.retainSession(result);

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
   * Clear the conversation context (start fresh).
   *
   * Equivalent to `resetContext()` — clears both the retained `contextId`
   * and any pending server-side `taskId`, and drops cached history.
   */
  clearContext(): void {
    this.resetContext();
  }

  /**
   * Reset conversation state. Call with no args to start a fresh
   * conversation; pass a seed to rehydrate a persisted session id (e.g.,
   * across a process restart).
   *
   * Always clears `pendingTaskId` — a persisted `contextId` places the next
   * send into the same server-side session, but any old `taskId` is stale.
   */
  resetContext(seed?: string): void {
    if (this.currentContextId) {
      this.client.clearConversationHistory(this.currentContextId);
    }
    this.currentContextId = seed;
    this.pendingTaskId = undefined;
  }

  /**
   * Get the current conversation context ID
   */
  getContextId(): string | undefined {
    return this.currentContextId;
  }

  /**
   * Get the pending server-side `taskId` from the last non-terminal
   * response, if any. Populated when the server returned
   * `input-required` / `working` / `submitted` / `auth-required`;
   * cleared when the task reaches a terminal state.
   *
   * Persist this alongside `getContextId()` if you need to resume a
   * specific task (not just a conversation) across a process restart.
   */
  getPendingTaskId(): string | undefined {
    return this.pendingTaskId;
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
   *
   * **Not supported on in-process instances** (created via `fromMCPClient`).
   * Use `getAgentId()` / `getAgentName()` for identification instead.
   */
  async resolveCanonicalUrl(): Promise<string> {
    if (this._isInProcess) {
      throw new Error(
        'resolveCanonicalUrl() is not supported on in-process AgentClient instances. ' +
          'Use getAgentId() or getAgentName() to identify this client.'
      );
    }
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
      ...this.withSession(options),
    });

    this.retainSession(result);

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
   * Generate webhook URL for a specific task and operation.
   *
   * **Not supported on in-process instances** (created via `fromMCPClient`).
   * In-process clients have no HTTP listener to receive webhook callbacks.
   */
  getWebhookUrl(taskType: string, operationId: string): string {
    if (this._isInProcess) {
      throw new Error(
        'getWebhookUrl() is not supported on in-process AgentClient instances. ' +
          'In-process clients have no HTTP listener for webhook delivery.'
      );
    }
    return this.client.getWebhookUrl(taskType, operationId);
  }

  /**
   * Register webhook for task notifications.
   *
   * **Not supported on in-process instances** (created via `fromMCPClient`).
   */
  async registerWebhook(webhookUrl: string, taskTypes?: string[]): Promise<void> {
    if (this._isInProcess) {
      throw new Error(
        'registerWebhook() is not supported on in-process AgentClient instances. ' +
          'In-process clients have no HTTP listener for webhook delivery.'
      );
    }
    return this.client.registerWebhook(webhookUrl, taskTypes);
  }

  /**
   * Unregister webhook notifications.
   *
   * **Not supported on in-process instances** (created via `fromMCPClient`).
   */
  async unregisterWebhook(): Promise<void> {
    if (this._isInProcess) {
      throw new Error(
        'unregisterWebhook() is not supported on in-process AgentClient instances. ' +
          'In-process clients have no HTTP listener for webhook delivery.'
      );
    }
    return this.client.unregisterWebhook();
  }
}
