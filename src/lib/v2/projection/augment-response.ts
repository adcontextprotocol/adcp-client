/**
 * Buyer-side helpers that augment a v1-shaped agent response with v2
 * `format_options[]` derived from the existing `format_ids[]` on each
 * Product.
 *
 * Buyers who want the canonical creative-format model call
 * `withFormatOptions(response)` and read `format_options` instead of
 * relying only on legacy `format_ids`.
 *
 * The SDK also auto-projects compatible `AgentClient.getProducts()`
 * responses; this helper remains useful for cached responses, fixtures,
 * upstream seller/storefront composition, and explicit migration code.
 *
 * Pure functions — no IO, no caching. Each Product is projected
 * independently; diagnostics aggregate so a multi-product response
 * surfaces every projection issue at once. The helpers preserve the
 * input shape verbatim and add `format_options[]` (additive). They do
 * NOT drop `format_ids[]` — that's the 8.0 narrowing. To DROP
 * `format_ids[]` once a consumer has fully migrated, use
 * `toCanonicalOnlyProduct` / `toCanonicalOnlyResponse`.
 */

import type { V1Product, V1FormatId, V2ProductFormatDeclaration, ProjectionDiagnostic } from './types';
import { projectV1ProductToV2 } from './v1-to-v2';
import { LIBRARY_VERSION } from '../../version';

const SDK_ID = `@adcp/sdk@${LIBRARY_VERSION}`;

/**
 * A Product that has been augmented with `format_options[]` while
 * preserving the original `format_ids[]`. Carries the projection
 * diagnostics that were generated mapping each `format_id` so the
 * buyer can see what (if anything) didn't project cleanly.
 *
 * **Write-side bridge.** After picking a `format_options[i]` entry,
 * use {@link formatIdsFromOptions} (from `@adcp/sdk/v2/projection`)
 * to extract the `format_ids[]` value for a `create_media_buy`
 * package. Inlining `decl.v1_format_ref` works but bypasses the
 * fail-closed semantics (canonical_formats_only / inherently-v2
 * canonical → throw). The spec gap that forces this bridge is tracked
 * at adcontextprotocol/adcp#4842.
 *
 * @see formatIdsFromOptions
 * @see formatIdsForCapability
 */
export type V2AugmentedProduct<P> = P & {
  format_options: V2ProductFormatDeclaration[];
};

/**
 * Augment a single Product. Idempotent — when `format_options[]` is
 * already present (the seller is v2-native), passes the Product
 * through unchanged. Otherwise projects from `format_ids[]`.
 *
 * Returns `{ product, diagnostics }`. `diagnostics` is empty for a
 * clean projection; populated when individual format_ids don't have
 * a v2 mapping (catalog gap, structural unreachability, etc.).
 *
 * @see toCanonicalOnlyProduct — the canonical-only counterpart that DROPS
 * `format_ids[]` for a fully-migrated consumer.
 */
export function augmentProductWithFormatOptions<P extends V1Product>(
  product: P
): { product: V2AugmentedProduct<P>; diagnostics: ProjectionDiagnostic[] } {
  // Already v2-shaped (seller sent format_options directly) — pass through.
  const existing = (product as unknown as { format_options?: unknown }).format_options;
  if (Array.isArray(existing)) {
    return {
      product: product as V2AugmentedProduct<P>,
      diagnostics: [],
    };
  }
  // v1 shape — project to add format_options[].
  if (!Array.isArray(product.format_ids)) {
    // Neither shape — nothing to project. Return as-is with an empty
    // format_options so the buyer doesn't have to special-case.
    return {
      product: { ...product, format_options: [] },
      diagnostics: [],
    };
  }
  const { v2, diagnostics } = projectV1ProductToV2(product);
  // Preserve the original product shape (especially format_ids); just
  // add format_options.
  return {
    product: {
      ...product,
      format_options: v2.format_options,
    },
    diagnostics,
  };
}

/**
 * Augment every Product in a `get_products` response with
 * `format_options[]`. Returns `{ response, diagnostics }` so callers
 * can surface projection diagnostics alongside the response's existing
 * `errors[]` array (or filter by `source: 'sdk'` to distinguish SDK
 * diagnostics from seller-emitted errors).
 *
 * Idempotent: if the seller is v2-native and every Product already
 * carries `format_options[]`, returns the response verbatim with no
 * diagnostics.
 *
 * @see toCanonicalOnlyResponse — the canonical-only counterpart that DROPS
 * `format_ids[]` for a fully-migrated consumer.
 */
