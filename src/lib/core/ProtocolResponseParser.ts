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
