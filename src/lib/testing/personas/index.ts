/**
 * Canonical buyer personas — typed, immutable test fixtures every
 * adopter would otherwise rewrite. Each persona carries enough identity
 * (brand domain, account_id, promoted_offering, brief) to drive the
 * common AdCP request shapes without surface-area surprises.
 *
 * Use when you want a deterministic buyer to drive an integration test
 * against your seller / signal / creative agent. Pair with the builder
 * helpers below to construct wire-shaped requests in one line.
 *
 * The four shipped personas span the verticals and budget classes most
 * sellers see: enterprise CTV, performance social, premium B2B, and
 * geo-targeted local. Adopters who need richer coverage extend the
 * pattern; this set intentionally stays small to keep the surface
 * stable through preview.
 *
 * Status: Preview / 6.0.
 *
 * @example
 * ```ts
 * import { dtcSkincareBuyer, buildGetProductsRequest } from '@adcp/sdk/testing/personas';
 *
 * const result = await server.dispatchTestRequest({
 *   method: 'tools/call',
 *   params: {
 *     name: 'get_products',
 *     arguments: buildGetProductsRequest(dtcSkincareBuyer),
 *   },
 * });
 * ```
 *
 * @public
 */

import type { AccountReference, BrandReference, GetProductsRequest } from '../../types/tools.generated';

/**
 * A canonical buyer persona — brand identity + account fixture + brief
 * + budget shape. Typed `readonly` because personas are shared
 * fixtures: tests should mutate via the builder helpers (which clone
 * before adding overrides), never the persona object itself.
 *
 * @public
 */
export interface BuyerPersona {
  /** Stable ID. Use this in test names + bug reports. */
  readonly id: string;
  /** Display name for test output. */
  readonly name: string;
  /** Vertical — same vocabulary as `SampleBrief.vertical`. */
  readonly vertical: string;
  /** Brand identity: domain hosts /.well-known/brand.json in real deployments. */
  readonly brand: { readonly domain: string; readonly name: string };
  /** Account ID this persona uses on the test seller. */
  readonly account_id: string;
  /** Single-line summary of what the buyer is selling — feeds `promoted_offering` on `get_products`. */
  readonly promoted_offering: string;
  /** Free-text brief — same shape as `SampleBrief.brief`, used by brief-driven sellers. */
  readonly brief: string;
  /** Total campaign budget hint. */
  readonly budget: { readonly amount: number; readonly currency: string };
  /** Channels this persona typically requests, in priority order. */
  readonly channels: readonly string[];
}

/**
 * DTC ecommerce on a tight performance budget. Social-first, Gen-Z
 * audience, $50K test budget, performance pricing models preferred.
 * Mirrors the `dtc_skincare_genZ` SampleBrief.
 *
 * @public
 */
export const dtcSkincareBuyer: BuyerPersona = {
  id: 'dtc_skincare_buyer',
  name: 'Glow Lab — DTC Skincare',
  vertical: 'Beauty & Personal Care',
  brand: { domain: 'glowlab.example.com', name: 'Glow Lab' },
  account_id: 'acc_glowlab',
  promoted_offering: 'Glow Lab Vitamin C Serum + first-time-buyer 20% off',
  brief:
    'Direct-to-consumer skincare brand targeting Gen Z females (18-25). ' +
    'Social-first campaign with UGC-style creative preferred. ' +
    'Goal is driving trial purchases through a 20% off promo code. ' +
    'Performance-oriented: need clear CPA/CPC pricing.',
  budget: { amount: 50_000, currency: 'USD' },
  channels: ['social', 'display'],
};

/**
 * Luxury automotive launch. High-impact video + premium display, $500K
 * Q3 flight, brand safety critical. Mirrors the `luxury_auto_ev`
 * SampleBrief.
 *
 * @public
 */
export const luxuryAutoBuyer: BuyerPersona = {
  id: 'luxury_auto_buyer',
  name: 'Velara Motors — EV Launch',
  vertical: 'Automotive',
  brand: { domain: 'velaramotors.example.com', name: 'Velara Motors' },
  account_id: 'acc_velara',
  promoted_offering: 'Velara V1 — luxury electric crossover SUV',
  brief:
    'Luxury automotive brand launching a new electric crossover SUV. ' +
    'Targeting high-income households ($150K+ HHI), ages 30-55, in major US metros. ' +
    'Need high-impact video and premium display placements. ' +
    'Q3 flight (July-September). Key message: "The future of luxury driving." ' +
    'Brand safety is critical — no UGC or controversial adjacency.',
  budget: { amount: 500_000, currency: 'USD' },
  channels: ['olv', 'ctv', 'display'],
};

