/**
 * Bridge between the `comply_test_controller` seed store and the
 * `createAdcpServer` spec-tool pipeline.
 *
 * Sellers who run the compliance conformance suite seed fixtures via
 * `comply_test_controller.seed_product`, but those fixtures don't flow into
 * `get_products` responses unless the seller plumbs it themselves — every
 * seller ends up rewriting the same "look up seeded products, merge into
 * handler response, dedupe, sandbox-gate" boilerplate.
 *
 * This module exposes a small declarative shape (`TestControllerBridge`)
 * that the server config accepts; when present, the dispatcher augments
 * `get_products` responses with seeded products on sandbox requests, and
 * leaves production traffic untouched.
 *
 * The bridge intentionally does NOT know how seeded products are stored.
 * Sellers provide a `getSeededProducts` callback that returns the list the
 * SDK should merge — which lets the same wiring work whether the backing
 * store is in-memory, Postgres, Redis, or a mock.
 */

import type {
  Product,
  GetProductsResponse,
  Account,
  ListAccountsResponse,
  ListCreativesResponse,
  GetMediaBuysResponse,
  GetMediaBuyDeliveryResponse,
  ListCreativeFormatsResponse,
  Format,
  GetAccountFinancialsResponse,
  GetAccountFinancialsSuccess,
  GetAccountFinancialsRequest,
  PropertyList,
  ListPropertyListsResponse,
  GetPropertyListResponse,
  GetPropertyListRequest,
  CollectionList,
  ListCollectionListsResponse,
  GetCollectionListResponse,
  GetCollectionListRequest,
  ContentStandards,
  ListContentStandardsResponse,
  GetContentStandardsResponse,
  GetContentStandardsRequest,
  GetSignalsResponse,
  GetCreativeDeliveryResponse,
  GetCreativeFeaturesResponse,
  CreativeFeatureResult,
} from '../types/tools.generated';
import { mergeSeedProduct } from '../testing/seed-merge';

/**
 * Seeded signal entry — the inline element type of `GetSignalsResponse.signals`.
 * Derived via lookup so it stays in lockstep with the generated wire schema.
 * Dedup key: `signal_id`.
 */
export type SeededSignal = GetSignalsResponse['signals'][number];

/**
 * Seeded creative-delivery entry — the inline element type of
 * `GetCreativeDeliveryResponse.creatives`. Derived via lookup so it stays in
 * lockstep with the generated wire schema. Dedup key: `creative_id`.
 */
export type SeededCreativeDelivery = GetCreativeDeliveryResponse['creatives'][number];

/**
 * Seeded creative-feature result — alias for the per-feature evaluation entry.
 * `get_creative_features` returns a `results: CreativeFeatureResult[]` array
 * on the success arm; the bridge seeds at the feature granularity (not the
 * whole envelope) so adopters can override specific feature scores while the
 * handler computes everything else. Dedup key: `feature_id`.
 */
export type SeededCreativeFeature = CreativeFeatureResult;

/**
 * Seeded creative entry — the inline element type of `ListCreativesResponse.creatives`.
 * Derived via lookup so it stays in lockstep with the generated wire schema.
 */
export type SeededCreative = ListCreativesResponse['creatives'][number];

/**
 * Seeded media-buy entry — the inline element type of `GetMediaBuysResponse.media_buys`.
 * Derived via lookup so it stays in lockstep with the generated wire schema.
 */
export type SeededMediaBuy = GetMediaBuysResponse['media_buys'][number];

/**
 * Seeded account-financials entry. The `get_account_financials` response is a
 * singleton (one account, one envelope), so the bridge callback returns an
 * array keyed by `account.account_id` and the framework picks the entry
 * matching the request's `account` reference — replacing the handler response
 * for that account when matched. Storyboards seeding financials for an account
 * under test see their fixture; un-seeded accounts pass through to the handler.
 */
export type SeededAccountFinancials = GetAccountFinancialsSuccess;

/**
 * Seeded media-buy-delivery entry — the inline element type of
 * `GetMediaBuyDeliveryResponse.media_buy_deliveries`. Derived via lookup so it
 * stays in lockstep with the generated wire schema.
 */
export type SeededMediaBuyDelivery = GetMediaBuyDeliveryResponse['media_buy_deliveries'][number];

/**
 * The shape of `GetMediaBuyDeliveryResponse.aggregated_totals` (optional on the
 * wire — recomputed by the bridge from the merged delivery array per the
 * documented policy).
 */
type AggregatedTotals = NonNullable<GetMediaBuyDeliveryResponse['aggregated_totals']>;

/**
 * Context passed to {@link TestControllerBridge.getSeededProducts}.
 *
 * `input` is the raw `get_products` request as received over the wire (post
 * MCP schema validation). `account` is the resolved seller account when
 * `resolveAccount` is configured on `createAdcpServer`, else `undefined` —
 * sellers who key seeded fixtures per account read it from here.
 */
export interface TestControllerBridgeContext<TAccount = unknown> {
  input: Record<string, unknown>;
  account?: TAccount;
}

/**
 * Wiring that connects the `comply_test_controller` seed store to the
 * spec-tool pipeline.
 *
 * Set on `AdcpServerConfig.testController`; when absent, behavior is
 * unchanged. The bridge is opt-in via the presence of `getSeededProducts`
 * — omit it to hold seeded state without changing response shape.
 */
export interface TestControllerBridge<TAccount = unknown> {
  /**
   * Retrieve seeded products for the current request. Return an empty
   * array (or `undefined`) when nothing is seeded. The returned products
   * are appended to the handler's `get_products` response; on
   * `product_id` collision, the seeded entry wins (sellers who seed to
   * override default inventory expect their fixture to take precedence).
   *
   * Scope your implementation to `ctx.account`; the framework's sandbox
   * check is a namespace selector, not an authority boundary. Your
   * callback MUST re-verify that `ctx.account` is a sandbox account
   * before returning fixtures (and the framework additionally skips the
   * bridge when it has a resolved non-sandbox account, belt-and-suspenders).
   */
  getSeededProducts?: (ctx: TestControllerBridgeContext<TAccount>) => Promise<Product[]> | Product[];

  /**
   * Retrieve seeded creatives for the current request. Returned entries are
   * appended to the handler's `list_creatives` response (`creatives` array);
   * on `creative_id` collision the seeded entry wins. Empty array (or
   * `undefined`) when nothing is seeded. Same sandbox gating contract as
   * {@link TestControllerBridge.getSeededProducts}.
   */
  getSeededCreatives?: (ctx: TestControllerBridgeContext<TAccount>) => Promise<SeededCreative[]> | SeededCreative[];

  /**
   * Retrieve seeded media buys for the current request. Returned entries are
   * appended to the handler's `get_media_buys` response (`media_buys` array);
   * on `media_buy_id` collision the seeded entry wins. Same sandbox gating
   * contract as {@link TestControllerBridge.getSeededProducts}.
   */
  getSeededMediaBuys?: (ctx: TestControllerBridgeContext<TAccount>) => Promise<SeededMediaBuy[]> | SeededMediaBuy[];

  /**
   * Retrieve seeded media-buy delivery snapshots. Returned entries are merged
   * into the handler's `get_media_buy_delivery` response (`media_buy_deliveries`
   * array); on `media_buy_id` collision the seeded entry wins, matching the
   * precedent set by `mergeSeededMediaBuys` / `mergeSeededCreatives` /
   * `mergeSeededAccounts` — storyboards seed deliberately, so a seeded fixture
   * for an existing `media_buy_id` is an explicit author override.
   *
   * After the merge, the response's `aggregated_totals` block is recomputed
   * from the merged per-delivery `totals` so `media_buy_count` /
   * `impressions` / `spend` stay wire-correct. See
   * {@link recomputeAggregatedTotals} for the recomputation policy. Same
   * sandbox gating contract as {@link TestControllerBridge.getSeededProducts}.
   */
  getSeededMediaBuyDelivery?: (
    ctx: TestControllerBridgeContext<TAccount>
  ) => Promise<SeededMediaBuyDelivery[]> | SeededMediaBuyDelivery[];

  /**
   * Retrieve seeded accounts for the current request. Returned entries are
   * appended to the handler's `list_accounts` response (`accounts` array);
   * on `account_id` collision the seeded entry wins. Same sandbox gating
   * contract as {@link TestControllerBridge.getSeededProducts}.
   */
  getSeededAccounts?: (ctx: TestControllerBridgeContext<TAccount>) => Promise<Account[]> | Account[];

  /**
   * Retrieve seeded account-financials records. Unlike the other seeded
   * collections, `get_account_financials` returns a singleton response —
   * one account, one envelope. The bridge callback returns an array of
   * seeded records keyed by `account.account_id`; the framework picks the
   * entry whose `account_id` matches the resolved request account and
   * replaces the handler response's financials payload with that fixture.
   * Framework-managed `context` and `ext` from the handler response are
   * PRESERVED across the replace — the seeded fixture is authoritative on
   * the financials body (spend / period / account / currency / ...) but not
   * on the response envelope (the fixture can't know the current request's
   * `request_id` / `adcp_version` echo).
   *
   * When no seeded entry matches, the handler response passes through
   * unchanged. Duplicate seeded entries with the same `account.account_id`
   * are warn-and-dropped during validation (first occurrence wins).
   *
   * Same sandbox gating contract as {@link TestControllerBridge.getSeededProducts}.
   */
  getSeededAccountFinancials?: (
    ctx: TestControllerBridgeContext<TAccount>
  ) => Promise<SeededAccountFinancials[]> | SeededAccountFinancials[];

  /**
   * Retrieve seeded creative formats. Returned entries are appended to the
   * handler's `list_creative_formats` response (`formats` array); on
   * collision (matched by canonical `format_id.agent_url` + `format_id.id`)
   * the seeded entry wins. Same sandbox gating contract as
   * {@link TestControllerBridge.getSeededProducts}.
   *
   * Composes with `SalesPlatform.listCreativeFormats` /
   * `CreativeBuilderPlatform.listCreativeFormats` — the adapter handler
   * runs first, then this bridge supplements. Not a replacement for those
   * handler-side hooks; storyboards use this seam to inject test-only
   * formats without rewriting the adapter.
   */
  getSeededCreativeFormats?: (ctx: TestControllerBridgeContext<TAccount>) => Promise<Format[]> | Format[];

