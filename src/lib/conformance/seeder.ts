import { AgentClient } from '../core/AgentClient';
import type { AgentConfig } from '../types';
import { generateIdempotencyKey } from '../utils/idempotency';
import type { ConformanceFixtures } from './types';

export interface SeedOptions {
  /** Protocol. Default: 'mcp'. */
  protocol?: 'mcp' | 'a2a';
  /** Bearer token forwarded to the agent. */
  authToken?: string;
  /** Full AgentConfig override. `id`/`agent_uri`/`protocol` are filled in from the other options. */
  agentConfig?: Partial<AgentConfig>;
  /**
   * Subset of seeders to run. Default: all.
   * `'create_media_buy'` implicitly runs `get_products` first to discover
   * a real product_id.
   */
  seeders?: readonly SeederName[];
}

export type SeederName = 'create_property_list' | 'create_content_standards' | 'create_media_buy';

export interface SeedResult {
  fixtures: ConformanceFixtures;
  warnings: SeedWarning[];
}

export interface SeedWarning {
  seeder: SeederName;
  reason: string;
}

// Cosmetic tag for human-readable names/labels only. NOT used for
// idempotency_key — that's minted by `generateIdempotencyKey()`. Two
// seeders racing with the same random suffix would produce two distinct
// entities with identical names, which is fine for a seeder.
const UNIQUE_TAG = (): string => 'cf_seed_' + Math.random().toString(36).slice(2, 10);

/**
 * Seeds an agent with known entities so Tier-3 fuzzing has real IDs to
 * feed back into referential + update tools. Each seeder is best-effort:
 * failures degrade to a recorded warning and an empty pool, never a
 * thrown exception, so a partial seed still lets the fuzzer run against
 * every other tool.
 *
 * Inputs are minimal hand-crafted payloads rather than fast-check
 * outputs — seeding is about producing a known-good entity, not
 * exploring the schema space. That's the job of runConformance.
 *
 * WARNING: This mutates the target. Point at a sandbox / test tenant.
 */
export async function seedFixtures(agentUrl: string, options: SeedOptions = {}): Promise<SeedResult> {
  const agent = buildAgent(agentUrl, options);
  const seeders =
    options.seeders ?? (['create_property_list', 'create_content_standards', 'create_media_buy'] as const);

  const fixtures: ConformanceFixtures = {};
  const warnings: SeedWarning[] = [];

  for (const name of seeders) {
    try {
      const runner = SEEDERS[name];
      if (!runner) {
        warnings.push({ seeder: name, reason: `no seeder registered for ${name}` });
        continue;
      }
      const out = await runner(agent);
      mergePool(fixtures, out.ids);
      warnings.push(...out.warnings);
    } catch (err) {
      warnings.push({ seeder: name, reason: `seeder threw: ${(err as Error)?.message ?? String(err)}` });
    }
  }

  return { fixtures, warnings };
}

function buildAgent(agentUrl: string, options: SeedOptions): AgentClient {
  const config: AgentConfig = {
    id: options.agentConfig?.id ?? 'conformance-seeder',
    name: options.agentConfig?.name ?? 'AdCP Conformance Seeder',
    agent_uri: agentUrl,
    protocol: options.protocol ?? options.agentConfig?.protocol ?? 'mcp',
    auth_token: options.authToken ?? options.agentConfig?.auth_token,
    ...options.agentConfig,
  };
  // The seeder tries every seed-tool regardless of declared capabilities.
  // Two SDK preflights are explicitly disabled:
  //   - `validateFeatures: false` — don't refuse tools that aren't
  //     declared in `get_adcp_capabilities`. The seeder just tries; the
  //     agent's rejection becomes a recorded warning.
  //   - `validation.responses: 'warn'` — don't fail a seed just because
  //     the agent's response drifts from the response schema. We want
  //     the ID if it's present; the fuzzer itself will do the strict
  //     validation on downstream tools that actually care.
  return new AgentClient(config, {
    validateFeatures: false,
    validation: { responses: 'warn' },
  });
}

function mergePool(dest: ConformanceFixtures, src: Partial<Record<keyof ConformanceFixtures, string[]>>): void {
  for (const [key, values] of Object.entries(src)) {
    if (!values || values.length === 0) continue;
    const k = key as keyof ConformanceFixtures;
    const existing = dest[k] ?? [];
    dest[k] = [...existing, ...values];
  }
}

interface SeederOutput {
  ids: Partial<Record<keyof ConformanceFixtures, string[]>>;
  warnings: SeedWarning[];
}
type Seeder = (agent: AgentClient) => Promise<SeederOutput>;

const SEEDERS: Record<SeederName, Seeder> = {
  create_property_list: seedPropertyList,
  create_content_standards: seedContentStandards,
  create_media_buy: seedMediaBuy,
};

