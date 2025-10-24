// Generated AdCP core types from official schemas v2.2.0
// Generated at: 2025-10-24T11:16:31.795Z

// MEDIA-BUY SCHEMA
/**
 * Status of a media buy
 */
export type MediaBuyStatus = 'pending_activation' | 'active' | 'paused' | 'completed';
/**
 * Budget pacing strategy
 */
export type Pacing = 'even' | 'asap' | 'front_loaded';
/**
 * Status of a package
 */
export type PackageStatus = 'draft' | 'active' | 'paused' | 'completed';

/**
 * Represents a purchased advertising campaign
 */
export interface MediaBuy {
  /**
   * Publisher's unique identifier for the media buy
   */
  media_buy_id: string;
  /**
   * Buyer's reference identifier for this media buy
   */
  buyer_ref?: string;
  status: MediaBuyStatus;
  /**
   * Description of advertiser and what is being promoted
   */
  promoted_offering: string;
  /**
   * Total budget amount
   */
  total_budget: number;
  /**
   * Array of packages within this media buy
   */
  packages: Package[];
  /**
   * ISO 8601 timestamp for creative upload deadline
   */
  creative_deadline?: string;
  /**
   * Creation timestamp
   */
  created_at?: string;
  /**
   * Last update timestamp
   */
  updated_at?: string;
}
/**
 * A specific product within a media buy (line item)
 */
export interface Package {
  /**
   * Publisher's unique identifier for the package
   */
  package_id: string;
  /**
   * Buyer's reference identifier for this package
   */
  buyer_ref?: string;
  /**
   * ID of the product this package is based on
   */
  product_id?: string;
  /**
   * Budget allocation for this package in the currency specified by the pricing option
   */
  budget?: number;
  pacing?: Pacing;
  /**
   * ID of the selected pricing option from the product's pricing_options array
   */
  pricing_option_id?: string;
  /**
   * Bid price for auction-based CPM pricing (present if using cpm-auction-option)
   */
  bid_price?: number;
  /**
   * Impression goal for this package
   */
  impressions?: number;
  targeting_overlay?: TargetingOverlay;
  /**
   * Creative assets assigned to this package
   */
  creative_assignments?: CreativeAssignment[];
  /**
   * Format IDs that creative assets will be provided for this package
   */
  format_ids_to_provide?: FormatID[];
  status: PackageStatus;
}
/**
 * Optional geographic refinements for media buys. Most targeting should be expressed in the brief and handled by the publisher. These fields are primarily for geographic restrictions (RCT testing, regulatory compliance).
 */
export interface TargetingOverlay {
  /**
   * Restrict delivery to specific countries (ISO codes). Use for regulatory compliance or RCT testing.
   */
  geo_country_any_of?: string[];
  /**
   * Restrict delivery to specific regions/states. Use for regulatory compliance or RCT testing.
   */
  geo_region_any_of?: string[];
  /**
   * Restrict delivery to specific metro areas (DMA codes). Use for regulatory compliance or RCT testing.
   */
  geo_metro_any_of?: string[];
  /**
   * Restrict delivery to specific postal/ZIP codes. Use for regulatory compliance or RCT testing.
   */
  geo_postal_code_any_of?: string[];
  frequency_cap?: FrequencyCap;
}
/**
 * Frequency capping settings for package-level application
 */
export interface FrequencyCap {
  /**
   * Minutes to suppress after impression
   */
  suppress_minutes: number;
}
/**
 * Assignment of a creative asset to a package with optional placement targeting. Used in create_media_buy and update_media_buy requests. Note: sync_creatives does not support placement_ids - use create/update_media_buy for placement-level targeting.
 */
export interface CreativeAssignment {
  /**
   * Unique identifier for the creative
   */
  creative_id: string;
  /**
   * Delivery weight for this creative
   */
  weight?: number;
  /**
   * Optional array of placement IDs where this creative should run. When omitted, the creative runs on all placements in the package. References placement_id values from the product's placements array.
   *
   * @minItems 1
   */
  placement_ids?: [string, ...string[]];
}
/**
 * Structured format identifier with agent URL and format name
 */
export interface FormatID {
  /**
   * URL of the agent that defines this format (e.g., 'https://creatives.adcontextprotocol.org' for standard formats, or 'https://publisher.com/.well-known/adcp/sales' for custom formats)
   */
  agent_url: string;
  /**
   * Format identifier within the agent's namespace (e.g., 'display_300x250', 'video_standard_30s')
   */
  id: string;
}