export function withFormatOptions<R extends { products?: V1Product[] }>(
  response: R
): { response: R & { products: V2AugmentedProduct<V1Product>[] }; diagnostics: ProjectionDiagnostic[] } {
  if (!Array.isArray(response?.products)) {
    return {
      response: { ...response, products: [] } as R & { products: V2AugmentedProduct<V1Product>[] },
      diagnostics: [],
    };
  }
  const out: V2AugmentedProduct<V1Product>[] = [];
  const diagnostics: ProjectionDiagnostic[] = [];
  for (const p of response.products) {
    const { product, diagnostics: d } = augmentProductWithFormatOptions(p);
    out.push(product);
    diagnostics.push(...d);
  }
  return {
    response: { ...response, products: out } as R & { products: V2AugmentedProduct<V1Product>[] },
    diagnostics,
  };
}

/**
 * A Product reduced to the canonical creative-format surface:
 * `format_options[]` only, with the legacy `format_ids[]` removed. The
 * read-side counterpart to a fully-migrated consumer — naive downstream
 * code can no longer fall back to the stale `{ agent_url, id }` shape and
 * silently bypass the canonical model.
 */
export type CanonicalOnlyProduct<P> = Omit<P, 'format_ids'> & {
  format_options: V2ProductFormatDeclaration[];
};

/**
 * Identity key for a `format_id` ref used by the coverage check.
 * Trailing-slash-insensitive on `agent_url` (folds the AAO host's slash /
 * no-slash forms, per `catalog.ts`'s `normalizeAgentUrl`), and includes the
 * dimensional discriminators so multi-size declarations sharing one
 * `{ agent_url, id }` but differing by size/duration are NOT collapsed —
 * the same key shape `write-side.ts` uses for v1 ref de-dup. Without the
 * size half, a `format_ids[]` entry for a size no `v1_format_ref` covers
 * would read as covered and be dropped silently.
 */
function formatRefCoverageKey(ref: V1FormatId): string {
  const url = ref.agent_url && !ref.agent_url.endsWith('/') ? ref.agent_url + '/' : ref.agent_url;
  return `${url}::${ref.id}::${ref.width ?? ''}x${ref.height ?? ''}::${ref.duration_ms ?? ''}`;
}

/**
 * Project a single Product to the canonical-only shape: `format_options[]`
 * present, `format_ids[]` dropped.
 *
 * **Dropping legacy never silently loses a format.** Every input
 * `format_id` is either represented in the returned `format_options[]` or
 * surfaced in `diagnostics` — never discarded without a trace:
 *
 *   - **v1-shaped input** (`format_ids[]`, no `format_options[]`): runs the
 *     v1 → v2 projection. Mapped refs become `format_options[]`; any ref
 *     the projection can't map is surfaced as `FORMAT_PROJECTION_FAILED`.
 *   - **v2-native input** (`format_options[]` already present): keeps the
 *     seller's canonical surface and drops the redundant v1 fallback. If a
 *     `format_ids[]` entry exists that no `format_options[].v1_format_ref`
 *     covers, it surfaces as `LEGACY_FORMAT_ID_DROPPED_UNMAPPED` — the gap
 *     the projection path can't see.
 *   - **neither shape**: returns `format_options: []`; there is nothing to
 *     project and nothing to lose.
 *
 * Pure and subtractive: unlike {@link augmentProductWithFormatOptions}
 * (which preserves `format_ids[]`), this drops it — the opt-in narrowing for
 * a consumer that has fully migrated. Complements the write-side
 * non-invertibility tracked at adcontextprotocol/adcp#4842 — this is the
 * read-side transparency half.
 */
