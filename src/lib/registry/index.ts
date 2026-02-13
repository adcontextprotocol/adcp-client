import type { ResolvedBrand, PropertyInfo, RegistryClientConfig } from './types';

export type { ResolvedBrand, PropertyInfo, RegistryClientConfig } from './types';

const DEFAULT_BASE_URL = 'https://adcontextprotocol.org';
const MAX_BULK_DOMAINS = 100;

/**
 * Client for looking up brands and properties in the AdCP registry.
 *
 * @example
 * ```ts
 * const registry = new RegistryClient();
 * const brand = await registry.lookupBrand('nike.com');
 * const properties = await registry.lookupProperties(['nytimes.com', 'wsj.com']);
 * ```
 */
export class RegistryClient {
  private readonly baseUrl: string;

  constructor(config?: RegistryClientConfig) {
    this.baseUrl = (config?.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
  }

  /**
   * Resolve a single domain to its canonical brand identity.
   *
   * @param domain - Domain to resolve (e.g. "nike.com")
   * @returns The resolved brand, or null if not found
   */
  async lookupBrand(domain: string): Promise<ResolvedBrand | null> {
    if (!domain?.trim()) throw new Error('domain is required');

    const url = `${this.baseUrl}/api/brands/resolve?domain=${encodeURIComponent(domain)}`;
    const res = await fetch(url);

    if (res.status === 404) return null;
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Registry brand lookup failed (${res.status}): ${body}`);
    }

    return this.parseJson(res);
  }

  /**
   * Bulk resolve domains to their canonical brand identities.
   *
   * @param domains - Array of domains to resolve (max 100)
   * @returns Map of domain to resolved brand (null if not found)
   */
  async lookupBrands(domains: string[]): Promise<Record<string, ResolvedBrand | null>> {
    if (domains.length === 0) return {};
    if (domains.length > MAX_BULK_DOMAINS) {
      throw new Error(`Cannot resolve more than ${MAX_BULK_DOMAINS} domains at once (got ${domains.length})`);
    }

    const url = `${this.baseUrl}/api/brands/resolve/bulk`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domains }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Registry bulk brand lookup failed (${res.status}): ${body}`);
    }

    const data = await this.parseJson(res);
    return data.results;
  }

  /**
   * Resolve a single domain to its property information.
   *
   * @param domain - Publisher domain to resolve (e.g. "nytimes.com")
   * @returns The resolved property info, or null if not found
   */
  async lookupProperty(domain: string): Promise<PropertyInfo | null> {
    if (!domain?.trim()) throw new Error('domain is required');

    const url = `${this.baseUrl}/api/properties/resolve?domain=${encodeURIComponent(domain)}`;
    const res = await fetch(url);

    if (res.status === 404) return null;
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Registry property lookup failed (${res.status}): ${body}`);
    }

    return this.parseJson(res);
  }

  /**
   * Bulk resolve domains to their property information.
   *
   * @param domains - Array of publisher domains to resolve (max 100)
   * @returns Map of domain to property info (null if not found)
   */
  async lookupProperties(domains: string[]): Promise<Record<string, PropertyInfo | null>> {
    if (domains.length === 0) return {};
    if (domains.length > MAX_BULK_DOMAINS) {
      throw new Error(`Cannot resolve more than ${MAX_BULK_DOMAINS} domains at once (got ${domains.length})`);
    }

    const url = `${this.baseUrl}/api/properties/resolve/bulk`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domains }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Registry bulk property lookup failed (${res.status}): ${body}`);
    }

    const data = await this.parseJson(res);
    return data.results;
  }

  private async parseJson(res: Response): Promise<any> {
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`Registry returned invalid JSON: ${text.slice(0, 200)}`);
    }
  }
}
