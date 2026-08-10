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
import type { V1ToV2ProjectionOptions } from './v1-to-v2';
import { LIBRARY_VERSION } from '../../version';
import { canonicalize as canonicalizeJson } from '../../utils/jcs';
import { concealLegacyFormatRefs } from './legacy-metadata';
import type { CanonicalFormatDeclaration } from './legacy-metadata';
import { legacyRoutesForProduct } from './legacy-routes';
import type { CanonicalFormatLegacyRoute } from './legacy-routes';

const SDK_ID = `@adcp/sdk@${LIBRARY_VERSION}`;
const DIRECT_LEGACY_FORMAT_IDENTITY_KEYS = new Set(['agenturl', 'formatid', 'formatids', 'v1formatref']);

function canonicalDiagnostic(diagnostic: ProjectionDiagnostic): ProjectionDiagnostic {
  return {
    ...diagnostic,
    // A source `format_ids[i]` index is not an index into the projected
    // `format_options[]`: earlier source refs may have failed while later refs
    // projected successfully. Point at the canonical collection instead of
    // claiming that a successful projected option is the failing value.
    field: diagnostic.field.replace(/\.format_ids\[\d+\]/g, '.format_options'),
  };
}

/** Protocol Error shape used for portable response-level projection advisories. */
export interface CanonicalProjectionError {
  code: ProjectionDiagnostic['code'];
  message: string;
  field: string;
  recovery: 'correctable';
  source: 'sdk';
  sdk_id: string;
  details: ProjectionDiagnostic['error']['details'];
}

function projectionErrorMessage(code: ProjectionDiagnostic['code']): string {
  switch (code) {
    case 'CANONICAL_PRODUCT_FORMATS_UNAVAILABLE':
      return 'Product has no format declaration representable on the canonical-only surface';
    case 'FORMAT_PROJECTION_FAILED':
      return 'Legacy creative format could not be projected to a canonical declaration';
    case 'FORMAT_DECLARATION_V1_AMBIGUOUS':
      return 'Canonical creative format has no unambiguous legacy declaration';
    case 'FORMAT_DECLARATION_V1_NOT_APPLICABLE':
      return 'Canonical-only creative format cannot be represented on a legacy format path';
    case 'CANONICAL_NOT_V1_TRANSLATABLE':
      return 'Canonical creative format has no legacy representation';
    case 'FORMAT_DECLARATION_V1_LOSSY_MULTI_SIZE':
      return 'Canonical multi-size format has incomplete legacy coverage';
    case 'LEGACY_FORMAT_ID_DROPPED_UNMAPPED':
      return 'Redundant legacy creative identity has no canonical counterpart';
  }
}

/** Flatten the projector's internal diagnostic into the protocol `Error` shape. */
export function projectionDiagnosticToError(diagnostic: ProjectionDiagnostic): CanonicalProjectionError {
  return {
    code: diagnostic.code,
    message: projectionErrorMessage(diagnostic.code),
    field: diagnostic.field,
    recovery: 'correctable',
    source: diagnostic.source,
    sdk_id: diagnostic.sdk_id,
    details: diagnostic.error.details,
  } as CanonicalProjectionError;
}

function canonicalFormatsUnavailableForProduct(
  product: V1Product,
  reason: Extract<ProjectionDiagnostic, { code: 'CANONICAL_PRODUCT_FORMATS_UNAVAILABLE' }>['error']['details']['reason']
): ProjectionDiagnostic {
  return {
    source: 'sdk',
    sdk_id: SDK_ID,
    field: `products[${product.product_id}].format_options`,
    code: 'CANONICAL_PRODUCT_FORMATS_UNAVAILABLE',
    error: {
      details: {
        product_id: product.product_id,
        reason,
      },
    },
  };
}

function errorIdentity(value: Record<string, unknown>): string | undefined {
  if (typeof value.code !== 'string' || typeof value.field !== 'string') return undefined;
  try {
    return `${value.code}\u0000${value.field}\u0000${canonicalizeJson(value.details ?? null)}`;
  } catch {
    // Preserve unreadable third-party errors instead of falsely deduplicating.
    return undefined;
  }
}

