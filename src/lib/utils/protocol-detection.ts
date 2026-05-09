/**
 * Protocol Detection Utilities
 *
 * Auto-detects whether an agent endpoint uses MCP or A2A protocol
 */

import { A2A_CARD_PATHS } from './a2a-discovery';
import { classifyProbeUrl, isInternalProbesAllowed } from './probe-policy';
import { SsrfRefusedError, ssrfSafeFetch } from '../net/ssrf-fetch';

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
  //
  // adcp-client#1627: route through `ssrfSafeFetch` to close the TOCTOU
  // rebind window left open in the #1618 hostname-literal gate. The
  // wrapper resolves DNS once, validates the full address set against
  // `address-guards`, and pins the connect to the first validated address
  // via undici's `Agent.connect.lookup`. A hostname like
  // `evil.example.com` that resolves to `169.254.169.254` rejects with
  // `SsrfRefusedError(always_blocked_address)` BEFORE the request hits
  // the wire. Counterparty-controlled `Location` headers are not followed
  // (`redirect: 'manual'` inside the wrapper) so a 302 to an SSRF target
  // can't bounce us either. The literal-hostname `classifyProbeUrl`
  // gate above remains as cheap synchronous defense in depth.
  const allowPrivateIp = isInternalProbesAllowed();

  let suspect = false;
  for (const path of A2A_CARD_PATHS) {
    const discoveryUrl = new URL(path, url).toString();
    try {
      const result = await ssrfSafeFetch(discoveryUrl, {
        method: 'GET',
        timeoutMs,
        allowPrivateIp,
        headers: { Accept: 'application/json, */*' },
        // The agent card is small (kB-scale) — cap tightly so a malicious
        // host can't pin our event loop on a slow body read.
        maxBodyBytes: 4 * 1024,
      });

      if (result.status >= 200 && result.status < 300) {
        return 'a2a';
      }
      // 5xx or auth-on-the-path: treat as A2A suspicion (host has this route
      // but couldn't return the card right now). Don't return immediately —
      // a later path might confirm with a 200.
      if (result.status >= 500 || result.status === 401 || result.status === 403 || result.status === 429) {
        suspect = true;
      }
      // 4xx (other than the above): negative evidence, leave suspect alone.
    } catch (err) {
      // Distinguish policy refusals (must propagate — caller is reaching
      // for SSRF targets) from runtime/network conditions (treat as
      // suspect — host is unreachable or non-conformant in a way that's
      // consistent with a slow / large A2A seller).
      //
      // Propagate: `always_blocked_address`, `private_address`,
      //   `scheme_not_allowed`, `non_https_without_opt_in`, `invalid_url`.
      //   These mean the caller's URL was rejected on policy grounds;
      //   silently converting them to `'a2a'` would reintroduce the
      //   catch-swallow class flagged in #1618 review.
      // Treat as suspect: `dns_lookup_failed`, `dns_empty`,
      //   `body_exceeds_limit`. DNS conditions mean the network is
      //   misbehaving, not that the URL is dangerous — and the pre-#1627
      //   native-fetch behavior also swallowed these into suspect.
      //   `body_exceeds_limit` fires when the agent card exceeds the
      //   defensive 4 KiB cap; A2A 0.3.0 §5 doesn't cap card size, so a
      //   large legitimate card shouldn't be misclassified as a policy
      //   attack — the host clearly knows the well-known path
      //   (the response started, just got too big), which is exactly
      //   the suspect-A2A signal.
      if (err instanceof SsrfRefusedError) {
        if (err.code === 'dns_lookup_failed' || err.code === 'dns_empty' || err.code === 'body_exceeds_limit') {
          suspect = true;
          continue;
        }
        throw err;
      }
      // Other errors (timeout, remote reset, etc.) → suspect.
      suspect = true;
    }
  }

  return suspect ? 'a2a' : 'mcp';
}