  /**
   * Retrieve seeded property lists. The same callback feeds both
   * `list_property_lists` (append-merge into `lists: PropertyList[]`, dedup
   * by `list_id` with seeded winning on collision) and `get_property_list`
   * (singleton — pick the entry whose `list_id` matches the request's
   * `list_id` and REPLACE the handler response's `list` field; the handler's
   * auxiliary fields — `identifiers`, `pagination`, `resolved_at`,
   * `cache_valid_until`, `coverage_gaps`, `context`, `ext` — pass through
   * verbatim because they depend on request-time pagination / resolve
   * params that a static fixture can't know).
   *
   * Unblocks the `property-lists` and `governance-aware-seller` storyboards
   * (property catalog seeding) on platform-proxy sellers whose state of
   * record is upstream. Same sandbox gating contract as
   * {@link TestControllerBridge.getSeededProducts}.
   */
  getSeededPropertyLists?: (ctx: TestControllerBridgeContext<TAccount>) => Promise<PropertyList[]> | PropertyList[];

  /**
   * Retrieve seeded content-standards configurations. The same callback feeds
   * both `list_content_standards` (success arm `standards: ContentStandards[]`,
   * append-merge with seeded winning on `standards_id` collision) and
   * `get_content_standards` (singleton — pick by `standards_id` and replace
   * the `ContentStandards` body). Seeded fixture is authoritative on the
   * `ContentStandards` body. Framework-managed envelope fields (`context`,
   * `ext`) round-trip from the handler — matches the precedent set by
   * {@link replaceAccountFinancialsIfSeeded}.
   *
   * Unblocks the `content-standards` storyboard. Same sandbox gating contract
   * as {@link TestControllerBridge.getSeededProducts}.
   */
  getSeededContentStandards?: (
    ctx: TestControllerBridgeContext<TAccount>
  ) => Promise<ContentStandards[]> | ContentStandards[];

  /**
   * Retrieve seeded collection lists. The same callback feeds both
   * `list_collection_lists` (append-merge into `lists: CollectionList[]`,
   * dedup by `list_id` with seeded winning on collision) and
   * `get_collection_list` (singleton — pick by `list_id` and replace the
   * `list` field; the handler's `collections`, `pagination`, `resolved_at`,
   * `cache_valid_until`, `coverage_gaps`, `context`, `ext` pass through
   * verbatim).
   *
   * Unblocks the `collection-lists` storyboard (program-level brand safety
   * via IMDb/Gracenote/EIDR IDs). Same sandbox gating contract as
   * {@link TestControllerBridge.getSeededProducts}.
   */
  getSeededCollectionLists?: (
    ctx: TestControllerBridgeContext<TAccount>
  ) => Promise<CollectionList[]> | CollectionList[];

  /**
   * Retrieve seeded signals for the current request. Returned entries are
   * appended to the handler's `get_signals` response (`signals` array); on
   * `signal_id` collision the seeded entry wins. The signal_id-keyed dedup
   * works uniformly across `signal-marketplace` and `signal-owned`
   * specialisms — both use the same response envelope; the discriminator
   * lives on each entry's `signal_type` field.
   *
   * `get_signals` does not carry a `query_summary` block (per AdCP 3.0.11).
   * Pagination is not recomputed on the merge. `PaginationResponse.total_count`
   * is optional; recomputing it on partial pages would mis-represent the
   * cross-page total (the handler may have served page 1 of N, and the seeded
   * fixture sits outside that pagination context). Storyboards asserting on
   * totals should seed the handler's response, not the post-merge envelope.
   * Same sandbox gating contract as
   * {@link TestControllerBridge.getSeededProducts}.
   */
  getSeededSignals?: (ctx: TestControllerBridgeContext<TAccount>) => Promise<SeededSignal[]> | SeededSignal[];

  /**
   * Retrieve seeded creative-delivery entries for `get_creative_delivery`.
   * Returned entries are appended to the handler response's `creatives` array;
   * on `creative_id` collision the seeded entry wins (storyboards seed
   * deliberately — a seeded fixture for an existing creative_id is an explicit
   * author override, matching the precedent set by other list-shaped bridges).
   *
   * After the merge, `pagination.total` (when set by the handler) is updated
   * by the count of new non-colliding seeded entries. `get_creative_delivery`
   * does not carry a `query_summary` block, and there is no top-level
   * aggregated-totals envelope (unlike `get_media_buy_delivery`), so no other
   * recomputation is performed.
   *
   * Unblocks the `creative-template` / `creative-generative` /
   * `creative-ad-server` delivery-readback storyboards. Same sandbox gating
   * contract as {@link TestControllerBridge.getSeededProducts}.
   */
  getSeededCreativeDelivery?: (
    ctx: TestControllerBridgeContext<TAccount>
  ) => Promise<SeededCreativeDelivery[]> | SeededCreativeDelivery[];

  /**
   * Retrieve seeded creative-feature results for `get_creative_features`.
   * `get_creative_features` returns a `oneOf` envelope — the success arm
   * carries `results: CreativeFeatureResult[]` (one entry per evaluated
   * feature). The bridge seeds at the per-feature granularity: returned
   * entries are merged into the success arm's `results` array, dedup by
   * `feature_id`, seeded wins on collision. Adopters can override specific
   * feature scores (e.g., brand-safety policy outcomes) without rewriting
   * the entire evaluation handler.
   *
   * When the handler returned the error arm (`errors[]`), the bridge is a
   * no-op — error envelopes pass through unchanged. When the handler
   * returned the success arm, framework-managed `context` / `ext` round-trip
   * from the handler verbatim. Same sandbox gating contract as
   * {@link TestControllerBridge.getSeededProducts}.
   */
  getSeededCreativeFeatures?: (
    ctx: TestControllerBridgeContext<TAccount>
  ) => Promise<SeededCreativeFeature[]> | SeededCreativeFeature[];
}

/**
 * Sandbox-request predicate. Reads the spec's two canonical sandbox markers:
 *
 *   1. `account.sandbox === true` on the request (per AccountReference
 *      discriminator — the brand+operator variant carries the flag).
 *   2. `context.sandbox === true` — storyboards that don't scope through an
 *      account still flag the envelope so the server can tell them apart.
 *
 * Either match is sufficient. Anything else returns `false` and the seeded
 * fixtures stay hidden. Keep this conservative — a `true` result opts the
 * request into test-only code paths, so a permissive predicate leaks
 * fixture data into production.
 */
export function isSandboxRequest(input: Record<string, unknown>): boolean {
  const account = input.account;
  if (account && typeof account === 'object' && (account as { sandbox?: unknown }).sandbox === true) {
    return true;
  }
  const context = input.context;
  if (context && typeof context === 'object' && (context as { sandbox?: unknown }).sandbox === true) {
    return true;
  }
  return false;
}

/**
 * Merge seeded products into a `get_products` response payload.
 *
 * Existing products from the handler come first; seeded entries append
 * after deduping by `product_id`. On collision, the seeded entry wins so
 * storyboards that seed to override default inventory see the fixture.
 *
 * Returns a NEW response object — the original is not mutated. The
 * `sandbox: true` flag is stamped on the merged response unless the
 * handler explicitly declared `sandbox: false` (which stays authoritative
 * — a handler that has already decided the request is non-sandbox
 * shouldn't be overridden by the bridge).
 */
export function mergeSeededProductsIntoResponse(
  response: GetProductsResponse,
  seeded: readonly Product[]
): GetProductsResponse {
  if (!seeded.length) return response;

  const seededIds = new Set<string>();
  for (const p of seeded) seededIds.add(p.product_id);

  const handlerProducts = Array.isArray(response.products) ? response.products : [];
  // Keep handler-returned products except those a seeded entry overrides.
  // A null/undefined product_id on the handler side would be a spec
  // violation; filtering on `!seededIds.has(id)` preserves it rather than
  // silently dropping so downstream response validation still catches it.
  const retained = handlerProducts.filter(p => !seededIds.has(p?.product_id));

  const merged: GetProductsResponse = {
    ...response,
    products: [...retained, ...seeded],
  };
  if (response.sandbox !== false) {
    merged.sandbox = true;
  }
  return merged;
}

/**
 * Validate and normalize a list of seeded products returned from a
 * {@link TestControllerBridge.getSeededProducts} callback. Invalid entries
 * are dropped with a warning rather than thrown — a broken test fixture
 * shouldn't tank the request under test. Valid entries pass through as-is.
 *
 * An entry is considered valid when it's a plain object with a string
 * `product_id`. Entries missing `product_id` would collide on
 * `undefined === undefined` when deduping, so we drop them early.
 */
export function filterValidSeededProducts(
  raw: unknown,
  logger?: { warn: (message: string, meta?: Record<string, unknown>) => void }
): Product[] {
  if (!Array.isArray(raw)) {
    logger?.warn('testController.getSeededProducts did not return an array; skipping bridge', {
      received: typeof raw,
    });
    return [];
  }

  const valid: Product[] = [];
  raw.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      logger?.warn('testController.getSeededProducts entry is not an object; dropping', { index });
      return;
    }
    const productId = (entry as { product_id?: unknown }).product_id;
    if (typeof productId !== 'string' || productId.length === 0) {
      logger?.warn('testController.getSeededProducts entry missing product_id; dropping', { index });
      return;
    }
    valid.push(entry as Product);
  });
  return valid;
}

// ---------------------------------------------------------------------------
// Per-tool validation + merge helpers
//
// Each helper pair (`filterValidSeededXxx` + `mergeSeededXxxIntoResponse`)
// mirrors the `filterValidSeededProducts` + `mergeSeededProductsIntoResponse`
// shape. The semantics are identical: validate-and-drop on the input side,
// dedupe-and-stamp-sandbox on the merge side. Symmetry is the point — adopters
// who understand the products seam should be able to read the others at a
// glance.
// ---------------------------------------------------------------------------

/**
 * Validate seeded creatives. Drops entries that are not plain objects or are
 * missing a non-empty string `creative_id` — matches the products contract
 * (a missing identifier collides on `undefined === undefined` when deduping).
 */
