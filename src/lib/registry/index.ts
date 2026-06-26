import type {
  ResolvedBrand,
  ResolvedProperty,
  PropertyInfo,
  RegistryClientConfig,
  SaveBrandRequest,
  SaveBrandResponse,
  ListBrandLogosOptions,
  ListBrandLogosResponse,
  SaveBrandLogoInput,
  SaveBrandLogoResponse,
  UploadBrandLogoInput,
  UploadBrandLogoResponse,
  SavePropertyRequest,
  SavePropertyResponse,
  BrandRegistryItem,
  PropertyRegistryItem,
  ValidationResult,
  FederatedAgentWithDetails,
  FederatedPublisher,
  DomainLookupResult,
  ListBrandsOptions,
  ListOptions,
  ListAgentsOptions,
  ListAgentsResponse,
  ListPublishersResponse,
  ValidateAdagentsRequest,
  CreateAdagentsRequest,
  CreateAdagentsResponse,
  CommunityMirrorAdagentsConfig,
  CreateCommunityMirrorAdagentsConfig,
  CommunityMirrorAdagentsCatalog,
  PublishCommunityMirrorAdagentsResponse,
  ListCommunityMirrorAdagentsResponse,
  DeleteCommunityMirrorAdagentsResponse,
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
  ManagerRevalidationRequest,
  ManagerRevalidationResponse,
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
  AgentCompliance,
  AgentComplianceDetail,
  StoryboardStatus,
  OperatorLookupResult,
  PublisherLookupResult,
  ComplianceChangedPayload,
  GetAgentStoryboardStatusResponse,
  GetAgentStoryboardStatusBulkResponse,
} from './types';

export type {
  ResolvedBrand,
  ResolvedProperty,
  PropertyInfo,
  RegistryClientConfig,
  SaveBrandRequest,
  SaveBrandResponse,
  BrandLogoReviewStatus,
  ApprovedBrandLogoAsset,
  PendingBrandLogoAsset,
  ReviewedBrandLogoAsset,
  BrandLogoAsset,
  ListBrandLogosOptions,
  ListBrandLogosResponse,
  SaveBrandLogoInput,
  SaveBrandLogoResponse,
  UploadBrandLogoInput,
  UploadBrandLogoResponse,
  SavePropertyRequest,
  SavePropertyResponse,
  BrandRegistryItem,
  PropertyRegistryItem,
  ValidationResult,
  FederatedAgentWithDetails,
  FederatedPublisher,
  DomainLookupResult,
  ListBrandsOptions,
  ListOptions,
  ListAgentsOptions,
  ListAgentsResponse,
  ListPublishersResponse,
  ValidateAdagentsRequest,
  CreateAdagentsRequest,
  CreateAdagentsResponse,
  AdagentsAuthorizedAgent,
  AdagentsCatalogFormat,
  AdagentsPlacementDefinition,
  AdagentsPlacementFormatReference,
  AdagentsPlacementFormatOption,
  AdagentsPlacementTag,
  CreatedAdagentsJson,
  CommunityMirrorAdagentsConfig,
  CreateCommunityMirrorAdagentsConfig,
  CommunityMirrorAdagentsCatalog,
  PublishCommunityMirrorAdagentsResponse,
  CommunityMirrorAdagentsSummary,
  ListCommunityMirrorAdagentsResponse,
  GetCommunityMirrorAdagentsResponse,
  PublishCommunityMirrorAdagentsRequest,
  PublishCommunityMirrorAdagentsError,
  DeleteCommunityMirrorAdagentsResponse,
  ValidateProductAuthorizationRequest,
  ExpandProductIdentifiersRequest,
  PublisherPropertySelector,
  CompanySearchResult,
  FindCompanyResult,
  FeedQuery,
  AgentSearchQuery,
  CrawlRequest,
  ManagerRevalidationRequest,
  ManagerRevalidationResponse,
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
  AgentComplianceDetail,
  StoryboardStatus,
  OperatorLookupResult,
  PublisherLookupResult,
  ComplianceChangedPayload,
  GetAgentStoryboardStatusResponse,
  GetAgentStoryboardStatusBulkResponse,
} from './types';

