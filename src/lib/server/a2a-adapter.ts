/**
 * A2A transport adapter for `AdcpServer`.
 *
 * Peer of `serve()` / `createExpressAdapter()`: same `AdcpServer` handle,
 * different wire transport. MCP and A2A share the dispatcher, idempotency
 * store, state store, resolveAccount, and governance — everything the
 * framework pipeline owns is transport-agnostic.
 *
 * **Scope**: A2A 1.0 `SendMessage`, `GetTask`, `CancelTask`, and
 * `GET /.well-known/agent-card.json`. Streaming,
 * push notifications, and mid-flight `input-required` interrupts are
 * explicit "not yet" — see `docs/guides/BUILD-AN-AGENT.md`.
 *
 * **Handler-return → A2A `Task.state` mapping:**
 *
 * | Handler returned…                   | A2A `Task.state`  | Artifact payload                                 |
 * |-------------------------------------|-------------------|--------------------------------------------------|
 * | Success arm                         | `completed`       | DataPart with the typed AdCP response            |
 * | Submitted arm (`status:'submitted'`)| `completed` [^1]  | DataPart with AdCP response + `metadata.adcp_task_id` |
 * | Error arm (`errors:[]`)             | `completed`       | DataPart with the AdCP Error arm payload         |
 * | `adcpError()` envelope              | `failed`          | DataPart with `adcp_error`                       |
 *
 * [^1]: A2A `submitted` is the INITIAL lifecycle state (before
 * `working`); A2A `completed` marks the transport call as done.
 * When the AdCP handler returns a Submitted arm the HTTP call itself
 * has completed — the AdCP-level async work is queued and buyers
 * resume it via `task_id` in the typed DataPart response. The DataPart's
 * `data` still carries `status: 'submitted'` from the AdCP response,
 * so a buyer reading the artifact payload sees the ad-tech state
 * directly; the A2A Task.state only mirrors whether the transport
 * call itself terminated.
 *
 * **Message shape.** A client addresses a tool by sending a `Message`
 * with a single structured `DataPart`: `{ skill, input }`.
 * `skill` must match a registered AdCP tool name (e.g. `get_products`);
 * `input` becomes the tool arguments before AdCP schema validation
 * runs. The 0.3 compatibility path accepts the older `{ skill, parameters }`
 * convention, but A2A 1.0 callers must use the AdCP profile's `input` field.
 *
 * **Two lifecycles, one response.** A2A's `Task.state` tracks the
 * TRANSPORT call (did the HTTP request complete?). AdCP's `status`
 * inside the artifact tracks the WORK (submitted / completed /
 * failed). Don't conflate them: a `completed` A2A task can carry a
 * `submitted` AdCP response, meaning the call returned successfully
 * but the ad-tech operation itself is still queued. Buyers resume the
 * AdCP work via the `task_id` in the structured response, not
 * by re-polling the A2A Task.
 *
 * The advertised Agent Card requires the normative AdCP profile extension
 * `https://adcontextprotocol.org/extensions/adcp/v3`.
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
  AgentEvent,
} from '@a2a-js/sdk/server';
import { jsonRpcHandler, agentCardHandler } from '@a2a-js/sdk/server/express';
import { AgentCard, Role, TaskState } from '@a2a-js/sdk';
import { duplicateInterfacesForLegacy } from '@a2a-js/sdk/compat/v0_3';
import type {
  AgentCapabilities,
  AgentProvider,
  AgentSkill,
  Artifact,
  Message,
  Part,
  SecurityScheme,
  Task,
  TaskArtifactUpdateEvent,
  TaskStatusUpdateEvent,
} from '@a2a-js/sdk';
import type { Request, RequestHandler } from 'express';
import { randomUUID } from 'node:crypto';
import { redactSecrets } from '../utils/redact-secrets';
import {
  getSdkServer,
  isToolAvailableForVersion,
  listRegisteredToolNames,
  type AdcpAuthInfo,
  type AdcpServer,
} from './adcp-server';
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
  securitySchemes?: Record<string, SecurityScheme | LegacySecurityScheme>;
  security?: { [k: string]: string[] }[];
  /** @deprecated The adapter exposes JSON-RPC only; this value must be `JSONRPC` when supplied. */
  preferredTransport?: string;

  /**
   * Override the auto-generated capabilities. The adapter sets
   * `streaming: false` and `pushNotifications: false` by default (this adapter
   * ships neither). Set `streaming: true` if you wire a downstream
   * extension; the adapter still does not emit streaming updates.
   */
  capabilities?: A2AAgentCapabilitiesOverride;

  /**
   * Override the auto-generated skills list. When omitted the adapter
   * derives one `AgentSkill` per registered AdCP tool from the server's
   * capability object. Supply this to add descriptions, examples, tags,
   * or per-skill input/output modes the SDK can't infer. Framework-private
   * tools such as `comply_test_controller` are still filtered from the public
   * A2A agent card.
   */
  skills?: A2AAgentSkillOverride[];

  defaultInputModes?: string[];
  defaultOutputModes?: string[];
  /** @deprecated AdCP 3.2 always advertises A2A 1.0 plus the SDK's 0.3 compatibility interface. */
  protocolVersion?: string;
}

