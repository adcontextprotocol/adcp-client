/**
 * Opinionated media-buy store that satisfies the seller's spec contract:
 * persist creation context and `packages[].targeting_overlay` from
 * `create_media_buy`, echo them on `get_media_buys`, and merge targeting
 * updates without dropping creation context or prior
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
 * `createAdcpServerFromPlatform`. Backed by any `AdcpStateStore`:
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

import { applyTargetingInput, resolveTargetingInput } from '../media-buy/targeting-input';
import type { TargetingOverlay, TargetingOverlayInput } from '../types/core.generated';
import type { AdcpStateStore } from './state-store';
import { scopedStore } from './state-store';

/** Default state-store collection name. Adopters can override per-store. */
export const DEFAULT_MEDIA_BUY_STORE_COLLECTION = 'media_buys_targeting';

interface PersistedPackage {
  package_id: string;
  targeting_overlay?: TargetingOverlay;
  context?: Record<string, unknown>;
}

interface PersistedRecord extends Record<string, unknown> {
  media_buy_id: string;
  context?: Record<string, unknown>;
  packages: PersistedPackage[];
}

/**
 * Subset of `CreateMediaBuyRequest` the store cares about. Typed loosely
 * so the wrapper code in `from-platform.ts` doesn't have to upcast the
 * request to the full generated type just to thread it through.
 */
export interface CreateMediaBuyInputForStore {
  /** Opaque creation context, persisted verbatim for resource readback. */
  context?: Record<string, unknown>;
  packages?: Array<{
    package_id?: string;
    buyer_ref?: string;
    product_id?: string;
    context?: Record<string, unknown>;
    /**
     * Request-shaped Targeting Input: individual dimensions may be `null` to
     * suppress a configured-product or product default (AdCP 3.2, DR-0020).
     * The store resolves those clear commands away before persisting.
     */
    targeting_overlay?: TargetingOverlayInput | null;
  }>;
}

/**
 * Subset of `CreateMediaBuyResponse` (the success arm) the store needs to
 * pin persisted-from-request packages to seller-assigned `package_id`s.
 */
export interface CreateMediaBuyResultForStore {
  media_buy_id: string;
  context?: Record<string, unknown>;
  packages?: Array<{
    package_id?: string;
    buyer_ref?: string;
    product_id?: string;
    context?: Record<string, unknown>;
    targeting_overlay?: TargetingOverlay;
  }>;
}

export interface UpdateMediaBuyInputForStore {
  packages?: Array<{
    package_id?: string;
    /**
     * Request-shaped Targeting Input patch. `undefined` (or absent) leaves the
     * stored overlay unchanged, `null` clears it entirely, and an object
     * merges per dimension where a `null` dimension clears just that one.
     */
    targeting_overlay?: TargetingOverlayInput | null;
  }>;
  new_packages?: Array<{
    package_id?: string;
    buyer_ref?: string;
    targeting_overlay?: TargetingOverlayInput | null;
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
    context?: Record<string, unknown>;
    packages?: Array<{
      package_id?: string;
      context?: Record<string, unknown>;
      targeting_overlay?: TargetingOverlay;
    }>;
  }>;
}

export interface MediaBuyStore {
  /**
   * Persist buy/package creation context and `packages[].targeting_overlay`
   * from a successful `create_media_buy`. Joins the request's per-package targeting
   * overlay with the response's seller-assigned `package_id` (or
   * `buyer_ref` when the request used buyer-supplied refs). Context uses
   * unambiguous package identities, then positional alignment only when
   * package counts agree and echoed identities do not contradict it.
   * Existing creation context is retained on repeated persistence calls.
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
   * A patch that clears the last surviving dimension drops the package's
   * tracked overlay entirely, so `backfill` stops echoing one. A cleared
   * dimension is absent from effective readback rather than present as `null`.
   *
   * `new_packages` from the patch are persisted as fresh entries when
   * they declare `targeting_overlay`. Entries that omit it are
   * not tracked. Updates preserve creation context and do not capture
   * context for packages added after creation.
   */
  mergeFromUpdate(accountId: string, mediaBuyId: string, patch: UpdateMediaBuyInputForStore): Promise<void>;

  /**
   * Fill in missing buy/package creation context and
   * `packages[].targeting_overlay` on the seller's
   * `get_media_buys` response from the persisted store. **Mutates the
   * response in place** (and returns it for fluent chaining). Packages
   * the seller already echoed are left untouched. The top-level response
   * context belongs to the read request and is never changed.
   */
  backfill<T extends GetMediaBuysResultForStore>(accountId: string, result: T): Promise<T>;
}

export interface CreateMediaBuyStoreOptions {
  /** Backing state store. Reuses your existing `InMemoryStateStore` / `PostgresStateStore`. */
  store: AdcpStateStore;
  /** Override the logical collection name. Defaults to {@link DEFAULT_MEDIA_BUY_STORE_COLLECTION}. */
  collection?: string;
}

type PackageIdentity = { package_id?: string; product_id?: string; buyer_ref?: string };
const PACKAGE_IDENTITY_FIELDS = ['package_id', 'product_id', 'buyer_ref'] as const;

function compatibleIdentity(left: PackageIdentity | undefined, right: PackageIdentity | undefined): boolean {
  if (!left || !right) return false;
  return PACKAGE_IDENTITY_FIELDS.every(key => !left[key] || !right[key] || left[key] === right[key]);
}

