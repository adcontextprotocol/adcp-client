import type { AgentConfig } from '../types/adcp';
import type { AgentSigningContext } from './agent-context';
import type { CachedCapability } from './capability-cache';
import { unwrapProtocolResponse } from './protocol-response';
import type { VerifierCapability } from './types';

/**
 * Op name used to fetch the seller's capability advertisement. The signing
 * wrapper short-circuits on this op so the priming request itself is never
 * gated by signing.
 */
export const CAPABILITY_OP = 'get_adcp_capabilities';

type FetchRaw = (args: Record<string, unknown>) => Promise<unknown>;

/**
 * Extract the `request_signing` capability block from a `get_adcp_capabilities`
 * response regardless of how the transport wrapped it:
 *
 *   - MCP `CallToolResult` — `structuredContent` or `content[].text` (JSON).
 *   - A2A JSON-RPC `SendMessageResponse` — `result` is a `Task` (with
 *     `artifacts[].parts[].data`) or a `Message` (with `parts[].data`).
 *   - Already-unwrapped payload — returned as-is.
 */
function extractCapability(response: unknown): {
  requestSigning: VerifierCapability | undefined;
  adcpVersion: number | undefined;
} {
  const payload = unwrapProtocolResponse(response);
  if (!payload || typeof payload !== 'object') return { requestSigning: undefined, adcpVersion: undefined };

  const body = payload as Record<string, unknown>;
  const requestSigning = body.request_signing as VerifierCapability | undefined;
  const adcp = body.adcp as { major_versions?: unknown } | undefined;
  const versions = Array.isArray(adcp?.major_versions) ? (adcp!.major_versions as unknown[]) : undefined;
  const adcpVersion =
    versions && versions.length > 0 && typeof versions[0] === 'number' ? (versions[0] as number) : undefined;

  return { requestSigning, adcpVersion };
}

/**
 * Refresh window applied to a negative-cache entry written after a failed
 * discovery call. 60s is short enough that a transient seller outage
 * self-heals on the next user action, long enough to avoid pile-ups if the
 * seller stays down.
 */
const NEGATIVE_CACHE_TTL_SECONDS = 60;

/**
 * Populate the capability cache for an agent when the `request_signing` entry
 * is absent or stale. The injected `fetchRaw` callback is expected to make an
 * unsigned `get_adcp_capabilities` call against the counterparty — callers
 * wire it to `ProtocolClient.callTool` or the underlying transport helper so
 * that no new connection code lives here.
 *
 * Fails open: if discovery itself fails, we cache an empty entry with a short
 * `staleAt` window and return it rather than propagating the error. Signing
 * decisions then fall through:
 *   - Ops in the buyer's `always_sign` list are still signed (with default
 *     content-digest coverage), so explicit pilot opt-ins keep working.
 *   - Ops the seller might have listed in `required_for` go out unsigned and
 *     are rejected with `request_signature_required` at the wire — the user
 *     sees a clear error rather than an opaque priming wedge, and the next
 *     retry re-primes.
 */
export async function ensureCapabilityLoaded(
  _agent: AgentConfig,
  signingContext: AgentSigningContext,
  fetchRaw: FetchRaw
): Promise<CachedCapability> {
  const { cache, capabilityCacheKey: key } = signingContext;
  const existing = cache.get(key);
  if (existing && !cache.isStale(existing)) return existing;

  const pending = cache._getInFlight(key);
  if (pending) return pending;

  const promise = fetchRaw({})
    .then(raw => {
      const { requestSigning, adcpVersion } = extractCapability(raw);
      const entry: CachedCapability = {
        requestSigning,
        adcpVersion,
        fetchedAt: Math.floor(Date.now() / 1000),
      };
      cache.set(key, entry);
      return entry;
    })
    .catch(() => {
      const now = Math.floor(Date.now() / 1000);
      const entry: CachedCapability = {
        requestSigning: undefined,
        adcpVersion: undefined,
        fetchedAt: now,
        staleAt: now + NEGATIVE_CACHE_TTL_SECONDS,
      };
      cache.set(key, entry);
      return entry;
    })
    .finally(() => {
      cache._deleteInFlight(key);
    });

  cache._setInFlight(key, promise);
  return promise;
}
