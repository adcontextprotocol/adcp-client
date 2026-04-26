import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import type { AgentConfig, AgentProviderSigningConfig, AgentRequestSigningConfig, AnyAgentSigningConfig } from '../types/adcp';
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
  /** Signing config — raw-key or provider arm. */
  signing: AnyAgentSigningConfig;
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
  return buildAgentSigningContextFromConfig(signing, agent.agent_uri, agent.auth_token, options);
}

/**
 * Build an `AgentSigningContext` directly from an {@link AnyAgentSigningConfig}.
 * Use when the config comes from outside an `AgentConfig` — for example, when
 * wiring a KMS-backed provider without loading a full agent config.
 */
export function buildAgentSigningContextFromConfig(
  signing: AnyAgentSigningConfig,
  agentUri: string,
  authToken?: string,
  options: { cache?: CapabilityCache } = {}
): AgentSigningContext {
  const cache = options.cache ?? defaultCapabilityCache;
  const keyFingerprint = resolveFingerprint(signing);
  const capabilityCacheKey = buildCapabilityCacheKey(agentUri, authToken, keyFingerprint);
  // Transport-connection cache-key suffix binds to a fingerprint that
  // uniquely identifies the private key. Two tenants that advertise the same
  // `kid` but hold distinct private keys must not collide on a shared cached
  // transport — that would sign one tenant's outbound requests with the other
  // tenant's key (same `kid`, different key material), an impersonation.
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

/** Derive a stable per-key cache-key fragment from whichever config arm is supplied. */
function resolveFingerprint(signing: AnyAgentSigningConfig): string {
  if (isProviderConfig(signing)) {
    const fp = signing.provider.fingerprint;
    if (!fp || fp.length < 16) {
      throw new Error(
        `SigningProvider.fingerprint must be at least 16 characters to provide adequate cache-isolation entropy (got ${JSON.stringify(fp)}). ` +
          'Use the KMS resource path (e.g. projects/…/cryptoKeyVersions/N) or a SHA-256 hex prefix.'
      );
    }
    return fp;
  }
  // Raw-key path: derive from kid + private scalar so two tenants with the
  // same kid but distinct keys get different cache entries.
  return createHash('sha256').update(signing.kid).update('\0').update(signing.private_key.d).digest('hex').slice(0, 16);
}

/** Type guard distinguishing the provider arm from the raw-key arm. */
export function isProviderConfig(signing: AnyAgentSigningConfig): signing is AgentProviderSigningConfig {
  return 'provider' in signing;
}