function mergeProjectionErrors(existing: unknown, diagnostics: readonly ProjectionDiagnostic[]): unknown[] {
  const merged = Array.isArray(existing) ? [...existing] : [];
  const seen = new Set<string>();
  for (const value of merged) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    const key = errorIdentity(record);
    if (key) seen.add(key);
  }
  for (const diagnostic of diagnostics) {
    const error = projectionDiagnosticToError(diagnostic) as unknown as Record<string, unknown>;
    const key = errorIdentity(error)!;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(error);
  }
  return merged;
}

function remapExistingProductErrors(
  existing: unknown,
  originalToOutputIndex: ReadonlyMap<number, number | undefined>,
  products: readonly V1Product[]
): unknown {
  if (!Array.isArray(existing)) return existing;
  return existing.map(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const record = value as Record<string, unknown>;
    let issuesChanged = false;
    const issues = Array.isArray(record.issues)
      ? record.issues.map(issue => {
          if (!issue || typeof issue !== 'object' || Array.isArray(issue)) return issue;
          const issueRecord = issue as Record<string, unknown>;
          if (typeof issueRecord.pointer !== 'string') return issue;
          const pointerMatch = /^\/products\/(\d+)(\/.*)?$/.exec(issueRecord.pointer);
          if (!pointerMatch) return issue;
          const originalIssueIndex = Number(pointerMatch[1]);
          if (!originalToOutputIndex.has(originalIssueIndex)) return issue;
          const outputIssueIndex = originalToOutputIndex.get(originalIssueIndex);
          issuesChanged = true;
          return {
            ...issueRecord,
            pointer:
              outputIssueIndex === undefined ? '/products' : `/products/${outputIssueIndex}${pointerMatch[2] ?? ''}`,
          };
        })
      : record.issues;
    const withIssues = issuesChanged ? { ...record, issues } : record;
    if (typeof record.field !== 'string') return issuesChanged ? withIssues : value;
    const match = /^products\[(\d+)\](.*)$/.exec(record.field);
    if (!match) return issuesChanged ? withIssues : value;
    const originalIndex = Number(match[1]);
    if (!originalToOutputIndex.has(originalIndex)) return issuesChanged ? withIssues : value;
    const outputIndex = originalToOutputIndex.get(originalIndex);
    if (outputIndex !== undefined) {
      return { ...withIssues, field: `products[${outputIndex}]${match[2] ?? ''}` };
    }
    const productId = products[originalIndex]?.product_id;
    const details =
      record.details && typeof record.details === 'object' && !Array.isArray(record.details)
        ? { ...(record.details as Record<string, unknown>) }
        : {};
    if (typeof productId === 'string' && details.product_id === undefined) details.product_id = productId;
    return { ...withIssues, field: 'products', ...(Object.keys(details).length > 0 ? { details } : {}) };
  });
}

function hasEmptyPlacementFormatOptions(product: CanonicalOnlyProduct<V1Product>): boolean {
  const placements = (product as Record<string, unknown>).placements;
  if (!Array.isArray(placements)) return false;
  return placements.some(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const options = (value as Record<string, unknown>).format_options;
    return Array.isArray(options) && options.length === 0;
  });
}

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
  product: P,
  options?: V1ToV2ProjectionOptions
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
  const { v2, diagnostics } = projectV1ProductToV2(product, options);
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
  response: R,
  options?: V1ToV2ProjectionOptions
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
    const { product, diagnostics: d } = augmentProductWithFormatOptions(p, options);
    out.push(product);
    diagnostics.push(...d);
  }
  return {
    response: { ...response, products: out } as R & { products: V2AugmentedProduct<V1Product>[] },
    diagnostics,
  };
}

/**
 * An additive canonical Product: canonical declarations contain no legacy
 * routing identity, while the Product's top-level `format_ids[]` remains
 * available to compatibility consumers.
 */
export type AdditiveCanonicalProduct<P> = Omit<P, 'format_options'> & {
  format_options: CanonicalFormatDeclaration[];
};

