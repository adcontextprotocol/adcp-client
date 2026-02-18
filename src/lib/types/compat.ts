/**
 * Backwards compatibility types for the BrandManifest -> BrandReference migration.
 *
 * BrandManifest (inline brand data) was replaced by BrandReference (domain pointer)
 * in the AdCP schema. Sellers now host brand data at /.well-known/brand.json and
 * buyers reference it by domain rather than passing it inline.
 *
 * @deprecated Use BrandReference instead.
 */

import type { BrandReference } from './tools.generated';

/**
 * @deprecated Only used with the deprecated BrandManifest type.
 */
export type AssetContentType =
  | 'image'
  | 'video'
  | 'audio'
  | 'text'
  | 'markdown'
  | 'html'
  | 'css'
  | 'javascript'
  | 'vast'
  | 'daast'
  | 'promoted_offerings'
  | 'url'
  | 'webhook';

/**
 * @deprecated Use BrandReference instead. Brand data is now hosted at
 * /.well-known/brand.json and referenced by domain.
 */
export interface BrandManifest {
  url?: string;
  privacy_policy_url?: string;
  name: string;
  logos?: {
    url: string;
    orientation?: 'square' | 'horizontal' | 'vertical' | 'stacked';
    background?: 'dark-bg' | 'light-bg' | 'transparent-bg';
    variant?: 'primary' | 'secondary' | 'icon' | 'wordmark' | 'full-lockup';
    tags?: string[];
    usage?: string;
    width?: number;
    height?: number;
  }[];
  colors?: {
    primary?: string | [string, ...string[]];
    secondary?: string | [string, ...string[]];
    accent?: string | [string, ...string[]];
    background?: string | [string, ...string[]];
    text?: string | [string, ...string[]];
  };
  fonts?: {
    primary?: string;
    secondary?: string;
    font_urls?: string[];
  };
  tone?:
    | string
    | {
        voice?: string;
        attributes?: string[];
        dos?: string[];
        donts?: string[];
      };
  voice?: {
    provider?: string;
    voice_id?: string;
    settings?: Record<string, unknown>;
  };
  avatar?: {
    provider?: string;
    avatar_id?: string;
    settings?: Record<string, unknown>;
  };
  tagline?: string;
  assets?: {
    asset_id: string;
    asset_type: AssetContentType;
    url: string;
    tags?: string[];
    name?: string;
    description?: string;
    width?: number;
    height?: number;
    duration_seconds?: number;
    file_size_bytes?: number;
    format?: string;
    metadata?: Record<string, unknown>;
  }[];
  product_catalog?: {
    feed_url: string;
    feed_format?: 'google_merchant_center' | 'facebook_catalog' | 'openai_product_feed' | 'custom';
    categories?: string[];
    last_updated?: string;
    update_frequency?: 'realtime' | 'hourly' | 'daily' | 'weekly';
    agentic_checkout?: {
      endpoint: string;
      spec: 'openai_agentic_checkout_v1';
      supported_payment_providers?: string[];
    };
  };
  disclaimers?: { text: string; context?: string; required?: boolean }[];
  industry?: string;
  target_audience?: string;
  contact?: { email?: string; phone?: string };
  metadata?: { created_date?: string; updated_date?: string; version?: string };
  [k: string]: unknown | undefined;
}

/**
 * @deprecated Use BrandReference instead.
 */
export type BrandManifestReference = BrandManifest | string;

/**
 * Convert a legacy BrandManifestReference to the new BrandReference format.
 *
 * Extracts the domain from the manifest URL. Returns undefined if no URL is
 * present (inline name-only manifests cannot be converted to a domain reference).
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
