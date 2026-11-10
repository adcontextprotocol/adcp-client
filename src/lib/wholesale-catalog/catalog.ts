/**
 * Pure helpers for the wholesale catalogue service: the served form of a product, scope versions, change
 * detection and event construction, and page cursors. Nothing here touches storage or the network.
 */
import { randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { canonicalJsonSha256 } from '../utils/jcs';
import { projectV2ProductToV1 } from '../v2/projection';
import type { CatalogEventV1, CatalogProduct, CatalogScope } from './types';
import { catalogScopeKey } from './memory-store';

/** What a buyer sees of a product: `ctx_metadata` stays on the seller's side. */
export function servedProduct(product: CatalogProduct): CatalogProduct {
  const { ctx_metadata: _omit, ...served } = product as CatalogProduct & { ctx_metadata?: unknown };
  return served as CatalogProduct;
}

/**
 * The feed version of a scope. The scope, and the account inside it, are part of the hash, so a token
 * minted for one scope never matches another. Products hash in the order they are served: a reorder changes
 * the pages, so it changes the version.
 */
export function catalogVersion(scope: Readonly<CatalogScope>, products: readonly CatalogProduct[]): string {
  return `sha256:${canonicalJsonSha256({
    cache_scope: scope.cacheScope,
    ...(scope.cacheScope === 'account' && { account_id: scope.accountId }),
    products: products.map(servedProduct),
  })}`;
}

/** A version no catalogue state hashes to, for the steps between two versions of one change. */
function stepVersion(scope: Readonly<CatalogScope>, from: string, to: string, step: number): string {
  return `sha256:${canonicalJsonSha256({ step, scope: catalogScopeKey(scope), from, to })}`;
}

/** Reject a catalogue the service cannot serve or diff: it keys products by `product_id`. */
export function assertCatalogProducts(products: readonly CatalogProduct[], scope: Readonly<CatalogScope>): void {
  const where = `readCatalog(${catalogScopeKey(scope)})`;
  if (!Array.isArray(products)) throw new TypeError(`${where} must return an array of products or null`);
  const seen = new Set<string>();
  for (const product of products) {
    const id = (product as { product_id?: unknown } | null)?.product_id;
    if (typeof id !== 'string' || id.length === 0)
      throw new TypeError(`${where} returned a product without a product_id`);
    if (seen.has(id)) throw new TypeError(`${where} returned product_id ${JSON.stringify(id)} more than once`);
    seen.add(id);
  }
}

/** Whether two catalogues serve the same products in the same order. */
export function sameCatalog(a: readonly CatalogProduct[], b: readonly CatalogProduct[]): boolean {
  return (
    a.length === b.length &&
    a.every((product, index) => isDeepStrictEqual(servedProduct(product), servedProduct(b[index]!)))
  );
}

// -- UUIDv7 ----------------------------------------------------------------------------------------------

let lastUuidMs = 0;
let uuidCounter = 0;

/** A UUIDv7 that sorts after every one this process made before it, so receivers can order events by id. */
export function uuidV7(now: number = Date.now()): string {
  let ms = Math.max(now, lastUuidMs);
  if (ms === lastUuidMs) {
    if (++uuidCounter > 0xfff) {
      ms += 1;
      uuidCounter = 0;
    }
  } else {
    uuidCounter = 0;
  }
  lastUuidMs = ms;
  const random = randomBytes(8);
  random[0] = (random[0]! & 0x3f) | 0x80;
  const hex =
    ms.toString(16).padStart(12, '0') + '7' + uuidCounter.toString(16).padStart(3, '0') + random.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

// -- change detection ------------------------------------------------------------------------------------

export interface CatalogDiffOptions {
  fraction: number;
  maxProducts: number;
  now: Date;
}

type EventBody = Pick<CatalogEventV1, 'type'> & Record<string, unknown>;

/**
 * Compare two catalogues by `product_id`. A product that is new is `created` and one that is gone is
 * `removed`. A product whose only change is `pricing_options` is `priced`; any other change is `updated`
 * and carries the whole product. More than `fraction` of the feed or `maxProducts` products changed is one
 * `wholesale_feed.bulk_change`: too many events to be worth a receiver's time, and its repair is a re-read.
 *
 * Each event carries the version a receiver holds after applying it, so one change from `fromVersion` to
 * `toVersion` is a chain a receiver can follow event by event. The last link is the real `toVersion`.
 */
export function diffCatalogs(
  scope: Readonly<CatalogScope>,
  previous: readonly CatalogProduct[],
  next: readonly CatalogProduct[],
  fromVersion: string,
  toVersion: string,
  options: CatalogDiffOptions
): CatalogEventV1[] {
  const before = new Map(previous.map(product => [product.product_id, servedProduct(product)]));
  const after = new Map(next.map(product => [product.product_id, servedProduct(product)]));
  const bodies: EventBody[] = [];
  for (const [id, product] of after) {
    const prior = before.get(id);
    if (!prior) bodies.push({ type: 'product.created', productId: id, product });
    else if (!isDeepStrictEqual(prior, product)) {
      const { pricing_options: priorPricing, ...priorRest } = prior as CatalogProduct & { pricing_options?: unknown };
      const { pricing_options: pricing, ...rest } = product as CatalogProduct & { pricing_options?: unknown };
      void priorPricing;
      bodies.push(
        isDeepStrictEqual(priorRest, rest) && Array.isArray(pricing)
          ? { type: 'product.priced', productId: id, pricingOptions: pricing }
          : { type: 'product.updated', productId: id, product }
      );
    }
  }
  for (const id of before.keys()) if (!after.has(id)) bodies.push({ type: 'product.removed', productId: id });
  if (bodies.length === 0) return [];

  const appliesTo = appliesToFor(scope);
  const base = { createdAt: options.now.toISOString(), appliesTo };
  const threshold = Math.max(1, Math.min(options.maxProducts, options.fraction * Math.max(before.size, after.size)));
  if (bodies.length > threshold) {
    return [
      {
        ...base,
        eventId: uuidV7(options.now.getTime()),
        previousVersion: fromVersion,
        version: toVersion,
        type: 'wholesale_feed.bulk_change',
        summary: `${bodies.length} products changed`,
        affectedCount: bodies.length,
      },
    ];
  }
  let previousVersion = fromVersion;
  return bodies.map((body, index) => {
    const version = index === bodies.length - 1 ? toVersion : stepVersion(scope, fromVersion, toVersion, index + 1);
    const event = {
      ...base,
      eventId: uuidV7(options.now.getTime()),
      previousVersion,
      version,
      ...body,
    } as CatalogEventV1;
    previousVersion = version;
    return event;
  });
}

/** One bulk change for a scope that gained or lost its own catalogue, where no per-product diff applies. */
export function bulkChangeEvent(
  scope: Readonly<CatalogScope>,
  fromVersion: string | undefined,
  toVersion: string,
  summary: string,
  affectedCount: number,
  now: Date
): CatalogEventV1 {
  return {
    eventId: uuidV7(now.getTime()),
    createdAt: now.toISOString(),
    appliesTo: appliesToFor(scope),
    ...(fromVersion !== undefined && { previousVersion: fromVersion }),
    version: toVersion,
    type: 'wholesale_feed.bulk_change',
    summary,
    affectedCount: Math.max(1, affectedCount),
  };
}

function appliesToFor(scope: Readonly<CatalogScope>): CatalogEventV1['appliesTo'] {
  return scope.cacheScope === 'public' ? { scope: 'public' } : { scope: 'account', accountIds: [scope.accountId] };
}

// -- wire shape ------------------------------------------------------------------------------------------

export type ProductPayloadView = 'canonical' | 'legacy';

/**
 * The legacy (`get_products`) form of a product: `format_ids` in place of `format_options`. `undefined` when the
 * product declares no format a legacy reader can name.
 */
export function legacyProduct(product: CatalogProduct): Record<string, unknown> | undefined {
  const { v1 } = projectV2ProductToV1(product as never);
  return v1.format_ids.length > 0 ? (v1 as unknown as Record<string, unknown>) : undefined;
}

/** Whether a subscriber of the `legacy` view can be told about this event product by product. */
export function legacyRepresentable(event: CatalogEventV1): boolean {
  return !('product' in event) || legacyProduct(event.product) !== undefined;
}

/** The AdCP wholesale feed event (`core/wholesale-feed-event.json`) for `event`, in the subscriber's view. */
export function wireEvent(event: CatalogEventV1, view: ProductPayloadView): Record<string, unknown> {
  const applies_to =
    event.appliesTo.scope === 'public'
      ? { scope: 'public' }
      : { scope: 'account', account_ids: event.appliesTo.accountIds };
  const common = { event_id: event.eventId, event_type: event.type, created_at: event.createdAt };
  switch (event.type) {
    case 'product.created':
    case 'product.updated':
      return {
        ...common,
        entity_type: 'product',
        entity_id: event.productId,
        payload: {
          product_id: event.productId,
          ...(view === 'canonical' ? { canonical_product: event.product } : { product: legacyProduct(event.product) }),
          applies_to,
        },
      };
    case 'product.priced':
      return {
        ...common,
        entity_type: 'product',
        entity_id: event.productId,
        payload: {
          product_id: event.productId,
          ...(view === 'canonical'
            ? { canonical_pricing_options: event.pricingOptions }
            : { pricing_options: event.pricingOptions }),
          applies_to,
        },
      };
    case 'product.removed':
      return {
        ...common,
        entity_type: 'product',
        entity_id: event.productId,
        payload: { product_id: event.productId, applies_to },
      };
    case 'wholesale_feed.bulk_change':
      return {
        ...common,
        entity_type: 'feed',
        entity_id: event.eventId,
        payload: {
          summary: event.summary,
          affected_count: event.affectedCount,
          recommendation: 'wholesale_resync',
          affected_entity_type: 'product',
          applies_to,
        },
      };
  }
}

// -- paging ----------------------------------------------------------------------------------------------

/** The page size when a request names none, and the most a request may ask for (`core/pagination-request.json`). */
export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 100;

interface CursorBody {
  /** The scope, and the selection, the cursor was minted for. */
  s: string;
  /** The offset of the next product. */
  o: number;
  /** The feed version the page was read at. */
  v: string;
}

export function encodeCursor(scopeKey: string, offset: number, version: string): string {
  const body: CursorBody = { s: scopeKey, o: offset, v: version };
  return Buffer.from(JSON.stringify(body)).toString('base64url');
}

/**
 * The offset a cursor points at, or `undefined` when it is not a cursor this service minted for this scope
 * and selection. A cursor read at an older version still resolves: the page is served from the current
 * snapshot with the current version, which tells the buyer to restart.
 */
export function decodeCursor(cursor: string, scopeKey: string): number | undefined {
  try {
    const body = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Partial<CursorBody>;
    if (body.s !== scopeKey) return undefined;
    return Number.isSafeInteger(body.o) && body.o! >= 0 ? body.o : undefined;
  } catch {
    return undefined;
  }
}
