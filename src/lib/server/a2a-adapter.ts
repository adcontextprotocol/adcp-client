/**
 * A2A transport adapter for `AdcpServer`.
 *
 * Peer of `serve()` / `createExpressAdapter()`: same `AdcpServer` handle,
 * different wire transport. MCP and A2A share the dispatcher, idempotency
 * store, state store, resolveAccount, and governance — everything the
 * framework pipeline owns is transport-agnostic.
 *
 * **Scope (v0)**: `message/send`, `tasks/get`, `tasks/cancel`, and
 * `GET /.well-known/agent-card.json`. Streaming (`message/stream`),
 * push notifications, and mid-flight `input-required` interrupts are
 * explicit "not yet" — see `docs/guides/BUILD-AN-AGENT.md`.
 *
 * **Handler-return → A2A `Task.state` mapping:**
 *
 * | Handler returned…                   | A2A result                                         |
 * |-------------------------------------|----------------------------------------------------|
 * | Success arm                         | `Task.state = 'completed'` + DataPart artifact     |
 * | Submitted arm (`status:'submitted'`)| `Task.state = 'submitted'` + DataPart artifact[^1] |
 * | Error arm (`errors:[]`)             | `Task.state = 'failed'`    + DataPart artifact     |
 * | `adcpError()` envelope              | `Task.state = 'failed'`    + DataPart artifact     |
 *
 * [^1]: A2A owns `Task.id`. The AdCP-level `task_id` rides on the DataPart
 * artifact's `data.adcp_task_id` — buyers poll the A2A `Task.id` via
 * `tasks/get`; the `adcp_task_id` is the handle they'd use against AdCP
 * tool-task APIs if they were calling the agent over MCP directly.
 *
 * **Message shape.** A client addresses a tool by sending a `Message` with
 * a single `DataPart`: `{ kind: 'data', data: { skill, input } }`. The
 * `skill` must match a registered AdCP tool name (e.g. `get_products`);
 * `input` becomes the tool arguments before AdCP schema validation runs.
 *
 * @preview v0 surface — field semantics may shift while the ecosystem
 * converges on AdCP-over-A2A conventions. Pinning a minor version is
 * recommended.
 */

import {
  type AgentExecutor,
  type ExecutionEventBus,
  type RequestContext,
  type TaskStore,
  type User,
  type UnauthenticatedUser,
  DefaultRequestHandler,
  InMemoryTaskStore as SdkInMemoryTaskStore,
  DefaultExecutionEventBusManager,
} from '@a2a-js/sdk/server';
import { jsonRpcHandler, agentCardHandler } from '@a2a-js/sdk/server/express';
import type {
  AgentCard,
  AgentCapabilities,
  AgentProvider,
  AgentSkill,
  Artifact,
  DataPart,
  Message,
  SecurityScheme,
  Task,
  TaskArtifactUpdateEvent,
  TaskStatusUpdateEvent,
} from '@a2a-js/sdk';
import type { Request, RequestHandler } from 'express';
import { randomUUID } from 'node:crypto';
import { getSdkServer, listRegisteredToolNames, type AdcpAuthInfo, type AdcpServer } from './adcp-server';
import type { McpToolResponse } from './responses';
import type { AdcpLogger } from './create-adcp-server';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Agent-card identity fields the adapter can't derive automatically.
 * Auto-seeded fields (`capabilities`, `skills`, `defaultInputModes`,
 * `defaultOutputModes`, `protocolVersion`, `additionalInterfaces`) may
 * be overridden by passing them here; the merged card is validated
 * against A2A's required-field set at boot.
 */
export interface A2AAgentCardOverrides {
  /** Human-readable agent name (required). */
  name: string;
  /** Human-readable description (required). */
  description: string;
  /** Agent URL — the endpoint A2A clients connect to (required). */
  url: string;
  /** Agent version (required). */
  version: string;

  provider?: AgentProvider;
  documentationUrl?: string;
  iconUrl?: string;
  securitySchemes?: { [k: string]: SecurityScheme };
  security?: { [k: string]: string[] }[];
  preferredTransport?: string;

