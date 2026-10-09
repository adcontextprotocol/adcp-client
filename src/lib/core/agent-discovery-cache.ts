import { createHash } from 'node:crypto';
import { ConfigurationError } from '../errors';
import { canonicalize as canonicalizeJson } from '../utils/jcs';
import { splitConnectionHeaders } from '../protocols/mcp-call-context';
import type { AdcpCapabilities } from '../utils/capabilities';

/** Default freshness window for shared discovery entries. */
export const DEFAULT_AGENT_DISCOVERY_TTL_MS = 5 * 60 * 1000;
/** Upper bound for a configured TTL; shared entries are discovery hints, not durable state. */
export const MAX_AGENT_DISCOVERY_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 256;

/**
 * Endpoint, tool-list and capability evidence for one (agent, caller identity,
 * AdCP version, transport policy) tuple. Entries are plain JSON so a shared
 * cache can live in process memory or an external store.
 */
export interface AgentDiscoveryEntry {
  /** MCP endpoint resolved by endpoint discovery (the URL actually serving MCP). */
  endpoint?: {
    agentUri: string;
    mcpEra?: 'legacy' | 'modern';
    /** Epoch milliseconds when this endpoint was observed (may be older than the entry). */
    observedAt?: number;
  };
  /** Capabilities from an authoritative `get_adcp_capabilities` response. Never synthetic. */
  capabilities?: AdcpCapabilities;
  /** `tools/list` input-schema properties keyed by tool name. */
  toolSchemas?: Record<string, Record<string, unknown>>;
  /** Epoch milliseconds when this evidence was observed. */
  observedAt: number;
  /** Epoch milliseconds after which the entry must not be used. Enforced by the SDK on read. */
  expiresAt: number;
}

/**
 * Storage backend for shared discovery entries. Keys are opaque SHA-256
 * digests derived by the SDK; implementations must not interpret them and
 * must return copies (or immutable values) so callers cannot mutate stored
 * entries. Methods may be synchronous or asynchronous.
 */
export interface AgentDiscoveryCache {
  get(key: string): AgentDiscoveryEntry | undefined | Promise<AgentDiscoveryEntry | undefined>;
  set(key: string, entry: AgentDiscoveryEntry): void | Promise<void>;
  delete(key: string): void | Promise<void>;
}

/**
 * Opt-in sharing of endpoint / `tools/list` / `get_adcp_capabilities`
 * discovery across `SingleAgentClient` instances.
 *
 * Sharing is explicit: nothing is shared unless a client is configured with a
 * cache AND a caller-owned `authIdentity`.
 */
export interface AgentDiscoveryCacheConfig {
  /** Shared store. Create one with {@link createInMemoryAgentDiscoveryCache}. */
  cache: AgentDiscoveryCache;
  /**
   * Stable, caller-owned identity of the principal whose credentials these
   * clients use (for example a tenant or buyer-account ID). Required.
   *
   * Entries are only shared between clients that present the same identity, so
   * choose it to be at least as specific as the credential's authorization
   * scope. It is NOT derived from the token: rotating a token for the same
   * principal keeps the entry, and two principals must never share an identity.
   * The identity is hashed into the cache key and never stored in the entry.
   */
  authIdentity: string;
  /** Freshness window in milliseconds. Defaults to five minutes; capped at 24 hours. */
  ttlMs?: number;
}

export interface InMemoryAgentDiscoveryCacheOptions {
  /** Maximum retained entries; least-recently-used entries are evicted. Defaults to 256. */
  maxEntries?: number;
}

/** Process-local {@link AgentDiscoveryCache} with LRU eviction and copy-on-read/write. */
export interface InMemoryAgentDiscoveryCache extends AgentDiscoveryCache {
  get(key: string): AgentDiscoveryEntry | undefined;
  set(key: string, entry: AgentDiscoveryEntry): void;
  delete(key: string): void;
  /** Drop every entry. */
  clear(): void;
  /** Number of retained entries (including entries that have expired but not been read). */
  readonly size: number;
}

