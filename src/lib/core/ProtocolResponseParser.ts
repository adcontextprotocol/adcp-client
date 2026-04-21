/**
 * Simple ADCP-compliant response parser
 * Implements ADCP spec PR #77 for standardized status field
 */

import type { InputRequest } from './ConversationTypes';

/**
 * ADCP standardized status values as per spec PR #78
 * Clear semantics for async task management:
 * - submitted: Long-running tasks (hours to days) - webhook required
 * - working: Processing tasks (<120 seconds) - keep connection open
 * - input-required: Tasks needing user interaction via handler
 * - completed: Successful task completion
 */
export const ADCP_STATUS = {
  SUBMITTED: 'submitted', // Long-running (hours/days) - webhook required
  WORKING: 'working', // Processing (<120s) - keep connection open
  INPUT_REQUIRED: 'input-required', // Needs user input via handler
  COMPLETED: 'completed', // Task completed successfully
  FAILED: 'failed', // Task failed
  CANCELED: 'canceled', // Task was canceled
  REJECTED: 'rejected', // Task was rejected
  AUTH_REQUIRED: 'auth-required', // Authentication required
  UNKNOWN: 'unknown', // Unknown status
} as const;

export type ADCPStatus = (typeof ADCP_STATUS)[keyof typeof ADCP_STATUS];

/**
 * Fields that belong to the task envelope, not to a domain payload. Derived
 * from `ProtocolEnvelope` (core/protocol-envelope.json) plus the optional
 * `errors` / `context` / `ext` fields that AdCP task-response schemas place at
 * envelope level. Used to disambiguate `structuredContent.status` from AdCP v3
 * domain status enums (MediaBuyStatus, CreativeStatus, etc.) that share
 * literals like `completed` / `canceled` / `failed` / `rejected` — see #646.
 */
const TASK_ENVELOPE_FIELDS: ReadonlySet<string> = new Set([
  'status',
  'message',
  'timestamp',
  'context_id',
  'task_id',
  'replayed',
  'push_notification_config',
  'governance_context',
  'adcp_version',
  'errors',
  'context',
  'ext',
]);

/**
 * ADCP task-lifecycle statuses that never overlap with AdCP domain status
 * enums and can be trusted from `structuredContent.status` unconditionally.
 * The other literals (`completed` / `canceled` / `failed` / `rejected`) share
 * values with `MediaBuyStatus` et al and require envelope-shape disambiguation.
 */
const EXCLUSIVE_TASK_STATUSES: ReadonlySet<string> = new Set([
  ADCP_STATUS.SUBMITTED,
  ADCP_STATUS.WORKING,
  ADCP_STATUS.INPUT_REQUIRED,
  ADCP_STATUS.AUTH_REQUIRED,
]);

/**
 * Max length for a server-issued session id (`contextId` / `taskId`) we
 * will retain on the client. Well above any sane UUID, opaque token, or
 * ADK-style hierarchical id — exceeding it signals a misbehaving seller,
 * not a legitimate identifier.
 */
const SESSION_ID_MAX_LENGTH = 256;

/**
 * Printable ASCII only (0x20–0x7E). Rejects control characters (CR, LF,
 * NUL, ANSI sequences) that would be retained verbatim on future sends
 * and echoed into debug logs — a log-injection vector if those logs reach
 * third-party observability stacks. This is stricter than the A2A spec,
 * which treats the id as opaque, but matches every id format we've seen
 * in the wild (UUIDs, KSUIDs, ADK `app/user/session` triples, etc.).
 */
const SESSION_ID_PATTERN = /^[\x20-\x7E]+$/;

function isSafeSessionId(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  if (v.length === 0 || v.length > SESSION_ID_MAX_LENGTH) return false;
  return SESSION_ID_PATTERN.test(v);
}

/** Return the first argument that passes {@link isSafeSessionId}, else `undefined`. */
function firstSafeSessionId(...candidates: unknown[]): string | undefined {
  for (const c of candidates) {
    if (isSafeSessionId(c)) return c;
  }
  return undefined;
}

/**
 * Simple parser that follows ADCP spec exactly
 */
export class ProtocolResponseParser {
  /**
   * Check if response indicates input is needed per ADCP spec
   */
  isInputRequest(response: any): boolean {
    // ADCP spec: check A2A JSON-RPC wrapped status first
    if (response?.result?.status?.state === ADCP_STATUS.INPUT_REQUIRED) {
      return true;
    }

    // ADCP spec: check top-level status field
    if (response?.status === ADCP_STATUS.INPUT_REQUIRED) {
      return true;
    }

    // Legacy fallback for backward compatibility
    return (
      response?.type === 'input_request' ||
      response?.question !== undefined ||
      response?.input_required === true ||
      response?.needs_clarification === true
    );
  }

  /**
   * Parse input request from response
   */
  parseInputRequest(response: any): InputRequest {
    const question = response.message || response.question || response.prompt || 'Please provide input';
    const field = response.field || response.parameter;
    const suggestions = response.options || response.choices || response.suggestions;

    return {
      question,
      field,
      expectedType: this.parseExpectedType(response.expected_type || response.type),
      suggestions,
      required: response.required !== false,
      validation: response.validation,
      context: response.context || response.description,
    };
  }

