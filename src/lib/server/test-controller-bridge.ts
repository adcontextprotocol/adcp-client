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
 * read-path responses with seeded fixtures on sandbox requests, and
 * leaves production traffic untouched.
 *
 * The bridge intentionally does NOT know how seeded fixtures are stored.
 * Sellers provide callbacks that return the lists the SDK should merge —
 * which lets the same wiring work whether the backing store is in-memory,
 * Postgres, Redis, or a mock.
 *
 * Platform-proxy sellers (DSPs, walled gardens, retail-media networks whose
 * read path calls an upstream API rather than a local store) use these
 * callbacks to inject seeded fixtures so conformance storyboards see the
 * expected data without needing live upstream OAuth.
 *
 * ## What a storyboard pass through this bridge proves — and doesn't
 *
 * A storyboard run that succeeds because seeded fixtures were merged into
 * the response verifies **protocol conformance against fixture data**:
 * wire shape, error envelopes, idempotency, signed-request handling,
 * sandbox stamping. It does **not** verify that the seller's adapter
 * against the real upstream (Snap, Meta, TikTok, Google Ads, etc.) is
 * working — the upstream code path is bypassed by the post-handler merge.
 *
 * Treat this bridge as the conformance equivalent of a recorded-fixtures
 * unit test, not an end-to-end integration test. Sellers should still
 * exercise their adapters against a real (or sandbox) upstream OAuth tier
 * separately; the typical pattern is a CLI runner pointed at a deployed
 * sandbox URL with live credentials. The two together — storyboard-via-
 * bridge plus live-OAuth runner — give wire conformance and adapter
 * health respectively.
 *
 * ## Adopter responsibilities
 *
 * **`resolveAccount` is the trust boundary.** The dispatcher's sandbox gate
 * is "request carries a sandbox marker AND (resolved account is sandbox OR
 * no account was resolved)." If you deploy a server with this bridge
 * registered but no `resolveAccount` configured, a buyer can stamp
 * `context.sandbox: true` on a request and trigger the merge. That's the
 * intended behavior for storyboard runners with no account scoping, but
 * means **production bindings must always configure `resolveAccount`** —
 * otherwise the request-signal check is the only line of defense.
 *
 * **Multi-tenant isolation is the adopter's job.** Callbacks receive
 * `ctx.account` and must key their fixture store on it. The SDK does no
 * defensive cross-check between the account on the response entries and
 * the `ctx.account` that asked for them. A sloppy session-store keying
 * can return tenant A's fixtures to tenant B; nothing in this module will
 * notice. Treat fixture stores like any other multi-tenant data layer.
 */

import type {
  Product,
  GetProductsResponse,
  ListCreativesResponse,
  GetMediaBuysResponse,
  ListAccountsResponse,
  GetAccountFinancialsSuccess,
  Format,
} from '../types/tools.generated';
import { mergeSeed, mergeSeedProduct } from '../testing/seed-merge';

/** Element type of `ListCreativesResponse.creatives`. */
export type SeededCreative = ListCreativesResponse['creatives'][number];

/** Element type of `GetMediaBuysResponse.media_buys`. */
export type SeededMediaBuy = GetMediaBuysResponse['media_buys'][number];

/** Element type of `ListAccountsResponse.accounts`. */
export type SeededAccount = ListAccountsResponse['accounts'][number];

/** Account type used in `ListAccountsResponse.accounts`. */
export type { Format };

/**
 * Context passed to each {@link TestControllerBridge} callback.
 *
 * `input` is the raw request as received over the wire (post MCP schema
 * validation). `account` is the resolved seller account when `resolveAccount`
 * is configured on `createAdcpServer`, else `undefined` — sellers who key
 * seeded fixtures per account read it from here.
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
 * unchanged. Each callback is opt-in via presence — omit a callback to
 * hold seeded state without changing that tool's response shape.
 *
 * All callbacks fire ONLY on sandbox requests (the framework gates on
 * `account.sandbox === true` or `context.sandbox === true` plus the
 * resolved-account check). They must still re-verify `ctx.account` is
 * sandbox-scoped internally if they key fixtures by account.
 *
 * Post-handler merge contract: the registered handler runs first, the
 * callback returns seeded entries, and the framework merges them into
 * the handler's response. For list tools, seeded entries append after
 * dedup (seeded wins on ID collision). For single-record tools
 * (`get_account_financials`), the first seeded entry overlays the
 * handler's response field-by-field via deep merge (seeded fields win).
 */
