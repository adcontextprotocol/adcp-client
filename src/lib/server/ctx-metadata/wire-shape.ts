/**
 * Compile-time + runtime defense against `ctx_metadata` leaking into
 * buyer-facing wire payloads.
 *
 * - **Compile-time:** `WireShape<T>` strips `ctx_metadata` from a type
 *   tree, so the framework's response builder return types refuse a
 *   payload that carries it.
 * - **Runtime:** `stripCtxMetadata(value)` shape-aware shallow walk
 *   over known carrier locations (response root + `packages[]` +
 *   `creatives[]` + `audiences[]` + `signals[]` + `media_buys[]` +
 *   `products[]`). Catches custom-handler escape hatches and HITL
 *   task return values that re-introduce the field at runtime.
 *
 * Single chokepoint at the dispatcher seam. Strip runs *before* the
 * idempotency cache write so cached replays don't leak.
 *
 * @public
 */

const CTX_METADATA_KEY = 'ctx_metadata' as const;

/**
 * Compile-time strip: recursively remove `ctx_metadata` from a type
 * tree. Used as the framework's response-boundary type so a publisher
 * payload that carries the field fails type-checking before it
 * reaches the wire.
 *
 * Strips `ctx_metadata` at top level, inside arrays, and inside
 * objects nested under `packages` / `creatives` / `audiences` /
 * `signals` / `media_buys` / `products` — the carrier shapes the
 * AdCP 3.0 wire spec defines. Other shapes pass through unchanged
 * (the runtime walk is deliberately not recursive everywhere — see
 * the docstring).
 */
export type WireShape<T> = T extends ReadonlyArray<infer U>
  ? ReadonlyArray<WireShape<U>>
  : T extends object
    ? { [K in keyof T as K extends 'ctx_metadata' ? never : K]: WireShape<T[K]> }
    : T;

/**
 * Runtime strip. Walks known carrier shapes in the response and
 * deletes `ctx_metadata` keys. Returns the input value (mutates in
 * place — the dispatcher constructs a fresh response per call, so
 * mutation is safe).
 *
 * **Why shape-aware shallow walk, not full recursion.** Full
 * recursion is O(response size) and risks stripping a field a
 * future spec adds with the same name elsewhere (e.g., a diagnostic
 * envelope's `ctx_metadata`). Shape-aware walks the carrier
 * locations defined by AdCP 3.0 — adding a new carrier requires
 * updating this list, which is the right kind of friction.
 */
export function stripCtxMetadata<T>(value: T): WireShape<T> {
  if (value == null || typeof value !== 'object') return value as WireShape<T>;
  stripFromCarrier(value as Record<string, unknown>);
  return value as WireShape<T>;
}

/**
 * Carrier locations: keys whose values may be objects or arrays of
 * objects that carry `ctx_metadata`. Add new keys here when a future
 * spec extends the wire-resource surface.
 */
const CARRIER_KEYS = [
  'account',
  'accounts',
  'media_buy',
  'media_buys',
  'package',
  'packages',
  'product',
  'products',
  'creative',
  'creatives',
  'audience',
  'audiences',
  'signal',
  'signals',
  'rights_grant',
  'rights_grants',
  'property_list',
  'property_lists',
  'collection_list',
  'collection_lists',
  'asset',
  'assets',
] as const;

function stripFromCarrier(obj: Record<string, unknown>): void {
  if (CTX_METADATA_KEY in obj) delete obj[CTX_METADATA_KEY];
  for (const key of CARRIER_KEYS) {
    const nested = obj[key];
    if (nested == null) continue;
    if (Array.isArray(nested)) {
      for (const item of nested) {
        if (item != null && typeof item === 'object') stripFromCarrier(item as Record<string, unknown>);
      }
    } else if (typeof nested === 'object') {
      stripFromCarrier(nested as Record<string, unknown>);
    }
  }
}

/**
 * Detect whether a payload contains `ctx_metadata` at any walked
 * carrier location. Used by the test suite to assert wire payloads
 * are clean — production code paths just call `stripCtxMetadata`.
 */
export function hasCtxMetadata(value: unknown): boolean {
  if (value == null || typeof value !== 'object') return false;
  return walkForCtxMetadata(value as Record<string, unknown>);
}

function walkForCtxMetadata(obj: Record<string, unknown>): boolean {
  if (CTX_METADATA_KEY in obj) return true;
  for (const key of CARRIER_KEYS) {
    const nested = obj[key];
    if (nested == null) continue;
    if (Array.isArray(nested)) {
      for (const item of nested) {
        if (item != null && typeof item === 'object' && walkForCtxMetadata(item as Record<string, unknown>)) {
          return true;
        }
      }
    } else if (typeof nested === 'object') {
      if (walkForCtxMetadata(nested as Record<string, unknown>)) return true;
    }
  }
  return false;
}
