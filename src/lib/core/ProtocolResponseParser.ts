// Protocol-specific response parser for ADCP
// Implements standardized status field detection as per ADCP spec PR #77

import type { InputRequest } from './ConversationTypes';

/**
 * Standardized ADCP response status values
 * As per ADCP spec update for consistent status across A2A and MCP
 */
export enum ResponseStatus {
  /** Task completed successfully */
  COMPLETED = 'completed',
  /** Agent needs input/clarification */
  NEEDS_INPUT = 'needs_input',
  /** Task is in progress */
  IN_PROGRESS = 'in_progress',
  /** Task failed */
  FAILED = 'failed',
  /** Task was cancelled */
  CANCELLED = 'cancelled'
}

/**
 * Protocol-specific parser configuration
 */
export interface ProtocolParserConfig {
  /** Custom status field names to check */
  statusFields?: string[];
  /** Custom input request indicators */
  inputIndicators?: string[];
  /** Whether to use legacy detection patterns */
  useLegacyPatterns?: boolean;
  /** Custom parser function */
  customParser?: (response: any) => boolean;
}

/**
 * Agent-specific parser configuration
 */
export interface AgentParserConfig {
  [agentId: string]: ProtocolParserConfig;
}

/**
 * Response parser that handles protocol and agent-specific detection
 */
export class ProtocolResponseParser {
  private defaultConfig: Record<'mcp' | 'a2a', ProtocolParserConfig> = {
    mcp: {
      statusFields: ['status', 'state'],
      inputIndicators: ['needs_input', 'input_required', 'requires_input'],
      useLegacyPatterns: true
    },
    a2a: {
      statusFields: ['status', 'state'],
      inputIndicators: ['needs_input', 'input_required', 'requires_input'],
      useLegacyPatterns: true
    }
  };

  private agentConfigs: AgentParserConfig = {};

  /**
   * Register custom parser configuration for a specific agent
   */
  registerAgentConfig(agentId: string, config: ProtocolParserConfig): void {
    this.agentConfigs[agentId] = config;
  }

  /**
   * Register custom parser configuration for a protocol
   */
  registerProtocolConfig(protocol: 'mcp' | 'a2a', config: ProtocolParserConfig): void {
    this.defaultConfig[protocol] = { ...this.defaultConfig[protocol], ...config };
  }

  /**
   * Check if response indicates input is needed
   */
  isInputRequest(
    response: any,
    protocol: 'mcp' | 'a2a',
    agentId?: string
  ): boolean {
    // Get configuration (agent-specific overrides protocol-specific)
    const config = agentId && this.agentConfigs[agentId]
      ? this.agentConfigs[agentId]
      : this.defaultConfig[protocol];

    // Use custom parser if provided
    if (config.customParser) {
      return config.customParser(response);
    }

    // Check standardized status field (ADCP spec compliant)
    if (this.hasStandardizedStatus(response, config)) {
      return this.getStandardizedStatus(response, config) === ResponseStatus.NEEDS_INPUT;
    }

    // Check input indicators
    if (this.hasInputIndicators(response, config)) {
      return true;
    }

    // Use legacy patterns if enabled
    if (config.useLegacyPatterns) {
      return this.checkLegacyPatterns(response);
    }

    return false;
  }

  /**
   * Parse input request details from response
   */
  parseInputRequest(response: any, protocol?: 'mcp' | 'a2a'): InputRequest {
    // Handle standardized format first
    if (response.input_request) {
      return this.parseStandardizedInputRequest(response.input_request);
    }

    // Handle various response formats
    return {
      question: this.extractQuestion(response),
      field: this.extractField(response),
      expectedType: this.extractExpectedType(response),
      suggestions: this.extractSuggestions(response),
      required: this.extractRequired(response),
      validation: this.extractValidation(response),
      context: this.extractContext(response)
    };
  }

  /**
   * Get the response status
   */
  getResponseStatus(
    response: any,
    protocol: 'mcp' | 'a2a',
    agentId?: string
  ): ResponseStatus | null {
    const config = agentId && this.agentConfigs[agentId]
      ? this.agentConfigs[agentId]
      : this.defaultConfig[protocol];

    if (this.hasStandardizedStatus(response, config)) {
      return this.getStandardizedStatus(response, config) as ResponseStatus;
    }

    // Try to infer status from other fields
    if (this.isInputRequest(response, protocol, agentId)) {
      return ResponseStatus.NEEDS_INPUT;
    }

    if (response.error || response.failed) {
      return ResponseStatus.FAILED;
    }

    if (response.cancelled) {
      return ResponseStatus.CANCELLED;
    }

    if (response.in_progress || response.pending) {
      return ResponseStatus.IN_PROGRESS;
    }

    // Default to completed if we have a response
    return ResponseStatus.COMPLETED;
  }

