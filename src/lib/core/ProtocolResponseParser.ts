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
    // ADCP spec: check status field first
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
    // Check top-level status first (flat format - legacy or direct status)
    if (response?.status && Object.values(ADCP_STATUS).includes(response.status)) {
      return response.status as ADCPStatus;
    }

    // Check A2A Task.status.state (when Task object passed directly)
    // A2A Task objects have kind='task' and status.state field
    if (
      response?.kind === 'task' &&
      response?.status?.state &&
      Object.values(ADCP_STATUS).includes(response.status.state)
    ) {
      return response.status.state as ADCPStatus;
    }

    // Check A2A JSON-RPC response with Task result
    // SendMessageSuccessResponse has result which can be Task | Message
    if (
      response?.result?.kind === 'task' &&
      response?.result?.status?.state &&
      Object.values(ADCP_STATUS).includes(response.result.status.state)
    ) {
      return response.result.status.state as ADCPStatus;
    }

    // Check A2A JSON-RPC response with Message result (completed synchronously)
    // If result is a Message, the task completed immediately
    if (response?.result?.kind === 'message') {
      return ADCP_STATUS.COMPLETED;
    }

    // Check MCP structuredContent.status
    if (response?.structuredContent?.status && Object.values(ADCP_STATUS).includes(response.structuredContent.status)) {
      return response.structuredContent.status as ADCPStatus;
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

  private parseExpectedType(rawType: any): 'string' | 'number' | 'boolean' | 'object' | 'array' | undefined {
    if (typeof rawType === 'string') {
      const allowedTypes = ['string', 'number', 'boolean', 'object', 'array'];
      return allowedTypes.includes(rawType) ? (rawType as any) : undefined;
    }
    return undefined;
  }
}

// Export singleton instance
export const responseParser = new ProtocolResponseParser();