export function filterValidSeededCreatives(
  raw: unknown,
  logger?: { warn: (message: string, meta?: Record<string, unknown>) => void }
): SeededCreative[] {
  return filterValidById<SeededCreative>(raw, 'creative_id', 'getSeededCreatives', logger);
}

/**
 * Validate seeded media buys. Drops entries missing a non-empty string
 * `media_buy_id`.
 */
export function filterValidSeededMediaBuys(
  raw: unknown,
  logger?: { warn: (message: string, meta?: Record<string, unknown>) => void }
): SeededMediaBuy[] {
  return filterValidById<SeededMediaBuy>(raw, 'media_buy_id', 'getSeededMediaBuys', logger);
}

/**
 * Validate seeded media-buy-delivery snapshots. Drops entries missing a
 * non-empty string `media_buy_id` — the dedup key against the handler set.
 */
export function filterValidSeededMediaBuyDeliveries(
  raw: unknown,
  logger?: { warn: (message: string, meta?: Record<string, unknown>) => void }
): SeededMediaBuyDelivery[] {
  return filterValidById<SeededMediaBuyDelivery>(raw, 'media_buy_id', 'getSeededMediaBuyDelivery', logger);
}

/**
 * Validate seeded accounts. Drops entries missing a non-empty string `account_id`.
 */
export function filterValidSeededAccounts(
  raw: unknown,
  logger?: { warn: (message: string, meta?: Record<string, unknown>) => void }
): Account[] {
  return filterValidById<Account>(raw, 'account_id', 'getSeededAccounts', logger);
}

/**
 * Validate seeded account-financials records. Drops entries whose `account`
 * field is not a `{ account_id: string }`-shaped object (`AccountReference`
 * carries `account_id` on the operator-resolved variant; the bridge keys on
 * that field to match against the request's account).
 *
 * Also drops duplicate entries by `account.account_id` (first occurrence
 * wins, matching the array-collection helpers' on-collision-seeded-wins
 * contract — the "first" seeded entry in iteration order is authoritative).
 * A fixture array with two entries for the same `account_id` is almost
 * always a seed-store bug; warn-and-drop surfaces it instead of silently
 * picking whichever happened to come first in iteration order.
 */
export function filterValidSeededAccountFinancials(
  raw: unknown,
  logger?: { warn: (message: string, meta?: Record<string, unknown>) => void }
): SeededAccountFinancials[] {
  if (!Array.isArray(raw)) {
    logger?.warn('testController.getSeededAccountFinancials did not return an array; skipping bridge', {
      received: typeof raw,
    });
    return [];
  }
  const valid: SeededAccountFinancials[] = [];
  const seenAccountIds = new Set<string>();
  raw.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      logger?.warn('testController.getSeededAccountFinancials entry is not an object; dropping', { index });
      return;
    }
    const account = (entry as { account?: unknown }).account;
    const accountId =
      account && typeof account === 'object' && !Array.isArray(account)
        ? (account as { account_id?: unknown }).account_id
        : undefined;
    if (typeof accountId !== 'string' || accountId.length === 0) {
      logger?.warn('testController.getSeededAccountFinancials entry missing account.account_id; dropping', { index });
      return;
    }
    if (seenAccountIds.has(accountId)) {
      logger?.warn(
        'testController.getSeededAccountFinancials duplicate account.account_id; dropping (first occurrence wins)',
        { index, account_id: accountId }
      );
      return;
    }
    seenAccountIds.add(accountId);
    valid.push(entry as SeededAccountFinancials);
  });
  return valid;
}

/**
 * Validate seeded creative formats. Drops entries whose `format_id` is not a
 * `{ agent_url: string, id: string }`-shaped object — both fields are
 * required to dedupe (and to canonicalize per the URL canonicalization rules
 * in the AdCP spec).
 */
export function filterValidSeededCreativeFormats(
  raw: unknown,
  logger?: { warn: (message: string, meta?: Record<string, unknown>) => void }
): Format[] {
  if (!Array.isArray(raw)) {
    logger?.warn('testController.getSeededCreativeFormats did not return an array; skipping bridge', {
      received: typeof raw,
    });
    return [];
  }
  const valid: Format[] = [];
  raw.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      logger?.warn('testController.getSeededCreativeFormats entry is not an object; dropping', { index });
      return;
    }
    const formatId = (entry as { format_id?: unknown }).format_id;
    if (!formatId || typeof formatId !== 'object' || Array.isArray(formatId)) {
      logger?.warn('testController.getSeededCreativeFormats entry missing format_id; dropping', { index });
      return;
    }
    const agentUrl = (formatId as { agent_url?: unknown }).agent_url;
    const id = (formatId as { id?: unknown }).id;
    if (typeof agentUrl !== 'string' || agentUrl.length === 0 || typeof id !== 'string' || id.length === 0) {
      logger?.warn(
        'testController.getSeededCreativeFormats entry has incomplete format_id (agent_url and id required); dropping',
        { index }
      );
      return;
    }
    valid.push(entry as Format);
  });
  return valid;
}

/**
 * Shared by-`id` validator for collections whose entries dedupe on a single
 * top-level string field (creatives → `creative_id`, media buys →
 * `media_buy_id`, accounts → `account_id`). Mirrors
 * {@link filterValidSeededProducts} exactly; factored only because the three
 * shapes share the same single-string-key contract.
 */
function filterValidById<T>(
  raw: unknown,
  idField: string,
  callbackName: string,
  logger?: { warn: (message: string, meta?: Record<string, unknown>) => void }
): T[] {
  if (!Array.isArray(raw)) {
    logger?.warn(`testController.${callbackName} did not return an array; skipping bridge`, {
      received: typeof raw,
    });
    return [];
  }
  const valid: T[] = [];
  raw.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      logger?.warn(`testController.${callbackName} entry is not an object; dropping`, { index });
      return;
    }
    const id = (entry as Record<string, unknown>)[idField];
    if (typeof id !== 'string' || id.length === 0) {
      logger?.warn(`testController.${callbackName} entry missing ${idField}; dropping`, { index });
      return;
    }
    valid.push(entry as T);
  });
  return valid;
}

/**
 * Merge seeded creatives into a `list_creatives` response. Existing creatives
 * come first; seeded entries append after deduping by `creative_id`. On
 * collision the seeded entry wins. Stamps `sandbox: true` unless the handler
 * explicitly declared `sandbox: false`. Returns a NEW response object.
 *
 * Also updates `query_summary.returned` to match the final array length and
 * `query_summary.total_matching` to `handler.total_matching + (seeded entries
 * that did NOT collide with the handler set)`. Storyboards that assert on
 * counts see the merged totals, not the handler's pre-merge counts. Mirror
 * field on `pagination.total_count` is updated by the same delta when the
 * handler set it.
 */
export function mergeSeededCreativesIntoResponse(
  response: ListCreativesResponse,
  seeded: readonly SeededCreative[]
): ListCreativesResponse {
  if (!seeded.length) return response;
  const seededIds = new Set<string>();
  for (const c of seeded) seededIds.add(c.creative_id);
  const existing = Array.isArray(response.creatives) ? response.creatives : [];
  const existingIds = new Set<string>();
  for (const c of existing) {
    if (c && typeof c.creative_id === 'string') existingIds.add(c.creative_id);
  }
  const retained = existing.filter(c => !seededIds.has(c?.creative_id));
  const finalCreatives = [...retained, ...seeded];
  // New entries = seeded that did NOT collide with the handler's set. Collisions
  // replace in-place; the merged total_matching shouldn't grow on those.
  let newCount = 0;
  for (const c of seeded) if (!existingIds.has(c.creative_id)) newCount += 1;
  const merged: ListCreativesResponse = {
    ...response,
    creatives: finalCreatives,
  };
  if ((response as { sandbox?: unknown }).sandbox !== false) {
    (merged as { sandbox?: boolean }).sandbox = true;
  }
  // query_summary is required on list_creatives per AdCP 3.0.11. Update the
  // counts if the handler provided them; leave the rest of the block
  // (filters_applied, etc.) untouched.
  const qs = (response as { query_summary?: { total_matching?: unknown; returned?: unknown } }).query_summary;
  if (qs && typeof qs === 'object') {
    const baseTotal = typeof qs.total_matching === 'number' ? qs.total_matching : existing.length;
    (merged as { query_summary?: unknown }).query_summary = {
      ...qs,
      total_matching: baseTotal + newCount,
      returned: finalCreatives.length,
    };
  }
  // pagination.total_count is optional; only update when the handler provided it.
  const pagination = (response as { pagination?: { total_count?: unknown } }).pagination;
  if (pagination && typeof pagination === 'object' && typeof pagination.total_count === 'number') {
    (merged as { pagination?: unknown }).pagination = {
      ...pagination,
      total_count: pagination.total_count + newCount,
    };
  }
  return merged;
}

/**
 * Merge seeded media buys into a `get_media_buys` response. Existing media
 * buys come first; seeded entries append after deduping by `media_buy_id`.
 * On collision the seeded entry wins. Returns a NEW response object.
 *
 * `get_media_buys` does NOT carry a `query_summary` block (per AdCP 3.0.11);
 * it exposes its count via `pagination.total_count` (optional). When the
 * handler set `pagination.total_count`, it's incremented by the count of
 * new (non-colliding) seeded entries so the merged response stays
 * internally consistent. Handlers that left `total_count` off pass through
 * unchanged.
 */
export function mergeSeededMediaBuysIntoResponse(
  response: GetMediaBuysResponse,
  seeded: readonly SeededMediaBuy[]
): GetMediaBuysResponse {
  if (!seeded.length) return response;
  const seededIds = new Set<string>();
  for (const mb of seeded) seededIds.add(mb.media_buy_id);
  const existing = Array.isArray(response.media_buys) ? response.media_buys : [];
  const existingIds = new Set<string>();
  for (const mb of existing) {
    if (mb && typeof mb.media_buy_id === 'string') existingIds.add(mb.media_buy_id);
  }
  const retained = existing.filter(mb => !seededIds.has(mb?.media_buy_id));
  let newCount = 0;
  for (const mb of seeded) if (!existingIds.has(mb.media_buy_id)) newCount += 1;
  const merged: GetMediaBuysResponse = {
    ...response,
    media_buys: [...retained, ...seeded],
  };
  if ((response as { sandbox?: unknown }).sandbox !== false) {
    (merged as { sandbox?: boolean }).sandbox = true;
  }
  const pagination = (response as { pagination?: { total_count?: unknown } }).pagination;
  if (pagination && typeof pagination === 'object' && typeof pagination.total_count === 'number') {
    (merged as { pagination?: unknown }).pagination = {
      ...pagination,
      total_count: pagination.total_count + newCount,
    };
  }
  return merged;
}

