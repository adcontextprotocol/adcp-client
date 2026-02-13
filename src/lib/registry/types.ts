/**
 * A brand resolved from the AdCP registry via domain lookup.
 */
export interface ResolvedBrand {
  /** Canonical identifier, e.g. "nike.com" or "nike.com#air-jordan" */
  canonical_id: string;
  /** Canonical domain for this brand */
  canonical_domain: string;
  /** Human-readable brand name */
  brand_name: string;
  /** Localized name variants keyed by language code */
  names?: Array<Record<string, string>>;
  /** Brand architecture classification (Keller's theory) */
  keller_type?: 'master' | 'sub_brand' | 'endorsed' | 'independent';
  /** Parent brand canonical ID, if this is a sub-brand */
  parent_brand?: string;
  /** Corporate house domain that owns this brand */
  house_domain?: string;
  /** Corporate house name */
  house_name?: string;
  /** URL to the brand's AdCP agent */
  brand_agent_url?: string;
  /** Brand manifest data (logos, colors, etc.) */
  brand_manifest?: Record<string, unknown>;
  /** How this brand record was sourced */
  source: 'brand_json' | 'community' | 'enriched';
}

/**
 * A property (publisher) resolved from the AdCP registry via domain lookup.
 */
export interface PropertyInfo {
  /** Publisher domain that owns this property */
  publisher_domain: string;
  /** How this property record was sourced */
  source: 'hosted' | 'adagents_json';
  /** Agents authorized to sell inventory on this property */
  authorized_agents: Array<{ url: string }>;
  /** Properties associated with this domain */
  properties: Array<{
    id: string;
    type: string;
    name: string;
    identifiers: Array<{ type: string; value: string; include_subdomains?: boolean }>;
    tags?: string[];
  }>;
  /** Publisher contact information */
  contact?: Record<string, unknown>;
  /** Whether domain ownership has been verified */
  verified: boolean;
}

/**
 * Configuration for the registry client.
 */
export interface RegistryClientConfig {
  /** Base URL of the AdCP registry. Defaults to https://adcontextprotocol.org */
  baseUrl?: string;
}
