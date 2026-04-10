/**
 * Response validator for agent responses
 *
 * Validates that agent responses match expected structures for both
 * MCP and A2A protocols, and validates data against AdCP schemas.
 */

import { z } from 'zod';
import { getBestUnionErrors } from '../utils/union-errors';
import { TOOL_RESPONSE_SCHEMAS } from '../utils/response-schemas';

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  protocol?: 'mcp' | 'a2a' | 'unknown';
  schemaErrors?: z.ZodIssue[];
}

export interface ValidationOptions {
  /** Enable strict mode - fail on warnings */
  strict?: boolean;
  /** Expected data fields (e.g., ['products'] for get_products) */
  expectedFields?: string[];
  /** Allow empty responses */
  allowEmpty?: boolean;
  /** Validate against AdCP Zod schemas */
  validateSchema?: boolean;
}

export class ResponseValidator {
  /**
   * Validate an agent response structure
   */
  validate(response: any, toolName?: string, options: ValidationOptions = {}): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];
    let protocol: 'mcp' | 'a2a' | 'unknown' = 'unknown';

    if (!response) {
      errors.push('Response is null or undefined');
      return { valid: false, errors, warnings, protocol };
    }

    // Detect protocol
    // A2A responses have either result.artifacts or error at top level
    if (response.result || response.error || response.jsonrpc) {
      protocol = 'a2a';
      this.validateA2AResponse(response, errors, warnings);
    } else if (response.structuredContent || response.content) {
      protocol = 'mcp';
      this.validateMCPResponse(response, errors, warnings);
    } else if (response.data) {
      warnings.push('Response has data field but unknown protocol');
    } else {
      warnings.push('Response does not match MCP or A2A structure');
    }

    // Check for expected fields if provided
    if (options.expectedFields && options.expectedFields.length > 0) {
      this.validateExpectedFields(response, options.expectedFields, protocol, errors, warnings);
    }

    // Check for empty responses
    if (!options.allowEmpty) {
      this.validateNotEmpty(response, protocol, warnings);
    }

    // Schema validation if enabled
    let schemaErrors: z.ZodIssue[] | undefined;
    if (options.validateSchema !== false && toolName) {
      const schemaResult = this.validateWithSchema(response, toolName, protocol);
      if (schemaResult) {
        schemaErrors = schemaResult.issues;

        // Union schemas produce a single unhelpful "(root): Invalid input" error.
        // Drill into variants to find the closest match's specific field errors.
        const isUnionError =
          schemaResult.issues.length === 1 &&
          schemaResult.issues[0]?.code === 'invalid_union' &&
          schemaResult.issues[0]?.path.length === 0;

        if (isUnionError) {
          const schema = this.getSchemaForTool(toolName);
          const data = this.extractDataForValidation(response, protocol);
          if (schema && data) {
            const betterErrors = getBestUnionErrors(schema, data);
            if (betterErrors && betterErrors.length > 0) {
              betterErrors.forEach(v => {
                errors.push(`Schema validation: ${v.path}: ${v.message}`);
              });
              return { valid: false, errors, warnings, protocol, schemaErrors };
            }
          }
        }

        schemaResult.issues.forEach(issue => {
          const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
          errors.push(`Schema validation: ${path}: ${issue.message}`);
        });
      }
    }

    const valid = errors.length === 0 && (!options.strict || warnings.length === 0);
    return { valid, errors, warnings, protocol, schemaErrors };
  }

  /**
   * Validate MCP response structure
   */
  private validateMCPResponse(response: any, errors: string[], warnings: string[]): void {
    // Check for error indicator
    if (response.isError === true) {
      errors.push('MCP response indicates error (isError: true)');
    }

    // Validate structuredContent if present
    if (response.structuredContent) {
      if (typeof response.structuredContent !== 'object') {
        errors.push('MCP structuredContent must be an object');
      }
    }

    // Validate content array if present
    if (response.content) {
      if (!Array.isArray(response.content)) {
        errors.push('MCP content must be an array');
      } else {
        response.content.forEach((item: any, index: number) => {
          if (!item.type) {
            warnings.push(`MCP content[${index}] missing type field`);
          }
        });
      }
    }

    // Should have either content or structuredContent
    if (!response.content && !response.structuredContent) {
      warnings.push('MCP response has neither content nor structuredContent');
    }
  }

  /**
   * Validate A2A response structure
   */
  private validateA2AResponse(response: any, errors: string[], warnings: string[]): void {
    // Check for JSON-RPC error
    if (response.error) {
      const errorMsg = response.error.message || JSON.stringify(response.error);
      errors.push(`A2A JSON-RPC error: ${errorMsg}`);
      return;
    }

    // Validate result structure
    if (!response.result) {
      errors.push('A2A response missing result field');
      return;
    }

    // Validate artifacts
    if (!response.result.artifacts) {
      errors.push('A2A response missing result.artifacts field');
      return;
    }

    if (!Array.isArray(response.result.artifacts)) {
      errors.push('A2A result.artifacts must be an array');
      return;
    }

    if (response.result.artifacts.length === 0) {
      warnings.push('A2A artifacts array is empty');
      return;
    }

    // Validate first artifact structure
    const firstArtifact = response.result.artifacts[0];
    if (!firstArtifact.parts) {
      errors.push('A2A artifact missing parts field');
      return;
    }

    if (!Array.isArray(firstArtifact.parts)) {
      errors.push('A2A artifact.parts must be an array');
      return;
    }

    if (firstArtifact.parts.length === 0) {
      warnings.push('A2A artifact parts array is empty');
      return;
    }

    // Validate first part
    const firstPart = firstArtifact.parts[0];
    if (!firstPart.kind && !firstPart.type) {
      warnings.push('A2A part missing kind/type field');
    }

    if (!firstPart.data) {
      warnings.push('A2A part missing data field');
    }
  }

  /**
   * Validate expected fields are present in the response
   */
  private validateExpectedFields(
    response: any,
    expectedFields: string[],
    protocol: string,
    errors: string[],
    warnings: string[]
  ): void {
    let data: any;

    // Extract data based on protocol
    if (protocol === 'mcp') {
      data = response.structuredContent;
    } else if (protocol === 'a2a') {
      data = response.result?.artifacts?.[0]?.parts?.[0]?.data;
    } else {
      data = response.data || response;
    }

    if (!data) {
      errors.push('Cannot validate fields: no data extracted');
      return;
    }

    // Check each expected field
    expectedFields.forEach(field => {
      if (!(field in data)) {
        errors.push(`Missing expected field: ${field}`);
      } else if (Array.isArray(data[field]) && data[field].length === 0) {
        warnings.push(`Field ${field} is an empty array`);
      }
    });
  }

  /**
   * Validate response is not empty
   */
  private validateNotEmpty(response: any, protocol: string, warnings: string[]): void {
    if (protocol === 'mcp' && response.structuredContent) {
      const keys = Object.keys(response.structuredContent);
      if (keys.length === 0) {
        warnings.push('MCP structuredContent is empty object');
      }
    }

    if (protocol === 'a2a' && response.result?.artifacts?.[0]?.parts?.[0]?.data) {
      const data = response.result.artifacts[0].parts[0].data;
      const keys = Object.keys(data);
      if (keys.length === 0) {
        warnings.push('A2A data is empty object');
      }
    }
  }

  /**
   * Quick validation helper - returns true if valid, throws if invalid
   */
  validateOrThrow(response: any, toolName?: string, options: ValidationOptions = {}): void {
    const result = this.validate(response, toolName, options);
    if (!result.valid) {
      const errorMsg = result.errors.join('; ');
      throw new Error(`Response validation failed: ${errorMsg}`);
    }
  }

  /**
   * Check if a response looks like a valid protocol response
   */
  isValidProtocolResponse(response: any): boolean {
    if (!response || typeof response !== 'object') {
      return false;
    }

    // MCP indicators
    if (response.structuredContent || response.content) {
      return true;
    }

    // A2A indicators
    if (response.result?.artifacts) {
      return true;
    }

    // Generic data response
    if (response.data) {
      return true;
    }

    return false;
  }

  /**
   * Extract response data based on protocol for validation.
   */
  private extractDataForValidation(response: any, protocol: string): any {
    if (protocol === 'mcp') {
      return response.structuredContent;
    } else if (protocol === 'a2a') {
      return response.result?.artifacts?.[0]?.parts?.[0]?.data;
    } else {
      return response.data || response;
    }
  }

  /**
   * Validate response data against AdCP Zod schema
   */
  private validateWithSchema(response: any, toolName: string, protocol: string): z.ZodError | null {
    const data = this.extractDataForValidation(response, protocol);

    if (!data) {
      return null; // No data to validate
    }

    // Get schema for tool
    const schema = this.getSchemaForTool(toolName);
    if (!schema) {
      return null; // No schema available for this tool
    }

    // Validate
    const result = schema.safeParse(data);
    return result.success ? null : result.error;
  }

  /**
   * Get Zod schema for a given tool
   */
  private getSchemaForTool(toolName: string): z.ZodSchema | null {
    return TOOL_RESPONSE_SCHEMAS[toolName] || null;
  }
}

// Export singleton instance
export const responseValidator = new ResponseValidator();
