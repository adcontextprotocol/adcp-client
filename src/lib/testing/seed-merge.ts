/**
 * Seed fixture merge helpers.
 *
 * Every seller that implements a `seed_*` scenario hits the same pattern:
 * take a baseline object that fills in defaults (channels, delivery_type,
 * pricing skeleton, reporting capabilities, ...), overlay whatever sparse
 * fields the storyboard's fixture declares, and ignore `undefined`/`null`
 * entries so an empty fixture leaves the defaults intact. These helpers
 * centralize that permissive merge so sellers don't reinvent it per seed kind.
 *
 * The five seed kinds map 1:1 with the `seed_*` scenarios dispatched by
 * `comply_test_controller`:
 *
 *   - `seed_product`        → {@link mergeSeedProduct}
 *   - `seed_pricing_option` → {@link mergeSeedPricingOption}
 *   - `seed_creative`       → {@link mergeSeedCreative}
 *   - `seed_plan`           → {@link mergeSeedPlan}
 *   - `seed_media_buy`      → {@link mergeSeedMediaBuy}
 *
 * Every wrapper delegates to the generic {@link mergeSeed} — the merge logic
 * is identical for all five. Typed wrappers exist so callers get autocomplete
 * against the shape they actually care about instead of
 * `Record<string, unknown>`.
 *
 * @example
 * ```ts
 * import { mergeSeedProduct } from '@adcp/client/testing';
 *
 * const baseline: Partial<Product> = {
 *   delivery_type: 'guaranteed',
 *   channels: ['display'],
 *   pricing_options: [
 *     { pricing_option_id: 'default', pricing_model: 'cpm', currency: 'USD', rate: 10 },
 *   ],
 * };
 *
 * // Fixture carries only the fields the storyboard wants to override.
 * const merged = mergeSeedProduct(baseline, { product_id: 'prd-1', name: 'Homepage Takeover' });
 * // merged.delivery_type === 'guaranteed' (from baseline)
 * // merged.product_id === 'prd-1' (from fixture)
 * ```
 */

import type { Product, PricingOption } from '../types/tools.generated';
import type { MediaBuy } from '../types/core.generated';

/**
 * Plain-object guard. Class instances, `Date`, `Map`, `Set`, and arrays fail
 * this check — they're treated as opaque leaves that replace their target
 * rather than merge. Matches the capability-overrides predicate in
 * `create-adcp-server.ts` so both paths agree on what counts as "mergeable".
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Reject Map/Set payloads loudly so silent stringification (→ `{}` via
 * `JSON.stringify`) can't ship. These types aren't expected in seed fixtures
 * — storyboards serialize over JSON — and allowing them would let a caller
 * pass a Map and never notice the merge dropped it on the floor.
 */
function rejectUnsupportedCollection(value: unknown, path: string): void {
  if (value instanceof Map) {
    throw new TypeError(
      `mergeSeed: Map is not supported in seed fixtures at ${path}. Convert to a plain object before seeding.`
    );
  }
  if (value instanceof Set) {
    throw new TypeError(
      `mergeSeed: Set is not supported in seed fixtures at ${path}. Convert to an array before seeding.`
    );
  }
}

/**
 * Deep-merge `seed` onto `base`.
 *
 * Merge rules:
 *   - `undefined` or `null` in `seed` → keep the `base` value untouched.
 *   - Plain-object values recurse (deep merge per key).
 *   - Arrays REPLACE rather than concat — storyboards that seed arrays
 *     expect to define the full list; concat would silently inflate
 *     `pricing_options`, `publisher_properties`, and similar fields past
 *     what the fixture declared.
 *   - `Map` / `Set` throw — not expected in seed payloads (see
 *     {@link rejectUnsupportedCollection}).
 *   - Other leaves (strings, numbers, booleans, Dates, class instances)
 *     replace the base value.
 *
 * Neither input is mutated; a fresh object tree is returned.
 */