export interface TestControllerBridge<TAccount = unknown> {
  /**
   * Retrieve seeded products for the current `get_products` request.
   *
   * Return an empty array (or `undefined`) when nothing is seeded. The
   * returned products are appended to the handler's response; on
   * `product_id` collision, the seeded entry wins.
   */
  getSeededProducts?: (ctx: TestControllerBridgeContext<TAccount>) => Promise<Product[]> | Product[];

  /**
   * Retrieve seeded creatives for the current `list_creatives` request.
   *
   * Returned entries are appended to the handler's `creatives` array; on
   * `creative_id` collision the seeded entry wins. The `query_summary.returned`
   * count is updated to reflect the merged length.
   */
  getSeededCreatives?: (ctx: TestControllerBridgeContext<TAccount>) => Promise<SeededCreative[]> | SeededCreative[];

  /**
   * Retrieve seeded media buys for the current `get_media_buys` request.
   *
   * Returned entries are appended to the handler's `media_buys` array; on
   * `media_buy_id` collision the seeded entry wins.
   */
  getSeededMediaBuys?: (ctx: TestControllerBridgeContext<TAccount>) => Promise<SeededMediaBuy[]> | SeededMediaBuy[];

  /**
   * Retrieve seeded accounts for the current `list_accounts` request.
   *
   * Returned entries are appended to the handler's `accounts` array; on
   * `account_id` collision the seeded entry wins.
   */
  getSeededAccounts?: (ctx: TestControllerBridgeContext<TAccount>) => Promise<SeededAccount[]> | SeededAccount[];

  /**
   * Retrieve seeded account financials for the current `get_account_financials`
   * request.
   *
   * The first valid entry in the returned array is deep-merged onto the
   * handler's `GetAccountFinancialsSuccess` response (seeded fields win on
   * collision). If the handler returns an error arm or no seeded entries are
   * provided, the handler response is returned unchanged.
   */
  getSeededAccountFinancials?: (
    ctx: TestControllerBridgeContext<TAccount>
  ) => Promise<GetAccountFinancialsSuccess[]> | GetAccountFinancialsSuccess[];

