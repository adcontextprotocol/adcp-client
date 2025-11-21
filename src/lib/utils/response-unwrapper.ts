/**
 * Response Unwrapper
 *
 * Extracts raw AdCP responses from protocol wrappers (MCP/A2A).
 * This ensures SDK responses match AdCP schema exactly without wrapping.
 */

/**
 * Extract raw AdCP response from protocol wrapper
 *
 * @param protocolResponse - Raw response from MCP or A2A protocol
 * @returns Raw AdCP response data matching schema exactly
 *
 * @example
 * // MCP response
 * const mcpResponse = {
 *   structuredContent: { packages: [...], media_buy_id: "..." }
 * };
 * const adcpResponse = unwrapProtocolResponse(mcpResponse);
 * // Returns: { packages: [...], media_buy_id: "..." }
 *
 * @example
 * // A2A response
 * const a2aResponse = {
 *   result: {
 *     artifacts: [{
 *       parts: [{
 *         data: { packages: [...], media_buy_id: "..." }
 *       }]
 *     }]
 *   }
 * };
 * const adcpResponse = unwrapProtocolResponse(a2aResponse);
 * // Returns: { packages: [...], media_buy_id: "..." }
 */
export function unwrapProtocolResponse(protocolResponse: any): any {
  if (!protocolResponse) {
    throw new Error('Protocol response is null or undefined');
  }

  // MCP protocol: extract from structuredContent
  if (protocolResponse.structuredContent !== undefined) {
    return protocolResponse.structuredContent;
  }

  // A2A protocol: extract from result.artifacts[0].parts[0].data
  if (protocolResponse.result?.artifacts?.[0]?.parts?.[0]?.data !== undefined) {
    return protocolResponse.result.artifacts[0].parts[0].data;
  }

  // A2A error response: check for error field
  if (protocolResponse.error) {
    // Convert JSON-RPC error to AdCP error format
    // AdCP uses { errors: [...] } for error responses
    return {
      errors: [{
        code: protocolResponse.error.code?.toString() || 'unknown',
        message: protocolResponse.error.message || 'Unknown error',
        ...(protocolResponse.error.data && { data: protocolResponse.error.data })
      }]
    };
  }

  // MCP error response: check for isError
  if (protocolResponse.isError === true) {
    const errorContent = Array.isArray(protocolResponse.content)
      ? protocolResponse.content.find((c: any) => c.type === 'text')?.text
      : protocolResponse.content?.text || 'Unknown error';

    return {
      errors: [{
        code: 'mcp_error',
        message: errorContent || 'MCP tool call failed'
      }]
    };
  }

  // If response has content but no structuredContent, it might be a plain text response
  if (protocolResponse.content && Array.isArray(protocolResponse.content)) {
    const textContent = protocolResponse.content.find((c: any) => c.type === 'text');
    if (textContent?.text) {
      // Try to parse as JSON (some agents return stringified JSON in text content)
      try {
        const parsed = JSON.parse(textContent.text);
        return parsed;
      } catch {
        // Not JSON, return as error
        return {
          errors: [{
            code: 'invalid_response',
            message: 'Response does not contain structured AdCP data'
          }]
        };
      }
    }
  }

  // If we can't find the data in expected locations, return the whole response
  // This allows for direct AdCP responses (when not wrapped in protocol)
  if (typeof protocolResponse === 'object' && !('structuredContent' in protocolResponse) && !('result' in protocolResponse)) {
    return protocolResponse;
  }

  throw new Error('Unable to extract AdCP response from protocol wrapper');
}

/**
 * Check if a response is an AdCP error response
 *
 * @param response - AdCP response to check
 * @returns true if response contains errors array
 */
export function isAdcpError(response: any): boolean {
  return Array.isArray(response?.errors) && response.errors.length > 0;
}

/**
 * Check if a response is an AdCP success response for a specific task
 *
 * @param response - AdCP response to check
 * @param taskName - Expected task name (e.g., 'create_media_buy', 'update_media_buy')
 * @returns true if response has required success fields for the task
 */
export function isAdcpSuccess(response: any, taskName: string): boolean {
  if (isAdcpError(response)) {
    return false;
  }

  // Task-specific validation based on AdCP schemas
  switch (taskName) {
    case 'create_media_buy':
      return !!(response.packages && response.media_buy_id);

    case 'update_media_buy':
      return !!response.affected_packages;

    case 'get_products':
      return Array.isArray(response.products);

    case 'list_creative_formats':
      return Array.isArray(response.formats);

    case 'sync_creatives':
      return Array.isArray(response.creatives);

    case 'list_creatives':
      return Array.isArray(response.creatives);

    case 'get_media_buy_delivery':
      return !!response.delivery;

    case 'list_authorized_properties':
      return Array.isArray(response.properties);

    case 'provide_performance_feedback':
      return response.status === 'received' || response.status === 'acknowledged';

    case 'get_signals':
      return Array.isArray(response.signals);

    case 'activate_signal':
      return !!response.signal_id;

    default:
      // Unknown task, can't validate
      return true;
  }
}
