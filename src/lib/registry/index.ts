import type {
  ResolvedBrand,
  ResolvedProperty,
  PropertyInfo,
  RegistryClientConfig,
  SaveBrandRequest,
  SaveBrandResponse,
  SavePropertyRequest,
  SavePropertyResponse,
  BrandRegistryItem,
  PropertyRegistryItem,
  ValidationResult,
  FederatedAgentWithDetails,
  FederatedPublisher,
  DomainLookupResult,
  ListOptions,
  ListAgentsOptions,
  ValidateAdagentsRequest,
  CreateAdagentsRequest,
  ValidateProductAuthorizationRequest,
  ExpandProductIdentifiersRequest,
  PublisherPropertySelector,
  CompanySearchResult,
  FindCompanyResult,
  FeedQuery,
  FeedResponse,
  AgentSearchQuery,
  AgentSearchResponse,
  CrawlRequest,
  CrawlRequestResponse,
  BrandActivity,
  PropertyActivity,
  PolicySummary,
  Policy,
  PolicyHistory,
  ListPoliciesQuery,
  ListPoliciesResponse,
  ResolvePolicyQuery,
  ResolvePolicyResponse,
  ResolvePoliciesBulkRequest,
  ResolvePoliciesBulkResponse,
  GetPolicyHistoryQuery,
  GetPolicyHistoryResponse,
  SavePolicyRequest,
  SavePolicyResponse,
  GetBrandHistoryQuery,
  GetBrandHistoryResponse,
  GetPropertyHistoryQuery,
  GetPropertyHistoryResponse,
} from './types';

export type {
  ResolvedBrand,
  ResolvedProperty,
  PropertyInfo,
  RegistryClientConfig,
  SaveBrandRequest,
  SaveBrandResponse,
  SavePropertyRequest,
  SavePropertyResponse,
  BrandRegistryItem,
  PropertyRegistryItem,
  ValidationResult,
  FederatedAgentWithDetails,
  FederatedPublisher,
  DomainLookupResult,
  ListOptions,
  ListAgentsOptions,
  ValidateAdagentsRequest,
  CreateAdagentsRequest,
  ValidateProductAuthorizationRequest,
  ExpandProductIdentifiersRequest,
  PublisherPropertySelector,
  CompanySearchResult,
  FindCompanyResult,
  FeedQuery,
  AgentSearchQuery,
  CrawlRequest,
  ListPoliciesQuery,
  ListPoliciesResponse,
  ResolvePolicyQuery,
  ResolvePolicyResponse,
  ResolvePoliciesBulkRequest,
  ResolvePoliciesBulkResponse,
  GetPolicyHistoryQuery,
  GetPolicyHistoryResponse,
  SavePolicyRequest,
  SavePolicyResponse,
  GetBrandHistoryQuery,
  GetBrandHistoryResponse,
  GetPropertyHistoryQuery,
  GetPropertyHistoryResponse,
} from './types';

// Re-export all generated types for advanced usage
export type {
  paths,
  operations,
  components,
  LocalizedName,
  PropertyIdentifier,
  RegistryError,
  AgentHealth,
  AgentStats,
  AgentCapabilities,
  PropertySummary,
  CatalogEvent,
  FeedResponse,
  AgentInventoryProfile,
  AgentSearchResult,
  AgentSearchResponse,
  CrawlRequestResponse,
  AuthorizationEntry,
  BrandActivity,
  PropertyActivity,
  PolicySummary,
  Policy,
  PolicyHistory,
} from './types';

// Re-export RegistrySync
export { RegistrySync } from './sync';
export type { RegistrySyncConfig, RegistrySyncState, RegistrySyncEvents, AgentFilter } from './sync';

// Re-export CursorStore
export { InMemoryCursorStore, FileCursorStore } from './cursor-store';
export type { CursorStore } from './cursor-store';

// Re-export PropertyRegistry
export { PropertyRegistry } from './property-registry';
export type { PropertyRegistryConfig } from './property-registry';

const DEFAULT_BASE_URL = 'https://adcontextprotocol.org';
const MAX_BULK_DOMAINS = 100;
const MAX_CHECK_DOMAINS = 10000; // per OpenAPI spec maxItems

