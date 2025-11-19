// Main ADCP Client - Type-safe conversation-aware client for AdCP agents

import { z } from 'zod';
import * as schemas from '../types/schemas.generated';
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
  ActivateSignalResponse,
  PreviewCreativeRequest,
  PreviewCreativeResponse,
  Format,
} from '../types/tools.generated';

import { TaskExecutor, DeferredTaskError } from './TaskExecutor';
import type { InputHandler, TaskOptions, TaskResult, ConversationConfig, TaskInfo } from './ConversationTypes';
import type { Activity, AsyncHandlerConfig, WebhookPayload } from './AsyncHandler';
import { AsyncHandler } from './AsyncHandler';
import * as crypto from 'crypto';

/**
 * Configuration for SingleAgentClient (and multi-agent client)
 */
export interface SingleAgentClientConfig extends ConversationConfig {
  /** Enable debug logging */
  debug?: boolean;
  /** Custom user agent string */
  userAgent?: string;
  /** Additional headers to include in requests */
  headers?: Record<string, string>;
  /** Activity callback for observability (logging, UI updates, etc) */
  onActivity?: (activity: Activity) => void | Promise<void>;
  /** Task completion handlers - called for both sync responses and webhook completions */
  handlers?: AsyncHandlerConfig;
  /** Webhook secret for signature verification (recommended for production) */
  webhookSecret?: string;
  /**
   * Webhook URL template with macro substitution
   *
   * Available macros:
   * - {agent_id} - Agent ID
   * - {task_type} - Task type (e.g., sync_creatives, media_buy_delivery)
   * - {operation_id} - Operation ID
   *
   * @example
   * Path-based: "https://myapp.com/webhook/{task_type}/{agent_id}/{operation_id}"
   * Query string: "https://myapp.com/webhook?agent={agent_id}&op={operation_id}&type={task_type}"
   * Custom: "https://myapp.com/api/v1/adcp/{agent_id}?operation={operation_id}"
   */
  webhookUrlTemplate?: string;
  /**
   * Runtime schema validation options
   */
  validation?: {
    /**
     * Fail tasks when response schema validation fails (default: true)
     *
     * When true: Invalid responses cause task to fail with error
     * When false: Schema violations are logged but task continues
     *
     * @default true
     */
    strictSchemaValidation?: boolean;
    /**
     * Log all schema validation violations to debug logs (default: true)
     *
     * @default true
     */
    logSchemaViolations?: boolean;
  };
}

/**
 * Internal single-agent client implementation
 *
 * This is an internal implementation detail used by AgentClient and ADCPMultiAgentClient.
 * External users should use AdCPClient (alias for ADCPMultiAgentClient) instead.
 *
 * Key features:
 * - 🔒 Full type safety for all ADCP tasks
 * - 💬 Conversation management with context preservation
 * - 🔄 Input handler pattern for clarifications
 * - ⏱️ Timeout and retry support
 * - 🐛 Debug logging and observability
 * - 🎯 Works with both MCP and A2A protocols
 */
export class SingleAgentClient {
  private executor: TaskExecutor;
  private asyncHandler?: AsyncHandler;
  private normalizedAgent: AgentConfig;
  private discoveredEndpoint?: string; // Cache discovered endpoint

  constructor(
    private agent: AgentConfig,
    private config: SingleAgentClientConfig = {}
  ) {
    // Normalize agent URL for MCP protocol
    this.normalizedAgent = this.normalizeAgentConfig(agent);

    this.executor = new TaskExecutor({
      workingTimeout: config.workingTimeout || 120000, // Max 120s for working status
      defaultMaxClarifications: config.defaultMaxClarifications || 3,
      enableConversationStorage: config.persistConversations !== false,
      webhookUrlTemplate: config.webhookUrlTemplate,
      agentId: agent.id,
      webhookSecret: config.webhookSecret,
      strictSchemaValidation: config.validation?.strictSchemaValidation !== false, // Default: true
      logSchemaViolations: config.validation?.logSchemaViolations !== false, // Default: true
      onActivity: config.onActivity,
    });

    // Create async handler if handlers are provided
    if (config.handlers) {
      this.asyncHandler = new AsyncHandler(config.handlers);
    }
  }