/**
 * Enterprise B2B SaaS awareness — premium publisher placements,
 * viewability benchmarks, $200K over six weeks. Mirrors the
 * `b2b_saas_awareness` SampleBrief.
 *
 * @public
 */
export const b2bSaasBuyer: BuyerPersona = {
  id: 'b2b_saas_buyer',
  name: 'Threadline — Workflow Platform',
  vertical: 'Technology / B2B',
  brand: { domain: 'threadline.example.com', name: 'Threadline' },
  account_id: 'acc_threadline',
  promoted_offering: 'Threadline workflow platform — annual enterprise plan',
  brief:
    'Enterprise SaaS company building brand awareness among IT decision-makers and C-suite executives. ' +
    'Looking for premium editorial environments — business, technology, and finance publishers. ' +
    'Display and native content placements preferred. CTV is acceptable if targeting is precise. ' +
    'Viewability benchmarks are important — need 70%+ viewability guarantee.',
  budget: { amount: 200_000, currency: 'USD' },
  channels: ['display', 'ctv'],
};

/**
 * Regional QSR / restaurant chain — geo-targeted mobile + display
 * within radius, foot-traffic attribution. Mirrors the
 * `restaurant_local` SampleBrief.
 *
 * @public
 */
export const restaurantLocalBuyer: BuyerPersona = {
  id: 'restaurant_local_buyer',
  name: 'Anchor & Oak — Regional Chain',
  vertical: 'QSR / Restaurant',
  brand: { domain: 'anchorandoak.example.com', name: 'Anchor & Oak' },
  account_id: 'acc_anchoroak',
  promoted_offering: 'Anchor & Oak summer menu — promoted across 15 metros',
  brief:
    'Regional restaurant chain promoting a new menu launch across 15 metro areas. ' +
    'Need geo-targeted mobile and display ads within 5-mile radius of each location. ' +
    'Audio/podcast ads are also interesting if available. ' +
    'Performance tracking: need foot traffic attribution or store visit metrics.',
  budget: { amount: 75_000, currency: 'USD' },
  channels: ['display', 'audio'],
};

/**
 * All shipped personas, in stable order. Adopters iterate this array
 * to run a scenario across every canonical buyer in one loop.
 *
 * @public
 */
export const ALL_PERSONAS: readonly BuyerPersona[] = [
  dtcSkincareBuyer,
  luxuryAutoBuyer,
  b2bSaasBuyer,
  restaurantLocalBuyer,
];

/**
 * Look up a persona by `id`. Returns `undefined` for unknown IDs —
 * test code asserting on a specific persona should narrow with a
 * non-null check.
 *
 * @public
 */
export function getPersonaById(id: string): BuyerPersona | undefined {
  return ALL_PERSONAS.find(p => p.id === id);
}

// ---------------------------------------------------------------------------
// Wire-shape builders
// ---------------------------------------------------------------------------

/**
 * Build an {@link AccountReference} pointing at the persona's account.
 * Discriminated-union narrowing concern: the wire shape allows
 * `account_id`, `brand`, or `brand + operator`. This builder always
 * returns the `account_id` arm — adopters who need the brand-arm shape
 * should compose `buildBrandReference(persona)` with their own operator.
 *
 * @public
 */
export function buildAccountReference(persona: BuyerPersona): AccountReference {
  return { account_id: persona.account_id };
}

/**
 * Build a {@link BrandReference} from the persona's brand identity.
 * Domain is the canonical field; name is dropped (the wire spec doesn't
 * carry it on `BrandReference` — sellers resolve via brand.json).
 *
 * @public
 */
export function buildBrandReference(persona: BuyerPersona): BrandReference {
  return { domain: persona.brand.domain };
}

/**
 * Build a wire-shaped {@link GetProductsRequest} keyed to this persona —
 * `buying_mode: 'brief'`, the persona's `brief` text, brand reference,
 * and account reference. Pass `overrides` to add `filters`,
 * `preferred_delivery_types`, `time_budget`, etc.
 *
 * @public
 */
export function buildGetProductsRequest(
  persona: BuyerPersona,
  overrides?: Partial<GetProductsRequest>
): GetProductsRequest {
  return {
    buying_mode: 'brief',
    brief: persona.brief,
    brand: buildBrandReference(persona),
    account: buildAccountReference(persona),
    ...overrides,
  };
}