  /**
   * Retrieve seeded creative formats for the current `list_creative_formats`
   * request.
   *
   * Returned entries are appended to the handler's `formats` array; on
   * `format_id.agent_url + format_id.id` collision the seeded entry wins.
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
 * Guard against the async-envelope shape (`{status: 'submitted', task_id, ...}`)
 * a handler may return when a tool call defers to a long-running task. The
 * merge helpers expect the success arm of the response schema; spreading a
 * `creatives: [...]` field into a submitted envelope produces a hybrid wire
 * shape that violates the async schema.
 *
 * Returns `true` only when `response` looks like the synchronous success
 * arm — the discriminant field exists and the expected list key is an array.
 * Anything that looks like an async / submitted / working envelope returns
 * `false` and the dispatcher leaves the handler response untouched.
 */
function isListSuccessShape(response: unknown, listKey: string): boolean {
  if (!response || typeof response !== 'object') return false;
  const r = response as Record<string, unknown>;
  // Async/in-flight envelopes carry a `task_id` and a non-terminal `status`.
  // Treat their presence as "not the success arm" regardless of list key.
  if (typeof r.task_id === 'string' && r.task_id.length > 0) return false;
  if (typeof r.status === 'string' && r.status !== 'completed') return false;
  return Array.isArray(r[listKey]);
}

/**
 * Variant of {@link isListSuccessShape} for `get_account_financials`, which
 * has no list field — the success arm is discriminated by the presence of
 * the required `account`, `currency`, `period`, and `timezone` fields.
 */
function isFinancialsSuccessShape(response: unknown): boolean {
  if (!response || typeof response !== 'object') return false;
  const r = response as Record<string, unknown>;
  if (typeof r.task_id === 'string' && r.task_id.length > 0) return false;
  if (typeof r.status === 'string' && r.status !== 'completed') return false;
  return (
    typeof r.account === 'object' &&
    r.account !== null &&
    typeof r.currency === 'string' &&
    typeof r.timezone === 'string'
  );
}

/**
 * Bump a `total_matching` / `total_count` integer by `delta`. Returns
 * `undefined` when the original was undefined (handlers that can't compute
 * a total stay opted-out), or the original when `delta` is zero. Otherwise
 * returns the sum, floor-clamped at the original value — drift safety in
 * case a malformed handler returned a count lower than its own array length.
 */
function bumpCount(original: number | undefined, delta: number): number | undefined {
  if (original === undefined) return undefined;
  if (delta <= 0) return original;
  return original + delta;
}

/**
 * Bump `pagination.total_count` by `delta` when present. Leaves
 * `has_more` and `cursor` untouched — seeded entries land on the current
 * page, the handler's cursor (if any) still points to its next page, and
 * `has_more: true` remains true after the merge.
 */
function bumpPaginationTotal<T extends { total_count?: number } | undefined>(pagination: T, delta: number): T {
  if (!pagination || delta <= 0) return pagination;
  if (pagination.total_count === undefined) return pagination;
  return { ...pagination, total_count: pagination.total_count + delta } as T;
}

// ---------------------------------------------------------------------------
// get_products merge helpers
// ---------------------------------------------------------------------------

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
  if (!isListSuccessShape(response, 'products')) return response;

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
// list_creatives merge helpers
// ---------------------------------------------------------------------------

/**
 * Merge seeded creatives into a `list_creatives` response payload.
 *
 * Handler-returned creatives come first; seeded entries append after deduping
 * by `creative_id`. On collision the seeded entry wins. The
 * `query_summary.returned` count is updated to match the merged array length;
 * `query_summary.total_matching` and `pagination.total_count` are bumped by
 * the number of genuinely-new seeded entries (collisions don't count, since
 * they replace existing handler entries that were already accounted for).
 * `pagination.cursor` / `pagination.has_more` are left untouched — seeded
 * entries land on the current page; the handler's cursor still points to its
 * next page if any.
 *
 * The `sandbox: true` flag is stamped unless the handler explicitly set
 * `sandbox: false`.
 */
export function mergeSeededCreativesIntoResponse(
  response: ListCreativesResponse,
  seeded: readonly SeededCreative[]
): ListCreativesResponse {
  if (!seeded.length) return response;
  if (!isListSuccessShape(response, 'creatives')) return response;

  const seededIds = new Set<string>();
  for (const c of seeded) seededIds.add(c.creative_id);

  const handlerCreatives = Array.isArray(response.creatives) ? response.creatives : [];
  const handlerIds = new Set<string>();
  for (const c of handlerCreatives) {
    if (c?.creative_id) handlerIds.add(c.creative_id);
  }
  const newlyAdded = seeded.reduce((n, c) => (handlerIds.has(c.creative_id) ? n : n + 1), 0);
  const retained = handlerCreatives.filter(c => !seededIds.has(c?.creative_id));
  const mergedList = [...retained, ...seeded];

  return {
    ...response,
    creatives: mergedList,
    query_summary: {
      ...response.query_summary,
      returned: mergedList.length,
      total_matching:
        typeof response.query_summary?.total_matching === 'number'
          ? response.query_summary.total_matching + newlyAdded
          : response.query_summary?.total_matching,
    },
    pagination: bumpPaginationTotal(response.pagination, newlyAdded),
    sandbox: response.sandbox !== false ? true : response.sandbox,
  };
}

/**
 * Validate and normalize seeded creatives. Entries missing `creative_id` or
 * that are not plain objects are dropped with a warning.
 */
export function filterValidSeededCreatives(
  raw: unknown,
  logger?: { warn: (message: string, meta?: Record<string, unknown>) => void }
): SeededCreative[] {
  if (!Array.isArray(raw)) {
    logger?.warn('testController.getSeededCreatives did not return an array; skipping bridge', {
      received: typeof raw,
    });
    return [];
  }
  const valid: SeededCreative[] = [];
  raw.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      logger?.warn('testController.getSeededCreatives entry is not an object; dropping', { index });
      return;
    }
    const id = (entry as { creative_id?: unknown }).creative_id;
    if (typeof id !== 'string' || id.length === 0) {
      logger?.warn('testController.getSeededCreatives entry missing creative_id; dropping', { index });
      return;
    }
    valid.push(entry as SeededCreative);
  });
  return valid;
}

// ---------------------------------------------------------------------------
// get_media_buys merge helpers
// ---------------------------------------------------------------------------

/**
 * Merge seeded media buys into a `get_media_buys` response payload.
 *
 * Handler-returned media buys come first; seeded entries append after deduping
 * by `media_buy_id`. On collision the seeded entry wins.
 * `pagination.total_count` (if present) is bumped by the number of genuinely-
 * new seeded entries; `pagination.cursor` / `has_more` are left untouched. The
 * `sandbox: true` flag is stamped unless the handler explicitly set
 * `sandbox: false`.
 */