function assertNoDirectLegacyFormatAliases(declarations: readonly V2ProductFormatDeclaration[]): void {
  for (let index = 0; index < declarations.length; index++) {
    const declaration = declarations[index] as unknown as Record<string, unknown>;
    for (const field of Object.keys(declaration)) {
      if (
        field !== 'v1_format_ref' &&
        DIRECT_LEGACY_FORMAT_IDENTITY_KEYS.has(field.replaceAll('_', '').toLowerCase())
      ) {
        throw new TypeError(
          `format_options[${index}] must not use legacy identity field ${field}; use v1_format_ref for migration routing`
        );
      }
    }
  }
}

/**
 * Conceal migration-only legacy identities from canonical format declarations
 * while extracting their durable downgrade routes first.
 *
 * This is the declaration-array counterpart to
 * {@link toAdditiveCanonicalProduct}. It is intended for persisted catalogs
 * and other consumers that do not hold a complete Product. The source array
 * and declarations are never mutated.
 *
 * @throws TypeError when a canonical declaration uses a direct legacy identity
 * alias such as `agent_url` or `agentUrl` instead of `v1_format_ref`.
 */
export function toCanonicalFormatOptionsWithRoutes(
  productId: string,
  formatOptions: readonly V2ProductFormatDeclaration[]
): {
  formatOptions: CanonicalFormatDeclaration[];
  routes: CanonicalFormatLegacyRoute[];
} {
  assertNoDirectLegacyFormatAliases(formatOptions);
  const routes = legacyRoutesForProduct(productId, formatOptions);
  return {
    formatOptions: canonicalDeclarations(formatOptions),
    routes,
  };
}

/**
 * Project a Product to an additive, URL-free canonical surface.
 *
 * Unlike {@link augmentProductWithFormatOptions}, this always returns fresh
 * `format_options[]` declarations with `v1_format_ref` concealed. Unlike
 * {@link toCanonicalOnlyProduct}, it preserves the Product's top-level
 * `format_ids[]`. Exact canonical-to-legacy downgrade identity is returned
 * separately as JSON-safe {@link CanonicalFormatLegacyRoute} sidecars.
 *
 * Extract `routes` before any JSON round-trip — WeakMap metadata is gone after
 * deserialization. This helper enforces that ordering internally; persist its
 * returned `routes` whenever a canonical selection may cross a process boundary
 * before being forwarded to a legacy seller. Rebuild the write-side resolver
 * with `canonicalFormatLegacyResolverFromRoutes(restoredRoutes)`.
 *
 * @throws TypeError when a canonical declaration uses a direct legacy identity
 * alias such as `agent_url` or `agentUrl` instead of `v1_format_ref`.
 */
export function toAdditiveCanonicalProduct<P extends V1Product>(
  product: P,
  options?: V1ToV2ProjectionOptions
): {
  product: AdditiveCanonicalProduct<P>;
  diagnostics: ProjectionDiagnostic[];
  routes: CanonicalFormatLegacyRoute[];
} {
  const { product: augmented, diagnostics } = augmentProductWithFormatOptions(product, options);
  const projected = toCanonicalFormatOptionsWithRoutes(product.product_id, augmented.format_options);
  return {
    product: {
      ...augmented,
      format_options: projected.formatOptions,
    } as AdditiveCanonicalProduct<P>,
    diagnostics,
    routes: projected.routes,
  };
}

/**
 * Response-level companion to {@link toAdditiveCanonicalProduct}. Projects
 * every Product and accumulates its serializable legacy routes.
 */
