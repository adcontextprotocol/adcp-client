import { EventEmitter } from 'node:events';
import type { RegistryClient } from './index';
import type {
  CatalogEvent,
  AgentSearchResult,
  AuthorizationEntry,
  AgentSearchResponse,
  FeedResponse,
} from './types.generated';

// ====== Configuration ======

export interface RegistrySyncConfig {
  /** RegistryClient instance to use for API calls. */
  client: RegistryClient;
  /** Polling interval in milliseconds. Default: 30000 (30s). */
  pollIntervalMs?: number;
  /** Choose which indexes to maintain. */
  indexes?: {
    /** Agent inventory profiles. Default: true. */
    agents?: boolean;
    /** Authorization entries (agent→domain mappings). Default: true. */
    authorizations?: boolean;
  };
  /** Called on errors during polling/bootstrap. */
  onError?: (error: Error) => void;
}

export type RegistrySyncState = 'idle' | 'bootstrapping' | 'syncing' | 'error';

// ====== Event types ======

export interface RegistrySyncEvents {
  bootstrap: [{ agentCount: number; authorizationCount: number }];
  sync: [{ cursor: string; eventsApplied: number }];
  event: [{ event: CatalogEvent }];
  error: [{ error: Error }];
  stateChange: [{ from: RegistrySyncState; to: RegistrySyncState }];
}

// ====== Agent filter for client-side search ======

export interface AgentFilter {
  type?: string;
  channels?: string[];
  markets?: string[];
  categories?: string[];
  property_types?: string[];
  tags?: string[];
  delivery_types?: string[];
  has_tmp?: boolean;
  min_properties?: number;
}

// ====== RegistrySync ======

/**
 * In-memory replica of the AdCP registry.
 *
 * Bootstraps from the agent search endpoint, then polls the event feed
 * to maintain up-to-date indexes for zero-latency lookups.
 *
 * @example
 * ```ts
 * const client = new RegistryClient({ apiKey: 'sk_...' });
 * const sync = new RegistrySync({ client });
 * await sync.start();
 *
 * // Zero-latency lookups
 * const agent = sync.getAgent('https://ads.example.com');
 * const authorized = sync.isAuthorized('https://ads.example.com', 'publisher.com');
 * const ctv = sync.findAgents({ channels: ['ctv'], markets: ['US'] });
 *
 * sync.on('event', ({ event }) => console.log('registry change:', event.event_type));
 * sync.stop();
 * ```
 */
export class RegistrySync extends EventEmitter<RegistrySyncEvents> {
  private readonly client: RegistryClient;
  private readonly pollIntervalMs: number;
  private readonly indexAgents: boolean;
  private readonly indexAuthorizations: boolean;
  private readonly errorHandler: ((error: Error) => void) | undefined;

  private _state: RegistrySyncState = 'idle';
  private cursor: string | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;

  // Indexes
  private agents = new Map<string, AgentSearchResult>();
  private authByDomain = new Map<string, AuthorizationEntry[]>();
  private authByAgent = new Map<string, AuthorizationEntry[]>();

  constructor(config: RegistrySyncConfig) {
    super();
    this.client = config.client;
    this.pollIntervalMs = config.pollIntervalMs ?? 30_000;
    this.indexAgents = config.indexes?.agents !== false;
    this.indexAuthorizations = config.indexes?.authorizations !== false;
    this.errorHandler = config.onError;
  }

  // ====== Lifecycle ======

  /** Bootstrap from the registry and begin polling the event feed. */
  async start(): Promise<void> {
    if (this._state === 'syncing') return;
    await this.bootstrap();
    this.schedulePoll();
  }

