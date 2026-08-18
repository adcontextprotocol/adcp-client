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
  /** Trusted AdCP wire-version pin for requests sent by the seeder. */
  adcpVersion?: string;
  /**
   * Subset of seeders to run. Default: all.
   * `'create_media_buy'` implicitly runs `get_products` first to discover
   * a real product_id. `'buy_products'` does the equivalent through the
   * compact 3.2 `list_products` → `buy_products` lifecycle.
   * `'sync_creatives'` implicitly runs
   * `list_creative_formats` first to pick a usable format.
   */
  seeders?: readonly SeederName[];
  /**
   * Also run the compact 3.2 `list_products` → `buy_products` seeder when
   * `seeders` is omitted. Defaults to false so legacy callers keep their
   * original seed set; `runConformance` enables it for a 3.2 schema bundle.
   */
  includeCompactMediaBuy?: boolean;
  /**
   * Brand reference for mutating seeders that require one. Default
   * `{ domain: 'conformance.example' }`. Sellers that enforce brand
   * allowlists should override this with a domain they're configured to
   * accept — otherwise `create_media_buy` seeding warns and falls through.
   */
  brand?: { domain: string; brand_id?: string };
}

export type SeederName =
  | 'create_property_list'
  | 'create_content_standards'
  | 'create_media_buy'
  | 'buy_products'
  | 'sync_creatives';

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
    options.seeders ??
    (options.includeCompactMediaBuy
      ? ([
          'create_property_list',
          'create_content_standards',
          'create_media_buy',
          'buy_products',
          'sync_creatives',
        ] as const)
      : (['create_property_list', 'create_content_standards', 'create_media_buy', 'sync_creatives'] as const));

  const ctx: SeederContext = {
    agent,
    brand: options.brand ?? { domain: 'conformance.example' },
  };

  const fixtures: ConformanceFixtures = {};
  const warnings: SeedWarning[] = [];

  for (const name of seeders) {
    try {
      const runner = SEEDERS[name];
      if (!runner) {
        warnings.push({ seeder: name, reason: `no seeder registered for ${name}` });
        continue;
      }
      const out = await runner(ctx);
      mergePool(fixtures, out.ids);
      warnings.push(...out.warnings);
    } catch (err) {
      warnings.push({ seeder: name, reason: `seeder threw: ${(err as Error)?.message ?? String(err)}` });
    }
  }

  return { fixtures, warnings };
}

interface SeederContext {
  agent: AgentClient;
  brand: { domain: string; brand_id?: string };
}

type CompactSeedAccount = {
  brand: { domain: string; brand_id?: string };
  operator: string;
};

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
    ...(options.adcpVersion ? { adcpVersion: options.adcpVersion } : {}),
    validateFeatures: false,
    validation: { responses: 'warn' },
  });
}

type MutableFixturePools = {
  [K in keyof ConformanceFixtures]?: Array<NonNullable<ConformanceFixtures[K]>[number]>;
};

function mergePool(dest: ConformanceFixtures, src: MutableFixturePools): void {
  const mutableDest = dest as unknown as Record<string, unknown[] | undefined>;
  for (const [key, values] of Object.entries(src)) {
    if (!values || values.length === 0) continue;
    const existing = mutableDest[key] ?? [];
    mutableDest[key] = [...existing, ...values];
  }
}

interface SeederOutput {
  ids: MutableFixturePools;
  warnings: SeedWarning[];
}
type Seeder = (ctx: SeederContext) => Promise<SeederOutput>;

const SEEDERS: Record<SeederName, Seeder> = {
  create_property_list: seedPropertyList,
  create_content_standards: seedContentStandards,
  create_media_buy: seedMediaBuy,
  buy_products: seedMediaBuyCompact,
  sync_creatives: seedSyncCreatives,
};