export function withAdditiveCanonicalFormatOptions<R extends { products?: V1Product[] }>(
  response: R,
  options?: V1ToV2ProjectionOptions
): {
  response: Omit<R, 'products'> & { products: AdditiveCanonicalProduct<V1Product>[] };
  diagnostics: ProjectionDiagnostic[];
  routes: CanonicalFormatLegacyRoute[];
} {
  if (!Array.isArray(response?.products)) {
    return {
      response: { ...response, products: [] } as Omit<R, 'products'> & {
        products: AdditiveCanonicalProduct<V1Product>[];
      },
      diagnostics: [],
      routes: [],
    };
  }
  const products: AdditiveCanonicalProduct<V1Product>[] = [];
  const diagnostics: ProjectionDiagnostic[] = [];
  const routes: CanonicalFormatLegacyRoute[] = [];
  for (const sourceProduct of response.products) {
    const projected = toAdditiveCanonicalProduct(sourceProduct, options);
    products.push(projected.product);
    diagnostics.push(...projected.diagnostics);
    routes.push(...projected.routes);
  }
  return {
    response: { ...response, products } as Omit<R, 'products'> & {
      products: AdditiveCanonicalProduct<V1Product>[];
    },
    diagnostics,
    routes,
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
  format_ids?: never;
  format_options: CanonicalFormatDeclaration[];
};

function canonicalDeclarations(values: readonly V2ProductFormatDeclaration[]): CanonicalFormatDeclaration[] {
  return values.map(value => concealLegacyFormatRefs(value));
}

function canonicalPlacements(
  product: Record<string, unknown>,
  options: V1ToV2ProjectionOptions | undefined,
  diagnostics: ProjectionDiagnostic[]
): unknown {
  if (!Array.isArray(product.placements)) return product.placements;
  return product.placements.map((value, placementIndex) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const placement = value as Record<string, unknown>;
    const { format_ids: _drop, ...rest } = placement;
    void _drop;
    const hasLegacyFormats = Array.isArray(placement.format_ids);
    const hasCanonicalFormats = Array.isArray(placement.format_options);
    if (!hasLegacyFormats && !hasCanonicalFormats) return rest;

    const productId = typeof product.product_id === 'string' ? product.product_id : '(unknown)';
    const placementId = typeof placement.placement_id === 'string' ? placement.placement_id : String(placementIndex);
    const pseudoProduct = {
      product_id: `${productId}:placement:${placementId}`,
      name: typeof placement.name === 'string' ? placement.name : placementId,
      description: `Nested placement ${placementId}`,
      ...(hasLegacyFormats ? { format_ids: placement.format_ids } : {}),
      ...(hasCanonicalFormats ? { format_options: placement.format_options } : {}),
    } as unknown as V1Product;
    const projected = toCanonicalOnlyProduct(pseudoProduct, options);
    for (const diagnostic of projected.diagnostics) {
      diagnostics.push({
        ...diagnostic,
        field: diagnostic.field.replace(/^products\[[^\]]+\]/, `products[${productId}].placements[${placementIndex}]`),
      });
    }
    return {
      ...rest,
      format_options: projected.product.format_options,
    };
  });
}

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
 *     legacy routing entry exists that no canonical option covers, it
 *     surfaces a canonical-safe `LEGACY_FORMAT_ID_DROPPED_UNMAPPED`
 *     diagnostic without echoing the routing identifier.
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
  product: P,
  options?: V1ToV2ProjectionOptions
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
          diagnostics.push({
            source: 'sdk',
            sdk_id: SDK_ID,
            field: `products[${product.product_id}].format_options`,
            code: 'LEGACY_FORMAT_ID_DROPPED_UNMAPPED',
            error: {
              details: {
                product_id: product.product_id,
                resolution_failure: 'unmapped_legacy_format',
              },
            },
          });
        }
      }
    }
    const { format_ids: _dropV2, ...rest } = product as P & { format_ids?: unknown };
    void _dropV2;
    return {
      product: {
        ...rest,
        format_options: canonicalDeclarations(formatOptions),
        ...(Array.isArray((product as Record<string, unknown>).placements)
          ? { placements: canonicalPlacements(product as Record<string, unknown>, options, diagnostics) }
          : {}),
      } as CanonicalOnlyProduct<P>,
      diagnostics: diagnostics.map(canonicalDiagnostic),
    };
  }

  // v1 shape: project. projectV1ProductToV2 already omits format_ids and
  // emits a diagnostic for every ref it couldn't map.
  if (Array.isArray(product.format_ids)) {
    const { v2, diagnostics } = projectV1ProductToV2(product, options);
    const { format_ids: _dropV1, ...rest } = product as P & { format_ids?: unknown };
    void _dropV1;
    return {
      product: {
        ...(rest as Omit<P, 'format_ids'>),
        format_options: canonicalDeclarations(v2.format_options),
        ...(Array.isArray((product as Record<string, unknown>).placements)
          ? { placements: canonicalPlacements(product as Record<string, unknown>, options, diagnostics) }
          : {}),
      } as CanonicalOnlyProduct<P>,
      diagnostics: diagnostics.map(canonicalDiagnostic),
    };
  }

  // Neither shape — nothing to project, nothing to lose.
  const { format_ids: _dropNone, ...rest } = product as P & { format_ids?: unknown };
  void _dropNone;
  const diagnostics: ProjectionDiagnostic[] = [];
  return {
    product: {
      ...(rest as Omit<P, 'format_ids'>),
      format_options: [],
      ...(Array.isArray((product as Record<string, unknown>).placements)
        ? { placements: canonicalPlacements(product as Record<string, unknown>, options, diagnostics) }
        : {}),
    } as CanonicalOnlyProduct<P>,
    diagnostics: diagnostics.map(canonicalDiagnostic),
  };
}