  /**
   * Ensure MCP endpoint is discovered (lazy initialization)
   *
   * If the agent needs discovery, perform it now and cache the result.
   * Returns the agent config with the discovered endpoint.
   */
  private async ensureEndpointDiscovered(): Promise<AgentConfig> {
    const needsDiscovery = (this.normalizedAgent as any)._needsDiscovery;

    if (!needsDiscovery) {
      return this.normalizedAgent;
    }

    // Already discovered? Use cached value
    if (this.discoveredEndpoint) {
      return {
        ...this.normalizedAgent,
        agent_uri: this.discoveredEndpoint,
      };
    }

    // Perform discovery
    this.discoveredEndpoint = await this.discoverMCPEndpoint(this.normalizedAgent.agent_uri);

    return {
      ...this.normalizedAgent,
      agent_uri: this.discoveredEndpoint,
    };
  }

  /**
   * Discover MCP endpoint by testing the provided path, then trying variants
   *
   * Strategy:
   * 1. Test the exact URL provided (preserving trailing slashes)
   * 2. If that fails, try with/without trailing slash
   * 3. If still fails and doesn't end with /mcp, try adding /mcp
   *
   * Note: This is async and called lazily on first agent interaction
   */
  private async discoverMCPEndpoint(providedUri: string): Promise<string> {
    const { Client: MCPClient } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');

    const authToken = this.agent.auth_token_env;

    const testEndpoint = async (url: string): Promise<boolean> => {
      try {
        const mcpClient = new MCPClient({
          name: 'AdCP-Client',
          version: '1.0.0',
        });

        // Use requestInit with proper headers - simpler and more reliable than custom fetch
        const transportOptions: any = {
          requestInit: {
            headers: {
              Accept: 'application/json, text/event-stream',
            },
          },
        };

        if (authToken) {
          transportOptions.requestInit.headers['Authorization'] = `Bearer ${authToken}`;
          transportOptions.requestInit.headers['x-adcp-auth'] = authToken;
        }

        const transport = new StreamableHTTPClientTransport(new URL(url), transportOptions);

        await mcpClient.connect(transport);
        await mcpClient.close();
        return true;
      } catch {
        return false;
      }
    };

    const urlsToTry: string[] = [];

    // 1. Always try the exact URL provided first
    urlsToTry.push(providedUri);

    // 2. Try the opposite trailing slash variant
    const hasTrailingSlash = providedUri.endsWith('/');
    const alternateSlash = hasTrailingSlash
      ? providedUri.slice(0, -1) // Remove trailing slash
      : providedUri + '/'; // Add trailing slash
    urlsToTry.push(alternateSlash);

    // 3. If URL doesn't end with /mcp or /mcp/, try adding /mcp
    const normalizedUri = providedUri.replace(/\/$/, '');
    if (!normalizedUri.endsWith('/mcp')) {
      urlsToTry.push(normalizedUri + '/mcp');
      urlsToTry.push(normalizedUri + '/mcp/');
    }

    // Remove duplicates while preserving order
    const uniqueUrls = [...new Set(urlsToTry)];

    // Test each URL
    for (const url of uniqueUrls) {
      if (await testEndpoint(url)) {
        return url;
      }
    }

    // None worked
    throw new Error(
      `Failed to discover MCP endpoint. Tried:\n` +
        uniqueUrls.map((url, i) => `  ${i + 1}. ${url}`).join('\n') +
        '\n' +
        `None responded to MCP protocol.`
    );
  }

  /**
   * Normalize agent config - mark all MCP agents for discovery
   *
   * We always test the endpoint they give us, and if it doesn't work,
   * we try adding /mcp. Simple.
   */
  private normalizeAgentConfig(agent: AgentConfig): AgentConfig {
    if (agent.protocol !== 'mcp') {
      return agent;
    }

    // Mark for discovery - we'll test their path, then try adding /mcp
    return {
      ...agent,
      _needsDiscovery: true,
    } as any;
  }

