import type { RegistryClient } from './index';
import type { CursorStore } from './cursor-store';
import type { AgentSearchResult, AuthorizationEntry } from './types.generated';
import { RegistrySync, type RegistrySyncProperty } from './sync';

// ====== Configuration ======

export interface PropertyRegistryConfig {
  /** RegistryClient instance for API calls. */
  registryClient: RegistryClient;
  /** Optional cursor store for resumable syncing. */
  cursorStore?: CursorStore;
  /** Polling interval in milliseconds. Default: 30000 (30s). */
  pollInterval?: number;
}

// ====== PropertyRegistry ======

/**
 * Local authorization cache with synchronous queries.
 *
 * Wraps RegistrySync internally, subscribing to its events and maintaining
 * indexed Maps for O(1) synchronous lookups. The key difference from using
 * RegistrySync directly is that all query methods are synchronous.
 *
 * @example
 * ```ts
 * const registry = new PropertyRegistry({
 *   registryClient: new RegistryClient({ apiKey: 'sk_...' }),
 * });
 * await registry.start();
 *
 * // Synchronous lookups - no await needed
 * const authorized = registry.isAuthorized('https://ads.example.com', 'publisher.com');
 * const agents = registry.findAgentsByDomain('publisher.com');
 *
 * registry.stop();
 * ```
 */
export class PropertyRegistry {
  private readonly sync: RegistrySync;
  private lastSync: Date | null = null;

  constructor(config: PropertyRegistryConfig) {
    this.sync = new RegistrySync({
      client: config.registryClient,
      pollIntervalMs: config.pollInterval,
      cursorStore: config.cursorStore,
      indexes: { agents: true, authorizations: true, properties: true },
    });

    this.sync.on('sync', () => {
      this.lastSync = new Date();
    });

    this.sync.on('bootstrap', () => {
      this.lastSync = new Date();
    });
  }

  // ====== Lifecycle ======

  /** Bootstrap from the registry and begin background polling. */
  async start(): Promise<void> {
    await this.sync.start();
  }

  /** Stop background polling. In-memory state is preserved. */
  stop(): void {
    this.sync.stop();
  }

  // ====== Synchronous Queries ======

  /** Check if an agent has any authorization for a publisher domain. */
  isAuthorized(agentUrl: string, domain: string): boolean {
    return this.sync.isAuthorized(agentUrl, domain);
  }

  /** Get all authorizations for a publisher domain. */
  getAuthorizationsForDomain(domain: string): AuthorizationEntry[] {
    return this.sync.getAuthorizationsForDomain(domain);
  }

  /** Get all authorizations for an agent. */
  getAuthorizationsForAgent(agentUrl: string): AuthorizationEntry[] {
    return this.sync.getAuthorizationsForAgent(agentUrl);
  }

  /** Get an agent by URL. */
  getAgent(url: string): AgentSearchResult | undefined {
    return this.sync.getAgent(url);
  }

  /** Find agents that are authorized for a given domain. */
  findAgentsByDomain(domain: string): AgentSearchResult[] {
    const auths = this.sync.getAuthorizationsForDomain(domain);
    const agents: AgentSearchResult[] = [];
    for (const auth of auths) {
      const agent = this.sync.getAgent(auth.agent_url);
      if (agent) agents.push(agent);
    }
    return agents;
  }

  /** Get a registry property by property_rid. Merged aliases resolve to their canonical RID. */
  getProperty(rid: string): RegistrySyncProperty | undefined {
    return this.sync.getProperty(rid);
  }

  /** Get all registry properties for a publisher domain. */
  getPropertiesForDomain(domain: string): RegistrySyncProperty[] {
    return this.sync.getPropertiesForDomain(domain);
  }

  // ====== Stats ======

  getStats(): { agents: number; authorizations: number; properties: number; lastSync: Date | null } {
    const syncStats = this.sync.getStats();
    return {
      agents: syncStats.agents,
      authorizations: syncStats.authorizations,
      properties: syncStats.properties,
      lastSync: this.lastSync,
    };
  }
}