/**
 * Client for the AdCP Registry API.
 *
 * Covers brand resolution, property resolution, agent discovery,
 * authorization lookups, validation tools, and search.
 *
 * @example
 * ```ts
 * const registry = new RegistryClient({ apiKey: 'sk_...' });
 * const brand = await registry.lookupBrand('nike.com');
 * const agents = await registry.listAgents({ type: 'sales' });
 * const results = await registry.search('nike');
 * ```
 */
export class RegistryClient {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;

  constructor(config?: RegistryClientConfig) {
    this.baseUrl = (config?.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.apiKey = config?.apiKey ?? process.env.ADCP_REGISTRY_API_KEY;
  }

  // ====== Brand Resolution ======

  /** Resolve a single domain to its canonical brand identity. */
  async lookupBrand(domain: string): Promise<ResolvedBrand | null> {
    if (!domain?.trim()) throw new Error('domain is required');
    const url = `${this.baseUrl}/api/brands/resolve?domain=${encodeURIComponent(domain)}`;
    return this.get(url, { nullOn404: true });
  }

  /** Search for companies by name or keyword, resolving colloquial names to canonical brand forms. */
  async findCompany(query: string, options?: { limit?: number }): Promise<FindCompanyResult> {
    if (!query?.trim()) throw new Error('query is required');
    let url = `${this.baseUrl}/api/brands/find?q=${encodeURIComponent(query)}`;
    if (options?.limit != null) url += `&limit=${options.limit}`;
    return this.get(url);
  }

  /** Bulk resolve domains to their canonical brand identities (max 100). */
  async lookupBrands(domains: string[]): Promise<Record<string, ResolvedBrand | null>> {
    if (domains.length === 0) return {};
    if (domains.length > MAX_BULK_DOMAINS) {
      throw new Error(`Cannot resolve more than ${MAX_BULK_DOMAINS} domains at once (got ${domains.length})`);
    }
    const data = await this.post(`${this.baseUrl}/api/brands/resolve/bulk`, { domains });
    return data.results;
  }

  /** List brands in the registry with optional search and pagination. */
  async listBrands(options?: ListOptions): Promise<{ brands: BrandRegistryItem[]; stats: Record<string, unknown> }> {
    const params = this.buildParams(options);
    return this.get(`${this.baseUrl}/api/brands/registry${params}`);
  }

  /** Fetch raw brand.json data for a domain. */
  async getBrandJson(domain: string): Promise<Record<string, unknown> | null> {
    if (!domain?.trim()) throw new Error('domain is required');
    const url = `${this.baseUrl}/api/brands/brand-json?domain=${encodeURIComponent(domain)}`;
    return this.get(url, { nullOn404: true });
  }

  /** Enrich a brand with Brandfetch data. */
  async enrichBrand(domain: string): Promise<Record<string, unknown>> {
    if (!domain?.trim()) throw new Error('domain is required');
    return this.get(`${this.baseUrl}/api/brands/enrich?domain=${encodeURIComponent(domain)}`);
  }

  /** Save or update a community brand. Requires authentication. */
  async saveBrand(brand: SaveBrandRequest): Promise<SaveBrandResponse> {
    if (!brand?.domain?.trim()) throw new Error('domain is required');
    if (!brand?.brand_name?.trim()) throw new Error('brand_name is required');
    if (!this.apiKey) throw new Error('apiKey is required for save operations');
    return this.post(`${this.baseUrl}/api/brands/save`, brand);
  }

  // ====== Property Resolution ======

  /** Resolve a single domain to its property information. */
  async lookupProperty(domain: string): Promise<ResolvedProperty | null> {
    if (!domain?.trim()) throw new Error('domain is required');
    const url = `${this.baseUrl}/api/properties/resolve?domain=${encodeURIComponent(domain)}`;
    return this.get(url, { nullOn404: true });
  }

  /** Bulk resolve domains to their property information (max 100). */
  async lookupProperties(domains: string[]): Promise<Record<string, ResolvedProperty | null>> {
    if (domains.length === 0) return {};
    if (domains.length > MAX_BULK_DOMAINS) {
      throw new Error(`Cannot resolve more than ${MAX_BULK_DOMAINS} domains at once (got ${domains.length})`);
    }
    const data = await this.post(`${this.baseUrl}/api/properties/resolve/bulk`, { domains });
    return data.results;
  }

  /**
   * Bulk resolve any number of domains to property information.
   * Automatically paginates in batches of 100, running up to `concurrency`
   * batches in parallel (default 5).
   */
  async lookupPropertiesAll(
    domains: string[],
    options?: { concurrency?: number }
  ): Promise<Record<string, ResolvedProperty | null>> {
    const unique = [...new Set(domains)];
    const concurrency = options?.concurrency ?? 5;
    const batches: string[][] = [];
    for (let i = 0; i < unique.length; i += MAX_BULK_DOMAINS) {
      batches.push(unique.slice(i, i + MAX_BULK_DOMAINS));
    }
    const results: Record<string, ResolvedProperty | null> = {};
    for (let i = 0; i < batches.length; i += concurrency) {
      const chunk = batches.slice(i, i + concurrency);
      const settled = await Promise.all(chunk.map(b => this.lookupProperties(b)));
      for (const r of settled) Object.assign(results, r);
    }
    return results;
  }

  /**
   * Check which domains exist in the registry.
   * Convenience wrapper over lookupPropertiesAll that returns a simple boolean map.
   * Use this for existence checks; use lookupPropertiesAll when you need the full property data.
   */
  async domainsExist(domains: string[], options?: { concurrency?: number }): Promise<Record<string, boolean>> {
    const results = await this.lookupPropertiesAll(domains, options);
    const exists: Record<string, boolean> = {};
    for (const [domain, resolved] of Object.entries(results)) {
      exists[domain] = resolved != null;
    }
    return exists;
  }

  /** List properties in the registry with optional search and pagination. */
  async listProperties(
    options?: ListOptions
  ): Promise<{ properties: PropertyRegistryItem[]; stats: Record<string, unknown> }> {
    const params = this.buildParams(options);
    return this.get(`${this.baseUrl}/api/properties/registry${params}`);
  }

  /** Validate a domain's adagents.json file. */
  async validateProperty(domain: string): Promise<ValidationResult> {
    if (!domain?.trim()) throw new Error('domain is required');
    return this.get(`${this.baseUrl}/api/properties/validate?domain=${encodeURIComponent(domain)}`);
  }

  /** Save or update a hosted property. Requires authentication. */
  async saveProperty(property: SavePropertyRequest): Promise<SavePropertyResponse> {
    if (!property?.publisher_domain?.trim()) throw new Error('publisher_domain is required');
    if (!Array.isArray(property?.authorized_agents)) throw new Error('authorized_agents is required');
    if (!this.apiKey) throw new Error('apiKey is required for save operations');
    return this.post(`${this.baseUrl}/api/properties/save`, property);
  }

  /**
   * Save or update multiple hosted properties.
   * Client-side fan-out over saveProperty with configurable concurrency.
   * Returns results keyed by publisher_domain; failed saves include an error message.
   */
  async saveProperties(
    properties: SavePropertyRequest[],
    options?: { concurrency?: number }
  ): Promise<Record<string, SavePropertyResponse | { error: string }>> {
    const concurrency = options?.concurrency ?? 5;
    const results: Record<string, SavePropertyResponse | { error: string }> = {};
    for (let i = 0; i < properties.length; i += concurrency) {
      const batch = properties.slice(i, i + concurrency);
      const settled = await Promise.allSettled(batch.map(p => this.saveProperty(p)));
      for (let j = 0; j < batch.length; j++) {
        const domain = batch[j]!.publisher_domain;
        const s = settled[j]!;
        results[domain] = s.status === 'fulfilled' ? s.value : { error: String(s.reason) };
      }
    }
    return results;
  }

  // ====== Agent Discovery ======

  /** List registered agents with optional filtering. */
  async listAgents(
    options?: ListAgentsOptions
  ): Promise<{ agents: FederatedAgentWithDetails[]; count: number; sources: Record<string, unknown> }> {
    const params = new URLSearchParams();
    if (options?.type) params.set('type', options.type);
    if (options?.health) params.set('health', 'true');
    if (options?.capabilities) params.set('capabilities', 'true');
    if (options?.properties) params.set('properties', 'true');
    const qs = params.toString();
    return this.get(`${this.baseUrl}/api/registry/agents${qs ? '?' + qs : ''}`);
  }

  /** List publishers in the registry. */
  async listPublishers(): Promise<{
    publishers: FederatedPublisher[];
    count: number;
    sources: Record<string, unknown>;
  }> {
    return this.get(`${this.baseUrl}/api/registry/publishers`);
  }

  /** Get aggregate registry statistics. */
  async getRegistryStats(): Promise<Record<string, unknown>> {
    return this.get(`${this.baseUrl}/api/registry/stats`);
  }

  // ====== Authorization Lookups ======

  /**
   * Look up which agents are authorized for a domain.
   * Returns agent authorization data (authorized_agents, sales_agents_claiming).
   * To check if a domain exists in the registry, use lookupProperty() or domainsExist() instead.
   */
  async lookupDomain(domain: string): Promise<DomainLookupResult> {
    if (!domain?.trim()) throw new Error('domain is required');
    return this.get(`${this.baseUrl}/api/registry/lookup/domain/${encodeURIComponent(domain)}`);
  }

  /**
   * Look up agents authorized for multiple domains.
   * Client-side fan-out over lookupDomain (no server bulk endpoint yet).
   * Domains that fail individually are omitted from the result.
   */
  async lookupDomains(
    domains: string[],
    options?: { concurrency?: number }
  ): Promise<Record<string, DomainLookupResult>> {
    const unique = [...new Set(domains)];
    const concurrency = options?.concurrency ?? 10;
    const results: Record<string, DomainLookupResult> = {};
    for (let i = 0; i < unique.length; i += concurrency) {
      const batch = unique.slice(i, i + concurrency);
      const settled = await Promise.allSettled(batch.map(d => this.lookupDomain(d)));
      for (let j = 0; j < batch.length; j++) {
        const s = settled[j]!;
        if (s.status === 'fulfilled') results[batch[j]!] = s.value;
      }
    }
    return results;
  }

  /**
   * Look up agents authorized for multiple property identifiers.
   * Client-side fan-out over lookupPropertyByIdentifier.
   * Identifiers that fail individually are omitted from the result.
   */
  async lookupPropertyIdentifiers(
    identifiers: { type: string; value: string }[],
    options?: { concurrency?: number }
  ): Promise<Record<string, Record<string, unknown>>> {
    const concurrency = options?.concurrency ?? 10;
    // Deduplicate by "type:value" key
    const seen = new Set<string>();
    const unique: { type: string; value: string }[] = [];
    for (const id of identifiers) {
      const key = `${id.type}:${id.value}`;
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(id);
      }
    }
    const results: Record<string, Record<string, unknown>> = {};
    for (let i = 0; i < unique.length; i += concurrency) {
      const batch = unique.slice(i, i + concurrency);
      const settled = await Promise.allSettled(batch.map(id => this.lookupPropertyByIdentifier(id.type, id.value)));
      for (let j = 0; j < batch.length; j++) {
        const s = settled[j]!;
        const key = `${batch[j]!.type}:${batch[j]!.value}`;
        if (s.status === 'fulfilled') results[key] = s.value;
      }
    }
    return results;
  }

