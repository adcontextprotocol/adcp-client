// Per-agent client wrapper with conversation context preservation

import type { Client as MCPClient } from '@modelcontextprotocol/sdk/client/index.js';
import { randomUUID } from 'node:crypto';
import type { AgentConfig } from '../types';
import type {
  MCPWebhookPayload,
  GetBrandIdentityRequest,
  GetBrandIdentityResponse,
  GetRightsRequest,
  GetRightsResponse,
  AcquireRightsRequest,
  AcquireRightsResponse,
  ContextMatchRequest,
  ContextMatchResponse,
  IdentityMatchRequest,
  IdentityMatchResponseRouterPublisher,
} from '../types/core.generated';
import type { Task as A2ATask, TaskStatusUpdateEvent } from '@a2a-js/sdk';
import {
  SingleAgentClient,
  type CanonicalReadTaskOptions,
  type CreativeDeliveryTaskOptions,
  type SingleAgentClientConfig,
  type SyncCreativesTaskOptions,
  type VerifyAndParseWebhookOptions,
  type WebhookHandlerAdapter,
  type WebhookParseResult,
} from './SingleAgentClient';
import type { InputHandler, TaskOptions, TaskResult, TaskInfo, Message } from './ConversationTypes';
import type { BeforeProtocolDispatchHook } from './TaskExecutor';
import type { AdcpCapabilities } from '../utils/capabilities';
import type { WebhookHeaderValue } from '../webhooks';
import type {
  GetProductsRequest,
  GetProductsResponse,
  ListProductsRequest,
  ListProductsResponse,
  RequestProposalsRequest,
  RequestProposalsResponse,
  DeclineProposalsRequest,
  DeclineProposalsResponse,
  BuyProductsRequest,
  BuyProductsResponse,
  AcceptProposalRequest,
  AcceptProposalResponse,
  ControlMediaBuyRequest,
  ControlMediaBuyResponse,
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
  GetCreativeDeliveryRequest,
  GetCreativeDeliveryResponse,
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
  CreateContentStandardsResponse,
  CreateContentStandardsRequest,
  SyncPlansRequest,
  SyncPlansResponse,
  CheckGovernanceRequest,
  CheckGovernanceResponse,
  ReportPlanOutcomeRequest,
  ReportPlanOutcomeResponse,
  ReportPlanAdjustmentRequest,
  ReportPlanAdjustmentResponse,
  GetPlanAuditLogsRequest,
  GetPlanAuditLogsResponse,
  ListTransformersRequest,
  ListTransformersResponse,
  SyncAgentNotificationConfigsRequest,
  SyncAgentNotificationConfigsResponse,
} from '../types/tools.generated';
import type { MutatingRequestInput } from '../utils/idempotency';
import { MediaBuyLifecycleCoordinator, type MediaBuyLifecycleCoordinatorOptions } from '../media-buy/compatibility';
import { buildRefineProposalsRequest } from '../negotiation/buyer';
import { assertRefineProposalsResponse } from '../negotiation/verification';
import type {
  ProposalRefinementCapabilities,
  RefineProposalsInput,
  RefineProposalsResponse,
} from '../negotiation/types';
import type { V1Product } from '../v2/projection/types';
import type { LegacyFormatConverter } from '../v2/projection/v1-to-v2';
import type { ProjectionCatalogSnapshot } from '../v2/projection/catalog-snapshot';
import type {
  CanonicalCreateMediaBuyRequest,
  CanonicalCreativeResponse,
  CanonicalGetProductsRequest,
  CanonicalGetProductsResponse,
  CanonicalListCreativesRequest,
  CanonicalListCreativesResponse,
  CanonicalPreviewCreativeRequest,
  CanonicalPreviewCreativeResponse,
  CanonicalProduct,
  CanonicalSyncCreativesRequest,
  CanonicalUpdateMediaBuyRequest,
} from '../v2/projection/creative-delivery';
export type { CanonicalGetProductsResponse } from '../v2/projection/creative-delivery';

export type CanonicalProjectionTaskOptions = TaskOptions & {
  /** Migration escape hatch for seller-specific legacy refs absent from the bundled registry. */
  legacyFormatConverter?: LegacyFormatConverter;
  /** Pre-resolved exact-owner publisher/community catalogs, highest precedence first. */
  projectionCatalogs?: readonly ProjectionCatalogSnapshot[];
};

export type ProposalRefinementTaskOptions = TaskOptions & {
  /** Explicit seller declaration from media_buy.proposal_refinement. */
  proposalRefinementCapabilities?: ProposalRefinementCapabilities;
};

function stripRefineProposalsSdkAnnotations(data: RefineProposalsResponse): RefineProposalsResponse {
  const canonical = { ...(data as RefineProposalsResponse & { success?: unknown; _message?: unknown }) };
  delete canonical.success;
  delete canonical._message;
  return canonical;
}

/**
 * Projection metadata attached to canonical `get_products` responses.
 *
 * Present whenever projection ran (the default). Portable projection
 * advisories are added to the standard `data.errors[]` array; this envelope
 * is a convenience view for SDK-local inspection. Absence of diagnostics means every product's
 * `format_options[]` is fully populated (clean catalog match) or was
 * already v2-shaped on the wire.
 */
/**
 * @deprecated The primary SDK surface is canonical-only. Use
 * {@link CanonicalGetProductsResponse}. Raw legacy wire shapes remain
 * available only through the explicit `getProductsLegacy()` escape hatch.
 */