/**
 * Reduce every Product in a `get_products` response to the canonical-only
 * shape — `format_options[]` present, `format_ids[]` dropped. Returns
 * `{ response, diagnostics }` so callers surface projection diagnostics
 * alongside the response's existing `errors[]`.
 *
 * Response-level counterpart to {@link toCanonicalOnlyProduct}; same
 * fail-closed guarantee, aggregated across products. A wholly unmappable
 * legacy product cannot be represented as a canonical Product because the
 * protocol requires `format_options` to contain at least one declaration. It
 * is therefore omitted from the canonical list and surfaced through the
 * response's portable `errors[]` plus the SDK convenience diagnostics. A
 * partially mappable product remains with its mapped options and advisories
 * for the refs that could not be projected.
 */
export function toCanonicalOnlyResponse<R extends { products?: V1Product[] }>(
  response: R,
  options?: V1ToV2ProjectionOptions
): {
  response: Omit<R, 'products'> & { products: CanonicalOnlyProduct<V1Product>[]; errors?: unknown[] };
  diagnostics: ProjectionDiagnostic[];
} {
  if (!Array.isArray(response?.products)) {
    return {
      response: { ...response, products: [] } as Omit<R, 'products'> & {
        products: CanonicalOnlyProduct<V1Product>[];
        errors?: unknown[];
      },
      diagnostics: [],
    };
  }
  const out: CanonicalOnlyProduct<V1Product>[] = [];
  const diagnostics: ProjectionDiagnostic[] = [];
  const originalToOutputIndex = new Map<number, number | undefined>();
  for (let productIndex = 0; productIndex < response.products.length; productIndex++) {
    const p = response.products[productIndex]!;
    const { product, diagnostics: rawDiagnostics } = toCanonicalOnlyProduct(p, options);
    const hasEmptyPlacement = hasEmptyPlacementFormatOptions(product);
    const keep = product.format_options.length > 0 && !hasEmptyPlacement;
    const outputIndex = keep ? out.length : undefined;
    originalToOutputIndex.set(productIndex, outputIndex);
    const d = rawDiagnostics.map(diagnostic => ({
      ...diagnostic,
      field: keep ? diagnostic.field.replace(/^products\[[^\]]+\]/, `products[${outputIndex}]`) : 'products',
      error: keep
        ? diagnostic.error
        : {
            details: {
              ...diagnostic.error.details,
              product_id: p.product_id,
            },
          },
    })) as ProjectionDiagnostic[];
    if (!keep && d.length === 0) {
      const reason = hasEmptyPlacement
        ? 'nested_placement_format_list_empty'
        : Array.isArray((p as Record<string, unknown>).format_options)
          ? 'canonical_format_list_empty'
          : Array.isArray(p.format_ids)
            ? 'legacy_format_list_empty'
            : 'missing_format_declaration';
      d.push({
        ...canonicalFormatsUnavailableForProduct(p, reason),
        field: 'products',
      });
    }
    diagnostics.push(...d);
    if (keep) out.push(product);
  }
  const remappedExistingErrors = remapExistingProductErrors(
    (response as { errors?: unknown }).errors,
    originalToOutputIndex,
    response.products
  );
  const errors = mergeProjectionErrors(remappedExistingErrors, diagnostics);
  return {
    response: {
      ...response,
      products: out,
      ...(errors.length > 0 ? { errors } : {}),
    } as Omit<R, 'products'> & { products: CanonicalOnlyProduct<V1Product>[]; errors?: unknown[] },
    diagnostics,
  };
}
