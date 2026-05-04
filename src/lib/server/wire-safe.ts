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
 * **Migration footgun:** `pickWireSpecFields` ALONE doesn't close
 * the round-2 / round-3 vectors (nested `context.<x>_access_token`,
 * nested `ext.<x>_access_token`). `ext` and `context` are wire-spec
 * fields, so the helper preserves them whole. Storefronts that fan
 * out MUST chain {@link scrubExtensions} after the pick — that helper
 * filters ext/context to a caller-specified key allowlist AND
 * recursively drops credential-shaped keys at any depth (using the
 * L1 default pattern set or an adopter-supplied matcher). Calling
 * `pickWireSpecFields` without `scrubExtensions` reopens the
 * round-2/round-3 attack surface.
 *
 * @see docs/guides/CTX-METADATA-SAFETY.md
 * @see scripts/generate-wire-spec-fields.ts — codegen for the
 *      allowlist constants this module reads.
 *
 * @public
 */

import { scanArgsForCredentials, type CredentialPatternsConfig } from './credential-policy';
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
 * The wire-spec request type associated with a `WireSpecRequestName`.
 * Internal — adopters access it transparently via
 * `pickWireSpecFields`'s return narrowing.
 */
type WireSpecRequestShape<K extends WireSpecRequestName> = (typeof WIRE_SPEC_FIELDS)[K]['__type'];

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
 * **Top-level only.** `ext` and `context` are wire-spec fields and
 * are preserved verbatim by this helper. Storefronts MUST chain
 * {@link scrubExtensions} to drop nested credentials in those
 * envelopes. See the module-level migration footgun warning.
 *
 * Storefronts call this once per upstream target during fan-out:
 *
 * ```ts
 * const safe = pickWireSpecFields(buyerReq, 'UpdateMediaBuyRequest');
 * for (const target of targets) {
 *   const perTarget = scrubExtensions(safe, { ... });
 *   await operational.updateMediaBuy(ctxFor(target), perTarget);
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
 *   {@link WIRE_SPEC_FIELDS}. TypeScript narrows the return type to
 *   `WireSafe<RequestType>` based on this — so
 *   `pickWireSpecFields(req, 'UpdateMediaBuyRequest')` returns
 *   `WireSafe<UpdateMediaBuyRequest>`.
 *
 * @example
 * ```ts
 * import { pickWireSpecFields } from '@adcp/sdk/server';
 *
 * // Buyer sends:
 * //   { media_buy_id: 'mb_1', paused: true, snap_access_token: 'attacker' }
 * const safe = pickWireSpecFields(buyerReq, 'UpdateMediaBuyRequest');
 * // safe: WireSafe<UpdateMediaBuyRequest>
 * //   value: { media_buy_id: 'mb_1', paused: true } — credential dropped
 * ```
 */
export function pickWireSpecFields<K extends WireSpecRequestName>(
  request: unknown,
  schemaName: K
): WireSafe<WireSpecRequestShape<K>> {
  const allowlist = WIRE_SPEC_FIELDS[schemaName].fields;
  const out: Record<string, unknown> = {};
  if (request === null || typeof request !== 'object') {
    // Defensive: caller passed something that isn't a request object.
    // Return an empty WireSafe — the upstream call will reject on
    // missing required fields (e.g. `idempotency_key`), which is the
    // right error class to surface (it's adopter-side, not buyer-side).
    return out as WireSafe<WireSpecRequestShape<K>>;
  }
  const source = request as Record<string, unknown>;
  for (const field of allowlist) {
    if (Object.prototype.hasOwnProperty.call(source, field)) {
      out[field] = source[field];
    }
  }
  return out as WireSafe<WireSpecRequestShape<K>>;
}

/**
 * Apply an extension-object allowlist to a `WireSafe<T>` and
 * recursively scrub credential-shaped values. Closes the round-2 /
 * round-3 nested-credential vectors that `pickWireSpecFields` alone
 * leaves open (because `ext` and `context` are wire-spec fields and
 * are preserved verbatim by the pick).
 *
 * Three operations, applied in order:
 *
 * 1. **Top-level allowlist filter** (when `allowedExtKeys` is set):
 *    drop keys from `ext` and `context` that aren't in the
 *    allowlist. Pass an empty Set to drop both fields entirely;
 *    pass `undefined` to leave the top level untouched.
 * 2. **Recursive credential scan** (when `recursiveCredentialScan`
 *    is `true`, default): walk surviving values in `ext`/`context`
 *    at any depth and drop nested keys that match the L1
 *    credential-pattern set (or an adopter-supplied matcher). Closes
 *    `ext.partner.token` and similar deep-nesting attack vectors.
 * 3. **Adopter inject** (when `inject` is set): merge
 *    storefront-controlled values into `ext` and/or `context`.
 *    Inject runs LAST so storefront-resolved credentials override
 *    any allowlisted buyer values that collide.
 *
 * The `WireSafe<T>` brand survives — the operation is closed over
 * the wire-spec field set.
 *
 * @example
 * ```ts
 * const safe = pickWireSpecFields(buyerReq, 'UpdateMediaBuyRequest');
 * const perTarget = scrubExtensions(safe, {
 *   allowedExtKeys: new Set(['scope3_api_key', 'partner_request_id']),
 *   inject: {
 *     context: {
 *       managed_access_token: target.token,
 *       managed_advertiser_id: target.advertiserId,
 *     },
 *   },
 * });
 * ```
 */
export interface ScrubExtensionsOptions {
  /**
   * Set of keys permitted to survive on `ext` and `context`. Keys
   * outside this set are dropped from both. Pass `undefined` to leave
   * `ext`/`context` top-level untouched (only the recursive scan and
   * `inject` apply); pass an empty set to drop both entirely.
   */
  allowedExtKeys?: ReadonlySet<string>;

  /**
   * When true (default), recursively walk surviving `ext`/`context`
   * values and drop nested keys matching the credential-pattern set.
   * Closes round-4-style deep-nesting attack vectors that the
   * top-level allowlist alone cannot — e.g. an adopter who allowlists
   * `partner` and forgets that `partner.token` is buyer-controlled.
   *
   * Set to `false` only when you've validated the surviving
   * `ext`/`context` shapes yourself (e.g. via Zod-typed extensions).
   */
  recursiveCredentialScan?: boolean;

  /**
   * Optional matcher overrides for the recursive scan. Defaults to
   * the L1 credential-policy default pattern set
   * ({@link DEFAULT_CREDENTIAL_PATTERNS}). Pass `extend` to add
   * adopter-specific patterns; pass `matcher` to fully replace the
   * regex set.
   */
  credentialPatterns?: CredentialPatternsConfig;

  /**
   * Adopter-controlled values to merge into `ext` and/or `context`
   * AFTER the allowlist filter and recursive scan run. Used to inject
   * storefront-owned routing tokens (e.g. resolved per-target
   * advertiser IDs) into the per-target request.
   *
   * **Adopter-side ONLY — values here MUST be storefront-derived,
   * never read from the incoming buyer request.** Threading buyer-
   * controlled values through `inject` defeats the discipline. The
   * inject precedes the allowlist filter, so a buyer value injected
   * here would survive every check.
   */
  inject?: {
    ext?: Record<string, unknown>;
    context?: Record<string, unknown>;
  };
}

/**
 * Implementation of {@link ScrubExtensionsOptions}. See JSDoc above.
 */
export function scrubExtensions<T extends object>(request: WireSafe<T>, options: ScrubExtensionsOptions): WireSafe<T> {
  const out = { ...(request as object) } as Record<string, unknown>;
  const { allowedExtKeys, recursiveCredentialScan = true, credentialPatterns, inject } = options;

  // Step 1: top-level allowlist filter. When `allowedExtKeys` is
  // undefined we leave the top level alone (recursive scan and
  // inject still run); when it's an empty set we drop both fields.
  if (allowedExtKeys !== undefined) {
    const sourceExt = (out.ext ?? {}) as Record<string, unknown>;
    const sourceCtx = (out.context ?? {}) as Record<string, unknown>;
    const filteredExt: Record<string, unknown> = {};
    const filteredCtx: Record<string, unknown> = {};
    for (const k of allowedExtKeys) {
      if (Object.prototype.hasOwnProperty.call(sourceExt, k)) filteredExt[k] = sourceExt[k];
      if (Object.prototype.hasOwnProperty.call(sourceCtx, k)) filteredCtx[k] = sourceCtx[k];
    }
    out.ext = filteredExt;
    out.context = filteredCtx;
  }

  // Step 2: recursive credential-shape scan. Strategy depends on
  // whether step 1 ran:
  //
  //   - With `allowedExtKeys` set: top-level is already gated by
  //     the explicit allowlist. The adopter has affirmed those keys
  //     are legitimate (e.g. `scope3_api_key` allowlisted on a
  //     specific tool), so we DON'T second-guess them by name. The
  //     scan applies to depths 1+ — dropping nested credentials
  //     INSIDE allowlisted values (`partner: { token: '...' }`
  //     becomes `partner: {}`).
  //
  //   - Without `allowedExtKeys`: no top-level gate; scan from
  //     depth 0 to drop credential-shaped keys at any depth. This
  //     is the path adopters take when they trust their own
  //     ext/context shapes but want belt-and-suspenders coverage.
  if (recursiveCredentialScan) {
    const fromDepth = allowedExtKeys !== undefined ? 1 : 0;
    if (out.ext !== undefined && out.ext !== null && typeof out.ext === 'object') {
      out.ext = stripNestedCredentials(out.ext, credentialPatterns, fromDepth);
    }
    if (out.context !== undefined && out.context !== null && typeof out.context === 'object') {
      out.context = stripNestedCredentials(out.context, credentialPatterns, fromDepth);
    }
  }

  // Step 3: adopter-controlled inject. Runs AFTER the scan so
  // storefront-resolved credentials/IDs aren't accidentally dropped
  // by the recursive scan (e.g. injected `managed_access_token` is
  // intentional and belongs).
  if (inject?.ext) {
    out.ext = { ...(out.ext as Record<string, unknown> | undefined), ...inject.ext };
  }
  if (inject?.context) {
    out.context = { ...(out.context as Record<string, unknown> | undefined), ...inject.context };
  }

  return out as WireSafe<T>;
}

/**
 * Recursively walk a value and drop keys matching the credential
 * pattern set, starting from `fromDepth`. Used by `scrubExtensions`
 * to close round-4 nesting.
 *
 * `fromDepth = 0` scans every depth including the top level — used
 * when no `allowedExtKeys` is supplied.
 * `fromDepth = 1` skips the top level — used when the top-level
 * keys have already been gated by an explicit allowlist (the
 * adopter affirmed them legitimate by name).
 *
 * Returns a NEW object/array tree — input is not mutated. Cycle-safe
 * via `WeakSet`. Primitives pass through.
 */
function stripNestedCredentials(value: unknown, patterns?: CredentialPatternsConfig, fromDepth = 0): unknown {
  // Identify credential-shaped paths via the L1 scanner.
  const hits = new Set(scanArgsForCredentials(value, patterns));
  if (hits.size === 0) return value;

  const seen = new WeakSet<object>();
  const walk = (node: unknown, path: readonly string[], depth: number): unknown => {
    if (node === null || typeof node !== 'object') return node;
    if (seen.has(node)) return node;
    seen.add(node);

    if (Array.isArray(node)) {
      return node.map((item, i) => walk(item, [...path, String(i)], depth + 1));
    }

    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      const childPath = [...path, key];
      // Only drop the key if we're AT or BEYOND `fromDepth`. Keys
      // shallower than fromDepth pass through unchecked because
      // they were already gated upstream.
      if (depth >= fromDepth && hits.has(childPath.join('.'))) {
        continue;
      }
      out[key] = walk(child, childPath, depth + 1);
    }
    return out;
  };
  return walk(value, [], 0);
}
