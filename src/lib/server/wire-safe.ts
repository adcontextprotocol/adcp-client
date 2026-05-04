/**
 * Wire-spec field discipline at the operational fan-out boundary.
 *
 * `WireSafe<T>` is a branded type that signals "this object has been
 * stripped to AdCP wire-spec fields and is safe to forward upstream."
 * The brand is constructed only by {@link pickWireSpecFields} (or
 * variants). Code that spreads a buyer request directly cannot satisfy
 * the brand — `{ ...buyerReq, paused: true }` is `T`, not
 * `WireSafe<T>`.
 *
 * The brand is the L2 of #1529: where L1 (`credentialPolicy`,
 * `src/lib/server/credential-policy.ts`) catches credential-shaped
 * keys at the buyer-facing dispatch boundary, L2 catches structural
 * leakage at the operational dispatch boundary — storefront fan-out
 * code that picks per-target args from a buyer request, where the
 * scrub happens BEFORE the credential scan would have run on the
 * upstream call.
 *
 * **The brand is opt-in at the type level.** `OperationalPlatform`
 * methods accept plain `UpdateMediaBuyRequest` etc. (not branded —
 * see #1530's interface), so adopters who don't use the helper
 * aren't broken. Adopters who DO use the helper get the safety
 * benefit at the picking site: assigning the result to a
 * `WireSafe<UpdateMediaBuyRequest>` variable forces `pickWireSpecFields`
 * to be the constructor; spreading the buyer request elsewhere fails
 * to satisfy the brand.
 *
 * @see docs/guides/CTX-METADATA-SAFETY.md
 * @see scripts/generate-wire-spec-fields.ts — codegen for the
 *      allowlist constants this module reads.
 *
 * @public
 */

import { WIRE_SPEC_FIELDS, type WireSpecRequestName } from './wire-spec-fields.generated';

declare const __wireSafe: unique symbol;

/**
 * A request shape that has been narrowed to AdCP wire-spec fields.
 * Cannot be produced by spreading a buyer request — only via
 * {@link pickWireSpecFields} or by typed `as WireSafe<T>` assertion
 * at a known-safe construction site (e.g. a poller that builds the
 * request from stored state, not from buyer input).
 *
 * The brand is what makes this load-bearing: `{ ...buyerRequest }` is
 * `T`, not `WireSafe<T>`, so passing it where `WireSafe<T>` is
 * required is a compile error.
 */
export type WireSafe<T> = T & { readonly [__wireSafe]: true };

export type { WireSpecRequestName };

export { WIRE_SPEC_FIELDS };

/**
 * Strip a buyer request to the wire-spec fields defined for
 * `schemaName` and return the result branded `WireSafe<T>`. The
 * canonical constructor of {@link WireSafe}.
 *
 * Drops every property NOT in the schema's `properties` allowlist,
 * including buyer-supplied unknown keys (`<platform>_access_token`,
 * `account: { brand: 'attacker.com' }`-style identity-pivot fields,
 * arbitrary attacker payload). The allowlist comes from codegen — the
 * AdCP request schema IS the allowlist; drift is structurally
 * impossible.
 *
 * Storefronts call this once per upstream target during fan-out:
 *
 * ```ts
 * const safe = pickWireSpecFields(buyerReq, 'UpdateMediaBuyRequest');
 * for (const target of targets) {
 *   await operational.updateMediaBuy(ctxFor(target), safe);
 * }
 * ```
 *
 * Pollers that construct requests from stored state typically don't
 * need this — their inputs aren't buyer-controlled. They can opt in
 * for symmetric type safety with `as WireSafe<T>` if their type
 * system encourages it, or call this helper anyway (the strip is a
 * no-op when input is already wire-spec only).
 *
 * @param request - Buyer-supplied (or otherwise untrusted) input.
 * @param schemaName - PascalCase request type name from
 *   {@link WIRE_SPEC_FIELDS}. TypeScript narrows the return type
 *   to the corresponding wire-spec interface — so
 *   `pickWireSpecFields(req, 'UpdateMediaBuyRequest')` returns
 *   `WireSafe<UpdateMediaBuyRequest>` (less the brand erasure).
 *
 * @example
 * ```ts
 * import { pickWireSpecFields } from '@adcp/sdk/server';
 *
 * // Buyer sends:
 * //   { media_buy_id: 'mb_1', paused: true, snap_access_token: 'attacker' }
 * const safe = pickWireSpecFields(buyerReq, 'UpdateMediaBuyRequest');
 * // safe: { media_buy_id: 'mb_1', paused: true } — credential dropped
 * ```
 */
