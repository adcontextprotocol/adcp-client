import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import type { AgentConfig, AgentRequestSigningConfig } from '../types/adcp';
import {
  buildCapabilityCacheKey,
  CapabilityCache,
  defaultCapabilityCache,
  type CachedCapability,
} from './capability-cache';

/**
 * Per-call signing context passed down to the MCP/A2A transport layer. Built
 * at `ProtocolClient.callTool` and consumed by the signing fetch wrapper
 * attached to the transport. Opaque to the transport helpers — they only
 * use `cacheKey` (to disambiguate connection-cache entries per signing
 * identity), `getCapability` (to read the cached seller advertisement on
 * each outbound request), and `signing` (to produce the signer key).
 */
export interface AgentSigningContext {
  /** Signing config copied from AgentConfig.request_signing. */
  signing: AgentRequestSigningConfig;
  /** Suffix to append to transport connection-cache keys so agents with different signing identities don't share a connection. */
  cacheKey: string;
  /** Lazy accessor for the currently cached capability for this agent. */
  getCapability: () => CachedCapability | undefined;
  /** Capability cache backing this context (for external invalidation). */
  cache: CapabilityCache;
  /** Stable cache key used against the capability cache itself. */
  capabilityCacheKey: string;
  /**
   * Evict this context's capability entry so the next outbound call
   * re-primes `get_adcp_capabilities`. Use after a seller-side rotation
   * signal — or on a 401 / protocol-signature error — without having to
   * rebuild the cache key from the agent's identifying fields.
   */
  invalidate(): void;
}

/**
 * AsyncLocalStorage carrying the signing context across the transport layer.
 * Top-level protocol entries (`callMCPTool`, `callA2ATool`, etc.) push a
 * context onto this storage for the duration of the call; internal helpers
 * (`withCachedConnection`, `connectMCPWithFallback`, `buildFetchImpl`) read
 * it when building cache keys and signing-fetch wrappers, avoiding the need
 * to thread `signingContext` through every intermediate signature.
 *
 * The top-level entries always call `run()` — including with `undefined` —
 * so a non-signing call cannot inherit a stale context from an enclosing
 * scope.
 */
export const signingContextStorage = new AsyncLocalStorage<AgentSigningContext | undefined>();

/**
 * Build an `AgentSigningContext` from an `AgentConfig` when signing is
 * configured. Returns `undefined` when the agent has no `request_signing`
 * block — callers use this to branch into the no-op fast path.
 */
export function buildAgentSigningContext(
  agent: AgentConfig,
  options: { cache?: CapabilityCache } = {}
): AgentSigningContext | undefined {
  const signing = agent.request_signing;
  if (!signing) return undefined;

  const cache = options.cache ?? defaultCapabilityCache;
  const keyFingerprint = privateKeyFingerprint(signing);
  const capabilityCacheKey = buildCapabilityCacheKey(agent.agent_uri, agent.auth_token, keyFingerprint);
  // Transport-connection cache-key suffix binds to a hash of the private key,
  // not just the advertised `kid`. Two tenants that misconfigure the same
  // `kid` string but hold distinct private keys must not collide on a shared
  // cached transport — that would sign one tenant's outbound requests with
  // the other tenant's key (same `kid`, different `d`), an impersonation.
  const cacheKey = `sig=${keyFingerprint}`;

  return {
    signing,
    cacheKey,
    cache,
    capabilityCacheKey,
    getCapability: () => cache.get(capabilityCacheKey),
    invalidate: () => cache.invalidate(capabilityCacheKey),
  };
}

/**
 * Derive a stable per-key cache-key fragment. Hashes both `kid` and the
 * private scalar `d` so that two tenants advertising the same `kid` but
 * holding distinct private keys get different cache entries. Truncated to
 * 16 hex chars — a collision-resistance budget of 64 bits against random
 * keys is plenty for a cache disambiguator, and we never rely on this
 * value as a security boundary.
 */
function privateKeyFingerprint(signing: AgentRequestSigningConfig): string {
  return createHash('sha256').update(signing.kid).update('\0').update(signing.private_key.d).digest('hex').slice(0, 16);
}