/**
 * Recompute `aggregated_totals` from a merged `media_buy_deliveries` array.
 *
 * The wire schema makes `aggregated_totals.impressions` / `spend` /
 * `media_buy_count` REQUIRED, so once the bridge changes the delivery list it
 * MUST rewrite the totals — otherwise `media_buy_count` is stale and the
 * impressions/spend sums no longer reflect the merged set.
 *
 * Policy (see VALIDATE-YOUR-AGENT.md "Platform-proxy sellers"):
 *   - Sum-derived (required): `impressions`, `spend`, `media_buy_count`.
 *   - Sum-derived (optional): `clicks`, `completed_views`, `views`,
 *     `conversions`, `conversion_value` — recomputed ONLY when EVERY merged
 *     delivery populates the field on its `totals`. Otherwise fall back to
 *     the handler's value (or omit if the handler omitted).
 *   - Derived ratios: `roas` (`conversion_value / spend`),
 *     `completion_rate` (`completed_views / impressions`),
 *     `cost_per_acquisition` (`spend / conversions`). Recomputed ONLY when
 *     both input fields recomputed AND the divisor is non-zero. Otherwise
 *     fall back to the handler's value (or omit).
 *   - Pass-through (not derivable from per-delivery `totals`): `reach`,
 *     `reach_unit`, `frequency`, `new_to_brand_rate`. The handler's values
 *     survive verbatim.
 *
 * Empty merged array → `{ impressions: 0, spend: 0, media_buy_count: 0 }` +
 * any pass-through the handler set. Divide-by-zero guards keep ratios omitted
 * rather than producing `Infinity` / `NaN` values that would fail validation.
 *
 * Pure helper — testable in isolation, no I/O.
 */
export function recomputeAggregatedTotals(
  deliveries: readonly SeededMediaBuyDelivery[],
  handlerAggregated: AggregatedTotals | undefined
): AggregatedTotals {
  const totalsList = deliveries.map(d => d.totals);

  const sumNumber = (key: keyof AggregatedTotals): number => {
    let acc = 0;
    for (const t of totalsList) {
      const v = (t as Record<string, unknown>)[key as string];
      if (typeof v === 'number') acc += v;
    }
    return acc;
  };

  const everyHasNumber = (key: string): boolean => {
    if (totalsList.length === 0) return false;
    for (const t of totalsList) {
      const v = (t as Record<string, unknown>)[key];
      if (typeof v !== 'number') return false;
    }
    return true;
  };

  // Required sums: per spec, these fields are REQUIRED on aggregated_totals
  // when the block exists. Empty merged set → zeros (still wire-correct).
  const recomputed: AggregatedTotals = {
    impressions: everyHasNumber('impressions') ? sumNumber('impressions' as keyof AggregatedTotals) : 0,
    spend: everyHasNumber('spend') ? sumNumber('spend' as keyof AggregatedTotals) : 0,
    media_buy_count: deliveries.length,
  };

  // Optional sums — only recompute when every delivery populates the field.
  // Otherwise fall back to the handler's value to avoid wire-incorrect
  // partial sums.
  const recomputedFields = new Set<string>();
  const optionalSumFields = ['clicks', 'completed_views', 'views', 'conversions', 'conversion_value'] as const;
  for (const field of optionalSumFields) {
    if (everyHasNumber(field)) {
      (recomputed as Record<string, unknown>)[field] = sumNumber(field as keyof AggregatedTotals);
      recomputedFields.add(field);
    } else {
      const handlerValue = handlerAggregated ? (handlerAggregated as Record<string, unknown>)[field] : undefined;
      if (handlerValue !== undefined) (recomputed as Record<string, unknown>)[field] = handlerValue;
    }
  }

  // Also track recomputed status for the required sum fields — needed for the
  // derived-ratio guards below. `impressions` / `spend` are recomputed when
  // every delivery populates them; empty merged set counts as "recomputed to 0".
  if (everyHasNumber('impressions') || deliveries.length === 0) recomputedFields.add('impressions');
  if (everyHasNumber('spend') || deliveries.length === 0) recomputedFields.add('spend');

  // Derived ratios — only recompute when BOTH inputs were recomputed AND the
  // divisor is non-zero. Otherwise fall back to the handler's value (or omit).
  const tryRatio = (
    outKey: 'roas' | 'completion_rate' | 'cost_per_acquisition',
    numerator: 'conversion_value' | 'completed_views' | 'spend',
    denominator: 'spend' | 'impressions' | 'conversions'
  ): void => {
    if (recomputedFields.has(numerator) && recomputedFields.has(denominator)) {
      const denom = (recomputed as Record<string, unknown>)[denominator];
      const num = (recomputed as Record<string, unknown>)[numerator];
      if (typeof denom === 'number' && denom > 0 && typeof num === 'number') {
        (recomputed as Record<string, unknown>)[outKey] = num / denom;
        return;
      }
      // Divide-by-zero — omit the ratio (don't fall back; the recomputed
      // inputs say the ratio is undefined for this set).
      return;
    }
    const handlerValue = handlerAggregated ? (handlerAggregated as Record<string, unknown>)[outKey] : undefined;
    if (handlerValue !== undefined) (recomputed as Record<string, unknown>)[outKey] = handlerValue;
  };

  tryRatio('roas', 'conversion_value', 'spend');
  tryRatio('completion_rate', 'completed_views', 'impressions');
  tryRatio('cost_per_acquisition', 'spend', 'conversions');

  // Pass-through fields — not derivable from per-delivery `totals` (reach
  // needs de-dup info we don't have; frequency depends on reach; NTB rate
  // needs an NTB conversion count that isn't carried on per-delivery totals).
  // Preserve handler's values verbatim.
  const passThroughFields = ['reach', 'reach_unit', 'frequency', 'new_to_brand_rate'] as const;
  for (const field of passThroughFields) {
    const handlerValue = handlerAggregated ? (handlerAggregated as Record<string, unknown>)[field] : undefined;
    if (handlerValue !== undefined) (recomputed as Record<string, unknown>)[field] = handlerValue;
  }

  return recomputed;
}

/**
 * Merge seeded media-buy-delivery entries into a `get_media_buy_delivery`
 * response. Existing handler entries come first; seeded entries append after
 * deduping by `media_buy_id`. On collision the SEEDED entry wins, matching the
 * precedent set by `mergeSeededMediaBuys` / `mergeSeededCreatives` /
 * `mergeSeededAccounts` — storyboards seed deliberately, so a seeded fixture
 * for an existing `media_buy_id` is an explicit author override.
 *
 * After merging, `aggregated_totals` is recomputed via
 * {@link recomputeAggregatedTotals} so `media_buy_count` / `impressions` /
 * `spend` reflect the merged set instead of the handler's pre-merge values.
 *
 * Returns a NEW response object — the handler's singleton envelope fields
 * (`reporting_period`, `currency`, `attribution_window`, `errors`, `sandbox`,
 * `context`, `ext`, plus webhook-only `notification_type` / `partial_data` /
 * `sequence_number` / etc.) pass through verbatim. Stamps `sandbox: true`
 * unless the handler explicitly declared `sandbox: false`.
 */
export function mergeSeededMediaBuyDeliveryIntoResponse(
  response: GetMediaBuyDeliveryResponse,
  seeded: readonly SeededMediaBuyDelivery[]
): GetMediaBuyDeliveryResponse {
  if (!seeded.length) return response;

  const handlerDeliveries = Array.isArray(response.media_buy_deliveries) ? response.media_buy_deliveries : [];
  const seededIds = new Set<string>();
  for (const d of seeded) seededIds.add(d.media_buy_id);
  // Seeded wins on collision: drop handler entries whose `media_buy_id` is in
  // the seeded set, then append seeded entries. Order mirrors
  // `mergeSeededMediaBuysIntoResponse` — retained handler entries first,
  // seeded entries (including overrides) last.
  const retained = handlerDeliveries.filter(d => !seededIds.has(d?.media_buy_id));
  const final = [...retained, ...seeded];

  const merged: GetMediaBuyDeliveryResponse = {
    ...response,
    media_buy_deliveries: final,
    aggregated_totals: recomputeAggregatedTotals(final, response.aggregated_totals),
  };
  if ((response as { sandbox?: unknown }).sandbox !== false) {
    (merged as { sandbox?: boolean }).sandbox = true;
  }
  return merged;
}

/**
 * Merge seeded accounts into a `list_accounts` response. Existing accounts
 * come first; seeded entries append after deduping by `account_id`. On
 * collision the seeded entry wins. Returns a NEW response object.
 *
 * `list_accounts` exposes its count via `pagination.total_count` (optional,
 * same as `get_media_buys`). When the handler set it, it's incremented by
 * the count of new (non-colliding) seeded entries.
 */
export function mergeSeededAccountsIntoResponse(
  response: ListAccountsResponse,
  seeded: readonly Account[]
): ListAccountsResponse {
  if (!seeded.length) return response;
  const seededIds = new Set<string>();
  for (const a of seeded) seededIds.add(a.account_id);
  const existing = Array.isArray(response.accounts) ? response.accounts : [];
  const existingIds = new Set<string>();
  for (const a of existing) {
    if (a && typeof a.account_id === 'string') existingIds.add(a.account_id);
  }
  const retained = existing.filter(a => !seededIds.has(a?.account_id));
  let newCount = 0;
  for (const a of seeded) if (!existingIds.has(a.account_id)) newCount += 1;
  const merged: ListAccountsResponse = {
    ...response,
    accounts: [...retained, ...seeded],
  };
  if ((response as { sandbox?: unknown }).sandbox !== false) {
    (merged as { sandbox?: boolean }).sandbox = true;
  }
  const pagination = (response as { pagination?: { total_count?: unknown } }).pagination;
  if (pagination && typeof pagination === 'object' && typeof pagination.total_count === 'number') {
    (merged as { pagination?: unknown }).pagination = {
      ...pagination,
      total_count: pagination.total_count + newCount,
    };
  }
  return merged;
}