export function mergeSeededMediaBuysIntoResponse(
  response: GetMediaBuysResponse,
  seeded: readonly SeededMediaBuy[]
): GetMediaBuysResponse {
  if (!seeded.length) return response;
  if (!isListSuccessShape(response, 'media_buys')) return response;

  const seededIds = new Set<string>();
  for (const m of seeded) seededIds.add(m.media_buy_id);

  const handlerBuys = Array.isArray(response.media_buys) ? response.media_buys : [];
  const handlerIds = new Set<string>();
  for (const m of handlerBuys) {
    if (m?.media_buy_id) handlerIds.add(m.media_buy_id);
  }
  const newlyAdded = seeded.reduce((n, m) => (handlerIds.has(m.media_buy_id) ? n : n + 1), 0);
  const retained = handlerBuys.filter(m => !seededIds.has(m?.media_buy_id));

  return {
    ...response,
    media_buys: [...retained, ...seeded],
    pagination: bumpPaginationTotal(response.pagination, newlyAdded),
    sandbox: response.sandbox !== false ? true : response.sandbox,
  };
}

/**
 * Validate and normalize seeded media buys. Entries missing `media_buy_id` or
 * that are not plain objects are dropped with a warning.
 */
export function filterValidSeededMediaBuys(
  raw: unknown,
  logger?: { warn: (message: string, meta?: Record<string, unknown>) => void }
): SeededMediaBuy[] {
  if (!Array.isArray(raw)) {
    logger?.warn('testController.getSeededMediaBuys did not return an array; skipping bridge', {
      received: typeof raw,
    });
    return [];
  }
  const valid: SeededMediaBuy[] = [];
  raw.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      logger?.warn('testController.getSeededMediaBuys entry is not an object; dropping', { index });
      return;
    }
    const id = (entry as { media_buy_id?: unknown }).media_buy_id;
    if (typeof id !== 'string' || id.length === 0) {
      logger?.warn('testController.getSeededMediaBuys entry missing media_buy_id; dropping', { index });
      return;
    }
    valid.push(entry as SeededMediaBuy);
  });
  return valid;
}

// ---------------------------------------------------------------------------
// list_accounts merge helpers
// ---------------------------------------------------------------------------

/**
 * Merge seeded accounts into a `list_accounts` response payload.
 *
 * Handler-returned accounts come first; seeded entries append after deduping
 * by `account_id`. On collision the seeded entry wins.
 * `pagination.total_count` (if present) is bumped by the number of
 * genuinely-new seeded entries; `pagination.cursor` / `has_more` are
 * left untouched.
 *
 * `ListAccountsResponse` has no top-level `sandbox` field, so no sandbox
 * stamp is applied (unlike the list-creatives and list-media-buys helpers).
 */
export function mergeSeededAccountsIntoResponse(
  response: ListAccountsResponse,
  seeded: readonly SeededAccount[]
): ListAccountsResponse {
  if (!seeded.length) return response;
  if (!isListSuccessShape(response, 'accounts')) return response;

  const seededIds = new Set<string>();
  for (const a of seeded) seededIds.add(a.account_id);

  const handlerAccounts = Array.isArray(response.accounts) ? response.accounts : [];
  const handlerIds = new Set<string>();
  for (const a of handlerAccounts) {
    if (a?.account_id) handlerIds.add(a.account_id);
  }
  const newlyAdded = seeded.reduce((n, a) => (handlerIds.has(a.account_id) ? n : n + 1), 0);
  const retained = handlerAccounts.filter(a => !seededIds.has(a?.account_id));

  return {
    ...response,
    accounts: [...retained, ...seeded],
    pagination: bumpPaginationTotal(response.pagination, newlyAdded),
  };
}

/**
 * Validate and normalize seeded accounts. Entries missing `account_id` or
 * that are not plain objects are dropped with a warning.
 */
export function filterValidSeededAccounts(
  raw: unknown,
  logger?: { warn: (message: string, meta?: Record<string, unknown>) => void }
): SeededAccount[] {
  if (!Array.isArray(raw)) {
    logger?.warn('testController.getSeededAccounts did not return an array; skipping bridge', {
      received: typeof raw,
    });
    return [];
  }
  const valid: SeededAccount[] = [];
  raw.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      logger?.warn('testController.getSeededAccounts entry is not an object; dropping', { index });
      return;
    }
    const id = (entry as { account_id?: unknown }).account_id;
    if (typeof id !== 'string' || id.length === 0) {
      logger?.warn('testController.getSeededAccounts entry missing account_id; dropping', { index });
      return;
    }
    valid.push(entry as SeededAccount);
  });
  return valid;
}

