import { createNonInteractiveOAuthProvider } from './index';
import type { MCPOAuthProvider } from './MCPOAuthProvider';
import type { AgentConfig } from './types';

const nonInteractiveOAuthProviderCache = new WeakMap<AgentConfig, MCPOAuthProvider>();

/** Reuse one refresh-capable provider for repeated calls in the same agent authorization context. */
export function getNonInteractiveOAuthProvider(
  agent: AgentConfig,
  options?: Parameters<typeof createNonInteractiveOAuthProvider>[1]
): MCPOAuthProvider {
  let provider = nonInteractiveOAuthProviderCache.get(agent);
  if (!provider) {
    provider = createNonInteractiveOAuthProvider(agent, options);
    nonInteractiveOAuthProviderCache.set(agent, provider);
  }
  return provider;
}

/** Preserve provider identity when endpoint discovery creates a derived AgentConfig object. */
export function shareNonInteractiveOAuthProvider(source: AgentConfig, target: AgentConfig): void {
  const provider = nonInteractiveOAuthProviderCache.get(source);
  if (provider) nonInteractiveOAuthProviderCache.set(target, provider);
}
