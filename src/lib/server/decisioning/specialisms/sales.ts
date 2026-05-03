/**
 * SalesPlatform — sales specialism platform interface.
 *
 * **Unified hybrid shape.** `create_media_buy` and `sync_creatives` use a
 * single method each. The method returns the wire success arm (sync fast
 * path) OR `ctx.handoffToTask(fn)` to promote the call to a background
 * task (HITL slow path). Branch per-call — the same method handles
 * programmatic remnant, guaranteed inventory, and hybrid sellers. Every
 * other tool is sync-only:
 *
 *   - `get_products` — sync. Brief in, products out.
 *   - `create_media_buy` — sync OR `ctx.handoffToTask(...)`.
 *   - `update_media_buy` — sync only. Re-approval flows that need HITL run
 *     out-of-band; `publishStatusChange` carries the result.
 *   - `sync_creatives` — sync OR `ctx.handoffToTask(...)`.
 *   - `get_media_buy_delivery` — sync only.
 *
 * Sync-only tools that need long-running semantics use `publishStatusChange`
 * (see `status-changes.ts`) — that's the spec-aligned channel for tools
 * whose wire response unions don't define a Submitted arm.
 *
 * Each method either returns the value or throws `AdcpError` for structured
 * rejection. Generic thrown errors map to `SERVICE_UNAVAILABLE`.
 *
 * **Method groups** — implement the group(s) matching your specialism:
 *
 * | Group | Methods | Claim when |
 * |---|---|---|
 * | Core sales (required) | `getProducts`, `updateMediaBuy`, `getMediaBuyDelivery` | Any `sales-*` specialism |
 * | Core sales (unified hybrid) | `createMediaBuy` | Any `sales-*` specialism |
 * | Core sales (unified hybrid) | `syncCreatives` | Any `sales-*` specialism |
 * | Read / feedback | `getMediaBuys`, `providePerformanceFeedback`, `listCreativeFormats`, `listCreatives` | Most sellers; optional |
 * | Retail-media extensions | `syncCatalogs`, `logEvent`, `syncEventSources` | `sales-catalog-driven`, `sales-retail-media` |
 *
 * New adopters implementing a non-retail seller (GAM, FreeWheel, a social
 * platform) only need the three core-required methods plus `createMediaBuy`
 * and `syncCreatives`. The retail-media extension methods (`syncCatalogs`,
 * `logEvent`, `syncEventSources`) are unnecessary unless you claim
 * `sales-catalog-driven` or `sales-retail-media`.
 *
 * **No-account tools (`providePerformanceFeedback`, `listCreativeFormats`):**
 * the wire requests for these two tools don't carry an `account` field, so
 * `ctx.account` may be `undefined` when `accounts.resolution === 'explicit'`.
 * Three safe patterns:
 *
 * 1. **`'derived'` resolution** — `accounts.resolve(undefined)` returns a
 *    singleton; `ctx.account` is always set. Best for single-tenant
 *    deployers.
 * 2. **Don't implement the method** — the framework returns
 *    `UNSUPPORTED_FEATURE`; buyers using the merge-seam custom handler or
 *    external creative agents still receive a response.
 * 3. **Explicit-mode with defensive read** — cast `ctx.account as Account |
 *    undefined` and derive the account from the request body (e.g., via a
 *    `media_buy_id` lookup), or throw `AdcpError('ACCOUNT_NOT_FOUND')`.
 *    Full `resolveAccount(undefined, { authInfo, toolName })` support for
 *    explicit-mode lands in rc.1.
 *
 * Status: Preview / 6.0.
 *
 * @public
 */

import type { Account, NoAccountCtx } from '../account';
import type { RequestContext } from '../context';
import type { TaskHandoff } from '../async-outcome';
import type {
  GetProductsRequest,
  GetProductsResponse,
  CreateMediaBuyRequest,
  CreateMediaBuySuccess,
  UpdateMediaBuyRequest,
  UpdateMediaBuySuccess,
  GetMediaBuysRequest,
  GetMediaBuysResponse,
  GetMediaBuyDeliveryRequest,
  GetMediaBuyDeliveryResponse,
  ProvidePerformanceFeedbackRequest,
  ProvidePerformanceFeedbackSuccess,
  ListCreativeFormatsRequest,
  ListCreativeFormatsResponse,
  ListCreativesRequest,
  ListCreativesResponse,
  SyncCatalogsRequest,
  SyncCatalogsSuccess,
  LogEventRequest,
  LogEventSuccess,
  SyncEventSourcesRequest,
  SyncEventSourcesSuccess,
  SyncCreativesSuccess,
  CreativeAsset,
} from '../../../types/tools.generated';