export type V2AugmentedGetProductsResponse = CanonicalGetProductsResponse;

/**
 * Type mapping for task names to their response types
 * Enables type-safe generic executeTask() calls
 */
export type TaskResponseTypeMap = {
  get_products: CanonicalGetProductsResponse;
  list_products: ListProductsResponse;
  request_proposals: RequestProposalsResponse;
  refine_proposals: RefineProposalsResponse;
  decline_proposals: DeclineProposalsResponse;
  buy_products: BuyProductsResponse;
  accept_proposal: AcceptProposalResponse;
  control_media_buy: ControlMediaBuyResponse;
  create_media_buy: CanonicalCreativeResponse<CreateMediaBuyResponse>;
  update_media_buy: CanonicalCreativeResponse<UpdateMediaBuyResponse>;
  sync_creatives: CanonicalCreativeResponse<SyncCreativesResponse>;
  list_creatives: CanonicalListCreativesResponse;
  get_media_buys: CanonicalCreativeResponse<GetMediaBuysResponse>;
  get_media_buy_delivery: CanonicalCreativeResponse<GetMediaBuyDeliveryResponse>;
  get_creative_delivery: CanonicalCreativeResponse<GetCreativeDeliveryResponse>;
  provide_performance_feedback: ProvidePerformanceFeedbackResponse;
  get_signals: GetSignalsResponse;
  activate_signal: ActivateSignalResponse;
  get_adcp_capabilities: GetAdCPCapabilitiesResponse;
  list_accounts: ListAccountsResponse;
  sync_accounts: SyncAccountsResponse;
  sync_audiences: SyncAudiencesResponse;
  create_property_list: CreatePropertyListResponse;
  get_property_list: GetPropertyListResponse;
  update_property_list: UpdatePropertyListResponse;
  list_property_lists: ListPropertyListsResponse;
  delete_property_list: DeletePropertyListResponse;
  si_get_offering: SIGetOfferingResponse;
  si_initiate_session: SIInitiateSessionResponse;
  si_send_message: SISendMessageResponse;
  si_terminate_session: SITerminateSessionResponse;
  get_brand_identity: GetBrandIdentityResponse;
  sync_plans: SyncPlansResponse;
  check_governance: CheckGovernanceResponse;
  report_plan_outcome: ReportPlanOutcomeResponse;
  report_plan_adjustment: ReportPlanAdjustmentResponse;
  get_plan_audit_logs: GetPlanAuditLogsResponse;
  context_match: ContextMatchResponse;
  identity_match: IdentityMatchResponseRouterPublisher;
  sync_agent_notification_configs: SyncAgentNotificationConfigsResponse;
};

/**
 * Valid ADCP task names
 */
export type AdcpTaskName = keyof TaskResponseTypeMap;

/** Exact request mapping paired with {@link TaskResponseTypeMap}. */
export type TaskRequestTypeMap = {
  get_products: CanonicalGetProductsRequest;
  list_products: ListProductsRequest;
  request_proposals: MutatingRequestInput<RequestProposalsRequest>;
  refine_proposals: RefineProposalsInput;
  decline_proposals: MutatingRequestInput<DeclineProposalsRequest>;
  buy_products: MutatingRequestInput<BuyProductsRequest>;
  accept_proposal: MutatingRequestInput<AcceptProposalRequest>;
  control_media_buy: MutatingRequestInput<ControlMediaBuyRequest>;
  create_media_buy: MutatingRequestInput<CanonicalCreateMediaBuyRequest>;
  update_media_buy: MutatingRequestInput<CanonicalUpdateMediaBuyRequest>;
  sync_creatives: MutatingRequestInput<CanonicalSyncCreativesRequest>;
  list_creatives: CanonicalListCreativesRequest;
  get_media_buys: GetMediaBuysRequest;
  get_media_buy_delivery: GetMediaBuyDeliveryRequest;
  get_creative_delivery: GetCreativeDeliveryRequest;
  provide_performance_feedback: MutatingRequestInput<ProvidePerformanceFeedbackRequest>;
  get_signals: GetSignalsRequest;
  activate_signal: MutatingRequestInput<ActivateSignalRequest>;
  get_adcp_capabilities: GetAdCPCapabilitiesRequest;
  list_accounts: ListAccountsRequest;
  sync_accounts: MutatingRequestInput<SyncAccountsRequest>;
  sync_audiences: MutatingRequestInput<SyncAudiencesRequest>;
  create_property_list: MutatingRequestInput<CreatePropertyListRequest>;
  get_property_list: GetPropertyListRequest;
  update_property_list: MutatingRequestInput<UpdatePropertyListRequest>;
  list_property_lists: ListPropertyListsRequest;
  delete_property_list: MutatingRequestInput<DeletePropertyListRequest>;
  si_get_offering: SIGetOfferingRequest;
  si_initiate_session: MutatingRequestInput<SIInitiateSessionRequest>;
  si_send_message: MutatingRequestInput<SISendMessageRequest>;
  si_terminate_session: SITerminateSessionRequest;
  get_brand_identity: GetBrandIdentityRequest;
  sync_plans: MutatingRequestInput<SyncPlansRequest>;
  check_governance: CheckGovernanceRequest;
  report_plan_outcome: MutatingRequestInput<ReportPlanOutcomeRequest>;
  report_plan_adjustment: MutatingRequestInput<ReportPlanAdjustmentRequest>;
  get_plan_audit_logs: GetPlanAuditLogsRequest;
  context_match: ContextMatchRequest;
  identity_match: IdentityMatchRequest;
  sync_agent_notification_configs: MutatingRequestInput<SyncAgentNotificationConfigsRequest>;
};