  /**
   * Handle webhook from agent (async task completion)
   *
   * @param payload - Webhook payload from agent
   * @param signature - X-ADCP-Signature header (format: "sha256=...")
   * @param timestamp - X-ADCP-Timestamp header (Unix timestamp)
   * @returns Whether webhook was handled successfully
   *
   * @example
   * ```typescript
   * app.post('/webhook', async (req, res) => {
   *   const signature = req.headers['x-adcp-signature'];
   *   const timestamp = req.headers['x-adcp-timestamp'];
   *
   *   try *     const handled = await client.handleWebhook(req.body, signature, timestamp);
   *     res.status(200).json({ received: handled });
   *   } catch (error) {
   *     res.status(401).json({ error: error.message });
   *   }
   * });
   * ```
   */
  async handleWebhook(payload: WebhookPayload, signature?: string, timestamp?: string | number): Promise<boolean> {
    // Verify signature if secret is configured
    if (this.config.webhookSecret) {
      if (!signature || !timestamp) {
        throw new Error('Webhook signature and timestamp required but not provided');
      }

      const isValid = this.verifyWebhookSignature(payload, signature, timestamp);
      if (!isValid) {
        throw new Error('Invalid webhook signature or timestamp too old');
      }
    }

    // Emit activity
    await this.config.onActivity?.({
      type: 'webhook_received',
      operation_id: payload.operation_id,
      agent_id: this.agent.id,
      context_id: payload.context_id,
      task_id: payload.task_id,
      task_type: payload.task_type,
      status: payload.status,
      payload: payload.result,
      timestamp: payload.timestamp || new Date().toISOString(),
    });

    // Handle through async handler if configured
    if (this.asyncHandler) {
      await this.asyncHandler.handleWebhook(payload, this.agent.id);
      return true;
    }

    return false;
  }

  /**
   * Generate webhook URL using macro substitution
   *
   * @param taskType - Type of task (e.g., 'get_products', 'media_buy_delivery')
   * @param operationId - Operation ID for this request
   * @returns Full webhook URL with macros replaced
   *
   * @example
   * ```typescript
   * // With template: "https://myapp.com/webhook/{task_type}/{agent_id}/{operation_id}"
   * const webhookUrl = client.getWebhookUrl('sync_creatives', 'op_123');
   * // Returns: https://myapp.com/webhook/sync_creatives/agent_x/op_123
   *
   * // With template: "https://myapp.com/webhook?agent={agent_id}&op={operation_id}"
   * const webhookUrl = client.getWebhookUrl('sync_creatives', 'op_123');
   * // Returns: https://myapp.com/webhook?agent=agent_x&op=op_123
   * ```
   */
  getWebhookUrl(taskType: string, operationId: string): string {
    if (!this.config.webhookUrlTemplate) {
      throw new Error('webhookUrlTemplate not configured - cannot generate webhook URL');
    }

    // Macro substitution
    return this.config.webhookUrlTemplate
      .replace(/{agent_id}/g, this.agent.id)
      .replace(/{task_type}/g, taskType)
      .replace(/{operation_id}/g, operationId);
  }

