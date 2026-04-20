/**
 * Canonical AdCP compliance storyboard fixtures.
 *
 * Conformance storyboards reference entities by hardcoded ID —
 * `test-product`, `test-pricing`, `video_30s`, `native_post`,
 * `native_content`, `campaign_hero_video`, `sports_ctv_q2`,
 * `cpm_guaranteed`, `gov_acme_q2_2027`, `mb_acme_q2_2026_auction`,
 * and a handful of others. None are discoverable from the JSON
 * Schemas alone; every implementer hits the same wall (failing
 * storyboards → grep YAML source → hand-seed matching fixtures).
 *
 * This module owns the canonical data and offers two integration
 * paths:
 *
 *   - {@link COMPLIANCE_FIXTURES}: a typed object literal with every
 *     known fixture ID and a minimal-but-storyboard-compatible body.
 *     Sellers can merge these into whatever handlers answer the
 *     relevant tools (`get_products`, `list_creative_formats`,
 *     `list_creatives`, …).
 *
 *   - {@link seedComplianceFixtures}: writes the fixtures into the
 *     server's state store under well-known collection names (see
 *     {@link COMPLIANCE_COLLECTIONS}). Sellers whose handlers already
 *     read-through the state store get fixtures populated without
 *     touching handler code.
 *
 * ```ts
 * import { createAdcpServer } from '@adcp/client/server';
 * import { seedComplianceFixtures, COMPLIANCE_FIXTURES } from '@adcp/client/compliance-fixtures';
 *
 * const server = createAdcpServer({
 *   mediaBuy: {
 *     getProducts: async (_params, ctx) => ({
 *       products: [
 *         ...(await ctx.store.list('compliance:products')).items.map(r => r.value),
 *         ...myCatalog,
 *       ],
 *     }),
 *   },
 *   ...handlers,
 * });
 *
 * await seedComplianceFixtures(server);
 * ```
 *
 * The shipped bodies are minimal on purpose: they contain exactly the
 * fields storyboards probe. Sellers whose catalog shape differs (richer
 * pricing, per-brand variants, etc.) SHOULD override via
 * {@link SeedComplianceFixturesOptions.overrides}.
 */

import { ADCP_STATE_STORE, type AdcpServer } from '../server/adcp-server';
import type { AdcpStateStore } from '../server/state-store';
// Pull canonical unions/shapes from the generated spec types so fixture
// typings can't drift from the schema. Hand-typing `pricing_model` as
// `'cpm' | 'cpc' | 'cpv' | 'flat'` is how we shipped `'flat'` (which
// doesn't exist in the spec) — the generated `PricingModel` has the
// authoritative union.
import type { PricingModel } from '../types/tools.generated';

export type ComplianceFixtureCategory =
  | 'products'
  | 'formats'
  | 'creatives'
  | 'plans'
  | 'media_buys'
  | 'pricing_options';

/**
 * State-store collection names the seeder writes into. Handlers that
 * read-through the state store should use the same names when
 * integrating fixture data into their own responses.
 */
export const COMPLIANCE_COLLECTIONS: Readonly<Record<ComplianceFixtureCategory, string>> = Object.freeze({
  products: 'compliance:products',
  formats: 'compliance:formats',
  creatives: 'compliance:creatives',
  plans: 'compliance:plans',
  media_buys: 'compliance:media_buys',
  pricing_options: 'compliance:pricing_options',
});

export interface ComplianceProductFixture {
  product_id: string;
  name: string;
  description: string;
  delivery_type: 'guaranteed' | 'non_guaranteed';
  channels: string[];
  formats: string[];
  pricing_options: string[];
}

export interface ComplianceFormatFixture {
  format_id: string;
  name: string;
  type: string;
  width?: number;
  height?: number;
  duration_ms?: number;
}

export interface CompliancePricingOptionFixture {
  pricing_option_id: string;
  /** ISO 4217 currency code, per the spec's `PricingOption.currency`. */
  currency: string;
  /**
   * Pricing model — uses the authoritative generated union. The spec
   * discriminates `PricingOption` on this field across 9 variants
   * (`cpm`, `vcpm`, `cpc`, `cpcv`, `cpv`, `cpp`, `cpa`, `flat_rate`,
   * `time`); mismatches here silently fail schema validation in
   * seller-side `get_products` responses that merge fixture data in.
   */
  pricing_model: PricingModel;
  /**
   * Fixed price per unit per the matching `*PricingOption.fixed_price`
   * field (CPM, CPC, etc.). Present when this is a fixed-price option;
   * omit for auction-based options that advertise `floor_price` /
   * `price_guidance` instead.
   */
  fixed_price?: number;
  /** Floor price for auction-based options. */
  floor_price?: number;
}

