// Main ADCP Client - Type-safe conversation-aware client for AdCP agents

import { z } from 'zod';
import * as schemas from '../types/schemas.generated';
import type { AgentConfig } from '../types';
import { ADCP_ENVELOPE_FIELDS } from '../types/adcp';
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
  PreviewCreativeRequest,
  PreviewCreativeResponse,
  BuildCreativeRequest,
  BuildCreativeResponse,
  Format,
  GetAdCPCapabilitiesRequest,
  GetAdCPCapabilitiesResponse,
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
  SyncPlansRequest,
  SyncPlansResponse,
  GetPlanAuditLogsRequest,
  GetPlanAuditLogsResponse,
  OutcomeType,
} from '../types/tools.generated';
import { type MutatingRequestInput, generateIdempotencyKey, isMutatingTask } from '../utils/idempotency';

import type {
  MCPWebhookPayload,
  AdCPAsyncResponseData,
  TaskStatus,
  CreateMediaBuyResponse,
} from '../types/core.generated';
import type { Task as A2ATask, TaskStatusUpdateEvent } from '@a2a-js/sdk';

import { TaskExecutor, DeferredTaskError } from './TaskExecutor';
import { attachMatch } from './match';
import { createMCPAuthHeaders } from '../auth';
import {
  AuthenticationRequiredError,
  ConfigurationError,
  FeatureUnsupportedError,
  TaskTimeoutError,
  VersionUnsupportedError,
  is401Error,
} from '../errors';
import { isLikelyPrivateUrl } from '../net';
import { discoverAuthorizationRequirements, NeedsAuthorizationError } from '../auth/oauth/authorization-required';
import { discoverOAuthMetadata } from '../auth/oauth/discovery';
import type { InputHandler, TaskOptions, TaskResult, ConversationConfig, TaskInfo } from './ConversationTypes';
import type { Activity, AsyncHandlerConfig, WebhookMetadata } from './AsyncHandler';
import { AsyncHandler } from './AsyncHandler';
import { unwrapProtocolResponse } from '../utils/response-unwrapper';
import {
  isWellKnownAgentCardUrl as isWellKnownCardUrl,
  buildCardUrls,
  stripAgentCardPath,
  stripTransportSuffix,
} from '../utils/a2a-discovery';
import * as crypto from 'crypto';

// v3.0 compatibility utilities
import type { AdcpCapabilities, ToolInfo, FeatureName } from '../utils/capabilities';
import {
  buildSyntheticCapabilities,
  augmentCapabilitiesFromTools,
  parseCapabilitiesResponse,
  resolveFeature,
  listDeclaredFeatures,
  TASK_FEATURE_MAP,
} from '../utils/capabilities';
import {
  adaptCreateMediaBuyRequestForV2,
  adaptUpdateMediaBuyRequestForV2,
  normalizeMediaBuyResponse,
} from '../utils/creative-adapter';
import { adaptSyncCreativesRequestForV2 } from '../utils/sync-creatives-adapter';
import { normalizeFormatsResponse } from '../utils/format-renders';
import { normalizePreviewCreativeResponse } from '../utils/preview-normalizer';
import { normalizeGetProductsResponse, adaptGetProductsRequestForV2 } from '../utils/pricing-adapter';
import { normalizeRequestParams } from '../utils/request-normalizer';
import { validateUserAgent } from '../utils/validate-user-agent';

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

/** AgentConfig with internal flags for lazy discovery */
type InternalAgentConfig = AgentConfig & {
  _needsDiscovery?: boolean;
  _needsCanonicalUrl?: boolean;
};

type NormalizedWebhookPayload = {
  operation_id: string;
  task_id: string;
  task_type: string;
  status: TaskStatus;
  context_id?: string;
  result?: AdCPAsyncResponseData;
  message?: string;
  timestamp?: string;
  idempotency_key?: string;
  protocol?: 'mcp' | 'a2a';
};

/**
 * Configuration for SingleAgentClient (and multi-agent client)
 */
export interface SingleAgentClientConfig extends ConversationConfig {
  /** Enable debug logging */
  debug?: boolean;
  /** Custom User-Agent header sent with all outbound protocol requests.
   *  Overridden by per-agent `headers['User-Agent']` if set. */
  userAgent?: string;
  /** Additional headers to include in requests */
  headers?: Record<string, string>;
  /** Activity callback for observability (logging, UI updates, etc) */
  onActivity?: (activity: Activity) => void | Promise<void>;
  /**
   * Task completion handlers — called for both sync responses and webhook
   * completions.
   *
   * For at-least-once webhook delivery, set `handlers.webhookDedup` to
   * drop duplicate retries by `idempotency_key`. See
   * `docs/guides/PUSH-NOTIFICATION-CONFIG.md#deduplication`.
   */
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
   * Validate that the seller supports required features before each task call.
   * When true, tasks like syncAudiences will fail fast with FeatureUnsupportedError
   * if the seller hasn't declared audience_targeting support.
   *
   * @default true
   */
  validateFeatures?: boolean;
  /**
   * Refuse to dispatch mutating tasks unless the seller's capabilities
   * corroborate AdCP v3. The guard requires all of:
   *   1. `major_versions` includes 3
   *   2. `adcp.idempotency.replay_ttl_seconds` is declared (spec-required)
   *   3. capabilities came from a real `get_adcp_capabilities` response
   *      (not synthesized from a tool list)
   *
   * Throws `VersionUnsupportedError` before the request is sent. Bypass
   * with `allowV2` or — process-wide as a fallback — `ADCP_ALLOW_V2=1`.
   *
   * @default false
   */
  requireV3ForMutations?: boolean;
  /**
   * Per-client bypass for the v3 guard. When `true`, the guard is off
   * regardless of the `ADCP_ALLOW_V2` env var. When `undefined`, the env
   * var is consulted as a fallback. Set explicitly in multi-tenant
   * deployments so one tenant's override can't silently disable safety
   * for another.
   */
  allowV2?: boolean;
  /**
   * Runtime schema validation options
   */
  validation?: {
    /**
     * Validate outgoing requests against the bundled AdCP JSON schema before
     * dispatch. Catches field-name drift at call-time instead of at
     * storyboard-time.
     *
     * - `strict`: throw `ValidationError` with a JSON Pointer to the bad field
     * - `warn`: log to debug logs and continue
     * - `off`: skip the validator entirely (no overhead)
     *
     * @default `strict` in dev/test, `warn` in production
     */
    requests?: import('../validation/client-hooks').ValidationMode;
    /**
     * Validate incoming responses against the bundled AdCP JSON schema.
     *
     * - `strict`: fail the task with `VALIDATION_ERROR`
     * - `warn`: log to debug logs and surface the task as successful
     * - `off`: skip the validator entirely
     *
     * Overrides `strictSchemaValidation` when set.
     *
     * @default `strict` in dev/test, `warn` in production
     */
    responses?: import('../validation/client-hooks').ValidationMode;
    /**
     * Legacy: fail tasks when response schema validation fails (default: true).
     * Superseded by `responses` above — retained for backward compat.
     * `false` maps to `responses: 'warn'` when `responses` isn't set.
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
    /**
     * Filter out invalid products from get_products responses instead of rejecting the entire response (default: false)
     *
     * When true: Each product in a get_products response is validated individually.
     * Valid products are kept, invalid products are dropped, and the response is
     * returned as long as it passes full schema validation after filtering.
     * When false: The entire response is rejected if any product fails validation.
     *
     * Only applies to get_products — all other tool responses use standard validation.
     *
     * @default false
     */
    filterInvalidProducts?: boolean;
  };
  /** Governance configuration for buyer-side campaign governance */
  governance?: import('./GovernanceTypes').GovernanceConfig;
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
  private normalizedAgent: InternalAgentConfig;
  private discoveredEndpoint?: string; // Cache discovered MCP endpoint
  private canonicalBaseUrl?: string; // Cache canonical base URL (from agent card or stripped /mcp)
  private cachedCapabilities?: AdcpCapabilities; // Cache detected server capabilities
  private cachedToolSchemas?: Map<string, Record<string, unknown>>; // inputSchema.properties per tool name
  private _v2WarningFired = false; // Gate: emit the v2-sunset warning once per client instance