// CREATIVE-ASSET SCHEMA
/**
 * VAST (Video Ad Serving Template) tag for third-party video ad serving
 */
export type VASTAsset = VASTAsset1 & VASTAsset2;
export type VASTAsset2 = {
  [k: string]: unknown;
};
/**
 * DAAST (Digital Audio Ad Serving Template) tag for third-party audio ad serving
 */
export type DAASTAsset = DAASTAsset1 & DAASTAsset2;
export type DAASTAsset2 = {
  [k: string]: unknown;
};
/**
 * Brand information manifest containing assets, themes, and guidelines. Can be provided inline or as a URL reference to a hosted manifest.
 */
export type BrandManifestReference = BrandManifest | string;
/**
 * Inline brand manifest object
 */
export type BrandManifest = BrandManifest1 & BrandManifest2;
export type BrandManifest1 = {
  [k: string]: unknown;
};

/**
 * Creative asset for upload to library - supports static assets, generative formats, and third-party snippets
 */
export interface CreativeAsset {
  /**
   * Unique identifier for the creative
   */
  creative_id: string;
  /**
   * Human-readable creative name
   */
  name: string;
  format_id: FormatID;
  /**
   * Assets required by the format, keyed by asset_role
   */
  assets: {
    /**
     * This interface was referenced by `undefined`'s JSON-Schema definition
     * via the `patternProperty` "^[a-zA-Z0-9_-]+$".
     */
    [k: string]:
      | ImageAsset
      | VideoAsset
      | AudioAsset
      | TextAsset
      | HTMLAsset
      | CSSAsset
      | JavaScriptAsset
      | VASTAsset
      | DAASTAsset
      | PromotedOfferings
      | URLAsset;
  };
  /**
   * Preview contexts for generative formats - defines what scenarios to generate previews for
   */
  inputs?: {
    /**
     * Human-readable name for this preview variant
     */
    name: string;
    /**
     * Macro values to apply for this preview
     */
    macros?: {
      [k: string]: string;
    };
    /**
     * Natural language description of the context for AI-generated content
     */
    context_description?: string;
  }[];
  /**
   * User-defined tags for organization and searchability
   */
  tags?: string[];
  /**
   * For generative creatives: set to true to approve and finalize, false to request regeneration with updated assets/message. Omit for non-generative creatives.
   */
  approved?: boolean;
}
/**
 * Format identifier specifying which format this creative conforms to
 */
export interface FormatID {
  /**
   * URL of the agent that defines this format (e.g., 'https://creatives.adcontextprotocol.org' for standard formats, or 'https://publisher.com/.well-known/adcp/sales' for custom formats)
   */
  agent_url: string;
  /**
   * Format identifier within the agent's namespace (e.g., 'display_300x250', 'video_standard_30s')
   */
  id: string;
}
/**
 * Image asset with URL and dimensions
 */
export interface ImageAsset {
  /**
   * URL to the image asset
   */
  url: string;
  /**
   * Image width in pixels
   */
  width?: number;
  /**
   * Image height in pixels
   */
  height?: number;
  /**
   * Image file format (jpg, png, gif, webp, etc.)
   */
  format?: string;
  /**
   * Alternative text for accessibility
   */
  alt_text?: string;
}
/**
 * Video asset with URL and specifications
 */
export interface VideoAsset {
  /**
   * URL to the video asset
   */
  url: string;
  /**
   * Video width in pixels
   */
  width?: number;
  /**
   * Video height in pixels
   */
  height?: number;
  /**
   * Video duration in milliseconds
   */
  duration_ms?: number;
  /**
   * Video file format (mp4, webm, mov, etc.)
   */
  format?: string;
  /**
   * Video bitrate in kilobits per second
   */
  bitrate_kbps?: number;
}
/**
 * Audio asset with URL and specifications
 */
export interface AudioAsset {
  /**
   * URL to the audio asset
   */
  url: string;
  /**
   * Audio duration in milliseconds
   */
  duration_ms?: number;
  /**
   * Audio file format (mp3, wav, aac, etc.)
   */
  format?: string;
  /**
   * Audio bitrate in kilobits per second
   */
  bitrate_kbps?: number;
}
/**
 * Text content asset
 */