  /**
   * Override the auto-generated capabilities. The adapter sets
   * `streaming: false` and `pushNotifications: false` by default (v0
   * ships neither). Set `streaming: true` if you wire a downstream
   * extension; the adapter still won't emit `TaskStatusUpdateEvent`s
   * on the stream path in v0.
   */
  capabilities?: AgentCapabilities;

  /**
   * Override the auto-generated skills list. When omitted the adapter
   * derives one `AgentSkill` per registered AdCP tool from the server's
   * capability object. Supply this to add descriptions, examples, tags,
   * or per-skill input/output modes the SDK can't infer.
   */
  skills?: AgentSkill[];

  defaultInputModes?: string[];
  defaultOutputModes?: string[];
  protocolVersion?: string;
}

/**
 * Options for {@link createA2AAdapter}.
 *
 * **Auth posture.** `authenticate(req)` runs BEFORE the tool handler
 * sees the request. Return an `AdcpAuthInfo` to let the pipeline
 * proceed with that principal; return `null` (or throw) to reject.
 * A rejection currently surfaces as a generic JSON-RPC `-32000`
 * server error — the `@a2a-js/sdk` doesn't yet expose a typed
 * authentication-failed code for the `UserBuilder` path. Production
 * deployments SHOULD wire upstream middleware (e.g. `express-jwt`) to
 * reject with a proper HTTP 401 / WWW-Authenticate challenge before
 * the request reaches `jsonRpcHandler`. The `authenticate` option
 * here is a last-line-of-defense guard, not the primary auth surface.
 *
 * **Agent-card `securitySchemes`.** The `agentCard.securitySchemes`
 * you provide is served verbatim at `/.well-known/agent-card.json` —
 * only put non-secret discovery data there (token endpoint, scopes,
 * OIDC issuer URL). Never paste client secrets, private JWKS, or
 * internal URLs into the card. The SDK doesn't schema-validate
 * `securitySchemes` at boot (v0 check is required-field presence
 * only), so a hand-crafted malformed entry will ship as-written.
 *
 * Omitting `authenticate` makes the adapter anonymous — handlers see
 * `ctx.authInfo === undefined`, matching `serve({ authenticate: undefined })`.
 */
export interface A2AAdapterOptions {
  /** AdCP server whose registered tools this adapter exposes over A2A. */
  server: AdcpServer;

  /**
   * Authenticate an inbound A2A request. Transport-level auth runs
   * before `AdcpServer.invoke()` so the framework pipeline sees a
   * verified `authInfo`. Return `null` (or throw) to reject.
   */
  authenticate?: (req: Request) => Promise<AdcpAuthInfo | null>;

  /** Seller-supplied agent-card identity fields. Required. */
  agentCard: A2AAgentCardOverrides;

  /**
   * A2A task store. Defaults to the SDK's `InMemoryTaskStore`.
   * Persistent deployments should supply a durable implementation
   * (e.g. a Postgres-backed `TaskStore`).
   */
  taskStore?: TaskStore;

  /** Optional logger. Falls back to `console`. */
  logger?: AdcpLogger;
}

/**
 * Value returned by {@link createA2AAdapter}. `jsonRpcHandler` accepts
 * A2A JSON-RPC posts (`message/send`, `tasks/get`, `tasks/cancel`);
 * mount it on the path your agent card advertises. `agentCardHandler`
 * serves the discovery GET — mount it at
 * `/.well-known/agent-card.json`.
 */