export function pickWireSpecFields<K extends WireSpecRequestName>(
  request: unknown,
  schemaName: K
): WireSafe<Record<string, unknown>> {
  const allowlist = WIRE_SPEC_FIELDS[schemaName];
  const out: Record<string, unknown> = {};
  if (request === null || typeof request !== 'object') {
    // Defensive: caller passed something that isn't a request object.
    // Return an empty WireSafe — the upstream call will reject on
    // missing required fields (e.g. `idempotency_key`), which is the
    // right error class to surface (it's adopter-side, not buyer-side).
    return out as WireSafe<Record<string, unknown>>;
  }
  const source = request as Record<string, unknown>;
  for (const field of allowlist) {
    if (Object.prototype.hasOwnProperty.call(source, field)) {
      out[field] = source[field];
    }
  }
  return out as WireSafe<Record<string, unknown>>;
}

/**
 * Apply an extension-object allowlist to a `WireSafe<T>`. The AdCP
 * `ext` and `context` fields are open extension objects per spec —
 * `pickWireSpecFields` keeps them whole (they're in the wire-spec
 * properties list), but storefronts that fan-out to multiple
 * upstream targets typically want a NARROWER ext/context shape per
 * target than the buyer sent.
 *
 * `scrubExtensions` filters `request.ext` and `request.context` to a
 * caller-specified key set (mirroring the `ALLOWED_EXT_KEYS` pattern
 * the agentic-adapters shim uses) and merges in caller-injected
 * values. Returns a new `WireSafe<T>` — the brand survives because
 * the operation is closed over the wire-spec field set.
 *
 * @example
 * ```ts
 * const safe = pickWireSpecFields(buyerReq, 'UpdateMediaBuyRequest');
 * const perTarget = scrubExtensions(safe, {
 *   allowedExtKeys: ['scope3_api_key', 'partner_request_id'],
 *   inject: {
 *     context: {
 *       managed_access_token: target.token,
 *       managed_advertiser_id: target.advertiserId,
 *     },
 *   },
 * });
 * ```
 *
 * Pass an empty `allowedExtKeys` set to drop ext/context entirely.
 * Pass `undefined` to leave them untouched (only `inject` applies).
 */
export interface ScrubExtensionsOptions {
  /**
   * Set of keys permitted to survive on `ext` and `context`. Keys
   * outside this set are dropped from both. Pass `undefined` to leave
   * `ext`/`context` untouched (only `inject` applies); pass an empty
   * set to drop both entirely.
   */
  allowedExtKeys?: ReadonlySet<string>;

  /**
   * Adopter-controlled values to merge into `ext` and/or `context`
   * AFTER the allowlist filter runs. Used to inject storefront-owned
   * routing tokens (e.g. resolved per-target advertiser IDs) into
   * the per-target request. Adopter-side — NEVER thread buyer values
   * through here.
   */
  inject?: {
    ext?: Record<string, unknown>;
    context?: Record<string, unknown>;
  };
}

export function scrubExtensions<T extends Record<string, unknown>>(
  request: WireSafe<T>,
  options: ScrubExtensionsOptions
): WireSafe<T> {
  const out: Record<string, unknown> = { ...request };
  const { allowedExtKeys, inject } = options;

  if (allowedExtKeys !== undefined) {
    const sourceExt = (request.ext ?? {}) as Record<string, unknown>;
    const sourceCtx = (request.context ?? {}) as Record<string, unknown>;
    const filteredExt: Record<string, unknown> = {};
    const filteredCtx: Record<string, unknown> = {};
    for (const k of allowedExtKeys) {
      if (Object.prototype.hasOwnProperty.call(sourceExt, k)) filteredExt[k] = sourceExt[k];
      if (Object.prototype.hasOwnProperty.call(sourceCtx, k)) filteredCtx[k] = sourceCtx[k];
    }
    out.ext = filteredExt;
    out.context = filteredCtx;
  }

  if (inject?.ext) {
    out.ext = { ...(out.ext as Record<string, unknown> | undefined), ...inject.ext };
  }
  if (inject?.context) {
    out.context = { ...(out.context as Record<string, unknown> | undefined), ...inject.context };
  }

  return out as WireSafe<T>;
}