export interface TextAsset {
  /**
   * Text content
   */
  content: string;
  /**
   * Language code (e.g., 'en', 'es', 'fr')
   */
  language?: string;
}
/**
 * HTML content asset
 */
export interface HTMLAsset {
  /**
   * HTML content
   */
  content: string;
  /**
   * HTML version (e.g., 'HTML5')
   */
  version?: string;
}
/**
 * CSS stylesheet asset
 */
export interface CSSAsset {
  /**
   * CSS content
   */
  content: string;
  /**
   * CSS media query context (e.g., 'screen', 'print')
   */
  media?: string;
}
/**
 * JavaScript code asset
 */
export interface JavaScriptAsset {
  /**
   * JavaScript content
   */
  content: string;
  /**
   * JavaScript module type
   */
  module_type?: 'esm' | 'commonjs' | 'script';
}
export interface VASTAsset1 {
  /**
   * URL endpoint that returns VAST XML
   */
  url?: string;
  /**
   * Inline VAST XML content
   */
  content?: string;
  /**
   * VAST specification version
   */
  vast_version?: '2.0' | '3.0' | '4.0' | '4.1' | '4.2';
  /**
   * Whether VPAID (Video Player-Ad Interface Definition) is supported
   */
  vpaid_enabled?: boolean;
  /**
   * Expected video duration in milliseconds (if known)
   */
  duration_ms?: number;
  /**
   * Tracking events supported by this VAST tag
   */
  tracking_events?: (
    | 'start'
    | 'firstQuartile'
    | 'midpoint'
    | 'thirdQuartile'
    | 'complete'
    | 'impression'
    | 'click'
    | 'pause'
    | 'resume'
    | 'skip'
    | 'mute'
    | 'unmute'
    | 'fullscreen'
    | 'exitFullscreen'
    | 'playerExpand'
    | 'playerCollapse'
  )[];
}
export interface DAASTAsset1 {
  /**
   * URL endpoint that returns DAAST XML
   */
  url?: string;
  /**
   * Inline DAAST XML content
   */
  content?: string;
  /**
   * DAAST specification version
   */
  daast_version?: '1.0' | '1.1';
  /**
   * Expected audio duration in milliseconds (if known)
   */
  duration_ms?: number;
  /**
   * Tracking events supported by this DAAST tag
   */
  tracking_events?: (
    | 'start'
    | 'firstQuartile'
    | 'midpoint'
    | 'thirdQuartile'
    | 'complete'
    | 'impression'
    | 'pause'
    | 'resume'
    | 'skip'
    | 'mute'
    | 'unmute'
  )[];
  /**
   * Whether companion display ads are included
   */
  companion_ads?: boolean;
}
/**
 * Complete offering specification combining brand manifest, product selectors, and asset filters. Provides all context needed for creative generation about what is being promoted.
 */
