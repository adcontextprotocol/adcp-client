/**
 * Protocol Detection Utilities
 *
 * Auto-detects whether an agent endpoint uses MCP or A2A protocol
 */

import { A2A_CARD_PATHS } from './a2a-discovery';

/**
 * Detect protocol for a given agent URL
 *
 * Uses a hybrid approach:
 * 1. Check URL patterns (fast heuristic)
 * 2. Try A2A discovery endpoints (authoritative)
 * 3. Default to MCP if A2A discovery fails
 *
 * @param url Agent URL to check
 * @returns Promise resolving to 'a2a' or 'mcp'
 */
export async function detectProtocol(url: string): Promise<'a2a' | 'mcp'> {
  return detectA2AOrMcp(url, 5000);
}

/**
 * Detect protocol with custom timeout
 *
 * @param url Agent URL to check
 * @param timeoutMs Timeout in milliseconds (default: 5000)
 * @returns Promise resolving to 'a2a' or 'mcp'
 */
export async function detectProtocolWithTimeout(url: string, timeoutMs: number = 5000): Promise<'a2a' | 'mcp'> {
  return detectA2AOrMcp(url, timeoutMs);
}

async function detectA2AOrMcp(url: string, timeoutMs: number): Promise<'a2a' | 'mcp'> {
  if (url.endsWith('/mcp/') || url.endsWith('/mcp')) {
    return 'mcp';
  }

  for (const path of A2A_CARD_PATHS) {
    try {
      const discoveryUrl = new URL(path, url);
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
      // Fetch failed - try next path
    }
  }

  return 'mcp';
}