  // Private helper methods

  private hasStandardizedStatus(response: any, config: ProtocolParserConfig): boolean {
    if (!response || !config.statusFields) return false;
    
    return config.statusFields.some(field => 
      response[field] !== undefined && 
      Object.values(ResponseStatus).includes(response[field])
    );
  }

  private getStandardizedStatus(response: any, config: ProtocolParserConfig): string | null {
    if (!config.statusFields) return null;
    
    for (const field of config.statusFields) {
      if (response[field] && Object.values(ResponseStatus).includes(response[field])) {
        return response[field];
      }
    }
    return null;
  }

  private hasInputIndicators(response: any, config: ProtocolParserConfig): boolean {
    if (!response || !config.inputIndicators) return false;
    
    // Check status fields for input indicators
    if (config.statusFields) {
      for (const field of config.statusFields) {
        if (config.inputIndicators.includes(response[field])) {
          return true;
        }
      }
    }

    // Check top-level input indicators
    return config.inputIndicators.some(indicator => 
      response[indicator] === true || response.type === indicator
    );
  }

  private checkLegacyPatterns(response: any): boolean {
    if (!response) return false;

    // Legacy pattern detection (backward compatibility)
    return (
      response.type === 'input_request' ||
      response.question !== undefined ||
      response.input_required === true ||
      response.needs_clarification === true ||
      response.awaiting_input === true ||
      (response.message && response.choices) || // Common prompt pattern
      (response.prompt && !response.result)     // Incomplete execution pattern
    );
  }

  private parseStandardizedInputRequest(request: any): InputRequest {
    const rawType = request.type || request.expected_type;
    const allowedTypes = ["string", "number", "boolean", "object", "array"];
    const expectedType = rawType && allowedTypes.includes(rawType) ? rawType : undefined;
    
    return {
      question: request.question || request.prompt || 'Please provide input',
      field: request.field,
      expectedType: expectedType as "string" | "number" | "boolean" | "object" | "array" | undefined,
      suggestions: request.suggestions || request.options || request.choices,
      required: request.required !== false,
      validation: request.validation || request.constraints,
      context: request.context || request.description || request.hint
    };
  }

  private extractQuestion(response: any): string {
    return response.question ||
           response.prompt ||
           response.message ||
           response.text ||
           response.input_request?.question ||
           'Please provide input';
  }

  private extractField(response: any): string | undefined {
    return response.field ||
           response.parameter ||
           response.param ||
           response.key ||
           response.input_request?.field;
  }

  private extractExpectedType(response: any): "string" | "number" | "boolean" | "object" | "array" | undefined {
    const raw = response.expected_type ||
           response.type ||
           response.dataType ||
           response.input_type ||
           response.input_request?.type;
    
    // Validate it's an allowed type
    const allowedTypes = ["string", "number", "boolean", "object", "array"];
    if (raw && allowedTypes.includes(raw)) {
      return raw as "string" | "number" | "boolean" | "object" | "array";
    }
    return undefined;
  }

  private extractSuggestions(response: any): any[] | undefined {
    return response.suggestions ||
           response.options ||
           response.choices ||
           response.values ||
           response.input_request?.suggestions;
  }

  private extractRequired(response: any): boolean {
    if (response.required !== undefined) return response.required;
    if (response.optional !== undefined) return !response.optional;
    if (response.input_request?.required !== undefined) {
      return response.input_request.required;
    }
    return true; // Default to required
  }

  private extractValidation(response: any): any | undefined {
    return response.validation ||
           response.constraints ||
           response.rules ||
           response.schema ||
           response.input_request?.validation;
  }

  private extractContext(response: any): string | undefined {
    return response.context ||
           response.hint ||
           response.description ||
           response.help ||
           response.info ||
           response.input_request?.context;
  }
}

// Export singleton instance for convenience
export const responseParser = new ProtocolResponseParser();