  /**
   * Get ADCP status from response
   */
  getStatus(response: any): ADCPStatus | null {
    // Check A2A JSON-RPC wrapped status (result.status.state)
    if (response?.result?.status?.state && Object.values(ADCP_STATUS).includes(response.result.status.state)) {
      return response.result.status.state as ADCPStatus;
    }

    // Check top-level status first (A2A and direct responses)
    if (response?.status && Object.values(ADCP_STATUS).includes(response.status)) {
      return response.status as ADCPStatus;
    }

    // Check MCP structuredContent.status.
    // Exclusive task-lifecycle statuses (submitted/working/input-required/
    // auth-required) never appear in domain enums and are trusted unconditionally.
    // Shared literals (completed/canceled/failed/rejected) collide with AdCP v3
    // domain status enums like MediaBuyStatus, so we only treat them as task
    // status when the envelope has no keys outside the task-envelope allowlist.
    // Otherwise we fall through to the structuredContent fallback below, so Zod
    // validators parse the domain payload. See issue #646.
    const sc = response?.structuredContent;
    if (sc?.status && Object.values(ADCP_STATUS).includes(sc.status)) {
      if (EXCLUSIVE_TASK_STATUSES.has(sc.status)) {
        return sc.status as ADCPStatus;
      }
      const hasDomainPayload = Object.keys(sc).some(k => !TASK_ENVELOPE_FIELDS.has(k));
      if (!hasDomainPayload) {
        return sc.status as ADCPStatus;
      }
      // Domain payload present alongside a shared-literal status — fall through.
    }

    // Check for MCP error responses
    if (response?.isError === true) {
      return ADCP_STATUS.FAILED;
    }

    // If response has structuredContent or content, assume it's completed
    if (response?.structuredContent || (response?.content && !response?.isError)) {
      return ADCP_STATUS.COMPLETED;
    }

    return null;
  }

  /**
   * Extract the `replayed` field from a protocol response envelope.
   *
   * Returns `true` if the seller set `replayed: true` on the envelope,
   * `false` if explicitly set to `false`, `undefined` if not present. Callers
   * with side effects on response (notifications, LLM memory writes, downstream
   * tool calls) MUST treat `undefined` as `false` — the spec says fresh
   * executions MAY omit the field.
   */
  getReplayed(response: any): boolean | undefined {
    if (response == null) return undefined;

    // A2A JSON-RPC wrapped
    if (response.result && typeof response.result.replayed === 'boolean') {
      return response.result.replayed;
    }

    // MCP structuredContent
    if (response.structuredContent && typeof response.structuredContent.replayed === 'boolean') {
      return response.structuredContent.replayed;
    }

    // Top-level envelope (A2A direct, REST)
    if (typeof response.replayed === 'boolean') {
      return response.replayed;
    }

    return undefined;
  }

  /**
   * Extract the A2A `contextId` / AdCP `context_id` that binds the response
   * to a server-side conversation. Buyers retain this across calls on the
   * same AgentClient so the server can route subsequent sends to the same
   * session. Returns `undefined` when the server did not surface one (e.g.,
   * MCP completed responses that don't need conversation continuity).
   *
   * Values that fail {@link isSafeSessionId} (overlong, control characters,
   * non-string) are rejected and return `undefined` — retention falls back
   * to the previously retained id. The server is the authoritative issuer
   * but a compromised or buggy seller shouldn't be able to exhaust buyer
   * memory or inject control sequences into buyer debug logs.
   */
  getContextId(response: any): string | undefined {
    if (response == null) return undefined;

    // A2A sendMessage returns either a Task (has `contextId`) or a Message
    // (may have `contextId`). With the A2AClient SDK these arrive unwrapped
    // on `response.result`; some transports surface them directly on the
    // response envelope, so check both.
    if (response.result) {
      const fromResult = firstSafeSessionId(response.result.contextId, response.result.context_id);
      if (fromResult) return fromResult;
    }
    const fromEnvelope = firstSafeSessionId(response.contextId);
    if (fromEnvelope) return fromEnvelope;

    // MCP structuredContent / top-level AdCP envelope.
    const sc = response.structuredContent;
    if (sc) {
      const fromSc = firstSafeSessionId(sc.context_id);
      if (fromSc) return fromSc;
    }
    return firstSafeSessionId(response.context_id);
  }

  /**
   * Extract the A2A `taskId` for the task the server is tracking (or just
   * created) for this send. Retained across calls only while the last
   * response was non-terminal (working / input-required / submitted /
   * auth-required) so buyers can resume the same server-side task; cleared
   * by the caller on terminal responses.
   *
   * Same sanitization rules as {@link getContextId}: malformed ids return
   * `undefined`.
   */
  getTaskId(response: any): string | undefined {
    if (response == null) return undefined;

    if (response.result) {
      // A2A Task result carries its own id; Message results carry `taskId`
      // when bound to a task.
      if (response.result.kind === 'task') {
        const taskKindId = firstSafeSessionId(response.result.id);
        if (taskKindId) return taskKindId;
      }
      const fromResult = firstSafeSessionId(
        response.result.taskId,
        response.result.id,
        response.result.task_id
      );
      if (fromResult) return fromResult;
    }
    const fromEnvelope = firstSafeSessionId(response.taskId);
    if (fromEnvelope) return fromEnvelope;

    const sc = response.structuredContent;
    if (sc) {
      const fromSc = firstSafeSessionId(sc.task_id);
      if (fromSc) return fromSc;
    }
    return firstSafeSessionId(response.task_id);
  }

  private parseExpectedType(rawType: unknown): 'string' | 'number' | 'boolean' | 'object' | 'array' | undefined {
    if (typeof rawType === 'string') {
      const allowedTypes: string[] = ['string', 'number', 'boolean', 'object', 'array'];
      return allowedTypes.includes(rawType)
        ? (rawType as 'string' | 'number' | 'boolean' | 'object' | 'array')
        : undefined;
    }
    return undefined;
  }
}

// Export singleton instance
export const responseParser = new ProtocolResponseParser();