export type TaskRequestFor<K extends AdcpTaskName> = TaskRequestTypeMap[K];

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
  | 'adcpVersion'
  | 'wireAdcpVersion'
  | 'versionEnvelope'
  | 'debug'
  | 'validation'
  | 'governance'
  | 'onActivity'
  | 'legacyFormatConverter'
  | 'projectionCatalogs'
  | 'canonicalFormatLegacyResolver'
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
/**
 * Retained server-side task handle. Paired with the `contextId` and skill
 * name under which it was returned so {@link AgentClient.withSession} only
 * auto-threads it when the next call is plausibly a continuation of the
 * SAME task (same skill, same conversation). A different skill or switched
 * contextId signals new work — sending the retained handle in that case
 * produces "Task not found" against spec-compliant A2A sellers (per A2A
 * 0.3.0 §3.4 — Message.taskId continues the parent task).
 */
interface PendingTaskHandle {
  taskId: string;
  contextId: string;
  taskName: string;
}

export class AgentClient {
  private client: SingleAgentClient;
  private currentContextId?: string;
  private pendingTask?: PendingTaskHandle;
  private readonly _isInProcess: boolean;

  constructor(
    private agent: AgentConfig,
    private config: SingleAgentClientConfig = {}
  ) {
    this.client = new SingleAgentClient(agent, config);
    this._isInProcess = agent._inProcessMcpClient !== undefined;
  }

  /**
   * Internal access to the underlying `TaskExecutor`. Used by the storyboard
   * runner's `pollTaskCompletion` race so it can poll AdCP `tasks/get` against
   * the agent's transport (see `src/lib/testing/storyboard/runner.ts`'s
   * `resolveTaskCompletionOutputs`). Without this surface the runner sees
   * `executor: undefined` on AgentClient and silently falls back to webhook-
   * only racing — which times out for storyboard fixtures that don't address
   * a runner-controlled webhook URL.
   *
   * Not part of the documented client API; production code goes through the
   * tool-specific methods on `AgentClient` / `AdCPClient`. The shape may
   * change without notice if the runner's polling contract evolves.
   *
   * @internal
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- runtime-internal accessor
  get executor(): any {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- reach-through to the underlying executor
    return (this.client as any).executor;
  }

  /**
   * Returns the AdCP protocol version this client speaks. Mirrors
   * `SingleAgentClient.getAdcpVersion()`. See {@link SingleAgentClientConfig.adcpVersion}.
   */
  getAdcpVersion(): string {
    return this.client.getAdcpVersion();
  }

  /**
   * Negotiate one compact-first media-buy facade for this seller.
   *
   * Compact tools are preferred when advertised. Established projections
   * are selected before dispatch and expose exact provenance/loss metadata;
   * the coordinator never switches mutation tools after a transport failure.
   */
  async negotiateMediaBuyLifecycle(
    options: MediaBuyLifecycleCoordinatorOptions = {}
  ): Promise<MediaBuyLifecycleCoordinator> {
    return MediaBuyLifecycleCoordinator.negotiate(this, options);
  }

  /**
   * Create an `AgentClient` backed by a pre-connected MCP `Client` instead of
   * an HTTP endpoint. Useful for in-process compliance testing without spinning
   * up a loopback HTTP server.
   *
   * **MCP only.** This factory wraps an MCP `Client` from
   * `@modelcontextprotocol/sdk`. There is no equivalent in-process bridge for
   * A2A today — for A2A agents, run them on a loopback HTTP server and use the
   * standard `AgentClient` constructor with the agent's `agent_uri`.
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
   * import { AgentClient } from '@adcp/sdk';
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
    // Reject pre-connect clients up front — MCP `Client.transport` is only set
    // after `client.connect(transport)` resolves. A pre-connect client would
    // fail later inside `listTools()`/`callTool()` with an opaque error; the
    // up-front check produces a clean failure pointing at the construction site.
    if ((mcpClient as { transport?: unknown }).transport === undefined) {
      throw new Error(
        'AgentClient.fromMCPClient: the supplied MCP Client is not connected. ' +
          'Call `await client.connect(transport)` before passing it here.'
      );
    }
    const { agentName, agentId, ...rest } = config;
    // Use randomUUID for collision resistance — the agent ID feeds session
    // routing so a debug-label collision (~65k via Math.random base36) could
    // alias two distinct in-process agents in a concurrent test fleet.
    const id = agentId ?? `in-process-${randomUUID()}`;
    // The `adcp-in-process://` scheme is parseable as a URL so existing
    // url-validation paths don't crash, but distinguishable from real http(s)
    // so the SDK skips network discovery + SSRF checks. The protocol layer
    // routes on the presence of `_inProcessMcpClient`, not the URI shape.
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
   * retain `contextId` whenever one is present, and retain a
   * `PendingTaskHandle` (taskId + contextId + skill name) only while the
   * response was non-terminal. Terminal responses clear `pendingTask` so
   * the next call starts a fresh server-side task.
   *
   * The `deferred` case is deliberately asymmetric: deferred results don't
   * surface a new `serverTaskId` on metadata (the caller holds a resume
   * token, not a task-id), so the partial-metadata guard preserves the
   * pre-defer handle — which is exactly what a later resume needs.
   */
  private retainSession<T>(result: TaskResult<T>): void {
    const meta = result.metadata;
    if (meta?.contextId) {
      this.currentContextId = meta.contextId;
    }
    if (NON_TERMINAL_STATES.has(meta?.status as string)) {
      if (meta?.serverTaskId && meta?.contextId && meta?.taskName) {
        this.pendingTask = {
          taskId: meta.serverTaskId,
          contextId: meta.contextId,
          taskName: meta.taskName,
        };
      }
      // Partial metadata preserves the pre-existing handle. Two distinct
      // cases land here: (1) the deferred resume-token path, where the
      // server intentionally omits a new `serverTaskId`; (2) a non-spec
      // A2A Task that lacks `contextId` or surfaces no `taskName` — by
      // design those are NOT retained as a fresh handle, since auto-
      // threading a partially-keyed taskId into a future call is exactly
      // the leak class #1590 narrows.
    } else {
      this.pendingTask = undefined;
    }
  }

