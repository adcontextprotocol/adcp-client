/**
 * Opinionated media-buy store that satisfies the seller's spec contract:
 * persist `packages[].targeting_overlay` from `create_media_buy`, echo it on
 * `get_media_buys`, and deep-merge updates without dropping prior
 * `property_list` / `collection_list` references.
 *
 * Per `schemas/cache/<v>/media-buy/get-media-buys-response.json` the seller
 * SHOULD echo persisted targeting; sellers claiming `property-lists` or
 * `collection-lists` MUST include the persisted references inside the
 * echoed `targeting_overlay`. Wiring this store is the framework-side
 * way to honor that contract without each adapter persisting + merging
 * by hand.
 *
 * Adopters opt in by passing `mediaBuyStore` to
 * `createAdcpServerFromPlatform`. Backed by any `AdcpStateStore` —
 * `InMemoryStateStore` for development, `PostgresStateStore` for
 * production.
 *
 * @example
 * ```ts
 * import {
 *   createAdcpServerFromPlatform,
 *   createMediaBuyStore,
 *   InMemoryStateStore,
 * } from '@adcp/sdk/server';
 *
 * const stateStore = new InMemoryStateStore();
 *
 * createAdcpServerFromPlatform(platform, {
 *   mediaBuyStore: createMediaBuyStore({ store: stateStore }),
 * });
 * ```
 */

import type { TargetingOverlay } from '../types/core.generated';
import type { AdcpStateStore } from './state-store';
import { scopedStore } from './state-store';

/** Default state-store collection name. Adopters can override per-store. */
export const DEFAULT_MEDIA_BUY_STORE_COLLECTION = 'media_buys_targeting';

interface PersistedPackage {
  package_id: string;
  targeting_overlay: TargetingOverlay;
}

interface PersistedRecord extends Record<string, unknown> {
  media_buy_id: string;
  packages: PersistedPackage[];
}

/**
 * Subset of `CreateMediaBuyRequest` the store cares about. Typed loosely
 * so the wrapper code in `from-platform.ts` doesn't have to upcast the
 * request to the full generated type just to thread it through.
 */
export interface CreateMediaBuyInputForStore {
  packages?: Array<{
    package_id?: string;
    buyer_ref?: string;
    targeting_overlay?: TargetingOverlay;
  }>;
}

/**
 * Subset of `CreateMediaBuyResponse` (the success arm) the store needs to
 * pin persisted-from-request packages to seller-assigned `package_id`s.
 */
export interface CreateMediaBuyResultForStore {
  media_buy_id: string;
  packages?: Array<{
    package_id?: string;
    buyer_ref?: string;
  }>;
}

export interface UpdateMediaBuyInputForStore {
  packages?: Array<{
    package_id?: string;
    targeting_overlay?: TargetingOverlay | null;
  }>;
  new_packages?: Array<{
    package_id?: string;
    buyer_ref?: string;
    targeting_overlay?: TargetingOverlay;
  }>;
}

/**
 * Subset of `GetMediaBuysResponse` mirroring the fields the store reads
 * + writes. Echoing is non-mutating from the buyer's perspective: every
 * package the seller already returned with `targeting_overlay` is left
 * alone.
 */
export interface GetMediaBuysResultForStore {
  media_buys?: Array<{
    media_buy_id?: string;
    packages?: Array<{
      package_id?: string;
      targeting_overlay?: TargetingOverlay;
    }>;
  }>;
}

export interface MediaBuyStore {
  /**
   * Persist `packages[].targeting_overlay` from a successful
   * `create_media_buy`. Joins the request's per-package targeting
   * overlay with the response's seller-assigned `package_id` (or
   * `buyer_ref` when the request used buyer-supplied refs).
   */
  persistFromCreate(
    accountId: string,
    request: CreateMediaBuyInputForStore,
    result: CreateMediaBuyResultForStore
  ): Promise<void>;

  /**
   * Apply an `update_media_buy` patch to the persisted record.
   *
   * Per-field merge semantics inside `targeting_overlay`:
   * - field omitted from the patch → keep prior value
   * - field present with a non-null value → replace
   * - field present and `null` → clear (drop the field)
   *
   * `new_packages` from the patch are persisted as fresh entries when
   * they declare `targeting_overlay`. Entries that omit it are
   * intentionally NOT tracked — this store is overlay-only, and a
   * later patch can still seed an overlay onto the package_id when
   * one becomes relevant.
   */
  mergeFromUpdate(accountId: string, mediaBuyId: string, patch: UpdateMediaBuyInputForStore): Promise<void>;

  /**
   * Fill in missing `packages[].targeting_overlay` on the seller's
   * `get_media_buys` response from the persisted store. **Mutates the
   * response in place** (and returns it for fluent chaining). Packages
   * the seller already echoed are left untouched.
   */
  backfill<T extends GetMediaBuysResultForStore>(accountId: string, result: T): Promise<T>;
}

export interface CreateMediaBuyStoreOptions {
  /** Backing state store. Reuses your existing `InMemoryStateStore` / `PostgresStateStore`. */
  store: AdcpStateStore;
  /** Override the logical collection name. Defaults to {@link DEFAULT_MEDIA_BUY_STORE_COLLECTION}. */
  collection?: string;
}

