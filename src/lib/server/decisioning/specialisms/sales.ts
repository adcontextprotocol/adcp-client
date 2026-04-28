/**
 * SalesPlatform — sales specialism platform interface (v2.1).
 *
 * **HITL coverage matches the AdCP wire spec.** Only `create_media_buy` and
 * `sync_creatives` define `Submitted` arms in their sync response unions;
 * those are the two tools where the v2.1 dual-method shape applies. Every
 * other tool is sync-only:
 *
 *   - `get_products` — sync. Brief in, products out.
 *   - `create_media_buy` — sync OR `*Task` HITL.
 *   - `update_media_buy` — sync only. Re-approval flows that need HITL run
 *     out-of-band; `publishStatusChange` carries the result.
 *   - `sync_creatives` — sync OR `*Task` HITL.
 *   - `get_media_buy_delivery` — sync only.
 *
 * For the two HITL-eligible tools, adopter implements EXACTLY ONE per pair:
 *
 *   - **Sync variant** (`xxx`): adopter returns the wire success arm
 *     synchronously. Framework awaits in foreground; projects the value to
 *     the wire response. Lifecycle changes flow via `publishStatusChange(...)`.
 *
 *   - **HITL variant** (`xxxTask`): framework allocates `taskId` BEFORE
 *     calling the platform, returns the spec-defined submitted envelope
 *     (`{ status: 'submitted', task_id }`) to the buyer immediately, then
 *     runs the task method in background. Method's return value becomes
 *     the task's terminal artifact.
 *
 * Sync-only tools that need long completion semantics use
 * `publishStatusChange` (see `status-changes.ts`) — that's the spec-aligned
 * channel for tools whose wire response unions don't define a Submitted
 * arm. See `docs/proposals/decisioning-platform-v2-hitl-split.md`
 * § "v2.1 spec-alignment" for rationale.
 *
 * Each method either returns the value or throws `AdcpError` for structured
 * rejection. Generic thrown errors map to `SERVICE_UNAVAILABLE`.
 *
 * **Method groups** — implement the group(s) matching your specialism:
 *
 * | Group | Methods | Claim when |
 * |---|---|---|
 * | Core sales (required) | `getProducts`, `updateMediaBuy`, `getMediaBuyDelivery` | Any `sales-*` specialism |
 * | Core sales (one-of pair) | `createMediaBuy` **or** `createMediaBuyTask` | Any `sales-*` specialism |
 * | Core sales (one-of pair) | `syncCreatives` **or** `syncCreativesTask` | Any `sales-*` specialism |
 * | Read / feedback | `getMediaBuys`, `providePerformanceFeedback`, `listCreativeFormats`, `listCreatives` | Most sellers; optional |
 * | Retail-media extensions | `syncCatalogs`, `logEvent`, `syncEventSources` | `sales-catalog-driven`, `sales-retail-media` |
 *
 * New adopters implementing a non-retail seller (GAM, FreeWheel, a social
 * platform) only need the three core-required methods plus one pair each
 * for `createMediaBuy` and `syncCreatives`. The retail-media extension
 * methods (`syncCatalogs`, `logEvent`, `syncEventSources`) are unnecessary
 * unless you claim `sales-catalog-driven` or `sales-retail-media`.
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

import type { Account } from '../account';
import type { RequestContext } from '../context';
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
type Ctx<TMeta> = RequestContext<Account<TMeta>>;

/**
 * Wire success-row shape for `sync_creatives`. Returning the array of these
 * rows from `syncCreatives` is what adopters write — the framework wraps
 * with `{ creatives: [...] }` to form `SyncCreativesSuccess`.
 */
export type SyncCreativesRow = SyncCreativesSuccess['creatives'][number];

export interface SalesPlatform<TMeta = Record<string, unknown>> {
  // ── get_products: sync only (today) ─────────────────────────────────
  // Spec defines a Submitted arm in `async-response-data.json`
  // (`GetProductsAsyncSubmitted`), but the per-tool
  // `get-products-response.json` doesn't include Submitted in its
  // `oneOf` — so codegen produces a `Success`-only shape, and the SDK
  // can't route HITL get_products dispatch with type safety until the
  // spec inconsistency is resolved.
  //
  // This is a SPEC issue, not a codegen bug — codegen faithfully
  // reflects the per-tool wire schema. Filed upstream as
  // adcontextprotocol/adcp#3392.
  //
  // Long-form discovery flows (proposal-mode sales agents, broadcast
  // TV) surface the eventual proposal via per-account notification
  // channels (`publishStatusChange` on `resource_type: 'proposal'`)
  // rather than HITL on this tool.
  /** Sync discovery: brief in, products out. */
  getProducts(req: GetProductsRequest, ctx: Ctx<TMeta>): Promise<GetProductsResponse>;

  // ── create_media_buy: sync OR task ──────────────────────────────────

  /**
   * Sync media-buy creation. Return the wire success-arm shape immediately.
   * Status changes (pending_creatives → active → completed) flow via
   * `publishStatusChange(...)` after creation.
   *
   * Required: `media_buy_id`. Other fields optional — populate the ones
   * your platform tracks at creation time.
   */
  createMediaBuy?(req: CreateMediaBuyRequest, ctx: Ctx<TMeta>): Promise<CreateMediaBuySuccess>;

