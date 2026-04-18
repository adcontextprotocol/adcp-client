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
}

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
  const capabilityCacheKey = buildCapabilityCacheKey(agent.agent_uri, agent.auth_token, signing.kid);
  // Transport-connection cache-key suffix is bound to the signer kid. Distinct
  // keys get their own cached transport so a change in signing identity
  // doesn't silently reuse a connection whose fetch was wrapped with a
  // different key.
  const cacheKey = `sig=${signing.kid}`;

  return {
    signing,
    cacheKey,
    cache,
    capabilityCacheKey,
    getCapability: () => cache.get(capabilityCacheKey),
  };
}