  /** Stop polling. In-memory state is preserved. */
  stop(): void {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /** Stop, clear all state, and re-bootstrap. */
  async reset(): Promise<void> {
    this.stop();
    this.agents.clear();
    this.authByDomain.clear();
    this.authByAgent.clear();
    this.cursor = null;
    this.setState('idle');
    await this.start();
  }

  // ====== Agent Lookups ======

  /** Get an agent by URL. */
  getAgent(url: string): AgentSearchResult | undefined {
    return this.agents.get(url);
  }

  /** Get all agents in the index. */
  getAgents(): AgentSearchResult[] {
    return [...this.agents.values()];
  }

  /** Find agents matching a filter. All specified dimensions use AND; values within arrays use OR. */
  findAgents(filter: AgentFilter): AgentSearchResult[] {
    return this.getAgents().filter(agent => {
      const p = agent.inventory_profile;
      if (filter.type && agent.type !== filter.type) return false;
      if (filter.channels?.length && !filter.channels.some(c => p.channels.includes(c))) return false;
      if (filter.markets?.length && !filter.markets.some(m => p.markets.includes(m))) return false;
      if (filter.categories?.length && !filter.categories.some(c => p.categories.includes(c))) return false;
      if (filter.property_types?.length && !filter.property_types.some(t => p.property_types.includes(t)))
        return false;
      if (filter.tags?.length && !filter.tags.some(t => p.tags.includes(t))) return false;
      if (filter.delivery_types?.length && !filter.delivery_types.some(d => p.delivery_types.includes(d)))
        return false;
      if (filter.has_tmp != null && p.has_tmp !== filter.has_tmp) return false;
      if (filter.min_properties != null && p.property_count < filter.min_properties) return false;
      return true;
    });
  }

  // ====== Authorization Lookups ======

  /** Get all authorizations for a publisher domain. */
  getAuthorizationsForDomain(domain: string): AuthorizationEntry[] {
    return this.authByDomain.get(domain) ?? [];
  }

  /** Get all authorizations for an agent. */
  getAuthorizationsForAgent(agentUrl: string): AuthorizationEntry[] {
    return this.authByAgent.get(agentUrl) ?? [];
  }

  /** Check if an agent is authorized for a publisher domain. */
  isAuthorized(agentUrl: string, domain: string): boolean {
    const entries = this.authByDomain.get(domain);
    return entries != null && entries.some(e => e.agent_url === agentUrl);
  }

  // ====== State ======

  get state(): RegistrySyncState {
    return this._state;
  }

  getCursor(): string | null {
    return this.cursor;
  }

  getStats(): { agents: number; authorizations: number } {
    let authCount = 0;
    for (const entries of this.authByDomain.values()) authCount += entries.length;
    return { agents: this.agents.size, authorizations: authCount };
  }

  // ====== Private: Bootstrap ======

  private async bootstrap(): Promise<void> {
    this.setState('bootstrapping');
    try {
      // Paginate searchAgents to load all agents
      if (this.indexAgents) {
        let cursor: string | undefined;
        do {
          const query: Record<string, unknown> = { limit: 200 };
          if (cursor) query.cursor = cursor;
          const res: AgentSearchResponse = await this.client.searchAgents(query as any);
          for (const agent of res.results) {
            this.agents.set(agent.url, agent);
          }
          cursor = res.has_more && res.cursor ? res.cursor : undefined;
        } while (cursor);
      }

      // Get initial feed cursor
      const feed: FeedResponse = await this.client.getFeed({ limit: 1000 });
      for (const event of feed.events) {
        this.applyEvent(event);
      }
      this.cursor = feed.cursor;

      // Drain remaining events
      while (feed.has_more && this.cursor) {
        const more = await this.client.getFeed({ cursor: this.cursor, limit: 1000 });
        for (const event of more.events) {
          this.applyEvent(event);
        }
        this.cursor = more.cursor;
        if (!more.has_more) break;
      }

      this.setState('syncing');
      this.emit('bootstrap', {
        agentCount: this.agents.size,
        authorizationCount: this.getStats().authorizations,
      });
    } catch (err) {
      this.setState('error');
      const error = err instanceof Error ? err : new Error(String(err));
      this.errorHandler?.(error);
      this.emit('error', { error });
      throw error;
    }
  }

  // ====== Private: Polling ======

  private schedulePoll(): void {
    this.pollTimer = setTimeout(() => this.pollLoop(), this.pollIntervalMs);
  }

  private async pollLoop(): Promise<void> {
    try {
      await this.poll();
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.emit('error', { error });
      this.errorHandler?.(error);
    }
    // Schedule next poll even after errors (will retry)
    if (this._state !== 'idle') {
      this.schedulePoll();
    }
  }

  private async poll(): Promise<void> {
    const feed = await this.client.getFeed({
      cursor: this.cursor ?? undefined,
      limit: 1000,
    });

    if (feed.cursor_expired) {
      await this.reset();
      return;
    }

    let eventsApplied = 0;
    for (const event of feed.events) {
      this.applyEvent(event);
      this.emit('event', { event });
      eventsApplied++;
    }

    if (feed.cursor) {
      this.cursor = feed.cursor;
    }

    // Drain has_more pages immediately
    if (feed.has_more && this.cursor) {
      await this.poll();
      return;
    }

    if (eventsApplied > 0) {
      this.emit('sync', { cursor: this.cursor!, eventsApplied });
    }
  }

  // ====== Private: Event Application ======

  private applyEvent(event: CatalogEvent): void {
    const payload = event.payload as Record<string, unknown>;

    switch (event.event_type) {
      case 'agent.discovered':
      case 'agent.profile_updated': {
        if (!this.indexAgents) break;
        const existing = this.agents.get(event.entity_id);
        if (existing && payload.inventory_profile) {
          // Update profile data
          this.agents.set(event.entity_id, {
            ...existing,
            inventory_profile: payload.inventory_profile as AgentSearchResult['inventory_profile'],
          });
        } else if (!existing) {
          // Stub entry for newly discovered agent
          this.agents.set(event.entity_id, {
            url: event.entity_id,
            name: (payload.name as string) ?? event.entity_id,
            type: (payload.type as AgentSearchResult['type']) ?? 'unknown',
            inventory_profile: (payload.inventory_profile as AgentSearchResult['inventory_profile']) ?? {
              channels: [],
              property_types: [],
              markets: [],
              categories: [],
              category_taxonomy: 'iab_content_3.0',
              tags: [],
              delivery_types: [],
              property_count: 0,
              publisher_count: 0,
              has_tmp: false,
            },
            match: { score: 0, matched_filters: [] },
          });
        }
        break;
      }

      case 'agent.removed': {
        if (this.indexAgents) this.agents.delete(event.entity_id);
        if (this.indexAuthorizations) this.authByAgent.delete(event.entity_id);
        break;
      }

      case 'authorization.granted': {
        if (!this.indexAuthorizations) break;
        const entry = payload as unknown as AuthorizationEntry;
        if (!entry.agent_url || !entry.publisher_domain || !entry.authorization_type) break;

        const domainEntries = this.authByDomain.get(entry.publisher_domain) ?? [];
        // Avoid duplicates
        if (!domainEntries.some(e => e.agent_url === entry.agent_url)) {
          domainEntries.push(entry);
          this.authByDomain.set(entry.publisher_domain, domainEntries);
        }

        const agentEntries = this.authByAgent.get(entry.agent_url) ?? [];
        if (!agentEntries.some(e => e.publisher_domain === entry.publisher_domain)) {
          agentEntries.push(entry);
          this.authByAgent.set(entry.agent_url, agentEntries);
        }
        break;
      }

      case 'authorization.revoked': {
        if (!this.indexAuthorizations) break;
        const agentUrl = payload.agent_url as string;
        const domain = payload.publisher_domain as string;
        if (!agentUrl || !domain) break;

        const domainEntries = this.authByDomain.get(domain);
        if (domainEntries) {
          const filtered = domainEntries.filter(e => e.agent_url !== agentUrl);
          if (filtered.length > 0) this.authByDomain.set(domain, filtered);
          else this.authByDomain.delete(domain);
        }

        const agentEntries = this.authByAgent.get(agentUrl);
        if (agentEntries) {
          const filtered = agentEntries.filter(e => e.publisher_domain !== domain);
          if (filtered.length > 0) this.authByAgent.set(agentUrl, filtered);
          else this.authByAgent.delete(agentUrl);
        }
        break;
      }

      // Property and publisher events: no-op for v1 (no property index yet)
      default:
        break;
    }
  }

  // ====== Private: State ======

  private setState(next: RegistrySyncState): void {
    const from = this._state;
    if (from === next) return;
    this._state = next;
    this.emit('stateChange', { from, to: next });
  }
}
