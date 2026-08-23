// Core task execution engine for ADCP conversation flow
// Implements PR #78 async patterns: working/submitted/input-required/completed

import { createHmac, randomBytes, randomUUID } from 'crypto';
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
import type { DeferredTaskState, DeferredTaskStorage } from '../storage/interfaces';
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
import { SECRET_KEY_PATTERN, secretKeyPatternMatches } from '../utils/redact-secrets';
import { MAX_JSON_DEPTH } from '../utils/json-depth';
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
  readonly token!: string;

  constructor(token: string) {
    super('Task deferred with an opaque continuation token.');
    this.name = 'DeferredTaskError';
    Object.defineProperty(this, 'token', {
      value: token,
      enumerable: false,
      writable: false,
      configurable: false,
    });
  }
}

export class InputRequiredError extends Error {
  constructor(question: string) {
    super(`Server requires input but no handler provided. Question: ${question}`);
    this.name = 'InputRequiredError';
  }
}

/** Internal settlement acknowledgement carried through higher-level result projection. */
export const DEFERRED_SETTLEMENT_ACK = Symbol('adcp.deferredSettlementAck');
const DEFERRED_SETTLEMENT_NACK = Symbol('adcp.deferredSettlementNack');
const AUTHORITATIVE_POLLED_TERMINAL = Symbol('adcp.authoritativePolledTerminal');
const DEFERRED_PENDING_SETTLEMENT = Symbol('adcp.deferredPendingSettlement');
const COMPLETION_HANDLER_ALREADY_PUBLISHED = Symbol('adcp.completionHandlerAlreadyPublished');
// Observation fingerprints live only in process-local settlement maps. A
// process-private HMAC keeps equality stable for those maps without retaining
// a reusable digest of credential-bearing seller result data.
const EXTERNAL_TASK_OBSERVATION_HMAC_KEY = randomBytes(32);

export class DeferredSettlementOwnershipError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DeferredSettlementOwnershipError';
  }
}

/** Carry only the SDK's private settlement controls across an internal result projection. */
export function transferDeferredSettlementAcknowledgement<T extends object>(source: object, target: T): T {
  for (const symbol of [DEFERRED_SETTLEMENT_ACK, DEFERRED_SETTLEMENT_NACK]) {
    const descriptor = Object.getOwnPropertyDescriptor(source, symbol);
    if (descriptor) Object.defineProperty(target, symbol, descriptor);
  }
  return target;
}

/** Identify the internal submitted continuation that owns a durable pending checkpoint. */
export function hasDeferredPendingSettlement(result: TaskResult<any>): boolean {
  return DEFERRED_PENDING_SETTLEMENT in result;
}

export function isAuthoritativePolledTerminal(result: TaskResult<any>): boolean {
  return AUTHORITATIVE_POLLED_TERMINAL in result;
}

/** Mark a result whose configured completion handler was already invoked by durable callback publication. @internal */
export function markCompletionHandlerAlreadyPublished<T extends object>(result: T): T {
  Object.defineProperty(result, COMPLETION_HANDLER_ALREADY_PUBLISHED, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return result;
}

/** Avoid invoking an application completion handler twice for the same durable publication. @internal */
export function hasCompletionHandlerAlreadyPublished(result: object): boolean {
  return COMPLETION_HANDLER_ALREADY_PUBLISHED in result;
}

const DEFERRED_CONTINUATION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43,256}$/;
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function assertDeferredContinuationToken(token: unknown): asserts token is string {
  if (typeof token !== 'string' || (!DEFERRED_CONTINUATION_TOKEN_PATTERN.test(token) && !UUID_V4_PATTERN.test(token))) {
    throw new Error('Deferred continuation token has an invalid shape.');
  }
}

export async function checkpointDeferredPendingSettlement<T>(
  owner: TaskResult<any>,
  terminal: TaskResult<T>
): Promise<TaskResult<T>> {
  const checkpoint = (
    owner as TaskResult<any> & {
      [DEFERRED_PENDING_SETTLEMENT]?: (result: TaskResult<T>) => Promise<TaskResult<T>>;
    }
  )[DEFERRED_PENDING_SETTLEMENT];
  if (!checkpoint) throw new Error('Durable pending settlement checkpoint is unavailable.');
  return checkpoint(terminal);
}