  /**
   * Merge the caller's `TaskOptions` with the retained session ids so the
   * outbound request carries whatever session continuity is in scope.
   * Caller-supplied ids win (explicit > implicit); unset caller fields fall
   * back to the retained ones.
   *
   * **Auto-threading the retained taskId is narrowed.** Per A2A 0.3.0 §3.4,
   * `Message.taskId` continues the parent task — sending it implies "this
   * message belongs to that task." We auto-thread `pendingTask.taskId` only
   * when the next call is plausibly a continuation: same skill name AND
   * same effective contextId. A different skill (different work) or a
   * switched contextId signals new work; the retained handle is stale, and
   * sending it produces "Task not found" against spec-compliant sellers.
   *
   * HITL flows (e.g., `createMediaBuy` → `input-required` → `createMediaBuy`
   * resume) match same-skill same-context and continue to thread as before.
   * Cross-skill or cross-conversation reuse of one `AgentClient` no longer
   * leaks taskIds — see #1585 / #1590 for the motivating compliance scenario.
   */
  private withSession(taskName: string, options?: TaskOptions): TaskOptions {
    const explicitSwitch = options?.contextId !== undefined && options.contextId !== this.currentContextId;
    const effectiveContextId = options?.contextId ?? this.currentContextId;
    const continuation =
      !explicitSwitch &&
      this.pendingTask !== undefined &&
      this.pendingTask.contextId === effectiveContextId &&
      this.pendingTask.taskName === taskName;
    return {
      ...options,
      contextId: effectiveContextId,
      taskId: options?.taskId ?? (continuation ? this.pendingTask?.taskId : undefined),
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
    signature?: WebhookHeaderValue,
    timestamp?: WebhookHeaderValue,
    rawBody?: string | Buffer | Uint8Array
  ): Promise<boolean> {
    return this.client.handleWebhook(payload, taskType, operationId, signature, timestamp, rawBody);
  }

  /**
   * Verify and normalize an inbound webhook without dispatching handlers.
   */
  async verifyAndParseWebhook(options: VerifyAndParseWebhookOptions): Promise<WebhookParseResult> {
    return this.client.verifyAndParseWebhook(options);
  }

  /** Create a trusted-route HTTP receiver for this specific agent. */
  createWebhookHandler(adapter: WebhookHandlerAdapter = {}) {
    return this.client.createWebhookHandler(adapter);
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
  verifyWebhookSignature(
    rawBodyOrPayload: string | Buffer | Uint8Array | unknown,
    signature: WebhookHeaderValue,
    timestamp: WebhookHeaderValue
  ): boolean {
    return this.client.verifyWebhookSignature(rawBodyOrPayload, signature, timestamp);
  }

  // ====== MEDIA BUY TASKS ======

  /**
   * Discover available advertising products.
   *
   * Response products expose only canonical `format_options[]`, regardless of
   * the seller's negotiated wire version. The SDK performs any required legacy
   * translation below this public boundary.
   *
   * Projection failures surface portably on `result.data.errors[]` and are
   * also mirrored on `result.data.projection.diagnostics` (structured
   * `source: 'sdk'` markers; codes mirror the spec's error-code
   * vocabulary plus three SDK-local codes — see the projection
   * module's `ProjectionDiagnostic` type for the full set).
   *
   * Protocol tooling that must inspect raw seller emission uses the explicit
   * deprecated `getProductsLegacy()` method.
   */
  async getProducts(
    params: CanonicalGetProductsRequest,
    inputHandler?: InputHandler,
    options?: CanonicalProjectionTaskOptions
  ): Promise<TaskResult<CanonicalGetProductsResponse>> {
    const result = await this.client.getProducts(params, inputHandler, {
      ...options,
      ...this.withSession('get_products', options),
    });

    this.retainSession(result);
    return result;
  }

  /** Discover products through the compact AdCP 3.2 catalog task. */
  async listProducts(
    params: ListProductsRequest,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<ListProductsResponse>> {
    const result = await this.client.executeTask(
      'list_products',
      params,
      inputHandler,
      this.withSession('list_products', options)
    );
    this.retainSession(result);
    return result;
  }

  /** Request one or more compact AdCP 3.2 proposals. */
  async requestProposals(
    params: MutatingRequestInput<RequestProposalsRequest>,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<RequestProposalsResponse>> {
    const result = await this.client.executeTask(
      'request_proposals',
      params,
      inputHandler,
      this.withSession('request_proposals', options)
    );
    if (
      result.data &&
      (result.data.outcome === 'products_available' || result.data.purchase_continuation !== undefined)
    ) {
      throw new TypeError(
        'request_proposals returned the projection-only products_available outcome from a native compact seller.'
      );
    }
    this.retainSession(result);
    return result;
  }

  /** Decline outstanding proposals. */
  async declineProposals(
    params: MutatingRequestInput<DeclineProposalsRequest>,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<DeclineProposalsResponse>> {
    const result = await this.client.executeTask(
      'decline_proposals',
      params,
      inputHandler,
      this.withSession('decline_proposals', options)
    );
    this.retainSession(result);
    return result;
  }

  /** Buy explicit products through the compact AdCP 3.2 lifecycle. */
  async buyProducts(
    params: MutatingRequestInput<BuyProductsRequest>,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<BuyProductsResponse>> {
    const result = await this.client.executeTask(
      'buy_products',
      params,
      inputHandler,
      this.withSession('buy_products', options)
    );
    this.retainSession(result);
    return result;
  }

  /** Accept a proposal through the compact AdCP 3.2 lifecycle. */
  async acceptProposal(
    params: MutatingRequestInput<AcceptProposalRequest>,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<AcceptProposalResponse>> {
    const result = await this.client.executeTask(
      'accept_proposal',
      params,
      inputHandler,
      this.withSession('accept_proposal', options)
    );
    this.retainSession(result);
    return result;
  }

  /** Apply a compact lifecycle control to an existing media buy. */
  async controlMediaBuy(
    params: MutatingRequestInput<ControlMediaBuyRequest>,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<ControlMediaBuyResponse>> {
    const result = await this.client.executeTask(
      'control_media_buy',
      params,
      inputHandler,
      this.withSession('control_media_buy', options)
    );
    this.retainSession(result);
    return result;
  }

  /** Record a governance-plan adjustment with idempotent 3.2 semantics. */
  async reportPlanAdjustment(
    params: MutatingRequestInput<ReportPlanAdjustmentRequest>,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<ReportPlanAdjustmentResponse>> {
    const result = await this.client.executeTask(
      'report_plan_adjustment',
      params,
      inputHandler,
      this.withSession('report_plan_adjustment', options)
    );
    this.retainSession(result);
    return result;
  }

  /** Declaratively replace agent-anchored notification subscriptions. */
  async syncAgentNotificationConfigs(
    params: MutatingRequestInput<SyncAgentNotificationConfigsRequest>,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<SyncAgentNotificationConfigsResponse>> {
    const result = await this.client.executeTask(
      'sync_agent_notification_configs',
      params,
      inputHandler,
      this.withSession('sync_agent_notification_configs', options)
    );
    this.retainSession(result);
    return result;
  }

  /**
   * Revise or atomically finalize compact AdCP proposals.
   *
   * The SDK validates batch/cardinality rules and any explicit seller
   * capability declaration before transport, and auto-generates the
   * idempotency key when omitted.
   */
  async refineProposals(
    params: RefineProposalsInput,
    inputHandler?: InputHandler,
    options?: ProposalRefinementTaskOptions
  ): Promise<TaskResult<RefineProposalsResponse>> {
    const { proposalRefinementCapabilities, ...taskOptions } = options ?? {};
    const request = buildRefineProposalsRequest(
      params,
      proposalRefinementCapabilities,
      this.client.getWireAdcpVersion()
    );
    const result = (await this.client.executeTask(
      'refine_proposals' as never,
      request as never,
      inputHandler,
      this.withSession('refine_proposals', taskOptions)
    )) as TaskResult<RefineProposalsResponse>;
    this.retainSession(result);
    if (result.success && result.status === 'completed') {
      const data = stripRefineProposalsSdkAnnotations(result.data);
      assertRefineProposalsResponse(request, data);
      return { ...result, data };
    }
    return result;
  }

  /** @deprecated Explicit raw-wire escape hatch for migration tooling. */
  async getProductsLegacy(
    params: GetProductsRequest,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<GetProductsResponse>> {
    const result = await this.client.getProductsLegacy(params, inputHandler, {
      ...this.withSession('get_products', options),
    });
    this.retainSession(result);
    return result;
  }

  /** @deprecated Migration-only access to a legacy named-format catalog. */
  async listCreativeFormatsLegacy(
    params: ListCreativeFormatsRequest,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<ListCreativeFormatsResponse>> {
    const result = await this.client.listCreativeFormatsLegacy(params, inputHandler, {
      ...this.withSession('list_creative_formats', options),
    });

    this.retainSession(result);

    return result;
  }

  /** @deprecated Migration-only access to legacy creative transformer declarations. */
  async listTransformersLegacy(
    params: ListTransformersRequest,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<ListTransformersResponse>> {
    const result = await this.client.listTransformersLegacy(params, inputHandler, {
      ...this.withSession('list_transformers', options),
    });
    this.retainSession(result);
    return result;
  }

  /**
   * Create a new media buy.
   *
   * Discover canonical `format_options[]` with `getProducts()`, select a
   * `format_option_id`, and send only canonical package and creative fields.
   * Compatibility translation for an older seller happens below this method.
   *
   * ```ts
   * const { data: { products } } = await agent.getProducts({ brief: '...' });
   * const product = products[0];
   * const format = product.format_options[0];
   *
   * await agent.createMediaBuy({
   *   packages: [{
   *     package_id: 'pkg-1',
   *     product_id: product.product_id,
   *     pricing_option_id: product.pricing_options[0].pricing_option_id,
   *     format_option_refs: [{
   *       scope: 'product',
   *       format_option_id: format.format_option_id
   *     }],
   *     creatives: [{
   *       creative_id: 'hero',
   *       format_kind: format.format_kind,
   *       format_option_ref: {
   *         scope: 'product',
   *         format_option_id: format.format_option_id
   *       },
   *       assets: { image: { url: 'https://cdn.example/hero.png' } }
   *     }],
   *     budget: { currency: 'USD', total: 5000 },
   *   }],
   *   // ...
   * });
   * ```
   *
   * **Inline creative fallback.** Sellers that do not advertise a creative
   * library (`supportsSyncCreatives(await agent.getCapabilities()) === false`)
   * can still accept package-scoped creative uploads when they advertise
   * `caps.features.inlineCreativeManagement`. Use
   * `inlineCreativesForPackages(packages, creatives, { assignments })` to
   * project `sync_creatives`-style creative assets into create-media-buy
   * package payloads without rewriting a raw `sync_creatives` call. If using
   * assignments for create payloads, give each package a stable key such as
   * `context.buyer_ref`, or pass a custom `packageId` resolver.
   *
   * Existing applications that still hold old named-format payloads must opt
   * into `createMediaBuyLegacy()` explicitly.
   */
  async createMediaBuy(
    params: MutatingRequestInput<CanonicalCreateMediaBuyRequest>,
    inputHandler?: InputHandler,
    options?: CreativeDeliveryTaskOptions
  ): Promise<TaskResult<CanonicalCreativeResponse<CreateMediaBuyResponse>>> {
    const result = await this.client.createMediaBuy(params, inputHandler, {
      ...this.withSession('create_media_buy', options),
    });

    this.retainSession(result);

    return result;
  }

  /**
   * @deprecated Use `createMediaBuy`; this raw compatibility surface accepts legacy creative `format_id`.
   * Projection-only options are ignored.
   */
  async createMediaBuyLegacy(
    params: MutatingRequestInput<CreateMediaBuyRequest>,
    inputHandler?: InputHandler,
    options?: CreativeDeliveryTaskOptions
  ): Promise<TaskResult<CreateMediaBuyResponse>> {
    const result = await this.client.createMediaBuyLegacy(params, inputHandler, {
      ...this.withSession('create_media_buy', options),
    });
    this.retainSession(result);
    return result;
  }

  /** @internal Run deterministic legacy-create preflight before an application-owned atomic claim hook. */
  async createMediaBuyLegacyWithPreDispatch(
    params: MutatingRequestInput<CreateMediaBuyRequest>,
    beforeDispatch: BeforeProtocolDispatchHook<CreateMediaBuyResponse>,
    inputHandler?: InputHandler,
    options?: CreativeDeliveryTaskOptions
  ): Promise<TaskResult<CreateMediaBuyResponse>> {
    const result = await this.client.createMediaBuyLegacyWithPreDispatch(params, beforeDispatch, inputHandler, {
      ...this.withSession('create_media_buy', options),
    });
    this.retainSession(result);
    return result;
  }

  /**
   * Update an existing media buy.
   *
   * For sellers without a creative library but with
   * `caps.features.inlineCreativeManagement`, post-create creative replacement
   * can be represented as package-scoped inline `packages[].creatives` on this
   * request. Build the package patch with `inlineCreativesForPackages()` and
   * preflight it with `preflightUpdateMediaBuy(currentBuy, patch)` so
   * `available_actions[]` allows `replace_creative` before dispatch.
   * Use `format_kind` and `format_option_ref` for every creative in the patch;
   * the SDK handles any negotiated compatibility conversion.
   */
  async updateMediaBuy(
    params: MutatingRequestInput<CanonicalUpdateMediaBuyRequest>,
    inputHandler?: InputHandler,
    options?: CreativeDeliveryTaskOptions
  ): Promise<TaskResult<CanonicalCreativeResponse<UpdateMediaBuyResponse>>> {
    const result = await this.client.updateMediaBuy(params, inputHandler, {
      ...this.withSession('update_media_buy', options),
    });

    this.retainSession(result);

    return result;
  }

  /**
   * @deprecated Use `updateMediaBuy`; this raw compatibility surface accepts legacy creative `format_id`.
   * Projection-only options are ignored.
   */
  async updateMediaBuyLegacy(
    params: MutatingRequestInput<UpdateMediaBuyRequest>,
    inputHandler?: InputHandler,
    options?: CreativeDeliveryTaskOptions
  ): Promise<TaskResult<UpdateMediaBuyResponse>> {
    const result = await this.client.updateMediaBuyLegacy(params, inputHandler, {
      ...this.withSession('update_media_buy', options),
    });
    this.retainSession(result);
    return result;
  }

  /**
   * Sync creative assets into the seller's reusable creative library.
   *
   * This is library-scoped: assignments can reference packages, but a raw
   * `sync_creatives` request does not contain enough media-buy context for the
   * SDK to safely rewrite it into inline package creatives. When the seller
   * lacks `creative.has_creative_library` but does advertise
   * `media_buy.features.inline_creative_management`, use
   * `inlineCreativesForPackages()` with explicit package/media-buy context and
   * send a separate `create_media_buy` or `update_media_buy` request with its
   * own idempotency key. If neither capability is advertised, creative upload
   * is not available through this SDK helper surface.
   *
   * A sync request does not carry product declarations. When compatibility
   * translation needs seller selection metadata, pass
   * `options.creativeFormatProjection.selectorContainers` with the routed
   * package/product selectors. Assignments scope each creative to its package.
   */
  async syncCreatives(
    params: MutatingRequestInput<CanonicalSyncCreativesRequest>,
    inputHandler?: InputHandler,
    options?: SyncCreativesTaskOptions
  ): Promise<TaskResult<CanonicalCreativeResponse<SyncCreativesResponse>>> {
    const result = await this.client.syncCreatives(params, inputHandler, {
      ...this.withSession('sync_creatives', options),
    });

    this.retainSession(result);

    return result;
  }

  /**
   * @deprecated Use `syncCreatives`; this raw compatibility surface accepts legacy creative `format_id`.
   * Projection-only options are ignored.
   */
  async syncCreativesLegacy(
    params: MutatingRequestInput<SyncCreativesRequest>,
    inputHandler?: InputHandler,
    options?: SyncCreativesTaskOptions
  ): Promise<TaskResult<SyncCreativesResponse>> {
    const result = await this.client.syncCreativesLegacy(params, inputHandler, {
      ...this.withSession('sync_creatives', options),
    });
    this.retainSession(result);
    return result;
  }

  /**
   * List creative assets
   */
  async listCreatives(
    params: CanonicalListCreativesRequest,
    inputHandler?: InputHandler,
    options?: CanonicalProjectionTaskOptions
  ): Promise<TaskResult<CanonicalListCreativesResponse>> {
    const result = await this.client.listCreatives(params, inputHandler, {
      ...options,
      ...this.withSession('list_creatives', options),
    });

    this.retainSession(result);
    return result;
  }

  /**
   * Return the unprojected `list_creatives` wire response.
   *
   * @deprecated Compatibility-only escape hatch for migration and protocol tooling.
   */
  async listCreativesLegacy(
    params: ListCreativesRequest,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<ListCreativesResponse>> {
    const result = await this.client.listCreativesLegacy(params, inputHandler, {
      ...this.withSession('list_creatives', options),
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
    options?: CanonicalReadTaskOptions
  ): Promise<TaskResult<CanonicalCreativeResponse<GetMediaBuysResponse>>> {
    const result = await this.client.getMediaBuys(params, inputHandler, {
      ...this.withSession('get_media_buys', options),
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
    options?: CanonicalReadTaskOptions
  ): Promise<TaskResult<CanonicalCreativeResponse<GetMediaBuyDeliveryResponse>>> {
    const result = await this.client.getMediaBuyDelivery(params, inputHandler, {
      ...this.withSession('get_media_buy_delivery', options),
    });

    this.retainSession(result);

    return result;
  }

  /** Retrieve canonical creative-level and variant-level delivery metrics. */
  async getCreativeDelivery(
    params: GetCreativeDeliveryRequest,
    inputHandler?: InputHandler,
    options?: CanonicalProjectionTaskOptions
  ): Promise<TaskResult<CanonicalCreativeResponse<GetCreativeDeliveryResponse>>> {
    const result = await this.client.getCreativeDelivery(params, inputHandler, {
      ...options,
      ...this.withSession('get_creative_delivery', options),
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
      ...this.withSession('provide_performance_feedback', options),
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
    const result = await this.client.getSignals(params, inputHandler, this.withSession('get_signals', options));

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
      ...this.withSession('activate_signal', options),
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
      ...this.withSession('get_adcp_capabilities', options),
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
  async getCapabilities(options?: Pick<TaskOptions, 'signal' | 'transport'>): Promise<AdcpCapabilities> {
    return this.client.getCapabilities(options);
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
   * Assert that the seller's capabilities corroborate this client's pinned
   * AdCP major (per `getAdcpVersion()`). Throws `VersionUnsupportedError`
   * otherwise. Set `ADCP_ALLOW_V2=1` to bypass.
   */
  async requireSupportedMajor(taskType: string = 'request'): Promise<void> {
    return this.client.requireSupportedMajor(taskType);
  }

  /**
   * Deprecated alias for {@link requireSupportedMajor}.
   * @deprecated Use `requireSupportedMajor()` instead.
   */
  async requireV3(taskType: string = 'request'): Promise<void> {
    return this.client.requireSupportedMajor(taskType);
  }

  /** Preview a creative using canonical capability or creative-library identity. */
  async previewCreative(
    params: CanonicalPreviewCreativeRequest,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<CanonicalPreviewCreativeResponse>> {
    const result = await this.client.previewCreative(params, inputHandler, {
      ...this.withSession('preview_creative', options),
    });
    this.retainSession(result);
    return result;
  }

  /** @deprecated Migration-only access to legacy `format_id`-based creative preview. */
  async previewCreativeLegacy(
    params: PreviewCreativeRequest,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<PreviewCreativeResponse>> {
    const result = await this.client.previewCreativeLegacy(params, inputHandler, {
      ...this.withSession('preview_creative', options),
    });
    this.retainSession(result);
    return result;
  }

  /** @deprecated Migration-only access to legacy `target_format_id`-based creative building. */
  async buildCreativeLegacy(
    params: MutatingRequestInput<BuildCreativeRequest>,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<BuildCreativeResponse>> {
    const result = await this.client.buildCreativeLegacy(params, inputHandler, {
      ...this.withSession('build_creative', options),
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
      ...this.withSession('list_accounts', options),
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
      ...this.withSession('sync_accounts', options),
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
      ...this.withSession('sync_audiences', options),
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
      ...this.withSession('create_property_list', options),
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
      ...this.withSession('get_property_list', options),
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
      ...this.withSession('update_property_list', options),
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
      ...this.withSession('list_property_lists', options),
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
      ...this.withSession('delete_property_list', options),
    });
    this.retainSession(result);
    return result;
  }

  /**
   * List content standards
   */
  async listContentStandardsLegacy(
    params: ListContentStandardsRequest,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<ListContentStandardsResponse>> {
    const result = await this.client.listContentStandardsLegacy(params, inputHandler, {
      ...this.withSession('list_content_standards', options),
    });
    this.retainSession(result);
    return result;
  }

  /**
   * Get content standards
   */
  async getContentStandardsLegacy(
    params: GetContentStandardsRequest,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<GetContentStandardsResponse>> {
    const result = await this.client.getContentStandardsLegacy(params, inputHandler, {
      ...this.withSession('get_content_standards', options),
    });
    this.retainSession(result);
    return result;
  }

  /**
   * Calibrate content against standards
   */
  async calibrateContentLegacy(
    params: MutatingRequestInput<CalibrateContentRequest>,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<CalibrateContentResponse>> {
    const result = await this.client.calibrateContentLegacy(params, inputHandler, {
      ...this.withSession('calibrate_content', options),
    });
    this.retainSession(result);
    return result;
  }

  /**
   * Validate content delivery
   */
  async validateContentDeliveryLegacy(
    params: ValidateContentDeliveryRequest,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<ValidateContentDeliveryResponse>> {
    const result = await this.client.validateContentDeliveryLegacy(params, inputHandler, {
      ...this.withSession('validate_content_delivery', options),
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
      ...this.withSession('si_get_offering', options),
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
      ...this.withSession('si_initiate_session', options),
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
      ...this.withSession('si_send_message', options),
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
      ...this.withSession('si_terminate_session', options),
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
   * Always clears the retained pending-task handle — a persisted `contextId`
   * places the next send into the same server-side session, but any old
   * `taskId` is stale.
   */
  resetContext(seed?: string): void {
    if (this.currentContextId) {
      this.client.clearConversationHistory(this.currentContextId);
    }
    this.currentContextId = seed;
    this.pendingTask = undefined;
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
    return this.pendingTask?.taskId;
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
    const otherIsInProcess = other instanceof AgentClient && other._isInProcess;
    if (this._isInProcess || otherIsInProcess) {
      // In-process agents have no canonical URL to resolve — compare sentinel IDs instead.
      const thisId = this.getAgentId();
      const otherId = other instanceof AgentClient ? other.getAgentId() : other.id;
      return thisId === otherId;
    }
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
  async getAgentInfo(options?: Pick<TaskOptions, 'signal' | 'transport'>) {
    return this.client.getAgentInfo(options);
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
   * // result is TaskResult<CanonicalGetProductsResponse> - no casting needed!
   *
   * // ✅ CUSTOM TYPES: For non-standard tasks
   * const customResult = await agent.executeCustomTask<MyCustomResponse>('custom_task', params);
   * ```
   */
  async executeTask<K extends AdcpTaskName>(
    taskName: K,
    params: TaskRequestFor<K>,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<TaskResponseTypeMap[K]>>;

  async executeTask(
    taskName: string,
    params: Record<string, unknown>,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<unknown>> {
    switch (taskName) {
      case 'get_products':
        return this.getProducts(params as CanonicalGetProductsRequest, inputHandler, options);
      case 'refine_proposals':
        return (await this.refineProposals(
          params as RefineProposalsInput,
          inputHandler,
          options
        )) as TaskResult<unknown>;
      case 'create_media_buy':
        return (await this.createMediaBuy(
          params as MutatingRequestInput<CanonicalCreateMediaBuyRequest>,
          inputHandler,
          options
        )) as TaskResult<unknown>;
      case 'update_media_buy':
        return (await this.updateMediaBuy(
          params as MutatingRequestInput<CanonicalUpdateMediaBuyRequest>,
          inputHandler,
          options
        )) as TaskResult<unknown>;
      case 'sync_creatives':
        return (await this.syncCreatives(
          params as MutatingRequestInput<CanonicalSyncCreativesRequest>,
          inputHandler,
          options
        )) as TaskResult<unknown>;
      case 'list_creatives':
        return this.listCreatives(params as CanonicalListCreativesRequest, inputHandler, options);
      case 'get_media_buys':
        return this.getMediaBuys(params as GetMediaBuysRequest, inputHandler, options);
      case 'get_media_buy_delivery':
        return this.getMediaBuyDelivery(params as GetMediaBuyDeliveryRequest, inputHandler, options);
      case 'get_creative_delivery':
        return this.getCreativeDelivery(params as GetCreativeDeliveryRequest, inputHandler, options);
    }
    const result = await this.client.executeTaskLegacy(taskName, params, inputHandler, {
      ...this.withSession(taskName, options),
    });

    this.retainSession(result);

    return result;
  }

  /** Execute an extension task that is not part of the standard AdCP task set. */
  async executeCustomTask<T = unknown>(
    taskName: string,
    params: Record<string, unknown>,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<T>> {
    const result = await this.client.executeCustomTask<T>(taskName, params, inputHandler, {
      ...this.withSession(taskName, options),
    });

    this.retainSession(result);
    return result;
  }

  /**
   * Explicit raw-task compatibility escape hatch for conformance and migration tooling.
   * @deprecated Application code should use typed primary methods or `executeTask()`.
   */
  async executeTaskLegacy<T = unknown>(
    taskName: string,
    params: Record<string, unknown>,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<T>> {
    const result = await this.client.executeTaskLegacy<T>(taskName, params, inputHandler, {
      ...this.withSession(taskName, options),
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