  /**
   * Create an HTTP webhook handler that automatically verifies signatures
   *
   * This helper creates a standard HTTP handler (Express/Next.js/etc.) that:
   * - Extracts X-ADCP-Signature and X-ADCP-Timestamp headers
   * - Verifies HMAC signature (if webhookSecret configured)
   * - Validates timestamp freshness
   * - Calls handleWebhook() with proper error handling
   *
   * @returns HTTP handler function compatible with Express, Next.js, etc.
   *
   * @example Express
   * ```typescript
   * const client = new ADCPClient(agent, {
   *   webhookSecret: 'your-secret-key',
   *   handlers: {
   *     onSyncCreativesStatusChange: async (result) => {
   *       console.log('Creative synced:', result);
   *     }
   *   }
   * });
   *
   * app.post('/webhook', client.createWebhookHandler());
   * ```
   *
   * @example Next.js API Route
   * ```typescript
   * export default client.createWebhookHandler();
   * ```
   */
  createWebhookHandler() {
    return async (req: any, res: any) => {
      try {
        // Extract headers (case-insensitive)
        const signature = req.headers['x-adcp-signature'] || req.headers['X-ADCP-Signature'];
        const timestamp = req.headers['x-adcp-timestamp'] || req.headers['X-ADCP-Timestamp'];

        // Parse body if needed
        const payload = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;

        // Handle webhook with automatic verification
        const handled = await this.handleWebhook(payload, signature, timestamp);

        // Return success
        if (res.json) {
          res.status(202).json({ status: 'accepted', received: handled });
        } else {
          res.writeHead(202, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'accepted', received: handled }));
        }
      } catch (error: any) {
        // Return error
        const statusCode = error.message.includes('signature') || error.message.includes('timestamp') ? 401 : 500;

        if (res.json) {
          res.status(statusCode).json({ error: error.message });
        } else {
          res.writeHead(statusCode, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: error.message }));
        }
      }
    };
  }

  /**
   * Verify webhook signature using HMAC-SHA256 per AdCP PR #86 spec
   *
   * Signature format: sha256={hex_signature}
   * Message format: {timestamp}.{json_payload}
   *
   * @param payload - Webhook payload object
   * @param signature - X-ADCP-Signature header value (format: "sha256=...")
   * @param timestamp - X-ADCP-Timestamp header value (Unix timestamp)
   * @returns true if signature is valid
   */
  verifyWebhookSignature(payload: any, signature: string, timestamp: string | number): boolean {
    if (!this.config.webhookSecret) {
      return false;
    }

    // Validate timestamp freshness (reject requests older than 5 minutes)
    const now = Math.floor(Date.now() / 1000);
    const ts = typeof timestamp === 'string' ? parseInt(timestamp) : timestamp;

    if (Math.abs(now - ts) > 300) {
      return false; // Request too old or from future
    }

    // Build message per AdCP spec: {timestamp}.{json_payload}
    const message = `${ts}.${JSON.stringify(payload)}`;

    // Calculate expected signature
    const hmac = crypto.createHmac('sha256', this.config.webhookSecret);
    hmac.update(message);
    const expectedSignature = `sha256=${hmac.digest('hex')}`;

    // Constant-time comparison to prevent timing attacks
    // Check length first to avoid timingSafeEqual error
    if (signature.length !== expectedSignature.length) {
      return false;
    }

    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature));
  }

  /**
   * Execute task and call appropriate handler on completion
   */
  private async executeAndHandle<T>(
    taskType: string,
    handlerName: keyof AsyncHandlerConfig,
    params: any,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<T>> {
    // Validate request params against schema
    this.validateRequest(taskType, params);

    const agent = await this.ensureEndpointDiscovered();
    const result = await this.executor.executeTask<T>(agent, taskType, params, inputHandler, options);

    // Call handler if task completed successfully and handler is configured
    if (result.status === 'completed' && result.success && this.asyncHandler) {
      const handler = this.config.handlers?.[handlerName] as any;
      if (handler) {
        const metadata = {
          operation_id: options?.contextId || 'sync',
          context_id: options?.contextId,
          task_id: result.metadata.taskId,
          agent_id: this.agent.id,
          task_type: taskType,
          timestamp: new Date().toISOString(),
        };
        await handler(result.data, metadata);
      }
    }

    return result;
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
    return this.executeAndHandle<GetProductsResponse>(
      'get_products',
      'onGetProductsStatusChange',
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
    return this.executeAndHandle<ListCreativeFormatsResponse>(
      'list_creative_formats',
      'onListCreativeFormatsStatusChange',
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
    // Auto-inject reporting_webhook if supported and not provided by caller
    // Generates a media_buy_delivery webhook URL using operation_id pattern: delivery_report_{agent_id}_{YYYY-MM}
    if (!params?.reporting_webhook && this.config.webhookUrlTemplate) {
      const now = new Date();
      const year = now.getUTCFullYear();
      const month = String(now.getUTCMonth() + 1).padStart(2, '0');
      const operationId = `delivery_report_${this.agent.id}_${year}-${month}`;
      const deliveryWebhookUrl = this.getWebhookUrl('media_buy_delivery', operationId);

      params = {
        ...params,
        reporting_webhook: {
          url: deliveryWebhookUrl,
          authentication: {
            schemes: ['HMAC-SHA256'],
            credentials: this.config.webhookSecret || 'placeholder_secret_min_32_characters_required',
          },
          reporting_frequency: 'monthly',
        },
      } as CreateMediaBuyRequest;
    }

    return this.executeAndHandle<CreateMediaBuyResponse>(
      'create_media_buy',
      'onCreateMediaBuyStatusChange',
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
    return this.executeAndHandle<UpdateMediaBuyResponse>(
      'update_media_buy',
      'onUpdateMediaBuyStatusChange',
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
    return this.executeAndHandle<SyncCreativesResponse>(
      'sync_creatives',
      'onSyncCreativesStatusChange',
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
    return this.executeAndHandle<ListCreativesResponse>(
      'list_creatives',
      'onListCreativesStatusChange',
      params,
      inputHandler,
      options
    );
  }

  /**
   * Preview a creative
   *
   * @param params - Preview creative parameters
   * @param inputHandler - Handler for clarification requests
   * @param options - Task execution options
   */
  async previewCreative(
    params: PreviewCreativeRequest,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<PreviewCreativeResponse>> {
    return this.executeAndHandle<PreviewCreativeResponse>(
      'preview_creative',
      'onPreviewCreativeStatusChange',
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
    return this.executeAndHandle<GetMediaBuyDeliveryResponse>(
      'get_media_buy_delivery',
      'onGetMediaBuyDeliveryStatusChange',
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
    return this.executeAndHandle<ListAuthorizedPropertiesResponse>(
      'list_authorized_properties',
      'onListAuthorizedPropertiesStatusChange',
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
    return this.executeAndHandle<ProvidePerformanceFeedbackResponse>(
      'provide_performance_feedback',
      'onProvidePerformanceFeedbackStatusChange',
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
    return this.executeAndHandle<GetSignalsResponse>(
      'get_signals',
      'onGetSignalsStatusChange',
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
    return this.executeAndHandle<ActivateSignalResponse>(
      'activate_signal',
      'onActivateSignalStatusChange',
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
    const agent = await this.ensureEndpointDiscovered();
    return this.executor.executeTask<T>(agent, taskName, params, inputHandler, options);
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
  async resumeDeferredTask<T = any>(token: string, inputHandler: InputHandler): Promise<TaskResult<T>> {
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
    const agent = await this.ensureEndpointDiscovered();
    return this.executor.executeTask<T>(agent, 'continue_conversation', { message }, inputHandler, { contextId });
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
    return this.executor.getActiveTasks().filter((task: any) => task.agent.id === this.agent.id);
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
    const agent = await this.ensureEndpointDiscovered();
    return this.executor.registerWebhook(agent, webhookUrl, taskTypes);
  }

  /**
   * Unregister webhook notifications
   */
  async unregisterWebhook(): Promise<void> {
    const agent = await this.ensureEndpointDiscovered();
    return this.executor.unregisterWebhook(agent);
  }

  // ====== AGENT DISCOVERY METHODS ======

  /**
   * Get comprehensive agent information including name, description, and available tools/skills
   *
   * Works with both MCP (tools) and A2A (skills) protocols to discover what the agent can do.
   *
   * @returns Promise resolving to agent information including tools
   *
   * @example
   * ```typescript
   * const client = new ADCPClient(agentConfig);
   * const info = await client.getAgentInfo();
   *
   * console.log(`${info.name}: ${info.description}`);
   * console.log(`Supports ${info.tools.length} tools`);
   *
   * info.tools.forEach(tool => {
   *   console.log(`  - ${tool.name}: ${tool.description}`);
   * });
   * ```
   */
  async getAgentInfo(): Promise<{
    name: string;
    description?: string;
    protocol: 'mcp' | 'a2a';
    url: string;
    tools: Array<{
      name: string;
      description?: string;
      inputSchema?: any;
      parameters?: string[];
    }>;
  }> {
    if (this.agent.protocol === 'mcp') {
      // Discover endpoint if needed
      const agent = await this.ensureEndpointDiscovered();

      // Use MCP SDK to list tools
      const { Client: MCPClient } = await import('@modelcontextprotocol/sdk/client/index.js');
      const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');

      const mcpClient = new MCPClient({
        name: 'AdCP-Client',
        version: '1.0.0',
      });

      const authToken = this.agent.auth_token_env;
      const customFetch = authToken
        ? async (input: any, init?: any) => {
            // IMPORTANT: Must preserve SDK's default headers (especially Accept header)
            // Convert existing headers to plain object for merging
            let existingHeaders: Record<string, string> = {};
            if (init?.headers) {
              if (init.headers instanceof Headers) {
                // Headers object - use forEach to extract all headers
                init.headers.forEach((value: string, key: string) => {
                  existingHeaders[key] = value;
                });
              } else if (Array.isArray(init.headers)) {
                // Array of [key, value] tuples
                for (const [key, value] of init.headers) {
                  existingHeaders[key] = value;
                }
              } else {
                // Plain object - copy all properties
                for (const key in init.headers) {
                  if (Object.prototype.hasOwnProperty.call(init.headers, key)) {
                    existingHeaders[key] = init.headers[key] as string;
                  }
                }
              }
            }

            // Merge auth headers with existing headers
            // Keep existing headers (including Accept) and only add/override with auth headers
            const headers = {
              ...existingHeaders,
              Authorization: `Bearer ${authToken}`,
              'x-adcp-auth': authToken,
            };
            return fetch(input, { ...init, headers });
          }
        : undefined;

      const transport = new StreamableHTTPClientTransport(
        new URL(agent.agent_uri),
        customFetch ? { fetch: customFetch } : {}
      );

      await mcpClient.connect(transport);
      const toolsList = await mcpClient.listTools();
      await mcpClient.close();

      const tools = toolsList.tools.map(tool => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        parameters: tool.inputSchema?.properties ? Object.keys(tool.inputSchema.properties) : [],
      }));

      return {
        name: this.agent.name,
        description: undefined,
        protocol: this.agent.protocol,
        url: agent.agent_uri,
        tools,
      };
    } else if (this.agent.protocol === 'a2a') {
      // Use A2A SDK to get agent card
      const clientModule = require('@a2a-js/sdk/client');
      const A2AClient = clientModule.A2AClient;

      const authToken = this.agent.auth_token_env;
      const fetchImpl = authToken
        ? async (url: any, options?: any) => {
            const headers = {
              ...options?.headers,
              Authorization: `Bearer ${authToken}`,
              'x-adcp-auth': authToken,
            };
            return fetch(url, { ...options, headers });
          }
        : undefined;

      const cardUrl = this.normalizedAgent.agent_uri.endsWith('/.well-known/agent-card.json')
        ? this.normalizedAgent.agent_uri
        : this.normalizedAgent.agent_uri.replace(/\/$/, '') + '/.well-known/agent-card.json';

      const client = await A2AClient.fromCardUrl(cardUrl, fetchImpl ? { fetchImpl } : {});
      const agentCard = client.agentCardPromise ? await client.agentCardPromise : client.agentCard;

      const tools = agentCard?.skills
        ? agentCard.skills.map((skill: any) => ({
            name: skill.name,
            description: skill.description,
            inputSchema: skill.inputSchema,
            parameters: skill.inputFormats || [],
          }))
        : [];

      return {
        name: agentCard?.displayName || agentCard?.name || this.agent.name,
        description: agentCard?.description,
        protocol: this.agent.protocol,
        url: this.normalizedAgent.agent_uri,
        tools,
      };
    }

    throw new Error(`Unsupported protocol: ${this.agent.protocol}`);
  }

  // ====== STATIC HELPER METHODS ======

  /**
   * Query a creative agent to discover available creative formats
   *
   * This is a static utility method that allows you to query any creative agent
   * (like creative.adcontextprotocol.org) to discover what formats are available
   * before creating a media buy.
   *
   * @param creativeAgentUrl - URL of the creative agent (e.g., 'https://creative.adcontextprotocol.org/mcp')
   * @param protocol - Protocol to use ('mcp' or 'a2a'), defaults to 'mcp'
   * @returns Promise resolving to the list of available formats
   *
   * @example
   * ```typescript
   * // Discover formats from the standard creative agent
   * const formats = await SingleAgentClient.discoverCreativeFormats(
   *   'https://creative.adcontextprotocol.org/mcp'
   * );
   *
   * // Find a specific format
   * const banner = formats.find(f => f.format_id.id === 'display_300x250_image');
   *
   * // Use the format in a media buy
   * await salesAgent.createMediaBuy({
   *   packages: [{
   *     format_ids: [{
   *       agent_url: banner.format_id.agent_url,
   *       id: banner.format_id.id
   *     }]
   *   }]
   * });
   * ```
   */
  static async discoverCreativeFormats(creativeAgentUrl: string, protocol: 'mcp' | 'a2a' = 'mcp'): Promise<Format[]> {
    const client = new SingleAgentClient(
      {
        id: 'creative_agent_discovery',
        name: 'Creative Agent',
        agent_uri: creativeAgentUrl,
        protocol,
      },
      {}
    );

    const result = await client.listCreativeFormats({});

    if (!result.success || !result.data) {
      throw new Error(`Failed to discover creative formats: ${result.error || 'Unknown error'}`);
    }

    return result.data.formats || [];
  }

  /**
   * Validate request parameters against AdCP schema
   */
  private validateRequest(taskType: string, params: any): void {
    const schema = this.getRequestSchema(taskType);
    if (!schema) {
      return; // No schema available for this task type
    }

    try {
      // Use strict() to reject unknown keys instead of stripping them
      // This ensures we fail fast on typos and invalid top-level fields
      // NOTE: Nested objects will still use default Zod behavior (strip unknown fields)
      // to maintain compatibility with agent implementations that may include extra metadata
      if (schema instanceof z.ZodObject) {
        schema.strict().parse(params);
      } else {
        schema.parse(params);
      }
    } catch (error) {
      if (error instanceof z.ZodError) {
        const issues = error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
        throw new Error(`Request validation failed for ${taskType}: ${issues}`);
      }
      throw error;
    }
  }

  /**
   * Get request schema for a given task type
   */
  private getRequestSchema(taskType: string): z.ZodSchema | null {
    // Only include schemas that exist (some may not be auto-generated)
    const schemaMap: Partial<Record<string, z.ZodSchema>> = {
      list_creative_formats: schemas.ListCreativeFormatsRequestSchema,
      list_creatives: schemas.ListCreativesRequestSchema,
      sync_creatives: schemas.SyncCreativesRequestSchema,
      create_media_buy: schemas.CreateMediaBuyRequestSchema,
      build_creative: schemas.BuildCreativeRequestSchema,
      get_products: schemas.GetProductsRequestSchema,
      update_media_buy: schemas.UpdateMediaBuyRequestSchema,
      get_media_buy_delivery: schemas.GetMediaBuyDeliveryRequestSchema,
      list_authorized_properties: schemas.ListAuthorizedPropertiesRequestSchema,
      provide_performance_feedback: schemas.ProvidePerformanceFeedbackRequestSchema,
      get_signals: schemas.GetSignalsRequestSchema,
      activate_signal: schemas.ActivateSignalRequestSchema,
      preview_creative: schemas.PreviewCreativeRequestSchema,
    };

    return schemaMap[taskType] || null;
  }
}

/**
 * Factory function to create a single-agent client (internal use)
 *
 * @param agent - Agent configuration
 * @param config - Client configuration
 * @returns Configured SingleAgentClient instance
 * @internal
 */
export function createSingleAgentClient(agent: AgentConfig, config?: SingleAgentClientConfig): SingleAgentClient {
  return new SingleAgentClient(agent, config);
}
