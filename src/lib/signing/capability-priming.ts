import type { AgentConfig } from '../types/adcp';
import type { AgentSigningContext } from './agent-context';
import type { CachedCapability } from './capability-cache';
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
 * response regardless of how the transport wrapped it (raw MCP
 * `CallToolResult` with `structuredContent` / `content[].text`, A2A task
 * result, or already-unwrapped payload).
 */
function extractCapability(response: unknown): {
  requestSigning: VerifierCapability | undefined;
  adcpVersion: number | undefined;
} {
  const payload = unwrapResponse(response);
  if (!payload || typeof payload !== 'object') return { requestSigning: undefined, adcpVersion: undefined };

  const body = payload as Record<string, unknown>;
  const requestSigning = body.request_signing as VerifierCapability | undefined;
  const adcp = body.adcp as { major_versions?: unknown } | undefined;
  const versions = Array.isArray(adcp?.major_versions) ? (adcp!.major_versions as unknown[]) : undefined;
  const adcpVersion =
    versions && versions.length > 0 && typeof versions[0] === 'number' ? (versions[0] as number) : undefined;

  return { requestSigning, adcpVersion };
}

function unwrapResponse(response: unknown): unknown {
  if (!response || typeof response !== 'object') return response;
  const r = response as Record<string, unknown>;
  if (r.structuredContent && typeof r.structuredContent === 'object') return r.structuredContent;
  const content = r.content;
  if (Array.isArray(content)) {
    for (const chunk of content) {
      if (chunk && typeof chunk === 'object' && typeof (chunk as any).text === 'string') {
        try {
          return JSON.parse((chunk as any).text);
        } catch {
          // non-JSON text chunk — keep looking
        }
      }
    }
  }
  return response;
}

/**
 * In-flight capability fetches, keyed by the caller's capability-cache key.
 * Serializes concurrent `callTool` invocations against the same cold agent
 * so that exactly one `get_adcp_capabilities` request fires — matches the
 * pending-connection pattern in the MCP transport.
 */
const pendingFetches = new Map<string, Promise<CachedCapability>>();

/**
 * Populate the capability cache for an agent when the `request_signing` entry
 * is absent or stale. The injected `fetchRaw` callback is expected to make an
 * unsigned `get_adcp_capabilities` call against the counterparty — callers
 * wire it to `ProtocolClient.callTool` or the underlying transport helper so
 * that no new connection code lives here.
 */
export async function ensureCapabilityLoaded(
  _agent: AgentConfig,
  signingContext: AgentSigningContext,
  fetchRaw: FetchRaw
): Promise<CachedCapability> {
  const key = signingContext.capabilityCacheKey;
  const existing = signingContext.cache.get(key);
  if (existing && !signingContext.cache.isStale(existing)) return existing;

  const pending = pendingFetches.get(key);
  if (pending) return pending;

  const promise = fetchRaw({})
    .then(raw => {
      const { requestSigning, adcpVersion } = extractCapability(raw);
      const entry: CachedCapability = {
        requestSigning,
        adcpVersion,
        fetchedAt: Math.floor(Date.now() / 1000),
      };
      signingContext.cache.set(key, entry);
      return entry;
    })
    .finally(() => {
      pendingFetches.delete(key);
    });

  pendingFetches.set(key, promise);
  return promise;
}
