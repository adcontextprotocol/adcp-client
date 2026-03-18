/**
 * Protocol Detection Utilities
 *
 * Auto-detects whether an agent endpoint uses MCP or A2A protocol
 */

/**
 * Discover agent card URL with fallback support
 *
 * Tries new standard path first, falls back to legacy path for backward compatibility.
 *
 * @param baseUrl Base URL to discover agent card from
 * @returns Promise resolving to the first successful agent card URL, or null if both fail
 */
async function discoverAgentCardUrl(baseUrl: string): Promise<string | null> {
  // Try new standard path first (/.well-known/agent.json)
  try {
    const newUrl = new URL('/.well-known/agent.json', baseUrl);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000); // 5s timeout

    const response = await fetch(newUrl.toString(), {
      method: 'GET',
      signal: controller.signal,
      headers: {
        Accept: 'application/json, */*',
      },
    });

    clearTimeout(timeoutId);

    if (response.ok) {
      return newUrl.toString();
    }
  } catch (error) {
    // Fetch failed - try legacy path
  }

  // Fallback to legacy path (/.well-known/agent-card.json)
  try {
    const legacyUrl = new URL('/.well-known/agent-card.json', baseUrl);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000); // 5s timeout

    const response = await fetch(legacyUrl.toString(), {
      method: 'GET',
      signal: controller.signal,
      headers: {
        Accept: 'application/json, */*',
      },
    });

    clearTimeout(timeoutId);

    if (response.ok) {
      return legacyUrl.toString();
    }
  } catch (error) {
    // Both paths failed
  }

  return null;
}

/**
 * Detect protocol for a given agent URL
 *
 * Uses a hybrid approach:
 * 1. Check URL patterns (fast heuristic)
 * 2. Try A2A discovery endpoint (authoritative)
 * 3. Default to MCP if A2A discovery fails
 *
 * @param url Agent URL to check
 * @returns Promise resolving to 'a2a' or 'mcp'
 */
export async function detectProtocol(url: string): Promise<'a2a' | 'mcp'> {
  // Step 1: Quick heuristic check
  if (url.endsWith('/mcp/') || url.endsWith('/mcp')) {
    return 'mcp';
  }

  // Step 2: Try A2A discovery with fallback support
  const discoveredUrl = await discoverAgentCardUrl(url);
  if (discoveredUrl) {
    return 'a2a';
  }

  // Step 3: Default to MCP
  return 'mcp';
}

/**
 * Discover agent card URL with custom timeout and fallback support
 *
 * Tries new standard path first, falls back to legacy path for backward compatibility.
 *
 * @param baseUrl Base URL to discover agent card from
 * @param timeoutMs Timeout in milliseconds (default: 5000)
 * @returns Promise resolving to the first successful agent card URL, or null if both fail
 */
async function discoverAgentCardUrlWithTimeout(baseUrl: string, timeoutMs: number = 5000): Promise<string | null> {
  // Try new standard path first (/.well-known/agent.json)
  try {
    const newUrl = new URL('/.well-known/agent.json', baseUrl);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch(newUrl.toString(), {
      method: 'GET',
      signal: controller.signal,
      headers: {
        Accept: 'application/json, */*',
      },
    });

    clearTimeout(timeoutId);

    if (response.ok) {
      return newUrl.toString();
    }
  } catch (error) {
    // Fetch failed - try legacy path
  }

  // Fallback to legacy path (/.well-known/agent-card.json)
  try {
    const legacyUrl = new URL('/.well-known/agent-card.json', baseUrl);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch(legacyUrl.toString(), {
      method: 'GET',
      signal: controller.signal,
      headers: {
        Accept: 'application/json, */*',
      },
    });

    clearTimeout(timeoutId);

    if (response.ok) {
      return legacyUrl.toString();
    }
  } catch (error) {
    // Both paths failed
  }

  return null;
}

/**
 * Detect protocol with custom timeout
 *
 * @param url Agent URL to check
 * @param timeoutMs Timeout in milliseconds (default: 5000)
 * @returns Promise resolving to 'a2a' or 'mcp'
 */
export async function detectProtocolWithTimeout(url: string, timeoutMs: number = 5000): Promise<'a2a' | 'mcp'> {
  // Quick heuristic check
  if (url.endsWith('/mcp/') || url.endsWith('/mcp')) {
    return 'mcp';
  }

  // Try A2A discovery with fallback support
  const discoveredUrl = await discoverAgentCardUrlWithTimeout(url, timeoutMs);
  if (discoveredUrl) {
    return 'a2a';
  }

  // Default to MCP
  return 'mcp';
}
