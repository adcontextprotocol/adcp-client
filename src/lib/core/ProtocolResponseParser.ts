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

type AnyRecord = Record<string, unknown>;

function asRecord(value: unknown): AnyRecord | undefined {
  return (typeof value === 'object' && value !== null) ? value as AnyRecord : undefined;
}

/**
 * Simple parser that follows ADCP spec exactly
 */
export class ProtocolResponseParser {
  /**
   * Check if response indicates input is needed per ADCP spec
   */
  isInputRequest(response: unknown): boolean {
    const r = asRecord(response);
    if (!r) return false;

    // ADCP spec: check A2A JSON-RPC wrapped status first
    const result = asRecord(r.result);
    const status = asRecord(result?.status);
    if (status?.state === ADCP_STATUS.INPUT_REQUIRED) {
      return true;
    }

    // ADCP spec: check top-level status field
    if (r.status === ADCP_STATUS.INPUT_REQUIRED) {
      return true;
    }

    // Legacy fallback for backward compatibility
    return (
      r.type === 'input_request' ||
      r.question !== undefined ||
      r.input_required === true ||
      r.needs_clarification === true
    );
  }

  /**
   * Parse input request from response
   */
  parseInputRequest(response: unknown): InputRequest {
    const r = asRecord(response) ?? {};
    const question = (r.message || r.question || r.prompt || 'Please provide input') as string;
    const field = (r.field || r.parameter) as string | undefined;
    const suggestions = (r.options || r.choices || r.suggestions) as string[] | undefined;

    return {
      question,
      field,
      expectedType: this.parseExpectedType(r.expected_type || r.type),
      suggestions,
      required: r.required !== false,
      validation: r.validation as Record<string, unknown> | undefined,
      context: (r.context || r.description) as string | undefined,
    };
  }

  /**
   * Get ADCP status from response
   */
  getStatus(response: unknown): ADCPStatus | null {
    const r = asRecord(response);
    if (!r) return null;

    const statusValues = Object.values(ADCP_STATUS) as string[];

    // Check A2A JSON-RPC wrapped status (result.status.state)
    const result = asRecord(r.result);
    const resultStatus = asRecord(result?.status);
    if (resultStatus?.state && statusValues.includes(resultStatus.state as string)) {
      return resultStatus.state as ADCPStatus;
    }

    // Check top-level status first (A2A and direct responses)
    if (r.status && statusValues.includes(r.status as string)) {
      return r.status as ADCPStatus;
    }

    // Check MCP structuredContent.status
    const structured = asRecord(r.structuredContent);
    if (structured?.status && statusValues.includes(structured.status as string)) {
      return structured.status as ADCPStatus;
    }

    // Check for MCP error responses
    if (r.isError === true) {
      return ADCP_STATUS.FAILED;
    }

    // If response has structuredContent or content, assume it's completed
    if (r.structuredContent || (r.content && !r.isError)) {
      return ADCP_STATUS.COMPLETED;
    }

    return null;
  }

  private parseExpectedType(rawType: unknown): 'string' | 'number' | 'boolean' | 'object' | 'array' | undefined {
    if (typeof rawType === 'string') {
      const allowedTypes: string[] = ['string', 'number', 'boolean', 'object', 'array'];
      return allowedTypes.includes(rawType) ? rawType as 'string' | 'number' | 'boolean' | 'object' | 'array' : undefined;
    }
    return undefined;
  }
}

// Export singleton instance
export const responseParser = new ProtocolResponseParser();