export function toCanonicalOnlyProduct<P extends V1Product>(
  product: P
): { product: CanonicalOnlyProduct<P>; diagnostics: ProjectionDiagnostic[] } {
  const existing = (product as unknown as { format_options?: unknown }).format_options;

  // v2-native: the seller already sent format_options[]. Drop the
  // redundant v1 fallback, but flag any legacy ref no v1_format_ref covers.
  if (Array.isArray(existing)) {
    const formatOptions = existing as V2ProductFormatDeclaration[];
    const diagnostics: ProjectionDiagnostic[] = [];
    const inputIds = Array.isArray(product.format_ids) ? product.format_ids : [];
    if (inputIds.length > 0) {
      const covered = new Set<string>();
      for (const opt of formatOptions) {
        const refs = Array.isArray(opt?.v1_format_ref) ? opt.v1_format_ref : [];
        for (const ref of refs) covered.add(formatRefCoverageKey(ref));
      }
      for (let k = 0; k < inputIds.length; k++) {
        const fid = inputIds[k]!;
        if (!covered.has(formatRefCoverageKey(fid))) {
          // Echo the full ref the SDK saw — including dimensions — so a
          // buyer can tell WHICH variant was dropped (matches the
          // FORMAT_DECLARATION_V1_LOSSY_MULTI_SIZE size-in-details contract).
          const dropped_format_id: {
            agent_url: string;
            id: string;
            width?: number;
            height?: number;
            duration_ms?: number;
          } = { agent_url: fid.agent_url, id: fid.id };
          if (typeof fid.width === 'number') dropped_format_id.width = fid.width;
          if (typeof fid.height === 'number') dropped_format_id.height = fid.height;
          if (typeof fid.duration_ms === 'number') dropped_format_id.duration_ms = fid.duration_ms;
          diagnostics.push({
            source: 'sdk',
            sdk_id: SDK_ID,
            // Indexed to match the v1→v2 projection path's
            // `products[id].format_ids[K]` so consumers correlate diagnostics
            // by `field` shape across both paths.
            field: `products[${product.product_id}].format_ids[${k}]`,
            code: 'LEGACY_FORMAT_ID_DROPPED_UNMAPPED',
            error: {
              details: {
                product_id: product.product_id,
                dropped_format_id,
              },
            },
          });
        }
      }
    }
    const { format_ids: _dropV2, ...rest } = product as P & { format_ids?: unknown };
    void _dropV2;
    return { product: rest as CanonicalOnlyProduct<P>, diagnostics };
  }

  // v1 shape: project. projectV1ProductToV2 already omits format_ids and
  // emits a diagnostic for every ref it couldn't map.
  if (Array.isArray(product.format_ids)) {
    const { v2, diagnostics } = projectV1ProductToV2(product);
    const { format_ids: _dropV1, ...rest } = product as P & { format_ids?: unknown };
    void _dropV1;
    return {
      product: { ...(rest as Omit<P, 'format_ids'>), format_options: v2.format_options } as CanonicalOnlyProduct<P>,
      diagnostics,
    };
  }

  // Neither shape — nothing to project, nothing to lose.
  const { format_ids: _dropNone, ...rest } = product as P & { format_ids?: unknown };
  void _dropNone;
  return {
    product: { ...(rest as Omit<P, 'format_ids'>), format_options: [] } as CanonicalOnlyProduct<P>,
    diagnostics: [],
  };
}

/**
 * Reduce every Product in a `get_products` response to the canonical-only
 * shape — `format_options[]` present, `format_ids[]` dropped. Returns
 * `{ response, diagnostics }` so callers surface projection diagnostics
 * alongside the response's existing `errors[]`.
 *
 * Response-level counterpart to {@link toCanonicalOnlyProduct}; same
 * never-silently-lose-a-format guarantee, aggregated across products. The
 * canonical-only sibling of {@link withFormatOptions} (which is additive
 * and preserves `format_ids[]`).
 */
export function toCanonicalOnlyResponse<R extends { products?: V1Product[] }>(
  response: R
): {
  response: Omit<R, 'products'> & { products: CanonicalOnlyProduct<V1Product>[] };
  diagnostics: ProjectionDiagnostic[];
} {
  if (!Array.isArray(response?.products)) {
    return {
      response: { ...response, products: [] } as Omit<R, 'products'> & { products: CanonicalOnlyProduct<V1Product>[] },
      diagnostics: [],
    };
  }
  const out: CanonicalOnlyProduct<V1Product>[] = [];
  const diagnostics: ProjectionDiagnostic[] = [];
  for (const p of response.products) {
    const { product, diagnostics: d } = toCanonicalOnlyProduct(p);
    out.push(product);
    diagnostics.push(...d);
  }
  return {
    response: { ...response, products: out } as Omit<R, 'products'> & { products: CanonicalOnlyProduct<V1Product>[] },
    diagnostics,
  };
}
