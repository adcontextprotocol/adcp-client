/**
 * Simple ADCP-compliant response parser
 * Implements ADCP spec PR #77 for standardized status field
 */

import type { InputRequest } from './ConversationTypes';

/**
 * ADCP standardized status values as per spec PR #77
 */
export const ADCP_STATUS = {
  SUBMITTED: 'submitted',
  WORKING: 'working', 
  INPUT_REQUIRED: 'input-required',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELED: 'canceled',
  REJECTED: 'rejected',
  AUTH_REQUIRED: 'auth-required',
  UNKNOWN: 'unknown'
} as const;

export type ADCPStatus = typeof ADCP_STATUS[keyof typeof ADCP_STATUS];

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
      context: response.context || response.description
    };
  }

  /**
   * Get ADCP status from response
   */
  getStatus(response: any): ADCPStatus | null {
    if (response?.status && Object.values(ADCP_STATUS).includes(response.status)) {
      return response.status as ADCPStatus;
    }
    return null;
  }

  private parseExpectedType(rawType: any): "string" | "number" | "boolean" | "object" | "array" | undefined {
    if (typeof rawType === 'string') {
      const allowedTypes = ["string", "number", "boolean", "object", "array"];
      return allowedTypes.includes(rawType) ? rawType as any : undefined;
    }
    return undefined;
  }
}

// Export singleton instance
export const responseParser = new ProtocolResponseParser();