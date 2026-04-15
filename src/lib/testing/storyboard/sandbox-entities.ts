/**
 * Sandbox entity loader.
 *
 * Parses storyboard test-kit YAML files and fictional-entities.yaml to produce
 * structured sandbox data for the AAO registry. The registry imports this
 * function so the YAML files remain the single source of truth — no seeding,
 * no copying, no drift.
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { parse } from 'yaml';
import { BrandJsonSchema, type BrandJson } from './brand-json-schema';

export type { BrandJson } from './brand-json-schema';

// ====== Public types ======

export interface SandboxBrand {
  domain: string;
  brand_name: string;
  brand_id: string;
  industry?: string;
  brand_json: BrandJson;
  sandbox: true;
}

export interface SandboxAgent {
  domain: string;
  name: string;
  type: string;
  size?: string;
  sandbox: true;
}

export interface SandboxEntities {
  brands: SandboxBrand[];
  agents: SandboxAgent[];
}

// ====== Internal helpers ======

function getStoryboardsDir(): string {
  return resolve(__dirname, '..', '..', '..', '..', 'storyboards');
}

function loadTestKit(filePath: string): Record<string, unknown> {
  const content = readFileSync(filePath, 'utf-8');
  return parse(content) as Record<string, unknown>;
}

function loadFictionalEntities(dir: string): Record<string, unknown> | null {
  const filePath = join(dir, 'fictional-entities.yaml');
  if (!existsSync(filePath)) return null;
  const content = readFileSync(filePath, 'utf-8');
  return parse(content) as Record<string, unknown>;
}

function buildBrandJson(kit: Record<string, unknown>): BrandJson {
  const brand = kit.brand as Record<string, unknown> | undefined;
  const house = brand?.house as Record<string, unknown> | undefined;
  const houseDomain = house?.domain as string | undefined;

  if (!brand || !house || !houseDomain) {
    throw new Error(`Test kit "${kit.id ?? kit.name}" missing brand.house.domain`);
  }

  const id = (brand.brand_id as string) ?? (kit.id as string);
  const rawNames = brand.names as Array<Record<string, string>> | undefined;
  const names = rawNames ?? [{ en: (house.name as string) ?? (kit.name as string) }];

  const raw: Record<string, unknown> = {
    $schema: 'https://adcontextprotocol.org/schemas/brand.json',
    house: houseDomain,
    brands: [
      {
        id,
        names,
        ...(brand.keller_type != null && { keller_type: brand.keller_type }),
        ...(brand.description != null && { description: brand.description }),
        ...(brand.logos != null && { logos: brand.logos }),
        ...(brand.colors != null && { colors: brand.colors }),
        ...(brand.fonts != null && { fonts: brand.fonts }),
        ...(brand.tone != null && { tone: brand.tone }),
      },
    ],
  };

  return BrandJsonSchema.parse(raw);
}

// ====== Public API ======

let _cache: SandboxEntities | null = null;

/**
 * Load all sandbox entities from bundled storyboard test kits and
 * fictional-entities.yaml. Results are cached after the first call.
 *
 * The registry calls this to serve sandbox brand.json and adagents.json
 * data without maintaining a separate copy.
 */
export function getSandboxEntities(): SandboxEntities {
  if (_cache) return _cache;

  const dir = getStoryboardsDir();
  const testKitDir = join(dir, 'test-kits');
  const brands: SandboxBrand[] = [];
  const agents: SandboxAgent[] = [];

  // Load brands from test kits (they have full brand identity data)
  if (existsSync(testKitDir)) {
    const files = readdirSync(testKitDir).filter(f => f.endsWith('.yaml'));
    for (const file of files) {
      const kit = loadTestKit(join(testKitDir, file));
      if (!kit.sandbox) continue;

      const brand = kit.brand as Record<string, unknown> | undefined;
      const house = brand?.house as Record<string, unknown> | undefined;
      const domain = house?.domain as string | undefined;
      if (!domain) continue;

      brands.push({
        domain,
        brand_name: (house?.name as string) ?? (kit.name as string),
        brand_id: (brand?.brand_id as string) ?? (kit.id as string),
        industry: (brand?.industry as string) ?? undefined,
        brand_json: buildBrandJson(kit),
        sandbox: true,
      });
    }
  }

  // Load additional brands and agents from fictional-entities.yaml
  const entities = loadFictionalEntities(dir);
  if (entities) {
    // Advertisers without test kits still need brand entries
    const advertisers = entities.advertisers as Array<Record<string, unknown>> | undefined;
    if (advertisers) {
      for (const adv of advertisers) {
        const domain = adv.domain as string;
        // Skip if already loaded from a test kit
        if (brands.some(b => b.domain === domain)) continue;
        if (!adv.sandbox_brand) continue;
        brands.push({
          domain,
          brand_name: adv.name as string,
          brand_id: adv.id as string,
          industry: adv.industry as string | undefined,
          brand_json: BrandJsonSchema.parse({
            $schema: 'https://adcontextprotocol.org/schemas/brand.json',
            house: domain,
            brands: [{ id: adv.id, names: [{ en: adv.name }] }],
          }),
          sandbox: true,
        });
      }
    }

    // Publishers/platforms → sandbox agents
    const publishers = entities.publishers as Array<Record<string, unknown>> | undefined;
    if (publishers) {
      for (const pub of publishers) {
        const domain = pub.domain as string;
        if (!domain) continue;
        agents.push({
          domain,
          name: pub.name as string,
          type: (pub.type as string) ?? 'publisher',
          size: pub.size as string | undefined,
          sandbox: true,
        });
      }
    }

    // Agencies → sandbox agents
    const agencyList = entities.agencies as Array<Record<string, unknown>> | undefined;
    if (agencyList) {
      for (const agency of agencyList) {
        const domain = agency.domain as string;
        if (!domain) continue;
        agents.push({
          domain,
          name: agency.name as string,
          type: 'agency',
          size: agency.size as string | undefined,
          sandbox: true,
        });
      }
    }

    // Data providers → sandbox agents
    const providers = entities.data_providers as Array<Record<string, unknown>> | undefined;
    if (providers) {
      for (const prov of providers) {
        const domain = prov.domain as string;
        if (!domain) continue;
        agents.push({
          domain,
          name: prov.name as string,
          type: 'data_provider',
          size: prov.size as string | undefined,
          sandbox: true,
        });
      }
    }

    // Rights → sandbox agents
    const rights = entities.rights as Array<Record<string, unknown>> | undefined;
    if (rights) {
      for (const r of rights) {
        const domain = r.domain as string;
        if (!domain) continue;
        agents.push({
          domain,
          name: r.name as string,
          type: (r.type as string) ?? 'rights',
          size: r.size as string | undefined,
          sandbox: true,
        });
      }
    }
  }

  _cache = { brands, agents };
  return _cache;
}

/**
 * Get sandbox brands only (convenience for brand resolution).
 */
export function getSandboxBrands(): SandboxBrand[] {
  return getSandboxEntities().brands;
}

/**
 * Look up a single sandbox brand by domain.
 * Returns null if the domain is not a sandbox brand.
 */
export function getSandboxBrand(domain: string): SandboxBrand | null {
  return getSandboxBrands().find(b => b.domain === domain) ?? null;
}

/**
 * Check if a domain is a sandbox entity (brand or agent).
 */
export function isSandboxDomain(domain: string): boolean {
  const { brands, agents } = getSandboxEntities();
  return brands.some(b => b.domain === domain) || agents.some(a => a.domain === domain);
}

/**
 * Clear the cached sandbox entities. Primarily for testing.
 */
export function clearSandboxCache(): void {
  _cache = null;
}
