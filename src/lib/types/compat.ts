/**
 * Backwards compatibility types for the BrandManifest -> BrandReference migration.
 *
 * BrandManifest (inline brand data) was replaced by BrandReference (a domain pointer
 * to a hosted /.well-known/brand.json file). These deprecated types are kept so that
 * existing callers don't break on upgrade.
 *
 * @deprecated Use BrandReference from the main package instead.
 */

import type { BrandReference } from './tools.generated';

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
