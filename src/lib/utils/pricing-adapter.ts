/**
 * Pricing Option Adapter
 *
 * Handles conversion between v2.x and v3 pricing option field names.
 * The library exposes only v3 API (fixed_price, floor_price) to clients,
 * and internally adapts requests for v2.x servers.
 *
 * Field mappings:
 * - v3 fixed_price ↔ v2 rate (for fixed pricing)
 * - v3 floor_price ↔ v2 price_guidance.floor (for auction pricing)
 * - v3 presence of fixed_price ↔ v2 is_fixed: true/false
 */

/**
 * v3 price guidance (percentiles only, floor moved to top level)
 */
export interface PriceGuidanceV3 {
  p25?: number;
  p50?: number;
  p75?: number;
  p90?: number;
}

/**
 * v2 price guidance (includes floor)
 */
export interface PriceGuidanceV2 {
  floor?: number;
  p25?: number;
  p50?: number;
  p75?: number;
  p90?: number;
}

/**
 * v3 pricing option structure
 */
export interface PricingOptionV3 {
  pricing_option_id: string;
  pricing_model: string;
  currency: string;
  /** Fixed price - if present, this is fixed pricing */
  fixed_price?: number;
  /** Floor price for auction - mutually exclusive with fixed_price */
  floor_price?: number;
  /** Percentile hints for auction bidding */
  price_guidance?: PriceGuidanceV3;
  min_spend_per_package?: number;
  parameters?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * v2 pricing option structure
 */
export interface PricingOptionV2 {
  pricing_option_id: string;
  pricing_model: string;
  currency: string;
  /** Fixed rate (v2 name for fixed_price) */
  rate?: number;
  /** Boolean discriminator for fixed vs auction */
  is_fixed?: boolean;
  /** Price guidance including floor */
  price_guidance?: PriceGuidanceV2;
  min_spend_per_package?: number;
  parameters?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Check if a pricing option uses v2 field names
 */
export function usesV2PricingFields(option: any): boolean {
  if (!option || typeof option !== 'object') return false;
  // v2 uses 'rate' or 'is_fixed' or has floor inside price_guidance
  return option.rate !== undefined || option.is_fixed !== undefined || option.price_guidance?.floor !== undefined;
}

/**
 * Check if a pricing option uses v3 field names
 */
export function usesV3PricingFields(option: any): boolean {
  if (!option || typeof option !== 'object') return false;
  // v3 uses fixed_price or floor_price at top level
  return option.fixed_price !== undefined || option.floor_price !== undefined;
}

/**
 * Detect if a pricing option is fixed pricing (works with v2 or v3)
 */
export function isFixedPricing(option: PricingOptionV2 | PricingOptionV3): boolean {
  // v3: presence of fixed_price indicates fixed pricing
  if ((option as PricingOptionV3).fixed_price !== undefined) {
    return true;
  }
  // v2: is_fixed boolean
  if ((option as PricingOptionV2).is_fixed !== undefined) {
    return (option as PricingOptionV2).is_fixed!;
  }
  // v2: presence of rate without is_fixed defaults to fixed
  if ((option as PricingOptionV2).rate !== undefined) {
    return true;
  }
  return false;
}

/**
 * Detect if a pricing option is CPA (cost per acquisition) pricing
 */
export function isCPAPricing(option: PricingOptionV2 | PricingOptionV3): boolean {
  return option?.pricing_model === 'cpa';
}

/**
 * Get the price value from a pricing option (works with v2 or v3)
 */
export function getPrice(option: PricingOptionV2 | PricingOptionV3): number | undefined {
  // v3 field takes precedence
  if ((option as PricingOptionV3).fixed_price !== undefined) {
    return (option as PricingOptionV3).fixed_price;
  }
  // Fall back to v2 field
  return (option as PricingOptionV2).rate;
}

/**
 * Get the floor price from a pricing option (works with v2 or v3)
 */
export function getFloorPrice(option: PricingOptionV2 | PricingOptionV3): number | undefined {
  // v3 field takes precedence
  if ((option as PricingOptionV3).floor_price !== undefined) {
    return (option as PricingOptionV3).floor_price;
  }
  // Fall back to v2 field (inside price_guidance)
  return (option as PricingOptionV2).price_guidance?.floor;
}

/**
 * Adapt a v3-style pricing option for a v2 server.
 * Converts fixed_price → rate, floor_price → price_guidance.floor
 */
export function adaptPricingOptionForV2(option: PricingOptionV3): PricingOptionV2 {
  // Already v2 format or no v3 fields
  if (!usesV3PricingFields(option)) {
    return option as unknown as PricingOptionV2;
  }

  const { fixed_price, floor_price, price_guidance, ...rest } = option;

  const result: PricingOptionV2 = { ...rest } as PricingOptionV2;

  if (fixed_price !== undefined) {
    // Fixed pricing
    result.rate = fixed_price;
    result.is_fixed = true;
  } else {
    // Auction pricing
    result.is_fixed = false;

    // Build v2 price_guidance with floor inside
    if (floor_price !== undefined || price_guidance) {
      result.price_guidance = {
        ...(price_guidance || {}),
      };
      if (floor_price !== undefined) {
        result.price_guidance.floor = floor_price;
      }
    }
  }

  return result;
}

/**
 * Normalize a v2-style pricing option to v3.
 * Converts rate → fixed_price, price_guidance.floor → floor_price
 */
export function normalizePricingOption(option: PricingOptionV2 | PricingOptionV3): PricingOptionV3 {
  // Already v3 format
  if (usesV3PricingFields(option) && !usesV2PricingFields(option)) {
    return option as PricingOptionV3;
  }

  const v2Option = option as PricingOptionV2;
  const { rate, is_fixed, price_guidance, ...rest } = v2Option;

  const result: PricingOptionV3 = { ...rest } as PricingOptionV3;

  // Convert rate → fixed_price (for fixed pricing)
  if (rate !== undefined && (is_fixed === true || is_fixed === undefined)) {
    result.fixed_price = rate;
  }

  // Convert price_guidance.floor → floor_price (for auction pricing)
  if (price_guidance) {
    const { floor, ...percentiles } = price_guidance;

    if (floor !== undefined) {
      result.floor_price = floor;
    }

    // Keep percentiles in price_guidance if any exist
    if (Object.keys(percentiles).length > 0) {
      result.price_guidance = percentiles;
    }
  }

  return result;
}

/**
 * Adapt all pricing options in a product for v2 server
 */
export function adaptProductPricingForV2(product: any): any {
  if (!product?.pricing_options || !Array.isArray(product.pricing_options)) {
    return product;
  }

  return {
    ...product,
    pricing_options: product.pricing_options.map(adaptPricingOptionForV2),
  };
}

/**
 * Normalize all pricing options in a product to v3
 */
export function normalizeProductPricing(product: any): any {
  if (!product?.pricing_options || !Array.isArray(product.pricing_options)) {
    return product;
  }

  return {
    ...product,
    pricing_options: product.pricing_options.map(normalizePricingOption),
  };
}

/**
 * Adapt a get_products request for a v2 server.
 *
 * Converts v3 fields to their v2 equivalents:
 * - brand (BrandReference) → brand_manifest (string URL)
 * - catalog → promoted_offerings (type='offering') or promoted_offerings.product_selectors (type='product')
 * - channels in filters → v2 channel names
 *
 * Strips v3-only fields v2 agents don't understand:
 * - buying_mode, buyer_campaign_ref, property_list, account_id, pagination (top-level)
 * - filters: required_features, required_axe_integrations, required_geo_targeting,
 *            signal_targeting, regions, metros
 */
export function adaptGetProductsRequestForV2(request: any): any {
  const adapted: any = { ...request };

  // Convert v3 brand (BrandReference) → v2 brand_manifest (string URL)
  if (adapted.brand?.domain) {
    adapted.brand_manifest = `https://${adapted.brand.domain}/.well-known/brand.json`;
    delete adapted.brand;
  }

  // Convert v3 catalog → v2 promoted_offerings
  if (adapted.catalog) {
    const catalog = adapted.catalog;
    if (catalog.type === 'product') {
      adapted.promoted_offerings = {
        product_selectors: {
          ...(catalog.gtins?.length && { manifest_gtins: catalog.gtins }),
          ...(catalog.ids?.length && { manifest_skus: catalog.ids }),
          ...(catalog.tags?.length && { manifest_tags: catalog.tags }),
          ...(catalog.category && { manifest_category: catalog.category }),
          ...(catalog.query && { manifest_query: catalog.query }),
        },
      };
    } else if (catalog.type === 'offering') {
      adapted.promoted_offerings = {
        ...(catalog.items?.length && { offerings: catalog.items }),
      };
    }
    delete adapted.catalog;
  }

  // Map v3 channel names to v2 equivalents
  if (adapted.filters?.channels) {
    const v2ChannelMap: Record<string, string> = {
      olv: 'video',
      ctv: 'video',
      streaming_audio: 'audio',
      retail_media: 'retail',
    };
    // Deduplicate after mapping (e.g. olv+ctv both become 'video')
    const mapped = adapted.filters.channels.map((ch: string) => v2ChannelMap[ch] ?? ch);
    adapted.filters = {
      ...adapted.filters,
      channels: [...new Set(mapped)],
    };
  }

  // Strip v3-only filter fields (format_ids exists in both v2 and v3, keep it)
  if (adapted.filters) {
    const { required_features, required_axe_integrations, required_geo_targeting, signal_targeting, regions, metros, ...v2Filters } = adapted.filters;
    adapted.filters = v2Filters;
  }

  // Strip v3-only top-level fields
  delete adapted.buying_mode;
  delete adapted.buyer_campaign_ref;
  delete adapted.property_list;
  delete adapted.account_id;
  delete adapted.pagination;

  return adapted;
}

/**
 * Normalize v2 channel names on a product to v3.
 * v2 used coarser buckets; some map one-to-many (e.g. 'video' → ['olv', 'ctv']).
 */
export function normalizeProductChannels(product: any): any {
  if (!product?.channels || !Array.isArray(product.channels)) {
    return product;
  }

  const v3ChannelMap: Record<string, string[]> = {
    video: ['olv', 'ctv'],
    audio: ['streaming_audio'],
    native: ['display'],
    retail: ['retail_media'],
  };

  const normalized = product.channels.flatMap((ch: string) => v3ChannelMap[ch] ?? [ch]);
  return { ...product, channels: [...new Set(normalized)] };
}

/**
 * Normalize all products in a get_products response to v3
 */
export function normalizeGetProductsResponse(response: any): any {
  if (!response?.products || !Array.isArray(response.products)) {
    return response;
  }

  return {
    ...response,
    products: response.products.map((p: any) => normalizeProductChannels(normalizeProductPricing(p))),
  };
}

/**
 * Adapt a package request's pricing option selection for v2 server.
 * This handles bid_price which references pricing option floor semantics.
 */
export function adaptPackagePricingForV2(pkg: any): any {
  // Package requests don't typically contain pricing_options,
  // but they do contain pricing_option_id which selects one.
  // No transformation needed for bid_price - it's the same in both versions.
  return pkg;
}

/**
 * Adapt a create_media_buy request for v2 server (pricing fields)
 */
export function adaptMediaBuyPricingForV2(request: any): any {
  // Media buy requests select pricing options by ID, not by defining them.
  // No pricing field transformation needed in requests.
  return request;
}

/**
 * Normalize a media buy response's package pricing to v3
 */
export function normalizeMediaBuyPricingResponse(response: any): any {
  // Media buy responses may include products with pricing_options
  if (response?.products && Array.isArray(response.products)) {
    return {
      ...response,
      products: response.products.map(normalizeProductPricing),
    };
  }
  return response;
}
