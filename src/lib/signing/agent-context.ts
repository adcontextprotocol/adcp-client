import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import type { AgentConfig, AgentRequestSigningConfig } from '../types/adcp';
import {
  buildCapabilityCacheKey,
  CapabilityCache,
  defaultCapabilityCache,
  type CachedCapability,
} from './capability-cache';
import type { SigningProvider } from './provider';
import type { AdcpSignAlg } from './types';

/**
 * Snapshot of the signing identity captured at context-build time. The
 * transport layer reads from this snapshot rather than from `provider.*`
 * directly so a provider object whose fields drift between context build
 * and outbound request can't desynchronize the on-wire `keyid` from the
 * cache key the connection was bound to. TypeScript's `readonly` modifier
 * is compile-time only; the snapshot is the runtime defense.
 */
export interface AgentSigningIdentitySnapshot {
  keyid: string;
  algorithm: AdcpSignAlg;
  /** Defensively hashed disambiguator — see {@link buildAgentSigningContext}. */
  fingerprint: string;
}

/**
 * Per-call signing context passed down to the MCP/A2A transport layer. Built
 * at `ProtocolClient.callTool` and consumed by the signing fetch wrapper
 * attached to the transport. Opaque to the transport helpers — they only
 * use `cacheKey` (to disambiguate connection-cache entries per signing
 * identity), `getCapability` (to read the cached seller advertisement on
 * each outbound request), and `signing` (to produce the signer key or
 * provider).
 */
export interface AgentSigningContext {
  /** Signing config copied from AgentConfig.request_signing. */
  signing: AgentRequestSigningConfig;
  /** Provider when `signing.kind === 'provider'`; undefined for inline keys. */
  provider?: SigningProvider;
  /** Snapshot of identity fields read from the provider at build time. */
  identity: AgentSigningIdentitySnapshot;
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
  const identity = snapshotIdentity(signing);
  const cacheFingerprint = deriveCacheFingerprint(identity);
  const capabilityCacheKey = buildCapabilityCacheKey(agent.agent_uri, agent.auth_token, cacheFingerprint);
  // Transport-connection cache-key suffix binds to the defensively hashed
  // identity, not just the advertised `kid`. Two tenants that misconfigure
  // the same `kid` string but hold distinct keys must not collide on a
  // shared cached transport — that would sign one tenant's outbound
  // requests with the other tenant's key (same `kid`, different material),
  // an impersonation. The hash includes `algorithm` so an Ed25519/P-256
  // swap on the same `kid+fingerprint` doesn't alias either.
  const cacheKey = `sig=${cacheFingerprint}`;
  const provider = signing.kind === 'provider' ? signing.provider : undefined;

  return {
    signing,
    provider,
    identity,
    cacheKey,
    cache,
    capabilityCacheKey,
    getCapability: () => cache.get(capabilityCacheKey),
    invalidate: () => cache.invalidate(capabilityCacheKey),
  };
}

/**
 * Snapshot the signing identity at context-build time. For provider configs,
 * reads `keyid` / `algorithm` / `fingerprint` once and freezes them. For
 * inline configs, derives a fingerprint from the private scalar — same
 * 64-bit cache disambiguator the SDK has always used.
 */
function snapshotIdentity(signing: AgentRequestSigningConfig): AgentSigningIdentitySnapshot {
  if (signing.kind === 'provider') {
    const provider = signing.provider;
    return {
      keyid: provider.keyid,
      algorithm: provider.algorithm,
      fingerprint: provider.fingerprint,
    };
  }
  return {
    keyid: signing.kid,
    algorithm: signing.alg,
    fingerprint: inlineFingerprint(signing.kid, signing.private_key.d),
  };
}

/**
 * Defensively hash the snapshot before composing cache keys. A
 * provider-supplied `fingerprint` is treated as untrusted input — a
 * confused integrator could return a constant, an empty string, or a
 * tenant-controlled value, any of which would re-enable cross-tenant
 * collisions on the same `kid`. Including `algorithm` in the digest
 * prevents an Ed25519/P-256 swap on identical `kid+fingerprint` from
 * aliasing.
 *
 * Truncated to 16 hex chars — a 64-bit collision-resistance budget against
 * random keys is plenty for a cache disambiguator, and we never rely on
 * this value as a security boundary.
 */
function deriveCacheFingerprint(identity: AgentSigningIdentitySnapshot): string {
  return createHash('sha256')
    .update(identity.algorithm)
    .update('\0')
    .update(identity.keyid)
    .update('\0')
    .update(identity.fingerprint)
    .digest('hex')
    .slice(0, 16);
}

function inlineFingerprint(kid: string, d: string | undefined): string {
  if (!d) {
    throw new TypeError(
      `AgentRequestSigningConfig (kind: 'inline', kid='${kid}') is missing 'private_key.d' — JWK must include the private scalar.`
    );
  }
  return createHash('sha256').update(kid).update('\0').update(d).digest('hex').slice(0, 16);
}