function sharesIdentity(left: PackageIdentity | undefined, right: PackageIdentity | undefined): boolean {
  if (!left || !right) return false;
  return compatibleIdentity(left, right) && PACKAGE_IDENTITY_FIELDS.some(key => left[key] && left[key] === right[key]);
}

function matchContextPackage(
  requests: NonNullable<CreateMediaBuyInputForStore['packages']>,
  responses: NonNullable<CreateMediaBuyResultForStore['packages']>,
  index: number
): NonNullable<CreateMediaBuyInputForStore['packages']>[number] | undefined {
  const matches = requests.filter(request => sharesIdentity(request, responses[index]));
  if (matches.length === 1 && responses.filter(response => sharesIdentity(matches[0], response)).length === 1) {
    return matches[0];
  }
  // A partial or contradictory result cannot safely inherit context by index.
  if (
    requests.length === responses.length &&
    requests.every((request, i) => compatibleIdentity(request, responses[i]))
  ) {
    return requests[index];
  }
  return undefined;
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
      if (!result.media_buy_id) return;

      const prior = await loadRecord(accountId, result.media_buy_id);
      const byId = new Map((prior?.packages ?? []).map(pkg => [pkg.package_id, { ...pkg }]));
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

        // The seller's echo is already the strict effective overlay. Falling
        // back to the request means falling back to a *Targeting Input*, so
        // resolve its clear commands away first: persisting `null` would put a
        // command into durable state, and `backfill` would then echo it into a
        // get_media_buys response whose schema forbids null.
        const persistedOverlay = respPkg?.targeting_overlay ?? resolveTargetingInput(reqPkg.targeting_overlay);
        if (!persistedOverlay) continue;
        byId.set(packageId, { ...byId.get(packageId), package_id: packageId, targeting_overlay: persistedOverlay });
      }

      for (const [index, response] of responsePackages.entries()) {
        if (!response.package_id) continue;
        const context = matchContextPackage(requestPackages, responsePackages, index)?.context ?? response.context;
        const stored = byId.get(response.package_id);
        if (context !== undefined && stored?.context === undefined) {
          byId.set(response.package_id, {
            ...stored,
            package_id: response.package_id,
            context: structuredClone(context),
          });
        }
      }
      const context = prior?.context ?? request.context ?? result.context;
      if (byId.size === 0 && context === undefined) return;
      await writeRecord(accountId, {
        media_buy_id: result.media_buy_id,
        ...(context !== undefined ? { context: structuredClone(context) } : {}),
        packages: Array.from(byId.values()),
      });
    },

    async mergeFromUpdate(accountId, mediaBuyId, patch) {
      const prior = (await loadRecord(accountId, mediaBuyId)) ?? {
        media_buy_id: mediaBuyId,
        packages: [],
      };

      const byId = new Map(prior.packages.map(p => [p.package_id, { ...p }]));

      for (const pkg of patch.packages ?? []) {
        const packageId = pkg?.package_id;
        if (!packageId) continue;
        // `'targeting_overlay' in pkg` distinguishes "patch did not mention
        // overlay" (keep prior) from "patch sent null/empty overlay"
        // (process the clear). With the wire-shape coming through JSON
        // parse, omitted fields are absent from the object entirely.
        if (!('targeting_overlay' in pkg)) continue;
        const incoming = pkg.targeting_overlay;
        if (incoming === undefined) continue;
        const stored = byId.get(packageId);
        const merged = applyTargetingInput(stored?.targeting_overlay, incoming);
        if (merged) byId.set(packageId, { ...stored, package_id: packageId, targeting_overlay: merged });
        else if (stored?.context !== undefined) {
          byId.set(packageId, { package_id: packageId, context: stored.context });
        } else byId.delete(packageId);
      }

      for (const pkg of patch.new_packages ?? []) {
        if (!pkg?.targeting_overlay || !pkg.package_id) continue;
        // A brand-new package has no prior state to patch, so a `null`
        // dimension suppresses a product default rather than clearing stored
        // targeting. Either way it must not reach durable state.
        const resolved = resolveTargetingInput(pkg.targeting_overlay);
        if (resolved)
          byId.set(pkg.package_id, {
            ...byId.get(pkg.package_id),
            package_id: pkg.package_id,
            targeting_overlay: resolved,
          });
      }

      await writeRecord(accountId, {
        ...prior,
        packages: Array.from(byId.values()),
      });
    },

    async backfill(accountId, result) {
      const buys = result.media_buys;
      if (!buys || buys.length === 0) return result;
      for (const buy of buys) {
        if (!buy?.media_buy_id) continue;
        const record = await loadRecord(accountId, buy.media_buy_id);
        if (!record) continue;
        if (buy.context === undefined && record.context !== undefined) {
          buy.context = structuredClone(record.context);
        }
        const byId = new Map(record.packages.map(p => [p.package_id, p]));
        for (const pkg of buy.packages ?? []) {
          if (!pkg?.package_id) continue;
          const persisted = byId.get(pkg.package_id);
          if (!persisted) continue;
          if (pkg.targeting_overlay === undefined && persisted.targeting_overlay !== undefined) {
            pkg.targeting_overlay = persisted.targeting_overlay;
          }
          if (pkg.context === undefined && persisted.context !== undefined) {
            pkg.context = structuredClone(persisted.context);
          }
        }
      }
      return result;
    },
  };
}