export interface PromotedOfferings {
  brand_manifest: BrandManifestReference;
  product_selectors?: PromotedProducts;
  /**
   * Inline offerings for campaigns without a product catalog. Each offering has a name, description, and associated assets.
   */
  offerings?: {
    /**
     * Offering name (e.g., 'Winter Sale', 'New Product Launch')
     */
    name: string;
    /**
     * Description of what's being offered
     */
    description?: string;
    /**
     * Assets specific to this offering
     */
    assets?: {
      [k: string]: unknown;
    }[];
  }[];
  /**
   * Selectors to choose specific assets from the brand manifest
   */
  asset_selectors?: {
    /**
     * Select assets with specific tags (e.g., ['holiday', 'premium'])
     */
    tags?: string[];
    /**
     * Filter by asset type (e.g., ['image', 'video'])
     */
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
    /**
     * Exclude assets with these tags
     */
    exclude_tags?: string[];
  };
}
export interface BrandManifest2 {
  /**
   * Primary brand URL for context and asset discovery. Creative agents can infer brand information from this URL.
   */
  url?: string;
  /**
   * Brand or business name
   */
  name?: string;
  /**
   * Brand logo assets with semantic tags for different use cases
   */
  logos?: {
    /**
     * URL to the logo asset
     */
    url: string;
    /**
     * Semantic tags describing the logo variant (e.g., 'dark', 'light', 'square', 'horizontal', 'icon')
     */
    tags?: string[];
    /**
     * Logo width in pixels
     */
    width?: number;
    /**
     * Logo height in pixels
     */
    height?: number;
  }[];
  /**
   * Brand color palette
   */
  colors?: {
    /**
     * Primary brand color (hex format)
     */
    primary?: string;
    /**
     * Secondary brand color (hex format)
     */
    secondary?: string;
    /**
     * Accent color (hex format)
     */
    accent?: string;
    /**
     * Background color (hex format)
     */
    background?: string;
    /**
     * Text color (hex format)
     */
    text?: string;
  };
  /**
   * Brand typography guidelines
   */
  fonts?: {
    /**
     * Primary font family name
     */
    primary?: string;
    /**
     * Secondary font family name
     */
    secondary?: string;
    /**
     * URLs to web font files if using custom fonts
     */
    font_urls?: string[];
  };
  /**
   * Brand voice and messaging tone (e.g., 'professional', 'casual', 'humorous', 'trustworthy', 'innovative')
   */
  tone?: string;
  /**
   * Brand tagline or slogan
   */
  tagline?: string;
  /**
   * Brand asset library with explicit assets and tags. Assets are referenced inline with URLs pointing to CDN-hosted files.
   */
  assets?: {
    /**
     * Unique identifier for this asset
     */
    asset_id: string;
    /**
     * Type of asset
     */
    asset_type: 'image' | 'video' | 'audio' | 'text';
    /**
     * URL to CDN-hosted asset file
     */
    url: string;
    /**
     * Tags for asset discovery (e.g., 'holiday', 'lifestyle', 'product_shot')
     */
    tags?: string[];
    /**
     * Human-readable asset name
     */
    name?: string;
    /**
     * Asset description or usage notes
     */
    description?: string;
    /**
     * Image/video width in pixels
     */
    width?: number;
    /**
     * Image/video height in pixels
     */
    height?: number;
    /**
     * Video/audio duration in seconds
     */
    duration_seconds?: number;
    /**
     * File size in bytes
     */
    file_size_bytes?: number;
    /**
     * File format (e.g., 'jpg', 'mp4', 'mp3')
     */
    format?: string;
    /**
     * Additional asset-specific metadata
     */
    metadata?: {
      [k: string]: unknown;
    };
  }[];
  /**
   * Product catalog information for e-commerce advertisers. Enables SKU-level creative generation and product selection.
   */
  product_catalog?: {
    /**
     * URL to product catalog feed
     */
    feed_url: string;
    /**
     * Format of the product feed
     */
    feed_format?: 'google_merchant_center' | 'facebook_catalog' | 'custom';
    /**
     * Product categories available in the catalog (for filtering)
     */
    categories?: string[];
    /**
     * When the product catalog was last updated
     */
    last_updated?: string;
    /**
     * How frequently the product catalog is updated
     */
    update_frequency?: 'realtime' | 'hourly' | 'daily' | 'weekly';
  };
  /**
   * Legal disclaimers or required text that must appear in creatives
   */
  disclaimers?: {
    /**
     * Disclaimer text
     */
    text: string;
    /**
     * When this disclaimer applies (e.g., 'financial_products', 'health_claims', 'all')
     */
    context?: string;
    /**
     * Whether this disclaimer must appear
     */
    required?: boolean;
  }[];
  /**
   * Industry or vertical (e.g., 'retail', 'automotive', 'finance', 'healthcare')
   */
  industry?: string;
  /**
   * Primary target audience description
   */
  target_audience?: string;
  /**
   * Brand contact information
   */
  contact?: {
    /**
     * Contact email
     */
    email?: string;
    /**
     * Contact phone number
     */
    phone?: string;
  };
  /**
   * Additional brand metadata
   */
  metadata?: {
    /**
     * When this brand manifest was created
     */
    created_date?: string;
    /**
     * When this brand manifest was last updated
     */
    updated_date?: string;
    /**
     * Brand card version number
     */
    version?: string;
  };
}
/**
 * Selectors to choose which products/offerings from the brand manifest product catalog to promote
 */
export interface PromotedProducts {
  /**
   * Direct product SKU references from the brand manifest product catalog
   */
  manifest_skus?: string[];
  /**
   * Select products by tags from the brand manifest product catalog (e.g., 'organic', 'sauces', 'holiday')
   */
  manifest_tags?: string[];
  /**
   * Select products from a specific category in the brand manifest product catalog (e.g., 'beverages/soft-drinks', 'food/sauces')
   */
  manifest_category?: string;
  /**
   * Natural language query to select products from the brand manifest (e.g., 'all Kraft Heinz pasta sauces', 'organic products under $20')
   */
  manifest_query?: string;
}
/**
 * URL reference asset
 */