  /** Look up agents by property identifier (type + value). */
  async lookupPropertyByIdentifier(type: string, value: string): Promise<Record<string, unknown>> {
    if (!type?.trim()) throw new Error('type is required');
    if (!value?.trim()) throw new Error('value is required');
    const params = `?type=${encodeURIComponent(type)}&value=${encodeURIComponent(value)}`;
    return this.get(`${this.baseUrl}/api/registry/lookup/property${params}`);
  }

  /** Get domains associated with an agent. */
  async getAgentDomains(agentUrl: string): Promise<{ agent_url: string; domains: string[]; count: number }> {
    if (!agentUrl?.trim()) throw new Error('agentUrl is required');
    return this.get(`${this.baseUrl}/api/registry/lookup/agent/${encodeURIComponent(agentUrl)}/domains`);
  }

  /** Check if an agent is authorized for a specific property identifier. */
  async validatePropertyAuthorization(
    agentUrl: string,
    identifierType: string,
    identifierValue: string
  ): Promise<{
    agent_url: string;
    identifier_type: string;
    identifier_value: string;
    authorized: boolean;
    checked_at: string;
  }> {
    if (!agentUrl?.trim()) throw new Error('agentUrl is required');
    const params = new URLSearchParams({
      agent_url: agentUrl,
      identifier_type: identifierType,
      identifier_value: identifierValue,
    });
    return this.get(`${this.baseUrl}/api/registry/validate/property-authorization?${params}`);
  }