  /**
   * HITL media-buy creation. Framework returns the submitted envelope to
   * the buyer; this method runs in background. Method's return value
   * becomes the task's terminal artifact.
   *
   * Return value is persisted as JSONB in the task registry. Postgres-backed
   * registries cap row size at 4MB — offload large payloads to blob
   * storage and return references in the result body instead. Oversized
   * returns surface via `onTaskTransition` with
   * `errorCode: 'REGISTRY_WRITE_FAILED'` and skip webhook delivery.
   */
  createMediaBuyTask?(req: CreateMediaBuyRequest, ctx: Ctx<TMeta>): Promise<CreateMediaBuySuccess>;

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
  updateMediaBuy(buyId: string, patch: UpdateMediaBuyRequest, ctx: Ctx<TMeta>): Promise<UpdateMediaBuySuccess>;

  // ── sync_creatives: sync OR task ────────────────────────────────────

  /**
   * Sync creative push. Returns the array of wire success rows — one per
   * creative processed. Each row carries `action` (CRUD outcome) and
   * optional `status` (review state). Buyers see mixed `approved` /
   * `pending_review` rows in one response. Subsequent review state changes
   * flow via `publishStatusChange(...)`.
   */
  syncCreatives?(creatives: Creative[], ctx: Ctx<TMeta>): Promise<SyncCreativesRow[]>;

  /**
   * HITL creative review. Framework returns the submitted envelope to the
   * buyer; this method runs in background. Returns per-creative result rows
   * once review is complete.
   *
   * Return value is persisted as JSONB in the task registry. Postgres-backed
   * registries cap row size at 4MB — return per-creative result rows
   * (not full creative bodies) to stay well under the cap.
   */
  syncCreativesTask?(creatives: Creative[], ctx: Ctx<TMeta>): Promise<SyncCreativesRow[]>;

  // ── get_media_buy_delivery: sync only ───────────────────────────────

  getMediaBuyDelivery(filter: GetMediaBuyDeliveryRequest, ctx: Ctx<TMeta>): Promise<GetMediaBuyDeliveryResponse>;

  // ── get_media_buys: sync only ───────────────────────────────────────
  // Read tool — buyers fetch a list of their media buys (often filtered by
  // status / time window). Optional because some sales agents are write-only
  // (proposal-mode adopters who deliver via push channels), but the vast
  // majority of seller agents implement this. Framework returns
  // UNSUPPORTED_FEATURE when omitted.
  /** List media buys this account owns. Filter + pagination per the wire shape. */
  getMediaBuys?(req: GetMediaBuysRequest, ctx: Ctx<TMeta>): Promise<GetMediaBuysResponse>;

  // ── provide_performance_feedback: sync only ─────────────────────────
  // Write tool — buyers report aggregate creative-level performance
  // (impressions, clicks, conversions) to help the seller's optimizer learn.
  // Optional because not every sales agent runs an optimizer, but every
  // buyer expects to be able to call it. Framework returns UNSUPPORTED_FEATURE
  // when omitted.
  //
  // ⚠️  NO-ACCOUNT TOOL. The wire request does not carry an `account` field.
  // `ctx.account` is undefined for `'explicit'`-resolution adopters.
  // See the `SalesPlatform` JSDoc ("No-account tools") for safe patterns.
  /** Accept buyer-side performance signals on a media buy / creative. */
  providePerformanceFeedback?(
    req: ProvidePerformanceFeedbackRequest,
    ctx: Ctx<TMeta>
  ): Promise<ProvidePerformanceFeedbackSuccess>;

  // ── list_creative_formats: sync only ────────────────────────────────
  // Discovery tool — buyers query what creative formats this seller
  // accepts. Optional because sellers that delegate to external
  // `creative_agents` (declared in `capabilities.creative_agents[]`) don't
  // own format definitions; framework can resolve from the declared agents.
  // Self-hosted sellers (own creative library) implement this directly.
  //
  // ⚠️  NO-ACCOUNT TOOL. See `providePerformanceFeedback` note above.
  listCreativeFormats?(req: ListCreativeFormatsRequest, ctx: Ctx<TMeta>): Promise<ListCreativeFormatsResponse>;

  // ── list_creatives: sync only ───────────────────────────────────────
  // Read tool — buyers query the seller's creative library. Optional
  // because most sales adopters delegate creative state to the
  // `creative_agents` declared in capabilities; ad-server-style sales
  // platforms implement directly. Note: also lives on `CreativeAdServerPlatform.listCreatives`
  // for the standalone-creative-agent shape.
  listCreatives?(req: ListCreativesRequest, ctx: Ctx<TMeta>): Promise<ListCreativesResponse>;

  // ── sync_catalogs: sync only ────────────────────────────────────────
  // Retail-media catalog sync. Buyers push product catalogs (SKUs, ASINs,
  // store-ids) for `sales-catalog-driven` agents (Amazon, Criteo, Citrusad,
  // Walmart Connect, Shopify ad surfaces). Optional — non-retail sales
  // adopters omit. Idempotent on the buyer's `idempotency_key`.
  syncCatalogs?(req: SyncCatalogsRequest, ctx: Ctx<TMeta>): Promise<SyncCatalogsSuccess>;

  // ── log_event: sync only ────────────────────────────────────────────
  // Conversion / engagement event logging. Buyers post events tied to
  // a `media_buy_id` for performance attribution. Used by retail-media
  // (post-purchase events) and conversion-tracked sales (Snap pixel,
  // Meta CAPI, LinkedIn conversions API). Optional.
  logEvent?(req: LogEventRequest, ctx: Ctx<TMeta>): Promise<LogEventSuccess>;

  // ── sync_event_sources: sync only ──────────────────────────────────
  // Register conversion event sources (websites, apps, offline pixel
  // IDs) so subsequent `log_event` calls can be attributed correctly.
  // Optional — adopters who don't expose conversion tracking omit.
  syncEventSources?(req: SyncEventSourcesRequest, ctx: Ctx<TMeta>): Promise<SyncEventSourcesSuccess>;
}
