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
  GetSignalsRequest,
  GetSignalsResponse,
  ActivateSignalRequest,
  ActivateSignalResponse,
  PreviewCreativeRequest,
  PreviewCreativeResponse,
  Format,
  GetAdCPCapabilitiesRequest,
  GetAdCPCapabilitiesResponse,
} from '../types/tools.generated';

import type {
  MCPWebhookPayload,
  AdCPAsyncResponseData,
  TaskStatus,
  CreateMediaBuyResponse,
} from '../types/core.generated';
import type { Task as A2ATask, TaskStatusUpdateEvent } from '@a2a-js/sdk';

import { TaskExecutor, DeferredTaskError } from './TaskExecutor';
import type { InputHandler, TaskOptions, TaskResult, ConversationConfig, TaskInfo } from './ConversationTypes';
import type { Activity, AsyncHandlerConfig, WebhookMetadata } from './AsyncHandler';
import { AsyncHandler } from './AsyncHandler';
import { unwrapProtocolResponse } from '../utils/response-unwrapper';
import * as crypto from 'crypto';

// v3.0 compatibility utilities
import type { AdcpCapabilities, ToolInfo } from '../utils/capabilities';
import { buildSyntheticCapabilities, parseCapabilitiesResponse } from '../utils/capabilities';
import {
  adaptCreateMediaBuyRequestForV2,
  adaptUpdateMediaBuyRequestForV2,
  normalizeMediaBuyResponse,
} from '../utils/creative-adapter';
import { normalizeFormatsResponse } from '../utils/format-renders';
import { normalizePreviewCreativeResponse } from '../utils/preview-normalizer';
import { normalizeGetProductsResponse } from '../utils/pricing-adapter';

/**
 * Error class for v3 feature compatibility issues
 *
 * Note: The library no longer throws this error for get_products calls with
 * unsupported v3 features. Instead, it returns an empty result (semantically
 * "no products match this filter"). This error class is exported for use in
 * custom validation logic or other scenarios.
 *
 * @example
 * ```typescript
 * // Custom validation before making requests
 * const capabilities = await client.getCapabilities();
 * if (params.property_list && !capabilities.features.propertyListFiltering) {
 *   throw new UnsupportedFeatureError('property_list', capabilities.version);
 * }
 * ```
 */
export class UnsupportedFeatureError extends Error {
  constructor(
    public readonly feature: string,
    public readonly serverVersion: 'v2' | 'v3',
    message?: string
  ) {
    super(message || `Feature '${feature}' requires AdCP v3 but server is ${serverVersion}`);
    this.name = 'UnsupportedFeatureError';
  }
}

