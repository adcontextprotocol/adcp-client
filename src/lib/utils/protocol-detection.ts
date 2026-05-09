/**
 * Protocol Detection Utilities
 *
 * Auto-detects whether an agent endpoint uses MCP or A2A protocol
 */

import { A2A_CARD_PATHS } from './a2a-discovery';
import { classifyProbeUrl } from './probe-policy';
import { SsrfRefusedError } from '../net/ssrf-fetch';

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

  // adcp-client#1618: SSRF policy gate. MUST run BEFORE the try/catch loop
  // below — placing this inside the loop would let `catch { suspect = true }`
  // silently convert a denied URL into `'a2a'`, defeating the whole point of
  // the policy. The hostname-literal check catches obvious attacks
  // (`http://169.254.169.254/`, `http://10.0.0.1/`); per-IP DNS-aware
  // protection lives one layer down (in callers that route through
  // `ssrfSafeFetch`).
  const policy = classifyProbeUrl(url);
  if (!policy.allowed) {
    // `classifyProbeUrl` already returned `{ allowed: true }` for any URL
    // that fails `new URL(...)`, so reaching the !allowed branch implies the
    // URL parses cleanly. Reparse here only to extract the bare hostname for
    // the `SsrfRefusedError` meta (the policy returned the human-readable
    // refusal reason but not the structured hostname).
    const hostname = new URL(url).hostname.replace(/^\[|\]$/g, '');
    throw new SsrfRefusedError(
      policy.code === 'always_blocked' ? 'always_blocked_address' : 'private_address',
      policy.reason,
      { url, hostname }
    );
  }

  // adcp-client#1612: classify each well-known card probe into one of three
  // signals so we can distinguish "this is A2A but momentarily 503" from
  // "this is not A2A":
  //   - `confirm`  : 200/3xx — A2A confirmed
  //   - `suspect`  : 5xx or transport error — host knows the path but can't
  //                  serve it right now; still strong evidence of A2A. Falling
  //                  back to MCP here is what produced the original #1612
  //                  symptom (425s of MCP retries against an A2A root).
  //   - `negative` : 4xx (other than 401/403/429) — host doesn't recognize
  //                  the well-known path; MCP is the better default.
  // 401/403/429 are auth/rate signals on the well-known path itself, which
  // also indicate "host knows the path" → suspect.
  let suspect = false;
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
      // 5xx or auth-on-the-path: treat as A2A suspicion (host has this route
      // but couldn't return the card right now). Don't return immediately —
      // a later path might confirm with a 200.
      if (response.status >= 500 || response.status === 401 || response.status === 403 || response.status === 429) {
        suspect = true;
      }
      // 4xx (other than the above): negative evidence, leave suspect alone.
    } catch {
      // Network error or our 5s timeout fired. The host may still be A2A
      // (just slow); upgrade suspicion so we don't fall back to MCP and
      // burn the caller's discovery budget on a non-MCP root.
      suspect = true;
    }
  }

  return suspect ? 'a2a' : 'mcp';
}