  /** Validate product authorization for an agent across publisher properties. */
  async validateProductAuthorization(
    agentUrl: string,
    publisherProperties: PublisherPropertySelector[]
  ): Promise<Record<string, unknown>> {
    return this.post(`${this.baseUrl}/api/registry/validate/product-authorization`, {
      agent_url: agentUrl,
      publisher_properties: publisherProperties,
    });
  }

  /** Expand product identifiers for an agent across publisher properties. */
  async expandProductIdentifiers(
    agentUrl: string,
    publisherProperties: PublisherPropertySelector[]
  ): Promise<Record<string, unknown>> {
    return this.post(`${this.baseUrl}/api/registry/expand/product-identifiers`, {
      agent_url: agentUrl,
      publisher_properties: publisherProperties,
    });
  }

  // ====== Property List Checking ======

  /**
   * Check a list of publisher domains against the AAO registry.
   *
   * Normalizes domains (strips www/m prefixes), removes duplicates, flags known ad tech
   * infrastructure, and identifies domains not yet in the registry. Returns four buckets:
   * - `remove`: duplicates or known blocked domains (ad servers, CDNs, trackers)
   * - `modify`: domains that were normalized (e.g. www.example.com → example.com)
   * - `assess`: unknown domains not in registry, not blocked
   * - `ok`: domains found in registry with no changes needed
   *
   * Results are stored for 7 days and retrievable via the `report_id`.
   *
   * For domains in the `modify` bucket, use the `canonical` value (not the original `input`)
   * for subsequent lookupProperties/lookupDomain calls.
   */
  async checkPropertyList(domains: string[]): Promise<{
    summary: { total: number; remove: number; modify: number; assess: number; ok: number };
    remove: Array<{
      input: string;
      canonical: string;
      reason: 'duplicate' | 'blocked';
      domain_type?: string;
      blocked_reason?: string;
    }>;
    modify: Array<{ input: string; canonical: string; reason: string }>;
    assess: Array<{ domain: string }>;
    ok: Array<{ domain: string; source: string }>;
    report_id: string;
  }> {
    if (!domains?.length) throw new Error('domains is required');
    if (domains.length > MAX_CHECK_DOMAINS) {
      throw new Error(`Cannot check more than ${MAX_CHECK_DOMAINS} domains at once (got ${domains.length})`);
    }
    return this.post(`${this.baseUrl}/api/properties/check`, { domains });
  }

