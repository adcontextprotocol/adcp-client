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
 * The generic {@link mergeSeed} replaces arrays wholesale — safe default
 * for unknown shapes. Typed wrappers layer **by-id overlay** on top for
 * well-known id-keyed arrays so sellers can seed a single `pricing_options`
 * entry and have it overlay the matching base entry without dropping the
 * rest (see {@link overlayById}).
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
 *     Every other falsy leaf (`0`, `false`, `""`, `[]`) DOES override base.
 *   - Plain-object values recurse (deep merge per key).
 *   - Arrays REPLACE rather than concat — storyboards that seed arrays
 *     expect to define the full list; concat would silently inflate
 *     `pricing_options`, `publisher_properties`, and similar fields past
 *     what the fixture declared. Typed wrappers layer per-array by-id
 *     overlay on top for known id-keyed fields (see {@link overlayById}).
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

/**
 * Identity predicate for by-id array overlay. Returns a key that uniquely
 * identifies an item for matching, or `undefined` if the item can't be
 * identified (in which case the overlay falls through to append).
 */
type IdentityFn<T> = (item: T) => string | undefined;

/**
 * Overlay a seed array onto a base array by a well-known id field.
 *
 * Semantics:
 *   - Seed entries whose identity matches a base entry deep-merge onto
 *     that base entry (via {@link mergeSeed}).
 *   - Seed entries with no matching base entry append to the result.
 *   - Base entries not referenced by any seed entry stay untouched.
 *   - Seed entries missing an identity (e.g., no `pricing_option_id`)
 *     append unconditionally — the fallback matches "array replaces" for
 *     the un-identifiable tail but preserves the matched overlays.
 *
 * Neither input is mutated.
 *
 * @param base   Base array (may be `undefined`).
 * @param seed   Seed array (may be `undefined`).
 * @param identity Returns the id for matching; either a property name or a fn.
 */
export function overlayById<T>(
  base: readonly T[] | undefined,
  seed: readonly T[] | undefined,
  identity: IdentityFn<T> | keyof T
): T[] | undefined {
  if (seed === undefined) return base ? [...base] : undefined;
  if (base === undefined || base.length === 0) return [...seed];

  const idOf: IdentityFn<T> =
    typeof identity === 'function'
      ? identity
      : (item: T) => {
          const v = (item as Record<string, unknown>)[identity as string];
          return typeof v === 'string' ? v : undefined;
        };

  const out: T[] = [];
  const seedById = new Map<string, T>();
  const seedUnkeyed: T[] = [];
  const consumed = new Set<string>();

  for (const item of seed) {
    const id = idOf(item);
    if (id !== undefined) seedById.set(id, item);
    else seedUnkeyed.push(item);
  }

  for (const baseItem of base) {
    const id = idOf(baseItem);
    if (id !== undefined && seedById.has(id)) {
      const seedItem = seedById.get(id)!;
      consumed.add(id);
      out.push(mergeSeed(baseItem, seedItem as Partial<T>));
    } else {
      out.push(baseItem);
    }
  }

  for (const [id, item] of seedById) {
    if (!consumed.has(id)) out.push(item);
  }
  for (const item of seedUnkeyed) out.push(item);

  return out;
}

// ────────────────────────────────────────────────────────────
// Typed wrappers — one per seed kind.
// ────────────────────────────────────────────────────────────
//
// Each wrapper delegates to `mergeSeed` for the top-level object merge,
// then layers by-id overlay on known id-keyed arrays so sellers can seed
// a single entry without replacing the rest.

/**
 * Merge a `seed_product` fixture onto a baseline `Product` (or a partial
 * defaults object).
 *
 * **By-id overlay** is applied to:
 *   - `pricing_options[]` — keyed by `pricing_option_id`. Seeding one
 *     `{ pricing_option_id: 'premium', rate: 25 }` overlays the matching
 *     base entry; other base pricing options stay put.
 *   - `publisher_properties[]` — keyed by `publisher_domain` + `selection_type`
 *     composite (PublisherPropertySelector is a discriminated union, no
 *     single id field).
 *
 * Other arrays (`channels`, `format_ids`, `placements`, ...) still replace
 * wholesale per the {@link mergeSeed} default.
 */