export function createInMemoryAgentDiscoveryCache(
  options: InMemoryAgentDiscoveryCacheOptions = {}
): InMemoryAgentDiscoveryCache {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
    throw new ConfigurationError('maxEntries must be a positive safe integer.');
  }
  const entries = new Map<string, AgentDiscoveryEntry>();
  return {
    get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      entries.delete(key);
      entries.set(key, entry);
      return structuredClone(entry);
    },
    set(key, entry) {
      entries.delete(key);
      entries.set(key, structuredClone(entry));
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
    },
    delete(key) {
      entries.delete(key);
    },
    clear() {
      entries.clear();
    },
    get size() {
      return entries.size;
    },
  };
}

/** Validate a client's shared-discovery configuration at construction time. */
export function validateAgentDiscoveryCacheConfig(config: AgentDiscoveryCacheConfig | undefined): void {
  if (config === undefined) return;
  const cache = config.cache as Partial<AgentDiscoveryCache> | undefined;
  if (
    !cache ||
    typeof cache.get !== 'function' ||
    typeof cache.set !== 'function' ||
    typeof cache.delete !== 'function'
  ) {
    throw new ConfigurationError('discoveryCache.cache must implement get, set and delete.', 'discoveryCache.cache');
  }
  if (typeof config.authIdentity !== 'string' || config.authIdentity.length === 0) {
    throw new ConfigurationError(
      'discoveryCache.authIdentity is required: supply a stable caller-owned identity for the principal ' +
        'whose credentials this client uses. It is deliberately not derived from the token, so that two ' +
        'principals can never share discovery evidence by accident.',
      'discoveryCache.authIdentity'
    );
  }
  resolveAgentDiscoveryTtlMs(config.ttlMs);
}

export function resolveAgentDiscoveryTtlMs(ttlMs: number | undefined): number {
  if (ttlMs === undefined) return DEFAULT_AGENT_DISCOVERY_TTL_MS;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > MAX_AGENT_DISCOVERY_TTL_MS) {
    throw new ConfigurationError(
      `discoveryCache.ttlMs must be a positive number of milliseconds no greater than ${MAX_AGENT_DISCOVERY_TTL_MS}.`,
      'discoveryCache.ttlMs'
    );
  }
  return ttlMs;
}

/** Everything that decides which cached discovery evidence a client may reuse. */
export interface AgentDiscoveryKeyInput {
  protocol: string;
  agentUri: string;
  adcpVersion: string;
  wireAdcpVersion?: string;
  authIdentity: string;
  /** Kind of credential presented (`none`, `bearer`, `oauth`, `header`, ...); never its value. */
  credentialKind?: string;
  /** Request headers the client sends on every call (correlation and credential headers are dropped here). */
  headers?: Record<string, string>;
  /** Non-secret fingerprint of the request-signing identity, when configured. */
  signing?: unknown;
  allowPrivateIp?: boolean;
  maxResponseBytes?: number;
}

/**
 * Derive the opaque cache key. Correlation headers are excluded (they differ
 * on every request) and so are credential headers (owned by `authIdentity`); every
 * other header — including unknown tenant, routing and policy headers — is part of the key, as are the signing identity and the
 * transport policy that governed how the evidence was collected.
 */
export function agentDiscoveryCacheKey(input: AgentDiscoveryKeyInput): string {
  // Credential headers are owned by `authIdentity`: whichever source supplied
  // them, their value never fragments the key (token rotation keeps the entry).
  const headers = Object.entries(splitConnectionHeaders(input.headers).identity)
    .map(([name, value]) => [name.toLowerCase(), value] as const)
    .filter(([name]) => name !== 'authorization' && name !== 'x-adcp-auth')
    .sort(([left], [right]) => left.localeCompare(right));
  const digest = createHash('sha256')
    .update(
      canonicalizeJson({
        v: 1,
        protocol: input.protocol,
        agentUri: input.agentUri,
        adcpVersion: input.adcpVersion,
        wireAdcpVersion: input.wireAdcpVersion ?? null,
        authIdentity: input.authIdentity,
        credentialKind: input.credentialKind ?? null,
        headers,
        signing: input.signing ?? null,
        allowPrivateIp: input.allowPrivateIp ?? null,
        maxResponseBytes: input.maxResponseBytes ?? null,
      })
    )
    .digest('hex');
  return `adcp:agent-discovery:v1:${digest}`;
}
