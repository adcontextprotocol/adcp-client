/**
 * `OperationalPlatform` — in-process operational contract.
 *
 * `DecisioningPlatform` covers buyer-facing MCP request dispatch:
 * `platform.sales.updateMediaBuy(req, ctx)` etc., where `ctx` is a
 * `RequestContext` built by the framework from `authInfo` via
 * `AccountStore.resolve`, threading `state`, `resolve`, `ctxMetadata`,
 * and `handoffToTask`.
 *
 * In-process consumers are different. The price-optimization poller,
 * audience-sync task poller, scheduled jobs, and the storefront
 * fan-out path do NOT have an MCP request to derive auth from. They
 * have a stored task with an access token (or, for fan-out, no token
 * — the storefront synthesizes one per upstream target). They cannot
 * honestly satisfy `RequestContext`. Every adopter doing operational
 * work would otherwise reinvent this seam.
 *
 * `OperationalPlatform` is the named contract for that seam. Five
 * methods covering the real operational surface:
 *
 * 1. `extractContext` — synthesize a per-call platform context from
 *    a stored token (and optional request args, for fan-out callers).
 *    The single CTX-METADATA-SAFETY boundary outside
 *    `AccountStore.resolve`: anything touching credentials in an
 *    in-process consumer flows through here.
 * 2. `updateMediaBuy` — required. Fan-out callers dispatch one of
 *    these per upstream target.
 * 3. `getMediaBuyDelivery` — required. Pollers read delivery metrics
 *    here.
 * 4. `pollAudienceStatuses` — optional. Audience-sync pollers only.
 * 5. `getProducts` — optional. Storefront bundle composition only;
 *    server-side internal call, not buyer-facing dispatch.
 *
 * Naming the contract honestly — "operational" rather than "adapter"
 * — separates it from any v5 `PlatformAdapter` baggage and from
 * `DecisioningPlatform`'s MCP-request flow. Tests mock
 * `OperationalPlatform`, not the broader v6 interface.
 *
 * Errors: methods throw `AdcpError` for structured rejection, matching
 * `DecisioningPlatform`'s convention. Generic thrown `Error` /
 * `TypeError` propagate; callers catch and log per their needs.
 *
 * Status: 6.10. See adcontextprotocol/adcp-client#1530.
 *
 * @see DecisioningPlatform — buyer-facing MCP dispatch
 * @see docs/guides/CTX-METADATA-SAFETY.md — credential discipline
 * @public
 */

import type {
  GetMediaBuyDeliveryResponse,
  GetProductsResponse,
  UpdateMediaBuyRequest,
  UpdateMediaBuyResponse,
} from '../types/tools.generated';
import type { RequireCacheScopeWhenProducts, ServerPayload } from '../types/server-payload';
import type { AudienceStatus } from './decisioning/specialisms/audiences';

/**
 * Minimal context for in-process operational calls. Adopters extend
 * with platform-specific fields (advertiser id, sandbox mode, region,
 * etc.); the type parameter on `OperationalPlatform<TCtx>` carries
 * the extension through.
 *
 * `accessToken` is the only field shared across adopters: the rest of
 * the context shape is platform-internal. Pollers and scheduled jobs
 * that legitimately have no token (server-side internal scans) leave
 * it `undefined`.
 *
 * @example
 * ```ts
 * interface SnapOpCtx extends OperationalContext {
 *   advertiserId: string;
 *   sandbox: boolean;
 * }
 *
 * const snapOps = defineOperationalPlatform<SnapOpCtx>({
 *   platformId: 'snap',
 *   extractContext: async (args, sessionToken) => ({
 *     accessToken: sessionToken,
 *     advertiserId: String(args.advertiser_id ?? ''),
 *     sandbox: Boolean(args.sandbox),
 *   }),
 *   // ...
 * });
 * ```
 */
export interface OperationalContext {
  /**
   * The access token used by upstream HTTP calls. `undefined` for
   * server-side internal scans that don't authenticate against a
   * specific tenant.
   */
  accessToken: string | undefined;
}

/**
 * In-process operational contract. Implementations dispatch to
 * upstream platform APIs from pollers, scheduled jobs, fan-out paths,
 * and other contexts that don't carry an MCP request.
 *
 * Type parameter `TCtx` extends {@link OperationalContext} to carry
 * platform-specific context fields through every method.
 */
export interface OperationalPlatform<TCtx extends OperationalContext = OperationalContext> {
  /**
   * Stable platform identifier matching `DecisioningPlatform`'s
   * registered name. Used by registries and routing layers to look up
   * the operational delegate by platform.
   */
  readonly platformId: string;

  /**
   * Synthesize an operational context from a stored token (and
   * optional request args for fan-out callers). The single
   * documented credential-synthesis path outside
   * `AccountStore.resolve` — so the only place adopters need
   * CTX-METADATA-SAFETY review on the operational side.
   *
   * Three call patterns this method serves:
   *   - **Poller / scheduled job**: `args` is `{}`, `sessionToken` is
   *     the stored token. Returns a context bound to that token.
   *   - **Storefront fan-out**: `args` is the (scrubbed) buyer
   *     request body, `sessionToken` is the storefront's master
   *     credential. Returns a context for one upstream target.
   *   - **Server-side internal scan**: `args` is `{}`, `sessionToken`
   *     is `undefined`, `requireAuth` is `false`. Returns a
   *     no-token context.
   *
   * @param args - Optional request args (storefront fan-out path)
   * @param sessionToken - Stored access token (poller path)
   * @param requireAuth - Throw `AuthMissingError` when no token is
   *   available. Defaults to `true`.
   *
   * @remarks Post-migration the SDK will likely split this into
   * `synthesizeFromToken` / `synthesizeFromArgs` (see #1530 for the
   * follow-up). The combined signature today matches the v5
   * `PlatformAdapter.extractContext` shape so v5 adapters duck-type
   * satisfy this interface during migration without a wrapper.
   */
  extractContext(args: Record<string, unknown>, sessionToken?: string, requireAuth?: boolean): Promise<TCtx>;