export interface A2AAdapter {
  jsonRpcHandler: RequestHandler;
  agentCardHandler: RequestHandler;
  /** Returns the merged, validated agent card. */
  getAgentCard(): Promise<AgentCard>;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Our `User` carries the full AdCP auth payload, not just the two
 * getters A2A's minimal `User` requires. The executor reads this back
 * out of `RequestContext.context.user`.
 */
interface A2AAdcpUser extends User {
  readonly adcpAuthInfo?: AdcpAuthInfo;
}

function buildAuthenticatedUser(authInfo: AdcpAuthInfo): A2AAdcpUser {
  const clientId = authInfo.clientId;
  return {
    get isAuthenticated() {
      return true;
    },
    get userName() {
      return clientId;
    },
    adcpAuthInfo: authInfo,
  };
}

function buildAnonymousUser(): UnauthenticatedUser {
  return {
    get isAuthenticated() {
      return false as const;
    },
    get userName() {
      return 'anonymous';
    },
  };
}

function getAdcpAuthInfo(context: RequestContext['context']): AdcpAuthInfo | undefined {
  const user = context?.user as A2AAdcpUser | undefined;
  return user?.adcpAuthInfo;
}

/**
 * Extract the `{ skill, input }` pair from the inbound Message's parts.
 *
 * Convention: the client sends a single DataPart with
 * `{ skill: '<tool_name>', input: { ...args } }`. Reject anything else
 * — text-only payloads, files, multiple data parts — so buyers get a
 * deterministic error instead of silently-wrong routing.
 */
interface ExtractedInvocation {
  skill: string;
  input: Record<string, unknown>;
}

function extractInvocation(message: Message): ExtractedInvocation {
  if (!Array.isArray(message.parts) || message.parts.length === 0) {
    throw new A2AInvocationError('Message must carry at least one part with a `data` kind.');
  }
  const dataParts = message.parts.filter((p): p is DataPart => p?.kind === 'data');
  if (dataParts.length === 0) {
    throw new A2AInvocationError(
      "Message must include a DataPart with { skill, input } — text-only messages aren't routable to AdCP tools."
    );
  }
  if (dataParts.length > 1) {
    throw new A2AInvocationError(
      'Message must include exactly one DataPart — multi-part invocations are not supported in v0.'
    );
  }
  const firstDataPart = dataParts[0]!;
  const rawData = firstDataPart.data;
  // Guard before destructuring — a client sending `{ kind: 'data', data: null }`
  // or `data: "string"` would otherwise TypeError on payload.skill and surface
  // as a generic HANDLER_THREW instead of INVALID_INVOCATION.
  if (rawData == null || typeof rawData !== 'object' || Array.isArray(rawData)) {
    throw new A2AInvocationError('DataPart `data` must be an object containing { skill, input }.');
  }
  const payload = rawData as Record<string, unknown>;
  const skill = payload.skill;
  const input = payload.input;
  if (typeof skill !== 'string' || skill.length === 0) {
    throw new A2AInvocationError('DataPart must include a non-empty string `skill` field naming the AdCP tool.');
  }
  if (input != null && (typeof input !== 'object' || Array.isArray(input))) {
    throw new A2AInvocationError('DataPart `input` must be an object (or omitted).');
  }
  return { skill, input: (input as Record<string, unknown>) ?? {} };
}

/** Thrown when an incoming Message doesn't match the AdCP-over-A2A convention. */
export class A2AInvocationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'A2AInvocationError';
  }
}

// ---------------------------------------------------------------------------
// Executor — translates A2A execute() into adcpServer.invoke() + events
// ---------------------------------------------------------------------------

/**
 * Classify a framework-produced `McpToolResponse` so the executor knows
 * what A2A `Task.state` to publish.
 */
type ClassifiedResult =
  | { kind: 'success'; data: Record<string, unknown> }
  | { kind: 'submitted'; adcpTaskId: string; data: Record<string, unknown> }
  | { kind: 'error_arm'; data: Record<string, unknown> }
  | { kind: 'adcp_error'; data: Record<string, unknown> };

function classifyResponse(res: McpToolResponse): ClassifiedResult {
  const structured = (res.structuredContent ?? {}) as Record<string, unknown>;
  if (res.isError === true) {
    if (structured.adcp_error && typeof structured.adcp_error === 'object') {
      return { kind: 'adcp_error', data: structured };
    }
    return { kind: 'error_arm', data: structured };
  }
  if (structured.status === 'submitted' && typeof structured.task_id === 'string') {
    return { kind: 'submitted', adcpTaskId: structured.task_id, data: structured };
  }
  return { kind: 'success', data: structured };
}