  constructor(
    private agent: AgentConfig,
    private config: SingleAgentClientConfig = {}
  ) {
    // Inject userAgent into agent headers so it flows through both MCP and A2A transports
    if (config.userAgent) {
      validateUserAgent(config.userAgent);
      this.agent = {
        ...this.agent,
        headers: { 'User-Agent': config.userAgent, ...this.agent.headers },
      };
    }

    // Normalize agent URL for MCP protocol
    this.normalizedAgent = this.normalizeAgentConfig(this.agent);

    this.executor = new TaskExecutor({
      workingTimeout: config.workingTimeout || 120000, // Max 120s for working status
      defaultMaxClarifications: config.defaultMaxClarifications || 3,
      enableConversationStorage: config.persistConversations !== false,
      webhookUrlTemplate: config.webhookUrlTemplate,
      agentId: agent.id,
      webhookSecret: config.webhookSecret,
      strictSchemaValidation: config.validation?.strictSchemaValidation !== false, // Default: true
      logSchemaViolations: config.validation?.logSchemaViolations !== false, // Default: true
      filterInvalidProducts: config.validation?.filterInvalidProducts === true, // Default: false
      validation: {
        ...(config.validation?.requests != null && { requests: config.validation.requests }),
        ...(config.validation?.responses != null && { responses: config.validation.responses }),
      },
      onActivity: config.onActivity,
      governance: config.governance,
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
    const needsDiscovery = this.normalizedAgent._needsDiscovery;

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
    const needsCanonicalUrl = this.normalizedAgent._needsCanonicalUrl;

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
   *
   * Special handling for authentication errors (401):
   * - If the agent card fetch returns 401, throw AuthenticationRequiredError
   * - Check for OAuth metadata to provide helpful guidance
   */
  private async fetchA2ACanonicalUrl(agentUri: string): Promise<string> {
    const clientModule = require('@a2a-js/sdk/client');
    const A2AClient = clientModule.A2AClient;

    const authToken = this.normalizedAgent.auth_token;
    let got401 = false;

    const fetchImpl = async (url: string | URL | Request, options?: RequestInit) => {
      const headers: Record<string, string> = {
        ...(options?.headers as Record<string, string>),
        ...this.normalizedAgent.headers,
        ...(authToken && {
          Authorization: `Bearer ${authToken}`,
          'x-adcp-auth': authToken,
        }),
      };

      const response = await fetch(url, { ...options, headers });

      // Track 401 errors for later handling
      if (response.status === 401) {
        got401 = true;
      }

      return response;
    };

    const cardUrls = buildCardUrls(agentUri);

    try {
      let client: InstanceType<typeof A2AClient> | undefined;
      let lastError: Error = new Error(`A2A agent card not found at ${cardUrls.join(', ')}`);
      for (const cardUrl of cardUrls) {
        try {
          client = await A2AClient.fromCardUrl(cardUrl, { fetchImpl });
          break;
        } catch (err: unknown) {
          lastError = err as Error;
          if (got401) break;
        }
      }
      if (!client) {
        throw lastError;
      }
      const agentCard = client.agentCardPromise ? await client.agentCardPromise : client.agentCard;

      // Use the canonical URL from the agent card, falling back to computed base URL
      if (agentCard?.url) {
        return agentCard.url;
      }

      return this.computeBaseUrl(agentUri);
    } catch (error: unknown) {
      // If we got a 401, throw the richer NeedsAuthorizationError when the
      // full discovery walk succeeds; otherwise fall back to the simpler
      // one-hop AuthenticationRequiredError so behavior degrades gracefully.
      if (is401Error(error, got401)) {
        const requirements = await discoverAuthorizationRequirements(agentUri, {
          allowPrivateIp: isLikelyPrivateUrl(agentUri),
        });
        if (requirements) {
          throw new NeedsAuthorizationError(requirements);
        }
        const oauthMetadata = await discoverOAuthMetadata(agentUri);
        throw new AuthenticationRequiredError(agentUri, oauthMetadata || undefined);
      }

      // Re-throw other errors
      throw error;
    }
  }

  /**
   * Compute base URL by stripping protocol-specific suffixes
   *
   * - Strips /.well-known/agent.json or /.well-known/agent-card.json for A2A discovery URLs
   * - Strips the protocol transport suffix (/mcp, /a2a, /sse)
   * - Strips trailing slash for consistency
   */
  private computeBaseUrl(url: string): string {
    let baseUrl = stripAgentCardPath(url);
    baseUrl = stripTransportSuffix(baseUrl);
    baseUrl = baseUrl.replace(/\/$/, '');
    return baseUrl;
  }

  private isWellKnownAgentCardUrl(url: string): boolean {
    return isWellKnownCardUrl(url);
  }

  /**
   * Discover MCP endpoint by testing the provided path, then trying variants
   *
   * Strategy:
   * 1. Test the exact URL provided (preserving trailing slashes)
   * 2. If that fails, try with/without trailing slash
   * 3. If still fails and doesn't end with /mcp, try adding /mcp
   *
   * Special handling for authentication errors (401):
   * - If any endpoint returns 401, we know the server exists but requires auth
   * - We fetch OAuth metadata and throw AuthenticationRequiredError
   * - This gives consumers clear guidance on how to authenticate
   *
   * Note: This is async and called lazily on first agent interaction
   */
  private async discoverMCPEndpoint(providedUri: string): Promise<string> {
    const { connectMCPWithFallback } = await import('../protocols/mcp');

    const authToken = this.agent.auth_token;
    const agentHeaders = this.agent.headers;
    const authHeaders = { ...agentHeaders, ...createMCPAuthHeaders(authToken) };

    type EndpointTestResult = {
      success: boolean;
      status?: number;
      error?: unknown;
    };

    const testEndpoint = async (url: string): Promise<EndpointTestResult> => {
      try {
        const client = await connectMCPWithFallback(new URL(url), authHeaders);
        await client.close();
        return { success: true };
      } catch (error: unknown) {
        if (is401Error(error)) {
          return { success: false, status: 401, error };
        }
        const errObj = error as Record<string, unknown>;
        const status =
          (errObj?.status as number | undefined) ||
          ((errObj?.response as Record<string, unknown>)?.status as number | undefined) ||
          ((errObj?.cause as Record<string, unknown>)?.status as number | undefined);
        return { success: false, status, error };
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

    // Track results and whether we got any 401s
    let got401 = false;
    let firstWorkingUrl: string | undefined;

    // Test each URL
    for (const url of uniqueUrls) {
      const result = await testEndpoint(url);

      if (result.success) {
        firstWorkingUrl = url;
        break;
      }

      if (result.status === 401) {
        got401 = true;
      }
    }

    if (firstWorkingUrl) {
      return firstWorkingUrl;
    }

    // If we got 401 from any endpoint, throw an authentication-required error.
    // Prefer the richer NeedsAuthorizationError when we can walk the full
    // RFC 9728 chain (PRM → AS metadata → endpoints + scopes + DCR hint).
    // Fall back to the simpler AuthenticationRequiredError with one-hop AS
    // metadata when the walk doesn't yield enough.
    if (got401) {
      const requirements = await discoverAuthorizationRequirements(providedUri, {
        allowPrivateIp: isLikelyPrivateUrl(providedUri),
      });
      if (requirements) {
        throw new NeedsAuthorizationError(requirements);
      }
      const oauthMetadata = await discoverOAuthMetadata(providedUri);
      throw new AuthenticationRequiredError(providedUri, oauthMetadata || undefined);
    }

    // None worked and no 401 - generic discovery failure
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
   * - If URL is a well-known agent card URL, switch to A2A protocol
   *   (these are A2A discovery URLs, not MCP endpoints)
   * - A2A agents are marked for canonical URL resolution (from agent card)
   * - MCP agents are marked for endpoint discovery
   */
  private normalizeAgentConfig(agent: AgentConfig): InternalAgentConfig {
    // If URL is a well-known agent card URL, use A2A protocol regardless of what was specified
    // Mark for canonical URL resolution - we'll fetch the agent card and use its url field
    if (this.isWellKnownAgentCardUrl(agent.agent_uri)) {
      return {
        ...agent,
        protocol: 'a2a',
        _needsCanonicalUrl: true,
      };
    }

    if (agent.protocol === 'a2a') {
      // A2A agents need canonical URL resolution from agent card
      return {
        ...agent,
        _needsCanonicalUrl: true,
      };
    }

    if (agent.protocol !== 'mcp') {
      return agent;
    }

    // MCP agents need endpoint discovery - we'll test their path, then try adding /mcp
    return {
      ...agent,
      _needsDiscovery: true,
    };
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
    timestamp?: string | number,
    rawBody?: string
  ): Promise<boolean> {
    // Verify signature if secret is configured
    if (this.config.webhookSecret) {
      if (!signature || !timestamp) {
        throw new Error('Webhook signature and timestamp required but not provided');
      }

      const isValid = this.verifyWebhookSignature(rawBody ?? payload, signature, timestamp);
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
      idempotency_key: normalizedPayload.idempotency_key,
      protocol: normalizedPayload.protocol,
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
        context_id: mcpPayload.context_id ?? undefined,
        task_id: mcpPayload.task_id,
        task_type: taskType,
        status: mcpPayload.status,
        result: mcpPayload.result ?? undefined,
        message: mcpPayload.message ?? undefined,
        timestamp: mcpPayload.timestamp,
        idempotency_key: mcpPayload.idempotency_key,
        protocol: 'mcp',
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
          console.warn(
            'Failed to unwrap A2A webhook payload:',
            error instanceof Error ? error.message : 'unknown error'
          );
          // Fallback: pass raw artifacts so handler has something to work with
          result = a2aPayload.artifacts as unknown as AdCPAsyncResponseData;
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
        protocol: 'a2a',
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
    return async (
      req: { headers: Record<string, string | undefined>; body: unknown; params?: Record<string, string> },
      res: {
        status: (code: number) => { json: (body: unknown) => void };
        json?: unknown;
        writeHead: (code: number, headers: Record<string, string>) => void;
        end: (body: string) => void;
      }
    ) => {
      try {
        // Extract headers (case-insensitive)
        const signature = req.headers['x-adcp-signature'] || req.headers['X-ADCP-Signature'];
        const timestamp = req.headers['x-adcp-timestamp'] || req.headers['X-ADCP-Timestamp'];

        // Capture raw body for signature verification, then parse
        const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
        const payload = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;

        // Extract routing params if available (e.g., Express route params)
        const taskType = req.params?.task_type || req.params?.taskType || 'unknown';
        const operationId = req.params?.operation_id || req.params?.operationId || 'unknown';

        // Handle webhook with automatic verification using raw body bytes
        const handled = await this.handleWebhook(payload, taskType, operationId, signature, timestamp, rawBody);

        // Return success
        if (res.json) {
          res.status(202).json({ status: 'accepted', received: handled });
        } else {
          res.writeHead(202, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'accepted', received: handled }));
        }
      } catch (error: unknown) {
        // Return error
        const errorMessage = error instanceof Error ? error.message : String(error);
        const statusCode = errorMessage.includes('signature') || errorMessage.includes('timestamp') ? 401 : 500;

        if (res.json) {
          res.status(statusCode).json({ error: errorMessage });
        } else {
          res.writeHead(statusCode, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: errorMessage }));
        }
      }
    };
  }

  /**
   * Verify webhook signature using HMAC-SHA256 per AdCP spec.
   *
   * HMAC is computed over the **raw HTTP body bytes** — the exact bytes received
   * on the wire, before JSON parsing. This ensures cross-language interop since
   * different JSON serializers may produce different byte representations of the
   * same logical payload.
   *
   * For backward compatibility, a parsed object is still accepted but will be
   * re-serialized with JSON.stringify, which may not match the sender's bytes.
   * Always prefer passing the raw body string.
   *
   * Signature format: sha256={hex_signature}
   * Message format: {timestamp}.{raw_body}
   *
   * @param rawBodyOrPayload - Raw HTTP body string (preferred) or parsed payload object (deprecated)
   * @param signature - X-ADCP-Signature header value (format: "sha256=...")
   * @param timestamp - X-ADCP-Timestamp header value (Unix timestamp)
   * @returns true if signature is valid
   */
  verifyWebhookSignature(rawBodyOrPayload: string | unknown, signature: string, timestamp: string | number): boolean {
    if (!this.config.webhookSecret) {
      return false;
    }

    // Validate timestamp freshness (reject requests older than 5 minutes)
    const now = Math.floor(Date.now() / 1000);
    const ts = typeof timestamp === 'string' ? parseInt(timestamp) : timestamp;

    if (Math.abs(now - ts) > 300) {
      return false; // Request too old or from future
    }

    // Use raw body bytes when available; fall back to JSON.stringify for backward compat
    const body = typeof rawBodyOrPayload === 'string' ? rawBodyOrPayload : JSON.stringify(rawBodyOrPayload);

    // Build message per AdCP spec: {timestamp}.{raw_body}
    const message = `${ts}.${body}`;

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
    // Normalize params for backwards compatibility before validation
    let normalizedParams = normalizeRequestParams(taskType, params, {
      skipIdempotencyAutoInject: options?.skipIdempotencyAutoInject,
    });

    // Inject an idempotency_key for mutating tools before schema validation
    // so callers don't have to supply one. TaskExecutor also guards against
    // missing keys, but validation happens here first — do the injection up
    // front so the request passes the spec's required-field check.
    // `options.skipIdempotencyAutoInject` disables this for compliance
    // testing that needs to exercise server-side missing-key behavior.
    if (
      !options?.skipIdempotencyAutoInject &&
      isMutatingTask(taskType) &&
      normalizedParams &&
      typeof normalizedParams === 'object' &&
      !normalizedParams.idempotency_key
    ) {
      normalizedParams = { ...normalizedParams, idempotency_key: generateIdempotencyKey() };
    }

    // Validate request params against schema. When compliance testing has
    // asked us to suppress idempotency auto-injection, also skip the
    // client-side required-field check — the whole point of the test is to
    // send a missing-key request through and observe the server's response.
    if (!options?.skipIdempotencyAutoInject) {
      this.validateRequest(taskType, normalizedParams);
    }

    // Validate required features before sending request
    await this.validateTaskFeatures(taskType);

    // Guard mutating calls against pre-v3 sellers when opted in.
    if (this.config.requireV3ForMutations && isMutatingTask(taskType)) {
      await this.requireV3(taskType);
    }

    // Check for v3 features used against v2 servers - return empty result if unsupported
    const earlyResult = await this.getEarlyResultForUnsupportedFeatures<T>(taskType, normalizedParams);
    if (earlyResult) {
      return attachMatch(earlyResult);
    }

    const agent = await this.ensureEndpointDiscovered();

    // Adapt request for v2 servers if needed
    const serverVersion = await this.detectServerVersion();
    const adaptedParams = await this.adaptRequestForServerVersion(taskType, normalizedParams);

    const result = await this.executor.executeTask<T>(
      agent,
      taskType,
      adaptedParams,
      inputHandler,
      options,
      serverVersion
    );

    // Normalize response to v3 format
    if (result.success && result.data) {
      result.data = this.normalizeResponseToV3(taskType, result.data) as T;
    }

    // Call handler if task completed successfully and handler is configured
    if (result.status === 'completed' && result.success && this.asyncHandler) {
      const handler = this.config.handlers?.[handlerName] as
        | ((data: unknown, metadata: Record<string, unknown>) => Promise<void>)
        | undefined;
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

    let adapted = params;

    if (version !== 'v3') {
      // Adapt v3 requests for v2 servers
      switch (taskType) {
        case 'get_products':
          adapted = adaptGetProductsRequestForV2(params);
          break;

        case 'create_media_buy':
          adapted = adaptCreateMediaBuyRequestForV2(params);
          break;

        case 'update_media_buy':
          adapted = adaptUpdateMediaBuyRequestForV2(params);
          break;

        case 'sync_creatives':
          adapted = adaptSyncCreativesRequestForV2(params);
          break;
      }
    }

    // Strip any top-level fields not declared in the agent's tool schema.
    // This handles partial implementations (agents that omit some fields)
    // and prevents unknown fields from causing validation errors on the
    // remote server.
    // Fails open when no schema is cached — better to send unknown fields and
    // let the agent respond than to silently drop data that might be required.
    // MCP-only in practice: A2A agents don't populate cachedToolSchemas.
    const toolSchema = this.cachedToolSchemas?.get(taskType);
    if (!toolSchema) return adapted;

    const declaredFields = new Set(Object.keys(toolSchema));

    // The v2 adapter may rename fields (e.g. brand → brand_manifest) that a
    // v3 server — misdetected as v2 — doesn't declare.  Reconcile known
    // adapter mappings so the value isn't silently dropped.
    const adapterAliases: [string, string][] = [['brand_manifest', 'brand']];
    for (const [adapterField, schemaField] of adapterAliases) {
      if (
        adapted[adapterField] !== undefined &&
        !declaredFields.has(adapterField) &&
        declaredFields.has(schemaField) &&
        adapted[schemaField] === undefined
      ) {
        adapted[schemaField] = adapted[adapterField];
        delete adapted[adapterField];
      }
    }

    // Protocol envelope fields are always preserved — they live at the
    // protocol layer, not in individual tool schemas.
    const envelopeFields = ADCP_ENVELOPE_FIELDS;
    const filtered: Record<string, unknown> = {};
    const stripped: string[] = [];

    for (const [key, value] of Object.entries(adapted)) {
      if (declaredFields.has(key) || envelopeFields.has(key)) {
        filtered[key] = value;
      } else {
        stripped.push(key);
      }
    }

    if (stripped.length > 0) {
      console.warn(
        `[AdCP] Stripping fields not declared in agent "${this.agent.id}" schema for ${taskType}: ${stripped.join(', ')}`
      );
    }

    return filtered;
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

    // Check for v3-only features that would make this query return empty results.
    //
    // TODO: Once we remove backwards-compatibility stripping in adaptGetProductsRequestForV2,
    // re-enable these guards so v3-only requests fail fast against v2 servers:
    //   (params.property_list && !capabilities.features.propertyListFiltering) ||
    //   (params.filters?.required_features?.includes('property_list_filtering') &&
    //     !capabilities.features.propertyListFiltering) ||
    //
    // TODO: Surface the reason for empty results to the caller (e.g. metadata or a
    // structured warning) so they can distinguish "no products matched" from "server
    // lacks v3 feature support" vs "request failed". Right now empty results from a
    // capability mismatch look identical to a seller that simply has no inventory.
    const usesUnsupportedFeature =
      // required_features: content_standards requires contentStandards
      params.filters?.required_features?.includes('content_standards') && !capabilities.features.contentStandards;

    if (!usesUnsupportedFeature) {
      return null; // Proceed normally
    }

    // Log warning about v2 downgrade
    console.warn(
      `[AdCP] v3-only features not supported by server "${this.agent.id}" (${capabilities.version}). Returning empty results.`
    );

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
    params: MutatingRequestInput<CreateMediaBuyRequest>,
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
    params: MutatingRequestInput<UpdateMediaBuyRequest>,
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
    params: MutatingRequestInput<SyncCreativesRequest>,
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
   * Get media buy status, creative approvals, and optional delivery snapshots
   *
   * @param params - Request parameters
   * @param inputHandler - Handler for clarification requests
   * @param options - Task execution options
   */
  async getMediaBuys(
    params: GetMediaBuysRequest,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<GetMediaBuysResponse>> {
    return this.executeAndHandle<GetMediaBuysResponse>(
      'get_media_buys',
      'onGetMediaBuysStatusChange',
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
    params: MutatingRequestInput<ProvidePerformanceFeedbackRequest>,
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
    params: MutatingRequestInput<ActivateSignalRequest>,
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

  // ====== GOVERNANCE TASKS ======

  /**
   * Sync campaign plans to a governance agent.
   * Plans define authorized parameters: budget, channels, flight dates, markets, policies, delegations.
   *
   * Uses the governance agent from config.governance.campaign.agent by default.
   * Pass an explicit agent via options.agent to override.
   */
  async syncPlans(
    params: MutatingRequestInput<SyncPlansRequest>,
    inputHandler?: InputHandler,
    options?: TaskOptions & { agent?: AgentConfig }
  ): Promise<TaskResult<SyncPlansResponse>> {
    const agent = options?.agent ?? this.getGovernanceAgent();
    return this.executor.executeTask<SyncPlansResponse>(agent, 'sync_plans', params, inputHandler, options);
  }

  /**
   * Get governance audit logs for one or more plans.
   * Returns budget state, channel allocation, per-campaign breakdown, and audit trail.
   *
   * Uses the governance agent from config.governance.campaign.agent by default.
   * Pass an explicit agent via options.agent to override.
   */
  async getPlanAuditLogs(
    params: GetPlanAuditLogsRequest,
    options?: TaskOptions & { agent?: AgentConfig }
  ): Promise<TaskResult<GetPlanAuditLogsResponse>> {
    const agent = options?.agent ?? this.getGovernanceAgent();
    return this.executor.executeTask<GetPlanAuditLogsResponse>(
      agent,
      'get_plan_audit_logs',
      params,
      undefined,
      options
    );
  }

  /**
   * Report a governance outcome for an async task that has resolved.
   *
   * Use this when a task returned status 'submitted' or 'working' and
   * later resolves via polling or webhooks. The checkId is available
   * on the original TaskResult at result.governance.checkId.
   */
  async reportGovernanceOutcome(
    checkId: string,
    outcome: OutcomeType,
    governanceContext?: string,
    sellerResponse?: Record<string, unknown>,
    error?: { code?: string; message: string }
  ): Promise<import('./GovernanceTypes').GovernanceOutcome | undefined> {
    const middleware = this.executor.getGovernanceMiddleware();
    if (!middleware) {
      throw new Error('No governance middleware configured. Set config.governance.campaign to enable governance.');
    }
    return middleware.reportOutcome(checkId, outcome, sellerResponse, error, [], governanceContext);
  }

  private getGovernanceAgent(): AgentConfig {
    const agent = this.config.governance?.campaign?.agent;
    if (!agent) {
      throw new Error(
        'No governance agent configured. Either pass an explicit agent via options.agent or set config.governance.campaign.agent.'
      );
    }
    return agent;
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

  // ====== CREATIVE BUILD TASKS ======

  /**
   * Build a creative from a format and brand context
   */
  async buildCreative(
    params: MutatingRequestInput<BuildCreativeRequest>,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<BuildCreativeResponse>> {
    return this.executeAndHandle<BuildCreativeResponse>(
      'build_creative',
      'onBuildCreativeStatusChange',
      params,
      inputHandler,
      options
    );
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
    return this.executeAndHandle<ListAccountsResponse>(
      'list_accounts',
      'onListAccountsStatusChange',
      params,
      inputHandler,
      options
    );
  }

  /**
   * Sync accounts
   */
  async syncAccounts(
    params: MutatingRequestInput<SyncAccountsRequest>,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<SyncAccountsResponse>> {
    return this.executeAndHandle<SyncAccountsResponse>(
      'sync_accounts',
      'onSyncAccountsStatusChange',
      params,
      inputHandler,
      options
    );
  }

  /**
   * Sync audiences
   */
  async syncAudiences(
    params: MutatingRequestInput<SyncAudiencesRequest>,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<SyncAudiencesResponse>> {
    return this.executeAndHandle<SyncAudiencesResponse>(
      'sync_audiences',
      'onSyncAudiencesStatusChange',
      params,
      inputHandler,
      options
    );
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
    return this.executeAndHandle<CreatePropertyListResponse>(
      'create_property_list',
      'onCreatePropertyListStatusChange',
      params,
      inputHandler,
      options
    );
  }

  /**
   * Get a property list
   */
  async getPropertyList(
    params: GetPropertyListRequest,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<GetPropertyListResponse>> {
    return this.executeAndHandle<GetPropertyListResponse>(
      'get_property_list',
      'onGetPropertyListStatusChange',
      params,
      inputHandler,
      options
    );
  }

  /**
   * Update a property list
   */
  async updatePropertyList(
    params: MutatingRequestInput<UpdatePropertyListRequest>,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<UpdatePropertyListResponse>> {
    return this.executeAndHandle<UpdatePropertyListResponse>(
      'update_property_list',
      'onUpdatePropertyListStatusChange',
      params,
      inputHandler,
      options
    );
  }

  /**
   * List property lists
   */
  async listPropertyLists(
    params: ListPropertyListsRequest,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<ListPropertyListsResponse>> {
    return this.executeAndHandle<ListPropertyListsResponse>(
      'list_property_lists',
      'onListPropertyListsStatusChange',
      params,
      inputHandler,
      options
    );
  }

  /**
   * Delete a property list
   */
  async deletePropertyList(
    params: MutatingRequestInput<DeletePropertyListRequest>,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<DeletePropertyListResponse>> {
    return this.executeAndHandle<DeletePropertyListResponse>(
      'delete_property_list',
      'onDeletePropertyListStatusChange',
      params,
      inputHandler,
      options
    );
  }

  /**
   * List content standards
   */
  async listContentStandards(
    params: ListContentStandardsRequest,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<ListContentStandardsResponse>> {
    return this.executeAndHandle<ListContentStandardsResponse>(
      'list_content_standards',
      'onListContentStandardsStatusChange',
      params,
      inputHandler,
      options
    );
  }

  /**
   * Get content standards
   */
  async getContentStandards(
    params: GetContentStandardsRequest,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<GetContentStandardsResponse>> {
    return this.executeAndHandle<GetContentStandardsResponse>(
      'get_content_standards',
      'onGetContentStandardsStatusChange',
      params,
      inputHandler,
      options
    );
  }

  /**
   * Calibrate content against standards
   */
  async calibrateContent(
    params: MutatingRequestInput<CalibrateContentRequest>,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<CalibrateContentResponse>> {
    return this.executeAndHandle<CalibrateContentResponse>(
      'calibrate_content',
      'onCalibrateContentStatusChange',
      params,
      inputHandler,
      options
    );
  }

  /**
   * Validate content delivery
   */
  async validateContentDelivery(
    params: ValidateContentDeliveryRequest,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<ValidateContentDeliveryResponse>> {
    return this.executeAndHandle<ValidateContentDeliveryResponse>(
      'validate_content_delivery',
      'onValidateContentDeliveryStatusChange',
      params,
      inputHandler,
      options
    );
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
    return this.executeAndHandle<SIGetOfferingResponse>(
      'si_get_offering',
      'onSIGetOfferingStatusChange',
      params,
      inputHandler,
      options
    );
  }

  /**
   * Initiate an SI session
   */
  async siInitiateSession(
    params: MutatingRequestInput<SIInitiateSessionRequest>,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<SIInitiateSessionResponse>> {
    return this.executeAndHandle<SIInitiateSessionResponse>(
      'si_initiate_session',
      'onSIInitiateSessionStatusChange',
      params,
      inputHandler,
      options
    );
  }

  /**
   * Send a message in an SI session
   */
  async siSendMessage(
    params: MutatingRequestInput<SISendMessageRequest>,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<SISendMessageResponse>> {
    return this.executeAndHandle<SISendMessageResponse>(
      'si_send_message',
      'onSISendMessageStatusChange',
      params,
      inputHandler,
      options
    );
  }

  /**
   * Terminate an SI session
   */
  async siTerminateSession(
    params: SITerminateSessionRequest,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<SITerminateSessionResponse>> {
    return this.executeAndHandle<SITerminateSessionResponse>(
      'si_terminate_session',
      'onSITerminateSessionStatusChange',
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
    const normalizedParams = normalizeRequestParams(taskName, params, {
      skipIdempotencyAutoInject: options?.skipIdempotencyAutoInject,
    });
    await this.validateTaskFeatures(taskName);
    if (this.config.requireV3ForMutations && isMutatingTask(taskName)) {
      await this.requireV3(taskName);
    }
    const agent = await this.ensureEndpointDiscovered();

    // Adapt request for the server's protocol version (e.g. strip v3-only
    // fields like buying_mode when talking to v2 agents).
    const serverVersion = await this.detectServerVersion();
    const adaptedParams = await this.adaptRequestForServerVersion(taskName, normalizedParams);

    const result = await this.executor.executeTask<T>(
      agent,
      taskName,
      adaptedParams,
      inputHandler,
      options,
      serverVersion
    );

    // Normalize response to v3 format for consistent API surface
    if (result.success && result.data) {
      result.data = this.normalizeResponseToV3(taskName, result.data) as T;
    }

    return result;
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
      const { _needsDiscovery, _needsCanonicalUrl, ...cleanAgent } = this.normalizedAgent;
      return {
        ...cleanAgent,
        agent_uri: this.canonicalBaseUrl,
      };
    }

    // Return normalized agent without internal flags
    const { _needsDiscovery, _needsCanonicalUrl, ...cleanAgent } = this.normalizedAgent;
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
   *   the well-known agent card path stripped
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
   * - URL format (with/without /mcp, with/without well-known agent card path)
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
    return this.executor.getActiveTasks().filter(task => task.agent.id === this.agent.id);
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
      inputSchema?: Record<string, unknown>;
      parameters?: string[];
    }>;
  }> {
    if (this.normalizedAgent.protocol === 'mcp') {
      // Discover endpoint if needed
      const agent = await this.ensureEndpointDiscovered();

      // Use the shared connectMCP path so both static bearer AND saved OAuth
      // tokens work. OAuth takes the refresh-capable authProvider branch.
      const { connectMCP } = await import('../protocols/mcp');
      const connectOptions: Parameters<typeof connectMCP>[0] = { agentUrl: agent.agent_uri };
      if (this.normalizedAgent.oauth_tokens) {
        const { createNonInteractiveOAuthProvider } = await import('../auth/oauth');
        connectOptions.authProvider = createNonInteractiveOAuthProvider(this.normalizedAgent, {
          agentHint: this.normalizedAgent.id,
        });
      } else if (this.normalizedAgent.auth_token) {
        connectOptions.authToken = this.normalizedAgent.auth_token;
      }

      const { client: mcpClient } = await connectMCP(connectOptions);
      try {
        const toolsList = await mcpClient.listTools();

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
      } finally {
        try {
          await mcpClient.close();
        } catch {
          /* ignore */
        }
      }
    } else if (this.normalizedAgent.protocol === 'a2a') {
      // Use A2A SDK to get agent card
      const clientModule = require('@a2a-js/sdk/client');
      const A2AClient = clientModule.A2AClient;

      const authToken = this.normalizedAgent.auth_token;
      const fetchImpl = authToken
        ? async (url: string | URL | Request, options?: RequestInit) => {
            const headers = {
              ...(options?.headers as Record<string, string>),
              Authorization: `Bearer ${authToken}`,
              'x-adcp-auth': authToken,
            };
            return fetch(url, { ...options, headers });
          }
        : undefined;

      const cardUrls = buildCardUrls(this.normalizedAgent.agent_uri);

      let client: InstanceType<typeof A2AClient> | undefined;
      let lastCardError: Error = new Error(`A2A agent card not found at ${cardUrls.join(', ')}`);
      for (const cardUrl of cardUrls) {
        try {
          client = await A2AClient.fromCardUrl(cardUrl, fetchImpl ? { fetchImpl } : {});
          break;
        } catch (err: unknown) {
          lastCardError = err as Error;
        }
      }
      if (!client) {
        throw lastCardError;
      }
      const agentCard = client.agentCardPromise ? await client.agentCardPromise : client.agentCard;

      const tools = agentCard?.skills
        ? agentCard.skills.map(
            (skill: {
              id?: string;
              name: string;
              description?: string;
              inputSchema?: Record<string, unknown>;
              inputFormats?: string[];
            }) => ({
              name: skill.id || skill.name,
              description: skill.description,
              inputSchema: skill.inputSchema,
              parameters: skill.inputFormats || [],
            })
          )
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
      this.maybeWarnV2Sunset(this.cachedCapabilities);
      return this.cachedCapabilities;
    }

    // First get tool list to support both detection methods
    const agentInfo = await this.getAgentInfo();
    const tools: ToolInfo[] = agentInfo.tools.map(t => ({
      name: t.name,
      description: t.description,
    }));

    // Cache raw tool schemas for field-level compatibility checks (e.g. buying_mode on get_products).
    // INVARIANT: must be assigned before cachedCapabilities below so that any code path
    // reaching adaptRequestForServerVersion always finds the schemas populated.
    this.cachedToolSchemas = new Map(
      agentInfo.tools
        .filter(t => t.inputSchema?.properties)
        .map(t => [t.name, t.inputSchema!.properties as Record<string, unknown>])
    );

    // Check if agent supports get_adcp_capabilities (v3)
    const hasCapabilitiesTool = tools.some(t => t.name === 'get_adcp_capabilities');

    if (hasCapabilitiesTool) {
      try {
        // Call get_adcp_capabilities tool
        const agent = await this.ensureEndpointDiscovered();
        const result = await this.executor.executeTask<any>(agent, 'get_adcp_capabilities', {}, undefined);

        if (result.success && result.data) {
          this.cachedCapabilities = augmentCapabilitiesFromTools(parseCapabilitiesResponse(result.data), tools);
          this.maybeWarnV2Sunset(this.cachedCapabilities);
          return this.cachedCapabilities;
        }
        // Log when executeTask returns but success is false — this causes
        // the server to be treated as v2 even though it advertises
        // get_adcp_capabilities, which will trigger v2 field adapters.
        console.warn(
          `[AdCP] Agent "${this.agent.id}" advertises get_adcp_capabilities but the call ` +
            `returned non-success — falling back to v2 synthetic capabilities. ` +
            `This may cause v2 field adapters to run against a v3 server.`,
          {
            success: result.success,
            error: result.error,
            hasData: !!result.data,
            data: result.data,
          }
        );
      } catch (error: unknown) {
        // Re-throw errors that indicate real infrastructure problems —
        // only fall through for tool-execution failures (the agent
        // advertises get_adcp_capabilities but can't actually serve it).
        if (error instanceof AuthenticationRequiredError || error instanceof TaskTimeoutError) {
          throw error;
        }
        console.warn(
          `[AdCP] Agent "${this.agent.id}" advertises get_adcp_capabilities but the call ` +
            `threw — falling back to v2 synthetic capabilities. ` +
            `This may cause v2 field adapters to run against a v3 server. ` +
            `Error: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    // Build synthetic capabilities from tool list (v2)
    console.warn(
      `[AdCP] Agent "${this.agent.id}" detected as v2` +
        (hasCapabilitiesTool ? ' (has get_adcp_capabilities tool but call failed)' : '') +
        `. Tools: [${tools.map(t => t.name).join(', ')}]`
    );
    this.cachedCapabilities = buildSyntheticCapabilities(tools);
    return this.cachedCapabilities;
  }

  /**
   * Emit a one-time warning when the agent reports v2 capabilities.
   *
   * v2 went unsupported on 2026-04-20 (AdCP 3.0 GA — adcp#2220). We still
   * execute v2 code paths (no behaviour change), but clients integrating
   * against an unsupported agent should hear about it loudly.
   *
   * Synthetic capabilities (no `get_adcp_capabilities` tool available) don't
   * trigger the warning — we don't actually know the agent's version, and
   * shouting at legitimately-unversioned agents would be noise.
   *
   * Suppression: `process.env.ADCP_ALLOW_V2 === '1'`.
   */
  private maybeWarnV2Sunset(capabilities: AdcpCapabilities): void {
    if (this._v2WarningFired) return;
    if (capabilities.version === 'v3') return;
    if (capabilities._synthetic) return;
    if (process.env.ADCP_ALLOW_V2 === '1') return;

    this._v2WarningFired = true;
    console.warn(
      `[adcp] Warning: agent ${this.agent.agent_uri} reports v2 capabilities. ` +
        `v2 went unsupported on 2026-04-20 (AdCP 3.0 GA). ` +
        `Upgrade the agent to v3 or set ADCP_ALLOW_V2=1 to suppress this warning. ` +
        `See https://github.com/adcontextprotocol/adcp/issues/2220`
    );
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

  /**
   * Return the seller's declared `adcp.idempotency.replay_ttl_seconds`.
   *
   * BYOK callers use this to compare the age of persisted keys against the
   * seller's replay window — past the window, the safe recovery is a
   * natural-key lookup rather than reusing the key.
   *
   * Fails closed when the seller is v3 but does not declare the field: the
   * spec makes the declaration REQUIRED, and silently defaulting to 24h
   * would mislead buyers about retry safety. Callers on v2 servers get
   * `undefined` instead of a throw — v2 pre-dates the idempotency envelope.
   */
  async getIdempotencyReplayTtlSeconds(): Promise<number | undefined> {
    const capabilities = await this.getCapabilities();
    if (capabilities.idempotency) return capabilities.idempotency.replayTtlSeconds;
    if (capabilities.version !== 'v3') return undefined;
    throw new ConfigurationError(
      `Agent "${this.agent.id}" is v3 but does not declare adcp.idempotency.replay_ttl_seconds. ` +
        `The spec requires this for v3 sellers — treating the agent as non-compliant rather than ` +
        `defaulting to 24h, which would silently mislead retry-sensitive flows.`,
      'adcp.idempotency.replay_ttl_seconds'
    );
  }

  /**
   * Check if the seller supports a feature.
   *
   * Feature names resolve as follows:
   * - Protocol names ('media_buy', 'signals', etc.) check supported_protocols
   * - 'ext:<name>' checks extensions_supported
   * - 'targeting.<name>' checks media_buy.execution.targeting
   * - Other names check media_buy.features (e.g., 'audience_targeting', 'conversion_tracking')
   *
   * Absent features return false.
   */
  async supports(feature: FeatureName): Promise<boolean> {
    const capabilities = await this.getCapabilities();
    return resolveFeature(capabilities, feature);
  }

  /**
   * Require that the seller supports all listed features.
   * Throws FeatureUnsupportedError if any are missing.
   *
   * Call this before making feature-dependent task calls to fail fast
   * with an actionable error message.
   */
  async require(...features: FeatureName[]): Promise<void> {
    const capabilities = await this.getCapabilities();
    const missing = features.filter(f => !resolveFeature(capabilities, f));
    if (missing.length > 0) {
      throw new FeatureUnsupportedError(missing, listDeclaredFeatures(capabilities), this.agent.agent_uri);
    }
  }

  /**
   * Force-refresh cached capabilities from the server.
   * Useful when seller capabilities may have changed.
   */
  async refreshCapabilities(): Promise<AdcpCapabilities> {
    this.cachedCapabilities = undefined;
    return this.getCapabilities();
  }

  /**
   * Validate that the seller supports all features required by a task.
   * Throws FeatureUnsupportedError if any required features are missing.
   *
   * Skipped when validateFeatures is false or the task has no feature requirements.
   */
  private async validateTaskFeatures(taskName: string): Promise<void> {
    if (this.config.validateFeatures === false) return;

    const requiredFeatures = TASK_FEATURE_MAP[taskName];
    if (!requiredFeatures || requiredFeatures.length === 0) return;

    await this.require(...requiredFeatures);
  }

  /**
   * Assert that the seller's capabilities corroborate AdCP v3.
   *
   * A self-reported `version: 'v3'` is not enough — a hostile or
   * misconfigured seller can just string-claim the version. The guard
   * requires:
   *
   *   1. `capabilities.majorVersions.includes(3)` (multi-version aware)
   *   2. `capabilities.idempotency.replayTtlSeconds` present (spec-required
   *      for real v3 sellers; synthetic capabilities don't get this free)
   *   3. capabilities were not synthesized from a tool list
   *
   * Per-client `allowV2: true` or, when that's undefined,
   * `ADCP_ALLOW_V2=1` in the environment bypasses the check.
   *
   * Throws `VersionUnsupportedError` with the specific reason on failure.
   */
  async requireV3(taskType: string = 'request'): Promise<void> {
    if (this.isV2Allowed()) return;
    const capabilities = await this.getCapabilities();

    if (capabilities._synthetic) {
      throw new VersionUnsupportedError(taskType, 'synthetic', capabilities.version, this.agent.agent_uri);
    }
    if (!capabilities.majorVersions.includes(3)) {
      throw new VersionUnsupportedError(taskType, 'version', capabilities.version, this.agent.agent_uri);
    }
    if (!capabilities.idempotency?.replayTtlSeconds) {
      throw new VersionUnsupportedError(taskType, 'idempotency', capabilities.version, this.agent.agent_uri);
    }
  }

  private isV2Allowed(): boolean {
    if (this.config.allowV2 !== undefined) return this.config.allowV2 === true;
    return process.env.ADCP_ALLOW_V2 === '1';
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
   * Validate request parameters against AdCP schema.
   *
   * Uses default (non-strict) parsing so required fields are still enforced
   * but unknown top-level keys pass through. This matters because callers —
   * including the storyboard runner's `applyBrandInvariant` — inject
   * scoping fields (`brand`, `account`) onto every outgoing request, and
   * `adaptRequestForServerVersion` strips those fields downstream for tools
   * whose schema doesn't declare them. A strict parse here rejects the
   * injected fields before the adapter gets a chance to clean them up, so
   * the two passes have to agree on "extra keys are fine."
   */
  private validateRequest(taskType: string, params: any): void {
    const schema = this.getRequestSchema(taskType);
    if (!schema) {
      return; // No schema available for this task type
    }

    try {
      schema.parse(params);
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
      get_products: schemas.GetProductsRequestSchema,
      list_creative_formats: schemas.ListCreativeFormatsRequestSchema,
      create_media_buy: schemas.CreateMediaBuyRequestSchema,
      // update_media_buy: excluded - complex discriminated unions (package operations)
      sync_creatives: schemas.SyncCreativesRequestSchema,
      list_creatives: schemas.ListCreativesRequestSchema,
      get_media_buys: schemas.GetMediaBuysRequestSchema,
      get_creative_features: schemas.GetCreativeFeaturesRequestSchema,
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