async function seedPropertyList(agent: AgentClient): Promise<SeederOutput> {
  const result = await agent.executeTask('create_property_list', {
    idempotency_key: generateIdempotencyKey(),
    name: `Conformance Seeder List ${UNIQUE_TAG()}`,
  });
  if (!result.success || result.status !== 'completed' || !result.data) {
    return {
      ids: {},
      warnings: [{ seeder: 'create_property_list', reason: summarizeResult(result) }],
    };
  }
  const listId = (result.data as { list?: { list_id?: unknown } })?.list?.list_id;
  if (typeof listId !== 'string' || listId.length === 0) {
    return {
      ids: {},
      warnings: [{ seeder: 'create_property_list', reason: 'response missing list.list_id' }],
    };
  }
  return { ids: { list_ids: [listId] }, warnings: [] };
}

async function seedContentStandards(agent: AgentClient): Promise<SeederOutput> {
  // Minimal payload that still satisfies the "at least one of policy,
  // policies, or registry_policy_ids is required" invariant some sellers
  // enforce beyond the raw schema. A single inline policy is the most
  // portable shape — registry_policy_ids require a pre-existing registry
  // entry on the seller, which we can't assume.
  const result = await agent.executeTask('create_content_standards', {
    idempotency_key: generateIdempotencyKey(),
    scope: { languages_any: ['en'] },
    policies: [
      {
        policy_id: `cf_policy_${UNIQUE_TAG()}`,
        enforcement: 'may',
        policy: 'Conformance seeder placeholder policy — advisory only.',
      },
    ],
  });
  if (!result.success || result.status !== 'completed' || !result.data) {
    return {
      ids: {},
      warnings: [{ seeder: 'create_content_standards', reason: summarizeResult(result) }],
    };
  }
  const standardsId = (result.data as { standards_id?: unknown })?.standards_id;
  if (typeof standardsId !== 'string' || standardsId.length === 0) {
    return {
      ids: {},
      warnings: [{ seeder: 'create_content_standards', reason: 'response missing standards_id' }],
    };
  }
  return { ids: { standards_ids: [standardsId] }, warnings: [] };
}

/**
 * Creates a media buy by first discovering a product via `get_products`,
 * then calling `create_media_buy` against that product. Captures the
 * returned `media_buy_id` and any `package_id`s from the response.
 */
async function seedMediaBuy(agent: AgentClient): Promise<SeederOutput> {
  const warnings: SeedWarning[] = [];
  const products = await agent.executeTask('get_products', {
    brief: 'Conformance fuzzer seed — any product acceptable',
  });
  if (!products.success || products.status !== 'completed' || !products.data) {
    return {
      ids: {},
      warnings: [{ seeder: 'create_media_buy', reason: 'get_products preflight: ' + summarizeResult(products) }],
    };
  }
  const productList = (products.data as { products?: unknown })?.products;
  if (!Array.isArray(productList) || productList.length === 0) {
    return {
      ids: {},
      warnings: [{ seeder: 'create_media_buy', reason: 'get_products returned no products' }],
    };
  }
  const product = productList[0] as {
    product_id?: string;
    pricing_options?: Array<{ pricing_option_id?: string }>;
  };
  if (!product.product_id || !product.pricing_options?.[0]?.pricing_option_id) {
    return {
      ids: {},
      warnings: [{ seeder: 'create_media_buy', reason: 'first product missing product_id or pricing_option_id' }],
    };
  }

  const tag = UNIQUE_TAG();
  const now = new Date();
  const start = new Date(now.getTime() + 24 * 60 * 60 * 1000); // +1 day
  const end = new Date(now.getTime() + 8 * 24 * 60 * 60 * 1000); // +8 days

  const result = await agent.executeTask('create_media_buy', {
    idempotency_key: generateIdempotencyKey(),
    account: { brand: { domain: 'conformance.example' }, operator: 'conformance.example' },
    brand: { domain: 'conformance.example' },
    start_time: start.toISOString(),
    end_time: end.toISOString(),
    total_budget: { amount: 100, currency: 'USD' },
    packages: [
      {
        buyer_ref: `cf_pkg_${tag}`,
        product_id: product.product_id,
        pricing_option_id: product.pricing_options[0].pricing_option_id,
        budget: 100,
      },
    ],
  });

  if (!result.success || result.status !== 'completed' || !result.data) {
    return {
      ids: {},
      warnings: [...warnings, { seeder: 'create_media_buy', reason: summarizeResult(result) }],
    };
  }

  const data = result.data as {
    media_buy_id?: unknown;
    packages?: Array<{ package_id?: unknown }>;
  };
  const ids: Partial<Record<keyof ConformanceFixtures, string[]>> = {};
  if (typeof data.media_buy_id === 'string' && data.media_buy_id.length > 0) {
    ids.media_buy_ids = [data.media_buy_id];
  } else {
    warnings.push({ seeder: 'create_media_buy', reason: 'response missing media_buy_id (may be submitted async)' });
  }
  const packageIds = (data.packages ?? [])
    .map(p => p?.package_id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
  if (packageIds.length > 0) ids.package_ids = packageIds;

  return { ids, warnings };
}

function summarizeResult(result: {
  success: boolean;
  status?: string;
  error?: string;
  adcpError?: { code?: string };
}): string {
  if (result.success === false) {
    const code = result.adcpError?.code ? `${result.adcpError.code}: ` : '';
    return `agent rejected with ${code}${result.error ?? 'unknown error'}`;
  }
  return `unexpected status ${result.status ?? 'unknown'}`;
}
