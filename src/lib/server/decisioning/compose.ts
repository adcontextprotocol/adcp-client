/**
 * Method-level composition helpers for {@link DecisioningPlatform} adopters
 * who need to wrap individual platform methods with pre/post hooks — typical
 * shapes are early-return short-circuits (price-optimization paths skipping
 * the inner call), response enrichment (carbon emissions, brand-manifest
 * merging), and response-level caching.
 *
 * Closes adcp-client#1314.
 *
 * @public
 */

/**
 * Sentinel returned by a `before` hook to signal "fall through to the inner
 * method." Distinct from any concrete `TResult` — adopters use it instead of
 * `undefined` so result types that legitimately include `undefined` don't
 * collide with the short-circuit semantics.
 *
 * Registered via `Symbol.for(...)` so the sentinel survives dual-package
 * hazards (CJS + ESM in the same process, monorepo deduplication mishaps):
 * any module that imports `PASS` from `@adcp/sdk/server` reaches the same
 * registry entry, so reference-equality (`===`) checks compose correctly.
 *
 * @public
 */
declare const PASS_BRAND: unique symbol;
type ComposePass = symbol & { readonly [PASS_BRAND]: 'composeMethod.PASS' };
export const PASS = Symbol.for('@adcp/sdk.composeMethod.PASS') as ComposePass;

/**
 * Hooks accepted by {@link composeMethod}.
 *
 * `before` returning {@link PASS} falls through to the wrapped method.
 * Returning any other value short-circuits — `after` (if any) still runs on
 * the short-circuit value before it flows back to the caller.
 *
 * `after` runs on the result whether it came from the wrapped method or
 * from a `before` short-circuit. Receives the original `params` and `ctx`
 * for context-dependent enrichment.
 *
 * @public
 */
export interface ComposeHooks<TParams, TCtx, TResult> {
  before?: (params: TParams, ctx: TCtx) => Promise<TResult | typeof PASS>;
  after?: (result: TResult, params: TParams, ctx: TCtx) => Promise<TResult>;
}

/**
 * Wrap a single platform method with optional `before` / `after` hooks.
 *
 * Type-preserving: the returned function has the same `(params, ctx) =>
 * Promise<TResult>` signature as `inner`, so it slots into a typed
 * `DecisioningPlatform` shape without `as` casts.
 *
 * @example Short-circuit + enrichment
 * ```ts
 * import { composeMethod, PASS } from '@adcp/sdk/server';
 *
 * const wrapped = {
 *   ...basePlatform,
 *   sales: {
 *     ...basePlatform.sales,
 *     getMediaBuyDelivery: composeMethod(basePlatform.sales.getMediaBuyDelivery, {
 *       before: async (params) =>
 *         params.optimization === 'price' ? cachedPriceOpt : PASS,
 *       after: async (result) => enrichWithCarbon(result),
 *     }),
 *     getProducts: composeMethod(basePlatform.sales.getProducts, {
 *       after: async (result) => mergeBrandManifest(result, await brandCache.get()),
 *     }),
 *   },
 * };
 *
 * createAdcpServerFromPlatform(wrapped, opts);
 * ```
 *
 * @public
 */
export function composeMethod<TParams, TCtx, TResult>(
  inner: (params: TParams, ctx: TCtx) => Promise<TResult>,
  hooks: ComposeHooks<TParams, TCtx, TResult>
): (params: TParams, ctx: TCtx) => Promise<TResult> {
  return async (params, ctx) => {
    let result: TResult;
    if (hooks.before) {
      const early = await hooks.before(params, ctx);
      if (early === PASS) {
        result = await inner(params, ctx);
      } else {
        result = early as TResult;
      }
    } else {
      result = await inner(params, ctx);
    }
    if (hooks.after) {
      result = await hooks.after(result, params, ctx);
    }
    return result;
  };
}
