/**
 * Per-agent OAuth storage binding.
 *
 * `ProtocolClient.callTool` constructs the non-interactive OAuth provider
 * inline from an `AgentConfig`, and needs to attach an `OAuthConfigStorage`
 * implementation when one is available — but only when the caller configured
 * one for that particular agent. Rather than threading storage through every
 * positional parameter of `callTool`, we attach it to the agent via a
 * `Symbol`-keyed enumerable property.
 *
 * Why a symbol and not a `WeakMap` or a string-keyed field:
 *
 * - `{...agent}` spreads copy enumerable string *and* symbol properties, so
 *   the binding survives the normalization + discovery passes that
 *   `SingleAgentClient` performs before calling `ProtocolClient.callTool`.
 * - `JSON.stringify` ignores symbol keys, so the binding never lands on
 *   disk when an agent is persisted.
 * - Using `Symbol.for(…)` (the global registry) keeps the binding readable
 *   across module instances — relevant when the library is loaded from both
 *   `dist/` and a workspace link during dev-loops.
 */
import type { AgentConfig } from '../../types/adcp';
import type { OAuthConfigStorage } from './types';

const STORAGE_KEY = Symbol.for('@adcp/client:oauth-config-storage');

/**
 * Attach an `OAuthConfigStorage` to an `AgentConfig` so that downstream
 * `callTool` invocations pick it up when constructing an OAuth provider.
 *
 * Call this once after resolving the agent (typically in the CLI after
 * loading from `~/.adcp/config.json`, or in a multi-tenant service after
 * looking up the agent record for a request).
 */
export function bindAgentStorage(agent: AgentConfig, storage: OAuthConfigStorage): void {
  (agent as unknown as Record<symbol, OAuthConfigStorage>)[STORAGE_KEY] = storage;
}

/**
 * Read the `OAuthConfigStorage` bound to an `AgentConfig`, or `undefined`
 * if none was bound. Used by the protocol client when wiring the OAuth
 * provider at call time.
 */
export function getAgentStorage(agent: AgentConfig): OAuthConfigStorage | undefined {
  return (agent as unknown as Record<symbol, OAuthConfigStorage | undefined>)[STORAGE_KEY];
}

/**
 * Remove the binding for an agent. Typically not needed (GC handles it) but
 * useful in tests that reuse agent objects across scenarios.
 */
export function unbindAgentStorage(agent: AgentConfig): void {
  delete (agent as unknown as Record<symbol, OAuthConfigStorage>)[STORAGE_KEY];
}