export interface URLAsset {
  /**
   * URL reference
   */
  url: string;
  /**
   * Type of URL asset: 'clickthrough' for user click destination (landing page), 'tracker_pixel' for impression/event tracking via HTTP request (fires GET, expects pixel/204 response), 'tracker_script' for measurement SDKs that must load as <script> tag (OMID verification, native event trackers using method:2)
   */
  url_type?: 'clickthrough' | 'tracker_pixel' | 'tracker_script';
  /**
   * Description of what this URL points to
   */
  description?: string;
}

// PRODUCT SCHEMA
/**
 * Type of inventory delivery
 */
export type DeliveryType = 'guaranteed' | 'non_guaranteed';
/**
 * A pricing model option offered by a publisher for a product. Each pricing model has its own schema with model-specific requirements.
 */
export type PricingOption =
  | CPMFixedRatePricingOption
  | CPMAuctionPricingOption
  | VCPMFixedRatePricingOption
  | VCPMAuctionPricingOption
  | CPCPricingOption
  | CPCVPricingOption
  | CPVPricingOption
  | CPPPricingOption
  | FlatRatePricingOption;

/**
 * Represents available advertising inventory
 */
export interface Product {
  /**
   * Unique identifier for the product
   */
  product_id: string;
  /**
   * Human-readable product name
   */
  name: string;
  /**
   * Detailed description of the product and its inventory
   */
  description: string;
  /**
   * Publisher properties covered by this product. Buyers fetch actual property definitions from each publisher's adagents.json and validate agent authorization.
   *
   * @minItems 1
   */
  publisher_properties: [
    {
      /**
       * Domain where publisher's adagents.json is hosted (e.g., 'cnn.com')
       */
      publisher_domain: string;
      /**
       * Specific property IDs from the publisher's adagents.json. Mutually exclusive with property_tags.
       *
       * @minItems 1
       */
      property_ids?: [string, ...string[]];
      /**
       * Property tags from the publisher's adagents.json. Product covers all properties with these tags. Mutually exclusive with property_ids.
       *
       * @minItems 1
       */
      property_tags?: [string, ...string[]];
    },
    ...{
      /**
       * Domain where publisher's adagents.json is hosted (e.g., 'cnn.com')
       */
      publisher_domain: string;
      /**
       * Specific property IDs from the publisher's adagents.json. Mutually exclusive with property_tags.
       *
       * @minItems 1
       */
      property_ids?: [string, ...string[]];
      /**
       * Property tags from the publisher's adagents.json. Product covers all properties with these tags. Mutually exclusive with property_ids.
       *
       * @minItems 1
       */
      property_tags?: [string, ...string[]];
    }[]
  ];
  /**
   * Array of supported creative format IDs - structured format_id objects with agent_url and id
   */
  format_ids: FormatID[];
  /**
   * Optional array of specific placements within this product. When provided, buyers can target specific placements when assigning creatives.
   *
   * @minItems 1
   */
  placements?: [Placement, ...Placement[]];
  delivery_type: DeliveryType;
  /**
   * Available pricing models for this product
   *
   * @minItems 1
   */
  pricing_options: [PricingOption, ...PricingOption[]];
  /**
   * Estimated exposures/impressions for guaranteed products
   */
  estimated_exposures?: number;
  measurement?: Measurement;
  /**
   * Measurement provider and methodology for delivery metrics. The buyer accepts the declared provider as the source of truth for the buy. REQUIRED for all products.
   */
  delivery_measurement: {
    /**
     * Measurement provider(s) used for this product (e.g., 'Google Ad Manager with IAS viewability', 'Nielsen DAR', 'Geopath for DOOH impressions')
     */
    provider: string;
    /**
     * Additional details about measurement methodology in plain language (e.g., 'MRC-accredited viewability. 50% in-view for 1s display / 2s video', 'Panel-based demographic measurement updated monthly')
     */
    notes?: string;
  };
  reporting_capabilities?: ReportingCapabilities;
  creative_policy?: CreativePolicy;
  /**
   * Whether this is a custom product
   */
  is_custom?: boolean;
  /**
   * Explanation of why this product matches the brief (only included when brief is provided)
   */
  brief_relevance?: string;
  /**
   * Expiration timestamp for custom products
   */
  expires_at?: string;
}
/**
 * Structured format identifier with agent URL and format name
 */
