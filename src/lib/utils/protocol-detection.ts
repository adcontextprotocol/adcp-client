/**
 * Protocol Detection Utilities
 *
 * Auto-detects whether an agent endpoint uses MCP or A2A protocol
 */

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

  // Step 2: Try A2A discovery
  try {
    const discoveryUrl = new URL('/.well-known/agent-card.json', url);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000); // 5s timeout

    const response = await fetch(discoveryUrl.toString(), {
      method: 'GET',
      signal: controller.signal,
      headers: {
        Accept: 'application/json, */*',
      },
    });

    clearTimeout(timeoutId);

    if (response.ok) {
      return 'a2a';
    }
  } catch (error) {
    // Fetch failed - likely not A2A
  }

  // Step 3: Default to MCP
  return 'mcp';
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

  // Try A2A discovery with custom timeout
  try {
    const discoveryUrl = new URL('/.well-known/agent-card.json', url);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch(discoveryUrl.toString(), {
      method: 'GET',
      signal: controller.signal,
      headers: {
        Accept: 'application/json, */*',
      },
    });

    clearTimeout(timeoutId);

    if (response.ok) {
      return 'a2a';
    }
  } catch (error) {
    // Fetch failed - likely not A2A
  }

  // Default to MCP
  return 'mcp';
}