// Re-export all generated types for advanced usage
export type {
  paths,
  operations,
  components,
  LocalizedName,
  PropertyIdentifier,
  RegistryError,
  AgentCompliance,
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
  CommunityMirrorListResponse,
  CommunityMirrorSummary,
  CommunityMirrorGetResponse,
  CommunityMirrorAdagentsJson,
  CommunityMirrorPublishResponse,
  CommunityMirrorPublishError,
  CommunityMirrorPublishRequest,
  CommunityMirrorDeleteResponse,
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

const DEFAULT_BASE_URL = 'https://agenticadvertising.org';
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BODY_BYTES = 256 * 1024;
const DEFAULT_LARGE_RESPONSE_MAX_BODY_BYTES = 2 * 1024 * 1024;
const ERROR_BODY_PREVIEW_CHARS = 200;
const MAX_BULK_DOMAINS = 100;
const MAX_CHECK_DOMAINS = 10000; // per OpenAPI spec maxItems
const COMMUNITY_MIRROR_PLATFORM_RE = /^[a-z0-9_-]{1,64}$/;

/**
 * Build a catalog-only community mirror adagents.json descriptor.
 *
 * Community mirrors are for format, placement, and property discovery when a
 * platform has not published its own seller-authorized file yet. This helper
 * always emits `authorized_agents: []` and rejects caller-supplied
 * authorization claims so the resulting descriptor cannot accidentally imply
 * platform adoption or seller authorization.
 */
export function buildCommunityMirrorAdagents(config: CommunityMirrorAdagentsConfig): CommunityMirrorAdagentsCatalog {
  const maybeConfig = config as CommunityMirrorAdagentsConfig & {
    authorized_agents?: unknown;
    include_schema?: unknown;
    include_timestamp?: unknown;
    platform?: unknown;
  };
  if ('authorized_agents' in maybeConfig) {
    throw new Error('authorized_agents is not accepted for community mirror adagents catalogs');
  }
  if ('include_schema' in maybeConfig || 'include_timestamp' in maybeConfig) {
    throw new Error('include_schema and include_timestamp are not accepted for community mirror adagents catalogs');
  }
  const contentKeys = ['formats', 'properties', 'placements', 'collections', 'signals'] as const;
  const hasCatalogContent = contentKeys.some(key => {
    const value = (config as Record<string, unknown>)[key];
    return Array.isArray(value) && value.length > 0;
  });
  if (!hasCatalogContent) {
    throw new Error('community mirror catalogs require at least one non-empty catalog collection');
  }

  const { platform: _platform, ...catalogConfig } = maybeConfig;

  return {
    ...catalogConfig,
    authorized_agents: [],
  };
}

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
  private readonly timeoutMs: number;
  private readonly maxBodyBytes: number;
  private readonly hasCustomMaxBodyBytes: boolean;
  private readonly redirect: 'follow' | 'error';
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(config?: RegistryClientConfig) {
    this.baseUrl = (config?.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.apiKey = config?.apiKey ?? process.env.ADCP_REGISTRY_API_KEY;
    this.timeoutMs = config?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxBodyBytes = config?.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    this.hasCustomMaxBodyBytes = config?.maxBodyBytes != null;
    this.redirect = config?.redirect ?? 'error';
    this.fetchImpl = config?.fetch ?? globalThis.fetch;
  }

  // ====== Brand Resolution ======

  /**
   * Resolve a single domain to its canonical brand identity.
   *
   * @remarks
   * Resolved registry data may include `brand_manifest` and `source` fields
   * suitable for downstream request construction. Treat all registry-supplied
   * strings as untrusted input and sanitize before injecting them into LLM
   * prompts, instructions, or tool-planning context.
   */
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
  async listBrands(
    options?: ListBrandsOptions
  ): Promise<{ brands: BrandRegistryItem[]; stats: Record<string, unknown> }> {
    const params = this.buildParams(options);
    return this.get(`${this.baseUrl}/api/brands/registry${params}`);
  }

  /**
   * Fetch raw brand.json data for a domain.
   *
   * @remarks
   * This returns registry-supplied manifest content. Sanitize strings before
   * using them in LLM prompts, instructions, or other executable context.
   */
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

  /**
   * List AAO brand logo assets for a domain, optionally filtered by tags.
   *
   * @remarks
   * Passing a raw `string[]` as the second argument is deprecated; pass
   * `{ tags }` instead.
   */
  async listBrandLogos(domain: string, options?: ListBrandLogosOptions | string[]): Promise<ListBrandLogosResponse> {
    if (!domain?.trim()) throw new Error('domain is required');
    const params = new URLSearchParams();
    const tags = Array.isArray(options) ? options : options?.tags;
    if (tags?.length) params.set('tags', tags.join(','));
    const qs = params.toString();
    const response = await this.get<Record<string, unknown>>(
      `${this.baseUrl}/api/brands/${encodeURIComponent(domain)}/logos${qs ? `?${qs}` : ''}`
    );
    return this.normalizeBrandLogoList(response);
  }

  /** Save an AAO brand logo asset for review. Requires authentication. */
  async saveBrandLogo(input: SaveBrandLogoInput): Promise<SaveBrandLogoResponse> {
    if (!input?.domain?.trim()) throw new Error('domain is required');
    if (!input?.filename?.trim()) throw new Error('filename is required');
    if (!input?.mimeType?.trim()) throw new Error('mimeType is required');
    if (input.data == null) throw new Error('data is required');
    if (!input.tags?.length) throw new Error('tags are required');
    if (!this.apiKey) throw new Error('apiKey is required for save operations');

    const form = new FormData();
    form.append('file', this.toBrandLogoBlob(input.data, input.mimeType), input.filename);
    if (input.note) form.append('note', input.note);
    form.append('tags', input.tags.join(','));

    return this.postFormData(`${this.baseUrl}/api/brands/${encodeURIComponent(input.domain)}/logos`, form);
  }

  /** @deprecated Use `saveBrandLogo()`. */
  async uploadBrandLogo(input: UploadBrandLogoInput): Promise<UploadBrandLogoResponse> {
    return this.saveBrandLogo(input);
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
  async listAgents(options?: ListAgentsOptions): Promise<ListAgentsResponse> {
    const params = new URLSearchParams();
    if (options?.type) params.set('type', options.type);
    this.setTrueParam(params, 'health', options?.health);
    this.setTrueParam(params, 'capabilities', options?.capabilities);
    this.setTrueParam(params, 'properties', options?.properties);
    this.setTrueParam(params, 'compliance', options?.compliance);
    this.appendParamValues(params, 'metric_id', options?.metric_id);
    this.appendParamValues(params, 'accreditation', options?.accreditation);
    if (options?.q) params.set('q', options.q);
    this.appendParamValues(params, 'verification_mode', options?.verification_mode);
    this.setTrueParam(params, 'verified', options?.verified);
    const qs = params.toString();
    return this.withSources(await this.get(`${this.baseUrl}/api/registry/agents${qs ? '?' + qs : ''}`));
  }

  /** List publishers in the registry. */
  async listPublishers(): Promise<ListPublishersResponse> {
    return this.withSources(await this.get(`${this.baseUrl}/api/registry/publishers`));
  }

  /** Get aggregate registry statistics. */
  async getRegistryStats(): Promise<Record<string, unknown>> {
    return this.get(`${this.baseUrl}/api/registry/stats`);
  }

  // ====== Compliance ======

  /** Get compliance status for an agent, including storyboard pass/fail counts. Returns null if agent not found. */
  async getAgentCompliance(agentUrl: string): Promise<AgentComplianceDetail | null> {
    if (!agentUrl?.trim()) throw new Error('agentUrl is required');
    return this.get(`${this.baseUrl}/api/registry/agents/${encodeURIComponent(agentUrl)}/compliance`, {
      nullOn404: true,
    });
  }

  /** Get per-storyboard compliance detail for an agent. Requires authentication. */
  async getAgentStoryboardStatus(agentUrl: string): Promise<GetAgentStoryboardStatusResponse> {
    if (!agentUrl?.trim()) throw new Error('agentUrl is required');
    if (!this.apiKey) throw new Error('apiKey is required for storyboard status');
    return this.get(`${this.baseUrl}/api/registry/agents/${encodeURIComponent(agentUrl)}/storyboard-status`);
  }

  /** Bulk query storyboard status for up to 100 agents. Requires authentication. */
  async getAgentStoryboardStatusBulk(agentUrls: string[]): Promise<GetAgentStoryboardStatusBulkResponse> {
    if (!agentUrls?.length) throw new Error('agentUrls is required');
    const unique = [...new Set(agentUrls.map(u => u?.trim()).filter(Boolean))];
    if (unique.length === 0) throw new Error('agentUrls contains no valid entries');
    if (unique.length > MAX_BULK_DOMAINS) {
      throw new Error(`Cannot query more than ${MAX_BULK_DOMAINS} agents at once (got ${unique.length})`);
    }
    if (!this.apiKey) throw new Error('apiKey is required for storyboard status');
    return this.post(`${this.baseUrl}/api/registry/agents/storyboard-status`, { agent_urls: unique });
  }

  // ====== Operator & Publisher Lookups ======

  /**
   * Look up which agents a domain operates and which publishers trust them.
   * Returns null if not found.
   *
   * The optional `scope` argument names a single agent-visibility bucket and
   * acts as a narrowing filter over the caller's auth — it can never widen
   * the view beyond what the caller's tier would otherwise return.
   *
   * - `'public'` — only `visibility=public`. Anonymous-equivalent view; useful
   *   for pre-sign-in pickers driven by an admin-tier API key whose only
   *   purpose is rate-limit + audit attribution.
   * - `'member'` — public + `members_only`. `members_only` requires API tier;
   *   anonymous / explorer-tier callers silently fall through to public-only
   *   (no 403).
   * - `'private'` — only `visibility=private`. Profile-owner only; non-owners
   *   get an empty agents array rather than 403. An empty result with this
   *   scope means *either* "you are the owner and have no drafts" *or* "you
   *   are not the owner" — the SDK can't tell them apart, only the caller can.
   * - omitted / `'all'` — tier-aware union (public + members_only when
   *   authorized + owner's private). Preserves historical behavior.
   *
   * Older AAO servers that predate this enum silently ignore unknown `?scope=`
   * values and return the tier-aware union; the filter is server-enforced.
   *
   * @see https://github.com/adcontextprotocol/adcp/pull/4581
   */
  async lookupOperator(
    domain: string,
    opts?: { scope?: 'public' | 'member' | 'private' | 'all' }
  ): Promise<OperatorLookupResult | null> {
    if (!domain?.trim()) throw new Error('domain is required');
    const params = new URLSearchParams({ domain });
    if (opts?.scope && opts.scope !== 'all') params.set('scope', opts.scope);
    return this.get(`${this.baseUrl}/api/registry/operator?${params.toString()}`, { nullOn404: true });
  }

  /**
   * Look up the inventory a domain publishes and which agents it authorizes.
   * Returns null if not found.
   *
   * Unlike `lookupOperator`, this endpoint has no visibility-tier semantics;
   * there is no `scope` filter.
   */
  async lookupPublisher(domain: string): Promise<PublisherLookupResult | null> {
    if (!domain?.trim()) throw new Error('domain is required');
    return this.get(`${this.baseUrl}/api/registry/publisher?domain=${encodeURIComponent(domain)}`, {
      nullOn404: true,
    });
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

  /**
   * Generate a valid adagents.json from an agent or catalog configuration.
   *
   * @remarks
   * Treat this as a build-time, cache-fill, or write-through operation for
   * public `.well-known/adagents.json` routes. Public routes should serve the
   * generated JSON from static storage or an application cache instead of
   * making a live registry dependency part of every request.
   *
   * In community mirror catalog files, `v1_format_ref[].agent_url` is a
   * format-shape namespace. It is not a seller authorization claim and does
   * not imply platform adoption. Seller authorization is expressed only by
   * `authorized_agents`.
   */
  async createAdagents(config: CreateAdagentsRequest): Promise<CreateAdagentsResponse> {
    return this.post(`${this.baseUrl}/api/adagents/create`, config);
  }

  /**
   * Build and submit a catalog-only community mirror adagents.json descriptor.
   *
   * This uses the registry generator endpoint and does not persist a mirror.
   * It emits `authorized_agents: []` and refuses caller-supplied authorization
   * entries; use `publishCommunityMirrorAdagents(platform, config)` or
   * `upsertCommunityMirrorAdagents(...)` to publish or update a hosted
   * community mirror catalog.
   */
  async createCommunityMirrorAdagents(config: CommunityMirrorAdagentsConfig): Promise<CreateAdagentsResponse> {
    return this.createAdagents(buildCommunityMirrorAdagents(config));
  }

  /**
   * Alias for `createCommunityMirrorAdagents()` that makes the generator-only
   * behavior explicit at call sites.
   */
  async previewCommunityMirrorAdagents(config: CommunityMirrorAdagentsConfig): Promise<CreateAdagentsResponse> {
    return this.createCommunityMirrorAdagents(config);
  }

  /**
   * Publish or update a catalog-only community mirror adagents.json descriptor
   * using a stable platform key from the first argument, `config.platform`, or a
   * single consistent `properties[].platform` value.
   */
  async upsertCommunityMirrorAdagents(
    config: CreateCommunityMirrorAdagentsConfig
  ): Promise<PublishCommunityMirrorAdagentsResponse>;
  async upsertCommunityMirrorAdagents(
    platform: string,
    config: CommunityMirrorAdagentsConfig
  ): Promise<PublishCommunityMirrorAdagentsResponse>;
  async upsertCommunityMirrorAdagents(
    platformOrConfig: string | CreateCommunityMirrorAdagentsConfig,
    maybeConfig?: CommunityMirrorAdagentsConfig
  ): Promise<PublishCommunityMirrorAdagentsResponse> {
    const { platform, config } = this.resolveCommunityMirrorPublishArgs(platformOrConfig, maybeConfig);
    return this.publishCommunityMirrorAdagents(platform, config);
  }

  /**
   * Publish or update a catalog-only community mirror adagents.json descriptor.
   *
   * This persists the mirror under `/api/registry/mirrors/:platform`. Use
   * `previewCommunityMirrorAdagents()` when you only need to validate or
   * preview the generated document without saving it. Use
   * `upsertCommunityMirrorAdagents(...)` when you want the client to infer the
   * platform key from config.
   *
   * @remarks
   * Catalog content may include registry-supplied strings. Treat them as
   * untrusted before injecting them into LLM prompts or executable context.
   */
  async publishCommunityMirrorAdagents(
    platform: string,
    config: CommunityMirrorAdagentsConfig
  ): Promise<PublishCommunityMirrorAdagentsResponse> {
    const normalizedPlatform = this.normalizeCommunityMirrorPlatform(platform);
    if (!this.apiKey) throw new Error('apiKey is required for save operations');
    const catalog = buildCommunityMirrorAdagents(config);
    this.assertCommunityMirrorPropertiesMatchPlatform(normalizedPlatform, catalog);
    return this.put(`${this.baseUrl}/api/registry/mirrors/${encodeURIComponent(normalizedPlatform)}`, catalog);
  }

  /**
   * Retrieve a published catalog-only community mirror adagents.json descriptor.
   *
   * @remarks
   * Registry responses may include arbitrary catalog strings. Treat them as
   * untrusted before injecting them into LLM prompts or executable context.
   * When the registry wrapper carries `superseded_by` and the inner catalog
   * omits it, this method hydrates `catalog.superseded_by` from the wrapper.
   */
  async getCommunityMirrorAdagents(platform: string): Promise<CommunityMirrorAdagentsCatalog | null> {
    const normalizedPlatform = this.normalizeCommunityMirrorPlatform(platform);
    const response = await this.get<{
      platform?: unknown;
      superseded_by?: unknown;
      adagents_json?: unknown;
    }>(`${this.baseUrl}/api/registry/mirrors/${encodeURIComponent(normalizedPlatform)}`, { nullOn404: true });
    if (!response) return null;
    if (response.platform !== undefined && response.platform !== normalizedPlatform) {
      throw new Error('Registry returned mismatched community mirror platform');
    }
    const catalog = response.adagents_json;
    if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) {
      throw new Error('Registry returned invalid community mirror catalog');
    }
    const typedCatalog = catalog as CommunityMirrorAdagentsCatalog & { authorized_agents?: unknown };
    if (!Array.isArray(typedCatalog.authorized_agents) || typedCatalog.authorized_agents.length !== 0) {
      throw new Error('Registry returned invalid community mirror catalog');
    }
    if (response.superseded_by != null && typeof response.superseded_by !== 'string') {
      throw new Error('Registry returned invalid community mirror catalog');
    }
    return response.superseded_by && !typedCatalog.superseded_by
      ? { ...typedCatalog, superseded_by: response.superseded_by }
      : typedCatalog;
  }

  /**
   * List published community mirror catalogs with their current etags.
   *
   * @remarks
   * Registry responses may include arbitrary catalog strings. Treat them as
   * untrusted before injecting them into LLM prompts or executable context.
   */
  async listCommunityMirrorAdagents(options?: {
    limit?: number;
    offset?: number;
  }): Promise<ListCommunityMirrorAdagentsResponse> {
    const params = new URLSearchParams();
    if (options?.limit != null) params.set('limit', String(options.limit));
    if (options?.offset != null) params.set('offset', String(options.offset));
    const qs = params.toString();
    return this.get(`${this.baseUrl}/api/registry/mirrors${qs ? `?${qs}` : ''}`);
  }

  /**
   * Delete a published community mirror and retire its derived catalog rows.
   *
   * By default, the registry refuses to delete mirrors without a
   * `superseded_by` successor URL. Pass `force: true` only for moderator
   * cleanup where no migration URL exists.
   */
  async deleteCommunityMirrorAdagents(
    platform: string,
    options?: { force?: boolean }
  ): Promise<DeleteCommunityMirrorAdagentsResponse> {
    const normalizedPlatform = this.normalizeCommunityMirrorPlatform(platform);
    if (!this.apiKey) throw new Error('apiKey is required for save operations');
    const params = new URLSearchParams();
    if (options?.force) params.set('force', 'true');
    const qs = params.toString();
    return this.deleteRequest(
      `${this.baseUrl}/api/registry/mirrors/${encodeURIComponent(normalizedPlatform)}${qs ? `?${qs}` : ''}`
    );
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

  /**
   * Request fan-out re-validation for publishers delegating to a manager domain.
   * Use after rotating a manager's adagents.json so MANAGERDOMAIN publishers
   * are queued without waiting for the next routine crawl cycle.
   *
   * Requires authentication.
   */
  async requestManagerRevalidation(managerDomain: string): Promise<ManagerRevalidationResponse> {
    if (!managerDomain?.trim()) throw new Error('managerDomain is required');
    if (!this.apiKey) throw new Error('apiKey is required for manager revalidation requests');
    const body: ManagerRevalidationRequest = { manager_domain: managerDomain };
    return this.post(`${this.baseUrl}/api/registry/manager-revalidation-request`, body);
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
    const { res, text } = await this.requestText(url, { headers: this.getHeaders() });
    if (opts?.nullOn404 && res.status === 404) return null as T;
    if (!res.ok) {
      throw new Error(`Registry request failed (${res.status}): ${this.preview(text)}`);
    }
    return this.parseJson(text);
  }

  private async post<T = any>(url: string, body: unknown): Promise<T> {
    const { res, text } = await this.requestText(url, {
      method: 'POST',
      headers: { ...this.getHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`Registry request failed (${res.status}): ${this.preview(text)}`);
    }
    return this.parseJson(text);
  }

  private async postFormData<T = any>(url: string, body: FormData): Promise<T> {
    const { res, text } = await this.requestText(url, {
      method: 'POST',
      headers: this.getHeaders(),
      body,
    });
    if (!res.ok) {
      throw new Error(`Registry request failed (${res.status}): ${this.preview(text)}`);
    }
    return this.parseJson(text);
  }

  private async put<T = any>(url: string, body: unknown): Promise<T> {
    const { res, text } = await this.requestText(url, {
      method: 'PUT',
      headers: { ...this.getHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`Registry request failed (${res.status}): ${this.preview(text)}`);
    }
    return this.parseJson(text);
  }

  private async deleteRequest<T = any>(url: string): Promise<T> {
    const { res, text } = await this.requestText(url, {
      method: 'DELETE',
      headers: this.getHeaders(),
    });
    if (!res.ok) {
      throw new Error(`Registry request failed (${res.status}): ${this.preview(text)}`);
    }
    return this.parseJson(text);
  }

  private normalizeBrandLogoList(response: Record<string, unknown>): ListBrandLogosResponse {
    const assets = Array.isArray(response.assets)
      ? (response.assets as ListBrandLogosResponse['assets'])
      : Array.isArray(response.logos)
        ? (response.logos as ListBrandLogosResponse['assets'])
        : [];
    const logos = Array.isArray(response.logos) ? (response.logos as ListBrandLogosResponse['assets']) : assets;

    const normalized: ListBrandLogosResponse = {
      assets,
      logos,
    };
    if (typeof response.domain === 'string') normalized.domain = response.domain;
    if (response.stats != null && typeof response.stats === 'object' && !Array.isArray(response.stats)) {
      normalized.stats = response.stats as Record<string, unknown>;
    }
    return normalized;
  }

  private toBrandLogoBlob(data: SaveBrandLogoInput['data'], mimeType: string): Blob {
    if (data instanceof Blob) return new Blob([data], { type: mimeType });
    if (data instanceof ArrayBuffer) return new Blob([data], { type: mimeType });
    if (ArrayBuffer.isView(data)) {
      const bytes = new Uint8Array(data.byteLength);
      bytes.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      return new Blob([bytes], { type: mimeType });
    }
    throw new Error('data must be a Blob, Buffer, ArrayBuffer, or ArrayBufferView');
  }

  private normalizeCommunityMirrorPlatform(platform: string): string {
    const normalizedPlatform = platform?.trim().toLowerCase();
    if (!normalizedPlatform) throw new Error('platform is required');
    if (!COMMUNITY_MIRROR_PLATFORM_RE.test(normalizedPlatform)) {
      throw new Error('platform must match ^[a-z0-9_-]{1,64}$');
    }
    return normalizedPlatform;
  }

  private resolveCommunityMirrorPublishArgs(
    platformOrConfig: string | CreateCommunityMirrorAdagentsConfig,
    maybeConfig?: CommunityMirrorAdagentsConfig
  ): { platform: string; config: CommunityMirrorAdagentsConfig } {
    if (typeof platformOrConfig === 'string') {
      if (!maybeConfig) throw new Error('config is required');
      return { platform: platformOrConfig, config: maybeConfig };
    }

    const config = platformOrConfig;
    const platform = this.communityMirrorPlatformFromConfig(config);
    return { platform, config };
  }

  private communityMirrorPlatformFromConfig(config: CreateCommunityMirrorAdagentsConfig): string {
    if (typeof config.platform === 'string') {
      const platform = config.platform.trim();
      if (platform) return platform;
    }

    const properties = (config as { properties?: unknown }).properties;
    if (Array.isArray(properties)) {
      const platforms = new Set<string>();
      for (const property of properties) {
        if (!property || typeof property !== 'object' || Array.isArray(property)) continue;
        const propertyPlatform = (property as { platform?: unknown }).platform;
        if (typeof propertyPlatform === 'string' && propertyPlatform.trim()) {
          platforms.add(this.normalizeCommunityMirrorPlatform(propertyPlatform));
        }
      }
      if (platforms.size === 1) return Array.from(platforms)[0]!;
      if (platforms.size > 1) {
        throw new Error('platform is ambiguous; pass upsertCommunityMirrorAdagents(platform, config)');
      }
    }

    throw new Error('platform is required for community mirror publish');
  }

  private assertCommunityMirrorPropertiesMatchPlatform(
    normalizedPlatform: string,
    catalog: CommunityMirrorAdagentsCatalog
  ): void {
    const properties = (catalog as { properties?: unknown }).properties;
    if (!Array.isArray(properties)) return;
    for (const property of properties) {
      if (!property || typeof property !== 'object' || Array.isArray(property)) continue;
      const propertyPlatform = (property as { platform?: unknown }).platform;
      if (propertyPlatform == null) continue;
      if (
        typeof propertyPlatform !== 'string' ||
        this.normalizeCommunityMirrorPlatform(propertyPlatform) !== normalizedPlatform
      ) {
        throw new Error(`properties[].platform must match ${normalizedPlatform}`);
      }
    }
  }

  private async requestText(url: string, init: RequestInit): Promise<{ res: Response; text: string }> {
    const controller = new AbortController();
    let timedOut = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new Error(`Registry request timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
    });
    const requestPromise = Promise.resolve().then(async () => {
      const res = await this.fetchImpl(url, {
        ...init,
        redirect: this.redirect,
        signal: controller.signal,
      });
      const text = await this.readBody(res, this.bodyLimitForUrl(url));
      return { res, text };
    });
    requestPromise.catch(() => {});
    try {
      return await Promise.race([requestPromise, timeoutPromise]);
    } catch (err) {
      if (timedOut || controller.signal.aborted) {
        throw new Error(`Registry request timed out after ${this.timeoutMs}ms`);
      }
      throw err;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }
    return headers;
  }

  private bodyLimitForUrl(url: string): number {
    if (this.hasCustomMaxBodyBytes) return this.maxBodyBytes;

    const path = new URL(url).pathname;
    if (
      path === '/api/brands/registry' ||
      path === '/api/brands/resolve/bulk' ||
      path === '/api/properties/registry' ||
      path === '/api/properties/resolve/bulk' ||
      path === '/api/registry/agents' ||
      path === '/api/registry/publishers' ||
      path === '/api/registry/feed' ||
      path === '/api/registry/mirrors' ||
      path === '/api/registry/agents/search' ||
      path === '/api/registry/authorizations' ||
      path === '/api/registry/authorizations/snapshot' ||
      path === '/api/search' ||
      path === '/api/policies/registry' ||
      path === '/api/policies/resolve/bulk' ||
      path === '/api/public/discover-agent' ||
      path === '/api/public/agent-formats' ||
      path === '/api/public/agent-products' ||
      path === '/api/public/validate-publisher' ||
      path === '/api/registry/agents/storyboard-status' ||
      (path.startsWith('/api/registry/agents/') && path.endsWith('/storyboard-status')) ||
      path.startsWith('/api/registry/mirrors/') ||
      path.startsWith('/api/properties/check')
    ) {
      return DEFAULT_LARGE_RESPONSE_MAX_BODY_BYTES;
    }

    return this.maxBodyBytes;
  }

  private async readBody(res: Response, maxBodyBytes: number): Promise<string> {
    const contentLength = res.headers.get('content-length');
    if (contentLength) {
      const declaredBytes = Number(contentLength);
      if (Number.isFinite(declaredBytes) && declaredBytes > maxBodyBytes) {
        throw new Error(`Registry response exceeded ${maxBodyBytes} bytes`);
      }
    }

    const reader = res.body?.getReader();
    if (!reader) {
      const text = await res.text();
      if (new TextEncoder().encode(text).byteLength > maxBodyBytes) {
        throw new Error(`Registry response exceeded ${maxBodyBytes} bytes`);
      }
      return text;
    }

    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > maxBodyBytes) {
          await reader.cancel();
          throw new Error(`Registry response exceeded ${maxBodyBytes} bytes`);
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }

    const buf = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      buf.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(buf);
  }

  private parseJson(text: string): any {
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`Registry returned invalid JSON: ${this.preview(text)}`);
    }
  }

  private withSources<T extends object>(value: T): T & { sources: Record<string, unknown> } {
    if ('sources' in value) return value as T & { sources: Record<string, unknown> };
    return { ...value, sources: {} };
  }

  private preview(text: string): string {
    return text
      .slice(0, ERROR_BODY_PREVIEW_CHARS)
      .replace(/[\u0000-\u001f\u007f]/g, ch => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
  }

  private buildParams(options?: ListOptions & { source?: string }): string {
    if (!options) return '';
    const params = new URLSearchParams();
    if (options.search) params.set('search', options.search);
    if (options.limit != null) params.set('limit', String(options.limit));
    if (options.offset != null) params.set('offset', String(options.offset));
    if ('source' in options && options.source) params.set('source', options.source);
    const qs = params.toString();
    return qs ? '?' + qs : '';
  }

  private setTrueParam(params: URLSearchParams, key: string, value: boolean | 'true' | undefined): void {
    if (value === true || value === 'true') params.set(key, 'true');
  }

  private appendParamValues(params: URLSearchParams, key: string, value: string | string[] | undefined): void {
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, item);
    } else if (value) {
      params.set(key, value);
    }
  }
}