export interface ComplianceCreativeFixture {
  creative_id: string;
  format_id: string;
  status: 'approved' | 'pending' | 'rejected';
  name: string;
}

export interface CompliancePlanFixture {
  plan_id: string;
  brand_domain: string;
  total_budget: { amount: number; currency: string };
  status: 'active' | 'paused';
}

export interface ComplianceMediaBuyFixture {
  media_buy_id: string;
  status: 'active' | 'pending_start' | 'completed';
  total_budget: { amount: number; currency: string };
}

export interface ComplianceFixtureSet {
  products: Readonly<Record<string, Readonly<ComplianceProductFixture>>>;
  formats: Readonly<Record<string, Readonly<ComplianceFormatFixture>>>;
  pricing_options: Readonly<Record<string, Readonly<CompliancePricingOptionFixture>>>;
  creatives: Readonly<Record<string, Readonly<ComplianceCreativeFixture>>>;
  plans: Readonly<Record<string, Readonly<CompliancePlanFixture>>>;
  media_buys: Readonly<Record<string, Readonly<ComplianceMediaBuyFixture>>>;
}

/**
 * Canonical storyboard fixtures. Every ID here appears verbatim in at
 * least one `compliance/cache/latest/**\/*.yaml` storyboard — CI lints
 * the tie between source storyboards and this set (not yet; see
 * {@link https://github.com/adcontextprotocol/adcp-client/issues/663}).
 */
export const COMPLIANCE_FIXTURES: ComplianceFixtureSet = Object.freeze({
  products: Object.freeze({
    'test-product': Object.freeze({
      product_id: 'test-product',
      name: 'Test Product',
      description:
        'Generic non-guaranteed inventory used by universal storyboards (error-compliance, idempotency, deterministic-testing, schema-validation).',
      delivery_type: 'non_guaranteed',
      channels: ['display', 'video'],
      formats: ['video_30s', 'native_post', 'native_content'],
      pricing_options: ['test-pricing', 'default'],
    }),
    sports_ctv_q2: Object.freeze({
      product_id: 'sports_ctv_q2',
      name: 'Sports CTV — Q2',
      description: 'CTV variant referenced by governance-spend-authority and governance-delivery-monitor storyboards.',
      delivery_type: 'guaranteed',
      channels: ['ctv'],
      formats: ['video_30s'],
      pricing_options: ['cpm_guaranteed'],
    }),
  }),

  formats: Object.freeze({
    video_30s: Object.freeze({
      format_id: 'video_30s',
      name: '30-second Video',
      type: 'video',
      duration_ms: 30_000,
    }),
    native_post: Object.freeze({
      format_id: 'native_post',
      name: 'Native Post',
      type: 'native',
    }),
    native_content: Object.freeze({
      format_id: 'native_content',
      name: 'Native Content',
      type: 'native',
    }),
  }),

  pricing_options: Object.freeze({
    'test-pricing': Object.freeze({
      pricing_option_id: 'test-pricing',
      currency: 'USD',
      pricing_model: 'cpm',
      fixed_price: 5,
    }),
    default: Object.freeze({
      pricing_option_id: 'default',
      currency: 'USD',
      pricing_model: 'cpm',
      fixed_price: 10,
    }),
    cpm_guaranteed: Object.freeze({
      pricing_option_id: 'cpm_guaranteed',
      currency: 'USD',
      pricing_model: 'cpm',
      fixed_price: 25,
    }),
  }),

  creatives: Object.freeze({
    campaign_hero_video: Object.freeze({
      creative_id: 'campaign_hero_video',
      format_id: 'video_30s',
      status: 'approved',
      name: 'Campaign Hero Video',
    }),
  }),

  plans: Object.freeze({
    gov_acme_q2_2027: Object.freeze({
      plan_id: 'gov_acme_q2_2027',
      brand_domain: 'acmeoutdoor.example',
      total_budget: Object.freeze({ amount: 50_000, currency: 'USD' }),
      status: 'active',
    }),
  }),

  media_buys: Object.freeze({
    mb_acme_q2_2026_auction: Object.freeze({
      media_buy_id: 'mb_acme_q2_2026_auction',
      status: 'active',
      total_budget: Object.freeze({ amount: 25_000, currency: 'USD' }),
    }),
  }),
}) as ComplianceFixtureSet;