  /**
   * Retrieve a previously stored property check report by ID.
   * Reports expire after 7 days.
   *
   * Note: the report endpoint only returns the summary counts, not the full per-domain
   * buckets. Use checkPropertyList to get the full detail (stored for 7 days via report_id).
   */
  async getPropertyCheckReport(reportId: string): Promise<{
    summary: { total: number; remove: number; modify: number; assess: number; ok: number };
  }> {
    if (!reportId?.trim()) throw new Error('reportId is required');
    return this.get(`${this.baseUrl}/api/properties/check/${encodeURIComponent(reportId)}`);
  }

  // ====== Adagents Tooling ======

  /** Validate a domain's adagents.json compliance. */
  async validateAdagents(domain: string): Promise<Record<string, unknown>> {
    if (!domain?.trim()) throw new Error('domain is required');
    return this.post(`${this.baseUrl}/api/adagents/validate`, { domain });
  }

  /** Generate a valid adagents.json from an agent configuration. */
  async createAdagents(config: CreateAdagentsRequest): Promise<Record<string, unknown>> {
    return this.post(`${this.baseUrl}/api/adagents/create`, config);
  }

  // ====== Search & Discovery ======

  /** Search brands, publishers, and properties. */
  async search(query: string): Promise<{ brands: unknown[]; publishers: unknown[]; properties: unknown[] }> {
    if (!query?.trim()) throw new Error('query is required');
    return this.get(`${this.baseUrl}/api/search?q=${encodeURIComponent(query)}`);
  }

  /** Look up a manifest reference by domain. */
  async lookupManifestRef(domain: string, type?: string): Promise<Record<string, unknown>> {
    if (!domain?.trim()) throw new Error('domain is required');
    const params = new URLSearchParams({ domain });
    if (type) params.set('type', type);
    return this.get(`${this.baseUrl}/api/manifest-refs/lookup?${params}`);
  }

  /** Probe a live agent endpoint to discover its capabilities. */
  async discoverAgent(url: string): Promise<Record<string, unknown>> {
    if (!url?.trim()) throw new Error('url is required');
    return this.get(`${this.baseUrl}/api/public/discover-agent?url=${encodeURIComponent(url)}`);
  }