async function seedPropertyList({ agent }: SeederContext): Promise<SeederOutput> {
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

async function seedContentStandards({ agent }: SeederContext): Promise<SeederOutput> {
  // Minimal payload that still satisfies the "at least one of policy,
  // policies, or registry_policy_ids is required" invariant some sellers
  // enforce beyond the raw schema. A single inline policy is the most
  // portable shape — registry_policy_ids require a pre-existing registry
  // entry on the seller, which we can't assume.
  const result = await agent.executeTaskLegacy('create_content_standards', {
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
async function seedMediaBuy({ agent, brand }: SeederContext): Promise<SeederOutput> {
  const warnings: SeedWarning[] = [];
  const products = await agent.executeTaskLegacy('get_products', {
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

  const brandRef: Record<string, string> = { domain: brand.domain };
  if (brand.brand_id) brandRef.brand_id = brand.brand_id;
  const result = await agent.executeTaskLegacy('create_media_buy', {
    idempotency_key: generateIdempotencyKey(),
    account: { brand: brandRef, operator: brand.domain },
    brand: brandRef,
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
  const ids: MutableFixturePools = {};
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

/**
 * Creates a media buy through the compact AdCP 3.2 lifecycle. Keeping this
 * separate from the legacy seeder makes auto-seeding exercise both buyer
 * surfaces and lets legacy-only sellers skip this path without losing their
 * `create_media_buy` fixture.
 */
async function seedMediaBuyCompact({ agent, brand }: SeederContext): Promise<SeederOutput> {
  const warnings: SeedWarning[] = [];
  const ids: MutableFixturePools = {};
  const brandRef = { domain: brand.domain, ...(brand.brand_id ? { brand_id: brand.brand_id } : {}) };
  const account = { brand: brandRef, operator: brand.domain };
  const products = await agent.listProducts({
    brand: brandRef,
    max_results: 1,
  });
  if (!products.success || products.status !== 'completed' || !products.data) {
    return {
      ids: {},
      warnings: [{ seeder: 'buy_products', reason: 'list_products preflight: ' + summarizeResult(products) }],
    };
  }

  const data = products.data as {
    products?: unknown;
    feed_version?: unknown;
    pricing_version?: unknown;
  };
  if (typeof data.feed_version !== 'string' || data.feed_version.length === 0) {
    return { ids: {}, warnings: [{ seeder: 'buy_products', reason: 'list_products response missing feed_version' }] };
  }
  if (!Array.isArray(data.products) || data.products.length === 0) {
    return { ids: {}, warnings: [{ seeder: 'buy_products', reason: 'list_products returned no products' }] };
  }
  const product = data.products[0] as {
    product_id?: unknown;
    pricing_options?: Array<{ pricing_option_id?: unknown }>;
  };
  const pricingOptionId = product.pricing_options?.[0]?.pricing_option_id;
  if (typeof product.product_id !== 'string' || typeof pricingOptionId !== 'string') {
    return {
      ids: {},
      warnings: [{ seeder: 'buy_products', reason: 'first product missing product_id or pricing_option_id' }],
    };
  }

  ids.products = [
    {
      product_id: product.product_id,
      pricing_option_id: pricingOptionId,
      feed_version: data.feed_version,
      ...(typeof data.pricing_version === 'string' && { pricing_version: data.pricing_version }),
      account,
    },
  ];

  const now = new Date();
  const start = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const end = new Date(now.getTime() + 8 * 24 * 60 * 60 * 1000);
  const result = await agent.buyProducts({
    idempotency_key: generateIdempotencyKey(),
    account,
    feed_version: data.feed_version,
    ...(typeof data.pricing_version === 'string' && { pricing_version: data.pricing_version }),
    start_time: start.toISOString(),
    end_time: end.toISOString(),
    purchases: [{ product_id: product.product_id, pricing_option_id: pricingOptionId }],
  });
  if (!result.success || result.status !== 'completed' || !result.data) {
    warnings.push({ seeder: 'buy_products', reason: summarizeResult(result) });
  } else {
    const buyData = result.data as { media_buy_id?: unknown; revision?: unknown };
    if (typeof buyData.media_buy_id !== 'string' || buyData.media_buy_id.length === 0) {
      warnings.push({ seeder: 'buy_products', reason: 'response missing media_buy_id (may be submitted async)' });
    } else {
      ids.media_buy_ids = [buyData.media_buy_id];
      if (typeof buyData.revision === 'number' && Number.isInteger(buyData.revision) && buyData.revision >= 1) {
        ids.media_buys = [{ media_buy_id: buyData.media_buy_id, revision: buyData.revision, account }];
      } else {
        warnings.push({ seeder: 'buy_products', reason: 'response missing positive integer revision' });
      }
    }
  }

  try {
    const proposalSeed = await seedCompactProposals(agent, account);
    ids.proposals = proposalSeed.proposals;
    warnings.push(...proposalSeed.warnings);
  } catch (err) {
    // Proposal support is independent from direct published-offer buying.
    // Preserve the real product/media-buy fixtures even when this seller
    // exposes only list_products + buy_products.
    warnings.push({
      seeder: 'buy_products',
      reason: `proposal lifecycle seed threw: ${(err as Error)?.message ?? String(err)}`,
    });
  }
  return { ids, warnings };
}

async function seedCompactProposals(
  agent: AgentClient,
  account: CompactSeedAccount
): Promise<{ proposals: NonNullable<ConformanceFixtures['proposals']>[number][]; warnings: SeedWarning[] }> {
  const warnings: SeedWarning[] = [];
  const drafts: NonNullable<ConformanceFixtures['proposals']>[number][] = [];

  // Two independent drafts let refine and decline probes mutate distinct
  // references. Finalizing the first also leaves a committed snapshot for
  // accept_proposal without sacrificing the second draft.
  for (let attempt = 0; attempt < 2 && drafts.length < 2; attempt++) {
    const requested = await agent.requestProposals({
      idempotency_key: generateIdempotencyKey(),
      account,
      brief: `Conformance proposal seed ${attempt + 1}`,
    });
    if (!requested.success || requested.status !== 'completed' || !requested.data) {
      warnings.push({
        seeder: 'buy_products',
        reason: `request_proposals seed ${attempt + 1}: ${summarizeResult(requested)}`,
      });
      continue;
    }
    for (const proposal of extractProposalFixtures(requested.data, account)) {
      if (proposal.proposal_status !== 'draft') continue;
      if (!drafts.some(existing => existing.proposal_id === proposal.proposal_id)) drafts.push(proposal);
    }
  }

  if (drafts.length === 0) {
    warnings.push({ seeder: 'buy_products', reason: 'request_proposals returned no usable draft proposals' });
    return { proposals: [], warnings };
  }

  const sourceDraft = drafts[0]!;
  const finalized = await agent.executeTaskLegacy('refine_proposals', {
    idempotency_key: generateIdempotencyKey(),
    refinements: [{ proposal_id: sourceDraft.proposal_id, action: 'finalize' }],
  });
  if (!finalized.success || finalized.status !== 'completed' || !finalized.data) {
    warnings.push({ seeder: 'buy_products', reason: 'refine_proposals finalize: ' + summarizeResult(finalized) });
    return { proposals: drafts, warnings };
  }

  const committed = extractProposalFixtures(finalized.data, account).filter(
    proposal => proposal.proposal_status === 'committed'
  );
  if (committed.length === 0) {
    warnings.push({ seeder: 'buy_products', reason: 'refine_proposals returned no committed proposal' });
  }
  return { proposals: [...drafts, ...committed], warnings };
}

function extractProposalFixtures(
  value: unknown,
  account: Record<string, unknown>
): NonNullable<ConformanceFixtures['proposals']>[number][] {
  const found: NonNullable<ConformanceFixtures['proposals']>[number][] = [];
  const seen = new Set<unknown>();

  const visit = (candidate: unknown): void => {
    if (candidate === null || typeof candidate !== 'object' || seen.has(candidate)) return;
    seen.add(candidate);
    const record = candidate as Record<string, unknown>;
    const status = record.proposal_status;
    if (
      typeof record.proposal_id === 'string' &&
      typeof record.terms_digest === 'string' &&
      (status === 'draft' || status === 'committed' || status === 'accepted')
    ) {
      found.push({
        proposal_id: record.proposal_id,
        terms_digest: record.terms_digest,
        proposal_status: status,
        account,
      });
    }
    for (const key of ['proposals', 'proposal', 'results']) {
      const nested = record[key];
      if (Array.isArray(nested)) nested.forEach(visit);
      else visit(nested);
    }
  };

  visit(value);
  return found;
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

/**
 * Creates a single creative by first discovering formats via
 * `list_creative_formats`, picking the first format whose required
 * assets are all covered by our placeholder synthesis, then calling
 * `sync_creatives` with a minimal manifest. Captures returned
 * `creative_id`s into the pool.
 */
async function seedSyncCreatives({ agent, brand }: SeederContext): Promise<SeederOutput> {
  const warnings: SeedWarning[] = [];
  const formatsResult = await agent.executeTaskLegacy('list_creative_formats', {});
  if (!formatsResult.success || formatsResult.status !== 'completed' || !formatsResult.data) {
    return {
      ids: {},
      warnings: [
        { seeder: 'sync_creatives', reason: 'list_creative_formats preflight: ' + summarizeResult(formatsResult) },
      ],
    };
  }
  const formats = (formatsResult.data as { formats?: unknown }).formats;
  if (!Array.isArray(formats) || formats.length === 0) {
    return { ids: {}, warnings: [{ seeder: 'sync_creatives', reason: 'list_creative_formats returned no formats' }] };
  }

  const picked = pickSimpleFormat(formats as FormatDef[]);
  if (!picked) {
    return {
      ids: {},
      warnings: [{ seeder: 'sync_creatives', reason: 'no format with a synthesizable required-asset set' }],
    };
  }

  const manifest = synthesizeManifestAssets(picked);
  const creativeId = `cf_creative_${UNIQUE_TAG()}`;
  const tag = UNIQUE_TAG();

  const result = await agent.executeTaskLegacy('sync_creatives', {
    idempotency_key: generateIdempotencyKey(),
    account: {
      brand: { domain: brand.domain, ...(brand.brand_id ? { brand_id: brand.brand_id } : {}) },
      operator: brand.domain,
    },
    creatives: [
      {
        creative_id: creativeId,
        name: `Conformance Seeder Creative ${tag}`,
        format_id: { agent_url: picked.format_id.agent_url, id: picked.format_id.id },
        assets: manifest,
      },
    ],
  });

  if (!result.success || result.status !== 'completed' || !result.data) {
    return { ids: {}, warnings: [...warnings, { seeder: 'sync_creatives', reason: summarizeResult(result) }] };
  }

  const capturedIds = extractCreativeIds(result.data, creativeId);
  if (capturedIds.length === 0) {
    warnings.push({
      seeder: 'sync_creatives',
      reason: 'response did not surface a creative_id (may be pending review)',
    });
    return { ids: {}, warnings };
  }
  return { ids: { creative_ids: capturedIds }, warnings };
}

/**
 * Pick the first format whose required assets are all in the set of
 * types we know how to synthesize placeholder values for. Sorted by the
 * format's declared order — no clever heuristics.
 */
interface FormatDef {
  format_id: { agent_url: string; id: string };
  assets?: Array<{ asset_id: string; asset_type?: string; required?: boolean; item_type?: string }>;
}
function pickSimpleFormat(formats: FormatDef[]): FormatDef | null {
  for (const f of formats) {
    if (!f?.format_id?.agent_url || !f.format_id.id) continue;
    const required = (f.assets ?? []).filter(a => a?.required === true && a.item_type === 'individual');
    // Skip formats with zero required assets — sellers typically reject a
    // creative with an empty assets dict, so picking one would just
    // trade "no format available" for "creative rejected" downstream.
    if (required.length === 0) continue;
    if (required.every(a => ASSET_PLACEHOLDER[a.asset_type as keyof typeof ASSET_PLACEHOLDER])) return f;
  }
  return null;
}

function synthesizeManifestAssets(format: FormatDef): Record<string, unknown> {
  const manifest: Record<string, unknown> = {};
  for (const asset of format.assets ?? []) {
    if (asset?.required !== true || asset.item_type !== 'individual') continue;
    const placeholder = ASSET_PLACEHOLDER[asset.asset_type as keyof typeof ASSET_PLACEHOLDER];
    if (placeholder) manifest[asset.asset_id] = placeholder();
  }
  return manifest;
}

// Placeholder value per asset type. Kept intentionally small: the
// seeder's job is to produce a creative the agent will accept, not to
// fuzz the asset surface. We only cover types whose `required` fields
// we can satisfy without format-specific knowledge (dimensions, codecs,
// etc. use safe defaults).
const ASSET_PLACEHOLDER = {
  image: () => ({ asset_type: 'image', url: 'https://conformance.example/placeholder.png', width: 300, height: 250 }),
  video: () => ({ asset_type: 'video', url: 'https://conformance.example/placeholder.mp4', width: 640, height: 360 }),
  audio: () => ({ asset_type: 'audio', url: 'https://conformance.example/placeholder.mp3' }),
  text: () => ({ asset_type: 'text', content: 'Conformance seed text' }),
  url: () => ({ asset_type: 'url', url: 'https://conformance.example/' }),
  html: () => ({ asset_type: 'html', content: '<div>Conformance seed</div>' }),
  javascript: () => ({ asset_type: 'javascript', content: '/* conformance seed */' }),
  css: () => ({ asset_type: 'css', content: '/* conformance seed */' }),
  markdown: () => ({ asset_type: 'markdown', content: 'Conformance seed' }),
} as const;

function extractCreativeIds(data: unknown, fallbackId: string): string[] {
  const d = data as { creatives?: unknown; synced_creatives?: unknown };
  const items: unknown[] = [];
  if (Array.isArray(d.creatives)) items.push(...d.creatives);
  if (Array.isArray(d.synced_creatives)) items.push(...d.synced_creatives);
  const ids: string[] = [];
  for (const it of items) {
    const id = (it as { creative_id?: unknown })?.creative_id;
    if (typeof id === 'string' && id.length > 0) ids.push(id);
  }
  // Fall back to the id we supplied — spec allows sellers to echo back
  // buyer-supplied creative_ids on success.
  return ids.length > 0 ? ids : [fallbackId];
}