// ---------------------------------------------------------------------------
// get_account_financials merge helpers
// ---------------------------------------------------------------------------

/**
 * Merge seeded account financials onto a `get_account_financials` success
 * response.
 *
 * Unlike list tools, `get_account_financials` returns a single object per
 * call. The first valid seeded entry is deep-merged onto the handler's
 * response: seeded fields win on collision. If no seeded entries are
 * provided, the handler response is returned unchanged.
 *
 * This allows proxy sellers to seed the financial values the conformance
 * storyboard expects without needing a live upstream billing API.
 *
 * `GetAccountFinancialsSuccess` has no top-level `sandbox` field, so no
 * sandbox stamp is applied.
 */
export function mergeSeededAccountFinancialsIntoResponse(
  response: GetAccountFinancialsSuccess,
  seeded: readonly GetAccountFinancialsSuccess[],
  logger?: { warn: (message: string, meta?: Record<string, unknown>) => void }
): GetAccountFinancialsSuccess {
  if (!seeded.length) return response;
  if (!isFinancialsSuccessShape(response)) return response;
  if (seeded.length > 1) {
    logger?.warn('mergeSeededAccountFinancialsIntoResponse received >1 seeded entry; only the first is applied', {
      receivedCount: seeded.length,
    });
  }
  return mergeSeed(response, seeded[0] as Partial<GetAccountFinancialsSuccess>) as GetAccountFinancialsSuccess;
}

/**
 * Validate and normalize seeded account financials. Entries lacking a plain
 * `account` object or `currency` string are dropped with a warning.
 */
export function filterValidSeededAccountFinancials(
  raw: unknown,
  logger?: { warn: (message: string, meta?: Record<string, unknown>) => void }
): GetAccountFinancialsSuccess[] {
  if (!Array.isArray(raw)) {
    logger?.warn('testController.getSeededAccountFinancials did not return an array; skipping bridge', {
      received: typeof raw,
    });
    return [];
  }
  const valid: GetAccountFinancialsSuccess[] = [];
  raw.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      logger?.warn('testController.getSeededAccountFinancials entry is not an object; dropping', { index });
      return;
    }
    const e = entry as Record<string, unknown>;
    if (!e.account || typeof e.account !== 'object') {
      logger?.warn('testController.getSeededAccountFinancials entry missing account; dropping', { index });
      return;
    }
    if (typeof e.currency !== 'string' || e.currency.length === 0) {
      logger?.warn('testController.getSeededAccountFinancials entry missing currency; dropping', { index });
      return;
    }
    if (!e.period || typeof e.period !== 'object') {
      logger?.warn('testController.getSeededAccountFinancials entry missing period; dropping', { index });
      return;
    }
    if (typeof e.timezone !== 'string' || e.timezone.length === 0) {
      logger?.warn('testController.getSeededAccountFinancials entry missing timezone; dropping', { index });
      return;
    }
    valid.push(entry as GetAccountFinancialsSuccess);
  });
  return valid;
}

// ---------------------------------------------------------------------------
// list_creative_formats merge helpers
// ---------------------------------------------------------------------------

/**
 * Merge seeded creative formats into a `list_creative_formats` response
 * payload.
 *
 * Handler-returned formats come first; seeded entries append after deduping
 * by `format_id.agent_url + format_id.id` composite (`\0` separator — never
 * appears in URLs or IDs). On collision the seeded entry wins.
 * `pagination.total_count` (if present) is bumped by the number of
 * genuinely-new seeded entries.
 *
 * `ListCreativeFormatsResponse` has no top-level `sandbox` field per the
 * AdCP spec — no sandbox stamp is applied (matching the `list_accounts` /
 * `get_account_financials` pattern).
 */