  /** Get creative formats supported by an agent. */
  async getAgentFormats(url: string): Promise<Record<string, unknown>> {
    if (!url?.trim()) throw new Error('url is required');
    return this.get(`${this.baseUrl}/api/public/agent-formats?url=${encodeURIComponent(url)}`);
  }

  /** Get products available from an agent. */
  async getAgentProducts(url: string): Promise<Record<string, unknown>> {
    if (!url?.trim()) throw new Error('url is required');
    return this.get(`${this.baseUrl}/api/public/agent-products?url=${encodeURIComponent(url)}`);
  }

  /** Validate a publisher domain's configuration. */
  async validatePublisher(domain: string): Promise<Record<string, unknown>> {
    if (!domain?.trim()) throw new Error('domain is required');
    return this.get(`${this.baseUrl}/api/public/validate-publisher?domain=${encodeURIComponent(domain)}`);
  }

  // ====== Registry Sync ======

  /**
   * Poll the catalog event feed. Returns events since the provided cursor.
   * Consumers save `cursor` from the response and pass it on the next poll.
   * When `has_more` is false, the consumer is caught up.
   *
   * Requires authentication.
   */
  async getFeed(options?: FeedQuery): Promise<FeedResponse> {
    if (!this.apiKey) throw new Error('apiKey is required for feed access');
    const params = new URLSearchParams();
    if (options?.cursor) params.set('cursor', options.cursor);
    if (options?.types) params.set('types', options.types);
    if (options?.limit != null) params.set('limit', String(options.limit));
    const qs = params.toString();
    return this.get(`${this.baseUrl}/api/registry/feed${qs ? '?' + qs : ''}`);
  }

  /**
   * Search agents by inventory profile. Returns ranked results with match scores.
   * All filters use AND logic across dimensions; multiple CSV values within a
   * filter use OR.
   *
   * Requires authentication.
   */
  async searchAgents(query?: AgentSearchQuery): Promise<AgentSearchResponse> {
    if (!this.apiKey) throw new Error('apiKey is required for agent search');
    const params = new URLSearchParams();
    if (query?.type) params.set('type', query.type);
    if (query?.channels) params.set('channels', query.channels);
    if (query?.markets) params.set('markets', query.markets);
    if (query?.categories) params.set('categories', query.categories);
    if (query?.property_types) params.set('property_types', query.property_types);
    if (query?.tags) params.set('tags', query.tags);
    if (query?.delivery_types) params.set('delivery_types', query.delivery_types);
    if (query?.has_tmp != null) params.set('has_tmp', String(query.has_tmp));
    if (query?.min_properties != null) params.set('min_properties', String(query.min_properties));
    if (query?.sort) params.set('sort', query.sort);
    if (query?.limit != null) params.set('limit', String(query.limit));
    if (query?.cursor) params.set('cursor', query.cursor);
    const qs = params.toString();
    return this.get(`${this.baseUrl}/api/registry/agents/search${qs ? '?' + qs : ''}`);
  }

  /**
   * Request immediate re-crawl of a domain's adagents.json.
   * Rate limited to one crawl per domain per 10 minutes.
   *
   * Requires authentication.
   */
  async requestCrawl(domain: string): Promise<CrawlRequestResponse> {
    if (!domain?.trim()) throw new Error('domain is required');
    if (!this.apiKey) throw new Error('apiKey is required for crawl requests');
    return this.post(`${this.baseUrl}/api/registry/crawl-request`, { domain });
  }

  // ====== Policy Management ======

  /** List policies in the governance policy registry with optional filtering. */
  async listPolicies(params?: ListPoliciesQuery): Promise<ListPoliciesResponse> {
    const qs = new URLSearchParams();
    if (params?.search) qs.set('search', params.search);
    if (params?.category) qs.set('category', params.category);
    if (params?.enforcement) qs.set('enforcement', params.enforcement);
    if (params?.jurisdiction) qs.set('jurisdiction', params.jurisdiction);
    if (params?.policy_category) qs.set('policy_category', params.policy_category);
    if (params?.domain) qs.set('domain', params.domain);
    if (params?.limit != null) qs.set('limit', String(params.limit));
    if (params?.offset != null) qs.set('offset', String(params.offset));
    const q = qs.toString();
    return this.get(`${this.baseUrl}/api/policies/registry${q ? '?' + q : ''}`);
  }