type Creative = CreativeAsset;
type Ctx<TCtxMeta> = RequestContext<Account<TCtxMeta>>;

/**
 * Wire success-row shape for `sync_creatives`. Returning the array of these
 * rows from `syncCreatives` is what adopters write — the framework wraps
 * with `{ creatives: [...] }` to form `SyncCreativesSuccess`.
 */
export type SyncCreativesRow = SyncCreativesSuccess['creatives'][number];

export interface SalesPlatform<TCtxMeta = Record<string, unknown>> {
  // **Method shape — all optional, enforced per-specialism.** Every method on
  // `SalesPlatform` is declared optional so the type accommodates non-media-
  // buy walled gardens (sales-social, audience-sync, sales-proposal-mode)
  // that don't accept inbound media buys but compose ingestion methods on
  // this same surface. Compile-time enforcement of "you claimed
  // sales-non-guaranteed, therefore you MUST implement getProducts /
  // createMediaBuy / updateMediaBuy / getMediaBuyDelivery / getMediaBuys"
  // moves up to `RequiredPlatformsFor<S>` — see the {@link SalesCorePlatform}
  // type alias and the per-specialism mapping in `platform.ts`. Runtime
  // enforcement is preserved: the dispatcher returns `UNSUPPORTED_FEATURE`
  // for tools whose method is absent, and `validateSpecialismRequiredTools`
  // throws / warns when a specialism's required tools aren't implemented.
  //
  // Adopters who implement the full media-buy surface keep working — their
  // implementation is a superset of every per-specialism requirement.
  // Adopters who only do ingestion (e.g. a Meta CAPI integration claiming
  // `sales-social`) drop the 5 core stubs without compile errors.

  // ── get_products: sync only — by design, not just by spec ─────────
  // get_products is a CATALOG LOOKUP — fast read against the seller's
  // existing inventory. It is NOT the right wire surface for proposal
  // generation (brief-to-pitch creative workflows that produce new
  // products tailored to the buyer's request). Those are different
  // verbs in the AdCP buyer's vocabulary and conflating them is a
  // buyer-predictability tax: a buyer calling get_products for fast
  // catalog filtering against a proposal-mode tenant gets a slow
  // response they didn't expect.
  //
  // The SDK keeps get_products sync-only deliberately, even when
  // adcp#3392 lands consolidated Submitted arms for the OTHER 5 HITL
  // tools (create_media_buy, update_media_buy, sync_creatives,
  // sync_catalogs, build_creative). For proposal generation, file
  // adcp#3407 advocates a separate `request_proposal` wire tool with
  // explicit Submitted-only semantics.
  //
  // Until that lands: long-form proposal flows surface the eventual
  // proposal via per-account notification channels (`publishStatusChange`
  // on `resource_type: 'proposal'`). Adopters running proposal-mode
  // workflows declare it via `capabilities` so buyers can route
  // appropriately before the first call.
  /** Sync catalog lookup: filters in, products out. NOT for proposal generation. */
  getProducts?(req: GetProductsRequest, ctx: Ctx<TCtxMeta>): Promise<GetProductsResponse>;

  // ── create_media_buy: unified hybrid shape ──────────────────────────