export interface LegacyHttpSecurityScheme {
  type: 'http';
  scheme: string;
  description?: string;
  bearerFormat?: string;
}

export type LegacySecurityScheme =
  | LegacyHttpSecurityScheme
  | { type: 'apiKey'; description?: string; in: 'cookie' | 'header' | 'query'; name: string }
  | {
      type: 'oauth2';
      description?: string;
      oauth2MetadataUrl?: string;
      flows: Partial<
        Record<
          'authorizationCode' | 'clientCredentials' | 'implicit' | 'password',
          | {
              authorizationUrl?: string;
              tokenUrl?: string;
              refreshUrl?: string;
              scopes: Record<string, string>;
            }
          | undefined
        >
      >;
    }
  | { type: 'openIdConnect'; description?: string; openIdConnectUrl: string }
  | { type: 'mutualTLS'; description?: string };

export type A2AAgentSkillOverride = Omit<
  AgentSkill,
  'examples' | 'inputModes' | 'outputModes' | 'securityRequirements'
> &
  Partial<Pick<AgentSkill, 'examples' | 'inputModes' | 'outputModes' | 'securityRequirements'>>;

export type A2AAgentCapabilitiesOverride = Omit<AgentCapabilities, 'extensions'> & {
  extensions?: AgentCapabilities['extensions'];
};

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
 * **Agent-card `securitySchemes`.** Legacy 0.3 OpenAPI-style schemes are
 * converted to the A2A 1.0 union and unsupported shapes fail at startup.
 * Only put non-secret discovery data there (token endpoint, scopes, OIDC
 * issuer URL). Never paste client secrets, private JWKS, or internal URLs
 * into the card.
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
   * A2A task store. Tests and development default to the SDK's in-memory
   * store. Production must supply a bounded, durable implementation.
   */
  taskStore?: TaskStore;

  /** Optional logger. Falls back to `console`. */
  logger?: AdcpLogger;
}

/** Minimal Express app surface the adapter's `mount()` helper needs. */
export interface ExpressAppLike {
  use(path: string, ...handlers: RequestHandler[]): unknown;
}

/** Options for {@link A2AAdapter.mount}. */
export interface A2AMountOptions {
  /**
   * URL-path prefix for the JSON-RPC endpoint. Defaults to the pathname
   * of the agent card's `url` field (so `url: 'https://host/a2a'` mounts
   * JSON-RPC at `/a2a`). Override to mount under a different path.
   */
  basePath?: string;
  /**
   * When true (default), also mounts the agent card at the origin root
   * (`/.well-known/agent-card.json`) so simple discovery probes targeting
   * the host itself find the card. Some deployments disable this when an
   * upstream proxy owns origin-root routes — set `false` to mount only
   * at `{basePath}/.well-known/agent-card.json`.
   */
  wellKnownAtRoot?: boolean;
}

/**
 * Value returned by {@link createA2AAdapter}.
 *
 * For almost every seller, `adapter.mount(app)` is the right entry
 * point — it wires all four routes (JSON-RPC at the agent-card's
 * path, the agent card at both `{basePath}/.well-known/agent-card.json`
 * for A2A discovery and `/.well-known/agent-card.json` for origin-root
 * probes) with one call.
 *
 * The `jsonRpcHandler` and `agentCardHandler` fields stay exposed for
 * deployments that need finer control (mounting behind a custom auth
 * layer, serving the card from a CDN, testing).
 */
