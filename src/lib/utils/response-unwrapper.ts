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
 * @param toolName - Optional AdCP tool name for validation (e.g., 'get_products')
 * @returns Raw AdCP response data matching schema exactly
 *
 * @example
 * // MCP response
 * const mcpResponse = {
 *   structuredContent: { packages: [...], media_buy_id: "..." }
 * };
 * const adcpResponse = unwrapProtocolResponse(mcpResponse, 'get_products');
 * // Returns: { packages: [...], media_buy_id: "..." }
 *
 * @example
 * // A2A response (simple)
 * const a2aResponse = {
 *   result: {
 *     artifacts: [{
 *       parts: [{
 *         data: { packages: [...], media_buy_id: "..." }
 *       }]
 *     }]
 *   }
 * };
 * const adcpResponse = unwrapProtocolResponse(a2aResponse, 'get_products');
 * // Returns: { packages: [...], media_buy_id: "..." }
 *
 * @example
 * // A2A response (HITL with multiple artifacts)
 * const hitlResponse = {
 *   result: {
 *     artifacts: [
 *       { artifactId: "...", parts: [{ data: { status: "pending_human", data: null }}]},
 *       { artifactId: "...", parts: [
 *         { kind: "text", text: "..." },
 *         { kind: "data", data: { packages: [...], media_buy_id: "..." }}
 *       ]}
 *     ]
 *   }
 * };
 * const adcpResponse = unwrapProtocolResponse(hitlResponse, 'create_media_buy');
 * // Returns: { packages: [...], media_buy_id: "...", _message: "..." } (from first completed artifact)
 */
export function unwrapProtocolResponse(protocolResponse: any, toolName?: string): any {
  if (!protocolResponse) {
    throw new Error('Protocol response is null or undefined');
  }

  // MCP protocol: extract from structuredContent
  if (protocolResponse.structuredContent !== undefined && protocolResponse.structuredContent !== null) {
    return protocolResponse.structuredContent;
  }

  // A2A protocol: extract from result.artifacts
  // Strategy: Find the first completed artifact with AdCP response data
  // - Completed artifacts have data parts with AdCP response fields
  // - Skip intermediate status artifacts (e.g., HITL pending_human status)
  // - Extract both text parts (human-readable messages) and data parts (structured response)
  const artifacts = protocolResponse.result?.artifacts;
  if (Array.isArray(artifacts) && artifacts.length > 0) {
    // Helper to extract both text and data from an artifact
    const extractFromArtifact = (artifact: any) => {
      const textParts = artifact.parts?.filter((p: any) => p.kind === 'text' && p.text).map((p: any) => p.text) || [];

      const dataPart = artifact.parts?.find((p: any) => p.kind === 'data' && p.data && typeof p.data === 'object');

      if (dataPart?.data) {
        const data = dataPart.data;
        // If there are text messages, include them similar to MCP's content field
        if (textParts.length > 0) {
          return {
            ...data,
            _message: textParts.join('\n'), // Include human-readable message
          };
        }
        return data;
      }
      return null;
    };

    // Helper to check if data looks like a completed AdCP response
    const isCompletedResponse = (data: any): boolean => {
      if (!data || typeof data !== 'object') return false;

      // Skip HITL status artifacts (these have status: "pending_human" and data: null)
      if (data.status === 'pending_human' && data.data === null) {
        return false;
      }

      // Use proper schema validation with tool name
      if (!toolName) {
        throw new Error(
          'Tool name is required to validate A2A artifacts. ' +
            'Cannot distinguish between intermediate HITL artifacts and completed AdCP responses without knowing which tool was called.'
        );
      }

      return isAdcpSuccess(data, toolName);
    };

    // Find first artifact with completed AdCP response
    for (const artifact of artifacts) {
      const extracted = extractFromArtifact(artifact);
      if (extracted && isCompletedResponse(extracted)) {
        return extracted;
      }
    }

    // If no completed artifacts found, throw error
    // This indicates either:
    // 1. The response structure doesn't match A2A protocol
    // 2. The workflow hasn't completed yet (e.g., still pending HITL)
    // 3. The response doesn't contain expected AdCP fields
    throw new Error(
      'No completed AdCP response found in A2A artifacts. ' +
        'Response may be pending completion or missing expected AdCP fields.'
    );
  }

  // A2A error response: check for error field
  if (protocolResponse.error) {
    // Convert JSON-RPC error to AdCP error format
    // AdCP uses { errors: [...] } for error responses
    return {
      errors: [
        {
          code: protocolResponse.error.code?.toString() || 'unknown',
          message: protocolResponse.error.message || 'Unknown error',
          ...(protocolResponse.error.data && { data: protocolResponse.error.data }),
        },
      ],
    };
  }

  // MCP error response: check for isError
  if (protocolResponse.isError === true) {
    const errorContent = Array.isArray(protocolResponse.content)
      ? protocolResponse.content.find((c: any) => c.type === 'text')?.text
      : protocolResponse.content?.text || 'Unknown error';

    return {
      errors: [
        {
          code: 'mcp_error',
          message: errorContent || 'MCP tool call failed',
        },
      ],
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
          errors: [
            {
              code: 'invalid_response',
              message: 'Response does not contain structured AdCP data',
            },
          ],
        };
      }
    }
  }

  // If we can't find the data in expected locations, return the whole response
  // This allows for direct AdCP responses (when not wrapped in protocol)
  if (
    typeof protocolResponse === 'object' &&
    !('structuredContent' in protocolResponse) &&
    !('result' in protocolResponse)
  ) {
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
      // Required fields per schema: media_buy_id, buyer_ref, packages
      return !!(response.media_buy_id && response.buyer_ref && response.packages);

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

    case 'build_creative':
      return !!response.creative;

    case 'preview_creative':
      return !!response.preview;

    case 'get_media_buy_delivery':
      return !!response.delivery;

    case 'list_authorized_properties':
      return Array.isArray(response.properties);

    case 'provide_performance_feedback':
      return response.success === true;

    case 'get_signals':
      return Array.isArray(response.signals);

    case 'activate_signal':
      return !!response.signal_id;

    default:
      // Unknown task, can't validate
      return true;
  }
}
