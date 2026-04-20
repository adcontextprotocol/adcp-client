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
    //
    // Several ADCP_STATUS literals (completed, canceled, failed, rejected) also
    // appear as values in domain status enums (e.g. MediaBuyStatus). When a
    // seller returns a spec-compliant domain envelope like
    //   { status: "canceled", media_buy: {...}, adcp_version: "3.0.0" }
    // we must NOT classify that as an MCP task status, or TaskExecutor's
    // terminal-state branches short-circuit the response with data:undefined
    // and skip Zod validation. See issue #646.
    //
    // Heuristic: only treat structuredContent.status as an ADCP task status
    // when the envelope looks like a plain task wrapper — i.e. contains only
    // task-envelope keys. Any domain payload key present alongside `status`
    // means this is a domain response; fall through so it's classified as
    // COMPLETED and validators run on the payload.
    const sc = response?.structuredContent;
    if (sc?.status && Object.values(ADCP_STATUS).includes(sc.status)) {
      const TASK_ENVELOPE_KEYS = new Set([
        'status',
        'message',
        'messages',
        'errors',
        'warnings',
        'adcp_version',
        'context_id',
        'task_id',
        'task_status',
        'replayed',
      ]);
      const hasDomainPayload = Object.keys(sc).some((k) => !TASK_ENVELOPE_KEYS.has(k));
      if (!hasDomainPayload) {
        return sc.status as ADCPStatus;
      }
      // Exception: preserve the task-lifecycle states that are never domain
      // enum values, even when a domain payload is attached (e.g. a server
      // returning partial data while still working).
      const TASK_ONLY_STATES: string[] = [
        ADCP_STATUS.SUBMITTED,
        ADCP_STATUS.WORKING,
        ADCP_STATUS.INPUT_REQUIRED,
        ADCP_STATUS.AUTH_REQUIRED,
      ];
      if (TASK_ONLY_STATES.includes(sc.status)) {
        return sc.status as ADCPStatus;
      }
      // Shared literal (completed/canceled/failed/rejected) + domain payload
      // → fall through to the "has structuredContent → COMPLETED" branch.
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
