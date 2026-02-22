/**
 * Backwards compatibility types kept so existing callers don't break on upgrade.
 */

import type { BrandReference, Catalog } from './tools.generated';

// ===== PromotedOfferings / PromotedProducts migration =====
// promoted_offerings was replaced by a top-level brand field + per-package catalog field.
// PromotedProducts selection methods (manifest_gtins, manifest_skus, etc.) map to the new
// Catalog type (gtins, ids, tags, category, query).

/**
 * @deprecated Use Catalog instead. Product selection is now expressed as a Catalog with
 * a 'product' type. Map fields: manifest_gtins→gtins, manifest_skus→ids,
 * manifest_tags→tags, manifest_category→category, manifest_query→query.
 */
export interface PromotedProducts {
  manifest_gtins?: string[];
  manifest_skus?: string[];
  manifest_tags?: string[];
  manifest_category?: string;
  manifest_query?: string;
  [k: string]: unknown | undefined;
}

/**
 * @deprecated Use a top-level brand field (BrandReference) and per-package catalog (Catalog)
 * in create_media_buy instead.
 */
export interface PromotedOfferings {
  brand?: BrandReference;
  si_agent_url?: string;
  product_selectors?: PromotedProducts;
  offerings?: Array<{
    offering_id?: string;
    name?: string;
    description?: string;
    landing_url?: string;
    [k: string]: unknown;
  }>;
  asset_selectors?: {
    tags?: string[];
    asset_types?: (
      | 'image'
      | 'video'
      | 'audio'
      | 'vast'
      | 'daast'
      | 'text'
      | 'url'
      | 'html'
      | 'css'
      | 'javascript'
      | 'webhook'
    )[];
    exclude_tags?: string[];
    [k: string]: unknown | undefined;
  };
  [k: string]: unknown | undefined;
}

/**
 * Convert deprecated PromotedProducts selectors to the new Catalog type.
 */
export function promotedProductsToCatalog(pp: PromotedProducts): Catalog {
  return {
    type: 'product',
    ...(pp.manifest_gtins?.length && { gtins: pp.manifest_gtins as [string, ...string[]] }),
    ...(pp.manifest_skus?.length && { ids: pp.manifest_skus as [string, ...string[]] }),
    ...(pp.manifest_tags?.length && { tags: pp.manifest_tags as [string, ...string[]] }),
    ...(pp.manifest_category && { category: pp.manifest_category }),
    ...(pp.manifest_query && { query: pp.manifest_query }),
  };
}

/**
 * @deprecated Use BrandReference instead. Inline brand data is no longer part of
 * the AdCP protocol. Host your brand data at /.well-known/brand.json and pass
 * a BrandReference with the domain field.
 */
export interface BrandManifest {
  name: string;
  url?: string;
  tagline?: string;
  logos?: Array<{
    url: string;
    orientation?: 'square' | 'horizontal' | 'vertical' | 'stacked';
    background?: 'dark-bg' | 'light-bg' | 'transparent-bg';
    variant?: 'primary' | 'secondary' | 'icon' | 'wordmark' | 'full-lockup';
    tags?: string[];
    usage?: string;
    width?: number;
    height?: number;
  }>;
  colors?: Record<string, string>;
  tone?: {
    voice?: string;
    attributes?: string[];
    dos?: string[];
    donts?: string[];
  };
  assets?: Array<{
    asset_id: string;
    asset_type: string;
    url: string;
    width?: number;
    height?: number;
    tags?: string[];
  }>;
}

/**
 * @deprecated Use BrandReference instead.
 */
export type BrandManifestReference = BrandManifest | string;

/**
 * @deprecated Only used with the deprecated BrandManifest type.
 */
export type AssetContentType = string;

/**
 * Convert a deprecated BrandManifestReference to the new BrandReference.
 * Extracts the domain from the manifest URL when available.
 * Returns undefined if no URL is present (name-only manifests cannot be converted).
 */
export function brandManifestToBrandReference(manifest: BrandManifestReference): BrandReference | undefined {
  const url = typeof manifest === 'string' ? manifest : manifest.url;
  if (!url) return undefined;
  try {
    return { domain: new URL(url).hostname };
  } catch {
    return undefined;
  }
}