export interface FormatID {
  /**
   * URL of the agent that defines this format (e.g., 'https://creatives.adcontextprotocol.org' for standard formats, or 'https://publisher.com/.well-known/adcp/sales' for custom formats)
   */
  agent_url: string;
  /**
   * Format identifier within the agent's namespace (e.g., 'display_300x250', 'video_standard_30s')
   */
  id: string;
}
/**
 * Represents a specific ad placement within a product's inventory
 */
export interface Placement {
  /**
   * Unique identifier for the placement within the product
   */
  placement_id: string;
  /**
   * Human-readable name for the placement (e.g., 'Homepage Banner', 'Article Sidebar')
   */
  name: string;
  /**
   * Detailed description of where and how the placement appears
   */
  description?: string;
  /**
   * Format IDs supported by this specific placement (subset of product's formats)
   *
   * @minItems 1
   */
  format_ids?: [FormatID, ...FormatID[]];
}
/**
 * Cost Per Mille (cost per 1,000 impressions) with guaranteed fixed rate - common for direct/guaranteed deals
 */
export interface CPMFixedRatePricingOption {
  /**
   * Unique identifier for this pricing option within the product (e.g., 'cpm_usd_guaranteed')
   */
  pricing_option_id: string;
  /**
   * Cost per 1,000 impressions
   */
  pricing_model: 'cpm';
  /**
   * Fixed CPM rate (cost per 1,000 impressions)
   */
  rate: number;
  /**
   * ISO 4217 currency code
   */
  currency: string;
  /**
   * Minimum spend requirement per package using this pricing option, in the specified currency
   */
  min_spend_per_package?: number;
}
/**
 * Cost Per Mille (cost per 1,000 impressions) with auction-based pricing - common for programmatic/non-guaranteed inventory
 */
export interface CPMAuctionPricingOption {
  /**
   * Unique identifier for this pricing option within the product (e.g., 'cpm_usd_auction')
   */
  pricing_option_id: string;
  /**
   * Cost per 1,000 impressions
   */
  pricing_model: 'cpm';
  /**
   * ISO 4217 currency code
   */
  currency: string;
  /**
   * Pricing guidance for auction-based CPM bidding
   */
  price_guidance: {
    /**
     * Minimum bid price - publisher will reject bids under this value
     */
    floor: number;
    /**
     * 25th percentile winning price
     */
    p25?: number;
    /**
     * Median winning price
     */
    p50?: number;
    /**
     * 75th percentile winning price
     */
    p75?: number;
    /**
     * 90th percentile winning price
     */
    p90?: number;
  };
  /**
   * Minimum spend requirement per package using this pricing option, in the specified currency
   */
  min_spend_per_package?: number;
}
/**
 * Viewable Cost Per Mille (cost per 1,000 viewable impressions) with guaranteed fixed rate - impressions meeting MRC viewability standard (50% pixels in-view for 1 second for display, 2 seconds for video)
 */
export interface VCPMFixedRatePricingOption {
  /**
   * Unique identifier for this pricing option within the product (e.g., 'vcpm_usd_guaranteed')
   */
  pricing_option_id: string;
  /**
   * Cost per 1,000 viewable impressions (MRC standard)
   */
  pricing_model: 'vcpm';
  /**
   * Fixed vCPM rate (cost per 1,000 viewable impressions)
   */
  rate: number;
  /**
   * ISO 4217 currency code
   */
  currency: string;
  /**
   * Minimum spend requirement per package using this pricing option, in the specified currency
   */
  min_spend_per_package?: number;
}
/**
 * Viewable Cost Per Mille (cost per 1,000 viewable impressions) with auction-based pricing - impressions meeting MRC viewability standard (50% pixels in-view for 1 second for display, 2 seconds for video)
 */