export function mergeSeed<T>(base: T, seed: Partial<T> | null | undefined): T {
  if (seed === null || seed === undefined) return base;
  rejectUnsupportedCollection(seed, '$');

  if (!isPlainObject(base) || !isPlainObject(seed)) {
    // One side is a leaf — a caller passing a non-object seed wants to
    // override with whatever leaf/array it carries.
    return (seed as T) ?? base;
  }

  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(seed as Record<string, unknown>)) {
    if (value === undefined || value === null) continue;
    rejectUnsupportedCollection(value, `$.${key}`);

    const existing = out[key];
    if (isPlainObject(existing) && isPlainObject(value)) {
      out[key] = mergeSeed(existing, value);
      continue;
    }
    // Array replaces (documented above). Leaves replace.
    out[key] = value;
  }
  return out as T;
}

// ────────────────────────────────────────────────────────────
// Typed wrappers — one per seed kind.
// ────────────────────────────────────────────────────────────
//
// Each wrapper is a thin `mergeSeed<T>` call with a named type. Seed
// fixtures flowing through `comply_test_controller` are typed as
// `Record<string, unknown>` at the wire layer because the spec lets
// storyboards declare only the fields a given test cares about. Sellers
// with a canonical "defaults" shape pass it as `TBase`; the wrapper keeps
// the output typed as `TBase` so autocomplete still works on the merged
// object.

/**
 * Merge a `seed_product` fixture onto a baseline `Product` (or a partial
 * defaults object). The seed is typed as a permissive partial — storyboards
 * routinely declare a product with only `product_id` and `name`, relying on
 * the seller to fill in delivery_type, channels, pricing_options, etc. from
 * its own defaults.
 */
export function mergeSeedProduct<TBase extends Partial<Product> = Partial<Product>>(
  base: TBase,
  seed: Partial<Product> | null | undefined
): TBase {
  return mergeSeed(base, seed as Partial<TBase>);
}

/**
 * Merge a `seed_pricing_option` fixture onto a baseline pricing option. The
 * spec's `PricingOption` is a discriminated union; the generic signature
 * preserves whichever variant the base declares.
 */
export function mergeSeedPricingOption<TBase extends Partial<PricingOption> = Partial<PricingOption>>(
  base: TBase,
  seed: Partial<PricingOption> | null | undefined
): TBase {
  return mergeSeed(base, seed as Partial<TBase>);
}

/**
 * Merge a `seed_creative` fixture onto a baseline creative. The SDK does not
 * ship a canonical `Creative` type (the spec models creatives as a union of
 * several assignment/manifest shapes), so the base is generic — sellers pass
 * whichever domain shape they store internally.
 */
export function mergeSeedCreative<TBase extends Record<string, unknown> = Record<string, unknown>>(
  base: TBase,
  seed: Partial<TBase> | null | undefined
): TBase {
  return mergeSeed(base, seed);
}

/**
 * Merge a `seed_plan` fixture onto a baseline plan. Like creatives, the spec
 * splits plans across several tool-response shapes, so the base type stays
 * generic.
 */
export function mergeSeedPlan<TBase extends Record<string, unknown> = Record<string, unknown>>(
  base: TBase,
  seed: Partial<TBase> | null | undefined
): TBase {
  return mergeSeed(base, seed);
}

/**
 * Merge a `seed_media_buy` fixture onto a baseline `MediaBuy`. Storyboards
 * seed media buys with varying richness depending on the track under test
 * (status-transition suites care about `status`; delivery suites set
 * `packages[*].delivery`), so the wrapper preserves the base type.
 */
export function mergeSeedMediaBuy<TBase extends Partial<MediaBuy> = Partial<MediaBuy>>(
  base: TBase,
  seed: Partial<MediaBuy> | null | undefined
): TBase {
  return mergeSeed(base, seed as Partial<TBase>);
}