export function mergeSeedProduct<TBase extends Partial<Product> = Partial<Product>>(
  base: TBase,
  seed: Partial<Product> | null | undefined
): TBase {
  const merged = mergeSeed(base, seed as Partial<TBase>);
  if (!isPlainObject(merged) || !seed) return merged;

  const seedObj = seed as Partial<Product>;
  const out = merged as Record<string, unknown>;

  if (Array.isArray(seedObj.pricing_options)) {
    const overlaid = overlayById(
      (base as Partial<Product>).pricing_options as readonly PricingOption[] | undefined,
      seedObj.pricing_options,
      'pricing_option_id'
    );
    if (overlaid !== undefined) out.pricing_options = overlaid;
  }

  if (Array.isArray(seedObj.publisher_properties)) {
    const overlaid = overlayById(
      (base as Partial<Product>).publisher_properties,
      seedObj.publisher_properties,
      item => {
        const domain = (item as { publisher_domain?: unknown }).publisher_domain;
        const sel = (item as { selection_type?: unknown }).selection_type;
        if (typeof domain === 'string' && typeof sel === 'string') return `${domain}::${sel}`;
        return undefined;
      }
    );
    if (overlaid !== undefined) out.publisher_properties = overlaid;
  }

  return merged;
}

/**
 * Merge a `seed_pricing_option` fixture onto a baseline pricing option. The
 * spec's `PricingOption` is a discriminated union; the generic signature
 * preserves whichever variant the base declares. No nested id-keyed arrays
 * to overlay — a pricing option is a leaf-ish record.
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
 *
 * **By-id overlay** is applied to `assets[]` when present, keyed by
 * `asset_id` — matches the creative manifest shape where assets are an
 * id-keyed list and sellers often seed a single asset override.
 */
export function mergeSeedCreative<TBase extends Record<string, unknown> = Record<string, unknown>>(
  base: TBase,
  seed: Partial<TBase> | null | undefined
): TBase {
  const merged = mergeSeed(base, seed);
  if (!isPlainObject(merged) || !seed) return merged;

  const seedObj = seed as Record<string, unknown>;
  const baseObj = base as Record<string, unknown>;
  const out = merged as Record<string, unknown>;

  if (Array.isArray(seedObj.assets)) {
    const overlaid = overlayById(
      Array.isArray(baseObj.assets) ? (baseObj.assets as unknown[]) : undefined,
      seedObj.assets,
      'asset_id'
    );
    if (overlaid !== undefined) out.assets = overlaid;
  }

  return merged;
}

/**
 * Merge a `seed_plan` fixture onto a baseline plan. Like creatives, the spec
 * splits plans across several tool-response shapes, so the base type stays
 * generic.
 *
 * **By-id overlay** is applied to any of these known id-keyed arrays when
 * present on the seed:
 *   - `member_plan_ids[]` — string array, no overlay (replaces).
 *   - `accounts[]` — string array, no overlay (replaces).
 *   - `findings[]` — keyed by `policy_id`.
 *   - `checks[]` — keyed by `check_id` when present.
 *
 * Other arrays replace wholesale per {@link mergeSeed}.
 */
export function mergeSeedPlan<TBase extends Record<string, unknown> = Record<string, unknown>>(
  base: TBase,
  seed: Partial<TBase> | null | undefined
): TBase {
  const merged = mergeSeed(base, seed);
  if (!isPlainObject(merged) || !seed) return merged;

  const seedObj = seed as Record<string, unknown>;
  const baseObj = base as Record<string, unknown>;
  const out = merged as Record<string, unknown>;

  const overlay = (field: string, idField: string) => {
    if (!Array.isArray(seedObj[field])) return;
    const overlaid = overlayById(
      Array.isArray(baseObj[field]) ? (baseObj[field] as unknown[]) : undefined,
      seedObj[field] as unknown[],
      idField as never
    );
    if (overlaid !== undefined) out[field] = overlaid;
  };

  overlay('findings', 'policy_id');
  overlay('checks', 'check_id');

  return merged;
}

/**
 * Merge a `seed_media_buy` fixture onto a baseline `MediaBuy`.
 *
 * **By-id overlay** is applied to `packages[]` keyed by `package_id` — the
 * common storyboard pattern is "seed one package's `delivery` or `status`
 * without rewriting the whole package list", which a naive array replace
 * would break.
 */
export function mergeSeedMediaBuy<TBase extends Partial<MediaBuy> = Partial<MediaBuy>>(
  base: TBase,
  seed: Partial<MediaBuy> | null | undefined
): TBase {
  const merged = mergeSeed(base, seed as Partial<TBase>);
  if (!isPlainObject(merged) || !seed) return merged;

  const seedObj = seed as Partial<MediaBuy>;
  const out = merged as Record<string, unknown>;

  if (Array.isArray(seedObj.packages)) {
    const overlaid = overlayById((base as Partial<MediaBuy>).packages, seedObj.packages, 'package_id');
    if (overlaid !== undefined) out.packages = overlaid;
  }

  return merged;
}