  /** Resolve a single policy by ID. Optionally pin to a specific version. */
  async resolvePolicy(params: ResolvePolicyQuery): Promise<ResolvePolicyResponse | null> {
    if (!params?.policy_id?.trim()) throw new Error('policy_id is required');
    const qs = new URLSearchParams({ policy_id: params.policy_id });
    if (params.version) qs.set('version', params.version);
    return this.get(`${this.baseUrl}/api/policies/resolve?${qs}`, { nullOn404: true });
  }

  /** Bulk resolve up to 100 policies by ID in a single request. */
  async resolvePoliciesBulk(body: ResolvePoliciesBulkRequest): Promise<ResolvePoliciesBulkResponse> {
    if (!body?.policy_ids?.length) throw new Error('policy_ids is required');
    return this.post(`${this.baseUrl}/api/policies/resolve/bulk`, body);
  }

  /** Retrieve the edit history for a policy. */
  async getPolicyHistory(params: GetPolicyHistoryQuery): Promise<GetPolicyHistoryResponse | null> {
    if (!params?.policy_id?.trim()) throw new Error('policy_id is required');
    const qs = new URLSearchParams({ policy_id: params.policy_id });
    if (params.limit != null) qs.set('limit', String(params.limit));
    if (params.offset != null) qs.set('offset', String(params.offset));
    return this.get(`${this.baseUrl}/api/policies/history?${qs}`, { nullOn404: true });
  }

  /** Create or update a community-contributed policy. Requires authentication. */
  async savePolicy(body: SavePolicyRequest): Promise<SavePolicyResponse> {
    if (!body?.policy_id?.trim()) throw new Error('policy_id is required');
    if (!body?.version?.trim()) throw new Error('version is required');
    if (!body?.name?.trim()) throw new Error('name is required');
    if (!body?.policy?.trim()) throw new Error('policy is required');
    if (!this.apiKey) throw new Error('apiKey is required for save operations');
    return this.post(`${this.baseUrl}/api/policies/save`, body);
  }

  // ====== History ======

  /** Retrieve brand activity history for a domain. */
  async getBrandHistory(params: GetBrandHistoryQuery): Promise<GetBrandHistoryResponse | null> {
    if (!params?.domain?.trim()) throw new Error('domain is required');
    const qs = new URLSearchParams({ domain: params.domain });
    if (params.limit != null) qs.set('limit', String(params.limit));
    if (params.offset != null) qs.set('offset', String(params.offset));
    return this.get(`${this.baseUrl}/api/brands/history?${qs}`, { nullOn404: true });
  }

  /** Retrieve property activity history for a domain. */
  async getPropertyHistory(params: GetPropertyHistoryQuery): Promise<GetPropertyHistoryResponse | null> {
    if (!params?.domain?.trim()) throw new Error('domain is required');
    const qs = new URLSearchParams({ domain: params.domain });
    if (params.limit != null) qs.set('limit', String(params.limit));
    if (params.offset != null) qs.set('offset', String(params.offset));
    return this.get(`${this.baseUrl}/api/properties/history?${qs}`, { nullOn404: true });
  }

  // ====== Private helpers ======

  private async get<T = any>(url: string, opts?: { nullOn404?: boolean }): Promise<T> {
    const res = await fetch(url, { headers: this.getHeaders() });
    if (opts?.nullOn404 && res.status === 404) return null as T;
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Registry request failed (${res.status}): ${body}`);
    }
    return this.parseJson(res);
  }

  private async post<T = any>(url: string, body: unknown): Promise<T> {
    const res = await fetch(url, {
      method: 'POST',
      headers: { ...this.getHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Registry request failed (${res.status}): ${text}`);
    }
    return this.parseJson(res);
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }
    return headers;
  }

  private async parseJson(res: Response): Promise<any> {
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`Registry returned invalid JSON: ${text.slice(0, 200)}`);
    }
  }

  private buildParams(options?: ListOptions): string {
    if (!options) return '';
    const params = new URLSearchParams();
    if (options.search) params.set('search', options.search);
    if (options.limit != null) params.set('limit', String(options.limit));
    if (options.offset != null) params.set('offset', String(options.offset));
    const qs = params.toString();
    return qs ? '?' + qs : '';
  }
}