export function mergeSeededCreativeFormatsIntoResponse(
  response: import('../types/tools.generated').ListCreativeFormatsResponse,
  seeded: readonly Format[]
): import('../types/tools.generated').ListCreativeFormatsResponse {
  if (!seeded.length) return response;
  if (!isListSuccessShape(response, 'formats')) return response;

  const seededKeys = new Set<string>();
  for (const f of seeded) {
    seededKeys.add(`${f.format_id.agent_url}\0${f.format_id.id}`);
  }

  const handlerFormats = Array.isArray(response.formats) ? response.formats : [];
  const handlerKeys = new Set<string>();
  for (const f of handlerFormats) {
    if (f?.format_id) handlerKeys.add(`${f.format_id.agent_url}\0${f.format_id.id}`);
  }
  const newlyAdded = seeded.reduce(
    (n, f) => (handlerKeys.has(`${f.format_id.agent_url}\0${f.format_id.id}`) ? n : n + 1),
    0
  );
  const retained = handlerFormats.filter(f => {
    if (!f?.format_id) return true;
    return !seededKeys.has(`${f.format_id.agent_url}\0${f.format_id.id}`);
  });

  return {
    ...response,
    formats: [...retained, ...seeded],
    pagination: bumpPaginationTotal(response.pagination, newlyAdded),
  };
}

/**
 * Validate and normalize seeded creative formats. Entries lacking a
 * `format_id` with string `agent_url` and `id` fields are dropped.
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
    const fid = (entry as { format_id?: unknown }).format_id;
    if (!fid || typeof fid !== 'object' || Array.isArray(fid)) {
      logger?.warn('testController.getSeededCreativeFormats entry missing format_id; dropping', { index });
      return;
    }
    const { agent_url, id } = fid as { agent_url?: unknown; id?: unknown };
    if (typeof agent_url !== 'string' || agent_url.length === 0) {
      logger?.warn('testController.getSeededCreativeFormats entry missing format_id.agent_url; dropping', { index });
      return;
    }
    if (typeof id !== 'string' || id.length === 0) {
      logger?.warn('testController.getSeededCreativeFormats entry missing format_id.id; dropping', { index });
      return;
    }
    valid.push(entry as Format);
  });
  return valid;
}

// ---------------------------------------------------------------------------
// applySeededBridge — dispatcher entry point used by createAdcpServer
// ---------------------------------------------------------------------------

/**
 * Table mapping each bridgeable tool to its callback, validator, and merge
 * helper. Used by {@link applySeededBridge} to consolidate the per-tool
 * dispatcher branches.
 *
 * The internal types use `any` because each row's callback/filter/merge are
 * type-aligned to a different success-response shape — bridging six row
 * shapes into one strongly-typed table costs more in conditional-type
 * complexity than the dispatcher gains. The merge helpers themselves are
 * strongly typed at their definition sites.
 */