type NormalizedWebhookPayload = {
  operation_id: string;
  task_id: string;
  task_type: string;
  status: TaskStatus;
  context_id?: string;
  result?: AdCPAsyncResponseData;
  message?: string;
  timestamp?: string;
};

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
   * Reporting webhook frequency
   *
   * @default 'daily'
   */
  reportingWebhookFrequency?: 'hourly' | 'daily' | 'monthly';
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
  private discoveredEndpoint?: string; // Cache discovered MCP endpoint
  private canonicalBaseUrl?: string; // Cache canonical base URL (from agent card or stripped /mcp)
  private cachedCapabilities?: AdcpCapabilities; // Cache detected server capabilities

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
   * Also computes the canonical base URL by stripping /mcp suffix.
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

    // Compute canonical base URL by stripping /mcp suffix
    this.canonicalBaseUrl = this.computeBaseUrl(this.discoveredEndpoint);

    return {
      ...this.normalizedAgent,
      agent_uri: this.discoveredEndpoint,
    };
  }

  /**
   * Ensure A2A canonical URL is resolved (lazy initialization)
   *
   * Fetches the agent card and extracts the canonical URL.
   * Returns the agent config with the canonical URL.
   */
  private async ensureCanonicalUrlResolved(): Promise<AgentConfig> {
    const needsCanonicalUrl = (this.normalizedAgent as any)._needsCanonicalUrl;

    if (!needsCanonicalUrl) {
      return this.normalizedAgent;
    }

    // Already resolved? Use cached value
    if (this.canonicalBaseUrl) {
      return {
        ...this.normalizedAgent,
        agent_uri: this.canonicalBaseUrl,
      };
    }

    // Fetch agent card to get canonical URL
    const canonicalUrl = await this.fetchA2ACanonicalUrl(this.normalizedAgent.agent_uri);
    this.canonicalBaseUrl = canonicalUrl;

    return {
      ...this.normalizedAgent,
      agent_uri: canonicalUrl,
    };
  }

  /**
   * Fetch the canonical URL from an A2A agent card
   */
  private async fetchA2ACanonicalUrl(agentUri: string): Promise<string> {
    const clientModule = require('@a2a-js/sdk/client');
    const A2AClient = clientModule.A2AClient;

    const authToken = this.normalizedAgent.auth_token;
    const fetchImpl = authToken
      ? async (url: string | URL | Request, options?: RequestInit) => {
          const headers: Record<string, string> = {
            ...(options?.headers as Record<string, string>),
            Authorization: `Bearer ${authToken}`,
            'x-adcp-auth': authToken,
          };
          return fetch(url, { ...options, headers });
        }
      : undefined;

    // Construct agent card URL
    const cardUrl = agentUri.endsWith('/.well-known/agent-card.json')
      ? agentUri
      : agentUri.replace(/\/$/, '') + '/.well-known/agent-card.json';

    const client = await A2AClient.fromCardUrl(cardUrl, fetchImpl ? { fetchImpl } : {});
    const agentCard = client.agentCardPromise ? await client.agentCardPromise : client.agentCard;

    // Use the canonical URL from the agent card, falling back to computed base URL
    if (agentCard?.url) {
      return agentCard.url;
    }

    // Fallback: strip .well-known/agent-card.json if present
    return this.computeBaseUrl(agentUri);
  }

  /**
   * Compute base URL by stripping protocol-specific suffixes
   *
   * - Strips /mcp or /mcp/ suffix for MCP endpoints
   * - Strips /.well-known/agent-card.json for A2A discovery URLs
   * - Strips trailing slash for consistency
   */
  private computeBaseUrl(url: string): string {
    let baseUrl = url;

    // Strip /.well-known/agent-card.json
    if (baseUrl.match(/\/\.well-known\/agent-card\.json$/i)) {
      baseUrl = baseUrl.replace(/\/\.well-known\/agent-card\.json$/i, '');
    }

    // Strip /mcp or /mcp/
    if (baseUrl.match(/\/mcp\/?$/i)) {
      baseUrl = baseUrl.replace(/\/mcp\/?$/i, '');
    }

    // Strip trailing slash for consistency
    baseUrl = baseUrl.replace(/\/$/, '');

    return baseUrl;
  }

  /**
   * Check if URL is a .well-known/agent-card.json URL
   *
   * These URLs are A2A agent card discovery URLs and should use A2A protocol.
   * Only matches when .well-known is at the root path (not in a subdirectory).
   */
  private isWellKnownAgentCardUrl(url: string): boolean {
    // Match: https://example.com/.well-known/agent-card.json
    // Don't match: https://example.com/api/.well-known/agent-card.json
    return /^https?:\/\/[^/]+\/\.well-known\/agent-card\.json$/i.test(url);
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

    const authToken = this.agent.auth_token;

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
   * Normalize agent config
   *
   * - If URL is a .well-known/agent-card.json URL, switch to A2A protocol
   *   (these are A2A discovery URLs, not MCP endpoints)
   * - A2A agents are marked for canonical URL resolution (from agent card)
   * - MCP agents are marked for endpoint discovery
   */
  private normalizeAgentConfig(agent: AgentConfig): AgentConfig {
    // If URL is a well-known agent card URL, use A2A protocol regardless of what was specified
    // Mark for canonical URL resolution - we'll fetch the agent card and use its url field
    if (this.isWellKnownAgentCardUrl(agent.agent_uri)) {
      return {
        ...agent,
        protocol: 'a2a',
        _needsCanonicalUrl: true,
      } as any;
    }

    if (agent.protocol === 'a2a') {
      // A2A agents need canonical URL resolution from agent card
      return {
        ...agent,
        _needsCanonicalUrl: true,
      } as any;
    }

    if (agent.protocol !== 'mcp') {
      return agent;
    }

    // MCP agents need endpoint discovery - we'll test their path, then try adding /mcp
    return {
      ...agent,
      _needsDiscovery: true,
    } as any;
  }

  /**
   * Handle webhook from agent (async task status updates and completions)
   *
   * Accepts webhook payloads from both MCP and A2A protocols:
   * 1. MCP: MCPWebhookPayload envelope with AdCP data in .result field
   * 2. A2A: Native Task/TaskStatusUpdateEvent with AdCP data in either:
   *    - status.message.parts[].data (for status updates)
   *    - artifacts (for task completion, per A2A spec)
   *
   * The method normalizes both formats so handlers receive the unwrapped
   * AdCP response data (AdCPAsyncResponseData), not the raw protocol structure.
   *
   * @param payload - Protocol-specific webhook payload (MCPWebhookPayload | Task | TaskStatusUpdateEvent)
   * @param taskType - Task type (e.g create_media_buy) from url param or url part of the webhook delivery
   * @param operationId - Operation id (e.g used for client app to track the operation) from the param or url part of the webhook delivery
   * @param signature - X-ADCP-Signature header (format: "sha256=...")
   * @param timestamp - X-ADCP-Timestamp header (Unix timestamp)
   * @returns Whether webhook was handled successfully
   *
   * @example
   * ```typescript
   * app.post('/webhook/:taskType', async (req, res) => {
   *   const signature = req.headers['x-adcp-signature'];
   *   const timestamp = req.headers['x-adcp-timestamp'];
   *
   *   try {
   *     const handled = await client.handleWebhook(req.body, signature, timestamp, req.params.taskType);
   *     res.status(200).json({ received: handled });
   *   } catch (error) {
   *     res.status(401).json({ error: error.message });
   *   }
   * });
   * ```
   */
  async handleWebhook(
    payload: MCPWebhookPayload | A2ATask | TaskStatusUpdateEvent,
    taskType: string,
    operationId: string,
    signature?: string,
    timestamp?: string | number
  ): Promise<boolean> {
    // Verify signature if secret is configured
    if (this.config.webhookSecret) {
      if (!signature || !timestamp) {
        throw new Error('Webhook signature and timestamp required but not provided');
      }

      const isValid = this.verifyWebhookSignature(payload, signature, timestamp);
      if (!isValid) {
        throw new Error('Invalid webhook signature or timestamp too old');
      }

      console.log('[ADCP Client]: Webhook signature is valid');
    }

    // Transform raw protocol payload to normalized format
    const normalizedPayload = this.normalizeWebhookPayload(payload, taskType, operationId);

    const metadata: WebhookMetadata = {
      operation_id: normalizedPayload.operation_id,
      context_id: normalizedPayload.context_id,
      task_id: normalizedPayload.task_id,
      agent_id: this.agent.id,
      task_type: normalizedPayload.task_type,
      status: normalizedPayload.status,
      message: normalizedPayload.message,
      timestamp: normalizedPayload.timestamp || new Date().toISOString(),
    };

    // Emit activity
    await this.config.onActivity?.({
      type: 'webhook_received',
      operation_id: metadata.operation_id,
      agent_id: metadata.agent_id,
      context_id: metadata.context_id,
      task_id: metadata.task_id,
      task_type: metadata.task_type,
      status: metadata.status,
      payload: normalizedPayload.result,
      timestamp: metadata.timestamp,
    });

    // Handle through async handler if configured
    if (this.asyncHandler) {
      await this.asyncHandler.handleWebhook({ result: normalizedPayload.result, metadata });
      return true;
    }

    return false;
  }

  /**
   * Normalize webhook payload - handles both MCP and A2A webhook formats
   *
   * MCP: Uses MCPWebhookPayload envelope with AdCP data in .result field
   * A2A: Uses native Task/TaskStatusUpdateEvent messages with AdCP data in either:
   *      - status.message.parts[].data (for status updates)
   *      - artifacts (for task completion responses, per A2A spec)
   *
   * @param payload - Protocol-specific webhook payload (MCPWebhookPayload | Task | TaskStatusUpdateEvent)
   * @param taskType - Task type override
   * @param operationId - Operation id
   * @returns Normalized webhook payload with extracted AdCP response
   */
  private normalizeWebhookPayload(
    payload: MCPWebhookPayload | A2ATask | TaskStatusUpdateEvent,
    taskType: string,
    operationId: string
  ): NormalizedWebhookPayload {
    // 1. Check for MCP Webhook Payload (has task_id, status, task_type fields)
    if ('task_id' in payload && 'task_type' in payload && 'status' in payload) {
      const mcpPayload = payload as MCPWebhookPayload;
      return {
        operation_id: operationId || 'unknown',
        context_id: mcpPayload.context_id,
        task_id: mcpPayload.task_id,
        task_type: taskType,
        status: mcpPayload.status,
        result: mcpPayload.result,
        message: mcpPayload.message,
        timestamp: mcpPayload.timestamp,
      };
    }

    // 2. Check for A2A Task or TaskStatusUpdateEvent
    if ('kind' in payload && (payload.kind === 'task' || payload.kind === 'status-update')) {
      const a2aPayload = payload as A2ATask | TaskStatusUpdateEvent;
      const a2aStatus = a2aPayload.status?.state || 'unknown';
      let result: AdCPAsyncResponseData | undefined = undefined;

      // Try to extract data from status.message.parts first (for status updates)
      const parts = a2aPayload.status?.message?.parts;
      if (parts && Array.isArray(parts)) {
        const dataPart = parts.find(p => 'data' in p && p.kind === 'data');
        if (dataPart && 'data' in dataPart) {
          result = dataPart.data as AdCPAsyncResponseData;
        }
      }

      // If not found in parts, check artifacts (standard A2A task output location)
      if (!result && 'artifacts' in a2aPayload && a2aPayload.artifacts && a2aPayload.artifacts.length > 0) {
        try {
          // Try to unwrap artifacts for all statuses
          result = unwrapProtocolResponse({ result: a2aPayload }, taskType, 'a2a') as AdCPAsyncResponseData;
        } catch (error) {
          console.warn('Failed to unwrap A2A webhook payload:', error);
          // Fallback: pass raw artifacts so handler has something to work with
          result = a2aPayload.artifacts as any;
        }
      }

      // Extract message part from status.message.parts (A2A Message structure)
      let message: string | undefined = undefined;
      if (a2aPayload.status?.message?.parts) {
        const textParts = a2aPayload.status.message.parts
          .filter(p => p.kind === 'text' && 'text' in p)
          .map(p => ('text' in p ? p.text : ''));
        if (textParts.length > 0) {
          message = textParts.join(' ');
        }
      }

      // Get task_id ensuring it's a string
      let taskId = 'unknown';
      if ('id' in a2aPayload && a2aPayload.id) {
        taskId = String(a2aPayload.id);
      } else if ('taskId' in a2aPayload && a2aPayload.taskId) {
        taskId = String(a2aPayload.taskId);
      }

      return {
        operation_id: operationId,
        context_id: 'contextId' in a2aPayload ? a2aPayload.contextId : undefined,
        task_id: taskId,
        task_type: taskType,
        status: a2aStatus,
        result,
        message: message,
        timestamp: a2aPayload.status?.timestamp || new Date().toISOString(),
      };
    }

    // 3. Unknown payload format
    throw new Error(
      'Unsupported webhook payload format. Expected MCPWebhookPayload, Task, or TaskStatusUpdateEvent. ' +
        `Received: ${JSON.stringify(payload).substring(0, 200)}`
    );
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
   *
   * Automatically adapts requests for v2 servers and normalizes responses.
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

    // Check for v3 features used against v2 servers - return empty result if unsupported
    const earlyResult = await this.getEarlyResultForUnsupportedFeatures<T>(taskType, params);
    if (earlyResult) {
      return earlyResult;
    }

    const agent = await this.ensureEndpointDiscovered();

    // Adapt request for v2 servers if needed
    const adaptedParams = await this.adaptRequestForServerVersion(taskType, params);

    const result = await this.executor.executeTask<T>(agent, taskType, adaptedParams, inputHandler, options);

    // Normalize response to v3 format
    if (result.success && result.data) {
      result.data = this.normalizeResponseToV3(taskType, result.data) as T;
    }

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

  /**
   * Adapt request parameters for the detected server version
   *
   * Converts v3-style requests to v2 format when talking to v2 servers.
   */
  private async adaptRequestForServerVersion(taskType: string, params: any): Promise<any> {
    // Get server version (cached after first call)
    const version = await this.detectServerVersion();

    // If server is v3, no adaptation needed
    if (version === 'v3') {
      return params;
    }

    // Adapt v3 requests for v2 servers
    switch (taskType) {
      case 'create_media_buy':
        return adaptCreateMediaBuyRequestForV2(params);

      case 'update_media_buy':
        return adaptUpdateMediaBuyRequestForV2(params);

      default:
        return params;
    }
  }

  /**
   * Normalize response to v3 format
   *
   * Converts v2 responses to v3 structure for consistent API surface.
   */
  private normalizeResponseToV3(taskType: string, data: any): any {
    switch (taskType) {
      case 'get_products':
        return normalizeGetProductsResponse(data);

      case 'list_creative_formats':
        return normalizeFormatsResponse(data);

      case 'preview_creative':
        return normalizePreviewCreativeResponse(data);

      case 'create_media_buy':
      case 'update_media_buy':
        return normalizeMediaBuyResponse(data);

      default:
        return data;
    }
  }

  /**
   * Check if request uses v3 features that the server doesn't support
   *
   * Returns an early empty result if the request requires v3 features
   * that the server doesn't support. This treats "products matching unsupported
   * capability" as an empty result set rather than an error.
   *
   * @returns TaskResult with empty data if v3 features are unsupported, null to proceed normally
   */
  private async getEarlyResultForUnsupportedFeatures<T>(taskType: string, params: any): Promise<TaskResult<T> | null> {
    // Only check for tasks that have v3-specific features
    if (taskType !== 'get_products') {
      return null;
    }

    // Get capabilities to check what the server supports
    const capabilities = await this.getCapabilities();

    // If server is v3, all features are supported - proceed normally
    if (capabilities.version === 'v3') {
      return null;
    }

    // Check for v3-only features that would make this query return empty results
    const usesUnsupportedFeature =
      // property_list requires propertyListFiltering
      (params.property_list && !capabilities.features.propertyListFiltering) ||
      // required_features: content_standards requires contentStandards
      (params.filters?.required_features?.includes('content_standards') && !capabilities.features.contentStandards) ||
      // required_features: property_list_filtering requires propertyListFiltering
      (params.filters?.required_features?.includes('property_list_filtering') &&
        !capabilities.features.propertyListFiltering);

    if (!usesUnsupportedFeature) {
      return null; // Proceed normally
    }

    // Return empty result - semantically "no products match this filter"
    const emptyResponse = {
      products: [],
      property_list_applied: false,
    } as T;

    return {
      success: true,
      status: 'completed',
      data: emptyResponse,
      metadata: {
        taskId: `early_${Date.now()}`,
        taskName: taskType,
        agent: {
          id: this.agent.id,
          name: this.agent.name,
          protocol: this.normalizedAgent.protocol,
        },
        responseTimeMs: 0,
        timestamp: new Date().toISOString(),
        clarificationRounds: 0,
        status: 'completed',
      },
    };
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
    // Merge library defaults with consumer-provided reporting_webhook config
    // Library provides url/auth/frequency defaults, consumer can override any field
    // Generates a media_buy_delivery webhook URL using operation_id pattern: delivery_report_{agent_id}_{YYYY-MM}
    if (this.config.webhookUrlTemplate) {
      const now = new Date();
      const year = now.getUTCFullYear();
      const month = String(now.getUTCMonth() + 1).padStart(2, '0');
      const operationId = `delivery_report_${this.agent.id}_${year}-${month}`;
      const deliveryWebhookUrl = this.getWebhookUrl('media_buy_delivery', operationId);

      // Library defaults
      const libraryDefaults = {
        url: deliveryWebhookUrl,
        authentication: {
          schemes: ['HMAC-SHA256'] as const,
          credentials: this.config.webhookSecret || 'placeholder_secret_min_32_characters_required',
        },
        reporting_frequency: (this.config.reportingWebhookFrequency || 'daily') as 'hourly' | 'daily' | 'monthly',
      };

      // Deep merge: consumer overrides library defaults
      params = {
        ...params,
        reporting_webhook: {
          ...libraryDefaults,
          ...params.reporting_webhook,
          authentication: {
            ...libraryDefaults.authentication,
            ...params.reporting_webhook?.authentication,
          },
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

  // ====== PROTOCOL TASKS ======

  /**
   * Get AdCP capabilities
   *
   * @param params - Capabilities request parameters
   * @param inputHandler - Handler for clarification requests
   * @param options - Task execution options
   */
  async getAdcpCapabilities(
    params: GetAdCPCapabilitiesRequest,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<GetAdCPCapabilitiesResponse>> {
    const agent = await this.ensureEndpointDiscovered();
    return this.executor.executeTask<GetAdCPCapabilitiesResponse>(
      agent,
      'get_adcp_capabilities',
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
   * Get the agent configuration with normalized protocol
   *
   * Returns the agent config with:
   * - Protocol normalized (e.g., .well-known URLs switch to A2A)
   * - If canonical URL has been resolved, agent_uri will be the canonical URL
   *
   * For guaranteed canonical URL, use getResolvedAgent() instead.
   */
  getAgent(): AgentConfig {
    // If we have resolved the canonical URL, return config with it
    if (this.canonicalBaseUrl) {
      const { _needsDiscovery, _needsCanonicalUrl, ...cleanAgent } = this.normalizedAgent as any;
      return {
        ...cleanAgent,
        agent_uri: this.canonicalBaseUrl,
      };
    }

    // Return normalized agent without internal flags
    const { _needsDiscovery, _needsCanonicalUrl, ...cleanAgent } = this.normalizedAgent as any;
    return { ...cleanAgent };
  }

  /**
   * Get the fully resolved agent configuration
   *
   * This async method ensures the agent config has the canonical URL resolved:
   * - For A2A: Fetches the agent card and uses its 'url' field
   * - For MCP: Performs endpoint discovery
   *
   * @returns Promise resolving to agent config with canonical URL
   */
  async getResolvedAgent(): Promise<AgentConfig> {
    await this.resolveCanonicalUrl();
    return this.getAgent();
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
   * Get the agent protocol (may be normalized from original config)
   */
  getProtocol(): 'mcp' | 'a2a' {
    return this.normalizedAgent.protocol;
  }

  /**
   * Get the canonical base URL for this agent
   *
   * Returns the canonical URL if already resolved, or computes it synchronously
   * from the configured URL. For the most accurate canonical URL (especially for A2A
   * where the agent card contains the authoritative URL), use resolveCanonicalUrl() first.
   *
   * The canonical URL is:
   * - For A2A: The 'url' field from the agent card (if resolved), or base URL with
   *   /.well-known/agent-card.json stripped
   * - For MCP: The discovered endpoint with /mcp stripped
   *
   * @returns The canonical base URL (synchronous, may not be fully resolved)
   */
  getCanonicalUrl(): string {
    // Return cached canonical URL if available
    if (this.canonicalBaseUrl) {
      return this.canonicalBaseUrl;
    }

    // Compute from configured URL (best effort without network call)
    return this.computeBaseUrl(this.normalizedAgent.agent_uri);
  }

  /**
   * Resolve and return the canonical base URL for this agent
   *
   * This async method ensures the canonical URL is properly resolved:
   * - For A2A: Fetches the agent card and uses its 'url' field
   * - For MCP: Performs endpoint discovery and strips /mcp suffix
   *
   * The result is cached, so subsequent calls are fast.
   *
   * @returns Promise resolving to the canonical base URL
   */
  async resolveCanonicalUrl(): Promise<string> {
    if (this.canonicalBaseUrl) {
      return this.canonicalBaseUrl;
    }

    if (this.normalizedAgent.protocol === 'a2a') {
      await this.ensureCanonicalUrlResolved();
    } else if (this.normalizedAgent.protocol === 'mcp') {
      await this.ensureEndpointDiscovered();
    }

    return this.canonicalBaseUrl || this.computeBaseUrl(this.normalizedAgent.agent_uri);
  }

  /**
   * Check if this agent is the same as another agent
   *
   * Compares agents by their canonical base URLs. Two agents are considered
   * the same if they have the same canonical URL, regardless of:
   * - Protocol (MCP vs A2A)
   * - URL format (with/without /mcp, with/without /.well-known/agent-card.json)
   * - Trailing slashes
   *
   * @param other - Another agent configuration or SingleAgentClient to compare
   * @returns true if agents have the same canonical URL
   */
  isSameAgent(other: AgentConfig | SingleAgentClient): boolean {
    const thisUrl = this.getCanonicalUrl().toLowerCase();

    let otherUrl: string;
    if (other instanceof SingleAgentClient) {
      otherUrl = other.getCanonicalUrl().toLowerCase();
    } else {
      otherUrl = this.computeBaseUrl(other.agent_uri).toLowerCase();
    }

    return thisUrl === otherUrl;
  }

  /**
   * Async version of isSameAgent that resolves canonical URLs first
   *
   * This provides more accurate comparison for A2A agents since it fetches
   * the agent card to get the authoritative canonical URL.
   *
   * @param other - Another agent configuration or SingleAgentClient to compare
   * @returns Promise resolving to true if agents have the same canonical URL
   */
  async isSameAgentResolved(other: AgentConfig | SingleAgentClient): Promise<boolean> {
    const thisUrl = (await this.resolveCanonicalUrl()).toLowerCase();

    let otherUrl: string;
    if (other instanceof SingleAgentClient) {
      otherUrl = (await other.resolveCanonicalUrl()).toLowerCase();
    } else {
      // For raw AgentConfig, we can only compute from the URL
      otherUrl = this.computeBaseUrl(other.agent_uri).toLowerCase();
    }

    return thisUrl === otherUrl;
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
    if (this.normalizedAgent.protocol === 'mcp') {
      // Discover endpoint if needed
      const agent = await this.ensureEndpointDiscovered();

      // Use MCP SDK to list tools
      const { Client: MCPClient } = await import('@modelcontextprotocol/sdk/client/index.js');
      const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');

      const mcpClient = new MCPClient({
        name: 'AdCP-Client',
        version: '1.0.0',
      });

      const authToken = this.normalizedAgent.auth_token;
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
        name: this.normalizedAgent.name,
        description: undefined,
        protocol: this.normalizedAgent.protocol,
        url: agent.agent_uri,
        tools,
      };
    } else if (this.normalizedAgent.protocol === 'a2a') {
      // Use A2A SDK to get agent card
      const clientModule = require('@a2a-js/sdk/client');
      const A2AClient = clientModule.A2AClient;

      const authToken = this.normalizedAgent.auth_token;
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
        name: agentCard?.displayName || agentCard?.name || this.normalizedAgent.name,
        description: agentCard?.description,
        protocol: this.normalizedAgent.protocol,
        url: this.normalizedAgent.agent_uri,
        tools,
      };
    }

    throw new Error(`Unsupported protocol: ${this.normalizedAgent.protocol}`);
  }

  /**
   * Get agent capabilities, including AdCP version support
   *
   * For v3 servers, calls get_adcp_capabilities tool.
   * For v2 servers, builds synthetic capabilities from available tools.
   *
   * @returns Promise resolving to normalized capabilities object
   *
   * @example
   * ```typescript
   * const capabilities = await client.getCapabilities();
   *
   * console.log(`Server version: ${capabilities.version}`);
   * console.log(`Protocols: ${capabilities.protocols.join(', ')}`);
   *
   * if (capabilities.features.propertyListFiltering) {
   *   // Use v3 property list features
   * }
   * ```
   */
  async getCapabilities(): Promise<AdcpCapabilities> {
    // Return cached if available
    if (this.cachedCapabilities) {
      return this.cachedCapabilities;
    }

    // First get tool list to support both detection methods
    const agentInfo = await this.getAgentInfo();
    const tools: ToolInfo[] = agentInfo.tools.map(t => ({
      name: t.name,
      description: t.description,
    }));

    // Check if agent supports get_adcp_capabilities (v3)
    const hasCapabilitiesTool = tools.some(t => t.name === 'get_adcp_capabilities');

    if (hasCapabilitiesTool) {
      try {
        // Call get_adcp_capabilities tool
        const agent = await this.ensureEndpointDiscovered();
        const result = await this.executor.executeTask<any>(agent, 'get_adcp_capabilities', {}, undefined);

        if (result.success && result.data) {
          this.cachedCapabilities = parseCapabilitiesResponse(result.data);
          return this.cachedCapabilities;
        }
      } catch {
        // Fall through to synthetic capabilities
      }
    }

    // Build synthetic capabilities from tool list (v2)
    this.cachedCapabilities = buildSyntheticCapabilities(tools);
    return this.cachedCapabilities;
  }

  /**
   * Detect server AdCP version
   *
   * @returns 'v2' or 'v3' based on server capabilities
   */
  async detectServerVersion(): Promise<'v2' | 'v3'> {
    const capabilities = await this.getCapabilities();
    return capabilities.version;
  }

  /**
   * Check if server supports a specific AdCP major version
   */
  async supportsVersion(version: 2 | 3): Promise<boolean> {
    const capabilities = await this.getCapabilities();
    return capabilities.majorVersions.includes(version);
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
   * Get request schema for a given task type.
   *
   * Note: Schema validation is not available for all task types. The following
   * tasks use complex discriminated unions that cannot be represented in Zod
   * without significant runtime overhead:
   *
   * - `get_products`: Uses conditional fields based on brief vs proposal_id
   * - `update_media_buy`: Uses conditional package update operations
   *
   * For these tasks, TypeScript compile-time checking is still enforced via
   * the generated types, but runtime validation falls back to basic type checks.
   * Invalid requests will still be rejected by the server with descriptive errors.
   *
   * @internal
   */
  private getRequestSchema(taskType: string): z.ZodSchema | null {
    const schemaMap: Partial<Record<string, z.ZodSchema>> = {
      // get_products: excluded - complex discriminated unions (brief vs proposal_id)
      list_creative_formats: schemas.ListCreativeFormatsRequestSchema,
      create_media_buy: schemas.CreateMediaBuyRequestSchema,
      // update_media_buy: excluded - complex discriminated unions (package operations)
      sync_creatives: schemas.SyncCreativesRequestSchema,
      list_creatives: schemas.ListCreativesRequestSchema,
      get_media_buy_delivery: schemas.GetMediaBuyDeliveryRequestSchema,
      get_signals: schemas.GetSignalsRequestSchema,
      activate_signal: schemas.ActivateSignalRequestSchema,
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