/**
 * Extract `account_id` from a `get_account_financials` request's `account`
 * reference. `AccountReference` is a discriminated union — the
 * operator-resolved variant carries `account_id` directly, brand+operator
 * variants do not. Returns `undefined` for variants that don't carry an
 * `account_id` (those requests can't match a seeded fixture by id and pass
 * through to the handler).
 */
function readRequestAccountId(req: Record<string, unknown> | undefined): string | undefined {
  const account = req?.account;
  if (!account || typeof account !== 'object' || Array.isArray(account)) return undefined;
  const id = (account as { account_id?: unknown }).account_id;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

/**
 * Pick a seeded `get_account_financials` fixture matching the request's
 * account. Unlike the array-collection helpers, this returns the SINGLE
 * matched envelope or `undefined` — `get_account_financials` is a singleton
 * response and "merge" reduces to "replace if the request's account matches
 * a seeded fixture".
 *
 * Matching honors both the raw request and the resolved account from
 * `resolveAccount`. `AccountReference` is a discriminated union — the
 * operator-resolved variant carries `account_id` on the request, but the
 * brand+operator variants do not. When the framework has already resolved
 * the request to an account, prefer that resolved id so seeded fixtures
 * find their match regardless of which `AccountReference` variant the
 * buyer sent.
 *
 * @param resolvedAccountId - The `account_id` from `ctx.account` after
 *   `resolveAccount` ran. Pass `undefined` when no account was resolved
 *   (singleton-tenant adopters) — the function falls back to the request's
 *   `account.account_id` field, which preserves the original semantics for
 *   adopters who don't wire `resolveAccount`.
 */
export function pickSeededAccountFinancialsForRequest(
  request: GetAccountFinancialsRequest | Record<string, unknown>,
  seeded: readonly SeededAccountFinancials[],
  resolvedAccountId?: string
): SeededAccountFinancials | undefined {
  if (!seeded.length) return undefined;
  const requestedId = resolvedAccountId ?? readRequestAccountId(request as Record<string, unknown>);
  if (requestedId == null) return undefined;
  for (const entry of seeded) {
    const id = (entry.account as { account_id?: unknown } | undefined)?.account_id;
    if (typeof id === 'string' && id === requestedId) return entry;
  }
  return undefined;
}

/**
 * Replace a `get_account_financials` response when a seeded fixture matches
 * the request's account. The seeded fixture is authoritative on the
 * financials payload (spend, period, account, currency, ...). The handler's
 * `context` and `ext` are framework-managed (`context` echoes
 * `adcp_version` / `request_id`; `ext` carries adopter passthrough) and
 * MUST be preserved across the replace — wire-correct context echo is the
 * framework's responsibility, not the seed fixture's.
 *
 * When no fixture matches, returns the handler response unchanged.
 *
 * @param resolvedAccountId - Optional resolved `account_id` from
 *   `ctx.account`; passed through to {@link pickSeededAccountFinancialsForRequest}.
 */
export function replaceAccountFinancialsIfSeeded(
  request: GetAccountFinancialsRequest | Record<string, unknown>,
  response: GetAccountFinancialsResponse,
  seeded: readonly SeededAccountFinancials[],
  resolvedAccountId?: string
): GetAccountFinancialsResponse {
  const picked = pickSeededAccountFinancialsForRequest(request, seeded, resolvedAccountId);
  if (!picked) return response;
  // Preserve framework-managed envelope fields from the handler response;
  // seeded fixture owns the financials body. Pull `context` / `ext` off the
  // handler response (when present) and re-stamp them on top of the seeded
  // payload — the fixture's own `context` / `ext` (if any) lose to the
  // handler's, which is correct: a seeded snapshot can't know the current
  // request's `request_id` / `adcp_version` echo.
  const handlerContext = (response as { context?: unknown }).context;
  const handlerExt = (response as { ext?: unknown }).ext;
  const merged: GetAccountFinancialsResponse = { ...picked };
  if (handlerContext !== undefined) (merged as { context?: unknown }).context = handlerContext;
  if (handlerExt !== undefined) (merged as { ext?: unknown }).ext = handlerExt;
  return merged;
}

/**
 * Canonical dedup key for a `Format` — `${agent_url}|${id}`. Matches the AdCP
 * format-id contract: two formats from the same agent with the same id are
 * the same format, regardless of parameterized dimension / duration. Fixtures
 * that seed multiple parameterized variants of the same template should use
 * distinct `id` values per variant.
 */
function formatDedupKey(f: Format): string | undefined {
  const fid = f.format_id;
  if (!fid || typeof fid !== 'object') return undefined;
  const agentUrl = (fid as { agent_url?: unknown }).agent_url;
  const id = (fid as { id?: unknown }).id;
  if (typeof agentUrl !== 'string' || typeof id !== 'string') return undefined;
  return `${agentUrl}|${id}`;
}

/**
 * Merge seeded creative formats into a `list_creative_formats` response.
 * Existing formats come first; seeded entries append after deduping by
 * canonical `${agent_url}|${id}`. On collision the seeded entry wins.
 * Returns a NEW response object.
 */
export function mergeSeededCreativeFormatsIntoResponse(
  response: ListCreativeFormatsResponse,
  seeded: readonly Format[]
): ListCreativeFormatsResponse {
  if (!seeded.length) return response;
  const seededKeys = new Set<string>();
  for (const f of seeded) {
    const key = formatDedupKey(f);
    if (key != null) seededKeys.add(key);
  }
  const existing = Array.isArray(response.formats) ? response.formats : [];
  const retained = existing.filter(f => {
    const key = formatDedupKey(f);
    return key == null || !seededKeys.has(key);
  });
  const merged: ListCreativeFormatsResponse = {
    ...response,
    formats: [...retained, ...seeded],
  };
  if (response.sandbox !== false) {
    merged.sandbox = true;
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Property lists / collection lists / content standards
//
// Each entity has a "list" tool (returns `T[]` under a top-level key) AND a
// "get" tool (returns a singleton). The same seeded fixture array feeds both
// tools — the list tool merges with seeded-wins on collision; the get tool
// picks by id and replaces. PropertyList and CollectionList wrap the picked
// entity into the response's `list` field; ContentStandards' success arm IS
// the entity directly.
//
// All three follow the same dedup contract:
//   PropertyList     → top-level `list_id` (string, required)
//   CollectionList   → top-level `list_id` (string, required)
//   ContentStandards → top-level `standards_id` (string, required)
// ---------------------------------------------------------------------------

/**
 * Validate seeded property-list entries. Drops entries missing a non-empty
 * string `list_id`.
 */
export function filterValidSeededPropertyLists(
  raw: unknown,
  logger?: { warn: (message: string, meta?: Record<string, unknown>) => void }
): PropertyList[] {
  return filterValidById<PropertyList>(raw, 'list_id', 'getSeededPropertyLists', logger);
}

/**
 * Validate seeded collection-list entries. Drops entries missing a non-empty
 * string `list_id`.
 */
export function filterValidSeededCollectionLists(
  raw: unknown,
  logger?: { warn: (message: string, meta?: Record<string, unknown>) => void }
): CollectionList[] {
  return filterValidById<CollectionList>(raw, 'list_id', 'getSeededCollectionLists', logger);
}

/**
 * Validate seeded content-standards entries. Drops entries missing a
 * non-empty string `standards_id`.
 */
export function filterValidSeededContentStandards(
  raw: unknown,
  logger?: { warn: (message: string, meta?: Record<string, unknown>) => void }
): ContentStandards[] {
  return filterValidById<ContentStandards>(raw, 'standards_id', 'getSeededContentStandards', logger);
}

/**
 * Merge seeded property lists into a `list_property_lists` response.
 * Existing entries come first; seeded entries append after deduping by
 * `list_id`. On collision the seeded entry wins. Returns a NEW response
 * object. When the handler set `pagination.total_count`, it's incremented
 * by the count of new (non-colliding) seeded entries.
 *
 * `list_property_lists` does not carry a `query_summary` block (per AdCP
 * 3.0.11) — pagination.total_count is the only count field to update.
 */
export function mergeSeededPropertyListsIntoResponse(
  response: ListPropertyListsResponse,
  seeded: readonly PropertyList[]
): ListPropertyListsResponse {
  if (!seeded.length) return response;
  const seededIds = new Set<string>();
  for (const l of seeded) seededIds.add(l.list_id);
  const existing = Array.isArray(response.lists) ? response.lists : [];
  const existingIds = new Set<string>();
  for (const l of existing) {
    if (l && typeof l.list_id === 'string') existingIds.add(l.list_id);
  }
  const retained = existing.filter(l => !seededIds.has(l?.list_id));
  let newCount = 0;
  for (const l of seeded) if (!existingIds.has(l.list_id)) newCount += 1;
  const merged: ListPropertyListsResponse = {
    ...response,
    lists: [...retained, ...seeded],
  };
  const pagination = (response as { pagination?: { total_count?: unknown } }).pagination;
  if (pagination && typeof pagination === 'object' && typeof pagination.total_count === 'number') {
    (merged as { pagination?: unknown }).pagination = {
      ...pagination,
      total_count: pagination.total_count + newCount,
    };
  }
  return merged;
}

/**
 * Merge seeded collection lists into a `list_collection_lists` response.
 * Symmetric with {@link mergeSeededPropertyListsIntoResponse} — same dedup
 * key (`list_id`), same pagination update policy.
 */
export function mergeSeededCollectionListsIntoResponse(
  response: ListCollectionListsResponse,
  seeded: readonly CollectionList[]
): ListCollectionListsResponse {
  if (!seeded.length) return response;
  const seededIds = new Set<string>();
  for (const l of seeded) seededIds.add(l.list_id);
  const existing = Array.isArray(response.lists) ? response.lists : [];
  const existingIds = new Set<string>();
  for (const l of existing) {
    if (l && typeof l.list_id === 'string') existingIds.add(l.list_id);
  }
  const retained = existing.filter(l => !seededIds.has(l?.list_id));
  let newCount = 0;
  for (const l of seeded) if (!existingIds.has(l.list_id)) newCount += 1;
  const merged: ListCollectionListsResponse = {
    ...response,
    lists: [...retained, ...seeded],
  };
  const pagination = (response as { pagination?: { total_count?: unknown } }).pagination;
  if (pagination && typeof pagination === 'object' && typeof pagination.total_count === 'number') {
    (merged as { pagination?: unknown }).pagination = {
      ...pagination,
      total_count: pagination.total_count + newCount,
    };
  }
  return merged;
}

/**
 * Merge seeded content-standards into a `list_content_standards` response
 * (success arm). Drops to a no-op if the response is the error arm (no
 * `standards` array). On `standards_id` collision the seeded entry wins.
 * Updates `pagination.total_count` when the handler set it. Returns a NEW
 * response object.
 */
export function mergeSeededContentStandardsIntoResponse(
  response: ListContentStandardsResponse,
  seeded: readonly ContentStandards[]
): ListContentStandardsResponse {
  if (!seeded.length) return response;
  // Skip the error arm — the dispatcher already gates on !isErrorResponse,
  // but the type is a union so we re-narrow defensively.
  const successArm = response as { standards?: ContentStandards[]; pagination?: { total_count?: unknown } };
  if (!Array.isArray(successArm.standards)) return response;
  const seededIds = new Set<string>();
  for (const s of seeded) seededIds.add(s.standards_id);
  const existing = successArm.standards;
  const existingIds = new Set<string>();
  for (const s of existing) {
    if (s && typeof s.standards_id === 'string') existingIds.add(s.standards_id);
  }
  const retained = existing.filter(s => !seededIds.has(s?.standards_id));
  let newCount = 0;
  for (const s of seeded) if (!existingIds.has(s.standards_id)) newCount += 1;
  const merged = {
    ...successArm,
    standards: [...retained, ...seeded],
  } as ListContentStandardsResponse;
  const pagination = successArm.pagination;
  if (pagination && typeof pagination === 'object' && typeof pagination.total_count === 'number') {
    (merged as { pagination?: unknown }).pagination = {
      ...pagination,
      total_count: pagination.total_count + newCount,
    };
  }
  return merged;
}

/**
 * Read the `list_id` from a `get_property_list` request. Required field per
 * spec; this helper is defensive about runtime input.
 */
function readRequestListId(req: Record<string, unknown> | undefined): string | undefined {
  const id = (req as { list_id?: unknown } | undefined)?.list_id;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

/**
 * Read the `standards_id` from a `get_content_standards` request.
 */
function readRequestStandardsId(req: Record<string, unknown> | undefined): string | undefined {
  const id = (req as { standards_id?: unknown } | undefined)?.standards_id;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

/**
 * Pick the seeded property list whose `list_id` matches the request.
 * Returns `undefined` when nothing matches.
 */
export function pickSeededPropertyListForRequest(
  request: GetPropertyListRequest | Record<string, unknown>,
  seeded: readonly PropertyList[]
): PropertyList | undefined {
  if (!seeded.length) return undefined;
  const requestedId = readRequestListId(request as Record<string, unknown>);
  if (requestedId == null) return undefined;
  for (const entry of seeded) {
    if (entry.list_id === requestedId) return entry;
  }
  return undefined;
}

/**
 * Replace a `get_property_list` response's `list` field with a seeded fixture
 * when one matches. The handler's auxiliary fields (`identifiers`,
 * `pagination`, `resolved_at`, `cache_valid_until`, `coverage_gaps`,
 * `context`, `ext`) pass through verbatim — those depend on request-time
 * pagination / resolve params that a static fixture can't know. Only `list`
 * is replaced. When no fixture matches, returns the handler response
 * unchanged.
 */
export function replacePropertyListIfSeeded(
  request: GetPropertyListRequest | Record<string, unknown>,
  response: GetPropertyListResponse,
  seeded: readonly PropertyList[]
): GetPropertyListResponse {
  const picked = pickSeededPropertyListForRequest(request, seeded);
  if (!picked) return response;
  return { ...response, list: picked };
}

/**
 * Pick the seeded collection list whose `list_id` matches the request.
 * Returns `undefined` when nothing matches.
 */
export function pickSeededCollectionListForRequest(
  request: GetCollectionListRequest | Record<string, unknown>,
  seeded: readonly CollectionList[]
): CollectionList | undefined {
  if (!seeded.length) return undefined;
  const requestedId = readRequestListId(request as Record<string, unknown>);
  if (requestedId == null) return undefined;
  for (const entry of seeded) {
    if (entry.list_id === requestedId) return entry;
  }
  return undefined;
}

/**
 * Replace a `get_collection_list` response's `list` field with a seeded
 * fixture when one matches. Same envelope-preservation policy as
 * {@link replacePropertyListIfSeeded}.
 */
export function replaceCollectionListIfSeeded(
  request: GetCollectionListRequest | Record<string, unknown>,
  response: GetCollectionListResponse,
  seeded: readonly CollectionList[]
): GetCollectionListResponse {
  const picked = pickSeededCollectionListForRequest(request, seeded);
  if (!picked) return response;
  return { ...response, list: picked };
}

/**
 * Pick the seeded content-standards entry whose `standards_id` matches the
 * request. Returns `undefined` when nothing matches.
 */
export function pickSeededContentStandardsForRequest(
  request: GetContentStandardsRequest | Record<string, unknown>,
  seeded: readonly ContentStandards[]
): ContentStandards | undefined {
  if (!seeded.length) return undefined;
  const requestedId = readRequestStandardsId(request as Record<string, unknown>);
  if (requestedId == null) return undefined;
  for (const entry of seeded) {
    if (entry.standards_id === requestedId) return entry;
  }
  return undefined;
}

/**
 * Replace a `get_content_standards` response with a seeded fixture when one
 * matches. Seeded fixture is authoritative on the `ContentStandards` body.
 * Framework-managed envelope fields (`context`, `ext`) round-trip from the
 * handler — matches the precedent set by {@link replaceAccountFinancialsIfSeeded}.
 *
 * When no fixture matches, returns the handler response unchanged. The
 * caller is responsible for skipping the error arm (the dispatcher gates on
 * `!isErrorResponse`).
 */
export function replaceContentStandardsIfSeeded(
  request: GetContentStandardsRequest | Record<string, unknown>,
  response: GetContentStandardsResponse,
  seeded: readonly ContentStandards[]
): GetContentStandardsResponse {
  const picked = pickSeededContentStandardsForRequest(request, seeded);
  if (!picked) return response;
  // Both context and ext are framework-managed envelope fields.
  // Seeded fixture is authoritative on the ContentStandards body only.
  const handlerContext = (response as { context?: unknown }).context;
  const handlerExt = (response as { ext?: unknown }).ext;
  const replaced: ContentStandards = { ...picked };
  if (handlerContext !== undefined) (replaced as { context?: unknown }).context = handlerContext;
  if (handlerExt !== undefined) (replaced as { ext?: unknown }).ext = handlerExt;
  return replaced;
}

// ---------------------------------------------------------------------------
// Signals / creative delivery / creative features
//
// `get_signals` (signal-marketplace + signal-owned)   → list-merge by signal_id
// `get_creative_delivery` (creative-* delivery)        → list-merge by creative_id, pagination.total update
// `get_creative_features` (creative-* governance)      → list-merge into success-arm `results` by feature_id
//
// All three follow the validate-and-drop / dedupe-and-stamp-sandbox
// precedent set by the earlier bridges. The features bridge gates on the
// success arm — error envelopes pass through unchanged.
// ---------------------------------------------------------------------------

/**
 * Canonical dedup key for a `SignalID`. `SignalID` is a discriminated union
 * (`{source:'catalog', data_provider_domain, id}` vs `{source:'agent',
 * agent_url, id}`) — two signals with the same `id` from different sources
 * are distinct, so dedup keys on the full source+origin+id tuple.
 */
function signalIdDedupKey(signal: SeededSignal): string | undefined {
  const sid = signal.signal_id as unknown;
  if (!sid || typeof sid !== 'object' || Array.isArray(sid)) return undefined;
  const source = (sid as { source?: unknown }).source;
  const id = (sid as { id?: unknown }).id;
  if (typeof source !== 'string' || typeof id !== 'string' || id.length === 0) return undefined;
  if (source === 'catalog') {
    const origin = (sid as { data_provider_domain?: unknown }).data_provider_domain;
    if (typeof origin !== 'string' || origin.length === 0) return undefined;
    return `catalog|${origin}|${id}`;
  }
  if (source === 'agent') {
    const origin = (sid as { agent_url?: unknown }).agent_url;
    if (typeof origin !== 'string' || origin.length === 0) return undefined;
    return `agent|${origin}|${id}`;
  }
  return undefined;
}

/**
 * Validate seeded signals. Drops entries whose `signal_id` is not a valid
 * `SignalID` discriminated-union shape (`{source:'catalog',
 * data_provider_domain, id}` or `{source:'agent', agent_url, id}`). A missing
 * or malformed `signal_id` collides on `undefined === undefined` when
 * deduping, so we drop early.
 */
export function filterValidSeededSignals(
  raw: unknown,
  logger?: { warn: (message: string, meta?: Record<string, unknown>) => void }
): SeededSignal[] {
  if (!Array.isArray(raw)) {
    logger?.warn('testController.getSeededSignals did not return an array; skipping bridge', {
      received: typeof raw,
    });
    return [];
  }
  const valid: SeededSignal[] = [];
  raw.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      logger?.warn('testController.getSeededSignals entry is not an object; dropping', { index });
      return;
    }
    const key = signalIdDedupKey(entry as SeededSignal);
    if (!key) {
      logger?.warn(
        'testController.getSeededSignals entry has invalid signal_id (expected {source:catalog,data_provider_domain,id} or {source:agent,agent_url,id}); dropping',
        { index }
      );
      return;
    }
    valid.push(entry as SeededSignal);
  });
  return valid;
}

/**
 * Validate seeded creative-delivery entries. Drops entries missing a non-empty
 * string `creative_id`.
 */
export function filterValidSeededCreativeDelivery(
  raw: unknown,
  logger?: { warn: (message: string, meta?: Record<string, unknown>) => void }
): SeededCreativeDelivery[] {
  return filterValidById<SeededCreativeDelivery>(raw, 'creative_id', 'getSeededCreativeDelivery', logger);
}

/**
 * Validate seeded creative-feature results. Drops entries missing a non-empty
 * string `feature_id` (the dedup key against the handler's `results` array).
 */
export function filterValidSeededCreativeFeatures(
  raw: unknown,
  logger?: { warn: (message: string, meta?: Record<string, unknown>) => void }
): SeededCreativeFeature[] {
  return filterValidById<SeededCreativeFeature>(raw, 'feature_id', 'getSeededCreativeFeatures', logger);
}

/**
 * Merge seeded signals into a `get_signals` response. Existing handler signals
 * come first; seeded entries append after deduping by `signal_id`. On
 * collision the seeded entry wins. Stamps `sandbox: true` unless the handler
 * explicitly declared `sandbox: false`.
 *
 * `get_signals` carries `pagination: PaginationResponse` and no `query_summary`.
 * Pagination is not recomputed on the merge. `PaginationResponse.total_count`
 * is optional; recomputing it on partial pages would mis-represent the
 * cross-page total (the handler may have served page 1 of N, and the seeded
 * fixture sits outside that pagination context). Storyboards asserting on
 * totals should seed the handler's response, not the post-merge envelope.
 */
export function mergeSeededSignalsIntoResponse(
  response: GetSignalsResponse,
  seeded: readonly SeededSignal[]
): GetSignalsResponse {
  if (!seeded.length) return response;
  const seededKeys = new Set<string>();
  for (const s of seeded) {
    const key = signalIdDedupKey(s);
    if (key) seededKeys.add(key);
  }
  const existing = Array.isArray(response.signals) ? response.signals : [];
  const retained = existing.filter(s => {
    const key = s ? signalIdDedupKey(s) : undefined;
    return key == null || !seededKeys.has(key);
  });
  const merged: GetSignalsResponse = {
    ...response,
    signals: [...retained, ...seeded],
  };
  if ((response as { sandbox?: unknown }).sandbox !== false) {
    (merged as { sandbox?: boolean }).sandbox = true;
  }
  return merged;
}

/**
 * Merge seeded creative-delivery entries into a `get_creative_delivery`
 * response. Existing handler creatives come first; seeded entries append after
 * deduping by `creative_id`. On collision the seeded entry wins (matches the
 * precedent set by `mergeSeededMediaBuyDelivery` — storyboards seed
 * deliberately, so a seeded fixture for an existing id is an explicit author
 * override).
 *
 * `pagination.total` (optional per the AdCP 3.0.11 schema) is incremented by
 * the count of new non-colliding seeded entries. There is no top-level
 * aggregated-totals envelope on this response (unlike `get_media_buy_delivery`),
 * so no further recomputation is performed. Stamps `sandbox: true` unless the
 * handler explicitly declared `sandbox: false`. Returns a NEW response object.
 */
export function mergeSeededCreativeDeliveryIntoResponse(
  response: GetCreativeDeliveryResponse,
  seeded: readonly SeededCreativeDelivery[]
): GetCreativeDeliveryResponse {
  if (!seeded.length) return response;
  const seededIds = new Set<string>();
  for (const c of seeded) seededIds.add(c.creative_id);
  const existing = Array.isArray(response.creatives) ? response.creatives : [];
  const existingIds = new Set<string>();
  for (const c of existing) {
    if (c && typeof c.creative_id === 'string') existingIds.add(c.creative_id);
  }
  const retained = existing.filter(c => !seededIds.has(c?.creative_id));
  let newCount = 0;
  for (const c of seeded) if (!existingIds.has(c.creative_id)) newCount += 1;
  const merged: GetCreativeDeliveryResponse = {
    ...response,
    creatives: [...retained, ...seeded],
  };
  if ((response as { sandbox?: unknown }).sandbox !== false) {
    (merged as { sandbox?: boolean }).sandbox = true;
  }
  // `pagination.total` is the schema-correct field name on
  // GetCreativeDeliveryResponse (distinct from `pagination.total_count` used
  // by list_creatives / get_media_buys / list_accounts).
  const pagination = (response as { pagination?: { total?: unknown } }).pagination;
  if (pagination && typeof pagination === 'object' && typeof pagination.total === 'number') {
    (merged as { pagination?: unknown }).pagination = {
      ...pagination,
      total: pagination.total + newCount,
    };
  }
  return merged;
}

/**
 * Merge seeded creative-feature results into a `get_creative_features`
 * response. The response is a `oneOf` envelope — success arm carries
 * `results: CreativeFeatureResult[]`, error arm carries `errors: Error[]`.
 * When the handler returned the error arm, this helper is a no-op; the error
 * envelope passes through unchanged. When the handler returned the success
 * arm, seeded results merge into the `results` array (dedup by `feature_id`,
 * seeded wins on collision).
 *
 * Framework-managed envelope fields (`context`, `ext`, `detail_url`,
 * `pricing_option_id`, `vendor_cost`, `currency`, `consumption`) round-trip
 * from the handler verbatim — the bridge only augments the per-feature
 * results array.
 *
 * Returns a NEW response object.
 */
export function mergeSeededCreativeFeaturesIntoResponse(
  response: GetCreativeFeaturesResponse,
  seeded: readonly SeededCreativeFeature[]
): GetCreativeFeaturesResponse {
  if (!seeded.length) return response;
  // Discriminate the success vs error arms. The error arm carries `errors`
  // and no `results`; the success arm carries `results` (required per spec).
  const successArm = response as { results?: CreativeFeatureResult[] };
  if (!Array.isArray(successArm.results)) return response;
  const seededIds = new Set<string>();
  for (const r of seeded) seededIds.add(r.feature_id);
  const existing = successArm.results;
  const retained = existing.filter(r => !seededIds.has(r?.feature_id));
  const merged = {
    ...successArm,
    results: [...retained, ...seeded],
  } as GetCreativeFeaturesResponse;
  return merged;
}

/**
 * Bridge the default test-controller store (a `Map<string, unknown>` that
 * holds seeded fixtures by `product_id`, populated by `seed_product` scenarios)
 * to a {@link TestControllerBridge}.
 *
 * Each stored fixture is merged onto `productDefaults` via
 * {@link mergeSeedProduct} — sellers pass their canonical baseline (delivery
 * type, channels, reporting capabilities, ...) once here, and the permissive
 * merge fills in whatever the storyboard fixture didn't declare. The bridge
 * then returns the resulting `Product[]` for the dispatcher to merge into
 * `get_products` responses.
 *
 * Accepts any `Map<string, unknown>` so it composes with session-scoped
 * stores as well as the default process-wide one.
 *
 * @example
 * ```ts
 * const store = new Map<string, unknown>();
 * const server = createAdcpServer({
 *   testController: bridgeFromTestControllerStore(store, {
 *     delivery_type: 'guaranteed',
 *     channels: ['display'],
 *   }),
 * });
 * ```
 */
export function bridgeFromTestControllerStore<TAccount = unknown>(
  store: Map<string, unknown>,
  productDefaults: Partial<Product> = {}
): TestControllerBridge<TAccount> {
  return {
    getSeededProducts: () => {
      const out: Product[] = [];
      for (const [productId, fixture] of store.entries()) {
        const merged = mergeSeedProduct(productDefaults, {
          ...(fixture && typeof fixture === 'object' ? (fixture as Partial<Product>) : {}),
          product_id: productId,
        });
        out.push(merged as Product);
      }
      return out;
    },
  };
}

/**
 * Options for {@link bridgeFromSessionStore}.
 *
 * Passed as an options object (rather than positional args) so future
 * additions (logger, sandbox override, cache hooks) land non-breakingly.
 * `loadSession` here receives the raw `get_products` request — distinct
 * from any session-loader a seller writes elsewhere that takes `{ context }`.
 */
export interface BridgeFromSessionStoreOptions<TSession> {
  /**
   * Resolve the session for the current request. Receives the raw
   * `get_products` request post-schema-validation; pull whatever key
   * you use (`session_id`, `brand.domain`, `account_id`) out of
   * `input.context` / `input.account` / `input.brand` and return the
   * session object. May be async.
   *
   * Errors propagate unchanged to the dispatcher — a `loadSession`
   * rejection fails the bridge call rather than silently producing an
   * empty seed list (seed loss under DB failure would be worse than a
   * loud error, and the storyboard runner surfaces the failure).
   */
  loadSession: (input: Record<string, unknown>) => Promise<TSession> | TSession;

  /**
   * Extract the seeded products from a resolved session. Return a Map,
   * any `[productId, fixture]` iterable, or a Promise of one — the
   * bridge awaits the return value so callers with lazy-loaded seed
   * collections don't have to eagerly hydrate inside `loadSession`.
   * Return `null` / `undefined` when the session has no seeds.
   */
  selectSeededProducts: (
    session: TSession
  ) =>
    | Iterable<readonly [string, unknown]>
    | Promise<Iterable<readonly [string, unknown]> | null | undefined>
    | null
    | undefined;

  /**
   * Baseline product fields every seeded fixture is merged onto via
   * {@link mergeSeedProduct}. Storyboards can then seed sparse
   * `{ name, targeting }` fixtures and the baseline fills in reporting
   * / pricing / property fields the response schema requires.
   */
  productDefaults?: Partial<Product>;

  /**
   * Extract seeded creatives from a resolved session. The returned entries
   * are passed through `filterValidSeededCreatives` and merged into
   * `list_creatives` responses on sandbox requests. Each entry MUST carry a
   * non-empty string `creative_id`. Return `null` / `undefined` when the
   * session has no seeded creatives.
   */
  selectSeededCreatives?: (
    session: TSession
  ) => Iterable<SeededCreative> | Promise<Iterable<SeededCreative> | null | undefined> | null | undefined;

  /**
   * Extract seeded media buys from a resolved session. Each entry MUST carry
   * a non-empty string `media_buy_id`.
   */
  selectSeededMediaBuys?: (
    session: TSession
  ) => Iterable<SeededMediaBuy> | Promise<Iterable<SeededMediaBuy> | null | undefined> | null | undefined;

  /**
   * Extract seeded media-buy-delivery snapshots from a resolved session. Each
   * entry MUST carry a non-empty string `media_buy_id`. The framework appends
   * non-colliding seeded entries to the handler's response and recomputes
   * `aggregated_totals` from the merged set — see
   * {@link TestControllerBridge.getSeededMediaBuyDelivery}.
   */
  selectSeededMediaBuyDelivery?: (
    session: TSession
  ) =>
    | Iterable<SeededMediaBuyDelivery>
    | Promise<Iterable<SeededMediaBuyDelivery> | null | undefined>
    | null
    | undefined;

  /**
   * Extract seeded accounts from a resolved session. Each entry MUST carry
   * a non-empty string `account_id`.
   */
  selectSeededAccounts?: (
    session: TSession
  ) => Iterable<Account> | Promise<Iterable<Account> | null | undefined> | null | undefined;

  /**
   * Extract seeded account-financials envelopes from a resolved session.
   * Each entry MUST carry `account.account_id`. The framework picks the
   * fixture matching the request's `account` reference (singleton replace,
   * not append — see {@link TestControllerBridge.getSeededAccountFinancials}).
   */
  selectSeededAccountFinancials?: (
    session: TSession
  ) =>
    | Iterable<SeededAccountFinancials>
    | Promise<Iterable<SeededAccountFinancials> | null | undefined>
    | null
    | undefined;

  /**
   * Extract seeded creative formats from a resolved session. Each entry MUST
   * carry a `format_id.agent_url` + `format_id.id` (both non-empty strings).
   */
  selectSeededCreativeFormats?: (
    session: TSession
  ) => Iterable<Format> | Promise<Iterable<Format> | null | undefined> | null | undefined;

  /**
   * Extract seeded property lists from a resolved session. Each entry MUST
   * carry a non-empty string `list_id`. Feeds both `list_property_lists`
   * (append-merge into `lists`) and `get_property_list` (singleton replace
   * of the `list` field; handler's `identifiers` / `pagination` / etc. pass
   * through).
   */
  selectSeededPropertyLists?: (
    session: TSession
  ) => Iterable<PropertyList> | Promise<Iterable<PropertyList> | null | undefined> | null | undefined;

  /**
   * Extract seeded content-standards from a resolved session. Each entry MUST
   * carry a non-empty string `standards_id`. Feeds `list_content_standards`
   * (append-merge into `standards`) and `get_content_standards` (singleton
   * replace of the whole response envelope, preserving handler `ext`).
   */
  selectSeededContentStandards?: (
    session: TSession
  ) => Iterable<ContentStandards> | Promise<Iterable<ContentStandards> | null | undefined> | null | undefined;

  /**
   * Extract seeded collection lists from a resolved session. Each entry MUST
   * carry a non-empty string `list_id`. Feeds both `list_collection_lists`
   * (append-merge into `lists`) and `get_collection_list` (singleton replace
   * of the `list` field).
   */
  selectSeededCollectionLists?: (
    session: TSession
  ) => Iterable<CollectionList> | Promise<Iterable<CollectionList> | null | undefined> | null | undefined;

  /**
   * Extract seeded signals from a resolved session. Each entry MUST carry a
   * non-empty string `signal_id`. Feeds `get_signals` (append-merge into
   * `signals`, dedup by `signal_id`, seeded wins). Works uniformly across
   * `signal-marketplace` and `signal-owned` specialisms.
   */
  selectSeededSignals?: (
    session: TSession
  ) => Iterable<SeededSignal> | Promise<Iterable<SeededSignal> | null | undefined> | null | undefined;

  /**
   * Extract seeded creative-delivery entries from a resolved session. Each
   * entry MUST carry a non-empty string `creative_id`. Feeds
   * `get_creative_delivery` (append-merge into `creatives`, dedup by
   * `creative_id`, seeded wins; `pagination.total` updated when set).
   */
  selectSeededCreativeDelivery?: (
    session: TSession
  ) =>
    | Iterable<SeededCreativeDelivery>
    | Promise<Iterable<SeededCreativeDelivery> | null | undefined>
    | null
    | undefined;

  /**
   * Extract seeded creative-feature results from a resolved session. Each
   * entry MUST carry a non-empty string `feature_id`. Feeds
   * `get_creative_features` (merge into success-arm `results` by `feature_id`,
   * seeded wins; no-op when the handler returned the error arm).
   */
  selectSeededCreativeFeatures?: (
    session: TSession
  ) => Iterable<SeededCreativeFeature> | Promise<Iterable<SeededCreativeFeature> | null | undefined> | null | undefined;
}

/**
 * Session-scoped variant of {@link bridgeFromTestControllerStore}.
 *
 * {@link bridgeFromTestControllerStore} closes over a single `Map` at
 * construction time — fine for a process-wide seed store, but doesn't
 * compose with sellers whose seed state is per-tenant / per-brand / per-
 * `account_id` and loaded from Postgres or Redis on every request. Those
 * sellers end up rewriting the same "load session, pull the seed Map,
 * merge into products" glue each time.
 *
 * Sandbox gating and dedup happen in the dispatcher (same path as the
 * default-store bridge); this helper returns fixtures unconditionally
 * and leaves scoping to the framework.
 *
 * @example
 * ```ts
 * import { bridgeFromSessionStore } from '@adcp/sdk/server';
 *
 * const server = createAdcpServer({
 *   testController: bridgeFromSessionStore({
 *     loadSession: (input) => loadComplySession(sessionKeyFromInput(input)),
 *     selectSeededProducts: (session) => session.complyExtensions.seededProducts,
 *     productDefaults: SEED_PRODUCT_DEFAULTS,
 *   }),
 * });
 * ```
 */
export function bridgeFromSessionStore<TSession, TAccount = unknown>(
  opts: BridgeFromSessionStoreOptions<TSession>
): TestControllerBridge<TAccount> {
  const {
    loadSession,
    selectSeededProducts,
    productDefaults = {},
    selectSeededCreatives,
    selectSeededMediaBuys,
    selectSeededMediaBuyDelivery,
    selectSeededAccounts,
    selectSeededAccountFinancials,
    selectSeededCreativeFormats,
    selectSeededPropertyLists,
    selectSeededContentStandards,
    selectSeededCollectionLists,
    selectSeededSignals,
    selectSeededCreativeDelivery,
    selectSeededCreativeFeatures,
  } = opts;

  // Each per-tool callback resolves the session per-request (no memoisation —
  // same contract as the original `getSeededProducts` path) and awaits the
  // selector so callers can lazy-load seed collections on the selector path.
  // Selectors are wired only when the adopter provided them; absent selectors
  // leave the bridge callback omitted (opt-in by presence on the bridge
  // interface, same shape as `getSeededProducts`).
  const bridge: TestControllerBridge<TAccount> = {
    getSeededProducts: async ctx => {
      const session = await loadSession(ctx.input);
      const entries = await selectSeededProducts(session);
      if (!entries) return [];
      const out: Product[] = [];
      for (const [productId, fixture] of entries) {
        const merged = mergeSeedProduct(productDefaults, {
          ...(fixture && typeof fixture === 'object' ? (fixture as Partial<Product>) : {}),
          product_id: productId,
        });
        out.push(merged as Product);
      }
      return out;
    },
  };

  if (selectSeededCreatives) {
    bridge.getSeededCreatives = async ctx => {
      const session = await loadSession(ctx.input);
      const entries = await selectSeededCreatives(session);
      return entries ? Array.from(entries) : [];
    };
  }
  if (selectSeededMediaBuys) {
    bridge.getSeededMediaBuys = async ctx => {
      const session = await loadSession(ctx.input);
      const entries = await selectSeededMediaBuys(session);
      return entries ? Array.from(entries) : [];
    };
  }
  if (selectSeededMediaBuyDelivery) {
    bridge.getSeededMediaBuyDelivery = async ctx => {
      const session = await loadSession(ctx.input);
      const entries = await selectSeededMediaBuyDelivery(session);
      return entries ? Array.from(entries) : [];
    };
  }
  if (selectSeededAccounts) {
    bridge.getSeededAccounts = async ctx => {
      const session = await loadSession(ctx.input);
      const entries = await selectSeededAccounts(session);
      return entries ? Array.from(entries) : [];
    };
  }
  if (selectSeededAccountFinancials) {
    bridge.getSeededAccountFinancials = async ctx => {
      const session = await loadSession(ctx.input);
      const entries = await selectSeededAccountFinancials(session);
      return entries ? Array.from(entries) : [];
    };
  }
  if (selectSeededCreativeFormats) {
    bridge.getSeededCreativeFormats = async ctx => {
      const session = await loadSession(ctx.input);
      const entries = await selectSeededCreativeFormats(session);
      return entries ? Array.from(entries) : [];
    };
  }
  if (selectSeededPropertyLists) {
    bridge.getSeededPropertyLists = async ctx => {
      const session = await loadSession(ctx.input);
      const entries = await selectSeededPropertyLists(session);
      return entries ? Array.from(entries) : [];
    };
  }
  if (selectSeededContentStandards) {
    bridge.getSeededContentStandards = async ctx => {
      const session = await loadSession(ctx.input);
      const entries = await selectSeededContentStandards(session);
      return entries ? Array.from(entries) : [];
    };
  }
  if (selectSeededCollectionLists) {
    bridge.getSeededCollectionLists = async ctx => {
      const session = await loadSession(ctx.input);
      const entries = await selectSeededCollectionLists(session);
      return entries ? Array.from(entries) : [];
    };
  }
  if (selectSeededSignals) {
    bridge.getSeededSignals = async ctx => {
      const session = await loadSession(ctx.input);
      const entries = await selectSeededSignals(session);
      return entries ? Array.from(entries) : [];
    };
  }
  if (selectSeededCreativeDelivery) {
    bridge.getSeededCreativeDelivery = async ctx => {
      const session = await loadSession(ctx.input);
      const entries = await selectSeededCreativeDelivery(session);
      return entries ? Array.from(entries) : [];
    };
  }
  if (selectSeededCreativeFeatures) {
    bridge.getSeededCreativeFeatures = async ctx => {
      const session = await loadSession(ctx.input);
      const entries = await selectSeededCreativeFeatures(session);
      return entries ? Array.from(entries) : [];
    };
  }

  return bridge;
}