  /**
   * Update a media buy upstream. Required because every operational
   * consumer assumes it — adapters that can't update media buys have
   * no business registering as operational.
   *
   * Throw `AdcpError` for structured rejection (`NOT_CANCELLABLE`,
   * `CONFLICT`, etc.). Generic thrown errors propagate to the caller.
   */
  updateMediaBuy(ctx: TCtx, request: UpdateMediaBuyRequest): Promise<ServerPayload<UpdateMediaBuyResponse>>;

  /**
   * Fetch delivery metrics for one or more media buys. Required for
   * the same reason as `updateMediaBuy`: every operational consumer
   * assumes it.
   *
   * `mediaBuyIds` is plural — matches the wire-spec
   * `GetMediaBuyDeliveryRequest.media_buy_ids` field (per AdCP 3.0
   * and PR #1342). Pollers that batch-query N buys in one upstream
   * call pass an array; single-buy callers pass `[id]`. Decomposed
   * here (vs. taking the full request shape) because pollers
   * synthesize requests internally and don't have a typed wire
   * payload to thread.
   *
   * `args` carries optional adopter-specific pass-through (e.g.
   * tenant-scoped query parameters); pollers leave it `undefined`.
   */
  getMediaBuyDelivery(
    ctx: TCtx,
    mediaBuyIds: readonly string[],
    startTime: string,
    endTime: string,
    args?: Record<string, unknown>
  ): Promise<ServerPayload<GetMediaBuyDeliveryResponse>>;

  /**
   * Poll upstream for the current status of one or more audiences.
   * Optional — only audience-sync pollers need this.
   *
   * Takes opaque `platformData` (whatever the adapter stored when
   * initiating the sync) plus a fresh access token. No operational
   * context is threaded because the original sync may have been
   * initiated under a now-expired auth principal; the poller carries
   * a freshly-resolved token from its own credential store.
   *
   * **`platformData` is for opaque upstream IDs only — never for
   * bearer tokens.** The fresh `accessToken` argument is the blessed
   * credential channel; reading a stale token from `platformData`
   * defeats the design and lands requests with revoked auth.
   *
   * Returns a `Map<audience_id, AudienceStatus>`. Audiences not
   * resolvable upstream are omitted from the map. Throw
   * `AdcpError('REFERENCE_NOT_FOUND')` only when the entire batch
   * is unresolvable for the tenant.
   *
   * Plural method name aligns with `AudiencePlatform.pollAudienceStatuses`
   * (the buyer-facing analog), which also returns
   * `Map<string, AudienceStatus>`. Signature differs because operational
   * callers don't have a `RequestContext` to thread.
   */
  pollAudienceStatuses?(
    platformData: Record<string, unknown>,
    accessToken: string
  ): Promise<Map<string, AudienceStatus>>;

  /**
   * Discover advertising products. Used by storefront bundle services
   * to query upstream platforms for products available for bundling
   * — server-side internal call, not buyer-facing dispatch.
   *
   * Optional: bundle-search is opt-in per storefront, and not every
   * upstream platform exposes a product-discovery surface.
   *
   * Signature differs from `SalesPlatform.getProducts` because the
   * caller is a storefront bundle service, not an MCP request
   * handler — they have a brief and brand context, not a typed
   * `GetProductsRequest` wire payload.
   */
  getProducts?(
    ctx: TCtx,
    brief: string,
    contextId?: string,
    brand?: Record<string, unknown>,
    sourceChain?: readonly string[]
  ): Promise<RequireCacheScopeWhenProducts<ServerPayload<GetProductsResponse>>>;
}

/**
 * Type-level identity for an `OperationalPlatform` object literal.
 * Forces the contextual type so handler bodies get typed `ctx` and
 * `request` parameters in TypeScript without an explicit annotation.
 *
 * Mirrors the `definePlatform` family for `DecisioningPlatform`
 * sub-interfaces — see `decisioning/platform-helpers.ts`.
 *
 * @example
 * ```ts
 * import { AuthMissingError, defineOperationalPlatform, type OperationalContext } from '@adcp/sdk/server';
 *
 * interface SnapOpCtx extends OperationalContext {
 *   advertiserId: string;
 * }
 *
 * export const snapOperational = defineOperationalPlatform<SnapOpCtx>({
 *   platformId: 'snap',
 *   extractContext: async (args, sessionToken, requireAuth = true) => {
 *     if (!sessionToken && requireAuth) {
 *       throw new AuthMissingError({ message: 'No Snap token available' });
 *     }
 *     return {
 *       accessToken: sessionToken,
 *       advertiserId: String(args.advertiser_id ?? ''),
 *     };
 *   },
 *   updateMediaBuy: async (ctx, request) => {
 *     // ctx.advertiserId typed ✓; request: UpdateMediaBuyRequest ✓
 *     return upstream.update(ctx, request);
 *   },
 *   getMediaBuyDelivery: async (ctx, id, start, end) => {
 *     return upstream.delivery(ctx, id, start, end);
 *   },
 * });
 * ```
 */
export function defineOperationalPlatform<TCtx extends OperationalContext = OperationalContext>(
  ops: OperationalPlatform<TCtx>
): OperationalPlatform<TCtx> {
  return ops;
}