class AdcpA2AAgentExecutor implements AgentExecutor {
  // Cooperative-cancel flag. `DefaultRequestHandler.cancelTask` only
  // calls our executor's `cancelTask` while an execute() is in-flight
  // (eventBus still open); post-completion cancels are handled by the
  // SDK directly against the task store. So this set only holds
  // taskIds that currently have a pending `cancelTask`, and execute()
  // always clears its entry at the end — no unbounded growth.
  private readonly canceled = new Set<string>();

  // A2A `Task.id` → original `contextId`. Populated when execute()
  // starts so `cancelTask` can emit a well-formed status-update event
  // against the same contextId instead of guessing an empty string.
  // Cleared alongside the canceled flag in execute()'s finally block.
  private readonly taskContextIds = new Map<string, string>();

  constructor(
    private readonly server: AdcpServer,
    private readonly logger: AdcpLogger
  ) {}

  async execute(requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const { taskId, contextId, userMessage } = requestContext;
    const authInfo = getAdcpAuthInfo(requestContext.context);

    this.taskContextIds.set(taskId, contextId);
    try {
      // Register the task with the ResultManager by publishing a Task
      // event first — subsequent status-update / artifact-update events
      // only resolve if the manager has seen the task. `working` is the
      // initial state; we replace it with completed / submitted / failed
      // once the handler returns.
      this.publishInitialTask(eventBus, taskId, contextId, userMessage);

      let invocation: ExtractedInvocation;
      try {
        invocation = extractInvocation(userMessage);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Invalid A2A invocation';
        this.emitFailure(eventBus, taskId, contextId, {
          reason: 'INVALID_INVOCATION',
          message,
        });
        return;
      }

      let response: McpToolResponse;
      try {
        response = await this.server.invoke({
          toolName: invocation.skill,
          args: invocation.input,
          ...(authInfo && { authInfo }),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error('A2A adapter: handler invocation threw', { toolName: invocation.skill, error: message });
        this.emitFailure(eventBus, taskId, contextId, {
          reason: 'HANDLER_THREW',
          message,
        });
        return;
      }

      if (this.canceled.has(taskId)) {
        this.publishStatus(eventBus, taskId, contextId, 'canceled', true);
        return;
      }

      const classified = classifyResponse(response);
      this.publishArtifact(eventBus, taskId, contextId, classified);
      this.publishStatus(
        eventBus,
        taskId,
        contextId,
        classified.kind === 'success' ? 'completed' : classified.kind === 'submitted' ? 'submitted' : 'failed',
        true
      );
    } finally {
      // Clean up per-task state regardless of path — the executor is
      // long-lived (one per adapter instance), so any leak compounds.
      this.canceled.delete(taskId);
      this.taskContextIds.delete(taskId);
      eventBus.finished();
    }
  }

  async cancelTask(taskId: string, eventBus: ExecutionEventBus): Promise<void> {
    this.canceled.add(taskId);
    // `DefaultRequestHandler.cancelTask` only reaches us when execute()
    // is still in-flight (eventBus still open). Publish the canceled
    // status so the SDK's secondary `_processEvents` loop terminates;
    // execute() will ALSO see the flag and short-circuit before
    // publishing a success/failure status. The A2A event bus is
    // idempotent on duplicate status publishes — whichever lands first
    // wins the taskStore write.
    const contextId = this.taskContextIds.get(taskId) ?? '';
    this.publishStatus(eventBus, taskId, contextId, 'canceled', true);
    // Do NOT call eventBus.finished() here — execute()'s finally block
    // owns the finished() signal, and calling it twice risks closing
    // the queue mid-event-flush on the primary processEvents loop.
  }

  private publishInitialTask(
    eventBus: ExecutionEventBus,
    taskId: string,
    contextId: string,
    userMessage: Message
  ): void {
    const task: Task = {
      kind: 'task',
      id: taskId,
      contextId,
      status: {
        state: 'working',
        timestamp: new Date().toISOString(),
      },
      history: [userMessage],
    };
    eventBus.publish(task);
  }

  private publishStatus(
    eventBus: ExecutionEventBus,
    taskId: string,
    contextId: string,
    state: TaskStatusUpdateEvent['status']['state'],
    final: boolean
  ): void {
    const event: TaskStatusUpdateEvent = {
      kind: 'status-update',
      taskId,
      contextId,
      status: {
        state,
        timestamp: new Date().toISOString(),
      },
      final,
    };
    eventBus.publish(event);
  }

  private publishArtifact(
    eventBus: ExecutionEventBus,
    taskId: string,
    contextId: string,
    classified: ClassifiedResult
  ): void {
    const artifactName =
      classified.kind === 'success' ? 'result' : classified.kind === 'submitted' ? 'submitted' : 'error';
    const artifact: Artifact = {
      artifactId: randomUUID(),
      name: artifactName,
      parts: [
        {
          kind: 'data',
          data:
            classified.kind === 'submitted'
              ? { ...classified.data, adcp_task_id: classified.adcpTaskId }
              : classified.data,
        },
      ],
    };
    const event: TaskArtifactUpdateEvent = {
      kind: 'artifact-update',
      taskId,
      contextId,
      artifact,
      append: false,
      lastChunk: true,
    };
    eventBus.publish(event);
  }

  private emitFailure(
    eventBus: ExecutionEventBus,
    taskId: string,
    contextId: string,
    payload: { reason: string; message: string }
  ): void {
    const artifact: Artifact = {
      artifactId: randomUUID(),
      name: 'error',
      parts: [{ kind: 'data', data: payload }],
    };
    eventBus.publish({
      kind: 'artifact-update',
      taskId,
      contextId,
      artifact,
      append: false,
      lastChunk: true,
    } satisfies TaskArtifactUpdateEvent);
    this.publishStatus(eventBus, taskId, contextId, 'failed', true);
  }
}

// ---------------------------------------------------------------------------
// Agent card
// ---------------------------------------------------------------------------

const DEFAULT_MODES = ['application/json'] as const;
const DEFAULT_PROTOCOL_VERSION = '0.3.0';

/**
 * Derive one `AgentSkill` per registered AdCP tool. Skills without
 * seller-supplied descriptions get a generic one pointing at the
 * AdCP tool name — enough to pass A2A registry validation; sellers
 * are expected to enrich via `agentCard.skills` in production.
 */
function deriveSkills(toolNames: string[]): AgentSkill[] {
  return toolNames.map(name => ({
    id: name,
    name,
    description: `AdCP tool: ${name}. Send { skill: "${name}", input: { ... } } as a DataPart.`,
    tags: ['adcp'],
  }));
}

function listRegisteredTools(server: AdcpServer): string[] {
  const sdk = getSdkServer(server);
  if (!sdk) return [];
  return listRegisteredToolNames(sdk).filter(name => name !== 'get_adcp_capabilities');
}

function buildAgentCard(server: AdcpServer, overrides: A2AAgentCardOverrides): AgentCard {
  const tools = listRegisteredTools(server);
  const skills = overrides.skills ?? deriveSkills(tools);

  const card: AgentCard = {
    name: overrides.name,
    description: overrides.description,
    url: overrides.url,
    version: overrides.version,
    protocolVersion: overrides.protocolVersion ?? DEFAULT_PROTOCOL_VERSION,
    defaultInputModes: overrides.defaultInputModes ?? [...DEFAULT_MODES],
    defaultOutputModes: overrides.defaultOutputModes ?? [...DEFAULT_MODES],
    capabilities: overrides.capabilities ?? {
      streaming: false,
      pushNotifications: false,
    },
    skills,
    ...(overrides.provider && { provider: overrides.provider }),
    ...(overrides.documentationUrl && { documentationUrl: overrides.documentationUrl }),
    ...(overrides.iconUrl && { iconUrl: overrides.iconUrl }),
    ...(overrides.securitySchemes && { securitySchemes: overrides.securitySchemes }),
    ...(overrides.security && { security: overrides.security }),
    ...(overrides.preferredTransport && { preferredTransport: overrides.preferredTransport }),
  };

  validateAgentCard(card);
  return card;
}

/**
 * Fail loud at adapter construction when the merged card misses
 * A2A-required fields. The SDK would reject the discovery response
 * at runtime anyway — better to catch it at boot so the agent never
 * binds a port with an unserviceable card.
 */
function validateAgentCard(card: AgentCard): void {
  const missing: string[] = [];
  if (!card.name) missing.push('name');
  if (!card.description) missing.push('description');
  if (!card.url) missing.push('url');
  if (!card.version) missing.push('version');
  if (!card.protocolVersion) missing.push('protocolVersion');
  if (!card.capabilities) missing.push('capabilities');
  if (!Array.isArray(card.defaultInputModes) || card.defaultInputModes.length === 0) {
    missing.push('defaultInputModes');
  }
  if (!Array.isArray(card.defaultOutputModes) || card.defaultOutputModes.length === 0) {
    missing.push('defaultOutputModes');
  }
  if (!Array.isArray(card.skills)) missing.push('skills');
  if (missing.length > 0) {
    throw new Error(
      `createA2AAdapter: agent card is missing required fields — ${missing.join(', ')}. ` +
        `Supply them via options.agentCard so A2A discovery doesn't fail at runtime.`
    );
  }
  if (Array.isArray(card.skills) && card.skills.length === 0) {
    throw new Error(
      'createA2AAdapter: agent card has no skills — register AdCP handlers on the server (or supply options.agentCard.skills) before creating the adapter.'
    );
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

const DEFAULT_LOGGER: AdcpLogger = {
  debug: (m, d) => console.debug(m, d ?? ''),
  info: (m, d) => console.info(m, d ?? ''),
  warn: (m, d) => console.warn(m, d ?? ''),
  error: (m, d) => console.error(m, d ?? ''),
};

/**
 * Create an A2A transport adapter around an `AdcpServer`.
 *
 * @example
 * ```ts
 * const adcp = createAdcpServer({ mediaBuy: { getProducts: async () => ({ products: [] }) } });
 * const a2a = createA2AAdapter({
 *   server: adcp,
 *   agentCard: {
 *     name: 'Acme SSP',
 *     description: 'Guaranteed + non-guaranteed display inventory',
 *     url: 'https://ssp.acme.com/a2a',
 *     version: '1.0.0',
 *     provider: { organization: 'Acme', url: 'https://acme.com' },
 *     securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
 *   },
 *   async authenticate(req) {
 *     const token = extractBearer(req);
 *     return token ? { token, clientId: 'buyer_123', scopes: [] } : null;
 *   },
 * });
 *
 * app.use('/a2a', a2a.jsonRpcHandler);
 * app.get('/.well-known/agent-card.json', a2a.agentCardHandler);
 * ```
 *
 * @preview — see the module docstring.
 */
export function createA2AAdapter(options: A2AAdapterOptions): A2AAdapter {
  const logger = options.logger ?? DEFAULT_LOGGER;
  const card = buildAgentCard(options.server, options.agentCard);
  const taskStore = options.taskStore ?? new SdkInMemoryTaskStore();
  const executor = new AdcpA2AAgentExecutor(options.server, logger);
  const eventBusManager = new DefaultExecutionEventBusManager();
  const requestHandler = new DefaultRequestHandler(card, taskStore, executor, eventBusManager);

  const userBuilder = async (req: Request): Promise<User> => {
    if (!options.authenticate) return buildAnonymousUser();
    const authInfo = await options.authenticate(req);
    if (authInfo == null) {
      // Throwing an A2AError with an authentication code would give the
      // SDK's JSON-RPC envelope the right shape, but the SDK keeps
      // `A2AError` internal — surfacing as a thrown Error yields a
      // generic -32000 server error, which is still closer to the
      // right signal than silently continuing anonymously. Most
      // deployments should reject before the UserBuilder via upstream
      // middleware (e.g. `express-jwt`); auth via the UserBuilder is
      // the fallback path.
      throw new Error('A2A authentication failed');
    }
    return buildAuthenticatedUser(authInfo);
  };

  const jsonRpc = jsonRpcHandler({ requestHandler, userBuilder });
  const agentCard = agentCardHandler({ agentCardProvider: requestHandler });

  return {
    jsonRpcHandler: jsonRpc,
    agentCardHandler: agentCard,
    async getAgentCard() {
      return card;
    },
  };
}