  /**
   * Create a media buy. Return the wire success-arm shape (sync fast path)
   * OR `ctx.handoffToTask(fn)` to promote the call to a background task
   * (HITL slow path). Adopters can branch per-call: hybrid sellers route
   * programmatic remnant sync, guaranteed inventory through HITL, all
   * from the same method.
   *
   * Buyers pattern-match on the wire response shape (`media_buy_id` on
   * the immediate response → sync; `task_id` + `status: 'submitted'` →
   * poll `tasks_get` or receive webhook). Predictable per request,
   * dynamic per call.
   *
   * Status changes flow via `publishStatusChange(...)` regardless of
   * which path was taken.
   *
   * The handoff function's return value is persisted as JSONB in the
   * task registry. Postgres-backed registries cap row size at 4MB —
   * offload large payloads to blob storage and return references.
   *
   * @example Sync-only adopter (no HITL inventory)
   * ```ts
   * createMediaBuy: async (req, ctx) => {
   *   return await this.commitSync(req);
   * }
   * ```
   *
   * @example HITL-only adopter (every call goes through trafficker review)
   * ```ts
   * createMediaBuy: async (req, ctx) => {
   *   return ctx.handoffToTask(async (taskCtx) => {
   *     await taskCtx.update({ message: 'Awaiting trafficker' });
   *     return await this.runHITL(req);
   *   });
   * }
   * ```
   *
   * @example Hybrid adopter (programmatic + guaranteed in same tenant)
   * ```ts
   * createMediaBuy: async (req, ctx) => {
   *   if (this.requiresHITL(req)) {
   *     return ctx.handoffToTask(async (taskCtx) => await this.runHITL(req));
   *   }
   *   return await this.commitSync(req);
   * }
   * ```
   */
  createMediaBuy?(
    req: CreateMediaBuyRequest,
    ctx: Ctx<TCtxMeta>
  ): Promise<CreateMediaBuySuccess | TaskHandoff<CreateMediaBuySuccess>>;

  // ── update_media_buy: sync only (today) ─────────────────────────────
  // Spec inconsistency — same root cause as get_products above. The
  // `UpdateMediaBuyAsyncSubmitted` schema exists, but the per-tool
  // `update-media-buy-response.json` `oneOf` doesn't reference it, so
  // codegen produces `Success | Error` (no Submitted). Tracked as
  // adcontextprotocol/adcp#3392. Until that lands, operator
  // re-approval flows surface eventual transitions via
  // `publishStatusChange` on `resource_type: 'media_buy'` rather than
  // HITL on this tool.
  /** Sync update. Returns the patched buy. */
  updateMediaBuy?(buyId: string, patch: UpdateMediaBuyRequest, ctx: Ctx<TCtxMeta>): Promise<UpdateMediaBuySuccess>;

  // ── sync_creatives: unified hybrid shape ────────────────────────────

  /**
   * Push creatives. Return the array of wire success rows (sync fast
   * path) OR `ctx.handoffToTask(fn)` to defer to a background task
   * (HITL slow path — manual review, brand-suitability gates, etc.).
   * Hybrid: branch per-batch — auto-approve simple creatives sync,
   * route everything else to HITL.
   *
   * Each row carries `action` (CRUD outcome) and optional `status`
   * (review state). Buyers see mixed `approved` / `pending_review`
   * rows on the sync path; subsequent review changes flow via
   * `publishStatusChange(...)`.
   *
   * @example Hybrid adopter
   * ```ts
   * syncCreatives: async (creatives, ctx) => {
   *   if (creatives.some(c => this.needsReview(c))) {
   *     return ctx.handoffToTask(async (taskCtx) => {
   *       return await this.reviewAndPersist(creatives);
   *     });
   *   }
   *   return creatives.map(c => ({ creative_id: c.creative_id, action: 'created', status: 'approved' }));
   * }
   * ```
   */
  syncCreatives?(
    creatives: Creative[],
    ctx: Ctx<TCtxMeta>
  ): Promise<SyncCreativesRow[] | TaskHandoff<SyncCreativesRow[]>>;

  // ── get_media_buy_delivery: sync only ───────────────────────────────

