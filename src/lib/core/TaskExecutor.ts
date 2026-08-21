// Core task execution engine for ADCP conversation flow
// Implements PR #78 async patterns: working/submitted/input-required/completed

import { createHash, randomUUID } from 'crypto';
import type { AgentConfig } from '../types';
import {
  ProtocolClient,
  normalizeTransportOptions,
  prepareProtocolToolCall,
  type PreparedProtocolToolCall,
} from '../protocols';
import { listMCPTasks } from '../protocols/mcp-tasks';
import { withPreparedProtocolToolCall } from '../protocols/prepared-call-context';
import { getAuthToken } from '../auth';
import { is401Error, adcpErrorToTypedError, ConfigurationError } from '../errors';
import type { ADCPError } from '../errors';
import type { Storage } from '../storage/interfaces';
import {
  validateOutgoingRequest,
  validateIncomingResponse,
  resolveValidationModes,
  type ValidationHookConfig,
  type ValidationMode,
} from '../validation/client-hooks';
import { formatIssues } from '../validation/schema-validator';
import { ADCP_VERSION } from '../version';
import { unwrapProtocolResponse, isAdcpOperationSuccess } from '../utils/response-unwrapper';
import { extractAdcpErrorInfo, extractCorrelationId } from '../utils/error-extraction';
import { generateIdempotencyKey, requestUsesIdempotency, redactIdempotencyKeyInArgs } from '../utils/idempotency';
import { normalizeGetProductsResponse } from '../utils/pricing-adapter';
import { normalizeLegacyMediaBuyStatusForReturn } from '../utils/envelope-status-compat';
import { canonicalize } from '../utils/jcs';
import { getLatestA2ADataPartFromResponse } from '../utils/a2a-artifacts';
import type { AdcpCapabilities } from '../utils/capabilities';
import { cancelA2ATask } from '../protocols/a2a';
import { isAbortOrTimeoutError, throwIfAborted } from '../protocols/abort';
import type {
  Message,
  InputRequest,
  InputHandler,
  ConversationContext,
  TaskOptions,
  TaskResult,
  TaskResultMetadata,
  TaskState,
  TaskStatus,
  TaskInfo,
  DeferredContinuation,
  SubmittedContinuation,
  WebhookUrlTemplate,
} from './ConversationTypes';
import { normalizeHandlerResponse, isDeferResponse, isAbortResponse } from '../handlers/types';
import { ProtocolResponseParser, ADCP_STATUS, type ADCPStatus } from './ProtocolResponseParser';
import type { Activity } from './AsyncHandler';
import { GovernanceMiddleware } from './GovernanceMiddleware';
import type { GovernanceConfig, GovernanceCheckResult } from './GovernanceTypes';
import { targetDeclaresGovernanceEnforcement } from '../governance';
import { attachMatch } from './match';
import { resolveWebhookUrl } from './webhook-url';
import {
  attachTaskDeadlineGovernanceRecovery,
  attachTaskDeadlineIdempotencyKey,
  getTaskOperationId,
  withTaskDeadline,
} from './task-deadline';

// Keep the direct `core/TaskExecutor` export identical to the package-level
// typed timeout error thrown by the deadline wrapper.
export { TaskTimeoutError } from '../errors';

/**
 * Custom errors for task execution
 */
export class MaxClarificationError extends Error {
  constructor(taskId: string, maxAttempts: number) {
    super(`Task ${taskId} exceeded maximum clarification attempts: ${maxAttempts}`);
    this.name = 'MaxClarificationError';
  }
}

export class DeferredTaskError extends Error {
  constructor(public token: string) {
    super(`Task deferred with token: ${token}`);
    this.name = 'DeferredTaskError';
  }
}

export class InputRequiredError extends Error {
  constructor(question: string) {
    super(`Server requires input but no handler provided. Question: ${question}`);
    this.name = 'InputRequiredError';
  }
}

/** Supporting contract for the internal pre-dispatch boundary. */
export type BeforeProtocolDispatchHookResult<T> =
  | {
      action: 'dispatch_committed';
      /** Persist or otherwise settle the seller result inside the executor-owned dispatch lifetime. */
      onResult?: (result: TaskResult<T>) => Promise<TaskResult<T>>;
      /** Fence transport/parser uncertainty inside the executor-owned dispatch lifetime. */
      onError?: (error: unknown) => Promise<never>;
    }
  | { action: 'return'; result: TaskResult<T> };

/** Context supplied to the internal pre-dispatch boundary. */
export interface BeforeProtocolDispatchContext {
  /** True when governance changed the payload rather than approving it unchanged. */
  governanceAdjusted: boolean;
  /** Publish a terminal continuation result after its durable settlement succeeds. */
  publishSettledTaskStatus: (status: TaskStatus, data?: unknown, error?: string) => void;
  /** Register durable settlement for an authoritative terminal push notification. */
  registerExternalTaskSettlement: (handler: ExternalTaskSettlementHandler) => void;
}

export interface ExternalTaskSettlementObservation {
  status: TaskStatus;
  result?: unknown;
  serverTaskId?: string;
  taskType?: string;
}

export type ExternalTaskSettlementHandler = (
  observation: ExternalTaskSettlementObservation
) => Promise<TaskResult<unknown>>;

export interface ExternalTaskStatusResult {
  settled: boolean;
  /** Exact retry of a terminal observation that already completed durable settlement. */
  duplicate?: boolean;
  result?: unknown;
  status?: TaskStatus;
  error?: string;
}

interface SettledExternalTaskObservation {
  key: string;
  status: TaskStatus;
  error?: string;
}

interface ExternalTaskSettlementInFlight {
  observationKey: string;
  settlement: Promise<ExternalTaskStatusResult>;
  waiterCount: number;
}

/** Hook used by higher-level SDK coordinators at the final dispatch boundary. */
export type BeforeProtocolDispatchHook<T> = (
  effectiveParams: any,
  context: BeforeProtocolDispatchContext
) => Promise<BeforeProtocolDispatchHookResult<T>>;

/** Keeps internal dispatch-boundary failures out of the normal TaskResult error projection. */
/** @internal */
export class BeforeProtocolDispatchHookError extends Error {
  constructor(readonly original: unknown) {
    super('An SDK pre-dispatch hook failed.', { cause: original });
    this.name = 'BeforeProtocolDispatchHookError';
  }
}

/** Keeps internal post-dispatch settlement failures out of normal TaskResult error projection. */
/** @internal */
export class AfterProtocolDispatchHookError extends Error {
  constructor(readonly original: unknown) {
    super('An SDK post-dispatch settlement hook failed.', { cause: original });
    this.name = 'AfterProtocolDispatchHookError';
  }
}

const GOVERNED_CREDENTIAL_SCAN_MAX_NODES = 10_000;
const GOVERNED_CREDENTIAL_SCAN_MAX_DEPTH = 64;
const GOVERNED_CALLBACK_FIELDS = new Set(['push_notification_config', 'reporting_webhook', 'artifact_webhook']);

type GovernedCredentialScanResult =
  | { kind: 'credential'; path: string; callbackField: string }
  | { kind: 'limit'; limit: 'nodes' | 'depth' };

function webhookRegistrationFromPreparedCall(
  agent: AgentConfig,
  preparedCall: PreparedProtocolToolCall
): { callbackUrl: string; mode: 'rfc9421' | 'hmac-sha256' } | undefined {
  const candidate =
    agent.protocol === 'a2a'
      ? preparedCall.pushNotificationConfig
      : preparedCall.args.push_notification_config &&
          typeof preparedCall.args.push_notification_config === 'object' &&
          !Array.isArray(preparedCall.args.push_notification_config)
        ? (preparedCall.args.push_notification_config as Record<string, unknown>)
        : undefined;
  if (!candidate) return undefined;
  if (typeof candidate.url !== 'string') {
    throw new ConfigurationError('push_notification_config.url must be a string.', 'push_notification_config.url');
  }

  if (!Object.prototype.hasOwnProperty.call(candidate, 'authentication')) {
    return { callbackUrl: candidate.url, mode: 'rfc9421' };
  }
  const authentication = candidate.authentication;
  if (!authentication || typeof authentication !== 'object' || Array.isArray(authentication)) {
    throw new ConfigurationError(
      'push_notification_config.authentication selects legacy verification and must be a supported object.',
      'push_notification_config.authentication'
    );
  }
  const schemes = (authentication as Record<string, unknown>).schemes;
  const credentials = (authentication as Record<string, unknown>).credentials;
  if (
    !Array.isArray(schemes) ||
    schemes.length !== 1 ||
    schemes[0] !== 'HMAC-SHA256' ||
    typeof credentials !== 'string' ||
    credentials.length === 0
  ) {
    throw new ConfigurationError(
      'This receiver supports legacy HMAC-SHA256 or RFC 9421 push notifications; Bearer and mixed schemes are not supported.',
      'push_notification_config.authentication.schemes'
    );
  }
  return {
    callbackUrl: candidate.url,
    mode: 'hmac-sha256',
  };
}

/**
 * Find callback authentication credentials before an exact downstream payload
 * crosses the governance-agent boundary. AdCP 3.2 requires intent payloads to
 * match the seller arguments byte-for-byte at the JSON-data-model level, so
 * the SDK cannot safely redact a credential and reinsert it after approval:
 * doing so would invalidate the seller's authorized_payload_hash check.
 */
function findGovernedAuthenticationCredential(value: unknown): GovernedCredentialScanResult | undefined {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  const visited = new WeakSet<object>();
  let visitedNodes = 0;

  while (stack.length > 0) {
    const current = stack.pop()!;
    if (!current.value || typeof current.value !== 'object') continue;
    if (current.depth > GOVERNED_CREDENTIAL_SCAN_MAX_DEPTH) return { kind: 'limit', limit: 'depth' };
    if (visited.has(current.value)) continue;
    visited.add(current.value);
    if (++visitedNodes > GOVERNED_CREDENTIAL_SCAN_MAX_NODES) return { kind: 'limit', limit: 'nodes' };

    if (!Array.isArray(current.value)) {
      const record = current.value as Record<string, unknown>;
      for (const callbackField of GOVERNED_CALLBACK_FIELDS) {
        const callback = record[callbackField];
        if (!callback || typeof callback !== 'object' || Array.isArray(callback)) continue;
        const authentication = (callback as Record<string, unknown>).authentication;
        if (
          authentication &&
          typeof authentication === 'object' &&
          !Array.isArray(authentication) &&
          (authentication as Record<string, unknown>).credentials !== undefined
        ) {
          return {
            kind: 'credential',
            path: `${callbackField}.authentication.credentials`,
            callbackField,
          };
        }
      }
    }

    for (const key in current.value) {
      if (!Object.prototype.hasOwnProperty.call(current.value, key)) continue;
      const child = (current.value as Record<string, unknown>)[key];
      if (!child || typeof child !== 'object') continue;
      if (visitedNodes + stack.length >= GOVERNED_CREDENTIAL_SCAN_MAX_NODES) {
        return { kind: 'limit', limit: 'nodes' };
      }
      stack.push({ value: child, depth: current.depth + 1 });
    }
  }
  return undefined;
}

function assertGovernedPayloadHasNoCallbackCredentials(
  taskName: string,
  payload: Record<string, unknown>,
  options: { sdkInjectedPushConfig?: boolean } = {}
): void {
  const scanResult = findGovernedAuthenticationCredential(payload);
  if (!scanResult) return;
  if (scanResult.kind === 'limit') {
    const limitDescription =
      scanResult.limit === 'nodes'
        ? `${GOVERNED_CREDENTIAL_SCAN_MAX_NODES.toLocaleString('en-US')} nested objects`
        : `${GOVERNED_CREDENTIAL_SCAN_MAX_DEPTH} object levels`;
    throw new ConfigurationError(
      `The SDK could not safely inspect the governed ${taskName} payload for callback credentials because it ` +
        `exceeds the ${limitDescription} safety limit. Simplify the payload or move deeply nested extension data ` +
        `out of the governed request before retrying.`,
      'governance.payload'
    );
  }
  const remedy =
    scanResult.callbackField === 'push_notification_config'
      ? options.sdkInjectedPushConfig
        ? 'Retry with task options `{ disableWebhook: true }` and poll for completion, or use A2A task-status notifications.'
        : 'Remove the credential-bearing push notification config and poll for completion, or use A2A task-status notifications.'
      : `Remove the credential-bearing ${scanResult.callbackField} from this governed request and use a ` +
        `non-webhook delivery path.`;
  throw new ConfigurationError(
    `Governed ${taskName} cannot forward ${scanResult.path} to the governance agent. ` +
      `The SDK will not disclose receiver authentication credentials, and redacting modern AdCP 3.2 payloads ` +
      `would invalidate seller authorization. ${remedy}`,
    scanResult.path
  );
}

/**
 * Map an AdCP `tasks/get` response (post-unwrap) to the SDK's internal
 * `TaskInfo` shape. The AdCP 3.0 schema
 * (`schemas/cache/3.0.0/bundled/core/tasks-get-response.json`) is flat
 * snake_case: `{ task_id, task_type, protocol, status, created_at,
 * updated_at, error?, progress?, history?, completed_at?, has_webhook?,
 * context?, ext? }`. The internal `TaskInfo` is camelCase with a
 * superset of legacy fields some pre-3.0 sellers still emit.
 *
 * **Result-data extraction.** AdCP 3.1.0 defines a typed `result`
 * field on `tasks/get` responses (per adcontextprotocol/adcp#3126,
 * which closed adcp#3123). Sellers populate it when the buyer's
 * request set `include_result: true` and the task reached
 * `completed`. The mapper reads it directly into `TaskInfo.result`
 * so `pollTaskCompletion` surfaces it on the resolved
 * `TaskResult.data`. Pre-3.1.0 sellers that emitted `result` via
 * `additionalProperties: true` continue to work — the typed and
 * informal paths share the same field name.
 *
 * **Legacy nested shape.** Some pre-3.0 sellers and existing test
 * mocks emit `{ task: { ...TaskInfo } }` — a non-spec wrapper. We
 * unwrap it before the spec-shape mapping so the SDK stays
 * compatible with both surfaces during the transition.
 */