function markAuthoritativePolledTerminal<T>(result: TaskResult<T>): TaskResult<T> {
  Object.defineProperty(result, AUTHORITATIVE_POLLED_TERMINAL, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return result;
}

export async function acknowledgeDeferredSettlement(result: TaskResult<any>): Promise<void> {
  const acknowledge = (
    result as TaskResult<any> & {
      [DEFERRED_SETTLEMENT_ACK]?: (finalizedResult?: TaskResult<any>) => Promise<void>;
    }
  )[DEFERRED_SETTLEMENT_ACK];
  await acknowledge?.(result);
}

export async function rejectDeferredSettlement(result: TaskResult<any>): Promise<void> {
  const reject = (
    result as TaskResult<any> & {
      [DEFERRED_SETTLEMENT_NACK]?: () => Promise<void>;
    }
  )[DEFERRED_SETTLEMENT_NACK];
  await reject?.();
}

/** Supporting contract for the internal pre-dispatch boundary. */
export type BeforeProtocolDispatchHookResult<T> =
  | {
      action: 'dispatch_committed';
      /** Require the owning durable coordinator to authorize every seller-input continuation. */
      requireDeferredSettlementResumeAuthorization?: boolean;
      /** Persist returned pauses for restart/public-token recovery. Defaults to true. */
      persistPausedContinuation?: boolean;
      /** Persist or otherwise settle the seller result inside the executor-owned dispatch lifetime. */
      onResult?: (result: TaskResult<T>) => Promise<TaskResult<T>>;
      /** Fence transport/parser uncertainty inside the executor-owned dispatch lifetime. */
      onError?: (error: unknown) => Promise<never>;
    }
  | { action: 'return'; result: TaskResult<T> };

/** Context supplied to the internal pre-dispatch boundary. */
export interface BeforeProtocolDispatchContext {
  /** Client-minted operation id embedded in the callback route. */
  operationId: string;
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
  idempotencyKey?: string;
  /** True when the caller already owns the deferred terminal finalization lease. @internal */
  deferredCheckpointOwned?: boolean;
}

export type ExternalTaskSettlementHandler = (
  observation: ExternalTaskSettlementObservation
) => Promise<TaskResult<unknown>>;

export interface ExternalTaskStatusResult {
  settled: boolean;
  /** Accepted for deferred settlement once the response supplies trusted task identity. */
  queued?: boolean;
  /** Exact retry of a terminal observation that already completed durable settlement. */
  duplicate?: boolean;
  result?: unknown;
  status?: TaskStatus;
  error?: string;
  /** Durable acknowledgement to run only after application dispatch succeeds. @internal */
  afterDispatch?: () => Promise<void>;
  /** Release an acquired durable-finalization owner when application dispatch fails. @internal */
  onDispatchError?: () => Promise<void>;
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
  _agent: AgentConfig,
  preparedCall: PreparedProtocolToolCall
): { callbackUrl: string; mode: 'rfc9421' | 'hmac-sha256' } | undefined {
  const candidate =
    preparedCall.args.push_notification_config &&
    typeof preparedCall.args.push_notification_config === 'object' &&
    !Array.isArray(preparedCall.args.push_notification_config)
      ? (preparedCall.args.push_notification_config as Record<string, unknown>)
      : _agent.protocol === 'a2a'
        ? preparedCall.pushNotificationConfig
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

interface TaskStatusPollResult {
  task: TaskInfo;
  rawResponse: Record<string, unknown>;
}

class TaskBindingMismatchError extends Error {
  constructor(
    message: string,
    readonly rawResponse: Record<string, unknown>
  ) {
    super(message);
    this.name = 'TaskBindingMismatchError';
  }
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
const DEFAULT_DEFERRED_TASK_TTL_SECONDS = 7 * 24 * 60 * 60;
// Human continuation tokens may intentionally be short-lived. Once seller
// dispatch is admitted, mutation fencing and terminal recovery need their own
// substantially longer horizon that cannot be shortened by that option.
const DEFAULT_DEFERRED_SAFETY_RETENTION_SECONDS = 7 * 24 * 60 * 60;
const DEFERRED_SAFETY_MARGIN_SECONDS = 60;
const DEFERRED_FINALIZATION_LEASE_MS = 30_000;
const DEFERRED_FINALIZATION_RENEW_MS = 10_000;
const DEFERRED_DISPATCH_ADMISSION_LEASE_MS = 30_000;
const DEFERRED_DISPATCH_ADMISSION_RENEW_MS = 10_000;
const DEFERRED_SECRET_KEY_PATTERN = new RegExp(
  `(?:${SECRET_KEY_PATTERN.source})|^(?:auth|oauth)[_-]?token$`,
  SECRET_KEY_PATTERN.flags
);

function snapshotTaskOptions(options: TaskOptions): TaskOptions {
  return {
    ...options,
    ...(options.transport !== undefined && { transport: snapshotTransportOptions(options.transport) }),
    ...(options.metadata !== undefined && { metadata: structuredClone(options.metadata) }),
  };
}

function snapshotTransportOptions(
  transport?: import('../protocols').TransportOptions
): import('../protocols').TransportOptions | undefined {
  return transport === undefined ? undefined : { ...transport };
}

function durableDeferredSnapshot<T>(value: T): T {
  const snapshot = (current: unknown, depth: number, seen: WeakSet<object>): unknown => {
    // Durable continuations must never preserve an unvisited subtree. The
    // shared recorder redactor relies on a later depth assertion, whereas
    // this path writes the clone directly to adopter-controlled storage.
    if (depth > MAX_JSON_DEPTH) return '[Truncated]';
    if (Array.isArray(current)) {
      if (seen.has(current)) return '[Circular]';
      seen.add(current);
      const result = current.map(item => snapshot(item, depth + 1, seen));
      seen.delete(current);
      return result;
    }
    if (current && typeof current === 'object') {
      if (seen.has(current)) return '[Circular]';
      seen.add(current);
      const result: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(current as Record<string, unknown>)) {
        // Secret-shaped containers (for example service-account
        // `credentials`) are opaque. Redact the entire value rather than
        // assuming its vendor-specific child keys also match our pattern.
        const retained = secretKeyPatternMatches(DEFERRED_SECRET_KEY_PATTERN, key)
          ? '[redacted]'
          : snapshot(item, depth + 1, seen);
        Object.defineProperty(result, key, {
          value: retained,
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
      seen.delete(current);
      return result;
    }
    return current;
  };

  return snapshot(value, 0, new WeakSet()) as T;
}

function comparableDeferredTerminal(result: unknown): unknown {
  const snapshot = durableDeferredSnapshot(result) as Partial<TaskResult<unknown>> | undefined;
  if (!snapshot || typeof snapshot !== 'object') return snapshot;
  return {
    success: snapshot.success,
    status: snapshot.status,
    data: snapshot.data,
    error: snapshot.error,
    adcpError: snapshot.adcpError,
    correlationId: snapshot.correlationId,
    serverTaskId: snapshot.metadata?.serverTaskId,
  };
}

function sameDeferredTerminal(left: unknown, right: unknown): boolean {
  return canonicalize(comparableDeferredTerminal(left)) === canonicalize(comparableDeferredTerminal(right));
}

function reconcileDeferredServerTaskId(
  trustedServerTaskId: string | undefined,
  observedServerTaskIds: readonly (string | undefined)[],
  mismatchMessage = 'The committed deferred continuation changed its bound seller task identity.'
): string | undefined {
  const identities = [trustedServerTaskId, ...observedServerTaskIds].filter(
    (identity): identity is string => identity !== undefined
  );
  for (const identity of identities) {
    if (identity.length === 0) {
      throw new Error('The committed deferred continuation contains an invalid empty seller task identity.');
    }
  }
  const serverTaskId = trustedServerTaskId ?? observedServerTaskIds.find(identity => identity !== undefined);
  if (serverTaskId !== undefined && identities.some(identity => identity !== serverTaskId)) {
    throw new Error(mismatchMessage);
  }
  return serverTaskId;
}

function normalizeDeferredTerminalServerTaskId<T>(
  result: TaskResult<T>,
  trustedServerTaskId?: string
): { result: TaskResult<T>; serverTaskId?: string } {
  const observedServerTaskId = result.metadata?.serverTaskId;
  const serverTaskId = reconcileDeferredServerTaskId(trustedServerTaskId, [observedServerTaskId]);
  if (serverTaskId === undefined || observedServerTaskId === serverTaskId) {
    return { result, ...(serverTaskId !== undefined && { serverTaskId }) };
  }
  return {
    result: {
      ...result,
      metadata: {
        ...result.metadata,
        serverTaskId,
      },
    },
    serverTaskId,
  };
}

function trustedDeferredServerTaskId(state: DeferredTaskState): string | undefined {
  return reconcileDeferredServerTaskId(
    state.settlementServerTaskId,
    [state.settlementPendingTaskId],
    'The durable deferred checkpoint contains conflicting seller task identities.'
  );
}

interface DeferredFinalizationLease {
  finalize<T>(result: TaskResult<T>): Promise<void>;
  release(completionHandlerPublished?: boolean): Promise<void>;
}

interface DeferredDispatchAdmissionLease {
  stop(): Promise<{ version: string; state: DeferredTaskState }>;
}

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
  private readonly externalTaskSettlementTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly pendingExternalTaskObservations = new Map<string, ExternalTaskSettlementObservation[]>();
  private readonly deferredAgents = new Map<string, AgentConfig>();
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
      deferredStorage?: DeferredTaskStorage;
      /** Resolve current trusted agent configuration after a process restart. */
      resolveDeferredAgent?: (agentId: string) => AgentConfig | undefined | Promise<AgentConfig | undefined>;
      /** Lifetime of a durable human-continuation token. Defaults to seven days. */
      deferredTaskTtlSeconds?: number;
      /** Check whether the owning client can recover a committed deferred settlement. */
      canRecoverDeferredSettlement?: (operationId: string) => boolean | Promise<boolean>;
      /** Verify that this is still the coordinator's current committed continuation token. */
      authorizeDeferredSettlementResume?: (operationId: string, token: string) => boolean | Promise<boolean>;
      /** Verify a separate owner capability before revealing a route's opaque continuation token. */
      authorizeDeferredSettlementOperationRecovery?: (
        operationId: string,
        recoveryKey: string,
        purpose: 'pause-recovery' | 'callback-checkpoint'
      ) => boolean | Promise<boolean>;
      /** Atomically hand a committed coordinator route from one persisted token generation to the next. */
      replaceDeferredSettlementResumeToken?: (
        operationId: string,
        currentToken: string,
        replacementToken: string
      ) => boolean | Promise<boolean>;
      /** Settle a committed deferred result before it can be published or returned. */
      recoverDeferredSettlement?: (
        result: TaskResult<any>,
        operationId: string,
        serverTaskId?: string
      ) => Promise<{ result: TaskResult<any>; afterFinalize?: () => Promise<void> }>;
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
    if (
      config.deferredTaskTtlSeconds !== undefined &&
      (!Number.isSafeInteger(config.deferredTaskTtlSeconds) || config.deferredTaskTtlSeconds < 1)
    ) {
      throw new ConfigurationError('deferredTaskTtlSeconds must be a positive safe integer.');
    }
    if (config.deferredStorage && typeof config.deferredStorage.putIfAbsent !== 'function') {
      throw new ConfigurationError(
        'Deferred storage must implement atomic putIfAbsent() creation so replicas cannot overwrite a continuation. ' +
          'Use MemoryStorage for single-process tests or implement the DeferredTaskStorage atomic contract.'
      );
    }
    if (config.deferredStorage && typeof config.deferredStorage.replaceIfVersion !== 'function') {
      throw new ConfigurationError(
        'Deferred storage must implement atomic replaceIfVersion() fencing so only one replica can dispatch a resume. ' +
          'Use MemoryStorage for single-process tests or implement the DeferredTaskStorage atomic contract.'
      );
    }
    if (config.deferredStorage && typeof config.deferredStorage.takeIfVersion !== 'function') {
      throw new ConfigurationError(
        'Deferred storage must implement atomic takeIfVersion() cleanup so stale owners cannot delete newer state. ' +
          'Use MemoryStorage for single-process tests or implement the DeferredTaskStorage atomic contract.'
      );
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
      const pending = this.pendingExternalTaskObservations.get(taskId) ?? [];
      if (pending.length >= MAX_PENDING_EXTERNAL_TASK_OBSERVATIONS) {
        throw new Error('Too many terminal push notifications are awaiting durable task settlement.');
      }
      pending.push(observation);
      this.pendingExternalTaskObservations.set(taskId, pending);
      // The seller may wait for callback acknowledgement before returning the
      // response that carries its task id. Do not couple that acknowledgement
      // to the settlement handler that can only be registered from the response.
      return { settled: false, queued: true };
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

  /** Whether durable settlement can run immediately without an in-memory queue. */
  hasExternalTaskSettlementHandler(taskId: string): boolean {
    return this.externalTaskSettlementHandlers.has(taskId);
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
      const a2aTaskId = this.responseParser.getA2APendingTaskId(args.response);
      if (a2aTaskId) meta.a2aTaskId = a2aTaskId;
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
    beforeProtocolDispatch?: BeforeProtocolDispatchHook<T>,
    deferredClientContext?: unknown
  ): Promise<TaskResult<T>> {
    // The configured transport is the same SSRF/custom-fetch trust boundary as
    // a per-call override. Own the effective value before activity, governance,
    // or protocol discovery can yield to code that still holds the config.
    const optionsSnapshot = snapshotTaskOptions({
      ...options,
      ...(options.transport === undefined && this.config.transport !== undefined
        ? { transport: this.config.transport }
        : {}),
    });
    return withTaskDeadline(optionsSnapshot, effectiveOptions =>
      this.executeTaskWithinDeadline<T>(
        agent,
        taskName,
        params,
        inputHandler,
        effectiveOptions,
        serverVersion,
        targetCapabilities,
        beforeProtocolDispatch,
        deferredClientContext
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
    beforeProtocolDispatch?: BeforeProtocolDispatchHook<T>,
    deferredClientContext?: unknown
  ): Promise<TaskResult<T>> {
    const effectiveServerVersion = serverVersion ?? 'v3';
    this.lastKnownServerVersion = effectiveServerVersion;
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
      | Pick<
          Extract<BeforeProtocolDispatchHookResult<T>, { action: 'dispatch_committed' }>,
          'onResult' | 'onError' | 'requireDeferredSettlementResumeAuthorization' | 'persistPausedContinuation'
        >
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
              operationId: taskId,
              serverVersion: effectiveServerVersion,
              adcpVersion: this.config.adcpVersion,
              wireAdcpVersion: this.config.wireAdcpVersion,
              versionEnvelope: this.config.versionEnvelope,
            }).args
          : params;
        if (await governanceMiddleware.shouldCheck(taskName, governableParams, targetCapabilities)) {
          const sdkInjectedPushConfig =
            modernGovernance && webhookUrl !== undefined && this.config.webhookSecret !== undefined;
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
        operationId: taskId,
        serverVersion: effectiveServerVersion,
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
          this.compactClosedExternalTaskSettlementFences();
          if (
            this.liveExternalTaskSettlementCount() + this.settlementCapacityReservations.size >=
            COMPACTED_TASK_STATE_LIMIT
          ) {
            throw new Error('The durable task-settlement capacity is exhausted; no mutation claim was attempted.');
          }
          this.settlementCapacityReservations.add(taskId);
          if (webhookRegistrationPersisted) {
            await this.config.onDurableSettlementRequired?.(taskId);
            throwIfAborted(options.signal);
          }
          decision = await beforeProtocolDispatch(preparedCall.args, {
            operationId: taskId,
            governanceAdjusted,
            publishSettledTaskStatus: (status, data, error) =>
              this.publishSettledTaskStatus(taskId, status, data, error),
            registerExternalTaskSettlement: handler => this.registerExternalTaskSettlement(taskId, handler),
          });
          if (decision.action === 'dispatch_committed') {
            if (
              decision.requireDeferredSettlementResumeAuthorization === true &&
              this.config.deferredStorage !== undefined
            ) {
              this.requireDeferredSettlementOperationRouting(this.config.deferredStorage);
            }
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
          } else if (
            ['working', 'submitted', 'input-required', 'auth-required', 'deferred'].includes(earlyResult.status)
          ) {
            this.compactIntermediateTaskState(
              taskId,
              earlyResult.status as 'working' | 'submitted' | 'input-required' | 'auth-required' | 'deferred'
            );
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
        operationId: taskId,
        serverVersion: effectiveServerVersion,
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
        dispatchCommitted,
        dispatchSettlement?.persistPausedContinuation ?? true,
        effectiveServerVersion,
        deferredClientContext,
        dispatchSettlement?.requireDeferredSettlementResumeAuthorization === true
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
          this.updateTaskStatus(taskId, 'failed', undefined, 'An SDK post-dispatch settlement hook failed.');
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
        try {
          await dispatchSettlement.onError(error);
        } catch (settlementError) {
          this.closeExternalTaskSettlement(taskId, settlementError);
          this.updateTaskStatus(taskId, 'failed', undefined, 'An SDK post-dispatch settlement hook failed.');
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
    deferTerminalTaskStatus = false,
    persistPausedContinuation = true,
    serverVersion: 'v2' | 'v3' = 'v3',
    deferredClientContext?: unknown,
    requireDeferredSettlementResumeAuthorization = false
  ): Promise<TaskResult<T>> {
    const status = this.responseParser.getStatus(response) as ADCPStatus;

    switch (status) {
      case ADCP_STATUS.COMPLETED:
        // Task completed immediately
        const completedData = this.extractResponseData(response, debugLogs, taskName, serverVersion);
        // Ordinary calls retain the historical behavior of publishing seller
        // completion before optional governance postflight work. A committed
        // compatibility mutation defers this until durable settlement.
        if (!deferTerminalTaskStatus) this.updateTaskStatus(taskId, 'completed', completedData);

        const operationSuccess = this.isOperationSuccess(completedData, taskName, serverVersion);

        // Validate response against AdCP schema - validate extracted data, not protocol wrapper
        const validationResult = this.validateResponseSchema(completedData, taskName, debugLogs, serverVersion);

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
          startTime,
          serverVersion
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
          deferTerminalTaskStatus,
          serverVersion
        );

      case ADCP_STATUS.INPUT_REQUIRED:
      case ADCP_STATUS.AUTH_REQUIRED:
        // Server needs caller action. Preserve the same server-side task so
        // handler-less HITL and credential-refresh flows can resume safely.
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
          deferTerminalTaskStatus,
          status,
          persistPausedContinuation,
          serverVersion,
          deferredClientContext,
          requireDeferredSettlementResumeAuthorization
        );

      case ADCP_STATUS.FAILED:
      case ADCP_STATUS.REJECTED:
      case ADCP_STATUS.CANCELED: {
        const failedData = this.extractResponseData(response, debugLogs, taskName, serverVersion);
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
        const defaultData = this.extractResponseData(response, debugLogs, taskName, serverVersion);
        if (
          defaultData &&
          (defaultData !== response || response.structuredContent || response.result || response.data)
        ) {
          const defaultSuccess = this.isOperationSuccess(defaultData, taskName, serverVersion);

          // Validate response against AdCP schema - validate extracted data, not protocol wrapper
          const defaultValidation = this.validateResponseSchema(defaultData, taskName, debugLogs, serverVersion);

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
  public extractResponseData(response: any, debugLogs?: any[], toolName?: string, serverVersion?: 'v2' | 'v3'): any {
    // MCP error responses (isError: true) flow through here — the response unwrapper
    // extracts structured data (adcp_error, context, ext) from structuredContent or text

    // Paused A2A tasks intentionally carry the AdCP pause arm on
    // `Task.status.message` rather than an artifact: artifacts represent
    // completed transport output, while input/auth-required leaves the A2A
    // task resumable. The general unwrapper rejects intermediate tasks, so
    // normalize this one standard location before artifact extraction.
    const a2aState = response?.result?.status?.state;
    if (a2aState === 'input-required' || a2aState === 'auth-required') {
      const statusParts = response?.result?.status?.message?.parts;
      const statusDataPart = (Array.isArray(statusParts) ? [...statusParts].reverse() : []).find(
        (part: unknown): part is { kind: 'data'; data: Record<string, unknown> } =>
          !!part &&
          typeof part === 'object' &&
          (part as { kind?: unknown }).kind === 'data' &&
          !!(part as { data?: unknown }).data &&
          typeof (part as { data?: unknown }).data === 'object' &&
          !Array.isArray((part as { data?: unknown }).data)
      );
      if (statusDataPart) {
        this.logDebug(debugLogs, 'info', 'Extracted A2A pause data from Task.status.message', { state: a2aState });
        return statusDataPart.data;
      }
    }

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
        responseAdcpVersion: this.effectiveResponseAdcpVersion(serverVersion),
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
  private isOperationSuccess(data: any, taskName?: string, serverVersion?: 'v2' | 'v3'): boolean {
    return isAdcpOperationSuccess(data, taskName, this.effectiveResponseAdcpVersion(serverVersion));
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
    startTime: number = Date.now(),
    serverVersion: 'v2' | 'v3' = 'v3'
  ): Promise<TaskResult<T>> {
    // Extract any data that came with the working response
    const partialData = this.extractResponseData(initialResponse, debugLogs, taskName, serverVersion);
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
    deferTerminalTaskStatus = false,
    serverVersion: 'v2' | 'v3' = 'v3'
  ): Promise<TaskResult<T>> {
    // Extract any data that came with the submitted response
    const partialData = this.extractResponseData(response, debugLogs, taskName, serverVersion);

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
    // metadata (`adcp_task_id` / `serverTaskId`). The A2A transport `Task.id`
    // is retained separately as `metadata.a2aTaskId`; it is never a
    // `tasks/get` work handle. `responseParser.getTaskId` walks the AdCP
    // handle shapes.
    //
    // When the seller violated the spec and didn't include a task handle
    // we fall back to the local UUID so the buyer at least gets a
    // non-undefined `taskId` field. The polling cycle won't be able to
    // locate the work in this state — log an advisory so operators
    // grepping debug logs can pinpoint the seller-side spec violation.
    const extractedServerTaskId = this.responseParser.getTaskId(response);
    const serverTaskId = extractedServerTaskId ?? taskId;
    const metadata = this.buildMetadata({
      taskId,
      taskName,
      agent,
      startTime,
      status: 'submitted',
      response,
    });
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
          'or A2A metadata.adcp_task_id.',
        timestamp: new Date().toISOString(),
        taskName,
        runnerTaskId: taskId,
      });
    }

    const submitted = this.createSubmittedContinuation<T>(
      agent,
      taskId,
      taskName,
      serverTaskId,
      webhookUrl,
      pollingTransport,
      metadata,
      deferTerminalTaskStatus,
      serverVersion
    );

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

  /** Build polling closures around one authoritative seller work handle. */
  private createSubmittedContinuation<T>(
    agent: AgentConfig,
    taskId: string,
    taskName: string,
    serverTaskId: string,
    webhookUrl: string | undefined,
    pollingTransport: import('../protocols').TransportOptions | undefined,
    metadata: TaskResultMetadata,
    deferTerminalTaskStatus: boolean,
    serverVersion: 'v2' | 'v3'
  ): SubmittedContinuation<T> {
    return {
      taskId: serverTaskId,
      webhookUrl,
      track: async (transport?: import('../protocols').TransportOptions) => {
        const transportSnapshot = snapshotTransportOptions(transport ?? pollingTransport ?? this.config.transport);
        const task = (
          await this.getTaskStatusWithRawResponse(
            agent,
            serverTaskId,
            transportSnapshot,
            undefined,
            taskName,
            serverVersion
          )
        ).task;
        if (!deferTerminalTaskStatus && ['completed', 'failed', 'rejected', 'canceled'].includes(task.status)) {
          this.updateTaskStatus(taskId, task.status as TaskStatus, task.result, task.error);
        }
        return task;
      },
      waitForCompletion: async (pollInterval = 60000, signal?: AbortSignal, requireExactTaskIdentity = false) => {
        void requireExactTaskIdentity;
        const completed = await this.pollTaskCompletion<T>(
          agent,
          serverTaskId,
          pollInterval,
          pollingTransport,
          signal,
          metadata.a2aTaskId,
          taskName,
          taskId,
          serverVersion
        );
        // `pollTaskCompletion` also returns nonresumable paused
        // input-required/auth-required states. Preserve that status so callers
        // can select an explicit application/protocol-specific recovery path;
        // only genuinely terminal statuses trigger delayed state eviction.
        if (!deferTerminalTaskStatus || !TERMINAL_TASK_STATUSES.has(completed.status as TaskStatus)) {
          this.updateTaskStatus(taskId, completed.status as TaskStatus, completed.data, completed.error);
        }
        return completed;
      },
    };
  }

  /**
   * A committed compatibility hook may replace resumable continuations with
   * wrappers that validate and durably persist their terminal result. Attach
   * local task publication only after those final wrappers return.
   */
  private attachSettledContinuationTaskStatus<T>(taskId: string, result: TaskResult<T>): TaskResult<T> {
    const publish = (
      status: TaskStatus,
      data?: unknown,
      error?: string,
      identity?: { serverTaskId?: string; taskType?: string }
    ) => {
      this.publishSettledTaskStatus(taskId, status, data, error, false, identity);
    };

    if (result.submitted) {
      const submitted = result.submitted;
      result.submitted = {
        ...submitted,
        track: async transport => {
          const task = await submitted.track(transport);
          publish(task.status as TaskStatus, task.result, task.error, {
            serverTaskId: task.taskId,
            taskType: task.taskType,
          });
          return task;
        },
        waitForCompletion: async (pollInterval, signal) => {
          const completion = this.attachSettledContinuationTaskStatus(
            taskId,
            await submitted.waitForCompletion(pollInterval, signal)
          );
          publish(completion.status as TaskStatus, completion.data, completion.error, {
            serverTaskId: completion.metadata.serverTaskId ?? submitted.taskId,
            taskType: completion.metadata.taskName,
          });
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
          if (!(DEFERRED_SETTLEMENT_ACK in completion)) {
            publish(completion.status as TaskStatus, completion.data, completion.error, {
              serverTaskId: completion.metadata.serverTaskId,
              taskType: completion.metadata.taskName,
            });
          }
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
    fromExternalObservation = false,
    identity: { serverTaskId?: string; taskType?: string } = {}
  ): void {
    if (!TERMINAL_TASK_STATUSES.has(status)) return;
    const task = this.activeTasks.get(taskId);
    if (!task) return;
    if (!fromExternalObservation) {
      if (identity.serverTaskId !== undefined && identity.taskType !== undefined) {
        const observation: ExternalTaskSettlementObservation = { status, result: data, ...identity };
        this.settledExternalTaskObservationKeys.set(taskId, {
          key: this.externalTaskObservationKey(observation),
          status,
          ...(error !== undefined && { error: error.slice(0, MAX_RETAINED_EXTERNAL_TASK_ERROR_CHARS) }),
        });
      }
      this.closeExternalTaskSettlement(
        taskId,
        new Error('The task settled through its direct response; a racing pushed result was not accepted.')
      );
    }
    if (task.status !== status) this.updateTaskStatus(taskId, status, data, error);
  }

  private rejectPendingExternalTaskObservations(taskId: string, _error: unknown): void {
    this.pendingExternalTaskObservations.delete(taskId);
  }

  private liveExternalTaskSettlementCount(): number {
    let count = 0;
    for (const taskId of this.deferredTerminalPublicationTaskIds) {
      if (!this.closedExternalTaskSettlementTaskIds.has(taskId)) count += 1;
    }
    return count;
  }

  private compactClosedExternalTaskSettlementFences(): void {
    while (
      this.deferredTerminalPublicationTaskIds.size + this.settlementCapacityReservations.size >=
      COMPACTED_TASK_STATE_LIMIT
    ) {
      const oldestClosed = [...this.deferredTerminalPublicationTaskIds].find(taskId =>
        this.closedExternalTaskSettlementTaskIds.has(taskId)
      );
      if (oldestClosed === undefined) return;
      // The durable registration/recovery layer remains the authoritative
      // fail-closed route after this bounded exact-retry cache is evicted.
      this.deferredTerminalPublicationTaskIds.delete(oldestClosed);
      this.closedExternalTaskSettlementTaskIds.delete(oldestClosed);
      this.settledExternalTaskObservationKeys.delete(oldestClosed);
      this.externalTaskSettlementExpiry.delete(oldestClosed);
      const timer = this.externalTaskSettlementTimers.get(oldestClosed);
      if (timer) clearTimeout(timer);
      this.externalTaskSettlementTimers.delete(oldestClosed);
    }
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
    const timer = this.externalTaskSettlementTimers.get(taskId);
    if (timer) clearTimeout(timer);
    this.externalTaskSettlementTimers.delete(taskId);
    this.rejectPendingExternalTaskObservations(
      taskId,
      new Error('The durable push-settlement retention window expired before the observation was accepted.')
    );
  }

  private retainExternalTaskSettlementState(taskId: string): void {
    const retentionMs = this.config.externalTaskSettlementRetentionMs ?? DEFAULT_EXTERNAL_TASK_SETTLEMENT_RETENTION_MS;
    const expiry = Date.now() + retentionMs;
    if ((this.externalTaskSettlementExpiry.get(taskId) ?? 0) >= expiry) return;
    const priorTimer = this.externalTaskSettlementTimers.get(taskId);
    if (priorTimer) clearTimeout(priorTimer);
    this.externalTaskSettlementExpiry.set(taskId, expiry);
    const expire = () => {
      if (this.externalTaskSettlementExpiry.get(taskId) !== expiry) return;
      const remaining = expiry - Date.now();
      if (remaining > 0) {
        const timer = setTimeout(expire, Math.min(remaining, MAX_TIMER_DELAY_MS));
        timer.unref?.();
        this.externalTaskSettlementTimers.set(taskId, timer);
        return;
      }
      this.externalTaskSettlementTimers.delete(taskId);
      this.clearExternalTaskSettlementState(taskId);
    };
    const timer = setTimeout(expire, Math.min(retentionMs, MAX_TIMER_DELAY_MS));
    timer.unref?.();
    this.externalTaskSettlementTimers.set(taskId, timer);
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
    for (const observation of pending) {
      // The HTTP delivery has already been acknowledged. Durable failure stays
      // fenced locally and is surfaced by subsequent reconciliation/retries.
      void this.settleExternalTaskStatus(taskId, handler, observation).catch(() => undefined);
    }
  }

  private externalTaskObservationKey(observation: ExternalTaskSettlementObservation): string {
    return createHmac('sha256', EXTERNAL_TASK_OBSERVATION_HMAC_KEY)
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
    deferTerminalTaskStatus = false,
    pauseStatus: 'input-required' | 'auth-required' = 'input-required',
    persistPausedContinuation = true,
    serverVersion: 'v2' | 'v3' = 'v3',
    deferredClientContext?: unknown,
    requireDeferredSettlementResumeAuthorization = false
  ): Promise<TaskResult<T>> {
    const inputRequest = this.responseParser.parseInputRequest(response);
    const serverContextId = this.responseParser.getContextId(response) ?? response.contextId;
    const a2aTaskId = this.responseParser.getA2AContinuationTaskId(response);
    const settlementServerTaskId = deferTerminalTaskStatus ? this.responseParser.getTaskId(response) : undefined;

    // MCP has no standard continuation after a returned pause. A2A can resume
    // only when the seller supplied an official task ID; without one, a same-
    // tool `{ input }` call would be a fresh mutation rather than an exact-task
    // continuation. In either case, return the nonresumable pause without
    // invoking a handler or inventing a continuation call.
    if (agent.protocol === 'mcp' || !a2aTaskId) {
      const partialData = this.extractResponseData(response, debugLogs, taskName, serverVersion);
      const metadata = this.buildMetadata({
        taskId,
        taskName,
        agent,
        startTime,
        status: pauseStatus,
        response,
        inputRequest,
      });
      this.compactIntermediateTaskState(taskId, pauseStatus);
      return {
        success: true,
        status: pauseStatus,
        data: partialData,
        metadata,
        conversation: messages,
        debug_logs: debugLogs,
      };
    }

    // If no handler is provided, return the pause as a valid intermediate
    // state so callers can collect input or refresh credentials themselves.
    if (!inputHandler) {
      // Extract any data that came with the response (some agents include partial results)
      const partialData = this.extractResponseData(response, debugLogs, taskName, serverVersion);
      const metadata = this.buildMetadata({
        taskId,
        taskName,
        agent,
        startTime,
        status: pauseStatus,
        response,
        inputRequest,
      });
      this.compactIntermediateTaskState(taskId, pauseStatus);

      // Preserve a safe same-process resume path for callers that choose to
      // collect HITL input themselves. This continues the existing seller task
      // and never replays the original mutation as a fresh dispatch.
      const token = randomUUID();
      const deferredStorage = this.config.deferredStorage;
      const usesDurableStorage = deferredStorage !== undefined && persistPausedContinuation;
      if (usesDurableStorage) {
        const createdAt = Date.now();
        const ttlSeconds = this.config.deferredTaskTtlSeconds ?? DEFAULT_DEFERRED_TASK_TTL_SECONDS;
        const continuationVersion = randomUUID();
        this.deferredAgents.set(agent.id, agent);
        const deferredState: DeferredTaskState = {
          continuationVersion,
          taskId,
          ...(serverContextId !== undefined && { contextId: serverContextId }),
          a2aTaskId,
          serverVersion,
          agentId: agent.id,
          taskName,
          params: durableDeferredSnapshot(params),
          messages: durableDeferredSnapshot(messages),
          pauseStatus,
          pauseQuestion: inputRequest.question,
          ...(deferredClientContext !== undefined && {
            clientContext: durableDeferredSnapshot(deferredClientContext),
          }),
          ...(deferTerminalTaskStatus && {
            settlementOperationId: taskId,
            settlementOperationRouteRequired: true as const,
          }),
          ...(deferTerminalTaskStatus &&
            requireDeferredSettlementResumeAuthorization && {
              settlementResumeAuthorizationRequired: true,
            }),
          ...(settlementServerTaskId !== undefined && { settlementServerTaskId }),
          createdAt,
          expiresAt: createdAt + ttlSeconds * 1000,
        };
        if (deferTerminalTaskStatus) this.requireDeferredSettlementOperationRouting(deferredStorage);
        const stored = deferTerminalTaskStatus
          ? await deferredStorage.putForSettlementOperationIfAbsent(taskId, token, deferredState, ttlSeconds)
          : await deferredStorage.putIfAbsent(token, deferredState, ttlSeconds);
        if (!stored) {
          throw new Error('Deferred continuation token already exists; refusing to replace another task.');
        }
        try {
          throwIfAborted(options.signal);
        } catch (error) {
          await deferredStorage.takeIfVersion(token, continuationVersion);
          throw error;
        }
      }
      let inProcessResumeConsumed = false;
      const resumeInProcess = async (input: unknown): Promise<TaskResult<T>> => {
        const inputSnapshot = structuredClone(input);
        if (inProcessResumeConsumed) throw new Error('Deferred continuation token has already been consumed.');
        inProcessResumeConsumed = true;
        return this.continueTaskWithInput<T>(
          agent,
          taskId,
          taskName,
          params,
          serverContextId,
          a2aTaskId,
          inputSnapshot,
          messages,
          undefined,
          options,
          debugLogs,
          startTime,
          deferTerminalTaskStatus,
          persistPausedContinuation,
          serverVersion,
          deferredClientContext,
          requireDeferredSettlementResumeAuthorization
        );
      };
      const deferred: DeferredContinuation<T> = {
        token,
        question: inputRequest.question,
        resume: usesDurableStorage
          ? input => this.resumeDeferredTaskFromLiveClosure<T>(token, input, !deferTerminalTaskStatus)
          : resumeInProcess,
      };

      return {
        success: true, // The task is progressing, not failed
        status: pauseStatus,
        data: partialData,
        deferred,
        metadata,
        conversation: messages,
        debug_logs: debugLogs,
      };
    }

    const discussedField = (content: unknown): string | undefined => {
      if (content == null || typeof content !== 'object' || Array.isArray(content)) return undefined;
      const direct = (content as Record<string, unknown>).field;
      if (typeof direct === 'string') return direct;
      return this.responseParser.isInputRequest(content)
        ? this.responseParser.parseInputRequest(content).field
        : undefined;
    };

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
        messages.some(m => m.role === 'agent' && discussedField(m.content) === field),
      getPreviousResponse: field => {
        // Find the agent message that requested this field
        const fieldRequestIndex = messages.findIndex(m => m.role === 'agent' && discussedField(m.content) === field);
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
      const deferredStorage = this.config.deferredStorage;
      const usesDurableStorage = deferredStorage !== undefined && persistPausedContinuation;

      // Save deferred state for later resumption
      if (usesDurableStorage) {
        assertDeferredContinuationToken(token);
        const createdAt = Date.now();
        const ttlSeconds = this.config.deferredTaskTtlSeconds ?? DEFAULT_DEFERRED_TASK_TTL_SECONDS;
        const continuationVersion = randomUUID();
        this.deferredAgents.set(agent.id, agent);
        const deferredState: DeferredTaskState = {
          continuationVersion,
          taskId,
          ...(serverContextId !== undefined && { contextId: serverContextId }),
          a2aTaskId,
          serverVersion,
          agentId: agent.id,
          taskName,
          params: durableDeferredSnapshot(params),
          messages: durableDeferredSnapshot(messages),
          pauseStatus: 'deferred',
          pauseQuestion: inputRequest.question,
          ...(deferredClientContext !== undefined && {
            clientContext: durableDeferredSnapshot(deferredClientContext),
          }),
          ...(deferTerminalTaskStatus && {
            settlementOperationId: taskId,
            settlementOperationRouteRequired: true as const,
          }),
          ...(deferTerminalTaskStatus &&
            requireDeferredSettlementResumeAuthorization && {
              settlementResumeAuthorizationRequired: true,
            }),
          ...(settlementServerTaskId !== undefined && { settlementServerTaskId }),
          createdAt,
          expiresAt: createdAt + ttlSeconds * 1000,
        };
        if (deferTerminalTaskStatus) this.requireDeferredSettlementOperationRouting(deferredStorage);
        const stored = deferTerminalTaskStatus
          ? await deferredStorage.putForSettlementOperationIfAbsent(taskId, token, deferredState, ttlSeconds)
          : await deferredStorage.putIfAbsent(token, deferredState, ttlSeconds);
        if (!stored) {
          throw new Error('Deferred continuation token already exists; refusing to replace another task.');
        }
        try {
          throwIfAborted(options.signal);
        } catch (error) {
          // Cancellation may race a storage adapter that ignores the signal.
          // Remove only the exact generation just written. A concurrent resume
          // may already have claimed and advanced a newer generation.
          await deferredStorage.takeIfVersion(token, continuationVersion);
          throw error;
        }
      }
      // Deferred storage is the resume source of truth. Avoid retaining a
      // duplicate full request (including assets/credentials) in activeTasks.
      this.compactIntermediateTaskState(taskId, 'deferred');

      let inProcessResumeConsumed = false;
      const resumeInProcess = async (input: unknown): Promise<TaskResult<T>> => {
        const inputSnapshot = structuredClone(input);
        if (inProcessResumeConsumed) throw new Error('Deferred continuation token has already been consumed.');
        inProcessResumeConsumed = true;
        return this.continueTaskWithInput<T>(
          agent,
          taskId,
          taskName,
          params,
          serverContextId,
          a2aTaskId,
          inputSnapshot,
          messages,
          undefined,
          options,
          debugLogs,
          startTime,
          deferTerminalTaskStatus,
          persistPausedContinuation,
          serverVersion,
          deferredClientContext,
          requireDeferredSettlementResumeAuthorization
        );
      };
      const deferred: DeferredContinuation<T> = {
        token,
        question: inputRequest.question,
        resume: usesDurableStorage
          ? input => this.resumeDeferredTaskFromLiveClosure<T>(token, input, !deferTerminalTaskStatus)
          : resumeInProcess,
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
      serverContextId,
      a2aTaskId,
      handlerResponse,
      messages,
      inputHandler, // Pass handler for multi-round clarification
      options,
      debugLogs,
      startTime,
      deferTerminalTaskStatus,
      persistPausedContinuation,
      serverVersion,
      deferredClientContext,
      requireDeferredSettlementResumeAuthorization
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
    const transportSnapshot = snapshotTransportOptions(transport ?? this.config.transport);
    try {
      return await this.listTasksForAgent(agent, transportSnapshot);
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
    signal?: AbortSignal,
    expectedTaskType?: string,
    serverVersion?: 'v2' | 'v3'
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
        serverVersion: serverVersion ?? this.lastKnownServerVersion,
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
    const task = mapTasksGetResponseToTaskInfo(response);
    if (!task.taskId || task.taskId !== taskId) {
      throw new TaskBindingMismatchError(
        'tasks/get returned a task identity that does not match the requested task.',
        response
      );
    }
    if (expectedTaskType !== undefined && task.taskType !== expectedTaskType) {
      throw new TaskBindingMismatchError(
        'tasks/get returned a task type that does not match the submitted operation.',
        response
      );
    }
    return { task, rawResponse: response };
  }

  async getTaskStatus(
    agent: AgentConfig,
    taskId: string,
    transport?: import('../protocols').TransportOptions,
    signal?: AbortSignal
  ): Promise<TaskInfo> {
    const transportSnapshot = snapshotTransportOptions(transport ?? this.config.transport);
    return (await this.getTaskStatusWithRawResponse(agent, taskId, transportSnapshot, signal)).task;
  }

  async pollTaskCompletion<T>(
    agent: AgentConfig,
    taskId: string,
    pollInterval = 60000,
    transport?: import('../protocols').TransportOptions,
    signal?: AbortSignal,
    a2aCancellationTaskId?: string,
    expectedTaskType?: string,
    metadataTaskId = taskId,
    serverVersion?: 'v2' | 'v3'
  ): Promise<TaskResult<T>> {
    // Transport policy is a request trust boundary. Own one shallow snapshot
    // for the entire polling lifetime so caller mutation cannot substitute a
    // fetch implementation or private-address policy between polls/cancel.
    const transportSnapshot = snapshotTransportOptions(transport ?? this.config.transport);
    if (!Number.isFinite(pollInterval) || pollInterval < 0 || pollInterval > MAX_TIMER_DELAY_MS) {
      throw new RangeError(`pollInterval must be a finite non-negative number <= ${MAX_TIMER_DELAY_MS}`);
    }
    const pollStartTime = Date.now();
    const withServerTaskId = (metadata: TaskResultMetadata): TaskResultMetadata => ({
      ...metadata,
      serverTaskId: taskId,
    });
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
        if (agent.protocol === 'a2a' && a2aCancellationTaskId && agent.agent_uri) {
          try {
            // adcp-client#1617 Phase 2: pass the full agent so cancelA2ATask
            // can sign the POST when agent.request_signing is configured.
            // signed-requests sellers no longer 401 the cancel.
            const cancelTransport = normalizeTransportOptions(transportSnapshot);
            void cancelA2ATask(
              agent,
              a2aCancellationTaskId,
              cancelTransport?.trustedFetchFn,
              cancelTransport?.allowPrivateIp
            ).catch(() => {
              /* see SECURITY note above */
            });
          } catch {
            /* see SECURITY note above */
          }
        }
        return attachMatch({
          success: false as const,
          status: 'failed' as const,
          error: `tasks/get polling was cancelled before a terminal state was observed: ${reason}`,
          metadata: withServerTaskId(
            this.buildMetadata({
              taskId: metadataTaskId,
              taskName: 'unknown',
              agent,
              startTime: pollStartTime,
              status: 'failed',
            })
          ),
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
        const pollResult = await this.getTaskStatusWithRawResponse(
          agent,
          taskId,
          transportSnapshot,
          signal,
          expectedTaskType,
          serverVersion
        );
        status = pollResult.task;
        rawResponse = pollResult.rawResponse;
      } catch (err) {
        if (err instanceof TaskBindingMismatchError) {
          return attachMatch({
            success: false as const,
            status: 'failed' as const,
            error: err.message,
            metadata: withServerTaskId(
              this.buildMetadata({
                taskId: metadataTaskId,
                taskName: 'unknown',
                agent,
                startTime: pollStartTime,
                status: 'failed',
                response: err.rawResponse,
              })
            ),
          });
        }
        const msg = err instanceof Error ? err.message : String(err);
        // Bounded `\S{1,128}` task-id segment (no `.*`) keeps the match
        // linear-time on adversarial inputs — CodeQL flags unbounded
        // polynomial regex on uncontrolled error strings.
        if (/\btask\s+\S{1,128}\s+not found\b/i.test(msg)) {
          return attachMatch({
            success: false as const,
            status: 'failed' as const,
            error: `Task ${taskId} is no longer queryable — it may have been completed and evicted by the seller before this poll arrived. Consider using push notifications (reporting_webhook) instead of polling, or configuring a longer task retention TTL on the seller.`,
            metadata: withServerTaskId(
              this.buildMetadata({
                taskId: metadataTaskId,
                taskName: 'unknown',
                agent,
                startTime: pollStartTime,
                status: 'failed',
              })
            ),
          });
        }
        throw err;
      }

      if (expectedTaskType !== undefined && (status.taskId !== taskId || status.taskType !== expectedTaskType)) {
        return attachMatch({
          success: false as const,
          status: 'failed' as const,
          error: 'The seller returned a task outside the requested durable task identity.',
          metadata: this.buildMetadata({
            taskId,
            taskName: 'unknown',
            agent,
            startTime: pollStartTime,
            status: 'failed',
          }),
        });
      }

      if (status.status === ADCP_STATUS.COMPLETED) {
        const pollSuccess = this.isOperationSuccess(status.result, status.taskType, serverVersion);

        if (pollSuccess) {
          return markAuthoritativePolledTerminal(
            attachMatch({
              success: true as const,
              status: 'completed' as const,
              data: status.result,
              metadata: withServerTaskId(
                this.buildMetadata({
                  taskId: metadataTaskId,
                  taskName: status.taskType,
                  agent,
                  responseTimeMs: Date.now() - status.createdAt,
                  status: 'completed',
                  response: rawResponse,
                })
              ),
            })
          );
        }
        const asyncResultErr = extractAdcpErrorInfo(status.result);
        return markAuthoritativePolledTerminal(
          attachMatch({
            success: false as const,
            status: 'failed' as const,
            data: status.result,
            error: this.extractOperationError(status.result),
            adcpError: asyncResultErr,
            errorInstance: this.buildErrorInstance(metadataTaskId, asyncResultErr),
            correlationId: extractCorrelationId(status.result),
            metadata: withServerTaskId(
              this.buildMetadata({
                taskId: metadataTaskId,
                taskName: status.taskType,
                agent,
                responseTimeMs: Date.now() - status.createdAt,
                status: 'failed',
                response: rawResponse,
              })
            ),
          })
        );
      }

      if (
        status.status === ADCP_STATUS.FAILED ||
        status.status === ADCP_STATUS.CANCELED ||
        status.status === ADCP_STATUS.REJECTED
      ) {
        const asyncFailedErr = extractAdcpErrorInfo(status.result);
        return markAuthoritativePolledTerminal(
          attachMatch({
            success: false as const,
            status: 'failed' as const,
            data: status.result,
            error: status.error || status.message || `Task ${status.status}`,
            adcpError: asyncFailedErr,
            errorInstance: this.buildErrorInstance(metadataTaskId, asyncFailedErr),
            correlationId: extractCorrelationId(status.result),
            metadata: withServerTaskId(
              this.buildMetadata({
                taskId: metadataTaskId,
                taskName: status.taskType,
                agent,
                responseTimeMs: Date.now() - status.createdAt,
                status: 'failed',
                response: rawResponse,
              })
            ),
          })
        );
      }

      // Paused states: `input-required` and `auth-required`. Polling
      // alone can't advance these. Return a `TaskResultIntermediate` so the
      // caller can branch on `result.status` and select an explicit
      // application/protocol-specific recovery path; this mirrors the
      // synchronous `handleInputRequired` no-handler path
      // (`success: true` because the task is progressing, not failed).
      // Without this branch the loop would spin until timeout — the
      // paused-state regression class flagged by adcp-client#977.
      if (status.status === ADCP_STATUS.INPUT_REQUIRED || status.status === ADCP_STATUS.AUTH_REQUIRED) {
        return attachMatch({
          success: true as const,
          status: status.status,
          data: status.result as T,
          metadata: withServerTaskId(
            this.buildMetadata({
              taskId: metadataTaskId,
              taskName: status.taskType,
              agent,
              responseTimeMs: Date.now() - status.createdAt,
              status: status.status,
              response: rawResponse,
            })
          ),
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
          metadata: withServerTaskId(
            this.buildMetadata({
              taskId: metadataTaskId,
              taskName: 'unknown',
              agent,
              startTime: pollStartTime,
              status: 'failed',
              response: rawResponse,
            })
          ),
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
    const result = (await this.resumeDeferredTaskWithContext<T>(token, input, publishTerminalTaskStatus)).result;
    await acknowledgeDeferredSettlement(result);
    return result;
  }

  /** Whether this exact continuation currently has a durable SDK checkpoint. @internal */
  async hasDurablyStoredDeferredTask(token: string): Promise<boolean> {
    if (!this.config.deferredStorage) return false;
    assertDeferredContinuationToken(token);
    return (await this.config.deferredStorage.has(token)) === true;
  }

  private requireDeferredSettlementOperationRouting(storage: DeferredTaskStorage): void {
    if (
      typeof storage.putForSettlementOperationIfAbsent !== 'function' ||
      typeof storage.getBySettlementOperationId !== 'function' ||
      typeof storage.replaceForSettlementOperationIfVersion !== 'function'
    ) {
      throw new ConfigurationError(
        'Committed deferred settlement requires atomic operation routing so paused mutations remain discoverable across crashes. ' +
          'Use MemoryStorage or implement the DeferredTaskStorage operation-route contract.'
      );
    }
  }

  private async loadDeferredSettlementOperationRoute(
    storage: DeferredTaskStorage,
    operationId: string
  ): Promise<{ token: string; state: DeferredTaskState } | undefined> {
    try {
      return await storage.getBySettlementOperationId(operationId);
    } catch (error) {
      throw new DeferredSettlementOwnershipError(
        'Committed continuation operation routing could not be loaded safely.',
        { cause: error }
      );
    }
  }

  private replaceDeferredState(
    storage: DeferredTaskStorage,
    token: string,
    expectedVersion: string,
    state: DeferredTaskState,
    ttlSeconds: number
  ): Promise<boolean> {
    if (state.settlementOperationId === undefined || state.settlementOperationRouteRequired !== true) {
      return storage.replaceIfVersion(token, expectedVersion, state, ttlSeconds);
    }
    this.requireDeferredSettlementOperationRouting(storage);
    return storage.replaceForSettlementOperationIfVersion(
      state.settlementOperationId,
      token,
      expectedVersion,
      token,
      state,
      ttlSeconds
    );
  }

  /** Recover the current pause generation through its committed operation route. @internal */
  async recoverDeferredTaskForOperation<T>(
    operationId: string,
    recoveryKey: string,
    publishTerminalTaskStatus = true
  ): Promise<{ token: string; result: TaskResult<T> } | undefined> {
    const storage = this.config.deferredStorage;
    if (!storage) return undefined;
    this.requireDeferredSettlementOperationRouting(storage);
    let authorized = false;
    try {
      authorized =
        (await this.config.authorizeDeferredSettlementOperationRecovery?.(
          operationId,
          recoveryKey,
          'pause-recovery'
        )) === true;
    } catch (error) {
      throw new DeferredSettlementOwnershipError(
        'Committed continuation operation recovery could not be authorized safely.',
        { cause: error }
      );
    }
    if (!authorized) {
      throw new DeferredSettlementOwnershipError('Committed continuation operation recovery is not authorized.');
    }
    const routed = await this.loadDeferredSettlementOperationRoute(storage, operationId);
    if (!routed) return undefined;
    return this.recoverRoutedDeferredTask<T>(operationId, routed, publishTerminalTaskStatus);
  }

  private async recoverRoutedDeferredTask<T>(
    operationId: string,
    routed: { token: string; state: DeferredTaskState },
    publishTerminalTaskStatus: boolean
  ): Promise<{ token: string; result: TaskResult<T> } | undefined> {
    const { token, state } = routed;
    if (
      state.settlementOperationId !== operationId ||
      state.settlementOperationRouteRequired !== true ||
      state.expiresAt <= Date.now()
    ) {
      return undefined;
    }

    // Terminal/pending checkpoints already have exact replay logic and never
    // consume the supplied input before reaching it.
    if (
      state.settlementFinalizedResult !== undefined ||
      state.settlementTerminalResult !== undefined ||
      state.settlementPendingTaskId !== undefined
    ) {
      return {
        token,
        result: (await this.resumeDeferredTaskCore<T>(token, undefined, publishTerminalTaskStatus, false)).result,
      };
    }
    if (state.continuationClaimed) {
      return undefined;
    }
    if (!state.pauseStatus || !state.pauseQuestion) {
      throw new DeferredSettlementOwnershipError(
        'The current committed continuation is missing its durable pause descriptor.'
      );
    }
    const agent = this.deferredAgents.get(state.agentId) ?? (await this.config.resolveDeferredAgent?.(state.agentId));
    if (!agent || agent.id !== state.agentId || agent.protocol !== 'a2a') {
      throw new DeferredSettlementOwnershipError(
        'The trusted agent for the current committed continuation could not be resolved safely.'
      );
    }
    this.deferredAgents.set(agent.id, agent);
    const status = state.pauseStatus;
    const result = attachMatch({
      success: true,
      status,
      deferred: {
        token,
        question: state.pauseQuestion,
        resume: (input: unknown) =>
          this.resumeDeferredTaskFromClientClosure<T>(token, input, publishTerminalTaskStatus),
      },
      metadata: {
        taskId: state.taskId,
        taskName: state.taskName,
        agent: { id: agent.id, name: agent.name, protocol: agent.protocol },
        responseTimeMs: 0,
        timestamp: new Date().toISOString(),
        clarificationRounds: 0,
        status,
        a2aTaskId: state.a2aTaskId,
        ...(state.contextId !== undefined && { contextId: state.contextId }),
        ...(state.settlementServerTaskId !== undefined && { serverTaskId: state.settlementServerTaskId }),
      },
      conversation: durableDeferredSnapshot(state.messages),
    } as TaskResult<T>);
    return { token, result };
  }

  /** Bridge a store-recovered callback into the same deferred terminal checkpoint. @internal */
  async checkpointExternalDeferredSettlement<T>(
    token: string,
    operationId: string,
    terminalResult: TaskResult<T>
  ): Promise<TaskResult<T> | undefined> {
    assertDeferredContinuationToken(token);
    const storage = this.config.deferredStorage;
    if (!storage) throw new Error('Deferred storage is unavailable for the linked callback checkpoint.');
    let state: DeferredTaskState | undefined;
    try {
      state = await storage.get(token);
    } catch (error) {
      throw new DeferredSettlementOwnershipError('Deferred callback checkpoint state could not be loaded safely.', {
        cause: error,
      });
    }
    if (!state) throw new Error('The linked deferred callback checkpoint is unavailable.');
    if (state.settlementOperationId !== operationId) {
      throw new Error('The deferred callback token is bound to a different committed operation.');
    }
    if (state.settlementOperationRouteRequired === true) {
      this.requireDeferredSettlementOperationRouting(storage);
      const currentRoute = await this.loadDeferredSettlementOperationRoute(storage, operationId);
      if (!currentRoute || currentRoute.token !== token) {
        throw new DeferredSettlementOwnershipError(
          'The deferred callback token is not the current generation for its committed operation.'
        );
      }
    }
    const trustedServerTaskId = trustedDeferredServerTaskId(state);
    const normalizedTerminal = normalizeDeferredTerminalServerTaskId(terminalResult, trustedServerTaskId);
    const normalizedSavedTerminal =
      state.settlementTerminalResult === undefined
        ? undefined
        : normalizeDeferredTerminalServerTaskId(
            state.settlementTerminalResult as TaskResult<unknown>,
            trustedServerTaskId
          ).result;
    if (state.settlementFinalizedResult !== undefined) {
      if (
        normalizedSavedTerminal === undefined ||
        normalizedTerminal.serverTaskId === undefined ||
        normalizedTerminal.serverTaskId !== trustedServerTaskId ||
        !sameDeferredTerminal(normalizedSavedTerminal, normalizedTerminal.result)
      ) {
        throw new Error('The durable callback conflicts with the finalized deferred settlement.');
      }
      return undefined;
    }

    let lease: DeferredFinalizationLease;
    if (normalizedSavedTerminal !== undefined) {
      if (
        normalizedTerminal.serverTaskId === undefined ||
        normalizedTerminal.serverTaskId !== trustedServerTaskId ||
        !sameDeferredTerminal(normalizedSavedTerminal, normalizedTerminal.result)
      ) {
        throw new Error('The durable callback conflicts with the saved deferred terminal observation.');
      }
      lease = await this.acquireDeferredFinalizationLease(token, state);
    } else {
      const expectedTaskId = trustedServerTaskId;
      const observedTaskId = normalizedTerminal.serverTaskId;
      if (!expectedTaskId || !observedTaskId || observedTaskId !== expectedTaskId) {
        throw new Error('The durable callback task identity does not match the linked deferred seller task.');
      }
      const acquired = await this.checkpointDeferredPendingTerminal(token, state, normalizedTerminal.result, true);
      if (!acquired) throw new Error('Committed deferred callback finalization lease was not acquired.');
      lease = acquired;
    }

    return this.attachDeferredSettlementAcknowledgement(
      normalizedTerminal.result,
      state.taskId,
      true,
      undefined,
      finalized => lease.finalize(finalized),
      () => lease.release()
    );
  }

  /** Resolve and checkpoint the current generation using a separate owner capability. @internal */
  async checkpointExternalDeferredSettlementForOperation<T>(
    operationId: string,
    recoveryKey: string,
    terminalResult: TaskResult<T>
  ): Promise<{ token: string; result?: TaskResult<T> } | undefined> {
    const storage = this.config.deferredStorage;
    if (!storage) return undefined;
    this.requireDeferredSettlementOperationRouting(storage);
    let authorized = false;
    try {
      authorized =
        (await this.config.authorizeDeferredSettlementOperationRecovery?.(
          operationId,
          recoveryKey,
          'callback-checkpoint'
        )) === true;
    } catch (error) {
      throw new DeferredSettlementOwnershipError(
        'Committed callback operation recovery could not be authorized safely.',
        { cause: error }
      );
    }
    if (!authorized) {
      throw new DeferredSettlementOwnershipError('Committed callback operation recovery is not authorized.');
    }
    const currentRoute = await this.loadDeferredSettlementOperationRoute(storage, operationId);
    if (!currentRoute) return undefined;
    if (currentRoute.state.settlementOperationRouteRequired !== true) {
      throw new DeferredSettlementOwnershipError('The callback operation route is not a current-format checkpoint.');
    }
    const result = await this.checkpointExternalDeferredSettlement(currentRoute.token, operationId, terminalResult);
    return { token: currentRoute.token, ...(result !== undefined && { result }) };
  }

  /** A live owner closure may carry its committed settlement wrapper in process. */
  private async resumeDeferredTaskFromLiveClosure<T>(
    token: string,
    input: any,
    publishTerminalTaskStatus: boolean
  ): Promise<TaskResult<T>> {
    return (await this.resumeDeferredTaskCore<T>(token, input, publishTerminalTaskStatus, true)).result;
  }

  /** Preserve higher-level client finalization before settlement acknowledgement. */
  private async resumeDeferredTaskFromClientClosure<T>(
    token: string,
    input: any,
    publishTerminalTaskStatus: boolean
  ): Promise<TaskResult<T>> {
    return (await this.resumeDeferredTaskCore<T>(token, input, publishTerminalTaskStatus, false)).result;
  }

  /** Resume and return the opaque owner context needed by higher-level clients. @internal */
  async resumeDeferredTaskWithContext<T>(
    token: string,
    input: any,
    publishTerminalTaskStatus = true
  ): Promise<{
    result: TaskResult<T>;
    clientContext?: unknown;
    settlementOperationId?: string;
    settlementServerTaskId?: string;
  }> {
    return this.resumeDeferredTaskCore<T>(token, input, publishTerminalTaskStatus, false);
  }

  private async resumeDeferredTaskCore<T>(
    token: string,
    input: any,
    publishTerminalTaskStatus: boolean,
    liveSettlementOwner: boolean
  ): Promise<{
    result: TaskResult<T>;
    clientContext?: unknown;
    settlementOperationId?: string;
    settlementServerTaskId?: string;
  }> {
    // Caller-owned nested input must not remain live across the storage or
    // trusted-agent resolution awaits below.
    const inputSnapshot = structuredClone(input);
    assertDeferredContinuationToken(token);
    if (!this.config.deferredStorage) {
      throw new Error('Deferred storage not configured');
    }

    // Read first, then atomically transition the exact record generation to a
    // claimed fence below. The key is never physically absent during seller
    // dispatch, so neither a replica nor a reused handler token can create an
    // ABA replacement while settlement is pending.
    let state: DeferredTaskState | undefined;
    try {
      state = await this.config.deferredStorage.get(token);
    } catch (error) {
      throw new DeferredSettlementOwnershipError('Deferred continuation state could not be loaded safely.', {
        cause: error,
      });
    }
    if (!state) {
      throw new Error('Deferred task not found.');
    }
    if (state.expiresAt <= Date.now()) {
      throw new Error('Deferred task expired.');
    }

    const committedOperationId = state.settlementOperationId;
    const requiresSettlement = committedOperationId !== undefined;
    const requiresRecoveredSettlement = requiresSettlement && !liveSettlementOwner;
    if (requiresSettlement && state.settlementOperationRouteRequired === true) {
      this.requireDeferredSettlementOperationRouting(this.config.deferredStorage);
    }
    // Once durable settlement and public-client finalization both succeeded,
    // replay the exact finalized value without re-running application handlers
    // or settlement recovery.
    if (requiresSettlement && state.settlementFinalizedResult !== undefined) {
      const normalizedFinalized = normalizeDeferredTerminalServerTaskId(
        structuredClone(state.settlementFinalizedResult) as TaskResult<T>,
        trustedDeferredServerTaskId(state)
      );
      if (normalizedFinalized.serverTaskId === undefined) {
        throw new Error('The finalized deferred settlement does not contain its trusted seller task identity.');
      }
      const finalized = attachMatch(normalizedFinalized.result);
      if (state.settlementCompletionHandlerPublished === true) {
        markCompletionHandlerAlreadyPublished(finalized);
      }
      return {
        result: finalized,
        settlementOperationId: committedOperationId,
        ...(state.settlementServerTaskId !== undefined && {
          settlementServerTaskId: state.settlementServerTaskId,
        }),
      };
    }
    if (requiresRecoveredSettlement) {
      let recoveryAvailable = false;
      try {
        recoveryAvailable =
          this.config.recoverDeferredSettlement !== undefined &&
          this.config.canRecoverDeferredSettlement !== undefined &&
          (await this.config.canRecoverDeferredSettlement(committedOperationId));
      } catch (error) {
        throw error;
      }
      if (!recoveryAvailable) {
        throw new Error(
          'This deferred task crossed a committed mutation boundary, but durable settlement recovery is unavailable.'
        );
      }
    }

    // A crash may occur after the seller consumed input for A and the atomic
    // SDK operation route moved to pause B, but before the coordinator CAS or
    // caller response completed. Possession of A plus the matching committed
    // operation is sufficient to recover B; never redispatch A's input.
    if (requiresSettlement && state.settlementOperationRouteRequired === true) {
      const currentRoute = await this.loadDeferredSettlementOperationRoute(
        this.config.deferredStorage,
        committedOperationId
      );
      if (currentRoute && currentRoute.token !== token) {
        if (currentRoute.state.settlementOperationId !== committedOperationId) {
          throw new DeferredSettlementOwnershipError(
            'The committed continuation operation route does not match its stored generation.'
          );
        }
        if (state.settlementResumeAuthorizationRequired === true) {
          let replacementAuthorized =
            (await this.config.authorizeDeferredSettlementResume?.(committedOperationId, currentRoute.token)) === true;
          if (!replacementAuthorized) {
            const replaced = await this.config.replaceDeferredSettlementResumeToken?.(
              committedOperationId,
              token,
              currentRoute.token
            );
            replacementAuthorized =
              replaced === true ||
              (await this.config.authorizeDeferredSettlementResume?.(committedOperationId, currentRoute.token)) ===
                true;
          }
          if (!replacementAuthorized) {
            throw new DeferredSettlementOwnershipError(
              'The recovered continuation generation could not be linked to its durable coordinator.'
            );
          }
        }
        const recovered = await this.recoverRoutedDeferredTask<T>(
          committedOperationId,
          currentRoute,
          publishTerminalTaskStatus
        );
        if (!recovered || recovered.token !== currentRoute.token) {
          throw new DeferredSettlementOwnershipError(
            'The recovered continuation generation changed before it could be returned safely.'
          );
        }
        return {
          result: recovered.result,
          ...(currentRoute.state.clientContext !== undefined && {
            clientContext: structuredClone(currentRoute.state.clientContext),
          }),
          settlementOperationId: committedOperationId,
          ...(currentRoute.state.settlementServerTaskId !== undefined && {
            settlementServerTaskId: currentRoute.state.settlementServerTaskId,
          }),
        };
      }
    }

    // A previous committed resume advanced the seller into working/submitted
    // state. Reconstruct polling from the durable seller work handle instead
    // of redispatching the human input after a process restart.
    if (requiresSettlement && state.settlementPendingTaskId !== undefined) {
      let pendingAgent = this.deferredAgents.get(state.agentId);
      if (!pendingAgent) {
        try {
          pendingAgent = await this.config.resolveDeferredAgent?.(state.agentId);
        } catch (error) {
          throw new DeferredSettlementOwnershipError(
            'The trusted agent for a pending deferred settlement could not be resolved safely.',
            { cause: error }
          );
        }
      }
      if (!pendingAgent || pendingAgent.id !== state.agentId) {
        throw new Error('Deferred task agent could not be resolved from trusted configuration.');
      }
      if (pendingAgent.protocol !== 'a2a' || !state.a2aTaskId) {
        throw new Error('A persisted pending deferred task can only poll its exact A2A seller task.');
      }
      this.deferredAgents.set(pendingAgent.id, pendingAgent);
      const pending = await this.setupSubmittedTask<T>(
        pendingAgent,
        state.taskId,
        state.taskName,
        {
          status: ADCP_STATUS.SUBMITTED,
          task_id: state.settlementPendingTaskId,
        },
        state.messages,
        {},
        [],
        Date.now(),
        true,
        state.serverVersion
      );
      const recoveredPending = this.wrapDeferredPendingSettlementContinuations(
        token,
        state,
        pending,
        publishTerminalTaskStatus,
        true
      );
      return {
        result: attachMatch(recoveredPending),
        ...(state.clientContext !== undefined && { clientContext: structuredClone(state.clientContext) }),
        settlementOperationId: committedOperationId,
        settlementServerTaskId: state.settlementPendingTaskId,
      };
    }

    // A prior seller continuation reached a terminal result but recovery did
    // not finish. Retry the saved observation without contacting the seller.
    if (requiresSettlement && state.settlementTerminalResult !== undefined) {
      const finalizationLease = await this.acquireDeferredFinalizationLease(token, state);
      try {
        const normalizedCheckpoint = normalizeDeferredTerminalServerTaskId(
          structuredClone(state.settlementTerminalResult) as TaskResult<T>,
          trustedDeferredServerTaskId(state)
        );
        if (normalizedCheckpoint.serverTaskId === undefined) {
          throw new Error('The deferred terminal checkpoint does not contain its trusted seller task identity.');
        }
        const checkpointed = attachMatch(normalizedCheckpoint.result);
        const settlement = requiresRecoveredSettlement
          ? await this.config.recoverDeferredSettlement!(
              checkpointed,
              committedOperationId,
              normalizedCheckpoint.serverTaskId
            )
          : { result: checkpointed };
        const recovered = this.attachDeferredSettlementAcknowledgement(
          settlement.result as TaskResult<T>,
          state.taskId,
          publishTerminalTaskStatus,
          settlement.afterFinalize,
          finalized => finalizationLease.finalize(finalized),
          completionHandlerPublished => finalizationLease.release(completionHandlerPublished)
        );
        if (state.settlementCompletionHandlerPublished === true) {
          markCompletionHandlerAlreadyPublished(recovered);
        }
        return {
          result: attachMatch(recovered),
          ...(state.clientContext !== undefined && { clientContext: structuredClone(state.clientContext) }),
          settlementOperationId: committedOperationId,
          ...(state.settlementServerTaskId !== undefined && {
            settlementServerTaskId: state.settlementServerTaskId,
          }),
        };
      } catch (error) {
        throw await this.releaseDeferredFinalizationAfterFailure(finalizationLease, error);
      }
    }

    if (state.continuationClaimed) {
      const dispatchLease = state.settlementResumeDispatchLease;
      const reclaimableAdmission =
        requiresSettlement &&
        dispatchLease?.phase === 'admission' &&
        Number.isFinite(dispatchLease.expiresAt) &&
        dispatchLease.expiresAt <= Date.now();
      if (!reclaimableAdmission) {
        throw new DeferredSettlementOwnershipError('Deferred task is already being resumed.');
      }
    }
    if (typeof state.continuationVersion !== 'string' || state.continuationVersion.length === 0) {
      throw new Error('Deferred task state does not contain the atomic continuation version required for resumption.');
    }
    const remainingTtlSeconds = Math.ceil((state.expiresAt - Date.now()) / 1000);
    if (remainingTtlSeconds < 1) throw new Error('Deferred task expired.');
    // Admission is governed by the original human-input deadline above. Once
    // admitted, keep the exact claim generation alive for a fresh dispatch
    // horizon so a slow seller cannot outlive the fence or defeat checkpoint
    // persistence after it has already advanced the mutation.
    const claimTtlSeconds = this.deferredSafetyRetentionSeconds();
    const claimedVersion = randomUUID();
    const claimedAt = Date.now();
    const dispatchOwnerId = requiresSettlement ? randomUUID() : undefined;
    // MemoryStorage retains object references. Keep the durable claim and the
    // mutable in-flight conversation on independent sanitized graphs so a
    // transport failure cannot leave raw resume input in the retained fence.
    const claimedMessages = durableDeferredSnapshot(state.messages);
    const resumedMessages = durableDeferredSnapshot(state.messages);
    const claimedState: DeferredTaskState = {
      ...state,
      continuationVersion: claimedVersion,
      continuationClaimed: true,
      messages: claimedMessages,
      ...(dispatchOwnerId !== undefined && {
        settlementResumeDispatchLease: {
          ownerId: dispatchOwnerId,
          phase: 'admission' as const,
          expiresAt: claimedAt + DEFERRED_DISPATCH_ADMISSION_LEASE_MS,
        },
      }),
      createdAt: claimedAt,
      expiresAt: claimedAt + claimTtlSeconds * 1000,
    };
    let claimed: boolean;
    try {
      claimed = await this.replaceDeferredState(
        this.config.deferredStorage,
        token,
        state.continuationVersion,
        claimedState,
        claimTtlSeconds
      );
    } catch (error) {
      throw new DeferredSettlementOwnershipError('Deferred dispatch admission could not be claimed safely.', {
        cause: error,
      });
    }
    if (!claimed) {
      throw new DeferredSettlementOwnershipError('Deferred task was already consumed or replaced.');
    }

    const admissionLease =
      dispatchOwnerId === undefined
        ? undefined
        : this.startDeferredDispatchAdmissionLease(token, claimedVersion, claimedState, dispatchOwnerId);
    let dispatchVersion = claimedVersion;
    let dispatchCommitted = false;
    let preDispatchStateConsumed = false;
    let agent: AgentConfig | undefined;
    let terminalObservationPersisted = false;
    let finalizationLease: DeferredFinalizationLease | undefined;
    let pendingCheckpointState: DeferredTaskState | undefined;
    try {
      // Authorization belongs after the atomic claim. A callback that wins the
      // previous generation makes this owner lose its final dispatch CAS.
      if (requiresSettlement && state.settlementResumeAuthorizationRequired) {
        await this.requireDeferredDispatchAuthorization(
          committedOperationId,
          token,
          'This deferred continuation is not the current durable route for its committed operation.'
        );
      }
      agent = this.deferredAgents.get(state.agentId) ?? (await this.config.resolveDeferredAgent?.(state.agentId));
      if (!agent || agent.id !== state.agentId) {
        throw new Error('Deferred task agent could not be resolved from trusted configuration.');
      }
      if (state.expiresAt <= Date.now()) {
        const owned = admissionLease ? await admissionLease.stop() : { version: dispatchVersion, state: claimedState };
        const removed = await this.config.deferredStorage.takeIfVersion(token, owned.version);
        if (!removed) {
          throw new DeferredSettlementOwnershipError(
            'Deferred continuation ownership changed while its trusted agent was being resolved.'
          );
        }
        preDispatchStateConsumed = true;
        throw new DeferredSettlementOwnershipError('Deferred task expired during trusted-agent resolution.');
      }
      if (agent.protocol !== 'a2a') {
        throw new Error('A persisted deferred task can only resume an exact A2A seller task.');
      }
      if (!state.a2aTaskId) {
        throw new Error('A persisted A2A deferred task requires a seller task ID.');
      }
      this.deferredAgents.set(agent.id, agent);

      // Re-authorize at the last await boundary, then atomically publish the
      // dispatch linearization point. A callback may still win authoritatively;
      // if it does, this CAS fails and no protocol call is issued.
      if (requiresSettlement && state.settlementResumeAuthorizationRequired) {
        await this.requireDeferredDispatchAuthorization(
          committedOperationId,
          token,
          'This deferred continuation is no longer the current route for its committed operation.'
        );
      }
      if (admissionLease) {
        const owned = await admissionLease.stop();
        const committedAt = Date.now();
        dispatchVersion = randomUUID();
        const dispatchState: DeferredTaskState = {
          ...owned.state,
          continuationVersion: dispatchVersion,
          settlementResumeDispatchLease: {
            ownerId: dispatchOwnerId!,
            phase: 'dispatch-committed',
            expiresAt: committedAt + claimTtlSeconds * 1000,
          },
          createdAt: committedAt,
          expiresAt: committedAt + claimTtlSeconds * 1000,
        };
        let committed: boolean;
        try {
          committed = await this.replaceDeferredState(
            this.config.deferredStorage,
            token,
            owned.version,
            dispatchState,
            claimTtlSeconds
          );
        } catch (error) {
          throw new DeferredSettlementOwnershipError(
            'Deferred dispatch admission could not be committed safely before seller dispatch.',
            { cause: error }
          );
        }
        if (!committed) {
          throw new DeferredSettlementOwnershipError(
            'Deferred continuation ownership changed before seller dispatch; no input was sent.'
          );
        }
      }
      dispatchCommitted = true;
    } catch (error) {
      if (!dispatchCommitted && !preDispatchStateConsumed) {
        const owned = admissionLease ? await admissionLease.stop() : { version: dispatchVersion, state: claimedState };
        await this.restoreUnadvancedDeferredState(token, owned.version, state);
        if (!(error instanceof DeferredSettlementOwnershipError)) {
          throw new DeferredSettlementOwnershipError(
            error instanceof Error ? error.message : 'Deferred continuation failed safely before seller dispatch.',
            { cause: error }
          );
        }
      }
      throw error;
    }

    const { settlementResumeDispatchLease: _dispatchLease, ...checkpointBaseState } = state;
    void _dispatchLease;
    try {
      // Continue task with the provided input (no handler for resumed deferred tasks)
      let resumed = await this.continueTaskWithInput<T>(
        agent,
        state.taskId,
        state.taskName,
        state.params,
        state.contextId,
        state.a2aTaskId,
        inputSnapshot,
        resumedMessages,
        undefined, // No handler for deferred tasks - input was provided by human
        {},
        [],
        Date.now(),
        !publishTerminalTaskStatus || requiresSettlement,
        false,
        state.serverVersion,
        state.clientContext,
        state.settlementResumeAuthorizationRequired === true
      );
      const observedResumedServerTaskId = resumed.metadata.serverTaskId;
      if (requiresSettlement && !TERMINAL_TASK_STATUSES.has(resumed.status as TaskStatus)) {
        resumed = attachMatch(
          normalizeDeferredTerminalServerTaskId(resumed, trustedDeferredServerTaskId(state)).result
        );
      }
      const remainsPaused = ['input-required', 'auth-required', 'deferred'].includes(resumed.status);
      // A resumed seller may pause again with a replacement continuation.
      // Persist that exact new task identity before returning it; otherwise
      // only the in-process closure can resume and a restart falls back to the
      // already-consumed token.
      if (remainsPaused && resumed.deferred !== undefined) {
        const nextA2ATaskId = resumed.metadata.a2aTaskId;
        if (!nextA2ATaskId) {
          throw new Error('A resumable A2A pause did not expose the seller task ID required for durable storage.');
        }
        const nextToken = resumed.deferred.token;
        assertDeferredContinuationToken(nextToken);
        const replacementServerTaskId = requiresSettlement
          ? reconcileDeferredServerTaskId(trustedDeferredServerTaskId(state), [resumed.metadata.serverTaskId])
          : resumed.metadata.serverTaskId;
        const createdAt = Date.now();
        const ttlSeconds = this.config.deferredTaskTtlSeconds ?? DEFAULT_DEFERRED_TASK_TTL_SECONDS;
        const replacementState: DeferredTaskState = {
          continuationVersion: randomUUID(),
          taskId: state.taskId,
          ...(resumed.metadata.contextId !== undefined
            ? { contextId: resumed.metadata.contextId }
            : state.contextId !== undefined
              ? { contextId: state.contextId }
              : {}),
          a2aTaskId: nextA2ATaskId,
          serverVersion: state.serverVersion,
          agentId: state.agentId,
          taskName: state.taskName,
          params: durableDeferredSnapshot(state.params),
          messages: durableDeferredSnapshot(resumed.conversation ?? state.messages),
          pauseStatus: resumed.status as 'input-required' | 'auth-required' | 'deferred',
          pauseQuestion: resumed.deferred.question,
          ...(state.clientContext !== undefined && {
            clientContext: durableDeferredSnapshot(state.clientContext),
          }),
          ...(state.settlementOperationId !== undefined && {
            settlementOperationId: state.settlementOperationId,
          }),
          ...(state.settlementOperationRouteRequired === true && {
            settlementOperationRouteRequired: true as const,
          }),
          ...(state.settlementResumeAuthorizationRequired === true && {
            settlementResumeAuthorizationRequired: true,
          }),
          ...(replacementServerTaskId !== undefined && {
            settlementServerTaskId: replacementServerTaskId,
          }),
          createdAt,
          expiresAt: createdAt + ttlSeconds * 1000,
        };
        const stored =
          requiresSettlement && state.settlementOperationRouteRequired === true
            ? await this.config.deferredStorage.replaceForSettlementOperationIfVersion(
                committedOperationId,
                token,
                dispatchVersion,
                nextToken,
                replacementState,
                ttlSeconds
              )
            : await this.config.deferredStorage.putIfAbsent(nextToken, replacementState, ttlSeconds);
        if (!stored) {
          if (requiresSettlement) {
            const winner = await this.resumeExactDeferredSettlementWinner<T>(
              token,
              state,
              replacementServerTaskId ?? trustedDeferredServerTaskId(state),
              undefined,
              inputSnapshot,
              publishTerminalTaskStatus,
              liveSettlementOwner
            );
            if (winner) return winner;
          }
          throw new Error('Replacement deferred continuation token already exists; refusing unsafe overwrite.');
        }
        if (requiresSettlement && state.settlementResumeAuthorizationRequired === true) {
          const replaced = await this.config.replaceDeferredSettlementResumeToken?.(
            committedOperationId,
            token,
            nextToken
          );
          if (replaced !== true) {
            // A terminal callback may have won after the SDK atomically moved
            // the operation route to B but before the coordinator completed
            // its A -> B CAS. Replay that exact B winner instead of reporting
            // an ownership failure to the originating resume.
            const winner = await this.resumeExactDeferredSettlementWinner<T>(
              nextToken,
              replacementState,
              replacementServerTaskId ?? trustedDeferredServerTaskId(state),
              undefined,
              inputSnapshot,
              publishTerminalTaskStatus,
              liveSettlementOwner
            );
            if (winner) return winner;
            throw new DeferredSettlementOwnershipError(
              'The committed deferred continuation advanced, but its coordinator route still needs recovery.'
            );
          }
        }
        resumed.deferred.resume = nextInput =>
          liveSettlementOwner
            ? this.resumeDeferredTaskFromLiveClosure<T>(nextToken, nextInput, publishTerminalTaskStatus)
            : this.resumeDeferredTaskFromClientClosure<T>(nextToken, nextInput, publishTerminalTaskStatus);
      }

      let settledResult = attachMatch(resumed) as TaskResult<T>;
      let settledServerTaskId = trustedDeferredServerTaskId(state);
      let afterFinalize: (() => Promise<void>) | undefined;
      if (requiresSettlement) {
        if (TERMINAL_TASK_STATUSES.has(resumed.status as TaskStatus)) {
          const normalizedTerminal = normalizeDeferredTerminalServerTaskId(resumed, trustedDeferredServerTaskId(state));
          if (normalizedTerminal.serverTaskId === undefined) {
            throw new Error('The committed deferred terminal response did not provide a seller task identity.');
          }
          settledResult = attachMatch(normalizedTerminal.result);
          const terminalSettlementServerTaskId = normalizedTerminal.serverTaskId;
          settledServerTaskId = terminalSettlementServerTaskId;
          const {
            match: _match,
            submitted: _submitted,
            deferred: _deferred,
            ...serializableResult
          } = normalizedTerminal.result as any;
          const checkpointCreatedAt = Date.now();
          const checkpointTtlSeconds = this.deferredSafetyRetentionSeconds();
          const checkpointVersion = randomUUID();
          const checkpointState: DeferredTaskState = {
            ...checkpointBaseState,
            continuationVersion: checkpointVersion,
            continuationClaimed: true,
            params: durableDeferredSnapshot(state.params),
            messages: durableDeferredSnapshot(normalizedTerminal.result.conversation ?? state.messages),
            ...(state.clientContext !== undefined && {
              clientContext: durableDeferredSnapshot(state.clientContext),
            }),
            ...(terminalSettlementServerTaskId !== undefined && {
              settlementServerTaskId: terminalSettlementServerTaskId,
            }),
            settlementTerminalResult: durableDeferredSnapshot(serializableResult),
            createdAt: checkpointCreatedAt,
            expiresAt: checkpointCreatedAt + checkpointTtlSeconds * 1000,
          };
          const saved = await this.replaceDeferredState(
            this.config.deferredStorage,
            token,
            dispatchVersion,
            checkpointState,
            checkpointTtlSeconds
          );
          if (!saved) {
            const winner = await this.resumeExactDeferredSettlementWinner<T>(
              token,
              state,
              terminalSettlementServerTaskId,
              normalizedTerminal.result,
              inputSnapshot,
              publishTerminalTaskStatus,
              liveSettlementOwner
            );
            if (winner) {
              // An immediate authoritative callback may finish while the seller
              // holds its response for webhook acknowledgement. Re-enter the
              // durable terminal/finalized route; never redispatch the input.
              return winner;
            }
            throw new Error('Committed deferred terminal observation could not be saved without overwriting state.');
          }
          terminalObservationPersisted = true;
          finalizationLease = await this.acquireDeferredFinalizationLease(token, checkpointState);
        } else if (!remainsPaused) {
          // `setupSubmittedTask()` exposes the runner correlation ID as a
          // compatibility fallback when the seller omitted task_id. That value
          // is useful to callers but is never authoritative durable seller
          // identity. Treat a submitted handle as observed only when metadata
          // proves it came from the seller, or when it differs from the local
          // operation ID used by the fallback.
          const observedSubmittedTaskId =
            resumed.submitted?.taskId !== undefined &&
            (observedResumedServerTaskId !== undefined || resumed.submitted.taskId !== state.taskId)
              ? resumed.submitted.taskId
              : undefined;
          const pendingTaskId = reconcileDeferredServerTaskId(trustedDeferredServerTaskId(state), [
            observedResumedServerTaskId,
            observedSubmittedTaskId,
          ]);
          if (!pendingTaskId) {
            throw new Error(
              'A committed deferred continuation became nonterminal without the seller work handle required for recovery.'
            );
          }
          if (resumed.submitted) {
            resumed.submitted = this.createSubmittedContinuation<T>(
              agent,
              state.taskId,
              state.taskName,
              pendingTaskId,
              resumed.submitted.webhookUrl,
              undefined,
              resumed.metadata,
              true,
              state.serverVersion
            );
            settledResult = resumed;
          }
          const pendingCreatedAt = Date.now();
          const pendingTtlSeconds = this.deferredSafetyRetentionSeconds();
          const pendingState: DeferredTaskState = {
            ...checkpointBaseState,
            continuationVersion: randomUUID(),
            continuationClaimed: true,
            settlementPendingTaskId: pendingTaskId,
            settlementServerTaskId: pendingTaskId,
            params: durableDeferredSnapshot(state.params),
            messages: durableDeferredSnapshot(resumed.conversation ?? state.messages),
            ...(state.clientContext !== undefined && {
              clientContext: durableDeferredSnapshot(state.clientContext),
            }),
            createdAt: pendingCreatedAt,
            expiresAt: pendingCreatedAt + pendingTtlSeconds * 1000,
          };
          const saved = await this.replaceDeferredState(
            this.config.deferredStorage,
            token,
            dispatchVersion,
            pendingState,
            pendingTtlSeconds
          );
          if (!saved) {
            const winner = await this.resumeExactDeferredSettlementWinner<T>(
              token,
              state,
              pendingTaskId,
              undefined,
              inputSnapshot,
              publishTerminalTaskStatus,
              liveSettlementOwner
            );
            if (winner) return winner;
            throw new Error('Committed deferred pending task could not be saved without overwriting state.');
          }
          terminalObservationPersisted = true;
          pendingCheckpointState = pendingState;
          settledServerTaskId = pendingTaskId;
        }
        if (requiresRecoveredSettlement && !pendingCheckpointState) {
          const settlement = await this.config.recoverDeferredSettlement!(
            settledResult,
            committedOperationId,
            settledServerTaskId
          );
          settledResult = settlement.result as TaskResult<T>;
          afterFinalize = settlement.afterFinalize;
        }
      }
      if (
        publishTerminalTaskStatus &&
        !requiresSettlement &&
        TERMINAL_TASK_STATUSES.has(settledResult.status as TaskStatus) &&
        this.activeTasks.get(state.taskId)?.status !== settledResult.status
      ) {
        this.updateTaskStatus(
          state.taskId,
          settledResult.status as TaskStatus,
          settledResult.data,
          settledResult.error
        );
      }
      if (requiresSettlement && TERMINAL_TASK_STATUSES.has(settledResult.status as TaskStatus)) {
        const activeFinalizationLease = finalizationLease;
        settledResult = this.attachDeferredSettlementAcknowledgement(
          settledResult,
          state.taskId,
          publishTerminalTaskStatus,
          afterFinalize,
          activeFinalizationLease ? finalized => activeFinalizationLease.finalize(finalized) : undefined,
          activeFinalizationLease ? () => activeFinalizationLease.release() : undefined
        );
      }
      if (pendingCheckpointState) {
        settledResult = this.wrapDeferredPendingSettlementContinuations(
          token,
          pendingCheckpointState,
          settledResult,
          publishTerminalTaskStatus,
          requiresRecoveredSettlement
        );
      }
      if (!terminalObservationPersisted) {
        const consumedFence = await this.config.deferredStorage.takeIfVersion(token, dispatchVersion);
        if (!consumedFence) {
          if (requiresSettlement) {
            const winner = await this.resumeExactDeferredSettlementWinner<T>(
              token,
              state,
              settledServerTaskId,
              undefined,
              inputSnapshot,
              publishTerminalTaskStatus,
              liveSettlementOwner
            );
            if (winner) return winner;
          }
          throw new Error('Deferred continuation claim was replaced before version-fenced completion.');
        }
      }
      return {
        result: attachMatch(settledResult),
        ...(state.clientContext !== undefined && { clientContext: structuredClone(state.clientContext) }),
        ...(state.settlementOperationId !== undefined && {
          settlementOperationId: state.settlementOperationId,
        }),
        ...(settledServerTaskId !== undefined && {
          settlementServerTaskId: settledServerTaskId,
        }),
      };
    } catch (error) {
      let propagatedError = error;
      if (finalizationLease) {
        propagatedError = await this.releaseDeferredFinalizationAfterFailure(finalizationLease, error);
      }
      // A thrown continuation failure is terminal for this deferred token.
      // Release both persistence and the in-memory request payload before the
      // error escapes to the caller.
      if (
        publishTerminalTaskStatus &&
        !terminalObservationPersisted &&
        !(propagatedError instanceof DeferredSettlementOwnershipError)
      ) {
        this.updateTaskStatus(
          state.taskId,
          'failed',
          undefined,
          propagatedError instanceof Error ? propagatedError.message : String(propagatedError)
        );
      }
      // The versioned claim fence stays in storage after uncertain dispatch:
      // the seller may have advanced even when its response did not reach
      // this process, so the human continuation must not become resumable.
      throw propagatedError;
    }
  }

  private wrapDeferredPendingSettlementContinuations<T>(
    token: string,
    pendingState: DeferredTaskState,
    result: TaskResult<T>,
    publishTerminalTaskStatus: boolean,
    recoverTerminal: boolean
  ): TaskResult<T> {
    const markPendingSettlement = (marked: TaskResult<T>): TaskResult<T> => {
      Object.defineProperty(marked, DEFERRED_PENDING_SETTLEMENT, {
        value: async (terminal: TaskResult<T>) => {
          const normalizedTerminal = normalizeDeferredTerminalServerTaskId(
            terminal,
            trustedDeferredServerTaskId(pendingState)
          );
          const lease = await this.checkpointDeferredPendingTerminal(
            token,
            pendingState,
            normalizedTerminal.result,
            true
          );
          if (!lease) throw new Error('Committed deferred terminal finalization lease was not acquired.');
          let checkpointed = normalizedTerminal.result;
          let afterFinalize: (() => Promise<void>) | undefined;
          try {
            if (recoverTerminal) {
              const settlement = await this.config.recoverDeferredSettlement!(
                normalizedTerminal.result,
                pendingState.settlementOperationId!,
                normalizedTerminal.serverTaskId
              );
              checkpointed = settlement.result as TaskResult<T>;
              afterFinalize = settlement.afterFinalize;
            }
            checkpointed = this.attachDeferredSettlementAcknowledgement(
              checkpointed,
              pendingState.taskId,
              publishTerminalTaskStatus,
              afterFinalize,
              finalized => lease.finalize(finalized),
              () => lease.release()
            );
          } catch (error) {
            throw await this.releaseDeferredFinalizationAfterFailure(lease, error);
          }
          if (pendingState.clientContext === undefined) await acknowledgeDeferredSettlement(checkpointed);
          return checkpointed;
        },
        enumerable: false,
        configurable: false,
        writable: false,
      });
      return marked;
    };
    if (!result.submitted) return markPendingSettlement(result);
    const submitted = result.submitted;
    const wrapped = attachMatch({
      ...result,
      submitted: {
        ...submitted,
        track: async transport => {
          const task = await submitted.track(transport);
          if (TERMINAL_TASK_STATUSES.has(task.status as TaskStatus)) {
            const status = task.status === 'completed' ? 'completed' : (task.status as TaskStatus);
            const terminal = attachMatch({
              success: status === 'completed',
              status,
              ...(task.result !== undefined && { data: task.result }),
              ...(task.error !== undefined && { error: task.error }),
              metadata: {
                taskId: pendingState.taskId,
                taskName: task.taskType,
                agent: { id: pendingState.agentId, name: pendingState.agentId, protocol: 'a2a' },
                responseTimeMs: 0,
                timestamp: new Date().toISOString(),
                clarificationRounds: 0,
                status,
                serverTaskId: task.taskId,
              },
            } as TaskResult<unknown>);
            await this.checkpointDeferredPendingTerminal(token, pendingState, terminal, false);
            if (!recoverTerminal) return task;
            throw new Error(
              'The terminal seller observation was saved; resume the durable token to finalize committed settlement.'
            );
          }
          return task;
        },
        waitForCompletion: async (pollInterval, signal) => {
          const completion = await submitted.waitForCompletion(pollInterval, signal);
          if (
            !TERMINAL_TASK_STATUSES.has(completion.status as TaskStatus) ||
            !(AUTHORITATIVE_POLLED_TERMINAL in completion)
          ) {
            return completion;
          }
          const normalizedCompletion = normalizeDeferredTerminalServerTaskId(
            completion,
            trustedDeferredServerTaskId(pendingState)
          );
          const lease = await this.checkpointDeferredPendingTerminal(
            token,
            pendingState,
            normalizedCompletion.result,
            true
          );
          if (!lease) throw new Error('Committed deferred terminal finalization lease was not acquired.');
          let checkpointed: TaskResult<T> = normalizedCompletion.result;
          let afterFinalize: (() => Promise<void>) | undefined;
          try {
            if (recoverTerminal) {
              const settlement = await this.config.recoverDeferredSettlement!(
                normalizedCompletion.result,
                pendingState.settlementOperationId!,
                normalizedCompletion.serverTaskId
              );
              checkpointed = settlement.result as TaskResult<T>;
              afterFinalize = settlement.afterFinalize;
            }
            checkpointed = this.attachDeferredSettlementAcknowledgement(
              checkpointed,
              pendingState.taskId,
              publishTerminalTaskStatus,
              afterFinalize,
              finalized => lease.finalize(finalized),
              () => lease.release()
            );
          } catch (error) {
            throw await this.releaseDeferredFinalizationAfterFailure(lease, error);
          }
          if (pendingState.clientContext === undefined) {
            await acknowledgeDeferredSettlement(checkpointed);
          }
          return checkpointed;
        },
      },
    } as TaskResult<T>);
    return markPendingSettlement(wrapped);
  }

  private async resumeExactDeferredSettlementWinner<T>(
    token: string,
    expectedState: DeferredTaskState,
    expectedServerTaskId: string | undefined,
    expectedTerminal: TaskResult<T> | undefined,
    inputSnapshot: unknown,
    publishTerminalTaskStatus: boolean,
    liveSettlementOwner: boolean
  ): Promise<
    | {
        result: TaskResult<T>;
        clientContext?: unknown;
        settlementOperationId?: string;
        settlementServerTaskId?: string;
      }
    | undefined
  > {
    const winner = await this.config.deferredStorage?.get(token);
    if (
      !winner ||
      winner.settlementOperationId === undefined ||
      winner.settlementOperationId !== expectedState.settlementOperationId ||
      expectedServerTaskId === undefined ||
      winner.settlementServerTaskId !== expectedServerTaskId ||
      (winner.settlementTerminalResult === undefined && winner.settlementFinalizedResult === undefined)
    ) {
      return undefined;
    }

    if (winner.settlementTerminalResult !== undefined) {
      const normalizedWinner = normalizeDeferredTerminalServerTaskId(
        winner.settlementTerminalResult as TaskResult<unknown>,
        winner.settlementServerTaskId
      ).result;
      if (expectedTerminal !== undefined) {
        const normalizedExpected = normalizeDeferredTerminalServerTaskId(expectedTerminal, expectedServerTaskId).result;
        if (!sameDeferredTerminal(normalizedWinner, normalizedExpected)) return undefined;
      }
    } else if (expectedTerminal !== undefined) {
      // A direct terminal response needs the raw seller observation to prove
      // equality; a finalized-only legacy record is not enough.
      return undefined;
    } else {
      normalizeDeferredTerminalServerTaskId(
        winner.settlementFinalizedResult as TaskResult<unknown>,
        winner.settlementServerTaskId
      );
    }

    return this.resumeDeferredTaskCore<T>(token, inputSnapshot, publishTerminalTaskStatus, liveSettlementOwner);
  }

  private async checkpointDeferredPendingTerminal<T>(
    token: string,
    pendingState: DeferredTaskState,
    terminalResult: TaskResult<T>,
    acquireLease: boolean
  ): Promise<DeferredFinalizationLease | undefined> {
    const storage = this.config.deferredStorage;
    if (!storage) throw new Error('Deferred storage not configured');
    const normalizedTerminal = normalizeDeferredTerminalServerTaskId(
      terminalResult,
      trustedDeferredServerTaskId(pendingState)
    );
    const {
      match: _match,
      submitted: _submitted,
      deferred: _deferred,
      ...serializableResult
    } = normalizedTerminal.result as any;
    void _match;
    void _submitted;
    void _deferred;
    const {
      settlementPendingTaskId: _pending,
      settlementResumeDispatchLease: _dispatchLease,
      ...checkpointBase
    } = pendingState;
    void _pending;
    void _dispatchLease;
    const checkpointCreatedAt = Date.now();
    const ttlSeconds = this.deferredSafetyRetentionSeconds();
    const checkpointState: DeferredTaskState = {
      ...checkpointBase,
      continuationVersion: randomUUID(),
      continuationClaimed: true,
      ...(normalizedTerminal.serverTaskId !== undefined && {
        settlementServerTaskId: normalizedTerminal.serverTaskId,
      }),
      settlementTerminalResult: durableDeferredSnapshot(serializableResult),
      createdAt: checkpointCreatedAt,
      expiresAt: checkpointCreatedAt + ttlSeconds * 1000,
    };
    const saved =
      pendingState.settlementOperationId && pendingState.settlementOperationRouteRequired === true
        ? await storage.replaceForSettlementOperationIfVersion(
            pendingState.settlementOperationId,
            token,
            pendingState.continuationVersion,
            token,
            checkpointState,
            ttlSeconds
          )
        : await this.replaceDeferredState(
            storage,
            token,
            pendingState.continuationVersion,
            checkpointState,
            ttlSeconds
          );
    if (!saved) {
      throw new DeferredSettlementOwnershipError(
        'Committed deferred terminal observation could not replace its pending checkpoint.'
      );
    }
    return acquireLease ? this.acquireDeferredFinalizationLease(token, checkpointState) : undefined;
  }

  private startDeferredDispatchAdmissionLease(
    token: string,
    initialVersion: string,
    initialState: DeferredTaskState,
    ownerId: string
  ): DeferredDispatchAdmissionLease {
    const storage = this.config.deferredStorage!;
    const safetyTtlSeconds = this.deferredSafetyRetentionSeconds();
    let currentVersion = initialVersion;
    let currentState = initialState;
    let stopped = false;
    let lostError: Error | undefined;
    let renewal = Promise.resolve();
    let timer: ReturnType<typeof setTimeout> | undefined;

    const scheduleRenewal = (): void => {
      if (stopped || lostError) return;
      timer = setTimeout(() => {
        renewal = renewal.then(async () => {
          if (stopped || lostError) return;
          try {
            const renewedAt = Date.now();
            const nextVersion = randomUUID();
            const nextState: DeferredTaskState = {
              ...currentState,
              continuationVersion: nextVersion,
              settlementResumeDispatchLease: {
                ownerId,
                phase: 'admission',
                expiresAt: renewedAt + DEFERRED_DISPATCH_ADMISSION_LEASE_MS,
              },
              expiresAt: renewedAt + safetyTtlSeconds * 1000,
            };
            const renewed = await this.replaceDeferredState(
              storage,
              token,
              currentVersion,
              nextState,
              safetyTtlSeconds
            );
            if (!renewed) {
              lostError = new DeferredSettlementOwnershipError(
                'Deferred dispatch admission ownership changed before seller dispatch.'
              );
              return;
            }
            currentVersion = nextVersion;
            currentState = nextState;
            scheduleRenewal();
          } catch (error) {
            lostError = new DeferredSettlementOwnershipError(
              'Deferred dispatch admission lease could not be renewed safely before seller dispatch.',
              { cause: error }
            );
          }
        });
      }, DEFERRED_DISPATCH_ADMISSION_RENEW_MS);
      timer.unref?.();
    };
    scheduleRenewal();

    let stoppedState: { version: string; state: DeferredTaskState } | undefined;
    return {
      stop: async () => {
        if (stoppedState) return stoppedState;
        if (!stopped) {
          stopped = true;
          if (timer) clearTimeout(timer);
        }
        await renewal;
        if (lostError) throw lostError;
        stoppedState = { version: currentVersion, state: currentState };
        return stoppedState;
      },
    };
  }

  private async requireDeferredDispatchAuthorization(
    operationId: string,
    token: string,
    message: string
  ): Promise<void> {
    try {
      if ((await this.config.authorizeDeferredSettlementResume?.(operationId, token)) !== true) {
        throw new DeferredSettlementOwnershipError(message);
      }
    } catch (error) {
      if (error instanceof DeferredSettlementOwnershipError) throw error;
      throw new DeferredSettlementOwnershipError(message, { cause: error });
    }
  }

  private async acquireDeferredFinalizationLease(
    token: string,
    checkpoint: DeferredTaskState
  ): Promise<DeferredFinalizationLease> {
    const storage = this.config.deferredStorage;
    if (!storage) {
      throw new DeferredSettlementOwnershipError(
        'Deferred settlement finalization could not be claimed because deferred storage is unavailable.'
      );
    }
    const now = Date.now();
    if (checkpoint.settlementFinalizationLease && checkpoint.settlementFinalizationLease.expiresAt > now) {
      throw new DeferredSettlementOwnershipError('Deferred settlement finalization is already in progress.');
    }

    const ownerId = randomUUID();
    const safetyTtlSeconds = this.deferredSafetyRetentionSeconds();
    let currentVersion = randomUUID();
    let currentState: DeferredTaskState = {
      ...checkpoint,
      continuationVersion: currentVersion,
      settlementFinalizationLease: {
        ownerId,
        expiresAt: now + DEFERRED_FINALIZATION_LEASE_MS,
      },
      expiresAt: now + safetyTtlSeconds * 1000,
    };
    let acquired: boolean;
    try {
      acquired = await this.replaceDeferredState(
        storage,
        token,
        checkpoint.continuationVersion,
        currentState,
        safetyTtlSeconds
      );
    } catch (error) {
      throw new DeferredSettlementOwnershipError('Deferred settlement finalization could not be claimed safely.', {
        cause: error,
      });
    }
    if (!acquired) {
      throw new DeferredSettlementOwnershipError('Deferred settlement finalization was claimed by another replica.');
    }

    let stopped = false;
    let lostError: Error | undefined;
    let renewal = Promise.resolve();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const scheduleRenewal = (): void => {
      if (stopped || lostError) return;
      timer = setTimeout(() => {
        renewal = renewal.then(async () => {
          if (stopped || lostError) return;
          try {
            const renewedAt = Date.now();
            const nextVersion = randomUUID();
            const nextState: DeferredTaskState = {
              ...currentState,
              continuationVersion: nextVersion,
              settlementFinalizationLease: {
                ownerId,
                expiresAt: renewedAt + DEFERRED_FINALIZATION_LEASE_MS,
              },
              expiresAt: renewedAt + safetyTtlSeconds * 1000,
            };
            const renewed = await this.replaceDeferredState(
              storage,
              token,
              currentVersion,
              nextState,
              safetyTtlSeconds
            );
            if (!renewed) {
              lostError = new DeferredSettlementOwnershipError('Deferred settlement finalization lease was lost.');
              return;
            }
            currentVersion = nextVersion;
            currentState = nextState;
            scheduleRenewal();
          } catch (error) {
            lostError = new DeferredSettlementOwnershipError(
              'Deferred settlement finalization lease could not be renewed.',
              { cause: error }
            );
          }
        });
      }, DEFERRED_FINALIZATION_RENEW_MS);
      timer.unref?.();
    };
    scheduleRenewal();

    const stop = async (): Promise<void> => {
      if (!stopped) {
        stopped = true;
        if (timer) clearTimeout(timer);
      }
      await renewal;
      if (lostError) throw lostError;
    };

    let completed = false;
    return {
      finalize: async <T>(result: TaskResult<T>): Promise<void> => {
        if (completed) return;
        await stop();
        await this.markDeferredSettlementFinalized(token, currentVersion, result);
        completed = true;
      },
      release: async (completionHandlerPublished = false): Promise<void> => {
        if (completed) return;
        await stop();
        const { settlementFinalizationLease: _lease, ...retryableCheckpoint } = currentState;
        void _lease;
        const releasedAt = Date.now();
        let released: boolean;
        try {
          released = await this.replaceDeferredState(
            storage,
            token,
            currentVersion,
            {
              ...retryableCheckpoint,
              continuationVersion: randomUUID(),
              ...((retryableCheckpoint.settlementCompletionHandlerPublished === true || completionHandlerPublished) && {
                settlementCompletionHandlerPublished: true,
              }),
              createdAt: releasedAt,
              expiresAt: releasedAt + safetyTtlSeconds * 1000,
            },
            safetyTtlSeconds
          );
        } catch (error) {
          throw new DeferredSettlementOwnershipError(
            'Deferred settlement finalization lease could not be released safely.',
            { cause: error }
          );
        }
        if (!released) {
          throw new DeferredSettlementOwnershipError(
            'Deferred settlement finalization lease ownership changed before it could be released.'
          );
        }
        completed = true;
      },
    };
  }

  private async releaseDeferredFinalizationAfterFailure(
    lease: DeferredFinalizationLease,
    originalFailure: unknown
  ): Promise<unknown> {
    try {
      await lease.release();
      return originalFailure;
    } catch (releaseFailure) {
      return new DeferredSettlementOwnershipError(
        'Deferred settlement failed and its finalization lease could not be released safely.',
        {
          cause: new AggregateError(
            [originalFailure, releaseFailure],
            'Deferred settlement failure and finalization lease release both failed.'
          ),
        }
      );
    }
  }

  private attachDeferredSettlementAcknowledgement<T>(
    result: TaskResult<T>,
    taskId: string,
    publishTerminalTaskStatus: boolean,
    afterFinalize?: () => Promise<void>,
    persistFinalized?: (finalizedResult: TaskResult<T>) => Promise<void>,
    rejectFinalization?: (completionHandlerPublished: boolean) => Promise<void>
  ): TaskResult<T> {
    let acknowledged = false;
    let rejected = false;
    const acknowledge = async (finalizedResult: TaskResult<T> = result): Promise<void> => {
      if (acknowledged) return;
      if (rejected) {
        throw new DeferredSettlementOwnershipError(
          'Deferred settlement finalization was released; reacquire the durable checkpoint before acknowledging.'
        );
      }
      try {
        await afterFinalize?.();
        await persistFinalized?.(finalizedResult);
        if (
          publishTerminalTaskStatus &&
          TERMINAL_TASK_STATUSES.has(finalizedResult.status as TaskStatus) &&
          this.activeTasks.get(taskId)?.status !== finalizedResult.status
        ) {
          this.updateTaskStatus(
            taskId,
            finalizedResult.status as TaskStatus,
            finalizedResult.data,
            finalizedResult.error
          );
        }
        acknowledged = true;
      } catch (error) {
        if (!rejected) {
          try {
            await rejectFinalization?.(
              hasCompletionHandlerAlreadyPublished(finalizedResult) || hasCompletionHandlerAlreadyPublished(result)
            );
            rejected = true;
          } catch (releaseFailure) {
            rejected = true;
            throw new DeferredSettlementOwnershipError(
              'Deferred settlement acknowledgement failed and its finalization lease could not be released safely.',
              {
                cause: new AggregateError(
                  [error, releaseFailure],
                  'Deferred settlement acknowledgement and finalization lease release both failed.'
                ),
              }
            );
          }
        }
        throw error;
      }
    };
    const reject = async (): Promise<void> => {
      if (acknowledged || rejected) return;
      await rejectFinalization?.(hasCompletionHandlerAlreadyPublished(result));
      rejected = true;
    };
    Object.defineProperty(result, DEFERRED_SETTLEMENT_ACK, {
      value: acknowledge,
      enumerable: true,
      configurable: false,
      writable: false,
    });
    Object.defineProperty(result, DEFERRED_SETTLEMENT_NACK, {
      value: reject,
      enumerable: true,
      configurable: false,
      writable: false,
    });
    return result;
  }

  private async markDeferredSettlementFinalized<T>(
    token: string,
    expectedVersion: string,
    finalizedResult: TaskResult<T>
  ): Promise<void> {
    const storage = this.config.deferredStorage;
    if (!storage) {
      throw new DeferredSettlementOwnershipError(
        'Committed deferred completion could not be durably acknowledged because deferred storage is unavailable.'
      );
    }
    let current: DeferredTaskState | undefined;
    try {
      current = await storage.get(token);
    } catch (error) {
      throw new DeferredSettlementOwnershipError('Committed deferred completion ownership could not be verified.', {
        cause: error,
      });
    }
    if (!current || current.continuationVersion !== expectedVersion) {
      throw new DeferredSettlementOwnershipError(
        'Committed deferred completion could not be durably acknowledged because ownership changed.'
      );
    }
    const normalizedFinalized = normalizeDeferredTerminalServerTaskId(
      finalizedResult,
      trustedDeferredServerTaskId(current)
    );
    if (normalizedFinalized.serverTaskId === undefined) {
      throw new Error('The finalized deferred settlement does not contain its trusted seller task identity.');
    }
    if (normalizedFinalized.result !== finalizedResult) {
      finalizedResult.metadata = normalizedFinalized.result.metadata;
    }
    const {
      match: _match,
      submitted: _submitted,
      deferred: _deferred,
      ...serializableResult
    } = normalizedFinalized.result as any;
    void _match;
    void _submitted;
    void _deferred;
    const acknowledgedAt = Date.now();
    const ttlSeconds = this.deferredSafetyRetentionSeconds();
    const { settlementFinalizationLease: _lease, ...finalizedCheckpoint } = current;
    void _lease;
    let saved: boolean;
    try {
      saved = await this.replaceDeferredState(
        storage,
        token,
        expectedVersion,
        {
          ...finalizedCheckpoint,
          continuationVersion: randomUUID(),
          continuationClaimed: true,
          params: durableDeferredSnapshot(current.params),
          messages: durableDeferredSnapshot(current.messages),
          ...(current.clientContext !== undefined && {
            clientContext: durableDeferredSnapshot(current.clientContext),
          }),
          settlementFinalizedResult: durableDeferredSnapshot(serializableResult),
          ...((current.settlementCompletionHandlerPublished === true ||
            hasCompletionHandlerAlreadyPublished(finalizedResult)) && {
            settlementCompletionHandlerPublished: true,
          }),
          createdAt: acknowledgedAt,
          expiresAt: acknowledgedAt + ttlSeconds * 1000,
        },
        ttlSeconds
      );
    } catch (error) {
      throw new DeferredSettlementOwnershipError('Committed deferred completion could not be durably acknowledged.', {
        cause: error,
      });
    }
    if (!saved) {
      throw new DeferredSettlementOwnershipError(
        'Committed deferred completion could not be durably acknowledged because ownership changed.'
      );
    }
  }

  private deferredSafetyRetentionSeconds(): number {
    const configuredWorkingMs = this.config.workingTimeout ?? 120_000;
    const workingMs =
      Number.isFinite(configuredWorkingMs) && configuredWorkingMs > 0
        ? Math.min(configuredWorkingMs, MAX_TIMER_DELAY_MS)
        : 120_000;
    const configuredRequestMs = this.config.transport?.requestTimeoutMs;
    const requestMs =
      configuredRequestMs === 0
        ? MAX_TIMER_DELAY_MS
        : configuredRequestMs !== undefined && Number.isFinite(configuredRequestMs) && configuredRequestMs > 0
          ? Math.min(configuredRequestMs, MAX_TIMER_DELAY_MS)
          : 0;
    const configuredOperationHorizonSeconds =
      Math.ceil((workingMs + requestMs) / 1000) + DEFERRED_SAFETY_MARGIN_SECONDS;
    return Math.max(
      DEFAULT_DEFERRED_SAFETY_RETENTION_SECONDS,
      this.config.deferredTaskTtlSeconds ?? 0,
      configuredOperationHorizonSeconds
    );
  }

  /** Restore a consumed token only when no seller continuation was dispatched. */
  private async restoreUnadvancedDeferredState(
    token: string,
    claimedVersion: string,
    state: DeferredTaskState
  ): Promise<void> {
    const remainingTtlSeconds = Math.ceil((state.expiresAt - Date.now()) / 1000);
    const storage = this.config.deferredStorage;
    if (!storage) {
      throw new DeferredSettlementOwnershipError('Deferred continuation state could not be restored safely.');
    }
    if (remainingTtlSeconds < 1) {
      let removed: DeferredTaskState | undefined;
      try {
        removed = await storage.takeIfVersion(token, claimedVersion);
      } catch (error) {
        throw new DeferredSettlementOwnershipError('Expired deferred dispatch admission could not be removed safely.', {
          cause: error,
        });
      }
      if (!removed) {
        throw new DeferredSettlementOwnershipError(
          'Expired deferred dispatch admission ownership changed before cleanup.'
        );
      }
      return;
    }
    let restored: boolean;
    try {
      restored = await this.replaceDeferredState(storage, token, claimedVersion, state, remainingTtlSeconds);
    } catch (error) {
      throw new DeferredSettlementOwnershipError('Deferred continuation state could not be restored safely.', {
        cause: error,
      });
    }
    if (!restored) {
      throw new DeferredSettlementOwnershipError(
        'Deferred continuation token was reused during trusted-agent resolution; original state was not restored.'
      );
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
    contextId: string | undefined,
    a2aTaskId: string | undefined,
    input: any,
    messages: Message[],
    inputHandler: InputHandler | undefined,
    options: TaskOptions = {},
    debugLogs: any[] = [],
    startTime: number = Date.now(),
    deferTerminalTaskStatus = false,
    persistPausedContinuation = true,
    serverVersion: 'v2' | 'v3' = 'v3',
    deferredClientContext?: unknown,
    requireDeferredSettlementResumeAuthorization = false
  ): Promise<TaskResult<T>> {
    // This is also the direct same-process continuation when durable storage
    // is absent. Snapshot before the first await so nested caller-owned input
    // cannot change after the user selects it.
    const inputSnapshot = structuredClone(input);
    if (agent.protocol !== 'a2a') {
      throw new Error('MCP does not define a standard continuation for a returned input-required task.');
    }
    if (!a2aTaskId) {
      throw new Error(
        'A2A continuation requires a seller task ID; refusing to issue a fresh same-tool call from identity-less state.'
      );
    }
    // Add user input message
    const inputMessage: Message = {
      id: randomUUID(),
      role: 'user',
      content: inputSnapshot,
      timestamp: new Date().toISOString(),
      metadata: { type: 'input_response' },
    };
    messages.push(inputMessage);

    // Continue the task with input
    const response = await ProtocolClient.callTool(
      agent,
      taskName,
      { input: inputSnapshot },
      {
        debugLogs,
        serverVersion,
        adcpVersion: this.config.adcpVersion,
        ...(this.config.wireAdcpVersion !== undefined && { wireAdcpVersion: this.config.wireAdcpVersion }),
        ...(this.config.versionEnvelope !== undefined && { versionEnvelope: this.config.versionEnvelope }),
        transport: options.transport ?? this.config.transport,
        session: { contextId, taskId: a2aTaskId },
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
      deferTerminalTaskStatus,
      persistPausedContinuation,
      serverVersion,
      deferredClientContext,
      requireDeferredSettlementResumeAuthorization
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
    const transportSnapshot = snapshotTransportOptions(transport ?? this.config.transport);
    // First try to get from agent via protocol
    const agent = this.findAgentById(agentId);
    if (agent) {
      try {
        return await this.listTasksForAgent(agent, transportSnapshot);
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
    debugLogs: any[],
    serverVersion?: 'v2' | 'v3'
  ): { valid: boolean; errors: string[] } {
    const mode = this.responseValidationMode;
    const logViolations = this.config.logSchemaViolations !== false;

    try {
      // Validate against the version the agent actually spoke. Without
      // this, v2.5 sellers (e.g. Wonderstruck) return valid v2.5-shaped
      // responses and the SDK rejects them as malformed v3 — surfaces as
      // `pricing_options must NOT have fewer than 1 items` and similar
      // shape mismatches that don't exist in v2.5. The v3 → v2 path is
      // Normal dispatch uses lastKnownServerVersion; restart recovery passes
      // the persisted continuation version explicitly so concurrent or fresh
      // executors cannot validate the seller's response against another wire.
      const validationVersion =
        (serverVersion ?? this.lastKnownServerVersion) === 'v2'
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

  private effectiveResponseAdcpVersion(serverVersion?: 'v2' | 'v3'): string {
    if ((serverVersion ?? this.lastKnownServerVersion) === 'v2') return 'v2.5';
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