  /**
   * Per-media-buy delivery actuals (impressions, spend, pacing,
   * conversions). Sync — report-running platforms with manual report
   * cycles return the latest cached actuals and emit `delivery_report`
   * status changes via `publishStatusChange` when fresh reports are
   * available.
   *
   * **Multi-id contract.** `filter.media_buy_ids` is an array — buyers
   * routinely request delivery for multiple buys in one call. The
   * platform MUST iterate every id and return one element per id in
   * `media_buy_deliveries[]`. Implementations that read only
   * `media_buy_ids[0]` silently truncate the buyer's request — a
   * correctness bug that has bitten multiple adopters (closes #1342).
   *
   * Pass-through is the framework contract: the platform owns fan-out
   * because `aggregated_totals` requires platform-domain knowledge —
   * `reach` (cross-buy dedup capability), `new_to_brand_rate` (weighted
   * across buys, not a per-buy average), and `frequency` (depends on
   * dedup) cannot be synthesized correctly by a naive framework loop.
   * Sellers that can't compute the cross-buy fields omit them and emit
   * the safely-summable fields (`impressions`, `spend`, `clicks`,
   * `media_buy_count`); buyers fall back to per-buy values when needed.
   *
   * Recommended pattern:
   *
   * ```ts
   * getMediaBuyDelivery: async (req, ctx) => {
   *   const ids = req.media_buy_ids ?? [];
   *   const deliveries = await Promise.all(ids.map(id => fetchOne(id, ctx)));
   *   return {
   *     reporting_period: { start, end },
   *     currency: 'USD',
   *     media_buy_deliveries: deliveries,
   *     aggregated_totals: sumNumericFields(deliveries),
   *   };
   * }
   * ```
   *
   * When `media_buy_ids` is omitted, return a paginated set of
   * accessible media buys per the wire schema. `status_filter`
   * defaults to `['active']` when omitted; honor the filter in your
   * iteration.
   */
  getMediaBuyDelivery?(filter: GetMediaBuyDeliveryRequest, ctx: Ctx<TCtxMeta>): Promise<GetMediaBuyDeliveryResponse>;

  // ── get_media_buys: sync only — REQUIRED ──────────────────────────────
  // Read tool — buyers fetch a list of their media buys (often filtered by
  // status / time window). Required because:
  //   1. Every seller needs to support reading back what they created.
  //   2. Idempotent retries depend on it (replay safe-by-design).
  //   3. The 6.2 patch-decomposition redesign needs single-id reads;
  //      `getMediaBuys` is the foundation.
  //   4. Framework auto-stores returned media buys for hydration on
  //      subsequent updateMediaBuy calls (see `hydratePackagesWithProducts`
  //      pattern in `from-platform.ts`).
  //
  // Proposal-mode adopters (write-only via push channels) return an empty
  // `media_buys: []` array — that's a valid response.
  /** List media buys this account owns. Filter + pagination per the wire shape. */
  getMediaBuys?(req: GetMediaBuysRequest, ctx: Ctx<TCtxMeta>): Promise<GetMediaBuysResponse>;

  // ── provide_performance_feedback: sync only ─────────────────────────
  // Write tool — buyers report aggregate creative-level performance
  // (impressions, clicks, conversions) to help the seller's optimizer learn.
  // Optional because not every sales agent runs an optimizer, but every
  // buyer expects to be able to call it. Framework returns UNSUPPORTED_FEATURE
  // when omitted.
  //
  // ⚠️  NO-ACCOUNT TOOL — `ctx: NoAccountCtx<TCtxMeta>`. The wire request
  // does not carry an `account` field. `ctx.account` may be `undefined` for
  // `'explicit'`-resolution adopters; narrow before reading
  // `ctx.account.ctx_metadata`. See {@link NoAccountCtx} and the
  // `SalesPlatform` JSDoc ("No-account tools") for safe patterns.
  /** Accept buyer-side performance signals on a media buy / creative. */
  providePerformanceFeedback?(
    req: ProvidePerformanceFeedbackRequest,
    ctx: NoAccountCtx<TCtxMeta>
  ): Promise<ProvidePerformanceFeedbackSuccess>;

  // ── list_creative_formats: sync only ────────────────────────────────
  // Discovery tool — buyers query what creative formats this seller
  // accepts. Optional because sellers that delegate to external
  // `creative_agents` (declared in `capabilities.creative_agents[]`) don't
  // own format definitions; framework can resolve from the declared agents.
  // Self-hosted sellers (own creative library) implement this directly.
  //
  // ⚠️  NO-ACCOUNT TOOL — `ctx: NoAccountCtx<TCtxMeta>`. See
  // `providePerformanceFeedback` note above.
  listCreativeFormats?(
    req: ListCreativeFormatsRequest,
    ctx: NoAccountCtx<TCtxMeta>
  ): Promise<ListCreativeFormatsResponse>;

