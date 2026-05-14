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
  ListCreativeFormatsResponse,
  Format,
  GetAccountFinancialsResponse,
  GetAccountFinancialsSuccess,
  GetAccountFinancialsRequest,
} from '../types/tools.generated';
import { mergeSeedProduct } from '../testing/seed-merge';

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
    selectSeededAccounts,
    selectSeededAccountFinancials,
    selectSeededCreativeFormats,
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

  return bridge;
}