export interface VCPMAuctionPricingOption {
  /**
   * Unique identifier for this pricing option within the product (e.g., 'vcpm_usd_auction')
   */
  pricing_option_id: string;
  /**
   * Cost per 1,000 viewable impressions (MRC standard)
   */
  pricing_model: 'vcpm';
  /**
   * ISO 4217 currency code
   */
  currency: string;
  /**
   * Statistical guidance for auction pricing
   */
  price_guidance: {
    /**
     * Minimum acceptable bid price
     */
    floor: number;
    /**
     * 25th percentile of recent winning bids
     */
    p25?: number;
    /**
     * Median of recent winning bids
     */
    p50?: number;
    /**
     * 75th percentile of recent winning bids
     */
    p75?: number;
    /**
     * 90th percentile of recent winning bids
     */
    p90?: number;
  };
  /**
   * Minimum spend requirement per package using this pricing option, in the specified currency
   */
  min_spend_per_package?: number;
}
/**
 * Cost Per Click fixed-rate pricing for performance-driven advertising campaigns
 */
export interface CPCPricingOption {
  /**
   * Unique identifier for this pricing option within the product (e.g., 'cpc_usd_fixed')
   */
  pricing_option_id: string;
  /**
   * Cost per click
   */
  pricing_model: 'cpc';
  /**
   * Fixed CPC rate (cost per click)
   */
  rate: number;
  /**
   * ISO 4217 currency code
   */
  currency: string;
  /**
   * Minimum spend requirement per package using this pricing option, in the specified currency
   */
  min_spend_per_package?: number;
}
/**
 * Cost Per Completed View (100% video/audio completion) fixed-rate pricing
 */
export interface CPCVPricingOption {
  /**
   * Unique identifier for this pricing option within the product (e.g., 'cpcv_usd_guaranteed')
   */
  pricing_option_id: string;
  /**
   * Cost per completed view (100% completion)
   */
  pricing_model: 'cpcv';
  /**
   * Fixed CPCV rate (cost per 100% completion)
   */
  rate: number;
  /**
   * ISO 4217 currency code
   */
  currency: string;
  /**
   * Minimum spend requirement per package using this pricing option, in the specified currency
   */
  min_spend_per_package?: number;
}
/**
 * Cost Per View (at publisher-defined threshold) fixed-rate pricing for video/audio
 */
export interface CPVPricingOption {
  /**
   * Unique identifier for this pricing option within the product (e.g., 'cpv_usd_50pct')
   */
  pricing_option_id: string;
  /**
   * Cost per view at threshold
   */
  pricing_model: 'cpv';
  /**
   * Fixed CPV rate (cost per view)
   */
  rate: number;
  /**
   * ISO 4217 currency code
   */
  currency: string;
  /**
   * CPV-specific parameters defining the view threshold
   */
  parameters: {
    view_threshold:
      | number
      | {
          /**
           * Seconds of viewing required (e.g., 30 for YouTube-style '30 seconds = view')
           */
          duration_seconds: number;
        };
  };
  /**
   * Minimum spend requirement per package using this pricing option, in the specified currency
   */
  min_spend_per_package?: number;
}
/**
 * Cost Per Point (Gross Rating Point) fixed-rate pricing for TV and audio campaigns requiring demographic measurement
 */
export interface CPPPricingOption {
  /**
   * Unique identifier for this pricing option within the product (e.g., 'cpp_usd_p18-49')
   */
  pricing_option_id: string;
  /**
   * Cost per Gross Rating Point
   */
  pricing_model: 'cpp';
  /**
   * Fixed CPP rate (cost per rating point)
   */
  rate: number;
  /**
   * ISO 4217 currency code
   */
  currency: string;
  /**
   * CPP-specific parameters for demographic targeting and GRP requirements
   */
  parameters: {
    /**
     * Target demographic in Nielsen format: P/M/W/A/C + age range. Examples: P18-49 (Persons 18-49), M25-54 (Men 25-54), W35+ (Women 35+), A18-34 (Adults 18-34), C2-11 (Children 2-11)
     */
    demographic: string;
    /**
     * Minimum GRPs/TRPs required for this pricing option
     */
    min_points?: number;
  };
  /**
   * Minimum spend requirement per package using this pricing option, in the specified currency
   */
  min_spend_per_package?: number;
}
/**
 * Flat rate pricing for DOOH, sponsorships, and time-based campaigns - fixed cost regardless of delivery volume
 */
