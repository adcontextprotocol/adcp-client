/**
 * AdCP Validation Utilities
 * Functions for validating URLs, responses, and schemas
 */

import { classifyProbeUrl } from '../utils/probe-policy';

export { validateRequest, validateResponse, formatIssues } from './schema-validator';
export type { ValidationIssue, ValidationOutcome } from './schema-validator';
export { buildValidationError, buildAdcpValidationErrorPayload } from './schema-errors';
export type { ValidationErrorDetails, AdcpValidationErrorDetails } from './schema-errors';
export {
  getValidator,
  listValidatorKeys,
  resolveBundleKey,
  hasSchemaBundle,
  registerExternalSchemaRoot,
  unregisterExternalSchemaRoot,
  withExternalSchemaRoot,
} from './schema-loader';
export type { Direction, ResponseVariant } from './schema-loader';
export { validateOutgoingRequest, validateIncomingResponse, resolveValidationModes } from './client-hooks';
export type { ValidationMode, ValidationHookConfig } from './client-hooks';

/**
 * Get expected response schema type for a given tool
 */
export function getExpectedSchema(toolName: string): string {
  switch (toolName) {
    case 'get_products':
      return 'products';
    case 'list_creative_formats':
      return 'formats';
    case 'create_media_buy':
      return 'media_buy';
    case 'manage_creative_assets':
      return 'creative_management';
    case 'sync_creatives':
      return 'sync_response';
    case 'list_creatives':
      return 'creative_list';
    case 'add_creative_assets':
      return 'creative_upload';
    default:
      return 'generic';
  }
}

/**
 * Validate an agent URL before it reaches a protocol transport.
 *
 * The private/metadata decision delegates to {@link classifyProbeUrl} so agent
 * URLs and discovery probes share one policy: loopback allowed (a dev loop
 * already requires on-host access to abuse), RFC-1918/link-local/ULA refused
 * unless the operator sets `ADCP_ALLOW_INTERNAL_PROBES=1`, cloud metadata
 * refused even then. Deliberately NOT keyed on `NODE_ENV` — a staging image
 * running `NODE_ENV=test` must not inherit a looser SSRF posture than
 * production.
 *
 * SCOPE: this is a synchronous check on the URL's literal scheme and hostname.
 * It does NOT resolve DNS, so it cannot stop a public hostname that resolves —
 * or rebinds — to a private address. That gap is the same TOCTOU one tracked
 * for `classifyProbeUrl`; DNS-level defense requires resolving and pinning at
 * connect time, as `ssrfSafeFetch` and `createPinAndBindFetch` do.
 */
export function validateAgentUrl(url: string): void {
  // Handle edge cases first
  if (!url || typeof url !== 'string') {
    throw new Error('Agent URL is required and must be a string');
  }

  if (url.trim() === '') {
    throw new Error('Agent URL cannot be empty');
  }

  // Ensure reasonable URL length
  if (url.length > 2048) {
    throw new Error('Agent URL is too long (max 2048 characters)');
  }

  try {
    const parsedUrl = new URL(url.trim());

    // Only allow HTTP/HTTPS protocols
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      throw new Error(`Protocol '${parsedUrl.protocol}' not allowed (only HTTP/HTTPS)`);
    }

    // Ensure URL has a valid hostname
    if (!parsedUrl.hostname) {
      throw new Error('URL must have a valid hostname');
    }

    // Metadata and private-network destinations. One policy, shared with
    // discovery probes — see `classifyProbeUrl` for the range table and the
    // single `ADCP_ALLOW_INTERNAL_PROBES` opt-out. It does real CIDR matching
    // over `net/address-guards`, so bracketed `[::1]`, `127.0.0.2`, CGNAT, and
    // IPv4-mapped IPv6 are all classified correctly and registered names like
    // `10.example.com` are not false positives.
    const probe = classifyProbeUrl(parsedUrl.toString());
    if (!probe.allowed) {
      throw new Error(`${probe.reason} (agent URL not allowed)`);
    }
  } catch (e) {
    if (e instanceof Error) {
      // Don't double-wrap our own errors
      if (e.message.includes('not allowed') || e.message.includes('required') || e.message.includes('cannot be')) {
        throw e;
      }
      // Only wrap URL constructor errors with more context
      throw new Error(`Invalid agent URL format: ${e.message}`);
    }
    throw new Error('Invalid agent URL format');
  }
}

/**
 * Validate AdCP response format and content
 */
export function validateAdCPResponse(response: any, expectedSchema: string): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  // Basic response structure validation
  if (!response || typeof response !== 'object') {
    errors.push('Response is not a valid object');
    return { valid: false, errors };
  }

  // Check for AdCP-specific fields based on expected schema
  if (expectedSchema === 'products') {
    if (!Array.isArray(response.products)) {
      errors.push('Missing or invalid products array');
    } else {
      response.products.forEach((product: any, index: number) => {
        if (!product.id) errors.push(`Product ${index}: Missing id field`);
        if (!product.name) errors.push(`Product ${index}: Missing name field`);
        if (!product.pricing_model) errors.push(`Product ${index}: Missing pricing_model field`);
      });
    }
  }

  if (expectedSchema === 'formats') {
    if (!Array.isArray(response.formats) && !Array.isArray(response.creative_formats)) {
      errors.push('Missing formats/creative_formats array');
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Handle AdCP response with comprehensive error checking
 */
export async function handleAdCPResponse(
  response: Response,
  expectedSchema: string,
  agentName: string
): Promise<{ success: boolean; data?: any; error?: string; warnings?: string[] }> {
  const warnings: string[] = [];

  // Check AdCP-specific response headers
  const adcpVersion = response.headers.get('AdCP-Version');
  if (!adcpVersion) {
    warnings.push('Missing AdCP-Version header in response');
  } else if (adcpVersion !== '1.0') {
    warnings.push(`Unexpected AdCP version: ${adcpVersion} (expected 1.0)`);
  }

  const responseId = response.headers.get('AdCP-Response-ID');
  if (!responseId) {
    warnings.push('Missing AdCP-Response-ID header in response');
  }

  const contentType = response.headers.get('Content-Type');
  if (!contentType?.includes('application/vnd.adcp+json') && !contentType?.includes('application/json')) {
    warnings.push(`Unexpected content type: ${contentType} (expected application/vnd.adcp+json)`);
  }

  // Parse response body
  let responseData: unknown;
  try {
    const textResponse = await response.text();
    if (!textResponse.trim()) {
      return {
        success: false,
        error: `Empty response from ${agentName}`,
        warnings,
      };
    }

    responseData = JSON.parse(textResponse);
  } catch (parseError) {
    return {
      success: false,
      error: `Invalid JSON response from ${agentName}: ${
        parseError instanceof Error ? parseError.message : 'Parse error'
      }`,
      warnings,
    };
  }

  // Check for JSON-RPC error response
  const parsed = responseData as Record<string, unknown>;
  if (parsed?.error || (parsed?.jsonrpc && parsed?.id !== undefined && !parsed?.result)) {
    const errorObj = parsed.error as Record<string, unknown> | undefined;
    return {
      success: false,
      error: `Agent returned JSON-RPC error: ${errorObj?.message || JSON.stringify(errorObj)}`,
      warnings,
      data: responseData, // Include raw data for debugging
    };
  }

  // Validate response schema
  const validation = validateAdCPResponse(responseData, expectedSchema);
  if (!validation.valid) {
    return {
      success: false,
      error: `Schema validation failed for ${agentName}: ${validation.errors.join(', ')}`,
      warnings,
      data: responseData, // Include raw data for debugging
    };
  }

  return {
    success: true,
    data: responseData,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}