export interface A2AAdapter {
  /** The A2A JSON-RPC middleware (`message/send`, `tasks/get`, `tasks/cancel`). */
  jsonRpcHandler: RequestHandler;
  /** The agent-card discovery GET middleware. */
  agentCardHandler: RequestHandler;
  /** Returns the merged, validated agent card. */
  getAgentCard(): Promise<AgentCard>;
  /**
   * Wire all A2A routes onto an Express-compatible app in one call.
   * Eliminates the "card mounted at only one location" footgun: the
   * A2A SDK derives `${agentCard.url}/.well-known/agent-card.json` for
   * discovery, while many clients also probe origin root — this helper
   * satisfies both. See {@link A2AMountOptions} to override paths.
   */
  mount(app: ExpressAppLike, options?: A2AMountOptions): void;
}

class RedactingA2ATaskStore implements TaskStore {
  constructor(private readonly delegate: TaskStore) {}

  save(task: Task, context: Parameters<TaskStore['save']>[1]): Promise<void> {
    return this.delegate.save(redactSecrets(task) as Task, context);
  }

  load(taskId: string, context: Parameters<TaskStore['load']>[1]): Promise<Task | undefined> {
    return this.delegate.load(taskId, context);
  }

  list(
    params: Parameters<TaskStore['list']>[0],
    context: Parameters<TaskStore['list']>[1]
  ): ReturnType<TaskStore['list']> {
    return this.delegate.list(params, context);
  }
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

function extractInvocation(message: Message, allowLegacyParameters = false): ExtractedInvocation {
  if (!Array.isArray(message.parts) || message.parts.length === 0) {
    throw new A2AInvocationError('Message must carry at least one part with a `data` kind.');
  }
  const dataParts = message.parts.filter(
    (part): part is Part & { content: { $case: 'data'; value: unknown } } => part.content?.$case === 'data'
  );
  if (dataParts.length === 0) {
    throw new A2AInvocationError(
      "Message must include a DataPart with { skill, input } — text-only messages aren't routable to AdCP tools."
    );
  }
  if (dataParts.length > 1) {
    throw new A2AInvocationError(
      'Message must include exactly one DataPart — multi-part invocations are not supported.'
    );
  }
  const firstDataPart = dataParts[0]!;
  const rawData = firstDataPart.content.value;
  // Guard before destructuring — a client sending `{ kind: 'data', data: null }`
  // or `data: "string"` would otherwise TypeError on payload.skill and surface
  // as a generic HANDLER_THREW instead of INVALID_INVOCATION.
  if (rawData == null || typeof rawData !== 'object' || Array.isArray(rawData)) {
    throw new A2AInvocationError('DataPart `data` must be an object containing { skill, input }.');
  }
  const payload = rawData as Record<string, unknown>;
  const skill = payload.skill;
  const input = payload.input ?? (allowLegacyParameters ? payload.parameters : undefined);
  if (typeof skill !== 'string' || skill.length === 0) {
    throw new A2AInvocationError('DataPart must include a non-empty string `skill` field naming the AdCP tool.');
  }
  if (input != null && (typeof input !== 'object' || Array.isArray(input))) {
    throw new A2AInvocationError('DataPart `input` must be an object.');
  }
  if (input == null) {
    throw new A2AInvocationError('DataPart must include an `input` object.');
  }
  return { skill, input: input as Record<string, unknown> };
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
  | { kind: 'paused'; status: 'input-required' | 'auth-required'; data: Record<string, unknown> }
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
  if (structured.status === 'input-required' || structured.status === 'auth-required') {
    return { kind: 'paused', status: structured.status, data: structured };
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
    const requestedExtensions = requestContext.context.requestedExtensions;
    const requestedAdcpExtension =
      Array.isArray(requestedExtensions) && requestedExtensions.some(extension => extension === ADCP_A2A_EXTENSION);
    const legacyWire = requestContext.context.requestedVersion.startsWith('0.');

    this.taskContextIds.set(taskId, contextId);
    try {
      // Register the task with the ResultManager by publishing a Task
      // event first — subsequent status-update / artifact-update events
      // only resolve if the manager has seen the task. `working` is the
      // initial state; we replace it with completed / submitted / failed
      // once the handler returns.
      this.publishInitialTask(eventBus, taskId, contextId, userMessage);

      if (!legacyWire) {
        if (!requestedAdcpExtension) {
          this.emitFailure(eventBus, taskId, contextId, {
            reason: 'REQUIRED_EXTENSION_MISSING',
            message: `A2A requests must activate ${ADCP_A2A_EXTENSION}`,
          });
          return;
        }
        requestContext.context.addActivatedExtension(ADCP_A2A_EXTENSION);
      }

      let invocation: ExtractedInvocation;
      try {
        invocation = extractInvocation(userMessage, legacyWire);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Invalid A2A invocation';
        this.emitFailure(eventBus, taskId, contextId, {
          reason: 'INVALID_INVOCATION',
          message,
        });
        return;
      }

      let response: McpToolResponse | undefined;
      const toolNames = a2aSkillToServerToolNames(invocation.skill);
      let invokedToolName: string | undefined;
      try {
        for (const toolName of toolNames) {
          try {
            invokedToolName = toolName;
            response = await this.server.invoke({
              // Platform servers register `tasks_get`; older/custom A2A
              // fixtures may still register the slash name directly.
              toolName,
              args: invocation.input,
              ...(authInfo && { authInfo }),
            });
            break;
          } catch (err) {
            if (toolName === 'tasks_get' && invocation.skill === 'tasks/get' && isToolNotRegistered(err, toolName)) {
              continue;
            }
            throw err;
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error('A2A adapter: handler invocation threw', {
          toolName: invokedToolName ?? invocation.skill,
          requestedToolName: invocation.skill,
          error: message,
        });
        this.emitFailure(eventBus, taskId, contextId, {
          reason: 'HANDLER_THREW',
          message: 'The A2A tool invocation failed.',
        });
        return;
      }
      if (response === undefined) {
        this.emitFailure(eventBus, taskId, contextId, {
          reason: 'HANDLER_THREW',
          message: `No handler registered for ${invocation.skill}`,
        });
        return;
      }

      if (this.canceled.has(taskId)) {
        this.publishStatus(eventBus, taskId, contextId, TaskState.TASK_STATE_CANCELED);
        return;
      }

      const classified = classifyResponse(response);
      this.publishArtifact(eventBus, taskId, contextId, classified, legacyWire);
      // A2A Task.state maps the TRANSPORT call lifecycle, not the AdCP
      // work. A `submitted` AdCP arm means the HTTP call itself
      // completed — the ad-tech work is queued, resumed via
      // `task_id` in the typed DataPart response. Emitting A2A
      // `TASK_STATE_SUBMITTED` as the final transport state would be a
      // non-conformant transition (`submitted` is the initial state before
      // `working`, never terminal). Buyers read
      // the AdCP-level status from the artifact's `data.status` field.
      // This server adapter does not expose a continuation dispatcher.
      // A handler-returned pause is therefore terminal at the A2A transport
      // layer and rides in the artifact as an explicitly nonresumable AdCP
      // result. Leaving the Task live would invite `{input}` to re-enter the
      // ordinary request/idempotency pipeline as an unsafe fresh mutation.
      this.publishStatus(
        eventBus,
        taskId,
        contextId,
        classified.kind === 'success' ||
          classified.kind === 'submitted' ||
          classified.kind === 'paused' ||
          (!legacyWire && classified.kind === 'error_arm')
          ? TaskState.TASK_STATE_COMPLETED
          : TaskState.TASK_STATE_FAILED
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
    this.publishStatus(eventBus, taskId, contextId, TaskState.TASK_STATE_CANCELED);
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
      id: taskId,
      contextId,
      status: {
        state: TaskState.TASK_STATE_WORKING,
        message: undefined,
        timestamp: new Date().toISOString(),
      },
      artifacts: [],
      history: [userMessage],
      metadata: undefined,
    };
    eventBus.publish(AgentEvent.task(task));
  }

  private publishStatus(
    eventBus: ExecutionEventBus,
    taskId: string,
    contextId: string,
    state: TaskState,
    messageData?: Record<string, unknown>
  ): void {
    const event: TaskStatusUpdateEvent = {
      taskId,
      contextId,
      status: {
        state,
        timestamp: new Date().toISOString(),
        message: messageData
          ? {
              messageId: randomUUID(),
              contextId,
              taskId,
              role: Role.ROLE_AGENT,
              parts: [dataPart(messageData)],
              metadata: undefined,
              extensions: [],
              referenceTaskIds: [],
            }
          : undefined,
      },
      metadata: undefined,
    };
    eventBus.publish(AgentEvent.statusUpdate(event));
  }

  private publishArtifact(
    eventBus: ExecutionEventBus,
    taskId: string,
    contextId: string,
    classified: ClassifiedResult,
    legacyWire: boolean
  ): void {
    const artifactName =
      classified.kind === 'success'
        ? 'result'
        : classified.kind === 'submitted'
          ? 'submitted'
          : classified.kind === 'paused'
            ? 'result'
            : 'error';
    // DataPart `data` is the AdCP tool's typed response — no
    // transport-level fields injected here so the payload still
    // validates against the tool's AdCP response schema. AdCP
    // On A2A 1.0, work identity stays in the typed response. Metadata is
    // populated only for the SDK's 0.3 compatibility wire.
    const artifact: Artifact = {
      artifactId: randomUUID(),
      name: artifactName,
      description: '',
      parts: [dataPart(classified.data)],
      metadata: legacyWire
        ? {
            adcp_status:
              classified.kind === 'submitted'
                ? 'submitted'
                : classified.kind === 'paused'
                  ? classified.status
                  : classified.kind === 'success'
                    ? 'completed'
                    : 'failed',
            ...(classified.kind === 'submitted' && { adcp_task_id: classified.adcpTaskId }),
          }
        : undefined,
      extensions: [],
    };
    const event: TaskArtifactUpdateEvent = {
      taskId,
      contextId,
      artifact,
      append: false,
      lastChunk: true,
      metadata: undefined,
    };
    eventBus.publish(AgentEvent.artifactUpdate(event));
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
      description: '',
      parts: [dataPart(payload)],
      metadata: undefined,
      extensions: [],
    };
    eventBus.publish(
      AgentEvent.artifactUpdate({
        taskId,
        contextId,
        artifact,
        append: false,
        lastChunk: true,
        metadata: undefined,
      })
    );
    this.publishStatus(eventBus, taskId, contextId, TaskState.TASK_STATE_FAILED);
  }
}

function dataPart(value: unknown): Part {
  return {
    content: { $case: 'data', value },
    metadata: undefined,
    filename: '',
    mediaType: 'application/json',
  };
}

function isToolNotRegistered(err: unknown, toolName: string): boolean {
  return err instanceof Error && err.message.includes(`tool "${toolName}" is not registered`);
}

function a2aSkillToServerToolNames(skill: string): string[] {
  return skill === 'tasks/get' ? ['tasks_get', 'tasks/get'] : [skill];
}

// ---------------------------------------------------------------------------
// Agent card
// ---------------------------------------------------------------------------

const DEFAULT_MODES = ['application/json'] as const;
const DEFAULT_PROTOCOL_VERSION = '1.0';
const ADCP_A2A_EXTENSION = 'https://adcontextprotocol.org/extensions/adcp/v3';
const PUBLIC_AGENT_CARD_EXCLUDED_SKILLS = new Set(['comply_test_controller']);

/**
 * Derive one `AgentSkill` per registered AdCP tool. Skills without
 * seller-supplied descriptions get a generic one pointing at the
 * AdCP tool name — enough to pass A2A registry validation; sellers
 * are expected to enrich via `agentCard.skills` in production.
 */
function deriveSkills(toolNames: string[]): AgentSkill[] {
  const publicNames = new Set(toolNames.map(toA2ASkillName));
  return [...publicNames].map(name => ({
    id: name,
    name,
    description: `AdCP tool: ${name}. Send { skill: "${name}", input: { ... } } as a DataPart.`,
    tags: ['adcp'],
    examples: [],
    inputModes: [],
    outputModes: [],
    securityRequirements: [],
  }));
}

function toA2ASkillName(toolName: string): string {
  return toolName === 'tasks_get' ? 'tasks/get' : toolName;
}

function listRegisteredTools(server: AdcpServer): string[] {
  const sdk = getSdkServer(server);
  if (!sdk) return [];
  return listRegisteredToolNames(sdk).filter(name => !PUBLIC_AGENT_CARD_EXCLUDED_SKILLS.has(name));
}

function filterPublicAgentCardSkills(skills: AgentSkill[]): AgentSkill[] {
  return skills.filter(skill => {
    const id = typeof skill.id === 'string' ? skill.id : undefined;
    const name = typeof skill.name === 'string' ? skill.name : undefined;
    return !(
      (id != null && PUBLIC_AGENT_CARD_EXCLUDED_SKILLS.has(id)) ||
      (name != null && PUBLIC_AGENT_CARD_EXCLUDED_SKILLS.has(name))
    );
  });
}

function normalizeAgentCardSkills(skills: A2AAgentSkillOverride[]): AgentSkill[] {
  return skills.map(skill => ({
    ...skill,
    examples: skill.examples ?? [],
    inputModes: skill.inputModes ?? [],
    outputModes: skill.outputModes ?? [],
    securityRequirements: skill.securityRequirements ?? [],
  }));
}

function buildAgentCard(server: AdcpServer, overrides: A2AAgentCardOverrides): AgentCard {
  if (overrides.preferredTransport && overrides.preferredTransport.toUpperCase() !== 'JSONRPC') {
    throw new Error('createA2AAdapter: only the JSONRPC A2A transport is supported');
  }
  const registeredTools = listRegisteredTools(server);
  const tools = registeredTools.filter(toolName =>
    isToolAvailableForVersion(server, toolName, server.getAdcpVersion())
  );
  const availableTools = new Set(tools);
  const registeredToolSet = new Set(registeredTools);
  const skills = filterPublicAgentCardSkills(
    (overrides.skills ? normalizeAgentCardSkills(overrides.skills) : deriveSkills(tools)).filter(skill => {
      const normalizedId = typeof skill.id === 'string' ? a2aSkillToServerToolNames(skill.id)[0] : undefined;
      const normalizedName = typeof skill.name === 'string' ? a2aSkillToServerToolNames(skill.name)[0] : undefined;
      const registeredName =
        normalizedId !== undefined && registeredToolSet.has(normalizedId)
          ? normalizedId
          : normalizedName !== undefined && registeredToolSet.has(normalizedName)
            ? normalizedName
            : undefined;
      return registeredName === undefined || availableTools.has(registeredName);
    })
  );
  // Capability discovery is an invocable AdCP skill and is required for safe
  // version/lifecycle selection. Keep it visible even when sellers override
  // their business-skill descriptions. Unlike native A2A JSON-RPC methods,
  // every published skill here is callable through message/send.
  if (
    tools.includes('get_adcp_capabilities') &&
    !skills.some(skill => skill.id === 'get_adcp_capabilities' || skill.name === 'get_adcp_capabilities')
  ) {
    skills.push(...deriveSkills(['get_adcp_capabilities']));
  }

  const card: AgentCard = {
    name: overrides.name,
    description: overrides.description,
    supportedInterfaces: duplicateInterfacesForLegacy(
      [
        {
          url: overrides.url,
          protocolBinding: 'JSONRPC',
          protocolVersion: DEFAULT_PROTOCOL_VERSION,
          tenant: '',
        },
      ],
      ['JSONRPC']
    ),
    version: overrides.version,
    defaultInputModes: overrides.defaultInputModes ?? [...DEFAULT_MODES],
    defaultOutputModes: overrides.defaultOutputModes ?? [...DEFAULT_MODES],
    capabilities: {
      streaming: overrides.capabilities?.streaming ?? false,
      pushNotifications: overrides.capabilities?.pushNotifications ?? false,
      extendedAgentCard: overrides.capabilities?.extendedAgentCard,
      extensions: [
        ...(overrides.capabilities?.extensions ?? []).filter(extension => extension.uri !== ADCP_A2A_EXTENSION),
        {
          uri: ADCP_A2A_EXTENSION,
          description: 'AdCP structured task invocation profile',
          required: true,
          params: undefined,
        },
      ],
    },
    skills,
    provider: overrides.provider,
    securitySchemes: normalizeSecuritySchemes(overrides.securitySchemes),
    securityRequirements: (overrides.security ?? []).map(requirement => ({
      schemes: Object.fromEntries(Object.entries(requirement).map(([name, scopes]) => [name, { list: scopes }])),
    })),
    signatures: [],
    ...(overrides.documentationUrl && { documentationUrl: overrides.documentationUrl }),
    ...(overrides.iconUrl && { iconUrl: overrides.iconUrl }),
  };

  // Preserve the adapter's pre-1.0 programmatic read aliases without
  // advertising them on the v1 Agent Card wire shape.
  Object.defineProperties(card, {
    url: { value: overrides.url, enumerable: false },
    protocolVersion: { value: DEFAULT_PROTOCOL_VERSION, enumerable: false },
    // The SDK's Express card middleware currently calls JSON.stringify on the
    // ts-proto in-memory shape. Supply the official JSON projection so v1
    // security-scheme unions serialize as `type`/`scheme`, not `$case`.
    toJSON: { value: () => AgentCard.toJSON(card), enumerable: false },
  });

  validateAgentCard(card);
  return card;
}

function normalizeSecuritySchemes(schemes: A2AAgentCardOverrides['securitySchemes']): Record<string, SecurityScheme> {
  return Object.fromEntries(
    Object.entries(schemes ?? {}).map(([name, value]) => {
      const candidate = value as SecurityScheme & {
        type?: string;
        description?: string;
        scheme?: string | SecurityScheme['scheme'];
        bearerFormat?: string;
      };
      if (candidate.scheme && typeof candidate.scheme === 'object' && '$case' in candidate.scheme) {
        return [name, value as SecurityScheme];
      }
      const legacy = value as LegacySecurityScheme;
      switch (legacy.type) {
        case 'apiKey':
          return [
            name,
            {
              scheme: {
                $case: 'apiKeySecurityScheme',
                value: { description: legacy.description ?? '', location: legacy.in, name: legacy.name },
              },
            } satisfies SecurityScheme,
          ];
        case 'http':
          return [
            name,
            {
              scheme: {
                $case: 'httpAuthSecurityScheme',
                value: {
                  description: legacy.description ?? '',
                  scheme: legacy.scheme,
                  bearerFormat: legacy.bearerFormat ?? '',
                },
              },
            } satisfies SecurityScheme,
          ];
        case 'oauth2':
          return [
            name,
            {
              scheme: {
                $case: 'oauth2SecurityScheme',
                value: {
                  description: legacy.description ?? '',
                  oauth2MetadataUrl: legacy.oauth2MetadataUrl ?? '',
                  flows: normalizeLegacyOAuthFlows(legacy.flows),
                },
              },
            } satisfies SecurityScheme,
          ];
        case 'openIdConnect':
          return [
            name,
            {
              scheme: {
                $case: 'openIdConnectSecurityScheme',
                value: {
                  description: legacy.description ?? '',
                  openIdConnectUrl: legacy.openIdConnectUrl,
                },
              },
            } satisfies SecurityScheme,
          ];
        case 'mutualTLS':
          return [
            name,
            {
              scheme: {
                $case: 'mtlsSecurityScheme',
                value: { description: legacy.description ?? '' },
              },
            } satisfies SecurityScheme,
          ];
      }
      throw new Error(`createA2AAdapter: unsupported security scheme shape for "${name}"`);
    })
  );
}

function normalizeLegacyOAuthFlows(flows: Extract<LegacySecurityScheme, { type: 'oauth2' }>['flows']): any {
  const selected = flows.authorizationCode
    ? ['authorizationCode', flows.authorizationCode]
    : flows.clientCredentials
      ? ['clientCredentials', flows.clientCredentials]
      : flows.implicit
        ? ['implicit', flows.implicit]
        : flows.password
          ? ['password', flows.password]
          : undefined;
  if (!selected) return undefined;
  const [kind, flow] = selected as [string, NonNullable<(typeof flows)[keyof typeof flows]>];
  return {
    flow: {
      $case: kind,
      value: {
        authorizationUrl: flow.authorizationUrl ?? '',
        tokenUrl: flow.tokenUrl ?? '',
        refreshUrl: flow.refreshUrl ?? '',
        scopes: flow.scopes,
        ...(kind === 'authorizationCode' && { pkceRequired: false }),
      },
    },
  };
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
  if (!card.supportedInterfaces?.[0]?.url) missing.push('supportedInterfaces[0].url');
  if (!card.version) missing.push('version');
  if (card.supportedInterfaces?.[0]?.protocolVersion !== DEFAULT_PROTOCOL_VERSION) missing.push('protocolVersion=1.0');
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
 * app.use('/.well-known/agent-card.json', a2a.agentCardHandler);
 * ```
 *
 * @preview — see the module docstring.
 */
export function createA2AAdapter(options: A2AAdapterOptions): A2AAdapter {
  const logger = options.logger ?? DEFAULT_LOGGER;
  const card = buildAgentCard(options.server, options.agentCard);
  const handlerCard = structuredClone(card);
  if (handlerCard.capabilities?.extensions) {
    handlerCard.capabilities.extensions = handlerCard.capabilities.extensions.map(extension =>
      extension.uri === ADCP_A2A_EXTENSION ? { ...extension, required: false } : extension
    );
  }
  const development = process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'development';
  if (!options.taskStore && !development) {
    throw new Error(
      'createA2AAdapter: production requires a bounded durable taskStore; ' +
        'the SDK in-memory store is available only under NODE_ENV=test or NODE_ENV=development'
    );
  }
  const taskStore = new RedactingA2ATaskStore(options.taskStore ?? new SdkInMemoryTaskStore());
  const executor = new AdcpA2AAgentExecutor(options.server, logger);
  const eventBusManager = new DefaultExecutionEventBusManager();
  // The SDK enforces required extensions before AgentExecutor receives the
  // negotiated version. Keep its internal card permissive so 0.3 callers can
  // interoperate, then enforce the required AdCP extension for 1.0 in execute().
  const requestHandler = new DefaultRequestHandler(handlerCard, taskStore, executor, eventBusManager);

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

  const legacyCompat = { enabled: true } as const;
  const jsonRpc = jsonRpcHandler({ requestHandler, userBuilder, legacyCompat });
  const nativeAgentCardMiddleware = agentCardHandler({ agentCardProvider: async () => card });
  const legacyAgentCardMiddleware = agentCardHandler({ agentCardProvider: async () => handlerCard, legacyCompat });
  const agentCardMiddleware: RequestHandler = (req, res, next) => {
    const requestedVersion = req.header('A2A-Version');
    return requestedVersion && !requestedVersion.startsWith('0.')
      ? nativeAgentCardMiddleware(req, res, next)
      : legacyAgentCardMiddleware(req, res, next);
  };

  // Derive the default basePath from the agent-card URL's pathname so
  // `mount(app)` "just works" for the common case where the URL the
  // seller advertised and the URL their app serves are aligned.
  // Falls back to `/a2a` when the URL has no path (empty or `/`).
  const defaultBasePath = (() => {
    try {
      const parsed = new URL(card.supportedInterfaces[0]!.url);
      const pathname = parsed.pathname.replace(/\/+$/, '');
      return pathname.length > 0 ? pathname : '/a2a';
    } catch {
      // `agentCard.url` might be a relative path or otherwise unparseable
      // — fall back to the conventional A2A mount point.
      return '/a2a';
    }
  })();

  const mount = (app: ExpressAppLike, mountOptions: A2AMountOptions = {}): void => {
    const basePath = mountOptions.basePath ?? defaultBasePath;
    const wellKnownAtRoot = mountOptions.wellKnownAtRoot ?? true;
    // A2A SDK clients derive `${agentCard.url}/.well-known/agent-card.json`
    // for discovery, so mount there first.
    app.use(`${basePath}/.well-known/agent-card.json`, agentCardMiddleware);
    if (wellKnownAtRoot) {
      // Origin-root is where simple "what agent lives at this host?"
      // probes look. Serving both locations matches what deployments
      // already hand-roll; the helper just bakes it in.
      app.use('/.well-known/agent-card.json', agentCardMiddleware);
    }
    app.use(basePath, jsonRpc);
  };

  return {
    jsonRpcHandler: jsonRpc,
    agentCardHandler: agentCardMiddleware,
    async getAgentCard() {
      return card;
    },
    mount,
  };
}
