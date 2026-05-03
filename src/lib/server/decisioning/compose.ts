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
 * Wrapper returned by a `before` hook to short-circuit the wrapped method.
 *
 * Returning a wrapped object (e.g. `{ shortCircuit: cachedPriceOpt }`) skips
 * the inner method and feeds the wrapped value through `after` (if any)
 * back to the caller. Returning `undefined` (or no return) falls through.
 *
 * Discriminated wrapper rather than a sentinel symbol because the wrapper
 * is unambiguous even when `TResult` itself includes `undefined`, and
 * adopters can't accidentally short-circuit by forgetting an import.
 *
 * @public
 */
export interface ComposeShortCircuit<TResult> {
  shortCircuit: TResult;
}

/**
 * Hooks accepted by {@link composeMethod}.
 *
 * `before` returning `undefined` (or no return) falls through to the wrapped
 * method. Returning `{ shortCircuit: value }` short-circuits — `after` (if
 * any) still runs on the short-circuit value before it flows back to the
 * caller.
 *
 * `after` runs on the result whether it came from the wrapped method or
 * from a `before` short-circuit. Receives the original `params` and `ctx`
 * for context-dependent enrichment.
 *
 * The `after` hook runs BEFORE response-schema validation. The wrapped
 * value still has to satisfy the wire schema for the tool — adopters
 * decorating responses with vendor-specific data should put it under
 * `ext` (the spec's typed extension surface) rather than at the top level.
 *
 * @public
 */
export interface ComposeHooks<TParams, TCtx, TResult> {
  before?: (params: TParams, ctx: TCtx) => Promise<ComposeShortCircuit<TResult> | undefined>;
  after?: (result: TResult, params: TParams, ctx: TCtx) => Promise<TResult>;
}

type MethodFn<TParams, TCtx, TResult> = (params: TParams, ctx: TCtx) => Promise<TResult>;

function composeSingle<TParams, TCtx, TResult>(
  inner: MethodFn<TParams, TCtx, TResult>,
  hooks: ComposeHooks<TParams, TCtx, TResult>
): MethodFn<TParams, TCtx, TResult> {
  return async (params, ctx) => {
    let result: TResult;
    if (hooks.before) {
      const early = await hooks.before(params, ctx);
      if (early === undefined) {
        result = await inner(params, ctx);
      } else {
        result = early.shortCircuit;
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

/**
 * Wrap a single platform method with optional `before` / `after` hooks.
 *
 * Type-preserving: the returned function has the same `(params, ctx) =>
 * Promise<TResult>` signature as `inner`, so it slots into a typed
 * `DecisioningPlatform` shape without `as` casts.
 *
 * Validates `inner` is a function eagerly (at wrap time, not at first
 * invocation) so adopters who reference an optional method that wasn't
 * implemented on the underlying platform get a clear error at module load
 * rather than the first traffic to hit the method.
 *
 * **Variadic overload** — pass multiple hooks to chain them without nesting.
 * `before` hooks run left-to-right (first argument runs first); `after`
 * hooks run right-to-left (last argument runs first), matching standard
 * middleware-stack semantics. A short-circuit from a `before` hook skips
 * remaining `before` hooks and the `after` hooks of inner wrappers that
 * were never entered; `after` hooks for the short-circuiting wrapper and
 * any outer wrappers still run. Equivalent to manually nesting
 * `composeMethod` calls right-to-left:
 *
 * ```ts
 * // These are identical:
 * composeMethod(inner, hookA, hookB, hookC)
 * composeMethod(composeMethod(composeMethod(inner, hookC), hookB), hookA)
 * ```
 *
 * @example Short-circuit + enrichment (single hook)
 * ```ts
 * import { composeMethod } from '@adcp/sdk/server';
 *
 * const wrapped = {
 *   ...basePlatform,
 *   sales: {
 *     ...basePlatform.sales,
 *     getMediaBuyDelivery: composeMethod(basePlatform.sales.getMediaBuyDelivery, {
 *       before: async (params) =>
 *         params.optimization === 'price'
 *           ? { shortCircuit: cachedPriceOpt }
 *           : undefined,
 *       after: async (result) => ({
 *         ...result,
 *         ext: { ...result.ext, carbon_grams_per_impression: await score(result) },
 *       }),
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
 * @example Stacking multiple security gates (variadic)
 * ```ts
 * import { composeMethod, requireAdvertiserMatch } from '@adcp/sdk/server';
 *
 * accounts: {
 *   resolve: composeMethod(
 *     baseResolve,
 *     { before: async (_p, ctx) => ctx.token ? undefined : { shortCircuit: null } },
 *     requireAdvertiserMatch(async (ctx) => tenantRoster.for(ctx?.agent)),
 *   ),
 * }
 * ```
 *
 * @public
 */
export function composeMethod<TParams, TCtx, TResult>(
  inner: MethodFn<TParams, TCtx, TResult>,
  hooks: ComposeHooks<TParams, TCtx, TResult>
): MethodFn<TParams, TCtx, TResult>;
export function composeMethod<TParams, TCtx, TResult>(
  inner: MethodFn<TParams, TCtx, TResult>,
  first: ComposeHooks<TParams, TCtx, TResult>,
  ...rest: ComposeHooks<TParams, TCtx, TResult>[]
): MethodFn<TParams, TCtx, TResult>;
export function composeMethod<TParams, TCtx, TResult>(
  inner: MethodFn<TParams, TCtx, TResult>,
  first: ComposeHooks<TParams, TCtx, TResult>,
  ...rest: ComposeHooks<TParams, TCtx, TResult>[]
): MethodFn<TParams, TCtx, TResult> {
  if (typeof inner !== 'function') {
    throw new TypeError(
      `composeMethod: 'inner' must be a function, got ${inner === null ? 'null' : typeof inner}. ` +
        `Did you reference an optional method that wasn't implemented on the platform?`
    );
  }
  if (rest.length === 0) {
    return composeSingle(inner, first);
  }
  // Fold right so the first argument becomes the outermost wrapper (runs first).
  // Equivalent to: composeMethod(composeMethod(composeMethod(inner, hookC), hookB), hookA)
  return [first, ...rest].reduceRight<MethodFn<TParams, TCtx, TResult>>(
    (acc, hooks) => composeSingle(acc, hooks),
    inner
  );
}