export interface FlatRatePricingOption {
  /**
   * Unique identifier for this pricing option within the product (e.g., 'flat_rate_usd_24h_takeover')
   */
  pricing_option_id: string;
  /**
   * Fixed cost regardless of delivery volume
   */
  pricing_model: 'flat_rate';
  /**
   * Flat rate cost
   */
  rate: number;
  /**
   * ISO 4217 currency code
   */
  currency: string;
  /**
   * Whether this is a fixed rate (true) or auction-based (false)
   */
  is_fixed: true;
  /**
   * Flat rate parameters for DOOH and time-based campaigns
   */
  parameters?: {
    /**
     * Duration in hours for time-based flat rate pricing (DOOH)
     */
    duration_hours?: number;
    /**
     * Guaranteed share of voice as percentage (DOOH, 0-100)
     */
    sov_percentage?: number;
    /**
     * Duration of ad loop rotation in seconds (DOOH)
     */
    loop_duration_seconds?: number;
    /**
     * Minimum number of times ad plays per hour (DOOH frequency guarantee)
     */
    min_plays_per_hour?: number;
    /**
     * Named venue package identifier for DOOH (e.g., 'times_square_network', 'airport_terminals')
     */
    venue_package?: string;
    /**
     * Estimated impressions for this flat rate option (informational, commonly used with SOV or time-based DOOH)
     */
    estimated_impressions?: number;
    /**
     * Specific daypart for time-based pricing (e.g., 'morning_commute', 'evening_prime', 'overnight')
     */
    daypart?: string;
  };
  /**
   * Minimum spend requirement per package using this pricing option, in the specified currency
   */
  min_spend_per_package?: number;
}
/**
 * Measurement capabilities included with a product
 */
export interface Measurement {
  /**
   * Type of measurement
   */
  type: string;
  /**
   * Attribution methodology
   */
  attribution: string;
  /**
   * Attribution window
   */
  window?: string;
  /**
   * Reporting frequency and format
   */
  reporting: string;
}
/**
 * Reporting capabilities available for a product
 */
export interface ReportingCapabilities {
  /**
   * Supported reporting frequency options
   *
   * @minItems 1
   */
  available_reporting_frequencies: ['hourly' | 'daily' | 'monthly', ...('hourly' | 'daily' | 'monthly')[]];
  /**
   * Expected delay in minutes before reporting data becomes available (e.g., 240 for 4-hour delay)
   */
  expected_delay_minutes: number;
  /**
   * Timezone for reporting periods. Use 'UTC' or IANA timezone (e.g., 'America/New_York'). Critical for daily/monthly frequency alignment.
   */
  timezone: string;
  /**
   * Whether this product supports webhook-based reporting notifications
   */
  supports_webhooks: boolean;
  /**
   * Metrics available in reporting. Impressions and spend are always implicitly included.
   */
  available_metrics: (
    | 'impressions'
    | 'spend'
    | 'clicks'
    | 'ctr'
    | 'video_completions'
    | 'completion_rate'
    | 'conversions'
    | 'viewability'
    | 'engagement_rate'
  )[];
}
/**
 * Creative requirements and restrictions for a product
 */
export interface CreativePolicy {
  /**
   * Co-branding requirement
   */
  co_branding: 'required' | 'optional' | 'none';
  /**
   * Landing page requirements
   */
  landing_page: 'any' | 'retailer_site_only' | 'must_include_retailer';
  /**
   * Whether creative templates are provided
   */
  templates_available: boolean;
}

// TARGETING SCHEMA
/**
 * Optional geographic refinements for media buys. Most targeting should be expressed in the brief and handled by the publisher. These fields are primarily for geographic restrictions (RCT testing, regulatory compliance).
 */
export interface TargetingOverlay {
  /**
   * Restrict delivery to specific countries (ISO codes). Use for regulatory compliance or RCT testing.
   */
  geo_country_any_of?: string[];
  /**
   * Restrict delivery to specific regions/states. Use for regulatory compliance or RCT testing.
   */
  geo_region_any_of?: string[];
  /**
   * Restrict delivery to specific metro areas (DMA codes). Use for regulatory compliance or RCT testing.
   */
  geo_metro_any_of?: string[];
  /**
   * Restrict delivery to specific postal/ZIP codes. Use for regulatory compliance or RCT testing.
   */
  geo_postal_code_any_of?: string[];
  frequency_cap?: FrequencyCap;
}
/**
 * Frequency capping settings for package-level application
 */
export interface FrequencyCap {
  /**
   * Minutes to suppress after impression
   */
  suppress_minutes: number;
}

