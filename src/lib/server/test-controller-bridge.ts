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
  getSeededAccounts?: (
    ctx: TestControllerBridgeContext<TAccount>
  ) => Promise<ListAccountsResponse['accounts'][number][]> | ListAccountsResponse['accounts'][number][];

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
 * `query_summary.returned` count is updated to match the merged array length.
 * The `sandbox: true` flag is stamped unless the handler explicitly set
 * `sandbox: false`.
 */
export function mergeSeededCreativesIntoResponse(
  response: ListCreativesResponse,
  seeded: readonly SeededCreative[]
): ListCreativesResponse {
  if (!seeded.length) return response;

  const seededIds = new Set<string>();
  for (const c of seeded) seededIds.add(c.creative_id);

  const handlerCreatives = Array.isArray(response.creatives) ? response.creatives : [];
  const retained = handlerCreatives.filter(c => !seededIds.has(c?.creative_id));
  const mergedList = [...retained, ...seeded];

  return {
    ...response,
    creatives: mergedList,
    query_summary: {
      ...response.query_summary,
      returned: mergedList.length,
    },
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
 * by `media_buy_id`. On collision the seeded entry wins. The `sandbox: true`
 * flag is stamped unless the handler explicitly set `sandbox: false`.
 */
export function mergeSeededMediaBuysIntoResponse(
  response: GetMediaBuysResponse,
  seeded: readonly SeededMediaBuy[]
): GetMediaBuysResponse {
  if (!seeded.length) return response;

  const seededIds = new Set<string>();
  for (const m of seeded) seededIds.add(m.media_buy_id);

  const handlerBuys = Array.isArray(response.media_buys) ? response.media_buys : [];
  const retained = handlerBuys.filter(m => !seededIds.has(m?.media_buy_id));

  return {
    ...response,
    media_buys: [...retained, ...seeded],
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
 *
 * `ListAccountsResponse` has no top-level `sandbox` field, so no sandbox
 * stamp is applied (unlike the list-creatives and list-media-buys helpers).
 */
export function mergeSeededAccountsIntoResponse(
  response: ListAccountsResponse,
  seeded: readonly ListAccountsResponse['accounts'][number][]
): ListAccountsResponse {
  if (!seeded.length) return response;

  const seededIds = new Set<string>();
  for (const a of seeded) seededIds.add(a.account_id);

  const handlerAccounts = Array.isArray(response.accounts) ? response.accounts : [];
  const retained = handlerAccounts.filter(a => !seededIds.has(a?.account_id));

  return {
    ...response,
    accounts: [...retained, ...seeded],
  };
}

/**
 * Validate and normalize seeded accounts. Entries missing `account_id` or
 * that are not plain objects are dropped with a warning.
 */
export function filterValidSeededAccounts(
  raw: unknown,
  logger?: { warn: (message: string, meta?: Record<string, unknown>) => void }
): ListAccountsResponse['accounts'][number][] {
  if (!Array.isArray(raw)) {
    logger?.warn('testController.getSeededAccounts did not return an array; skipping bridge', {
      received: typeof raw,
    });
    return [];
  }
  const valid: ListAccountsResponse['accounts'][number][] = [];
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
    valid.push(entry as ListAccountsResponse['accounts'][number]);
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
  seeded: readonly GetAccountFinancialsSuccess[]
): GetAccountFinancialsSuccess {
  if (!seeded.length) return response;
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
 * by `format_id.agent_url + format_id.id` composite. On collision the seeded
 * entry wins. The `sandbox: true` flag is stamped unless the handler
 * explicitly set `sandbox: false`.
 */
export function mergeSeededCreativeFormatsIntoResponse(
  response: import('../types/tools.generated').ListCreativeFormatsResponse,
  seeded: readonly Format[]
): import('../types/tools.generated').ListCreativeFormatsResponse {
  if (!seeded.length) return response;

  const seededKeys = new Set<string>();
  for (const f of seeded) {
    seededKeys.add(`${f.format_id.agent_url}\0${f.format_id.id}`);
  }

  const handlerFormats = Array.isArray(response.formats) ? response.formats : [];
  const retained = handlerFormats.filter(f => {
    if (!f?.format_id) return true;
    return !seededKeys.has(`${f.format_id.agent_url}\0${f.format_id.id}`);
  });

  return {
    ...response,
    formats: [...retained, ...seeded],
    sandbox: response.sandbox !== false ? true : response.sandbox,
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
  ) =>
    | ListAccountsResponse['accounts'][number][]
    | Promise<ListAccountsResponse['accounts'][number][] | null | undefined>
    | null
    | undefined;

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