function mapTasksGetResponseToTaskInfo(payload: unknown): TaskInfo {
  if (payload == null || typeof payload !== 'object') {
    return { taskId: '', status: 'unknown', taskType: 'unknown', createdAt: Date.now(), updatedAt: Date.now() };
  }
  const obj = payload as Record<string, unknown>;
  // Walk the transport-level wrappers in priority order:
  //   1. MCP `structuredContent` — the typed AdCP payload from `tools/call`
  //   2. A2A latest structured DataPart — the AdCP payload
  //      surfaced via the artifact (per #899)
  //   3. Legacy nested `{ task: TaskInfo }` — pre-3.0 sellers and
  //      existing test mocks
  //   4. Flat AdCP-spec shape — what AdCP 3.0 sellers emit directly
  const flat = unwrapTasksGetEnvelope(obj);
  const errorRaw = flat.error;
  const errorMessage =
    typeof errorRaw === 'string'
      ? errorRaw
      : errorRaw != null &&
          typeof errorRaw === 'object' &&
          typeof (errorRaw as { message?: unknown }).message === 'string'
        ? (errorRaw as { message: string }).message
        : undefined;
  const taskInfo: TaskInfo = {
    taskId: stringField(flat.task_id) ?? stringField(flat.taskId) ?? '',
    status: stringField(flat.status) ?? 'unknown',
    taskType: stringField(flat.task_type) ?? stringField(flat.taskType) ?? 'unknown',
    createdAt: parseTimestamp(flat.created_at ?? flat.createdAt),
    updatedAt: parseTimestamp(flat.updated_at ?? flat.updatedAt),
  };
  if (errorMessage !== undefined) taskInfo.error = errorMessage;
  // Top-level `message` field: the AdCP envelope's human-readable
  // status descriptor (advisory string accompanying any status —
  // e.g. "Budget cap exceeded — task not started" on a `rejected`
  // task). `pollTaskCompletion` falls back to this when the
  // `error.message` block is absent on a terminal failure. Distinct
  // from `error.message` (which lives under the structured `error`
  // object).
  const messageField = stringField(flat.message);
  if (messageField !== undefined) taskInfo.message = messageField;
  // Result extraction — see JSDoc. AdCP 3.1.0 defines `result` as
  // the canonical typed field; pre-3.1.0 sellers using
  // `additionalProperties: true` shared the same field name, so the
  // mapping is unchanged across versions.
  if (flat.result !== undefined) {
    taskInfo.result =
      flat.result != null && typeof flat.result === 'object' && !Array.isArray(flat.result)
        ? normalizeLegacyMediaBuyStatusForReturn(flat.result as Record<string, unknown>, {
            toolName: taskInfo.taskType,
          })
        : flat.result;
  }
  return taskInfo;
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Cap on the wrapper-unwrap recursion depth. Real-world responses
 * have at most two layers (MCP `structuredContent` OR A2A JSON-RPC →
 * Task → artifact → DataPart). The cap is a defense against a
 * malformed or hostile seller emitting a deeply-nested wrapper that
 * would otherwise stack-overflow the buyer.
 */
const TASKS_GET_UNWRAP_MAX_DEPTH = 8;

function unwrapTasksGetEnvelope(obj: Record<string, unknown>, depth = 0, allowRawData = true): Record<string, unknown> {
  if (depth >= TASKS_GET_UNWRAP_MAX_DEPTH) return obj;
  // MCP: `tools/call` response carries the typed payload at
  // `structuredContent`.
  const sc = obj.structuredContent;
  if (sc != null && typeof sc === 'object' && !Array.isArray(sc)) {
    return unwrapTasksGetEnvelope(sc as Record<string, unknown>, depth + 1, false);
  }
  // A2A: `message/send` response is a JSON-RPC envelope wrapping a
  // Task; the AdCP payload sits on the latest structured DataPart.
  const result = obj.result;
  if (result != null && typeof result === 'object' && !Array.isArray(result)) {
    const r = result as Record<string, unknown>;
    if (r.kind === 'task') {
      const extracted = getLatestA2ADataPartFromResponse(obj);
      if (extracted) {
        return unwrapTasksGetEnvelope(extracted.data, depth + 1, false);
      }
      // adcp-client#1612: When the A2A Task has no DataPart artifacts (e.g. the
      // seller returns an A2A transport-level state without an AdCP DataPart
      // payload), surface the transport-layer status as a last-resort hint so
      // `mapTasksGetResponseToTaskInfo` can map terminal states to `failed` /
      // `completed` rather than falling through to `'unknown'`. The transport
      // state overlaps with AdCP status strings for all A2A-native values
      // (`completed`, `failed`, `rejected`, `canceled`, `working`, `submitted`).
      // Note: `auth-required` is an AdCP-layer concept; it won't surface via
      // this path (no A2A-native transport state carries that label) — those
      // responses reach the `unknown` exit branch instead. Also include the A2A
      // task handle (`result.id`) so polling error messages carry the real id.
      const transportStatus = (r.status as Record<string, unknown> | undefined)?.state;
      if (typeof transportStatus === 'string') {
        return { status: transportStatus, task_id: typeof r.id === 'string' ? r.id : undefined };
      }
    }
  }
  // Raw/in-process MCP wrappers sometimes carry the AdCP payload under
  // `data` rather than the official CallToolResult `structuredContent`.
  // Unwrap only when it looks like a task envelope and no official payload
  // has already been selected.
  const data = obj.data;
  if (allowRawData && data != null && typeof data === 'object' && !Array.isArray(data)) {
    const d = data as Record<string, unknown>;
    if ('status' in d || 'task_id' in d || 'taskId' in d) {
      return unwrapTasksGetEnvelope(d, depth + 1, true);
    }
  }
  // Legacy nested wrapper from pre-3.0 sellers and existing mocks.
  // TODO(adcp-client#967): remove once mock fixtures in
  // `test/lib/task-executor*.test.js` migrate to the AdCP-spec flat
  // shape. No real seller emits this; verified at PR review time.
  if (obj.task != null && typeof obj.task === 'object' && !Array.isArray(obj.task)) {
    return obj.task as Record<string, unknown>;
  }
  // Flat AdCP-spec shape — return as-is.
  return obj;
}

function parseTimestamp(value: unknown): number {
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return Date.now();
}

/**
 * Return the idempotency_key this task should use: the caller's value if
 * present, otherwise a fresh UUID v4 for mutating tasks, otherwise undefined.
 */
function resolveIdempotencyKey(taskName: string, params: any, serverVersion?: 'v2' | 'v3'): string | undefined {
  const callerSupplied =
    params && typeof params === 'object' && typeof params.idempotency_key === 'string'
      ? params.idempotency_key
      : undefined;
  if (callerSupplied) return callerSupplied;
  // v2.5 mutations use buyer_ref as their stable replay identity. Request
  // adaptation has already derived it from the caller's canonical key. Do
  // not inject a fresh v3-only idempotency_key after adaptation: that makes
  // identical retries differ on the wire and can defeat legacy dedupe.
  if (serverVersion === 'v2') {
    return params && typeof params === 'object' && typeof params.buyer_ref === 'string' ? params.buyer_ref : undefined;
  }
  if (requestUsesIdempotency(taskName, params)) return generateIdempotencyKey();
  return undefined;
}

/**
 * Webhook manager for submitted tasks
 */
interface WebhookManager {
  generateUrl(taskId: string): string;
  registerWebhook(agent: AgentConfig, taskId: string, webhookUrl: string): Promise<void>;
  processWebhook(token: string, body: any): Promise<void>;
}

/**
 * Deferred task storage for client deferrals
 */
interface DeferredTaskState {
  taskId: string;
  contextId: string;
  agent: AgentConfig;
  taskName: string;
  params: any;
  messages: Message[];
  createdAt: number;
}

interface TaskStatusPollResult {
  task: TaskInfo;
  rawResponse: Record<string, unknown>;
}

const COMPACTED_TASK_STATE_LIMIT = 10_000;
const DEFAULT_EXTERNAL_TASK_SETTLEMENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const TERMINAL_TASK_STATUSES = new Set<TaskStatus>([
  'completed',
  'failed',
  'rejected',
  'canceled',
  'governance-denied',
  'aborted',
]);
const MAX_PENDING_EXTERNAL_TASK_OBSERVATIONS = 8;
const MAX_RETAINED_EXTERNAL_TASK_ERROR_CHARS = 1_024;

/**
 * Core task execution engine that handles the conversation loop with agents
 */
export class TaskExecutor {
  private readonly deferredTerminalPublicationTaskIds = new Set<string>();
  private readonly settlementCapacityReservations = new Set<string>();
  private readonly closedExternalTaskSettlementTaskIds = new Set<string>();
  private readonly externalTaskSettlementHandlers = new Map<string, ExternalTaskSettlementHandler>();
  private readonly externalTaskSettlementInFlight = new Map<string, ExternalTaskSettlementInFlight>();
  private readonly settledExternalTaskObservationKeys = new Map<string, SettledExternalTaskObservation>();
  private readonly externalTaskSettlementExpiry = new Map<string, number>();
  private readonly pendingExternalTaskObservations = new Map<
    string,
    Array<{
      observation: ExternalTaskSettlementObservation;
      resolve: (result: ExternalTaskStatusResult) => void;
      reject: (error: unknown) => void;
    }>
  >();
  private responseParser: ProtocolResponseParser;
  private activeTasks = new Map<string, TaskState>();
  private compactedTaskIds = new Map<string, true>();
  private conversationStorage?: Map<string, Message[]>;
  private governanceMiddleware?: GovernanceMiddleware;
  private lastKnownServerVersion?: 'v2' | 'v3';
  private requestValidationMode!: ValidationMode;
  private responseValidationMode!: ValidationMode;

  constructor(
    private config: {
      /** Default timeout for 'working' status (max 120s per PR #78) */
      workingTimeout?: number;
      /** Polling interval for 'working' status in milliseconds (default: 2000ms) */
      pollingInterval?: number;
      /** Default max clarification attempts */
      defaultMaxClarifications?: number;
      /** Enable conversation storage */
      enableConversationStorage?: boolean;
      /** Webhook manager for submitted tasks */
      webhookManager?: WebhookManager;
      /** Storage for deferred task state */
      deferredStorage?: Storage<DeferredTaskState>;
      /** Webhook URL template for protocol-level webhook support */
      webhookUrlTemplate?: WebhookUrlTemplate;
      /** Agent ID for webhook URL generation */
      agentId?: string;
      /** Webhook secret for legacy HMAC authentication. */
      webhookSecret?: string;
      /** Persist sanitized callback mode provenance before dispatch. */
      onWebhookRegistration?: (registration: {
        agent: AgentConfig;
        taskType: string;
        operationId: string;
        callbackUrl: string;
        mode: 'rfc9421' | 'hmac-sha256';
      }) => void | Promise<void>;
      /** Persist fail-closed routing provenance before a durable mutation claim can run. */
      onDurableSettlementRequired?: (operationId: string) => void | Promise<void>;
      /** Retain durable push-settlement fences for at least the callback registration lifetime. */
      externalTaskSettlementRetentionMs?: number;
      /** Fail tasks when response schema validation fails (default: true) */
      strictSchemaValidation?: boolean;
      /** Emit schema validation violations to debug logs and the console (default: true) */
      logSchemaViolations?: boolean;
      /**
       * Schema-driven validation using the bundled AdCP JSON schemas.
       * Controls outgoing request and incoming response checks independently.
       * Defaults: strict in dev/test, warn in prod. Set a mode to `off` to
       * skip the validator entirely on that side (zero overhead).
       */
      validation?: ValidationHookConfig;
      /** Filter out invalid products from get_products responses instead of rejecting the entire response (default: false) */
      filterInvalidProducts?: boolean;
      /** Global activity callback for observability */
      onActivity?: (activity: Activity) => void | Promise<void>;
      /** Transport-level diagnostics callback for outbound HTTP requests. */
      onTransportActivity?: import('../protocols').TransportActivityHandler;
      /** Governance configuration for buyer-side campaign governance */
      governance?: GovernanceConfig;
      /**
       * AdCP version this executor speaks. Selects which schema bundle
       * `validateIncomingResponse` / `validateOutgoingRequest` validate
       * against, and which `adcp_major_version` value goes on the wire.
       * Defaults to the SDK-pinned `ADCP_VERSION` when omitted.
       *
       * Plumbed from `SingleAgentClient.resolvedAdcpVersion` so the
       * client/agent's `getAdcpVersion()` value is the single source of
       * truth for both validation and wire-level major.
       */
      adcpVersion?: string;
      wireAdcpVersion?: string;
      versionEnvelope?: import('../protocols').VersionEnvelopeMode;
      /**
       * Transport-level safeguards applied to every call this executor
       * dispatches. Per-call options can override individual fields.
       */
      transport?: import('../protocols').TransportOptions;
    } = {}
  ) {
    if (
      config.externalTaskSettlementRetentionMs !== undefined &&
      (!Number.isSafeInteger(config.externalTaskSettlementRetentionMs) || config.externalTaskSettlementRetentionMs < 1)
    ) {
      throw new ConfigurationError('externalTaskSettlementRetentionMs must be a positive safe integer.');
    }
    this.responseParser = new ProtocolResponseParser();
    if (config.enableConversationStorage) {
      this.conversationStorage = new Map();
    }
    if (config.governance) {
      this.governanceMiddleware = new GovernanceMiddleware(
        config.governance,
        config.onActivity,
        config.adcpVersion,
        config.versionEnvelope,
        config.onTransportActivity
      );
    }
    const modes = resolveValidationModes(config.validation);
    this.requestValidationMode = modes.requests;
    // Legacy `strictSchemaValidation: false` flips response-side enforcement
    // to warn mode — preserve that behaviour unless `validation.responses`
    // was set explicitly.
    if (config.validation?.responses !== undefined) {
      this.responseValidationMode = config.validation.responses;
    } else if (config.strictSchemaValidation === false) {
      this.responseValidationMode = 'warn';
    } else {
      this.responseValidationMode = modes.responses;
    }
  }

  /**
   * Access the governance middleware for direct outcome reporting (async tasks).
   */
  getGovernanceMiddleware(): GovernanceMiddleware | undefined {
    return this.governanceMiddleware;
  }

  getRequestParams(taskId: string): Record<string, unknown> | undefined {
    const params = this.activeTasks.get(taskId)?.params;
    return params && typeof params === 'object' && !Array.isArray(params)
      ? (params as Record<string, unknown>)
      : undefined;
  }

  /**
   * Reconcile a push-delivered terminal status with the local runner task.
   * Submitted task state is already compacted after dispatch; this schedules
   * the same short final-status retention used by synchronous completions.
   *
   * @internal
   */
  async observeExternalTaskStatus(
    taskId: string,
    status: TaskStatus,
    result?: unknown,
    identity: { serverTaskId?: string; taskType?: string } = {}
  ): Promise<ExternalTaskStatusResult> {
    if (!['completed', 'failed', 'rejected', 'canceled', 'governance-denied', 'aborted'].includes(status)) {
      return { settled: false, result };
    }
    const observation: ExternalTaskSettlementObservation = { status, result, ...identity };
    const observationKey = this.externalTaskObservationKey(observation);
    if (this.closedExternalTaskSettlementTaskIds.has(taskId)) {
      const accepted = this.settledExternalTaskObservationKeys.get(taskId);
      if (accepted?.key === observationKey) {
        return {
          settled: true,
          duplicate: true,
          status: accepted.status,
          ...(accepted.error !== undefined && { error: accepted.error }),
        };
      }
      throw new Error('This task already completed durable settlement; the pushed result was not accepted.');
    }
    if (this.deferredTerminalPublicationTaskIds.has(taskId)) {
      const handler = this.externalTaskSettlementHandlers.get(taskId);
      if (handler) return this.settleExternalTaskStatus(taskId, handler, observation);
      return new Promise((resolve, reject) => {
        const pending = this.pendingExternalTaskObservations.get(taskId) ?? [];
        if (pending.length >= MAX_PENDING_EXTERNAL_TASK_OBSERVATIONS) {
          reject(new Error('Too many terminal push notifications are awaiting durable task settlement.'));
          return;
        }
        pending.push({ observation, resolve, reject });
        this.pendingExternalTaskObservations.set(taskId, pending);
      });
    }
    this.updateTaskStatus(taskId, status, result);
    return { settled: false, result };
  }

  /** Whether this process can safely settle or reject a durable callback for the operation. */
  hasExternalTaskSettlementRoute(taskId: string): boolean {
    return (
      this.deferredTerminalPublicationTaskIds.has(taskId) ||
      this.closedExternalTaskSettlementTaskIds.has(taskId) ||
      this.externalTaskSettlementHandlers.has(taskId)
    );
  }

  /**
   * Run the configured pre-send schema check against the user-facing request
   * shape. Callers invoke this on the unadapted (v3) params before any wire
   * adaptation runs, so the validator sees the same object the caller wrote.
   * Throws in strict, logs to `debugLogs` in warn, no-ops in off.
   */
  validateRequest(taskName: string, params: unknown, debugLogs?: any[]): void {
    validateOutgoingRequest(taskName, params, this.requestValidationMode, debugLogs, this.config.adcpVersion);
  }

  /**
   * After `adaptRequestForServerVersion` has rewritten a v3 request into v2
   * wire format, validate the adapted shape against the cached v2.5 schema
   * bundle. Always warn-only — adapter bugs shouldn't break user requests,
   * and the v3 pre-send pass already vouched for the user-facing input.
   * This pass exists to surface drift between what the adapter emits and
   * what a v2.5 server expects on the wire (primarily as CI signal via the
   * adapter-conformance test suite).
   *
   * Skips silently for tasks without a v2.5 schema or when the v2.5 bundle
   * isn't cached. Caller is responsible for gating on `serverVersion === 'v2'`
   * so v3-targeted traffic doesn't pay the validation cost.
   */
  validateAdaptedRequestAgainstV2(taskName: string, adaptedParams: unknown, debugLogs?: any[]): void {
    validateOutgoingRequest(taskName, adaptedParams, 'warn', debugLogs, 'v2.5');
  }

  /**
   * Generate webhook URL for protocol-level webhook support
   */
  /**
   * Build TaskResultMetadata, including the idempotency fields. The key is
   * pulled from the tracked task state so every result reports the key that
   * was actually sent (auto-generated or caller-supplied); `replayed` is
   * extracted from the response envelope when a response is available.
   */
  private buildMetadata(args: {
    taskId: string;
    taskName: string;
    agent: AgentConfig | { id: string; name: string; protocol: 'mcp' | 'a2a' };
    startTime?: number;
    responseTimeMs?: number;
    status: TaskStatus;
    clarificationRounds?: number;
    response?: any;
    inputRequest?: InputRequest;
  }): TaskResultMetadata {
    const meta: TaskResultMetadata = {
      taskId: args.taskId,
      taskName: args.taskName,
      agent: { id: args.agent.id, name: args.agent.name, protocol: args.agent.protocol },
      responseTimeMs: args.responseTimeMs ?? (args.startTime !== undefined ? Date.now() - args.startTime : 0),
      timestamp: new Date().toISOString(),
      clarificationRounds: args.clarificationRounds ?? 0,
      status: args.status,
    };
    if (args.inputRequest) meta.inputRequest = args.inputRequest;
    const key = this.activeTasks.get(args.taskId)?.idempotencyKey;
    if (key) meta.idempotency_key = key;
    if (args.response !== undefined) {
      const replayed = this.responseParser.getReplayed(args.response);
      if (replayed !== undefined) meta.replayed = replayed;
      const adcpVersion = this.responseParser.getAdcpVersion(args.response);
      if (adcpVersion) meta.adcpVersion = adcpVersion;
      const serverContextId = this.responseParser.getContextId(args.response);
      if (serverContextId) meta.contextId = serverContextId;
      const serverTaskId = this.responseParser.getTaskId(args.response);
      if (serverTaskId) meta.serverTaskId = serverTaskId;
    }
    return meta;
  }

  /**
   * Map a task's structured AdCP error to a typed `ADCPError` subclass when
   * the code has a dedicated class (e.g., `IDEMPOTENCY_CONFLICT` →
   * `IdempotencyConflictError`). The idempotency key is pulled from tracked
   * task state because the server intentionally omits it from error bodies
   * (it's a read-oracle).
   */
  private buildErrorInstance(
    taskId: string,
    adcpError: ReturnType<typeof extractAdcpErrorInfo>
  ): ADCPError | undefined {
    if (!adcpError) return undefined;
    const key = this.activeTasks.get(taskId)?.idempotencyKey;
    return adcpErrorToTypedError(adcpError, key);
  }

  private generateWebhookUrl(taskName: string, operationId: string, options?: TaskOptions): string | undefined {
    return resolveWebhookUrl(this.config.webhookUrlTemplate, this.config.agentId, taskName, operationId, options);
  }

  /**
   * Execute a task with an agent using PR #78 async patterns
   * Handles: working (keep SSE open), submitted (webhook), input-required (handler), completed
   */
  async executeTask<T = any>(
    agent: AgentConfig,
    taskName: string,
    params: any,
    inputHandler?: InputHandler,
    options: TaskOptions = {},
    serverVersion?: 'v2' | 'v3',
    targetCapabilities?: AdcpCapabilities,
    beforeProtocolDispatch?: BeforeProtocolDispatchHook<T>
  ): Promise<TaskResult<T>> {
    return withTaskDeadline(options, effectiveOptions =>
      this.executeTaskWithinDeadline<T>(
        agent,
        taskName,
        params,
        inputHandler,
        effectiveOptions,
        serverVersion,
        targetCapabilities,
        beforeProtocolDispatch
      )
    );
  }

  private async executeTaskWithinDeadline<T = any>(
    agent: AgentConfig,
    taskName: string,
    params: any,
    inputHandler?: InputHandler,
    options: TaskOptions = {},
    serverVersion?: 'v2' | 'v3',
    targetCapabilities?: AdcpCapabilities,
    beforeProtocolDispatch?: BeforeProtocolDispatchHook<T>
  ): Promise<TaskResult<T>> {
    if (serverVersion) this.lastKnownServerVersion = serverVersion;
    // Own the request graph before the first awaited activity/governance
    // boundary. This executor is internal, but direct callers and higher
    // layers may still retain the original nested objects.
    params = structuredClone(params);
    // The client-minted `taskId` is a local correlation id for tracking this
    // call's lifecycle (activeTasks map, metadata, webhook URL macros). It is
    // NOT the same thing as the A2A `taskId` that the server assigns — that
    // flows in on the response and is surfaced via metadata.serverTaskId.
    // `options.contextId` / `options.taskId` ride on the A2A message envelope
    // and are threaded straight to the protocol adapter below.
    const taskId = getTaskOperationId(options) ?? randomUUID();
    const startTime = Date.now();
    const workingTimeout = this.config.workingTimeout || 120000; // 120s max per PR #78

    // Auto-generate idempotency_key for mutating tasks when the caller didn't
    // supply one. The key lives on TaskState so internal retries reuse it —
    // re-generating on retry defeats the whole point of the envelope.
    // `options.skipIdempotencyAutoInject` disables this for compliance testing
    // that needs to exercise server-side missing-key behavior.
    const idempotencyKey = options.skipIdempotencyAutoInject
      ? undefined
      : resolveIdempotencyKey(taskName, params, serverVersion);
    if (idempotencyKey) attachTaskDeadlineIdempotencyKey(options, idempotencyKey);
    if (serverVersion !== 'v2' && idempotencyKey && params && typeof params === 'object' && !params.idempotency_key) {
      params = { ...params, idempotency_key: idempotencyKey };
    }

    // Register task in active tasks
    const taskState: TaskState = {
      taskId,
      taskName,
      params,
      status: 'pending',
      messages: [],
      startTime,
      attempt: 0,
      maxAttempts: options.maxClarifications || this.config.defaultMaxClarifications || 3,
      options,
      agent: { id: agent.id, name: agent.name, protocol: agent.protocol },
      idempotencyKey,
    };
    this.activeTasks.set(taskId, taskState);

    // Once the final compatibility boundary starts, an abort may race a
    // durable claim that has committed but whose hook has not returned yet.
    // In that window the boundary, not the caller signal, owns publication of
    // terminal state. The abort listener still compacts retained request data.
    let dispatchBoundaryOwnsTerminalState = false;

    // Compact task state as soon as cancellation fires, even if a protocol
    // adapter or caller callback never settles after receiving the signal.
    // The outer deadline race guarantees prompt rejection; this listener is
    // the matching resource-retention boundary for activeTasks.
    const taskAbortListener = options.signal
      ? () => {
          const currentStatus = this.activeTasks.get(taskId)?.status;
          if (currentStatus && !TERMINAL_TASK_STATUSES.has(currentStatus)) {
            if (dispatchBoundaryOwnsTerminalState) {
              this.compactAbandonedObserverTaskState(taskId);
              return;
            }
            const reason = options.signal?.reason;
            this.updateTaskStatus(
              taskId,
              'aborted',
              undefined,
              reason instanceof Error ? reason.message : reason == null ? 'The operation was aborted' : String(reason)
            );
          }
        }
      : undefined;
    if (taskAbortListener) options.signal!.addEventListener('abort', taskAbortListener, { once: true });

    // Emit task creation event
    this.emitTaskEvent(
      {
        taskId,
        status: 'submitted',
        taskType: taskName,
        createdAt: startTime,
        updatedAt: startTime,
      },
      agent.id
    );

    // Start streaming connection
    const debugLogs: any[] = [];

    // Generate webhook URL if template is configured
    const webhookUrl = this.generateWebhookUrl(taskName, taskId, options);

    // Governance state (scoped outside try so catch can access)
    let governanceCheckId: string | undefined;
    let governanceResult: GovernanceCheckResult | undefined;
    let effectiveParams = params;
    let governanceAdjusted = false;
    let dispatchCommitted = false;
    let dispatchSettlement:
      | Pick<Extract<BeforeProtocolDispatchHookResult<T>, { action: 'dispatch_committed' }>, 'onResult' | 'onError'>
      | undefined;
    let dispatchSettlementStarted = false;

    try {
      // Emit protocol_request activity. The activity payload is the boundary
      // callers typically pipe into external observability stacks, so redact
      // the idempotency key — it's a retry-pattern oracle within the seller's
      // TTL. Full logging is opt-in via ADCP_LOG_IDEMPOTENCY_KEYS=1.
      await this.config.onActivity?.({
        type: 'protocol_request',
        operation_id: taskId,
        agent_id: agent.id,
        context_id: options.contextId,
        task_id: taskId,
        task_type: taskName,
        status: 'pending',
        payload: { params: redactIdempotencyKeyInArgs(params) },
        timestamp: new Date().toISOString(),
      });
      throwIfAborted(options.signal);

      // Run governance check if configured for this tool
      const governanceMiddleware = this.governanceMiddleware;
      if (governanceMiddleware) {
        const modernGovernance =
          targetCapabilities !== undefined && targetDeclaresGovernanceEnforcement(targetCapabilities, taskName);
        // Modern authorization binds the exact argument object the seller
        // receives, including protocol-owned fields and MCP webhook
        // registration. Legacy governance retains its historical application
        // payload and must not receive SDK-injected callback credentials.
        const governableParams = modernGovernance
          ? prepareProtocolToolCall(agent, params, {
              toolName: taskName,
              webhookUrl,
              webhookSecret: this.config.webhookSecret,
              serverVersion,
              adcpVersion: this.config.adcpVersion,
              wireAdcpVersion: this.config.wireAdcpVersion,
              versionEnvelope: this.config.versionEnvelope,
            }).args
          : params;
        if (await governanceMiddleware.shouldCheck(taskName, governableParams, targetCapabilities)) {
          const sdkInjectedPushConfig =
            modernGovernance &&
            agent.protocol === 'mcp' &&
            webhookUrl !== undefined &&
            this.config.webhookSecret !== undefined;
          assertGovernedPayloadHasNoCallbackCredentials(taskName, governableParams, { sdkInjectedPushConfig });
          const { result: govResult, params: adjustedParams } = await governanceMiddleware.checkProposed(
            agent,
            targetCapabilities!,
            taskName,
            governableParams,
            debugLogs,
            options.signal
          );
          throwIfAborted(options.signal);
          assertGovernedPayloadHasNoCallbackCredentials(taskName, adjustedParams, { sdkInjectedPushConfig });
          governanceAdjusted = canonicalize(adjustedParams) !== canonicalize(governableParams);

          // Governance always blocks on denial/unapplied conditions.
          const isBlocking = true;

          if (govResult.status === 'denied' && isBlocking) {
            const denied = this.buildGovernanceResult<T>(govResult, taskId, taskName, agent, startTime, debugLogs);
            this.updateTaskStatus(taskId, 'governance-denied', undefined, denied.error);
            return attachMatch(denied);
          }

          if (govResult.status === 'conditions' && !govResult.conditionsApplied && isBlocking) {
            const denied = this.buildGovernanceResult<T>(govResult, taskId, taskName, agent, startTime, debugLogs);
            this.updateTaskStatus(taskId, 'governance-denied', undefined, denied.error);
            return attachMatch(denied);
          }

          // Approved, or non-blocking mode (advisory/audit) allows execution to proceed
          governanceCheckId = govResult.checkId;
          governanceResult = govResult;
          if (governanceCheckId) {
            // Preserve the approved check identity as soon as the seller may be
            // dispatched. If the deadline fires during response processing,
            // callers can still reconcile the seller mutation against the
            // original governance decision after restart.
            attachTaskDeadlineGovernanceRecovery(options, { checkId: governanceCheckId });
          }
          effectiveParams = adjustedParams;
        }
      }

      // Detach the final request graph before the durable claim boundary. The
      // caller may still hold and mutate nested account/brand/targeting values;
      // validation, claim verification, the prepared wire call, and dispatch
      // must all observe one immutable-by-ownership snapshot.
      const dispatchParams = structuredClone(effectiveParams);

      // Create initial message (uses dispatchParams which may have governance-applied conditions)
      const initialMessage: Message = {
        id: randomUUID(),
        role: 'user',
        content: { tool: taskName, params: dispatchParams },
        timestamp: new Date().toISOString(),
        metadata: { toolName: taskName, type: 'request' },
      };

      // Materialize once, persist callback provenance, and dispatch this same
      // prepared object. A seller can post immediately after receiving the
      // request, so the registration write must complete before the network
      // boundary is crossed.
      const preparedCall = prepareProtocolToolCall(agent, dispatchParams, {
        toolName: taskName,
        webhookUrl,
        webhookSecret: this.config.webhookSecret,
        serverVersion,
        adcpVersion: this.config.adcpVersion,
        wireAdcpVersion: this.config.wireAdcpVersion,
        versionEnvelope: this.config.versionEnvelope,
      });
      let webhookRegistrationPersisted = false;
      if (webhookUrl && this.config.onWebhookRegistration) {
        const registration = webhookRegistrationFromPreparedCall(agent, preparedCall);
        if (registration) {
          await this.config.onWebhookRegistration({
            agent,
            taskType: taskName,
            operationId: taskId,
            ...registration,
          });
          webhookRegistrationPersisted = true;
        }
      }

      // This is the final awaited preflight boundary. A durable mutation claim
      // made by the hook must be followed immediately by the official protocol
      // call; callers can therefore distinguish deterministic preflight failure
      // from transport uncertainty after the commit point.
      throwIfAborted(options.signal);
      if (beforeProtocolDispatch) {
        let decision: BeforeProtocolDispatchHookResult<T>;
        dispatchBoundaryOwnsTerminalState = true;
        try {
          if (
            this.deferredTerminalPublicationTaskIds.size + this.settlementCapacityReservations.size >=
            COMPACTED_TASK_STATE_LIMIT
          ) {
            throw new Error('The durable task-settlement capacity is exhausted; no mutation claim was attempted.');
          }
          this.settlementCapacityReservations.add(taskId);
          if (webhookRegistrationPersisted) {
            await this.config.onDurableSettlementRequired?.(taskId);
            throwIfAborted(options.signal);
          }
          decision = await beforeProtocolDispatch(dispatchParams, {
            governanceAdjusted,
            publishSettledTaskStatus: (status, data, error) =>
              this.publishSettledTaskStatus(taskId, status, data, error),
            registerExternalTaskSettlement: handler => this.registerExternalTaskSettlement(taskId, handler),
          });
          if (decision.action === 'dispatch_committed') {
            this.deferredTerminalPublicationTaskIds.add(taskId);
            this.retainExternalTaskSettlementState(taskId);
          }
        } catch (error) {
          throw new BeforeProtocolDispatchHookError(error);
        } finally {
          this.settlementCapacityReservations.delete(taskId);
        }
        if (decision.action === 'return') {
          const earlyResult = decision.result;
          if (
            ['completed', 'failed', 'rejected', 'canceled', 'governance-denied', 'aborted'].includes(earlyResult.status)
          ) {
            this.updateTaskStatus(taskId, earlyResult.status as TaskStatus, earlyResult.data, earlyResult.error);
          }
          return attachMatch(earlyResult);
        }
        dispatchCommitted = true;
        dispatchSettlement = decision;
      }

      // A claim that completes after the caller deadline must be fenced, not
      // turned into a hidden seller mutation after the caller has already
      // received a timeout and may have replanned. The catch path invokes the
      // committed hook's onError settlement before any protocol call begins.
      throwIfAborted(options.signal);

      // Once a durable claim commits, the caller-facing signal may already be
      // aborted after seller dispatch begins. Never let that abandoned
      // observer prevent response parsing or durable settlement.
      const postDispatchOptions = dispatchCommitted ? { ...options, signal: undefined } : options;

      // Send initial request and get streaming response with webhook URL.
      // Pass the caller's A2A session ids (contextId for conversation binding,
      // taskId for resuming a non-terminal server-side task). The adapter
      // drops these on the wire for MCP (no session concept there).
      const callOptions = {
        debugLogs,
        webhookUrl,
        webhookSecret: this.config.webhookSecret,
        serverVersion,
        session: { contextId: options.contextId, taskId: options.taskId },
        adcpVersion: this.config.adcpVersion,
        ...(this.config.wireAdcpVersion !== undefined && { wireAdcpVersion: this.config.wireAdcpVersion }),
        ...(this.config.versionEnvelope !== undefined && { versionEnvelope: this.config.versionEnvelope }),
        transport: options.transport ?? this.config.transport,
        // Once dispatch begins for a live committed claim, post-call handling
        // owns durable settlement even if the caller's deadline fires later.
        signal: postDispatchOptions.signal,
        onTransportActivity: this.config.onTransportActivity,
        transportActivityContext: {
          operationId: taskId,
          taskId: options.taskId ?? taskId,
          contextId: options.contextId,
          idempotencyKey,
        },
      };
      const response = await withPreparedProtocolToolCall(
        { agent, toolName: taskName, args: dispatchParams, preparedCall },
        () => ProtocolClient.callTool(agent, taskName, dispatchParams, callOptions)
      );
      throwIfAborted(postDispatchOptions.signal);

      // Emit protocol_response activity
      const respStatus = this.responseParser.getStatus(response) as string | undefined;
      await this.config.onActivity?.({
        type: 'protocol_response',
        operation_id: taskId,
        agent_id: agent.id,
        context_id: options.contextId,
        task_id: taskId,
        task_type: taskName,
        status: respStatus,
        payload: response,
        timestamp: new Date().toISOString(),
      });
      throwIfAborted(postDispatchOptions.signal);

      // Add initial response message
      const responseMessage: Message = {
        id: randomUUID(),
        role: 'agent',
        content: response,
        timestamp: new Date().toISOString(),
        metadata: { toolName: taskName, type: 'response' },
      };

      const messages = [initialMessage, responseMessage];

      // Handle response based on status
      let result = await this.handleAsyncResponse<T>(
        agent,
        taskId,
        taskName,
        dispatchParams,
        response,
        messages,
        inputHandler,
        postDispatchOptions,
        debugLogs,
        startTime,
        dispatchCommitted
      );
      throwIfAborted(postDispatchOptions.signal);

      // Attach governance check result to the task result
      if (governanceResult) {
        result.governance = governanceResult;
      }

      if (dispatchSettlement?.onResult) {
        dispatchSettlementStarted = true;
        try {
          result = await dispatchSettlement.onResult(attachMatch(result));
        } catch (error) {
          // A committed mutation is not terminal from the SDK's perspective
          // until its durable settlement succeeds. Publish only the failed
          // local coordinator state here; never leak the seller's earlier
          // completed response through task events or retained task state.
          this.closeExternalTaskSettlement(taskId, error);
          this.updateTaskStatus(taskId, 'failed', undefined, error instanceof Error ? error.message : String(error));
          throw new AfterProtocolDispatchHookError(error);
        }
      }

      // Report governance only after a committed compatibility mutation has
      // durably settled. A seller terminal response is not authoritative if
      // the coordinator subsequently fails to persist it.
      // For async tasks (submitted/working), outcome reporting is deferred —
      // the caller reports via client.reportGovernanceOutcome() when the
      // task resolves through polling or webhooks.
      if (governanceCheckId && this.governanceMiddleware) {
        const govCtx = governanceResult?.governanceContext;
        if (result.status === 'completed' && govCtx) {
          const outcomeIdempotencyKey = this.governanceMiddleware.getOutcomeIdempotencyKey(
            governanceCheckId,
            'completed'
          );
          attachTaskDeadlineGovernanceRecovery(options, {
            checkId: governanceCheckId,
            outcome: 'completed',
            outcomeIdempotencyKey,
          });
          result.governanceOutcome = await this.governanceMiddleware.reportOutcome(
            governanceCheckId,
            'completed',
            result.data as Record<string, unknown> | undefined,
            undefined,
            debugLogs,
            govCtx,
            postDispatchOptions.signal,
            outcomeIdempotencyKey
          );
          throwIfAborted(postDispatchOptions.signal);
          if (!result.governanceOutcome) {
            result.governanceOutcomeError = 'Outcome reporting to governance agent failed';
          }
        } else if (result.error && govCtx) {
          const outcomeIdempotencyKey = this.governanceMiddleware.getOutcomeIdempotencyKey(governanceCheckId, 'failed');
          attachTaskDeadlineGovernanceRecovery(options, {
            checkId: governanceCheckId,
            outcome: 'failed',
            outcomeIdempotencyKey,
          });
          result.governanceOutcome = await this.governanceMiddleware.reportOutcome(
            governanceCheckId,
            'failed',
            undefined,
            { message: result.error },
            debugLogs,
            govCtx,
            postDispatchOptions.signal,
            outcomeIdempotencyKey
          );
          throwIfAborted(postDispatchOptions.signal);
          if (!result.governanceOutcome) {
            result.governanceOutcomeError = 'Outcome reporting to governance agent failed';
          }
        } else if (result.status === 'submitted' || result.status === 'working') {
          // Attach the check ID so callers can report outcome after async resolution
          result.governance = { ...(result.governance ?? {}), checkId: governanceCheckId } as GovernanceCheckResult;
        }
      }

      if (dispatchCommitted) {
        result = this.attachSettledContinuationTaskStatus(taskId, result);
        if (TERMINAL_TASK_STATUSES.has(result.status as TaskStatus)) {
          this.publishSettledTaskStatus(taskId, result.status as TaskStatus, result.data, result.error);
        }
      }

      if (
        ['completed', 'failed', 'rejected', 'canceled', 'governance-denied', 'aborted'].includes(result.status) &&
        this.activeTasks.get(taskId)?.status !== result.status
      ) {
        this.updateTaskStatus(taskId, result.status as TaskStatus, result.data, result.error);
      }
      return attachMatch(result);
    } catch (error) {
      if (error instanceof BeforeProtocolDispatchHookError) {
        // Hook failures happen before seller dispatch. Preserve the original
        // exception for the compatibility coordinator, but terminalize the
        // local task so repeated invalid redemption attempts cannot retain
        // full request payloads and options in activeTasks.
        this.updateTaskStatus(taskId, 'failed', undefined, error.message);
        throw error;
      }
      if (error instanceof AfterProtocolDispatchHookError) throw error;
      if (dispatchCommitted && dispatchSettlement?.onError && !dispatchSettlementStarted) {
        dispatchSettlementStarted = true;
        try {
          await dispatchSettlement.onError(error);
        } catch (settlementError) {
          this.closeExternalTaskSettlement(taskId, settlementError);
          this.updateTaskStatus(
            taskId,
            'failed',
            undefined,
            settlementError instanceof Error ? settlementError.message : String(settlementError)
          );
          throw new AfterProtocolDispatchHookError(settlementError);
        }
        this.closeExternalTaskSettlement(taskId, error);
      }
      if (isAbortOrTimeoutError(error)) {
        if (idempotencyKey && error && typeof error === 'object') {
          (error as Error & { idempotency_key?: string; idempotencyKey?: string }).idempotency_key = idempotencyKey;
          (error as Error & { idempotency_key?: string; idempotencyKey?: string }).idempotencyKey = idempotencyKey;
        }
        const currentStatus = this.activeTasks.get(taskId)?.status;
        if (currentStatus && !TERMINAL_TASK_STATUSES.has(currentStatus)) {
          this.updateTaskStatus(taskId, 'aborted', undefined, error instanceof Error ? error.message : String(error));
        }
        throw error;
      }

      // Report failed outcome on error
      if (governanceCheckId && this.governanceMiddleware && governanceResult?.governanceContext) {
        const outcomeIdempotencyKey = this.governanceMiddleware.getOutcomeIdempotencyKey(governanceCheckId, 'failed');
        attachTaskDeadlineGovernanceRecovery(options, {
          checkId: governanceCheckId,
          outcome: 'failed',
          outcomeIdempotencyKey,
        });
        await this.governanceMiddleware.reportOutcome(
          governanceCheckId,
          'failed',
          undefined,
          { message: (error as Error).message },
          debugLogs,
          governanceResult.governanceContext,
          options.signal,
          outcomeIdempotencyKey
        );
      }
      const failed = this.createErrorResult<T>(taskId, agent, error, debugLogs, startTime);
      this.updateTaskStatus(taskId, 'failed', undefined, failed.error);
      return attachMatch(failed);
    } finally {
      if (taskAbortListener) options.signal!.removeEventListener('abort', taskAbortListener);
    }
  }

  /**
   * Handle agent response based on ADCP status (PR #78)
   */
  private buildGovernanceResult<T>(
    govResult: GovernanceCheckResult,
    taskId: string,
    taskName: string,
    agent: AgentConfig,
    startTime: number,
    debugLogs: any[]
  ): TaskResult<T> {
    return {
      success: false,
      status: 'governance-denied',
      error: govResult.explanation || 'Governance governance-denied',
      governance: govResult,
      metadata: this.buildMetadata({ taskId, taskName, agent, startTime, status: 'governance-denied' }),
      conversation: [],
      debug_logs: debugLogs,
    };
  }

  private async handleAsyncResponse<T>(
    agent: AgentConfig,
    taskId: string,
    taskName: string,
    params: any,
    response: any,
    messages: Message[],
    inputHandler?: InputHandler,
    options: TaskOptions = {},
    debugLogs: any[] = [],
    startTime: number = Date.now(),
    deferTerminalTaskStatus = false
  ): Promise<TaskResult<T>> {
    const status = this.responseParser.getStatus(response) as ADCPStatus;

    switch (status) {
      case ADCP_STATUS.COMPLETED:
        // Task completed immediately
        const completedData = this.extractResponseData(response, debugLogs, taskName);
        // Ordinary calls retain the historical behavior of publishing seller
        // completion before optional governance postflight work. A committed
        // compatibility mutation defers this until durable settlement.
        if (!deferTerminalTaskStatus) this.updateTaskStatus(taskId, 'completed', completedData);

        const operationSuccess = this.isOperationSuccess(completedData, taskName);

        // Validate response against AdCP schema - validate extracted data, not protocol wrapper
        const validationResult = this.validateResponseSchema(completedData, taskName, debugLogs);

        // In strict mode, schema validation failures cause task to fail
        const finalSuccess = operationSuccess && validationResult.valid;
        const finalError = !finalSuccess
          ? validationResult.errors.length > 0
            ? `Schema validation failed: ${validationResult.errors.join('; ')}`
            : this.extractOperationError(completedData)
          : undefined;

        if (finalSuccess) {
          return {
            success: true as const,
            status: 'completed' as const,
            data: completedData,
            metadata: this.buildMetadata({
              taskId,
              taskName,
              agent,
              startTime,
              status: 'completed',
              response,
            }),
            conversation: messages,
            debug_logs: debugLogs,
          };
        }
        const completedAdcpError = extractAdcpErrorInfo(completedData);
        return {
          success: false as const,
          status: 'failed' as const,
          data: completedData,
          error: finalError ?? 'Unknown error',
          adcpError: completedAdcpError,
          errorInstance: this.buildErrorInstance(taskId, completedAdcpError),
          correlationId: extractCorrelationId(completedData),
          metadata: this.buildMetadata({
            taskId,
            taskName,
            agent,
            startTime,
            status: 'failed',
            response,
          }),
          conversation: messages,
          debug_logs: debugLogs,
        };

      case ADCP_STATUS.WORKING:
        // Server is processing - keep connection open for up to 120s
        return this.waitForWorkingCompletion<T>(
          agent,
          taskId,
          taskName,
          params,
          response,
          messages,
          inputHandler,
          options,
          debugLogs,
          startTime
        );

      case ADCP_STATUS.SUBMITTED:
        // Long-running task - set up webhook
        return this.setupSubmittedTask<T>(
          agent,
          taskId,
          taskName,
          response,
          messages,
          options,
          debugLogs,
          startTime,
          deferTerminalTaskStatus
        );

      case ADCP_STATUS.INPUT_REQUIRED:
        // Server needs input - handler is mandatory
        return this.handleInputRequired<T>(
          agent,
          taskId,
          taskName,
          params,
          response,
          messages,
          inputHandler,
          options,
          debugLogs,
          startTime,
          deferTerminalTaskStatus
        );

      case ADCP_STATUS.FAILED:
      case ADCP_STATUS.REJECTED:
      case ADCP_STATUS.CANCELED: {
        const failedData = this.extractResponseData(response, debugLogs, taskName);
        // Raw/in-process protocol clients may wrap the tool payload under
        // `data` while carrying the task lifecycle status at the top level.
        // The generic unwrapper intentionally preserves that wrapper, so
        // select its nested payload here before extracting business errors.
        const failedPayload =
          response?.structuredContent === undefined &&
          response?.content === undefined &&
          response?.result === undefined &&
          response?.data != null &&
          typeof response.data === 'object'
            ? response.data
            : failedData;
        const adcpErrorInfo = extractAdcpErrorInfo(failedPayload);
        const hasStructuredError = !!adcpErrorInfo;
        // Preserve failedData whenever the server returned a structured
        // payload — not just when extractAdcpErrorInfo recognizes an
        // `adcp_error`/`errors` envelope. Tool-level error shapes like
        // `comply_test_controller`'s `{ success: false, error: 'UNKNOWN_SCENARIO' }`
        // don't match that extractor but still carry the information
        // storyboard validators read (`success`, `error_code`, etc.).
        // Only drop `data` when there's literally no structured payload —
        // i.e. falsy or an empty object.
        const hasStructuredPayload =
          failedPayload != null &&
          typeof failedPayload === 'object' &&
          (Array.isArray(failedPayload) || Object.keys(failedPayload).length > 0);
        const structuredMessage = hasStructuredPayload ? this.extractOperationError(failedPayload) : undefined;
        const failedError =
          structuredMessage && structuredMessage !== 'Operation failed'
            ? structuredMessage
            : response.error || response.message || structuredMessage || `Task ${status}`;
        return {
          success: false as const,
          status: 'failed' as const,
          data: hasStructuredError || hasStructuredPayload ? failedPayload : undefined,
          error: typeof failedError === 'string' ? failedError : `Task ${status}`,
          adcpError: adcpErrorInfo,
          errorInstance: this.buildErrorInstance(taskId, adcpErrorInfo),
          correlationId: extractCorrelationId(failedPayload),
          metadata: this.buildMetadata({
            taskId,
            taskName,
            agent,
            startTime,
            status: 'failed',
            response,
          }),
          conversation: messages,
          debug_logs: debugLogs,
        };
      }

      default:
        // Unknown status - treat as completed if we have data
        const defaultData = this.extractResponseData(response, debugLogs, taskName);
        if (
          defaultData &&
          (defaultData !== response || response.structuredContent || response.result || response.data)
        ) {
          const defaultSuccess = this.isOperationSuccess(defaultData, taskName);

          // Validate response against AdCP schema - validate extracted data, not protocol wrapper
          const defaultValidation = this.validateResponseSchema(defaultData, taskName, debugLogs);

          // In strict mode, schema validation failures cause task to fail
          const defaultFinalSuccess = defaultSuccess && defaultValidation.valid;
          const defaultFinalError = !defaultFinalSuccess
            ? defaultValidation.errors.length > 0
              ? `Schema validation failed: ${defaultValidation.errors.join('; ')}`
              : this.extractOperationError(defaultData)
            : undefined;

          if (defaultFinalSuccess) {
            return {
              success: true as const,
              status: 'completed' as const,
              data: defaultData,
              metadata: this.buildMetadata({
                taskId,
                taskName,
                agent,
                startTime,
                status: 'completed',
                response,
              }),
              conversation: messages,
              debug_logs: debugLogs,
            };
          }
          const defaultAdcpError = extractAdcpErrorInfo(defaultData);
          return {
            success: false as const,
            status: 'failed' as const,
            data: defaultData,
            error: defaultFinalError!,
            adcpError: defaultAdcpError,
            errorInstance: this.buildErrorInstance(taskId, defaultAdcpError),
            correlationId: extractCorrelationId(defaultData),
            metadata: this.buildMetadata({
              taskId,
              taskName,
              agent,
              startTime,
              status: 'failed',
              response,
            }),
            conversation: messages,
            debug_logs: debugLogs,
          };
        } else {
          throw new Error(`Unknown status: ${status || 'undefined'}`);
        }
    }
  }

  /**
   * Extract response data from different protocol formats
   *
   * @internal Exposed for testing purposes
   */
  public extractResponseData(response: any, debugLogs?: any[], toolName?: string): any {
    // MCP error responses (isError: true) flow through here — the response unwrapper
    // extracts structured data (adcp_error, context, ext) from structuredContent or text

    // Use the shared response unwrapper utility
    // This handles MCP structuredContent, A2A artifacts (including HITL multi-artifact responses),
    // and various edge cases consistently
    try {
      // Log what type of response we're processing BEFORE unwrapping
      // This ensures we have debug visibility even if unwrapping fails
      if (response?.structuredContent) {
        this.logDebug(debugLogs, 'info', 'Processing MCP structuredContent response');
      } else if (response?.result?.artifacts) {
        const artifacts = response.result.artifacts;
        if (artifacts.length === 0) {
          this.logDebug(debugLogs, 'info', 'Processing A2A response with empty artifacts array');
        } else {
          // Calculate total part count across all artifacts
          const totalParts = artifacts.reduce((sum: number, artifact: any) => {
            return sum + (artifact.parts?.length || 0);
          }, 0);

          // Extract canonical DataPart keys for debugging.
          const latestDataPart = getLatestA2ADataPartFromResponse(response);
          const dataKeys = latestDataPart?.data ? Object.keys(latestDataPart.data) : [];

          this.logDebug(debugLogs, 'info', 'Processing A2A artifact structure', {
            artifactCount: artifacts.length,
            partCount: totalParts,
            extractedFrom: artifacts.length > 1 ? 'multi-artifact (HITL)' : 'single-artifact',
            dataKeys,
          });
        }
      } else if (response?.data) {
        this.logDebug(debugLogs, 'info', 'Processing response.data field');
      } else {
        this.logDebug(debugLogs, 'info', 'Processing response without standard structure', {
          responseKeys: Object.keys(response || {}),
        });
      }

      // Now unwrap the response
      const unwrapped = unwrapProtocolResponse(response, toolName, undefined, {
        filterInvalidProducts: this.config.filterInvalidProducts,
        responseAdcpVersion: this.effectiveResponseAdcpVersion(),
      });

      // Log successful extraction with result details
      if (response?.structuredContent) {
        this.logDebug(debugLogs, 'info', 'Successfully extracted MCP data', {
          dataKeys: Object.keys(unwrapped || {}),
        });
      } else if (response?.result?.artifacts && response.result.artifacts.length > 0) {
        this.logDebug(debugLogs, 'info', 'Successfully extracted A2A data', {
          dataKeys: Object.keys(unwrapped || {}),
        });
      }

      return unwrapped;
    } catch (error) {
      this.logDebug(debugLogs, 'warning', 'Response unwrapper failed', {
        error: error instanceof Error ? error.message : String(error),
        toolName,
        responseKeys: Object.keys(response || {}),
      });

      // If toolName was provided, schema validation may have caused the failure.
      // Retry without toolName to extract the payload without schema checks.
      if (toolName) {
        try {
          return unwrapProtocolResponse(response);
        } catch {
          // Unwrapping itself failed — fall through to raw response
        }
      }

      return response;
    }
  }

  /**
   * Check if extracted response data represents a successful operation.
   * Handles singular `error`, plural `errors` (AdCP schema), and `success: false`.
   */
  private isOperationSuccess(data: any, taskName?: string): boolean {
    return isAdcpOperationSuccess(data, taskName, this.effectiveResponseAdcpVersion());
  }

  /**
   * Extract a human-readable error message from response data.
   * Handles singular `error`, plural `errors` array, and `message` field.
   */
  private extractOperationError(data: any): string {
    if (data?.adcp_error) {
      const ae = data.adcp_error;
      return ae.message ? `${ae.code}: ${ae.message}` : ae.code;
    }
    const pluralError = Array.isArray(data?.errors)
      ? data.errors
          .map((error: any) => error?.message || error?.code)
          .filter((value: unknown): value is string => typeof value === 'string' && value.length > 0)
          .join('; ')
      : undefined;
    return (
      data?.error ||
      pluralError ||
      data?.error_detail ||
      data?.reason ||
      data?.rejection_reason ||
      data?.message ||
      'Operation failed'
    );
  }

  /**
   * Helper to add debug logs safely
   */
  private logDebug(debugLogs: any[] | undefined, type: string, message: string, details?: any) {
    if (debugLogs && Array.isArray(debugLogs)) {
      debugLogs.push({
        type,
        message,
        timestamp: new Date().toISOString(),
        details,
      });
    }
  }

  /**
   * Handle 'working' status - return as valid intermediate state
   */
  private async waitForWorkingCompletion<T>(
    agent: AgentConfig,
    taskId: string,
    taskName: string,
    params: any,
    initialResponse: any,
    messages: Message[],
    inputHandler?: InputHandler,
    options: TaskOptions = {},
    debugLogs: any[] = [],
    startTime: number = Date.now()
  ): Promise<TaskResult<T>> {
    // Extract any data that came with the working response
    const partialData = this.extractResponseData(initialResponse, debugLogs, taskName);
    const metadata = this.buildMetadata({
      taskId,
      taskName,
      agent,
      startTime,
      status: 'working',
      response: initialResponse,
    });
    this.compactIntermediateTaskState(taskId, 'working');

    // Return working status immediately - this is a valid intermediate state
    // Callers can use the taskId to poll for completion or set up webhooks
    return {
      success: true, // The task is progressing, not failed
      status: 'working',
      data: partialData,
      metadata,
      conversation: messages,
      debug_logs: debugLogs,
    };
  }

  /**
   * Set up submitted task with webhook
   */
  private async setupSubmittedTask<T>(
    agent: AgentConfig,
    taskId: string,
    taskName: string,
    response: any,
    messages: Message[],
    options: TaskOptions = {},
    debugLogs: any[] = [],
    startTime: number = Date.now(),
    deferTerminalTaskStatus = false
  ): Promise<TaskResult<T>> {
    // Extract any data that came with the submitted response
    const partialData = this.extractResponseData(response, debugLogs, taskName);

    let webhookUrl = response.webhookUrl;

    // If no webhook URL provided by server, generate one. The webhook URL
    // macro path uses the local `taskId` (the runner-side correlation id
    // that doubles as the `{operation_id}` macro value), not the server
    // handle — webhook URLs identify the buyer-side request, not the
    // seller-side task.
    if (!webhookUrl && this.config.webhookManager) {
      webhookUrl = this.config.webhookManager.generateUrl(taskId);
      await this.config.webhookManager.registerWebhook(agent, taskId, webhookUrl);
    }

    // Polling and the buyer-facing `SubmittedContinuation.taskId` use the
    // SERVER-assigned task handle, not the runner's local UUID. The local
    // UUID is the `activeTasks` map key and the `{operation_id}` webhook
    // macro value — it never reaches the seller. The server handle comes
    // from `response.task_id` / `response.data.task_id` (AdCP submitted-arm
    // wire fields) or, for A2A responses, the same handle surfaced via
    // metadata (`adcp_task_id` / `serverTaskId`) before falling back to the
    // transport `result.id` / `taskId`. `responseParser.getTaskId` walks these
    // shapes.
    //
    // When the seller violated the spec and didn't include a task handle
    // we fall back to the local UUID so the buyer at least gets a
    // non-undefined `taskId` field. The polling cycle won't be able to
    // locate the work in this state — log an advisory so operators
    // grepping debug logs can pinpoint the seller-side spec violation.
    const extractedServerTaskId = this.responseParser.getTaskId(response);
    const serverTaskId = extractedServerTaskId ?? taskId;
    // Snapshot only what continuations need. Referencing `options.transport`
    // inside either closure would retain the entire per-call options object,
    // including unrelated adopter metadata, for as long as the continuation
    // remains reachable.
    const pollingTransport = options.transport;
    if (!extractedServerTaskId) {
      debugLogs.push({
        type: 'warning',
        message:
          'Submitted-arm response omitted task_id (spec violation). Polling will use the runner-side ' +
          'correlation id as a fallback; the seller will not recognize it. ' +
          'Expected: response.task_id / response.data.task_id (AdCP), A2A metadata.serverTaskId, ' +
          'A2A metadata.adcp_task_id, or result.id with kind === "task" (A2A wrapped).',
        timestamp: new Date().toISOString(),
        taskName,
        runnerTaskId: taskId,
      });
    }

    const submitted: SubmittedContinuation<T> = {
      taskId: serverTaskId,
      webhookUrl,
      track: async (transport?: import('../protocols').TransportOptions) => {
        const task = await this.getTaskStatus(agent, serverTaskId, transport ?? pollingTransport);
        if (!deferTerminalTaskStatus && ['completed', 'failed', 'rejected', 'canceled'].includes(task.status)) {
          this.updateTaskStatus(taskId, task.status as TaskStatus, task.result, task.error);
        }
        return task;
      },
      waitForCompletion: async (pollInterval = 60000, signal?: AbortSignal) => {
        const completed = await this.pollTaskCompletion<T>(agent, serverTaskId, pollInterval, pollingTransport, signal);
        // `pollTaskCompletion` also returns paused input-required/auth-required
        // states. Preserve that status so callers can resume the seller task;
        // only genuinely terminal statuses trigger delayed state eviction.
        if (!deferTerminalTaskStatus || !TERMINAL_TASK_STATUSES.has(completed.status as TaskStatus)) {
          this.updateTaskStatus(taskId, completed.status as TaskStatus, completed.data, completed.error);
        }
        return completed;
      },
    };

    const metadata = this.buildMetadata({
      taskId,
      taskName,
      agent,
      startTime,
      status: 'submitted',
      response,
    });
    this.compactIntermediateTaskState(taskId, 'submitted');

    return {
      success: true, // The task is progressing, not failed
      status: 'submitted',
      submitted,
      data: partialData,
      metadata,
      conversation: messages,
      debug_logs: debugLogs,
    };
  }

  /**
   * A committed compatibility hook may replace resumable continuations with
   * wrappers that validate and durably persist their terminal result. Attach
   * local task publication only after those final wrappers return.
   */
  private attachSettledContinuationTaskStatus<T>(taskId: string, result: TaskResult<T>): TaskResult<T> {
    const publish = (status: TaskStatus, data?: unknown, error?: string) => {
      this.publishSettledTaskStatus(taskId, status, data, error);
    };

    if (result.submitted) {
      const submitted = result.submitted;
      result.submitted = {
        ...submitted,
        track: async transport => {
          const task = await submitted.track(transport);
          publish(task.status as TaskStatus, task.result, task.error);
          return task;
        },
        waitForCompletion: async (pollInterval, signal) => {
          const completion = this.attachSettledContinuationTaskStatus(
            taskId,
            await submitted.waitForCompletion(pollInterval, signal)
          );
          publish(completion.status as TaskStatus, completion.data, completion.error);
          return completion;
        },
      };
    }

    if (result.deferred) {
      const deferred = result.deferred;
      result.deferred = {
        ...deferred,
        resume: async input => {
          const completion = this.attachSettledContinuationTaskStatus(taskId, await deferred.resume(input));
          publish(completion.status as TaskStatus, completion.data, completion.error);
          return completion;
        },
      };
    }

    return result;
  }

  private publishSettledTaskStatus(
    taskId: string,
    status: TaskStatus,
    data?: unknown,
    error?: string,
    fromExternalObservation = false
  ): void {
    if (!TERMINAL_TASK_STATUSES.has(status)) return;
    const task = this.activeTasks.get(taskId);
    if (!task) return;
    if (!fromExternalObservation) {
      this.closeExternalTaskSettlement(
        taskId,
        new Error('The task settled through its direct response; a racing pushed result was not accepted.')
      );
    }
    if (task.status !== status) this.updateTaskStatus(taskId, status, data, error);
  }

  private rejectPendingExternalTaskObservations(taskId: string, error: unknown): void {
    const pending = this.pendingExternalTaskObservations.get(taskId);
    this.pendingExternalTaskObservations.delete(taskId);
    for (const waiter of pending ?? []) waiter.reject(error);
  }

  private closeExternalTaskSettlement(taskId: string, error: unknown): void {
    this.externalTaskSettlementHandlers.delete(taskId);
    this.externalTaskSettlementInFlight.delete(taskId);
    this.closedExternalTaskSettlementTaskIds.add(taskId);
    this.rejectPendingExternalTaskObservations(taskId, error);
  }

  private clearExternalTaskSettlementState(taskId: string): void {
    this.deferredTerminalPublicationTaskIds.delete(taskId);
    this.closedExternalTaskSettlementTaskIds.delete(taskId);
    this.externalTaskSettlementHandlers.delete(taskId);
    this.externalTaskSettlementInFlight.delete(taskId);
    this.settledExternalTaskObservationKeys.delete(taskId);
    this.externalTaskSettlementExpiry.delete(taskId);
    this.rejectPendingExternalTaskObservations(
      taskId,
      new Error('The durable push-settlement retention window expired before the observation was accepted.')
    );
  }

  private retainExternalTaskSettlementState(taskId: string): void {
    const retentionMs = this.config.externalTaskSettlementRetentionMs ?? DEFAULT_EXTERNAL_TASK_SETTLEMENT_RETENTION_MS;
    const expiry = Date.now() + retentionMs;
    if ((this.externalTaskSettlementExpiry.get(taskId) ?? 0) >= expiry) return;
    this.externalTaskSettlementExpiry.set(taskId, expiry);
    const expire = () => {
      if (this.externalTaskSettlementExpiry.get(taskId) !== expiry) return;
      const remaining = expiry - Date.now();
      if (remaining > 0) {
        const timer = setTimeout(expire, Math.min(remaining, MAX_TIMER_DELAY_MS));
        timer.unref?.();
        return;
      }
      this.clearExternalTaskSettlementState(taskId);
    };
    const timer = setTimeout(expire, Math.min(retentionMs, MAX_TIMER_DELAY_MS));
    timer.unref?.();
  }

  /** Release short-lived task inspection state without dropping a live durable push fence. */
  private cleanupTerminalTaskInspectionState(taskId: string): void {
    this.activeTasks.delete(taskId);
    this.compactedTaskIds.delete(taskId);
    if (
      this.deferredTerminalPublicationTaskIds.has(taskId) ||
      this.closedExternalTaskSettlementTaskIds.has(taskId) ||
      this.externalTaskSettlementHandlers.has(taskId)
    ) {
      if (this.externalTaskSettlementExpiry.has(taskId)) return;
    }
    this.clearExternalTaskSettlementState(taskId);
  }

  private registerExternalTaskSettlement(taskId: string, handler: ExternalTaskSettlementHandler): void {
    this.externalTaskSettlementHandlers.set(taskId, handler);
    const pending = this.pendingExternalTaskObservations.get(taskId);
    if (!pending) return;
    this.pendingExternalTaskObservations.delete(taskId);
    for (const waiter of pending) {
      void this.settleExternalTaskStatus(taskId, handler, waiter.observation).then(waiter.resolve, waiter.reject);
    }
  }

  private externalTaskObservationKey(observation: ExternalTaskSettlementObservation): string {
    return createHash('sha256')
      .update(
        canonicalize({
          status: observation.status,
          serverTaskId: observation.serverTaskId ?? null,
          taskType: observation.taskType ?? null,
          result: observation.result ?? null,
        })
      )
      .digest('base64url');
  }

  private async settleExternalTaskStatus(
    taskId: string,
    handler: ExternalTaskSettlementHandler,
    observation: ExternalTaskSettlementObservation
  ): Promise<ExternalTaskStatusResult> {
    const observationKey = this.externalTaskObservationKey(observation);
    const existing = this.externalTaskSettlementInFlight.get(taskId);
    if (existing) {
      if (existing.waiterCount >= MAX_PENDING_EXTERNAL_TASK_OBSERVATIONS) {
        throw new Error('Too many terminal push notifications are undergoing durable task settlement.');
      }
      existing.waiterCount += 1;
      try {
        const accepted = await existing.settlement;
        if (existing.observationKey !== observationKey) {
          throw new Error('This task already completed durable settlement; the pushed result was not accepted.');
        }
        return { ...accepted, duplicate: true };
      } finally {
        existing.waiterCount -= 1;
      }
    }
    const settlement = (async () => {
      const settled = await handler(observation);
      const settledStatus = settled.status as TaskStatus;
      if (this.closedExternalTaskSettlementTaskIds.has(taskId)) {
        throw new Error('The task settled through its direct response; the racing pushed result was not accepted.');
      }
      if (this.settledExternalTaskObservationKeys.has(taskId)) {
        throw new Error('This task already completed durable settlement; the pushed result was not accepted.');
      }
      this.publishSettledTaskStatus(taskId, settledStatus, settled.data, settled.error, true);
      this.settledExternalTaskObservationKeys.set(taskId, {
        key: observationKey,
        status: settledStatus,
        ...(settled.error !== undefined && {
          error: settled.error.slice(0, MAX_RETAINED_EXTERNAL_TASK_ERROR_CHARS),
        }),
      });
      this.closeExternalTaskSettlement(
        taskId,
        new Error('The task already completed durable external settlement; a later pushed result was not accepted.')
      );
      return {
        settled: true,
        result: settled.data,
        status: settled.status as TaskStatus,
        ...(settled.error !== undefined && { error: settled.error }),
      };
    })();
    const inFlight = { observationKey, settlement, waiterCount: 1 };
    this.externalTaskSettlementInFlight.set(taskId, inFlight);
    try {
      return await settlement;
    } finally {
      if (this.externalTaskSettlementInFlight.get(taskId) === inFlight) {
        this.externalTaskSettlementInFlight.delete(taskId);
      }
    }
  }

  /** Release abandoned caller data without publishing a premature terminal state. */
  private compactAbandonedObserverTaskState(taskId: string): void {
    const task = this.activeTasks.get(taskId);
    if (!task) return;
    task.params = undefined;
    task.messages = [];
    task.options = {};
    delete task.pendingInput;
  }

  /**
   * A working/submitted response carries everything needed to poll externally.
   * Keeping the original request in activeTasks after dispatch would pin
   * inline assets, webhook credentials, conversation payloads, and per-call
   * options for an unbounded amount of time while the seller works. Retain
   * only lifecycle metadata and the separately tracked idempotency key.
   */
  private compactIntermediateTaskState(
    taskId: string,
    status: 'working' | 'submitted' | 'input-required' | 'auth-required' | 'deferred'
  ): void {
    const task = this.activeTasks.get(taskId);
    if (!task) return;
    task.status = status;
    task.params = undefined;
    task.messages = [];
    task.options = {};
    delete task.pendingInput;
    this.compactedTaskIds.delete(taskId);
    this.compactedTaskIds.set(taskId, true);
    while (this.compactedTaskIds.size > COMPACTED_TASK_STATE_LIMIT) {
      const oldest = [...this.compactedTaskIds.keys()].find(
        candidate =>
          !this.deferredTerminalPublicationTaskIds.has(candidate) &&
          !this.externalTaskSettlementHandlers.has(candidate) &&
          !this.externalTaskSettlementInFlight.has(candidate)
      );
      if (oldest === undefined) break;
      this.compactedTaskIds.delete(oldest);
      this.activeTasks.delete(oldest);
      this.closeExternalTaskSettlement(oldest, new Error('The compacted task was evicted before push settlement.'));
      this.closedExternalTaskSettlementTaskIds.delete(oldest);
    }
  }

  /**
   * Handle input-required status
   *
   * Some agents (like Yahoo) return input-required status. THIS IS TOTALLY VALID AND IS AN INTERMEDIATE STATE.
   * IT SHOULD NOT BE THROWING AN ERROR. IT DOES NOT ALWAYS REQUIRE an input handler.
   * This is common for HITL (human-in-the-loop) workflows where the agent has already processed
   * the request and is just signaling that async approval may be needed.
   */
  private async handleInputRequired<T>(
    agent: AgentConfig,
    taskId: string,
    taskName: string,
    params: any,
    response: any,
    messages: Message[],
    inputHandler?: InputHandler,
    options: TaskOptions = {},
    debugLogs: any[] = [],
    startTime: number = Date.now(),
    deferTerminalTaskStatus = false
  ): Promise<TaskResult<T>> {
    const inputRequest = this.responseParser.parseInputRequest(response);

    // If no handler provided, return input-required status as a valid intermediate state
    // This allows callers to handle the input-required state themselves (e.g., HITL workflows)
    if (!inputHandler) {
      // Extract any data that came with the response (some agents include partial results)
      const partialData = this.extractResponseData(response, debugLogs, taskName);
      const metadata = this.buildMetadata({
        taskId,
        taskName,
        agent,
        startTime,
        status: 'input-required',
        response,
        inputRequest,
      });
      this.compactIntermediateTaskState(taskId, 'input-required');

      return {
        success: true, // The task is progressing, not failed
        status: 'input-required',
        data: partialData,
        metadata,
        conversation: messages,
        debug_logs: debugLogs,
      };
    }

    // Build context for handler
    const context: ConversationContext = {
      messages,
      inputRequest,
      taskId,
      agent: { id: agent.id, name: agent.name, protocol: agent.protocol },
      attempt: 1,
      maxAttempts: options.maxClarifications || 3,
      deferToHuman: async () => ({ defer: true, token: randomUUID() }),
      abort: reason => {
        throw new Error(reason || 'Task aborted');
      },
      getSummary: () => messages.map(m => `${m.role}: ${JSON.stringify(m.content)}`).join('\n'),
      wasFieldDiscussed: field =>
        // Check if any agent message requested this field via input-required
        messages.some(
          m =>
            m.role === 'agent' &&
            m.content &&
            typeof m.content === 'object' &&
            'field' in m.content &&
            (m.content as Record<string, unknown>).field === field
        ),
      getPreviousResponse: field => {
        // Find the agent message that requested this field
        const fieldRequestIndex = messages.findIndex(
          m =>
            m.role === 'agent' &&
            m.content &&
            typeof m.content === 'object' &&
            'field' in m.content &&
            (m.content as Record<string, unknown>).field === field
        );
        // The response is the next user message after the field request
        if (fieldRequestIndex >= 0) {
          const responseMsg = messages
            .slice(fieldRequestIndex + 1)
            .find(m => m.role === 'user' && m.metadata?.type === 'input_response');
          return responseMsg?.content;
        }
        return undefined;
      },
    };

    // Call handler
    const handlerResponse = await inputHandler(context);
    throwIfAborted(options.signal);

    // Check if handler wants to defer
    if (isDeferResponse(handlerResponse)) {
      const token = handlerResponse.token;

      // Save deferred state for later resumption
      if (this.config.deferredStorage) {
        await this.config.deferredStorage.set(token, {
          taskId,
          contextId: response.contextId || taskId,
          agent,
          taskName,
          params,
          messages,
          createdAt: Date.now(),
        });
        try {
          throwIfAborted(options.signal);
        } catch (error) {
          // Cancellation may race a storage adapter that ignores the signal.
          // Remove the just-written resume record before propagating it.
          await this.config.deferredStorage.delete(token);
          throw error;
        }
      }
      // Deferred storage is the resume source of truth. Avoid retaining a
      // duplicate full request (including assets/credentials) in activeTasks.
      this.compactIntermediateTaskState(taskId, 'deferred');

      const deferred: DeferredContinuation<T> = {
        token,
        question: inputRequest.question,
        resume: input => this.resumeDeferredTask<T>(token, input, !deferTerminalTaskStatus),
      };

      return {
        success: true, // The task is progressing, not failed
        status: 'deferred',
        deferred,
        metadata: this.buildMetadata({
          taskId,
          taskName,
          agent,
          startTime,
          status: 'deferred',
          clarificationRounds: 1,
          response,
        }),
        conversation: messages,
        debug_logs: debugLogs,
      };
    }

    // Handler provided input - continue with the task
    throwIfAborted(options.signal);
    return this.continueTaskWithInput<T>(
      agent,
      taskId,
      taskName,
      params,
      response.contextId,
      handlerResponse,
      messages,
      inputHandler, // Pass handler for multi-round clarification
      options,
      debugLogs,
      startTime,
      deferTerminalTaskStatus
    );
  }

  /**
   * List tasks for an agent, preferring MCP Tasks protocol when available.
   */
  private async listTasksForAgent(
    agent: AgentConfig,
    transport?: import('../protocols').TransportOptions
  ): Promise<TaskInfo[]> {
    // Try MCP Tasks protocol method first
    if (agent.protocol === 'mcp') {
      const authToken = getAuthToken(agent);
      try {
        return await listMCPTasks(agent.agent_uri, authToken, undefined, {
          transport: transport ?? this.config.transport,
          onTransportActivity: this.config.onTransportActivity,
          transportActivityContext: {
            agentId: agent.id,
          },
        });
      } catch (err) {
        if (is401Error(err)) throw err;
        // Fall through to tool call if protocol method is not supported
      }
    }
    const response = (await ProtocolClient.callTool(
      agent,
      'tasks/list',
      {},
      {
        serverVersion: this.lastKnownServerVersion,
        adcpVersion: this.config.adcpVersion,
        ...(this.config.wireAdcpVersion !== undefined && { wireAdcpVersion: this.config.wireAdcpVersion }),
        ...(this.config.versionEnvelope !== undefined && { versionEnvelope: this.config.versionEnvelope }),
        transport: transport ?? this.config.transport,
        onTransportActivity: this.config.onTransportActivity,
      }
    )) as Record<string, unknown>;
    return (response.tasks as TaskInfo[]) || [];
  }

  /**
   * Task tracking methods (PR #78)
   */
  async listTasks(agent: AgentConfig, transport?: import('../protocols').TransportOptions): Promise<TaskInfo[]> {
    try {
      return await this.listTasksForAgent(agent, transport);
    } catch {
      // Static message only — CodeQL's taint analysis treats `error` and
      // every property of it as sensitive once it originates from an
      // operation that touched `agent.oauth_client_credentials`. Surfaces
      // the failure occurred; full detail is available via DEBUG=adcp:*.
      console.warn('Failed to list tasks (see DEBUG=adcp:* logs for detail)');
      return [];
    }
  }

  private async getTaskStatusWithRawResponse(
    agent: AgentConfig,
    taskId: string,
    transport?: import('../protocols').TransportOptions,
    signal?: AbortSignal
  ): Promise<TaskStatusPollResult> {
    // AdCP `tasks/get` is the cross-protocol work-status interface
    // (`schemas/cache/<v>/bundled/core/tasks-get-{request,response}.json`).
    // MCP tool names cannot contain `/`, so MCP servers advertise the
    // SDK-owned `tasks_get` alias; A2A continues to use the spec slash name.
    //
    // The previous implementation tried MCP's `experimental.tasks.getTask`
    // first for MCP agents and fell through to the AdCP tool path on
    // capability-missing. The native MCP path tracks the TRANSPORT-call
    // lifecycle (MCP analog of A2A `Task.state`) — not AdCP work
    // lifecycle. For submitted-arm polling we need work status; the
    // two interfaces are not substitutes, so we always use the AdCP
    // tool here. MCP sellers that haven't registered `tasks_get` as
    // an AdCP tool will surface a tool-not-found error rather than
    // silently polling the wrong lifecycle.
    //
    // The request param is `task_id` (snake_case per AdCP 3.0); the
    // response is the spec's flat shape, mapped to `TaskInfo` via
    // {@link mapTasksGetResponseToTaskInfo}.
    //
    //
    // Request includes `include_result: true` so spec-conformant
    // sellers (AdCP 3.1.0+) populate the typed `result` field on
    // `completed` responses (per adcontextprotocol/adcp#3126). Older
    // sellers ignore the unknown request field; the response mapper
    // falls back to the informal `additionalProperties` passthrough
    // for those.
    const toolName = agent.protocol === 'mcp' ? 'tasks_get' : 'tasks/get';
    const response = (await ProtocolClient.callTool(
      agent,
      toolName,
      { task_id: taskId, include_result: true },
      {
        serverVersion: this.lastKnownServerVersion,
        adcpVersion: this.config.adcpVersion,
        ...(this.config.wireAdcpVersion !== undefined && { wireAdcpVersion: this.config.wireAdcpVersion }),
        ...(this.config.versionEnvelope !== undefined && { versionEnvelope: this.config.versionEnvelope }),
        transport: transport ?? this.config.transport,
        signal,
        onTransportActivity: this.config.onTransportActivity,
        transportActivityContext: {
          taskId,
        },
      }
    )) as Record<string, unknown>;
    // We don't run `extractResponseData` here: that helper's
    // generic AdCP-error-arm detection treats any top-level
    // `error: { code, message }` as an error envelope and shreds the
    // response into `{ errors: [...] }`. For `tasks/get` the `error`
    // block is informational (the failed task's reason, not a
    // request rejection), so we map the raw response directly. The
    // mapper handles the AdCP-spec flat shape, the legacy
    // `{ task: ... }` nested wrapper, and MCP `structuredContent` /
    // A2A latest structured DataPart envelopes.
    return {
      task: mapTasksGetResponseToTaskInfo(response),
      rawResponse: response,
    };
  }

  async getTaskStatus(
    agent: AgentConfig,
    taskId: string,
    transport?: import('../protocols').TransportOptions,
    signal?: AbortSignal
  ): Promise<TaskInfo> {
    return (await this.getTaskStatusWithRawResponse(agent, taskId, transport, signal)).task;
  }

  async pollTaskCompletion<T>(
    agent: AgentConfig,
    taskId: string,
    pollInterval = 60000,
    transport?: import('../protocols').TransportOptions,
    signal?: AbortSignal
  ): Promise<TaskResult<T>> {
    const pollStartTime = Date.now();
    while (true) {
      // adcp-client#1612: When the outer storyboard race timer fires, the
      // caller's AbortSignal is already aborted. Exit cleanly rather than
      // continuing to send `tasks/get` requests that nobody is waiting for.
      if (signal?.aborted) {
        const reason =
          signal.reason instanceof Error ? signal.reason.message : String(signal.reason ?? 'polling cancelled');
        // adcp-client#1617: Phase 1 — notify the seller so it can stop doing
        // work for a buyer that has already given up. A2A 0.3.0 §7.4 defines
        // tasks/cancel for exactly this case. Fire-and-forget: cancel failure
        // (TaskNotCancelable, network error, terminal-state race) is non-fatal.
        // TODO(adcp-client#1617-phase2): upgrade to awaited cancel once AdCP
        // spec defines a cross-protocol cancel verb.
        //
        // SECURITY: silent on rejection. The orphan rejection's `Error.message`
        // can carry an echoed transport response body — same trust-boundary
        // concern as `raceWithSignal` in `src/lib/testing/client.ts`. A buyer
        // who has already aborted MUST NOT see seller-controlled text leak
        // into their logs/telemetry. The outer try AND the `.catch(() => {})`
        // are both intentional: a malformed `agent_uri` could throw
        // synchronously from `fetch(...)` before the promise chain catches
        // it, so the try guards the dispatch path; the `.catch()` guards the
        // async settlement path.
        if (agent.protocol === 'a2a' && taskId && agent.agent_uri) {
          try {
            // adcp-client#1617 Phase 2: pass the full agent so cancelA2ATask
            // can sign the POST when agent.request_signing is configured.
            // signed-requests sellers no longer 401 the cancel.
            const cancelTransport = normalizeTransportOptions(transport ?? this.config.transport);
            void cancelA2ATask(agent, taskId, cancelTransport?.trustedFetchFn, cancelTransport?.allowPrivateIp).catch(
              () => {
                /* see SECURITY note above */
              }
            );
          } catch {
            /* see SECURITY note above */
          }
        }
        return attachMatch({
          success: false as const,
          status: 'failed' as const,
          error: `tasks/get polling was cancelled before a terminal state was observed: ${reason}`,
          metadata: this.buildMetadata({
            taskId,
            taskName: 'unknown',
            agent,
            startTime: pollStartTime,
            status: 'failed',
          }),
        });
      }

      // adcp-client#1585: A2A 0.3.x defines no minimum retention TTL for
      // completed tasks. A seller may evict a task between the buyer
      // observing the working-state response and the first explicit
      // `tasks/get` poll firing — `getTaskStatus` then throws with a
      // "Task <id> not found" message. Surface a descriptive `failed`
      // `TaskResult` so the caller sees an actionable error instead of an
      // opaque uncaught exception escaping from the polling loop.
      let status: TaskInfo;
      let rawResponse: Record<string, unknown> | undefined;
      try {
        const pollResult = await this.getTaskStatusWithRawResponse(agent, taskId, transport, signal);
        status = pollResult.task;
        rawResponse = pollResult.rawResponse;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Bounded `\S{1,128}` task-id segment (no `.*`) keeps the match
        // linear-time on adversarial inputs — CodeQL flags unbounded
        // polynomial regex on uncontrolled error strings.
        if (/\btask\s+\S{1,128}\s+not found\b/i.test(msg)) {
          return attachMatch({
            success: false as const,
            status: 'failed' as const,
            error: `Task ${taskId} is no longer queryable — it may have been completed and evicted by the seller before this poll arrived. Consider using push notifications (reporting_webhook) instead of polling, or configuring a longer task retention TTL on the seller.`,
            metadata: this.buildMetadata({
              taskId,
              taskName: 'unknown',
              agent,
              startTime: pollStartTime,
              status: 'failed',
            }),
          });
        }
        throw err;
      }

      if (status.status === ADCP_STATUS.COMPLETED) {
        const pollSuccess = this.isOperationSuccess(status.result, status.taskType);

        if (pollSuccess) {
          return attachMatch({
            success: true as const,
            status: 'completed' as const,
            data: status.result,
            metadata: this.buildMetadata({
              taskId,
              taskName: status.taskType,
              agent,
              responseTimeMs: Date.now() - status.createdAt,
              status: 'completed',
              response: rawResponse,
            }),
          });
        }
        const asyncResultErr = extractAdcpErrorInfo(status.result);
        return attachMatch({
          success: false as const,
          status: 'failed' as const,
          data: status.result,
          error: this.extractOperationError(status.result),
          adcpError: asyncResultErr,
          errorInstance: this.buildErrorInstance(taskId, asyncResultErr),
          correlationId: extractCorrelationId(status.result),
          metadata: this.buildMetadata({
            taskId,
            taskName: status.taskType,
            agent,
            responseTimeMs: Date.now() - status.createdAt,
            status: 'failed',
            response: rawResponse,
          }),
        });
      }

      if (
        status.status === ADCP_STATUS.FAILED ||
        status.status === ADCP_STATUS.CANCELED ||
        status.status === ADCP_STATUS.REJECTED
      ) {
        const asyncFailedErr = extractAdcpErrorInfo(status.result);
        return attachMatch({
          success: false as const,
          status: 'failed' as const,
          data: status.result,
          error: status.error || status.message || `Task ${status.status}`,
          adcpError: asyncFailedErr,
          errorInstance: this.buildErrorInstance(taskId, asyncFailedErr),
          correlationId: extractCorrelationId(status.result),
          metadata: this.buildMetadata({
            taskId,
            taskName: status.taskType,
            agent,
            responseTimeMs: Date.now() - status.createdAt,
            status: 'failed',
            response: rawResponse,
          }),
        });
      }

      // Paused states: `input-required` and `auth-required`. Polling
      // alone can't advance these — the buyer must satisfy the paused
      // condition (supply input / refresh auth) and retry the
      // original tool call. Return a `TaskResultIntermediate` so the
      // caller can branch on `result.status`; this mirrors the
      // synchronous `handleInputRequired` no-handler path
      // (`success: true` because the task is progressing, not failed).
      // Without this branch the loop would spin until timeout — the
      // paused-state regression class flagged by adcp-client#977.
      if (status.status === ADCP_STATUS.INPUT_REQUIRED || status.status === ADCP_STATUS.AUTH_REQUIRED) {
        return attachMatch({
          success: true as const,
          status: status.status,
          data: status.result as T,
          metadata: this.buildMetadata({
            taskId,
            taskName: status.taskType,
            agent,
            responseTimeMs: Date.now() - status.createdAt,
            status: status.status,
            response: rawResponse,
          }),
        });
      }

      // adcp-client#1612: `status: 'unknown'` means `mapTasksGetResponseToTaskInfo`
      // could not extract a recognizable status string from the response — the
      // seller's `tasks/get` response did not conform to any expected envelope
      // shape (flat AdCP, MCP structuredContent, or A2A DataPart artifact).
      // Continuing to poll would spin forever since the shape won't change.
      // Surface a descriptive failure so the storyboard runner reports the
      // seller's non-conformance rather than burning the outer timeout budget.
      if (status.status === 'unknown') {
        return attachMatch({
          success: false as const,
          status: 'failed' as const,
          error:
            `tasks/get returned an unrecognizable response (parsed status: "unknown", taskId: "${status.taskId}"). ` +
            `The seller may not implement tasks/get as an AdCP skill, or its response did not match any ` +
            `supported envelope shape (flat AdCP, MCP structuredContent, or A2A DataPart artifact).`,
          metadata: this.buildMetadata({
            taskId,
            taskName: 'unknown',
            agent,
            startTime: pollStartTime,
            status: 'failed',
            response: rawResponse,
          }),
        });
      }

      await this.sleep(pollInterval);
      // Re-check after sleep so a signal that fired mid-sleep exits at the top
      // of the next iteration rather than issuing one more `getTaskStatus` call.
      if (signal?.aborted) continue;
    }
  }

  /**
   * Resume a deferred task (client deferral)
   */
  async resumeDeferredTask<T>(token: string, input: any, publishTerminalTaskStatus = true): Promise<TaskResult<T>> {
    if (!this.config.deferredStorage) {
      throw new Error('Deferred storage not configured');
    }

    const state = await this.config.deferredStorage.get(token);
    if (!state) {
      throw new Error(`Deferred task not found: ${token}`);
    }

    try {
      // Continue task with the provided input (no handler for resumed deferred tasks)
      const resumed = await this.continueTaskWithInput<T>(
        state.agent,
        state.taskId,
        state.taskName,
        state.params,
        state.contextId,
        input,
        state.messages,
        undefined, // No handler for deferred tasks - input was provided by human
        {},
        [],
        Date.now(),
        !publishTerminalTaskStatus
      );
      const remainsPaused = ['input-required', 'auth-required', 'deferred'].includes(resumed.status);
      if (
        publishTerminalTaskStatus &&
        ['completed', 'failed', 'rejected', 'canceled', 'governance-denied', 'aborted'].includes(resumed.status) &&
        this.activeTasks.get(state.taskId)?.status !== resumed.status
      ) {
        this.updateTaskStatus(state.taskId, resumed.status as TaskStatus, resumed.data, resumed.error);
      }
      if (!remainsPaused) {
        await this.config.deferredStorage.delete(token);
      }
      return attachMatch(resumed);
    } catch (error) {
      // A thrown continuation failure is terminal for this deferred token.
      // Release both persistence and the in-memory request payload before the
      // error escapes to the caller.
      if (publishTerminalTaskStatus) {
        this.updateTaskStatus(
          state.taskId,
          'failed',
          undefined,
          error instanceof Error ? error.message : String(error)
        );
      }
      try {
        await this.config.deferredStorage.delete(token);
      } catch {
        // Local request compaction above is the safety boundary. Preserve the
        // original continuation/delete error if external cleanup also fails.
      }
      throw error;
    }
  }

  /**
   * Continue a task after receiving input
   */
  private async continueTaskWithInput<T>(
    agent: AgentConfig,
    taskId: string,
    taskName: string,
    params: any,
    contextId: string,
    input: any,
    messages: Message[],
    inputHandler: InputHandler | undefined,
    options: TaskOptions = {},
    debugLogs: any[] = [],
    startTime: number = Date.now(),
    deferTerminalTaskStatus = false
  ): Promise<TaskResult<T>> {
    // Add user input message
    const inputMessage: Message = {
      id: randomUUID(),
      role: 'user',
      content: input,
      timestamp: new Date().toISOString(),
      metadata: { type: 'input_response' },
    };
    messages.push(inputMessage);

    // Continue the task with input
    const response = await ProtocolClient.callTool(
      agent,
      'continue_task',
      {
        contextId,
        input,
      },
      {
        debugLogs,
        serverVersion: this.lastKnownServerVersion,
        adcpVersion: this.config.adcpVersion,
        ...(this.config.wireAdcpVersion !== undefined && { wireAdcpVersion: this.config.wireAdcpVersion }),
        ...(this.config.versionEnvelope !== undefined && { versionEnvelope: this.config.versionEnvelope }),
        transport: options.transport ?? this.config.transport,
        signal: options.signal,
        onTransportActivity: this.config.onTransportActivity,
        transportActivityContext: {
          operationId: taskId,
          taskId,
          contextId,
        },
      }
    );

    // Add response message
    const responseMessage: Message = {
      id: randomUUID(),
      role: 'agent',
      content: response,
      timestamp: new Date().toISOString(),
      metadata: { type: 'continued_response' },
    };
    messages.push(responseMessage);

    // Handle the continued response (pass inputHandler for multi-round clarification)
    return this.handleAsyncResponse<T>(
      agent,
      taskId,
      taskName,
      params,
      response,
      messages,
      inputHandler,
      options,
      debugLogs,
      startTime,
      deferTerminalTaskStatus
    );
  }

  /**
   * Utility methods
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private createErrorResult<T>(
    taskId: string,
    agent: AgentConfig,
    error: any,
    debugLogs: any[] = [],
    startTime: number = Date.now()
  ): TaskResult<T> {
    // Try to extract structured error info from transport exceptions
    // (e.g., JSON-RPC errors with data.adcp_error)
    const transportData = error?.data || error?.response?.data;
    const adcpErrorInfo = extractAdcpErrorInfo(transportData);
    const correlationId = extractCorrelationId(transportData);

    return {
      success: false as const,
      status: 'failed' as const,
      error: error.message || String(error),
      adcpError: adcpErrorInfo,
      errorInstance: this.buildErrorInstance(taskId, adcpErrorInfo),
      correlationId,
      metadata: this.buildMetadata({
        taskId,
        taskName: 'unknown',
        agent,
        startTime,
        status: 'failed',
      }),
      debug_logs: debugLogs,
    };
  }

  /**
   * Legacy methods for backward compatibility
   */
  getConversationHistory(taskId: string): Message[] | undefined {
    return this.conversationStorage?.get(taskId);
  }

  clearConversationHistory(taskId: string): void {
    this.conversationStorage?.delete(taskId);
  }

  getActiveTasks(): TaskState[] {
    return Array.from(this.activeTasks.values());
  }

  // ====== TASK MANAGEMENT & NOTIFICATION METHODS ======

  private taskEventListeners = new Map<
    string,
    {
      callback: (task: TaskInfo) => void;
      agentId?: string;
    }[]
  >();

  private webhookRegistrations = new Map<
    string,
    {
      agent: AgentConfig;
      webhookUrl: string;
      taskTypes?: string[];
    }
  >();

  /**
   * Get task list for a specific agent
   */
  async getTaskList(agentId: string, transport?: import('../protocols').TransportOptions): Promise<TaskInfo[]> {
    // First try to get from agent via protocol
    const agent = this.findAgentById(agentId);
    if (agent) {
      try {
        return await this.listTasksForAgent(agent, transport);
      } catch {
        // Static message — see comment on listTasks above.
        console.warn('Failed to get remote task list (see DEBUG=adcp:* logs for detail)');
      }
    }

    // Fall back to local active tasks
    return Array.from(this.activeTasks.values())
      .filter(task => task.agent.id === agentId)
      .map(task => ({
        taskId: task.taskId,
        status: task.status,
        taskType: task.taskName,
        createdAt: task.startTime,
        updatedAt: task.startTime, // TODO: track updates
      }));
  }

  /**
   * Get detailed information about a specific task
   */
  async getTaskInfo(taskId: string): Promise<TaskInfo | null> {
    const localTask = this.activeTasks.get(taskId);
    if (localTask) {
      if (this.compactedTaskIds.has(taskId)) {
        this.compactedTaskIds.delete(taskId);
        this.compactedTaskIds.set(taskId, true);
      }
      return {
        taskId: localTask.taskId,
        status: localTask.status,
        taskType: localTask.taskName,
        createdAt: localTask.startTime,
        updatedAt: localTask.startTime,
      };
    }

    // Try to get from agent
    // Note: Would need to know which agent to query
    return null;
  }

  /**
   * Subscribe to task updates for a specific agent
   */
  onTaskUpdate(agentId: string, callback: (task: TaskInfo) => void): () => void {
    const listenerId = randomUUID();
    const listeners = this.taskEventListeners.get(listenerId) || [];
    listeners.push({ callback, agentId });
    this.taskEventListeners.set(listenerId, listeners);

    return () => {
      this.taskEventListeners.delete(listenerId);
    };
  }

  /**
   * Subscribe to task events with detailed callbacks
   */
  onTaskEvents(
    agentId: string,
    callbacks: {
      onTaskCreated?: (task: TaskInfo) => void;
      onTaskUpdated?: (task: TaskInfo) => void;
      onTaskCompleted?: (task: TaskInfo) => void;
      onTaskFailed?: (task: TaskInfo, error: string) => void;
    }
  ): () => void {
    const unsubscribeFns: (() => void)[] = [];

    // Create combined handler that routes to specific callbacks
    const handler = (task: TaskInfo) => {
      switch (task.status) {
        case 'submitted':
        case 'working':
          callbacks.onTaskCreated?.(task);
          break;
        case 'input-required':
          callbacks.onTaskUpdated?.(task);
          break;
        case 'completed':
          callbacks.onTaskCompleted?.(task);
          break;
        case 'failed':
        case 'rejected':
        case 'canceled':
          callbacks.onTaskFailed?.(task, task.error || `Task ${task.status}`);
          break;
        default:
          callbacks.onTaskUpdated?.(task);
      }
    };

    unsubscribeFns.push(this.onTaskUpdate(agentId, handler));

    return () => {
      unsubscribeFns.forEach(fn => fn());
    };
  }

  /**
   * Register webhook for task notifications
   */
  async registerWebhook(agent: AgentConfig, webhookUrl: string, taskTypes?: string[]): Promise<void> {
    this.webhookRegistrations.set(agent.id, {
      agent,
      webhookUrl,
      taskTypes,
    });

    // TODO: Register with remote agent if it supports webhooks
    console.log(`Webhook registered for agent ${agent.id}: ${webhookUrl}`);
  }

  /**
   * Unregister webhook notifications
   */
  async unregisterWebhook(agent: AgentConfig): Promise<void> {
    this.webhookRegistrations.delete(agent.id);
    console.log(`Webhook unregistered for agent ${agent.id}`);
  }

  /**
   * Emit task event to listeners
   */
  private emitTaskEvent(task: TaskInfo, agentId?: string): void {
    this.taskEventListeners.forEach(listeners => {
      listeners.forEach(({ callback, agentId: listenerAgentId }) => {
        if (!listenerAgentId || listenerAgentId === agentId) {
          try {
            callback(task);
          } catch (error) {
            console.error('Error in task event callback:', error instanceof Error ? error.message : 'unknown error');
          }
        }
      });
    });
  }

  /**
   * Normalize response data for schema validation
   *
   * Converts v2-style responses to v3 format before validation.
   * This ensures validation passes for both v2 and v3 server responses.
   */
  private normalizeResponseForValidation(response: any, taskName: string, legacyWire = false): any {
    if (!response) return response;

    // Strip underscore-prefixed client-side annotations (`_message` is added
    // by the response unwrapper, others may follow). Schemas with
    // `additionalProperties: false` (create-property-list-response, etc.)
    // would otherwise reject every response that reaches the grader's
    // schema check — the annotation is not part of the wire protocol.
    const stripped: Record<string, unknown> = {};
    if (typeof response === 'object' && !Array.isArray(response)) {
      for (const [k, v] of Object.entries(response)) {
        if (!k.startsWith('_')) stripped[k] = v;
      }
    } else {
      return taskName === 'get_products' && !legacyWire ? normalizeGetProductsResponse(response) : response;
    }

    // Validate v2.5 against the exact response that crossed the wire. Public
    // canonicalization happens later in SingleAgentClient; applying it here
    // would compare canonical `fixed_price`/`format_options` fields to the
    // legacy schema that correctly requires `rate`/`is_fixed`/`format_ids`.
    if (legacyWire) return stripped;

    switch (taskName) {
      case 'get_products':
        return normalizeGetProductsResponse(stripped);
      default:
        return stripped;
    }
  }

  /**
   * Validate an incoming response against the bundled AdCP JSON schema for
   * `taskName`. Strict mode fails the task; warn mode logs and returns
   * valid so the caller can continue. Off mode short-circuits before
   * AJV runs.
   */
  private validateResponseSchema(
    response: any,
    taskName: string,
    debugLogs: any[]
  ): { valid: boolean; errors: string[] } {
    const mode = this.responseValidationMode;
    const logViolations = this.config.logSchemaViolations !== false;

    try {
      // Validate against the version the agent actually spoke. Without
      // this, v2.5 sellers (e.g. Wonderstruck) return valid v2.5-shaped
      // responses and the SDK rejects them as malformed v3 — surfaces as
      // `pricing_options must NOT have fewer than 1 items` and similar
      // shape mismatches that don't exist in v2.5. The v3 → v2 path is
      // already correctly version-pinned via lastKnownServerVersion.
      const validationVersion =
        this.lastKnownServerVersion === 'v2'
          ? 'v2.5'
          : (this.responseAdcpVersionForValidation() ?? this.config.adcpVersion ?? ADCP_VERSION);
      const normalizedResponse = this.normalizeResponseForValidation(response, taskName, validationVersion === 'v2.5');
      // TaskExecutor owns the user-facing log entry below. Passing debugLogs
      // into the lower-level hook would emit a second, unversioned duplicate.
      const outcome = validateIncomingResponse(taskName, normalizedResponse, mode, undefined, validationVersion);
      if (outcome.valid) return { valid: true, errors: [] };

      const errorStrings = outcome.issues.map(i => `${i.pointer}: ${i.message}`);

      if (logViolations) {
        debugLogs.push({
          timestamp: new Date().toISOString(),
          type: mode === 'strict' ? 'error' : 'warning',
          message: `Schema validation ${mode === 'strict' ? 'failed' : 'warning'} for ${taskName}: ${formatIssues(
            outcome.issues
          )}`,
          errors: errorStrings,
          issues: outcome.issues,
          schemaVariant: outcome.variant,
          schemaVersion: validationVersion,
          mode,
        });
      }

      if (mode === 'warn') {
        if (logViolations) {
          console.warn(
            `Schema validation failed for ${taskName} against AdCP ${validationVersion} (non-blocking):`,
            errorStrings
          );
        }
        return { valid: true, errors: [] };
      }

      if (logViolations) {
        console.error(`Schema validation failed for ${taskName} against AdCP ${validationVersion}:`, errorStrings);
      }
      return { valid: false, errors: errorStrings };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'unknown error';
      console.error('Error during schema validation:', errorMessage);
      return {
        valid: mode !== 'strict',
        errors: mode === 'strict' ? [`Validation error: ${errorMessage}`] : [],
      };
    }
  }

  private responseAdcpVersionForValidation(): string | undefined {
    if (this.config.versionEnvelope === 'major-only') return '3.0';
    return undefined;
  }

  private effectiveResponseAdcpVersion(): string {
    if (this.lastKnownServerVersion === 'v2') return 'v2.5';
    return this.responseAdcpVersionForValidation() ?? this.config.adcpVersion ?? ADCP_VERSION;
  }

  /**
   * Update task status and emit events
   */
  private updateTaskStatus(taskId: string, status: TaskStatus, result?: any, error?: string): void {
    const task = this.activeTasks.get(taskId);
    if (task) {
      // Once cancellation has released request state, late work must not
      // resurrect the task or emit completion after the caller has retried.
      if (task.status === 'aborted' && status !== 'aborted') return;
      const previousStatus = task.status;
      task.status = status;

      const taskInfo: TaskInfo = {
        taskId: task.taskId,
        status: status,
        taskType: task.taskName,
        createdAt: task.startTime,
        updatedAt: Date.now(),
        result,
        error,
      };

      this.emitTaskEvent(taskInfo, task.agent.id);

      this.config.onActivity?.({
        type: 'status_change',
        operation_id: task.taskId,
        agent_id: task.agent.id,
        context_id: undefined,
        task_id: task.taskId,
        task_type: task.taskName,
        status: status,
        payload: result ?? (error ? { error } : undefined),
        timestamp: new Date().toISOString(),
      });

      if (status === 'input-required' || status === 'auth-required') {
        this.compactIntermediateTaskState(taskId, status);
      }

      // If task is finished, remove from active tasks after a delay.
      // unref() ensures this timer doesn't prevent the process from exiting.
      if (TERMINAL_TASK_STATUSES.has(status)) {
        // Keep lifecycle metadata briefly for status inspection, but release
        // request/conversation/options immediately. These may contain inline
        // creative assets and webhook or transport credentials.
        task.params = undefined;
        task.messages = [];
        task.options = {};
        delete task.pendingInput;
        setTimeout(() => {
          this.cleanupTerminalTaskInspectionState(taskId);
        }, 30000).unref(); // Keep for 30 seconds for final status checks
      }
    }
  }

  /**
   * Helper to find agent config by ID
   */
  private findAgentById(agentId: string): AgentConfig | undefined {
    // This would ideally be passed in or stored in the executor
    // For now, return undefined and fall back to local tasks
    return undefined;
  }
}