export interface SeedComplianceFixturesOptions {
  /**
   * Subset of fixture categories to seed. Defaults to all six.
   */
  categories?: ComplianceFixtureCategory[];
  /**
   * Per-category overrides to merge ON TOP of the canonical fixtures.
   * Keys are the fixture IDs — replacing an entry with `null` deletes
   * it from the seed set (for sellers whose catalog shape legitimately
   * can't satisfy a given storyboard's expectations).
   */
  overrides?: {
    [K in ComplianceFixtureCategory]?: Record<string, ComplianceFixtureSet[K][string] | null>;
  };
  /**
   * Collection-name prefix override. Defaults to the
   * {@link COMPLIANCE_COLLECTIONS} defaults (`compliance:*`). Use when
   * your handlers already read from a different collection convention.
   */
  collections?: Partial<Record<ComplianceFixtureCategory, string>>;
}

/**
 * Write {@link COMPLIANCE_FIXTURES} into the server's state store
 * under {@link COMPLIANCE_COLLECTIONS}. Handlers that read from the
 * same collections get compliance fixtures without hand-seeding.
 *
 * Idempotent: re-seeding overwrites existing entries with the same ID
 * (the state store's `put` is the write primitive — no version check).
 * Between storyboards, call `server.compliance.reset()` to clear state
 * AND re-seed (reset itself doesn't restore fixtures).
 *
 * Throws when the server doesn't expose a state store with the shape
 * {@link AdcpStateStore}. Custom servers that wrap the MCP SDK directly
 * should use {@link COMPLIANCE_FIXTURES} as the source of truth and
 * wire seeding themselves.
 */
export async function seedComplianceFixtures(
  server: AdcpServer,
  options: SeedComplianceFixturesOptions = {}
): Promise<void> {
  const store = resolveStateStore(server);
  const categories: ComplianceFixtureCategory[] =
    options.categories ?? (Object.keys(COMPLIANCE_COLLECTIONS) as ComplianceFixtureCategory[]);

  for (const category of categories) {
    const fixtures = COMPLIANCE_FIXTURES[category] as Record<string, Record<string, unknown>>;
    const overrides = (options.overrides?.[category] ?? {}) as Record<string, Record<string, unknown> | null>;
    const collection = options.collections?.[category] ?? COMPLIANCE_COLLECTIONS[category];

    const merged: Record<string, Record<string, unknown>> = { ...fixtures };
    for (const [id, override] of Object.entries(overrides)) {
      if (override === null) {
        delete merged[id];
      } else {
        merged[id] = override;
      }
    }

    for (const [id, body] of Object.entries(merged)) {
      await store.put(collection, id, body);
    }
  }
}

/**
 * Look up a single fixture by category and ID. Convenience for
 * handlers that don't want to iterate the entire fixture set.
 */
export function getComplianceFixture<K extends ComplianceFixtureCategory>(
  category: K,
  id: string
): ComplianceFixtureSet[K][string] | undefined {
  return (COMPLIANCE_FIXTURES[category] as Record<string, ComplianceFixtureSet[K][string]>)[id];
}

function resolveStateStore(server: AdcpServer): AdcpStateStore {
  const candidate = (server as unknown as { [k: symbol]: unknown })[ADCP_STATE_STORE];
  if (isStateStore(candidate)) return candidate;
  throw new Error(
    'seedComplianceFixtures: argument is not an AdcpServer produced by `createAdcpServer()`. ' +
      'Use `COMPLIANCE_FIXTURES` directly and seed via your own integration path.'
  );
}

function isStateStore(value: unknown): value is AdcpStateStore {
  return (
    value != null &&
    typeof value === 'object' &&
    typeof (value as { put?: unknown }).put === 'function' &&
    typeof (value as { get?: unknown }).get === 'function' &&
    typeof (value as { list?: unknown }).list === 'function'
  );
}