export function createMediaBuyStore(options: CreateMediaBuyStoreOptions): MediaBuyStore {
  const collection = options.collection ?? DEFAULT_MEDIA_BUY_STORE_COLLECTION;

  function viewFor(accountId: string): AdcpStateStore {
    return scopedStore(options.store, accountId);
  }

  async function loadRecord(accountId: string, mediaBuyId: string): Promise<PersistedRecord | null> {
    const view = viewFor(accountId);
    return view.get<PersistedRecord>(collection, mediaBuyId);
  }

  async function writeRecord(accountId: string, record: PersistedRecord): Promise<void> {
    const view = viewFor(accountId);
    await view.put(collection, record.media_buy_id, record);
  }

  return {
    async persistFromCreate(accountId, request, result) {
      const requestPackages = request.packages ?? [];
      const responsePackages = result.packages ?? [];
      if (requestPackages.length === 0 || !result.media_buy_id) return;

      const persistedPackages: PersistedPackage[] = [];
      for (let i = 0; i < requestPackages.length; i++) {
        const reqPkg = requestPackages[i];
        if (!reqPkg?.targeting_overlay) continue;

        // Resolve the seller's assigned package_id. Prefer matching by
        // buyer_ref (deterministic across reorderings); fall back to
        // positional alignment which is the wire convention when the
        // request did not supply buyer refs.
        const buyerRef = reqPkg.buyer_ref;
        const matchedByRef =
          buyerRef && buyerRef.length > 0 ? responsePackages.find(p => p?.buyer_ref === buyerRef) : undefined;
        const respPkg = matchedByRef ?? responsePackages[i];
        const packageId = respPkg?.package_id;
        if (!packageId) continue;

        persistedPackages.push({
          package_id: packageId,
          targeting_overlay: reqPkg.targeting_overlay,
        });
      }

      if (persistedPackages.length === 0) return;
      await writeRecord(accountId, {
        media_buy_id: result.media_buy_id,
        packages: persistedPackages,
      });
    },

    async mergeFromUpdate(accountId, mediaBuyId, patch) {
      const prior = (await loadRecord(accountId, mediaBuyId)) ?? {
        media_buy_id: mediaBuyId,
        packages: [],
      };

      const byId = new Map(prior.packages.map(p => [p.package_id, p.targeting_overlay]));

      for (const pkg of patch.packages ?? []) {
        const packageId = pkg?.package_id;
        if (!packageId) continue;
        // `'targeting_overlay' in pkg` distinguishes "patch did not mention
        // overlay" (keep prior) from "patch sent null/empty overlay"
        // (process the clear). With the wire-shape coming through JSON
        // parse, omitted fields are absent from the object entirely.
        if (!('targeting_overlay' in pkg)) continue;
        const incoming = pkg.targeting_overlay;
        if (incoming === null) {
          byId.delete(packageId);
          continue;
        }
        if (incoming === undefined) continue;
        const priorOverlay = byId.get(packageId);
        byId.set(packageId, mergeOverlay(priorOverlay, incoming));
      }

      for (const pkg of patch.new_packages ?? []) {
        if (!pkg?.targeting_overlay || !pkg.package_id) continue;
        byId.set(pkg.package_id, pkg.targeting_overlay);
      }

      await writeRecord(accountId, {
        media_buy_id: mediaBuyId,
        packages: Array.from(byId.entries()).map(([package_id, targeting_overlay]) => ({
          package_id,
          targeting_overlay,
        })),
      });
    },

    async backfill(accountId, result) {
      const buys = result.media_buys;
      if (!buys || buys.length === 0) return result;
      for (const buy of buys) {
        if (!buy?.media_buy_id || !buy.packages) continue;
        const record = await loadRecord(accountId, buy.media_buy_id);
        if (!record) continue;
        const overlayById = new Map(record.packages.map(p => [p.package_id, p.targeting_overlay]));
        for (const pkg of buy.packages) {
          if (!pkg?.package_id || pkg.targeting_overlay !== undefined) continue;
          const persisted = overlayById.get(pkg.package_id);
          if (persisted) pkg.targeting_overlay = persisted;
        }
      }
      return result;
    },
  };
}

/**
 * Per-key merge of an incoming `TargetingOverlay` patch against the prior
 * persisted overlay. Each key the patch sets to `null` is dropped; each
 * key the patch sets to a value replaces the prior; keys absent from the
 * patch are preserved.
 *
 * The merge is one level deep — `property_list` / `collection_list` are
 * reference objects keyed by `list_id`, so a "partial" property-list
 * update is meaningless and a top-level replace is the right semantics.
 */
function mergeOverlay(prior: TargetingOverlay | undefined, patch: TargetingOverlay): TargetingOverlay {
  const merged: Record<string, unknown> = { ...(prior ?? {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete merged[key];
    } else if (value !== undefined) {
      merged[key] = value;
    }
  }
  return merged as TargetingOverlay;
}