type BridgeTableEntry = {
  toolName: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  callback: (bridge: TestControllerBridge<any>) => ((ctx: TestControllerBridgeContext<any>) => any) | undefined;
  filter: (raw: unknown, logger?: { warn: (message: string, meta?: Record<string, unknown>) => void }) => unknown[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  merge: (
    sc: any,
    seeded: any,
    logger?: { warn: (message: string, meta?: Record<string, unknown>) => void }
  ) => unknown;
};

const BRIDGE_TABLE: readonly BridgeTableEntry[] = [
  {
    toolName: 'get_products',
    callback: b => b.getSeededProducts,
    filter: filterValidSeededProducts,
    merge: (sc, seeded) => mergeSeededProductsIntoResponse(sc, seeded),
  },
  {
    toolName: 'list_creatives',
    callback: b => b.getSeededCreatives,
    filter: filterValidSeededCreatives,
    merge: (sc, seeded) => mergeSeededCreativesIntoResponse(sc, seeded),
  },
  {
    toolName: 'get_media_buys',
    callback: b => b.getSeededMediaBuys,
    filter: filterValidSeededMediaBuys,
    merge: (sc, seeded) => mergeSeededMediaBuysIntoResponse(sc, seeded),
  },
  {
    toolName: 'list_accounts',
    callback: b => b.getSeededAccounts,
    filter: filterValidSeededAccounts,
    merge: (sc, seeded) => mergeSeededAccountsIntoResponse(sc, seeded),
  },
  {
    toolName: 'get_account_financials',
    callback: b => b.getSeededAccountFinancials,
    filter: filterValidSeededAccountFinancials,
    merge: (sc, seeded, logger) => mergeSeededAccountFinancialsIntoResponse(sc, seeded, logger),
  },
  {
    toolName: 'list_creative_formats',
    callback: b => b.getSeededCreativeFormats,
    filter: filterValidSeededCreativeFormats,
    merge: (sc, seeded) => mergeSeededCreativeFormatsIntoResponse(sc, seeded),
  },
];

/**
 * Apply the test-controller bridge to a tool response, if one is registered
 * for `toolName` and the sandbox gate passes.
 *
 * Returns the (possibly augmented) wrapped response. The contract:
 *
 *   - If the tool is not in the bridge table, the bridge has no callback for
 *     it, the response is an error envelope, the request is not sandbox-
 *     flagged, or the resolved account is not sandbox: returns the original
 *     `formatted` unchanged.
 *   - If the callback throws or returns malformed data: logs a `warn` and
 *     returns the original `formatted`. Sandbox-only failures must not tank
 *     the request under test.
 *   - If the merge helper short-circuits (async/error arm, no genuinely-new
 *     seeded entries): the merged response is reference-equal to the input,
 *     and the original wrapped `formatted` is returned without re-wrapping
 *     (re-wrapping the same payload can produce a subtly different
 *     `content[].text` summary).
 *   - Otherwise: wraps the merged response and returns it.
 *
 * Gate-rejection (sandbox input but non-sandbox resolved account) emits a
 * `debug` log so adopters chasing "why aren't my fixtures showing" have a
 * diagnostic surface.
 */
export async function applySeededBridge<TAccount, Wrapped = unknown>(opts: {
  bridge: TestControllerBridge<TAccount>;
  toolName: string;
  formatted: Wrapped & { structuredContent?: unknown };
  params: Record<string, unknown>;
  account: TAccount | undefined;
  isError: boolean;
  isSandboxInput: boolean;
  logger: {
    warn: (message: string, meta?: Record<string, unknown>) => void;
    debug?: (message: string, meta?: Record<string, unknown>) => void;
  };
  wrap: (data: unknown) => Wrapped;
}): Promise<Wrapped> {
  const { bridge, toolName, formatted, params, account, isError, isSandboxInput, logger, wrap } = opts;

  const entry = BRIDGE_TABLE.find(e => e.toolName === toolName);
  if (!entry) return formatted;

  const callback = entry.callback(bridge);
  if (!callback) return formatted;
  if (isError) return formatted;
  if (!isSandboxInput) return formatted;

  // Sandbox-account gate: if resolveAccount produced a record, it MUST be
  // flagged sandbox. If undefined, isSandboxInput is the only defense.
  const accountIsSandbox =
    account === undefined ||
    (typeof account === 'object' && account !== null && (account as { sandbox?: unknown }).sandbox === true);
  if (!accountIsSandbox) {
    logger.debug?.('test-controller bridge: sandbox input but resolved account is not sandbox; skipping merge', {
      tool: toolName,
    });
    return formatted;
  }

  try {
    const bridgeCtx: TestControllerBridgeContext<TAccount> = { input: params };
    if (account !== undefined) bridgeCtx.account = account;
    const rawSeeded = await callback(bridgeCtx);
    const seeded = entry.filter(rawSeeded, logger);
    if (seeded.length === 0) return formatted;

    const sc = formatted.structuredContent;
    if (!sc || typeof sc !== 'object') return formatted;

    const merged = entry.merge(sc, seeded, logger);
    // Reference-equal means the helper short-circuited (async envelope,
    // wrong shape, etc.). Don't re-wrap or we mutate the `content[].text`.
    if (merged === sc) return formatted;
    return wrap(merged);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.warn(`testController.${toolName} bridge failed; returning handler response unchanged`, {
      tool: toolName,
      error: reason,
    });
    return formatted;
  }
}

// ---------------------------------------------------------------------------
// bridgeFromTestControllerStore — process-wide Map-backed bridge (products)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// bridgeFromSessionStore — session-scoped bridge (all entities)
// ---------------------------------------------------------------------------

/**
 * Options for {@link bridgeFromSessionStore}.
 *
 * Passed as an options object (rather than positional args) so future
 * additions land non-breakingly. `loadSession` receives the raw request —
 * distinct from any session-loader a seller writes elsewhere that takes
 * `{ context }`.
 */
export interface BridgeFromSessionStoreOptions<TSession> {
  /**
   * Resolve the session for the current request. Receives the raw request
   * post-schema-validation; pull whatever key you use (`session_id`,
   * `brand.domain`, `account_id`) out of `input.context` / `input.account`
   * / `input.brand` and return the session object. May be async.
   *
   * Errors propagate unchanged — a `loadSession` rejection fails the bridge
   * call rather than silently producing an empty seed list (seed loss under
   * DB failure would be worse than a loud error, and the storyboard runner
   * surfaces the failure).
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
   * Extract seeded creatives from a resolved session. Return an array (or
   * a Promise of one) of {@link SeededCreative} objects, or `null` /
   * `undefined` when nothing is seeded. Each entry must have a `creative_id`.
   */
  selectSeededCreatives?: (
    session: TSession
  ) => SeededCreative[] | Promise<SeededCreative[] | null | undefined> | null | undefined;

  /**
   * Extract seeded media buys from a resolved session. Return an array (or
   * a Promise of one) of {@link SeededMediaBuy} objects, or `null` /
   * `undefined` when nothing is seeded. Each entry must have a `media_buy_id`.
   */
  selectSeededMediaBuys?: (
    session: TSession
  ) => SeededMediaBuy[] | Promise<SeededMediaBuy[] | null | undefined> | null | undefined;

  /**
   * Extract seeded accounts from a resolved session. Return an array (or a
   * Promise of one) of account objects, or `null` / `undefined` when nothing
   * is seeded. Each entry must have an `account_id`.
   */
  selectSeededAccounts?: (
    session: TSession
  ) => SeededAccount[] | Promise<SeededAccount[] | null | undefined> | null | undefined;

  /**
   * Extract seeded account financials from a resolved session. Return an
   * array (or a Promise of one) of {@link GetAccountFinancialsSuccess} objects,
   * or `null` / `undefined` when nothing is seeded. The first valid entry is
   * deep-merged onto the handler's response.
   */
  selectSeededAccountFinancials?: (
    session: TSession
  ) => GetAccountFinancialsSuccess[] | Promise<GetAccountFinancialsSuccess[] | null | undefined> | null | undefined;

  /**
   * Extract seeded creative formats from a resolved session. Return an array
   * (or a Promise of one) of {@link Format} objects, or `null` / `undefined`
   * when nothing is seeded. Each entry must have a `format_id` with
   * `agent_url` and `id`.
   */
  selectSeededCreativeFormats?: (
    session: TSession
  ) => Format[] | Promise<Format[] | null | undefined> | null | undefined;
}

/**
 * Session-scoped variant of {@link bridgeFromTestControllerStore}.
 *
 * {@link bridgeFromTestControllerStore} closes over a single `Map` at
 * construction time — fine for a process-wide seed store, but doesn't
 * compose with sellers whose seed state is per-tenant / per-brand / per-
 * `account_id` and loaded from Postgres or Redis on every request.
 *
 * This helper covers the full set of bridgeable tools: `get_products`,
 * `list_creatives`, `get_media_buys`, `list_accounts`,
 * `get_account_financials`, and `list_creative_formats`. The five new
 * entity-type selectors (`selectSeededCreatives` et al.) are optional —
 * omit the ones you don't need. `selectSeededProducts` remains required
 * for backwards-compatibility with existing callers.
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
 *     selectSeededCreatives: (session) => session.complyExtensions.seededCreatives,
 *     selectSeededMediaBuys: (session) => session.complyExtensions.seededMediaBuys,
 *     selectSeededAccounts: (session) => session.complyExtensions.seededAccounts,
 *     selectSeededAccountFinancials: (session) => session.complyExtensions.seededFinancials,
 *     selectSeededCreativeFormats: (session) => session.complyExtensions.seededFormats,
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

  return {
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

    getSeededCreatives: selectSeededCreatives
      ? async ctx => {
          const session = await loadSession(ctx.input);
          const entries = await selectSeededCreatives(session);
          return entries ?? [];
        }
      : undefined,

    getSeededMediaBuys: selectSeededMediaBuys
      ? async ctx => {
          const session = await loadSession(ctx.input);
          const entries = await selectSeededMediaBuys(session);
          return entries ?? [];
        }
      : undefined,

    getSeededAccounts: selectSeededAccounts
      ? async ctx => {
          const session = await loadSession(ctx.input);
          const entries = await selectSeededAccounts(session);
          return entries ?? [];
        }
      : undefined,

    getSeededAccountFinancials: selectSeededAccountFinancials
      ? async ctx => {
          const session = await loadSession(ctx.input);
          const entries = await selectSeededAccountFinancials(session);
          return entries ?? [];
        }
      : undefined,

    getSeededCreativeFormats: selectSeededCreativeFormats
      ? async ctx => {
          const session = await loadSession(ctx.input);
          const entries = await selectSeededCreativeFormats(session);
          return entries ?? [];
        }
      : undefined,
  };
}
