/**
 * Request-only Targeting Input helpers (AdCP 3.2, DR-0020).
 *
 * AdCP 3.2 mutation requests carry a **Targeting Input** with three states for
 * every targeting dimension:
 *
 * | wire state | create | update |
 * |---|---|---|
 * | dimension omitted | inherit the configured-product / product default | leave stored state unchanged |
 * | dimension `null` | suppress that default | clear the stored dimension |
 * | dimension non-null | replace the complete dimension | replace the complete dimension |
 *
 * `null` is a **command, not targeting state**. Discovery criteria, configured
 * products, accepted commercial snapshots, mutation responses, and package
 * readback all use the strict Targeting *Overlay* and MUST NOT contain `null` —
 * which is why codegen emits two types (`TargetingOverlayInput` with nullable
 * dimensions, `TargetingOverlay` without). After a successful clear the
 * dimension is simply absent from effective readback.
 *
 * These helpers are the projection between the two. Use them anywhere a
 * request-shaped overlay flows into durable state or into a response:
 * persisting an overlay verbatim would write a clear command into stored
 * targeting, and echoing it back would emit `null` on a wire shape whose schema
 * forbids it.
 *
 * `null` cannot remove inherent product scope. These helpers only project the
 * three states; deciding whether a clear is *executable* for a given product
 * remains the seller's validation step, which rejects a clear it cannot honor
 * rather than silently retaining the default.
 */

/**
 * Keys that must never be copied off a wire-supplied overlay.
 *
 * `targeting_overlay` arrives from `JSON.parse`, which happily produces an own
 * `__proto__` key. Assigning that key with `=` invokes the inherited setter
 * instead of creating an own property, which swaps the accumulator's prototype
 * and makes attacker-chosen targeting dimensions readable on the result while
 * staying invisible to `Object.keys`. The accumulator below is null-prototype,
 * which already defuses the setter, but these keys are dropped outright so a
 * later consumer that spreads the result into an ordinary object cannot
 * reintroduce the problem.
 */
const UNSAFE_OVERLAY_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Strict overlay projection derived from a request-only Targeting Input: the
 * same dimensions, with the `null` clear command removed from each. This does
 * not materialize configured-product defaults omitted by a create request.
 *
 * Generic rather than hardcoded to the generated `TargetingOverlay` because
 * the per-tool payload types widen non-empty-array tuples (`[string,
 * ...string[]]` becomes `string[]`), so a call site holding a payload-shaped
 * purchase or package still gets a precisely-typed result instead of being
 * pushed into a cast.
 */
export type ResolvedTargetingInput<T> = { [K in keyof T]?: Exclude<T[K], null> };

/**
 * Request-only Targeting Input derived from a strict overlay type: every
 * dimension additionally accepts `null` as the clear command.
 *
 * The generated `TargetingOverlayInput` is the canonical instance of this
 * shape; expressing it as a mapping keeps {@link applyTargetingInput} usable
 * from a call site whose overlay type is a payload-shaped widening.
 */
export type TargetingInputFor<T> = { [K in keyof T]?: T[K] | null };

/**
 * Resolve a request-only Targeting Input into the strict effective overlay,
 * dropping every `null` clear command.
 *
 * Use this on the **create** path only when no configured/product targeting
 * defaults need to be materialized. Otherwise pass those strict defaults and
 * the request to {@link applyTargetingInput}. Also use this projection whenever
 * a request-shaped overlay without a baseline is about to become strict state.
 *
 * Returns `undefined` when the input is absent, is an explicit whole-overlay
 * clear, or resolves to no surviving dimensions — a cleared dimension is absent
 * from effective readback, so an empty overlay is expressed by omitting it
 * rather than by echoing `{}`.
 *
 * @example
 * ```ts
 * resolveTargetingInput({ geo_countries: ['US'], audience_include: null });
 * // → { geo_countries: ['US'] }   — the clear command is not stored
 * ```
 */
export function resolveTargetingInput<T extends object>(
  input: T | null | undefined
): ResolvedTargetingInput<T> | undefined {
  if (!input) return undefined;
  return compactOverlay<ResolvedTargetingInput<T>>(Object.entries(input));
}

/**
 * Apply a request-only Targeting Input patch to the prior effective overlay.
 *
 * Use this on the **update** path. Implements the three states per dimension:
 * a dimension absent from the patch keeps its prior value, a dimension set to
 * `null` is cleared, and a non-null dimension replaces the prior value
 * completely.
 *
 * A `null` patch (rather than a patch *containing* nulls) clears the whole
 * overlay; an `undefined` patch leaves the prior overlay untouched, which is
 * how "the request did not mention targeting" is distinguished from "the
 * request asked to clear it".
 *
 * The merge is one level deep. `property_list` / `collection_list` are
 * reference objects keyed by `list_id`, so a partial merge of one would be
 * meaningless — a top-level replace is the correct semantics.
 *
 * @example
 * ```ts
 * applyTargetingInput({ geo_countries: ['US'], audience_include: [...] }, { audience_include: null });
 * // → { geo_countries: ['US'] }   — only the named dimension is cleared
 * ```
 */
export function applyTargetingInput<TOverlay extends object>(
  prior: TOverlay | undefined,
  input: TargetingInputFor<TOverlay> | null | undefined
): TOverlay | undefined {
  if (input === undefined) return prior;
  if (input === null) return undefined;
  return compactOverlay<TOverlay>([...Object.entries(prior ?? {}), ...Object.entries(input)]);
}

/**
 * True when the input carries at least one `null` clear command.
 *
 * Useful for a seller that must decide whether a clear is executable against
 * inherent product scope before accepting the mutation, and for asserting at a
 * response boundary that no clear command leaked into a strict overlay.
 */
export function hasTargetingClears(input: object | null | undefined): boolean {
  if (input === null) return true;
  if (!input) return false;
  // Mirror compactOverlay's key filter. A `{"__proto__": null}` payload is not
  // a targeting clear — the projection drops that key entirely — so counting it
  // here would make the two functions disagree about the same input.
  return Object.entries(input).some(([key, value]) => value === null && !UNSAFE_OVERLAY_KEYS.has(key));
}

/**
 * Fold ordered `[key, value]` pairs into a strict overlay. Later pairs win, a
 * `null` value deletes the key outright, and `undefined` is treated as "not
 * mentioned" so an explicitly-undefined patch key cannot erase a prior value.
 *
 * The result is a plain object (not null-prototype) so it behaves normally for
 * adopters, but it is assembled on a null-prototype accumulator so no wire key
 * can reach a setter on `Object.prototype` on the way in.
 */
function compactOverlay<T>(entries: Array<[string, unknown]>): T | undefined {
  const merged = Object.create(null) as Record<string, unknown>;
  for (const [key, value] of entries) {
    if (UNSAFE_OVERLAY_KEYS.has(key)) continue;
    if (value === null) delete merged[key];
    else if (value !== undefined) merged[key] = value;
  }
  const keys = Object.keys(merged);
  if (keys.length === 0) return undefined;
  return Object.fromEntries(keys.map(key => [key, merged[key]])) as T;
}