  // ── list_creatives: sync only ───────────────────────────────────────
  // Read tool — buyers query the seller's creative library. Optional
  // because most sales adopters delegate creative state to the
  // `creative_agents` declared in capabilities; ad-server-style sales
  // platforms implement directly. Note: also lives on `CreativeAdServerPlatform.listCreatives`
  // for the standalone-creative-agent shape.
  listCreatives?(req: ListCreativesRequest, ctx: Ctx<TCtxMeta>): Promise<ListCreativesResponse>;

  // ── sync_catalogs: sync only ────────────────────────────────────────
  // Retail-media catalog sync. Buyers push product catalogs (SKUs, ASINs,
  // store-ids) for `sales-catalog-driven` agents (Amazon, Criteo, Citrusad,
  // Walmart Connect, Shopify ad surfaces). Optional — non-retail sales
  // adopters omit. Idempotent on the buyer's `idempotency_key`.
  syncCatalogs?(req: SyncCatalogsRequest, ctx: Ctx<TCtxMeta>): Promise<SyncCatalogsSuccess>;

  // ── log_event: sync only ────────────────────────────────────────────
  // Conversion / engagement event logging. Buyers post events tied to
  // a `media_buy_id` for performance attribution. Used by retail-media
  // (post-purchase events) and conversion-tracked sales (Snap pixel,
  // Meta CAPI, LinkedIn conversions API). Optional.
  logEvent?(req: LogEventRequest, ctx: Ctx<TCtxMeta>): Promise<LogEventSuccess>;

  // ── sync_event_sources: sync only ──────────────────────────────────
  // Register conversion event sources (websites, apps, offline pixel
  // IDs) so subsequent `log_event` calls can be attributed correctly.
  // Optional — adopters who don't expose conversion tracking omit.
  syncEventSources?(req: SyncEventSourcesRequest, ctx: Ctx<TCtxMeta>): Promise<SyncEventSourcesSuccess>;
}

/**
 * Names the **core sales surface** — bidding + media-buy lifecycle. Required
 * for `sales-*` specialisms that own pricing/pacing
 * (`sales-non-guaranteed`, `sales-guaranteed`, `sales-broadcast-tv`,
 * `sales-streaming-tv`, `sales-exchange`, `sales-catalog-driven`,
 * `sales-retail-media`).
 *
 * Walled-garden specialisms whose value surface is asset ingestion
 * (`sales-social`, the `audience-sync` track, pure conversion-tracking
 * adopters) DON'T need to implement these — see {@link SalesIngestionPlatform}.
 *
 * Used by `RequiredPlatformsFor<S>` to pick the right slice of `SalesPlatform`
 * per claimed specialism.
 *
 * @public
 */
export type SalesCorePlatform<TCtxMeta = Record<string, unknown>> = Required<
  Pick<
    SalesPlatform<TCtxMeta>,
    'getProducts' | 'createMediaBuy' | 'updateMediaBuy' | 'getMediaBuyDelivery' | 'getMediaBuys'
  >
>;

/**
 * Names the **asset-ingestion surface** — sync surfaces for creatives,
 * audiences (via {@link import('./audiences').AudiencePlatform}), catalogs,
 * events, plus the read/feedback tools. Walled-garden specialisms
 * (`sales-social`) live here.
 *
 * Every method is optional individually. Adopters claiming `sales-social`
 * pick whichever ingestion surfaces apply (typically `syncCreatives` +
 * `logEvent` + `syncEventSources`); the rest stay omitted.
 *
 * Used by `RequiredPlatformsFor<S>` so claiming `sales-social` only requires
 * this slice of `SalesPlatform`, not the full {@link SalesCorePlatform}.
 *
 * @public
 */
export type SalesIngestionPlatform<TCtxMeta = Record<string, unknown>> = Pick<
  SalesPlatform<TCtxMeta>,
  | 'syncCreatives'
  | 'syncCatalogs'
  | 'syncEventSources'
  | 'logEvent'
  | 'listCreativeFormats'
  | 'listCreatives'
  | 'providePerformanceFeedback'
>;
