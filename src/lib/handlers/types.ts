// Input handler types and utilities for ADCP conversation flow

import type { InputHandler, InputHandlerResponse, ConversationContext } from '../core/ConversationTypes';

/**
 * Pre-built input handler for automatic approval
 * Always returns true for any input request
 */
export const autoApproveHandler: InputHandler = (context: ConversationContext) => {
  return true;
};

/**
 * Pre-built input handler that defers everything to humans
 * Useful for production scenarios where human oversight is required
 */
export const deferAllHandler: InputHandler = async (context: ConversationContext) => {
  return context.deferToHuman();
};

/**
 * Field-specific handler configuration
 */
export interface FieldHandlerConfig {
  [fieldName: string]: any | ((context: ConversationContext) => any);
}

/**
 * Create a field-specific handler that provides different responses based on the field being requested
 *
 * @param fieldMap - Map of field names to responses or response functions
 * @param defaultResponse - Default response for unmapped fields (defaults to defer)
 *
 * @example
 * ```typescript
 * const handler = createFieldHandler({
 *   budget: 50000,
 *   targeting: ['US', 'CA'],
 *   approval: (context) => context.attempt === 1 ? true : false
 * });
 * ```
 */
export function createFieldHandler(fieldMap: FieldHandlerConfig, defaultResponse?: any | InputHandler): InputHandler {
  return async (context: ConversationContext) => {
    const field = context.inputRequest.field;

    if (field && field in fieldMap) {
      const response = fieldMap[field];
      if (typeof response === 'function') {
        return response(context);
      }
      return response;
    }

    // Use default response or defer to human
    if (defaultResponse !== undefined) {
      if (typeof defaultResponse === 'function') {
        return defaultResponse(context);
      }
      return defaultResponse;
    }

    return context.deferToHuman();
  };
}

/**
 * Create a conditional handler that applies different logic based on context
 *
 * @param conditions - Array of condition/handler pairs
 * @param defaultHandler - Handler to use if no conditions match
 *
 * @example
 * ```typescript
 * const handler = createConditionalHandler([
 *   {
 *     condition: (ctx) => ctx.inputRequest.field === 'budget',
 *     handler: (ctx) => ctx.attempt === 1 ? 100000 : 50000
 *   },
 *   {
 *     condition: (ctx) => ctx.agent.name.includes('Premium'),
 *     handler: autoApproveHandler
 *   }
 * ], deferAllHandler);
 * ```
 */
export function createConditionalHandler(
  conditions: Array<{
    condition: (context: ConversationContext) => boolean;
    handler: InputHandler;
  }>,
  defaultHandler: InputHandler = deferAllHandler
): InputHandler {
  return async (context: ConversationContext) => {
    for (const { condition, handler } of conditions) {
      if (condition(context)) {
        return handler(context);
      }
    }
    return defaultHandler(context);
  };
}

/**
 * Create a retry handler that provides different responses based on attempt number
 *
 * @param responses - Array of responses for each attempt (1-indexed)
 * @param defaultResponse - Response to use for attempts beyond the array length
 *
 * @example
 * ```typescript
 * const handler = createRetryHandler([
 *   100000,  // First attempt
 *   50000,   // Second attempt
 *   25000    // Third attempt
 * ], deferAllHandler);
 * ```
 */
export function createRetryHandler(responses: any[], defaultResponse: any | InputHandler = deferAllHandler): InputHandler {
  return async (context: ConversationContext) => {
    const attemptIndex = context.attempt - 1;

    if (attemptIndex < responses.length) {
      const response = responses[attemptIndex];
      if (typeof response === 'function') {
        return response(context);
      }
      return response;
    }

    if (typeof defaultResponse === 'function') {
      return defaultResponse(context);
    }
    return defaultResponse;
  };
}

/**
 * Create a suggestion-based handler that uses agent suggestions when available
 *
 * @param suggestionIndex - Index of suggestion to use (0 = first, -1 = last)
 * @param fallbackHandler - Handler to use if no suggestions available
 *
 * @example
 * ```typescript
 * const handler = createSuggestionHandler(0, deferAllHandler); // Use first suggestion
 * ```
 */
export function createSuggestionHandler(suggestionIndex: number = 0, fallbackHandler: InputHandler = deferAllHandler): InputHandler {
  return async (context: ConversationContext) => {
    const suggestions = context.inputRequest.suggestions;

    if (suggestions && suggestions.length > 0) {
      if (suggestionIndex === -1) {
        return suggestions[suggestions.length - 1];
      }
      if (suggestionIndex >= 0 && suggestionIndex < suggestions.length) {
        return suggestions[suggestionIndex];
      }
    }

    return fallbackHandler(context);
  };
}

/**
 * Create a validation-aware handler that respects input validation rules
 *
 * @param value - Value to return
 * @param fallbackHandler - Handler to use if value doesn't pass validation
 */
export function createValidatedHandler(value: any, fallbackHandler: InputHandler = deferAllHandler): InputHandler {
  return async (context: ConversationContext) => {
    const validation = context.inputRequest.validation;

    if (!validation) {
      return value;
    }

    // Basic validation checks
    if (validation.enum && !validation.enum.includes(value)) {
      return fallbackHandler(context);
    }

    if (typeof value === 'number') {
      if (validation.min !== undefined && value < validation.min) {
        return fallbackHandler(context);
      }
      if (validation.max !== undefined && value > validation.max) {
        return fallbackHandler(context);
      }
    }

    if (typeof value === 'string' && validation.pattern) {
      const regex = new RegExp(validation.pattern);
      if (!regex.test(value)) {
        return fallbackHandler(context);
      }
    }

    return value;
  };
}

/**
 * Combine multiple handlers with fallback logic
 * Tries each handler in order until one succeeds (doesn't defer or abort)
 *
 * @param handlers - Array of handlers to try in order
 * @param defaultHandler - Final fallback handler
 */
export function combineHandlers(handlers: InputHandler[], defaultHandler: InputHandler = deferAllHandler): InputHandler {
  return async (context: ConversationContext) => {
    for (const handler of handlers) {
      try {
        const result = await handler(context);

        // If result is a defer object, try next handler
        if (typeof result === 'object' && result?.defer === true) {
          continue;
        }

        // If result is an abort object, try next handler
        if (typeof result === 'object' && result?.abort === true) {
          continue;
        }

        return result;
      } catch (error) {
        // If handler throws, try next one
        continue;
      }
    }

    return defaultHandler(context);
  };
}

/**
 * Type guard to check if a response is a defer response
 */
export function isDeferResponse(response: any): response is { defer: true; token: string } {
  return typeof response === 'object' && response?.defer === true && typeof response?.token === 'string';
}

/**
 * Type guard to check if a response is an abort response
 */
export function isAbortResponse(response: any): response is { abort: true; reason?: string } {
  return typeof response === 'object' && response?.abort === true;
}

/**
 * Utility to normalize handler responses
 */
export async function normalizeHandlerResponse(response: InputHandlerResponse, context: ConversationContext): Promise<any> {
  const resolved = await response;

  if (isDeferResponse(resolved)) {
    throw new Error(`Task deferred with token: ${resolved.token}`);
  }

  if (isAbortResponse(resolved)) {
    throw new Error(`Task aborted: ${resolved.reason || 'No reason provided'}`);
  }

  return resolved;
}
