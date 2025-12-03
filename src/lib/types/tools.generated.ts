// Tool Parameter and Response Types
// Generated from official AdCP schemas

// get_products parameters
/**
 * Brand information manifest providing brand context, assets, and product catalog. Can be provided inline or as a URL reference to a hosted manifest.
 */
export type BrandManifestReference = BrandManifest | string;
/**
 * Type of asset. Note: Brand manifests typically contain basic media assets (image, video, audio, text). Code assets (html, javascript, css) and ad markup (vast, daast) are usually not part of brand asset libraries.
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
 * Type of inventory delivery
 */
export type DeliveryType = 'guaranteed' | 'non_guaranteed';
/**
 * High-level categories for creative formats based on media type and delivery channel. Describes WHERE and HOW a creative displays, not what content it contains.
 */
export type FormatCategory = 'audio' | 'video' | 'display' | 'native' | 'dooh' | 'rich_media' | 'universal';
/**
 * Standard advertising channels supported by AdCP
 */
export type AdvertisingChannels =
  | 'display'
  | 'video'
  | 'audio'
  | 'native'
  | 'dooh'
  | 'ctv'
  | 'podcast'
  | 'retail'
  | 'social';

/**
 * Request parameters for discovering available advertising products
 */
export interface GetProductsRequest {
  /**
   * Natural language description of campaign requirements
   */
  brief?: string;
  brand_manifest?: BrandManifestReference;
  filters?: ProductFilters;
  context?: ContextObject;
  ext?: ExtensionObject;
}
/**
 * Inline brand manifest object
 */
export interface BrandManifest {
  /**
   * Primary brand URL for context and asset discovery. Creative agents can infer brand information from this URL.
   */
  url?: string;
  /**
   * Brand or business name
   */
  name: string;
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
    asset_type: AssetContentType;
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
 * Structured filters for product discovery
 */
export interface ProductFilters {
  delivery_type?: DeliveryType;
  /**
   * Filter for fixed price vs auction products
   */
  is_fixed_price?: boolean;
  /**
   * Filter by format types
   */
  format_types?: FormatCategory[];
  /**
   * Filter by specific format IDs
   */
  format_ids?: FormatID[];
  /**
   * Only return products accepting IAB standard formats
   */
  standard_formats_only?: boolean;
  /**
   * Minimum exposures/impressions needed for measurement validity
   */
  min_exposures?: number;
  /**
   * Campaign start date (ISO 8601 date format: YYYY-MM-DD) for availability checks
   */
  start_date?: string;
  /**
   * Campaign end date (ISO 8601 date format: YYYY-MM-DD) for availability checks
   */
  end_date?: string;
  /**
   * Budget range to filter appropriate products
   */
  budget_range?: {
    [k: string]: unknown;
  };
  /**
   * Filter by target countries using ISO 3166-1 alpha-2 country codes (e.g., ['US', 'CA', 'GB'])
   */
  countries?: string[];
  /**
   * Filter by advertising channels (e.g., ['display', 'video', 'dooh'])
   */
  channels?: AdvertisingChannels[];
}
/**
 * Structured format identifier with agent URL and format name. Can reference: (1) a concrete format with fixed dimensions (id only), (2) a template format without parameters (id only), or (3) a template format with parameters (id + dimensions/duration). Template formats accept parameters in format_id while concrete formats have fixed dimensions in their definition. Parameterized format IDs create unique, specific format variants.
 */
export interface FormatID {
  /**
   * URL of the agent that defines this format (e.g., 'https://creatives.adcontextprotocol.org' for standard formats, or 'https://publisher.com/.well-known/adcp/sales' for custom formats)
   */
  agent_url: string;
  /**
   * Format identifier within the agent's namespace (e.g., 'display_static', 'video_hosted', 'audio_standard'). When used alone, references a template format. When combined with dimension/duration fields, creates a parameterized format ID for a specific variant.
   */
  id: string;
  /**
   * Width in pixels for visual formats. When specified, height must also be specified. Both fields together create a parameterized format ID for dimension-specific variants.
   */
  width?: number;
  /**
   * Height in pixels for visual formats. When specified, width must also be specified. Both fields together create a parameterized format ID for dimension-specific variants.
   */
  height?: number;
  /**
   * Duration in milliseconds for time-based formats (video, audio). When specified, creates a parameterized format ID. Omit to reference a template format without parameters.
   */
  duration_ms?: number;
}
/**
 * Opaque correlation data that is echoed unchanged in responses. Used for internal tracking, UI session IDs, trace IDs, and other caller-specific identifiers that don't affect protocol behavior. Context data is never parsed by AdCP agents - it's simply preserved and returned.
 */
export interface ContextObject {
  [k: string]: unknown;
}
/**
 * Extension object for platform-specific, vendor-namespaced parameters. Extensions are always optional and must be namespaced under a vendor/platform key (e.g., ext.gam, ext.roku). Used for custom capabilities, partner-specific configuration, and features being proposed for standardization.
 */
export interface ExtensionObject {
  [k: string]: unknown;
}


// get_products response
/**
 * Selects properties from a publisher's adagents.json. Used for both product definitions and agent authorization. Supports three selection patterns: all properties, specific IDs, or by tags.
 */
export type PublisherPropertySelector =
  | {
      /**
       * Domain where publisher's adagents.json is hosted (e.g., 'cnn.com')
       */
      publisher_domain: string;
      /**
       * Discriminator indicating all properties from this publisher are included
       */
      selection_type: 'all';
    }
  | {
      /**
       * Domain where publisher's adagents.json is hosted (e.g., 'cnn.com')
       */
      publisher_domain: string;
      /**
       * Discriminator indicating selection by specific property IDs
       */
      selection_type: 'by_id';
      /**
       * Specific property IDs from the publisher's adagents.json
       *
       * @minItems 1
       */
      property_ids: [PropertyID, ...PropertyID[]];
    }
  | {
      /**
       * Domain where publisher's adagents.json is hosted (e.g., 'cnn.com')
       */
      publisher_domain: string;
      /**
       * Discriminator indicating selection by property tags
       */
      selection_type: 'by_tag';
      /**
       * Property tags from the publisher's adagents.json. Selector covers all properties with these tags
       *
       * @minItems 1
       */
      property_tags: [PropertyTag, ...PropertyTag[]];
    };
/**
 * Identifier for a publisher property. Must be lowercase alphanumeric with underscores only.
 */
export type PropertyID = string;
/**
 * Tag for categorizing publisher properties. Must be lowercase alphanumeric with underscores only.
 */
export type PropertyTag = string;
/**
 * Type of inventory delivery
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
 * Available frequencies for delivery reports and metrics updates
 */
export type ReportingFrequency = 'hourly' | 'daily' | 'monthly';
/**
 * Standard delivery and performance metrics available for reporting
 */
export type AvailableMetric =
  | 'impressions'
  | 'spend'
  | 'clicks'
  | 'ctr'
  | 'video_completions'
  | 'completion_rate'
  | 'conversions'
  | 'viewability'
  | 'engagement_rate';
/**
 * Co-branding requirement
 */
export type CoBrandingRequirement = 'required' | 'optional' | 'none';
/**
 * Landing page requirements
 */
export type LandingPageRequirement = 'any' | 'retailer_site_only' | 'must_include_retailer';

/**
 * Response payload for get_products task
 */
export interface GetProductsResponse {
  /**
   * Array of matching products
   */
  products: Product[];
  /**
   * Task-specific errors and warnings (e.g., product filtering issues)
   */
  errors?: Error[];
  context?: ContextObject;
  ext?: ExtensionObject;
}
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
   * Publisher properties covered by this product. Buyers fetch actual property definitions from each publisher's adagents.json and validate agent authorization. Selection patterns mirror the authorization patterns in adagents.json for consistency.
   *
   * @minItems 1
   */
  publisher_properties: [PublisherPropertySelector, ...PublisherPropertySelector[]];
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
  /**
   * Optional standard visual card (300x400px) for displaying this product in user interfaces. Can be rendered via preview_creative or pre-generated.
   */
  product_card?: {
    format_id: FormatID1;
    /**
     * Asset manifest for rendering the card, structure defined by the format
     */
    manifest: {
      [k: string]: unknown;
    };
  };
  /**
   * Optional detailed card with carousel and full specifications. Provides rich product presentation similar to media kit pages.
   */
  product_card_detailed?: {
    format_id: FormatID2;
    /**
     * Asset manifest for rendering the detailed card, structure defined by the format
     */
    manifest: {
      [k: string]: unknown;
    };
  };
  ext?: ExtensionObject;
}
/**
 * Structured format identifier with agent URL and format name. Can reference: (1) a concrete format with fixed dimensions (id only), (2) a template format without parameters (id only), or (3) a template format with parameters (id + dimensions/duration). Template formats accept parameters in format_id while concrete formats have fixed dimensions in their definition. Parameterized format IDs create unique, specific format variants.
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
   * Format IDs supported by this specific placement. Can include: (1) concrete format_ids (fixed dimensions), (2) template format_ids without parameters (accepts any dimensions/duration), or (3) parameterized format_ids (specific dimension/duration constraints).
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
   * Whether this is a fixed rate (true) or auction-based (false)
   */
  is_fixed: true;
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
   * Whether this is a fixed rate (true) or auction-based (false)
   */
  is_fixed: false;
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
   * Whether this is a fixed rate (true) or auction-based (false)
   */
  is_fixed: true;
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
   * Whether this is a fixed rate (true) or auction-based (false)
   */
  is_fixed: false;
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
   * Whether this is a fixed rate (true) or auction-based (false)
   */
  is_fixed: true;
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
   * Whether this is a fixed rate (true) or auction-based (false)
   */
  is_fixed: true;
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
   * Whether this is a fixed rate (true) or auction-based (false)
   */
  is_fixed: true;
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
   * Whether this is a fixed rate (true) or auction-based (false)
   */
  is_fixed: true;
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
  available_reporting_frequencies: [ReportingFrequency, ...ReportingFrequency[]];
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
  available_metrics: AvailableMetric[];
}
/**
 * Creative requirements and restrictions for a product
 */
export interface CreativePolicy {
  co_branding: CoBrandingRequirement;
  landing_page: LandingPageRequirement;
  /**
   * Whether creative templates are provided
   */
  templates_available: boolean;
}
/**
 * Structured format identifier with agent URL and format name. Can reference: (1) a concrete format with fixed dimensions (id only), (2) a template format without parameters (id only), or (3) a template format with parameters (id + dimensions/duration). Template formats accept parameters in format_id while concrete formats have fixed dimensions in their definition. Parameterized format IDs create unique, specific format variants.
 */
export interface FormatID1 {
  /**
   * URL of the agent that defines this format (e.g., 'https://creatives.adcontextprotocol.org' for standard formats, or 'https://publisher.com/.well-known/adcp/sales' for custom formats)
   */
  agent_url: string;
  /**
   * Format identifier within the agent's namespace (e.g., 'display_static', 'video_hosted', 'audio_standard'). When used alone, references a template format. When combined with dimension/duration fields, creates a parameterized format ID for a specific variant.
   */
  id: string;
  /**
   * Width in pixels for visual formats. When specified, height must also be specified. Both fields together create a parameterized format ID for dimension-specific variants.
   */
  width?: number;
  /**
   * Height in pixels for visual formats. When specified, width must also be specified. Both fields together create a parameterized format ID for dimension-specific variants.
   */
  height?: number;
  /**
   * Duration in milliseconds for time-based formats (video, audio). When specified, creates a parameterized format ID. Omit to reference a template format without parameters.
   */
  duration_ms?: number;
}
/**
 * Structured format identifier with agent URL and format name. Can reference: (1) a concrete format with fixed dimensions (id only), (2) a template format without parameters (id only), or (3) a template format with parameters (id + dimensions/duration). Template formats accept parameters in format_id while concrete formats have fixed dimensions in their definition. Parameterized format IDs create unique, specific format variants.
 */
export interface FormatID2 {
  /**
   * URL of the agent that defines this format (e.g., 'https://creatives.adcontextprotocol.org' for standard formats, or 'https://publisher.com/.well-known/adcp/sales' for custom formats)
   */
  agent_url: string;
  /**
   * Format identifier within the agent's namespace (e.g., 'display_static', 'video_hosted', 'audio_standard'). When used alone, references a template format. When combined with dimension/duration fields, creates a parameterized format ID for a specific variant.
   */
  id: string;
  /**
   * Width in pixels for visual formats. When specified, height must also be specified. Both fields together create a parameterized format ID for dimension-specific variants.
   */
  width?: number;
  /**
   * Height in pixels for visual formats. When specified, width must also be specified. Both fields together create a parameterized format ID for dimension-specific variants.
   */
  height?: number;
  /**
   * Duration in milliseconds for time-based formats (video, audio). When specified, creates a parameterized format ID. Omit to reference a template format without parameters.
   */
  duration_ms?: number;
}
/**
 * Extension object for platform-specific, vendor-namespaced parameters. Extensions are always optional and must be namespaced under a vendor/platform key (e.g., ext.gam, ext.roku). Used for custom capabilities, partner-specific configuration, and features being proposed for standardization.
 */
export interface Error {
  /**
   * Error code for programmatic handling
   */
  code: string;
  /**
   * Human-readable error message
   */
  message: string;
  /**
   * Field path associated with the error (e.g., 'packages[0].targeting')
   */
  field?: string;
  /**
   * Suggested fix for the error
   */
  suggestion?: string;
  /**
   * Seconds to wait before retrying the operation
   */
  retry_after?: number;
  /**
   * Additional task-specific error details
   */
  details?: {
    [k: string]: unknown;
  };
}
/**
 * Opaque correlation data that is echoed unchanged in responses. Used for internal tracking, UI session IDs, trace IDs, and other caller-specific identifiers that don't affect protocol behavior. Context data is never parsed by AdCP agents - it's simply preserved and returned.
 */

// list_creative_formats parameters
/**
 * Filter by format type (technical categories with distinct requirements)
 */
export interface ListCreativeFormatsRequest {
  /**
   * Return only these specific format IDs (e.g., from get_products response)
   */
  format_ids?: FormatID[];
  type?: FormatCategory;
  /**
   * Filter to formats that include these asset types. For third-party tags, search for 'html' or 'javascript'. E.g., ['image', 'text'] returns formats with images and text, ['javascript'] returns formats accepting JavaScript tags.
   */
  asset_types?: AssetContentType[];
  /**
   * Maximum width in pixels (inclusive). Returns formats where ANY render has width <= this value. For multi-render formats, matches if at least one render fits.
   */
  max_width?: number;
  /**
   * Maximum height in pixels (inclusive). Returns formats where ANY render has height <= this value. For multi-render formats, matches if at least one render fits.
   */
  max_height?: number;
  /**
   * Minimum width in pixels (inclusive). Returns formats where ANY render has width >= this value.
   */
  min_width?: number;
  /**
   * Minimum height in pixels (inclusive). Returns formats where ANY render has height >= this value.
   */
  min_height?: number;
  /**
   * Filter for responsive formats that adapt to container size. When true, returns formats without fixed dimensions.
   */
  is_responsive?: boolean;
  /**
   * Search for formats by name (case-insensitive partial match)
   */
  name_search?: string;
  context?: ContextObject;
  ext?: ExtensionObject;
}
/**
 * Structured format identifier with agent URL and format name. Can reference: (1) a concrete format with fixed dimensions (id only), (2) a template format without parameters (id only), or (3) a template format with parameters (id + dimensions/duration). Template formats accept parameters in format_id while concrete formats have fixed dimensions in their definition. Parameterized format IDs create unique, specific format variants.
 */

// list_creative_formats response
/**
 * Media type of this format - determines rendering method and asset requirements
 */
export type FormatIDParameter = 'dimensions' | 'duration';
/**
 * Type of asset
 */
export type AssetContentType1 =
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
 * Capabilities supported by creative agents for format handling
 */
export type CreativeAgentCapability = 'validation' | 'assembly' | 'generation' | 'preview';

/**
 * Response payload for list_creative_formats task
 */
export interface ListCreativeFormatsResponse {
  /**
   * Full format definitions for all formats this agent supports. Each format's authoritative source is indicated by its agent_url field.
   */
  formats: Format[];
  /**
   * Optional: Creative agents that provide additional formats. Buyers can recursively query these agents to discover more formats. No authentication required for list_creative_formats.
   */
  creative_agents?: {
    /**
     * Base URL for the creative agent (e.g., 'https://reference.adcp.org', 'https://dco.example.com'). Call list_creative_formats on this URL to get its formats.
     */
    agent_url: string;
    /**
     * Human-readable name for the creative agent
     */
    agent_name?: string;
    /**
     * Capabilities this creative agent provides
     */
    capabilities?: CreativeAgentCapability[];
  }[];
  /**
   * Task-specific errors and warnings (e.g., format availability issues)
   */
  errors?: Error[];
  context?: ContextObject;
  ext?: ExtensionObject;
}
/**
 * Represents a creative format with its requirements
 */
export interface Format {
  format_id: FormatID;
  /**
   * Human-readable format name
   */
  name: string;
  /**
   * Plain text explanation of what this format does and what assets it requires
   */
  description?: string;
  /**
   * DEPRECATED: Use format_card instead. Optional preview image URL for format browsing/discovery UI. Should be 400x300px (4:3 aspect ratio) PNG or JPG. Used as thumbnail/card image in format browsers. This field is maintained for backward compatibility but format_card provides a more flexible, structured approach.
   */
  preview_image?: string;
  /**
   * Optional URL to showcase page with examples and interactive demos of this format
   */
  example_url?: string;
  type: FormatCategory;
  /**
   * List of parameters this format accepts in format_id. Template formats define which parameters (dimensions, duration, etc.) can be specified when instantiating the format. Empty or omitted means this is a concrete format with fixed parameters.
   */
  accepts_parameters?: FormatIDParameter[];
  /**
   * Specification of rendered pieces for this format. Most formats produce a single render. Companion ad formats (video + banner), adaptive formats, and multi-placement formats produce multiple renders. Each render specifies its role and dimensions.
   *
   * @minItems 1
   */
  renders?: [
    (
      | {
          [k: string]: unknown;
        }
      | {
          parameters_from_format_id: true;
        }
    ),
    ...(
      | {
          [k: string]: unknown;
        }
      | {
          parameters_from_format_id: true;
        }
    )[]
  ];
  /**
   * Array of required assets or asset groups for this format. Each asset is identified by its asset_id, which must be used as the key in creative manifests. Can contain individual assets or repeatable asset sequences (e.g., carousel products, slideshow frames).
   */
  assets_required?: (
    | {
        /**
         * Discriminator indicating this is an individual asset requirement
         */
        item_type: 'individual';
        /**
         * Unique identifier for this asset. Creative manifests MUST use this exact value as the key in the assets object.
         */
        asset_id: string;
        asset_type: AssetContentType;
        /**
         * Optional descriptive label for this asset's purpose (e.g., 'hero_image', 'logo'). Not used for referencing assets in manifests—use asset_id instead. This field is for human-readable documentation and UI display only.
         */
        asset_role?: string;
        /**
         * Whether this asset is required
         */
        required?: boolean;
        /**
         * Technical requirements for this asset (dimensions, file size, duration, etc.). For template formats, use parameters_from_format_id: true to indicate asset parameters must match the format_id parameters (width/height/unit and/or duration_ms).
         */
        requirements?: {
          [k: string]: unknown;
        };
      }
    | {
        /**
         * Discriminator indicating this is a repeatable asset group
         */
        item_type: 'repeatable_group';
        /**
         * Identifier for this asset group (e.g., 'product', 'slide', 'card')
         */
        asset_group_id: string;
        /**
         * Minimum number of repetitions required
         */
        min_count: number;
        /**
         * Maximum number of repetitions allowed
         */
        max_count: number;
        /**
         * Assets within each repetition of this group
         */
        assets: {
          /**
           * Identifier for this asset within the group
           */
          asset_id: string;
          asset_type: AssetContentType1;
          /**
           * Optional descriptive label for this asset's purpose (e.g., 'hero_image', 'logo'). Not used for referencing assets in manifests—use asset_id instead. This field is for human-readable documentation and UI display only.
           */
          asset_role?: string;
          /**
           * Whether this asset is required in each repetition
           */
          required?: boolean;
          /**
           * Technical requirements for this asset. For template formats, use parameters_from_format_id: true to indicate asset parameters must match the format_id parameters (width/height/unit and/or duration_ms).
           */
          requirements?: {
            [k: string]: unknown;
          };
        }[];
      }
  )[];
  /**
   * Delivery method specifications (e.g., hosted, VAST, third-party tags)
   */
  delivery?: {
    [k: string]: unknown;
  };
  /**
   * List of universal macros supported by this format (e.g., MEDIA_BUY_ID, CACHEBUSTER, DEVICE_ID). Used for validation and developer tooling.
   */
  supported_macros?: string[];
  /**
   * For generative formats: array of format IDs that this format can generate. When a format accepts inputs like brand_manifest and message, this specifies what concrete output formats can be produced (e.g., a generative banner format might output standard image banner formats).
   */
  output_format_ids?: FormatID1[];
  /**
   * Optional standard visual card (300x400px) for displaying this format in user interfaces. Can be rendered via preview_creative or pre-generated.
   */
  format_card?: {
    format_id: FormatID2;
    /**
     * Asset manifest for rendering the card, structure defined by the format
     */
    manifest: {
      [k: string]: unknown;
    };
  };
  /**
   * Optional detailed card with carousel and full specifications. Provides rich format documentation similar to ad spec pages.
   */
  format_card_detailed?: {
    format_id: FormatID3;
    /**
     * Asset manifest for rendering the detailed card, structure defined by the format
     */
    manifest: {
      [k: string]: unknown;
    };
  };
}
/**
 * Structured format identifier with agent URL and format name
 */
export interface FormatID3 {
  /**
   * URL of the agent that defines this format (e.g., 'https://creatives.adcontextprotocol.org' for standard formats, or 'https://publisher.com/.well-known/adcp/sales' for custom formats)
   */
  agent_url: string;
  /**
   * Format identifier within the agent's namespace (e.g., 'display_static', 'video_hosted', 'audio_standard'). When used alone, references a template format. When combined with dimension/duration fields, creates a parameterized format ID for a specific variant.
   */
  id: string;
  /**
   * Width in pixels for visual formats. When specified, height must also be specified. Both fields together create a parameterized format ID for dimension-specific variants.
   */
  width?: number;
  /**
   * Height in pixels for visual formats. When specified, width must also be specified. Both fields together create a parameterized format ID for dimension-specific variants.
   */
  height?: number;
  /**
   * Duration in milliseconds for time-based formats (video, audio). When specified, creates a parameterized format ID. Omit to reference a template format without parameters.
   */
  duration_ms?: number;
}
/**
 * Standard error structure for task-specific errors and warnings
 */

// create_media_buy parameters
/**
 * Budget pacing strategy
 */
export type Pacing = 'even' | 'asap' | 'front_loaded';
/**
 * Image asset with URL and dimensions
 */
export type ImageAsset = Dimensions & {
  /**
   * URL to the image asset
   */
  url: string;
  /**
   * Image file format (jpg, png, gif, webp, etc.)
   */
  format?: string;
  /**
   * Alternative text for accessibility
   */
  alt_text?: string;
};
/**
 * Video asset with URL and specifications
 */
export type VideoAsset = Dimensions & {
  /**
   * URL to the video asset
   */
  url: string;
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
};
/**
 * JavaScript module type
 */
export type JavaScriptModuleType = 'esm' | 'commonjs' | 'script';
/**
 * VAST (Video Ad Serving Template) tag for third-party video ad serving
 */
export type VASTAsset =
  | {
      /**
       * Discriminator indicating VAST is delivered via URL endpoint
       */
      delivery_type: 'url';
      /**
       * URL endpoint that returns VAST XML
       */
      url: string;
      vast_version?: VASTVersion;
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
      tracking_events?: VASTTrackingEvent[];
    }
  | {
      /**
       * Discriminator indicating VAST is delivered as inline XML content
       */
      delivery_type: 'inline';
      /**
       * Inline VAST XML content
       */
      content: string;
      vast_version?: VASTVersion1;
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
      tracking_events?: VASTTrackingEvent[];
    };
/**
 * VAST specification version
 */
export type VASTVersion = '2.0' | '3.0' | '4.0' | '4.1' | '4.2';
/**
 * Standard VAST tracking events for video ad playback and interaction
 */
export type VASTTrackingEvent =
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
  | 'playerCollapse';
/**
 * VAST specification version
 */
export type VASTVersion1 = '2.0' | '3.0' | '4.0' | '4.1' | '4.2';
/**
 * DAAST (Digital Audio Ad Serving Template) tag for third-party audio ad serving
 */
export type DAASTAsset =
  | {
      /**
       * Discriminator indicating DAAST is delivered via URL endpoint
       */
      delivery_type: 'url';
      /**
       * URL endpoint that returns DAAST XML
       */
      url: string;
      daast_version?: DAASTVersion;
      /**
       * Expected audio duration in milliseconds (if known)
       */
      duration_ms?: number;
      /**
       * Tracking events supported by this DAAST tag
       */
      tracking_events?: DAASTTrackingEvent[];
      /**
       * Whether companion display ads are included
       */
      companion_ads?: boolean;
    }
  | {
      /**
       * Discriminator indicating DAAST is delivered as inline XML content
       */
      delivery_type: 'inline';
      /**
       * Inline DAAST XML content
       */
      content: string;
      daast_version?: DAASTVersion1;
      /**
       * Expected audio duration in milliseconds (if known)
       */
      duration_ms?: number;
      /**
       * Tracking events supported by this DAAST tag
       */
      tracking_events?: DAASTTrackingEvent[];
      /**
       * Whether companion display ads are included
       */
      companion_ads?: boolean;
    };
/**
 * DAAST specification version
 */
export type DAASTVersion = '1.0' | '1.1';
/**
 * Standard DAAST tracking events for audio ad playback and interaction
 */
export type DAASTTrackingEvent =
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
  | 'unmute';
/**
 * DAAST specification version
 */
export type DAASTVersion1 = '1.0' | '1.1';
/**
 * Brand information manifest containing assets, themes, and guidelines. Can be provided inline or as a URL reference to a hosted manifest.
 */
export type URLAssetType = 'clickthrough' | 'tracker_pixel' | 'tracker_script';
/**
 * Brand information manifest serving as the namespace and identity for this media buy. Provides brand context, assets, and product catalog. Can be provided inline or as a URL reference to a hosted manifest. Can be cached and reused across multiple requests.
 */
export type BrandManifestReference1 = BrandManifest | string;
/**
 * Campaign start timing: 'asap' or ISO 8601 date-time
 */
export type StartTiming = 'asap' | string;
/**
 * Authentication schemes for push notification endpoints
 */
export type AuthenticationScheme = 'Bearer' | 'HMAC-SHA256';

/**
 * Request parameters for creating a media buy
 */
export interface CreateMediaBuyRequest {
  /**
   * Buyer's reference identifier for this media buy
   */
  buyer_ref: string;
  /**
   * Array of package configurations
   */
  packages: PackageRequest[];
  brand_manifest: BrandManifestReference1;
  /**
   * Purchase order number for tracking
   */
  po_number?: string;
  start_time: StartTiming;
  /**
   * Campaign end date/time in ISO 8601 format
   */
  end_time: string;
  reporting_webhook?: PushNotificationConfig & {
    /**
     * Frequency for automated reporting delivery. Must be supported by all products in the media buy.
     */
    reporting_frequency: 'hourly' | 'daily' | 'monthly';
    /**
     * Optional list of metrics to include in webhook notifications. If omitted, all available metrics are included. Must be subset of product's available_metrics.
     */
    requested_metrics?: (
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
  };
  context?: ContextObject;
  ext?: ExtensionObject;
}
/**
 * Package configuration for media buy creation
 */
export interface PackageRequest {
  /**
   * Buyer's reference identifier for this package
   */
  buyer_ref: string;
  /**
   * Product ID for this package
   */
  product_id: string;
  /**
   * Array of format IDs that will be used for this package - must be supported by the product. If omitted, defaults to all formats supported by the product.
   *
   * @minItems 1
   */
  format_ids?: [FormatID, ...FormatID[]];
  /**
   * Budget allocation for this package in the media buy's currency
   */
  budget: number;
  pacing?: Pacing;
  /**
   * ID of the selected pricing option from the product's pricing_options array
   */
  pricing_option_id: string;
  /**
   * Bid price for auction-based CPM pricing (required if using cpm-auction-option)
   */
  bid_price?: number;
  targeting_overlay?: TargetingOverlay;
  /**
   * Creative IDs to assign to this package at creation time (references existing library creatives)
   */
  creative_ids?: string[];
  /**
   * Full creative objects to upload and assign to this package at creation time (alternative to creative_ids - creatives will be added to library). Supports both static and generative creatives.
   *
   * @maxItems 100
   */
  creatives?: CreativeAsset[];
  ext?: ExtensionObject;
}
/**
 * Structured format identifier with agent URL and format name. Can reference: (1) a concrete format with fixed dimensions (id only), (2) a template format without parameters (id only), or (3) a template format with parameters (id + dimensions/duration). Template formats accept parameters in format_id while concrete formats have fixed dimensions in their definition. Parameterized format IDs create unique, specific format variants.
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
  /**
   * AXE segment ID to include for targeting
   */
  axe_include_segment?: string;
  /**
   * AXE segment ID to exclude from targeting
   */
  axe_exclude_segment?: string;
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
  format_id: FormatID1;
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
  /**
   * Optional delivery weight for creative rotation when uploading via create_media_buy or update_media_buy (0-100). If omitted, platform determines rotation. Only used during upload to media buy - not stored in creative library.
   */
  weight?: number;
  /**
   * Optional array of placement IDs where this creative should run when uploading via create_media_buy or update_media_buy. References placement_id values from the product's placements array. If omitted, creative runs on all placements. Only used during upload to media buy - not stored in creative library.
   *
   * @minItems 1
   */
  placement_ids?: [string, ...string[]];
}
/**
 * Structured format identifier with agent URL and format name. Can reference: (1) a concrete format with fixed dimensions (id only), (2) a template format without parameters (id only), or (3) a template format with parameters (id + dimensions/duration). Template formats accept parameters in format_id while concrete formats have fixed dimensions in their definition. Parameterized format IDs create unique, specific format variants.
 */
export interface Dimensions {
  /**
   * Width in pixels
   */
  width: number;
  /**
   * Height in pixels
   */
  height: number;
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
  module_type?: JavaScriptModuleType;
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
/**
 * Inline brand manifest object
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
  url_type?: URLAssetType;
  /**
   * Description of what this URL points to
   */
  description?: string;
}
/**
 * Extension object for platform-specific, vendor-namespaced parameters. Extensions are always optional and must be namespaced under a vendor/platform key (e.g., ext.gam, ext.roku). Used for custom capabilities, partner-specific configuration, and features being proposed for standardization.
 */
export interface PushNotificationConfig {
  /**
   * Webhook endpoint URL for task status notifications
   */
  url: string;
  /**
   * Optional client-provided token for webhook validation. Echoed back in webhook payload to validate request authenticity.
   */
  token?: string;
  /**
   * Authentication configuration for webhook delivery (A2A-compatible)
   */
  authentication: {
    /**
     * Array of authentication schemes. Supported: ['Bearer'] for simple token auth, ['HMAC-SHA256'] for signature verification (recommended for production)
     *
     * @minItems 1
     * @maxItems 1
     */
    schemes: [AuthenticationScheme];
    /**
     * Credentials for authentication. For Bearer: token sent in Authorization header. For HMAC-SHA256: shared secret used to generate signature. Minimum 32 characters. Exchanged out-of-band during onboarding.
     */
    credentials: string;
  };
}
/**
 * Opaque correlation data that is echoed unchanged in responses. Used for internal tracking, UI session IDs, trace IDs, and other caller-specific identifiers that don't affect protocol behavior. Context data is never parsed by AdCP agents - it's simply preserved and returned.
 */

// create_media_buy response
/**
 * Response payload for create_media_buy task. Returns either complete success data OR error information, never both. This enforces atomic operation semantics - the media buy is either fully created or not created at all.
 */
export type CreateMediaBuyResponse =
  | {
      /**
       * Publisher's unique identifier for the created media buy
       */
      media_buy_id: string;
      /**
       * Buyer's reference identifier for this media buy
       */
      buyer_ref: string;
      /**
       * ISO 8601 timestamp for creative upload deadline
       */
      creative_deadline?: string;
      /**
       * Array of created packages with complete state information
       */
      packages: Package[];
      context?: ContextObject;
      ext?: ExtensionObject;
    }
  | {
      /**
       * Array of errors explaining why the operation failed
       *
       * @minItems 1
       */
      errors: [Error, ...Error[]];
      context?: ContextObject;
      ext?: ExtensionObject;
    };
/**
 * Budget pacing strategy
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
  /**
   * Whether this package is paused by the buyer. Paused packages do not deliver impressions. Defaults to false.
   */
  paused?: boolean;
  ext?: ExtensionObject;
}
/**
 * Optional geographic refinements for media buys. Most targeting should be expressed in the brief and handled by the publisher. These fields are primarily for geographic restrictions (RCT testing, regulatory compliance).
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
 * Structured format identifier with agent URL and format name. Can reference: (1) a concrete format with fixed dimensions (id only), (2) a template format without parameters (id only), or (3) a template format with parameters (id + dimensions/duration). Template formats accept parameters in format_id while concrete formats have fixed dimensions in their definition. Parameterized format IDs create unique, specific format variants.
 */

// sync_creatives parameters
/**
 * Image asset with URL and dimensions
 */
export type ValidationMode = 'strict' | 'lenient';
/**
 * Authentication schemes for push notification endpoints
 */
export interface SyncCreativesRequest {
  /**
   * Array of creative assets to sync (create or update)
   *
   * @maxItems 100
   */
  creatives: CreativeAsset[];
  /**
   * Optional filter to limit sync scope to specific creative IDs. When provided, only these creatives will be created/updated. Other creatives in the library are unaffected. Useful for partial updates and error recovery.
   *
   * @maxItems 100
   */
  creative_ids?: string[];
  /**
   * Optional bulk assignment of creatives to packages
   */
  assignments?: {
    /**
     * Array of package IDs to assign this creative to
     *
     * This interface was referenced by `undefined`'s JSON-Schema definition
     * via the `patternProperty` "^[a-zA-Z0-9_-]+$".
     */
    [k: string]: string[];
  };
  /**
   * When true, creatives not included in this sync will be archived. Use with caution for full library replacement.
   */
  delete_missing?: boolean;
  /**
   * When true, preview changes without applying them. Returns what would be created/updated/deleted.
   */
  dry_run?: boolean;
  validation_mode?: ValidationMode;
  push_notification_config?: PushNotificationConfig;
  context?: ContextObject;
  ext?: ExtensionObject;
}
/**
 * Creative asset for upload to library - supports static assets, generative formats, and third-party snippets
 */

// sync_creatives response
/**
 * Response from creative sync operation. Returns either per-creative results (best-effort processing) OR operation-level errors (complete failure). This enforces atomic semantics at the operation level while allowing per-item failures within successful operations.
 */
export type SyncCreativesResponse =
  | {
      /**
       * Whether this was a dry run (no actual changes made)
       */
      dry_run?: boolean;
      /**
       * Results for each creative processed. Items with action='failed' indicate per-item validation/processing failures, not operation-level failures.
       */
      creatives: {
        /**
         * Creative ID from the request
         */
        creative_id: string;
        action: CreativeAction;
        /**
         * Platform-specific ID assigned to the creative
         */
        platform_id?: string;
        /**
         * Field names that were modified (only present when action='updated')
         */
        changes?: string[];
        /**
         * Validation or processing errors (only present when action='failed')
         */
        errors?: string[];
        /**
         * Non-fatal warnings about this creative
         */
        warnings?: string[];
        /**
         * Preview URL for generative creatives (only present for generative formats)
         */
        preview_url?: string;
        /**
         * ISO 8601 timestamp when preview link expires (only present when preview_url exists)
         */
        expires_at?: string;
        /**
         * Package IDs this creative was successfully assigned to (only present when assignments were requested)
         */
        assigned_to?: string[];
        /**
         * Assignment errors by package ID (only present when assignment failures occurred)
         */
        assignment_errors?: {
          /**
           * Error message for this package assignment
           *
           * This interface was referenced by `undefined`'s JSON-Schema definition
           * via the `patternProperty` "^[a-zA-Z0-9_-]+$".
           */
          [k: string]: string;
        };
      }[];
      context?: ContextObject;
      ext?: ExtensionObject;
    }
  | {
      /**
       * Operation-level errors that prevented processing any creatives (e.g., authentication failure, service unavailable, invalid request format)
       *
       * @minItems 1
       */
      errors: [Error, ...Error[]];
      context?: ContextObject;
      ext?: ExtensionObject;
    };
/**
 * Action taken for this creative
 */
export type CreativeAction = 'created' | 'updated' | 'unchanged' | 'failed' | 'deleted';

/**
 * Opaque correlation data that is echoed unchanged in responses. Used for internal tracking, UI session IDs, trace IDs, and other caller-specific identifiers that don't affect protocol behavior. Context data is never parsed by AdCP agents - it's simply preserved and returned.
 */

// list_creatives parameters
/**
 * Filter by creative approval status
 */
export type CreativeStatus = 'processing' | 'approved' | 'rejected' | 'pending_review';
/**
 * Status of a creative asset
 */
export type CreativeStatus1 = 'processing' | 'approved' | 'rejected' | 'pending_review';
/**
 * Field to sort by
 */
export type CreativeSortField =
  | 'created_date'
  | 'updated_date'
  | 'name'
  | 'status'
  | 'assignment_count'
  | 'performance_score';
/**
 * Sort direction
 */
export type SortDirection = 'asc' | 'desc';

/**
 * Request parameters for querying creative assets from the centralized library with filtering, sorting, and pagination
 */
export interface ListCreativesRequest {
  filters?: CreativeFilters;
  /**
   * Sorting parameters
   */
  sort?: {
    field?: CreativeSortField;
    direction?: SortDirection;
  };
  /**
   * Pagination parameters
   */
  pagination?: {
    /**
     * Maximum number of creatives to return
     */
    limit?: number;
    /**
     * Number of creatives to skip
     */
    offset?: number;
  };
  /**
   * Include package assignment information in response
   */
  include_assignments?: boolean;
  /**
   * Include aggregated performance metrics in response
   */
  include_performance?: boolean;
  /**
   * Include sub-assets (for carousel/native formats) in response
   */
  include_sub_assets?: boolean;
  /**
   * Specific fields to include in response (omit for all fields)
   */
  fields?: (
    | 'creative_id'
    | 'name'
    | 'format'
    | 'status'
    | 'created_date'
    | 'updated_date'
    | 'tags'
    | 'assignments'
    | 'performance'
    | 'sub_assets'
  )[];
  context?: ContextObject;
  ext?: ExtensionObject;
}
/**
 * Filter criteria for querying creative assets from the centralized library
 */
export interface CreativeFilters {
  /**
   * Filter by creative format type (e.g., video, audio, display)
   */
  format?: string;
  /**
   * Filter by multiple creative format types
   */
  formats?: string[];
  status?: CreativeStatus;
  /**
   * Filter by multiple creative statuses
   */
  statuses?: CreativeStatus1[];
  /**
   * Filter by creative tags (all tags must match)
   */
  tags?: string[];
  /**
   * Filter by creative tags (any tag must match)
   */
  tags_any?: string[];
  /**
   * Filter by creative names containing this text (case-insensitive)
   */
  name_contains?: string;
  /**
   * Filter by specific creative IDs
   *
   * @maxItems 100
   */
  creative_ids?: string[];
  /**
   * Filter creatives created after this date (ISO 8601)
   */
  created_after?: string;
  /**
   * Filter creatives created before this date (ISO 8601)
   */
  created_before?: string;
  /**
   * Filter creatives last updated after this date (ISO 8601)
   */
  updated_after?: string;
  /**
   * Filter creatives last updated before this date (ISO 8601)
   */
  updated_before?: string;
  /**
   * Filter creatives assigned to this specific package
   */
  assigned_to_package?: string;
  /**
   * Filter creatives assigned to any of these packages
   */
  assigned_to_packages?: string[];
  /**
   * Filter creatives assigned to any of these media buys
   */
  media_buy_ids?: string[];
  /**
   * Filter creatives assigned to media buys with any of these buyer references
   */
  buyer_refs?: string[];
  /**
   * Filter for unassigned creatives when true, assigned creatives when false
   */
  unassigned?: boolean;
  /**
   * Filter creatives that have performance data when true
   */
  has_performance_data?: boolean;
}
/**
 * Opaque correlation data that is echoed unchanged in responses. Used for internal tracking, UI session IDs, trace IDs, and other caller-specific identifiers that don't affect protocol behavior. Context data is never parsed by AdCP agents - it's simply preserved and returned.
 */

// list_creatives response
/**
 * Sort direction for list queries
 */
export type SubAsset =
  | {
      /**
       * Discriminator indicating this is a media asset with content_uri
       */
      asset_kind: 'media';
      /**
       * Type of asset. Common types: thumbnail_image, product_image, featured_image, logo
       */
      asset_type: string;
      /**
       * Unique identifier for the asset within the creative
       */
      asset_id: string;
      /**
       * URL for media assets (images, videos, etc.)
       */
      content_uri: string;
    }
  | {
      /**
       * Discriminator indicating this is a text asset with content
       */
      asset_kind: 'text';
      /**
       * Type of asset. Common types: headline, body_text, cta_text, price_text, sponsor_name, author_name, click_url
       */
      asset_type: string;
      /**
       * Unique identifier for the asset within the creative
       */
      asset_id: string;
      /**
       * Text content for text-based assets like headlines, body text, CTA text, etc.
       */
      content: string | string[];
    };

/**
 * Response from creative library query with filtered results, metadata, and optional enriched data
 */
export interface ListCreativesResponse {
  /**
   * Summary of the query that was executed
   */
  query_summary: {
    /**
     * Total number of creatives matching filters (across all pages)
     */
    total_matching: number;
    /**
     * Number of creatives returned in this response
     */
    returned: number;
    /**
     * List of filters that were applied to the query
     */
    filters_applied?: string[];
    /**
     * Sort order that was applied
     */
    sort_applied?: {
      field?: string;
      direction?: SortDirection;
    };
  };
  /**
   * Pagination information for navigating results
   */
  pagination: {
    /**
     * Maximum number of results requested
     */
    limit: number;
    /**
     * Number of results skipped
     */
    offset: number;
    /**
     * Whether more results are available
     */
    has_more: boolean;
    /**
     * Total number of pages available
     */
    total_pages?: number;
    /**
     * Current page number (1-based)
     */
    current_page?: number;
  };
  /**
   * Array of creative assets matching the query
   */
  creatives: {
    /**
     * Unique identifier for the creative
     */
    creative_id: string;
    /**
     * Human-readable creative name
     */
    name: string;
    format_id: FormatID;
    status: CreativeStatus;
    /**
     * When the creative was uploaded to the library
     */
    created_date: string;
    /**
     * When the creative was last modified
     */
    updated_date: string;
    /**
     * Assets for this creative, keyed by asset_role
     */
    assets?: {
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
     * User-defined tags for organization and searchability
     */
    tags?: string[];
    /**
     * Current package assignments (included when include_assignments=true)
     */
    assignments?: {
      /**
       * Total number of active package assignments
       */
      assignment_count: number;
      /**
       * List of packages this creative is assigned to
       */
      assigned_packages?: {
        /**
         * Package identifier
         */
        package_id: string;
        /**
         * Human-readable package name
         */
        package_name?: string;
        /**
         * When this assignment was created
         */
        assigned_date: string;
        /**
         * Status of this specific assignment
         */
        status: 'active' | 'paused' | 'ended';
      }[];
    };
    /**
     * Aggregated performance metrics (included when include_performance=true)
     */
    performance?: {
      /**
       * Total impressions across all assignments
       */
      impressions?: number;
      /**
       * Total clicks across all assignments
       */
      clicks?: number;
      /**
       * Click-through rate (clicks/impressions)
       */
      ctr?: number;
      /**
       * Conversion rate across all assignments
       */
      conversion_rate?: number;
      /**
       * Aggregated performance score (0-100)
       */
      performance_score?: number;
      /**
       * When performance data was last updated
       */
      last_updated: string;
    };
    /**
     * Sub-assets for multi-asset formats (included when include_sub_assets=true)
     */
    sub_assets?: SubAsset[];
  }[];
  /**
   * Breakdown of creatives by format type
   */
  format_summary?: {
    /**
     * Number of creatives with this format
     *
     * This interface was referenced by `undefined`'s JSON-Schema definition
     * via the `patternProperty` "^[a-zA-Z0-9_-]+$".
     */
    [k: string]: number;
  };
  /**
   * Breakdown of creatives by status
   */
  status_summary?: {
    /**
     * Number of approved creatives
     */
    approved?: number;
    /**
     * Number of creatives pending review
     */
    pending_review?: number;
    /**
     * Number of rejected creatives
     */
    rejected?: number;
    /**
     * Number of archived creatives
     */
    archived?: number;
  };
  context?: ContextObject;
  ext?: ExtensionObject;
}
/**
 * Format identifier specifying which format this creative conforms to
 */

// update_media_buy parameters
/**
 * Request parameters for updating campaign and package settings
 */
export type UpdateMediaBuyRequest = UpdateMediaBuyRequest1;
/**
 * Campaign start timing: 'asap' or ISO 8601 date-time
 */

export interface UpdateMediaBuyRequest1 {
  /**
   * Publisher's ID of the media buy to update
   */
  media_buy_id?: string;
  /**
   * Buyer's reference for the media buy to update
   */
  buyer_ref?: string;
  /**
   * Pause/resume the entire media buy (true = paused, false = active)
   */
  paused?: boolean;
  start_time?: StartTiming;
  /**
   * New end date/time in ISO 8601 format
   */
  end_time?: string;
  /**
   * Package-specific updates
   */
  packages?: (
    | {
        [k: string]: unknown;
      }
    | {
        [k: string]: unknown;
      }
  )[];
  push_notification_config?: PushNotificationConfig;
  context?: ContextObject;
  ext?: ExtensionObject;
}
/**
 * Optional webhook configuration for async update notifications. Publisher will send webhook when update completes if operation takes longer than immediate response time.
 */

// update_media_buy response
/**
 * Response payload for update_media_buy task. Returns either complete success data OR error information, never both. This enforces atomic operation semantics - updates are either fully applied or not applied at all.
 */
export type UpdateMediaBuyResponse =
  | {
      /**
       * Publisher's identifier for the media buy
       */
      media_buy_id: string;
      /**
       * Buyer's reference identifier for the media buy
       */
      buyer_ref: string;
      /**
       * ISO 8601 timestamp when changes take effect (null if pending approval)
       */
      implementation_date?: string | null;
      /**
       * Array of packages that were modified with complete state information
       */
      affected_packages?: Package[];
      context?: ContextObject;
      ext?: ExtensionObject;
    }
  | {
      /**
       * Array of errors explaining why the operation failed
       *
       * @minItems 1
       */
      errors: [Error, ...Error[]];
      context?: ContextObject;
      ext?: ExtensionObject;
    };
/**
 * Budget pacing strategy
 */

// get_media_buy_delivery parameters
/**
 * Status of a media buy
 */
export type MediaBuyStatus = 'pending_activation' | 'active' | 'paused' | 'completed';

/**
 * Request parameters for retrieving comprehensive delivery metrics
 */
export interface GetMediaBuyDeliveryRequest {
  /**
   * Array of publisher media buy IDs to get delivery data for
   */
  media_buy_ids?: string[];
  /**
   * Array of buyer reference IDs to get delivery data for
   */
  buyer_refs?: string[];
  /**
   * Filter by status. Can be a single status or array of statuses
   */
  status_filter?: MediaBuyStatus | MediaBuyStatus[];
  /**
   * Start date for reporting period (YYYY-MM-DD)
   */
  start_date?: string;
  /**
   * End date for reporting period (YYYY-MM-DD)
   */
  end_date?: string;
  context?: ContextObject;
  ext?: ExtensionObject;
}
/**
 * Opaque correlation data that is echoed unchanged in responses. Used for internal tracking, UI session IDs, trace IDs, and other caller-specific identifiers that don't affect protocol behavior. Context data is never parsed by AdCP agents - it's simply preserved and returned.
 */

// get_media_buy_delivery response
/**
 * Pricing model used for this media buy
 */
export type PricingModel = 'cpm' | 'vcpm' | 'cpc' | 'cpcv' | 'cpv' | 'cpp' | 'flat_rate';
/**
 * The pricing model used for this package (e.g., cpm, cpcv, cpp). Indicates how the package is billed and which metrics are most relevant for optimization.
 */
export type PricingModel1 = 'cpm' | 'vcpm' | 'cpc' | 'cpcv' | 'cpv' | 'cpp' | 'flat_rate';

/**
 * Response payload for get_media_buy_delivery task
 */
export interface GetMediaBuyDeliveryResponse {
  /**
   * Type of webhook notification (only present in webhook deliveries): scheduled = regular periodic update, final = campaign completed, delayed = data not yet available, adjusted = resending period with updated data
   */
  notification_type?: 'scheduled' | 'final' | 'delayed' | 'adjusted';
  /**
   * Indicates if any media buys in this webhook have missing/delayed data (only present in webhook deliveries)
   */
  partial_data?: boolean;
  /**
   * Number of media buys with reporting_delayed or failed status (only present in webhook deliveries when partial_data is true)
   */
  unavailable_count?: number;
  /**
   * Sequential notification number (only present in webhook deliveries, starts at 1)
   */
  sequence_number?: number;
  /**
   * ISO 8601 timestamp for next expected notification (only present in webhook deliveries when notification_type is not 'final')
   */
  next_expected_at?: string;
  /**
   * Date range for the report. All periods use UTC timezone.
   */
  reporting_period: {
    /**
     * ISO 8601 start timestamp in UTC (e.g., 2024-02-05T00:00:00Z)
     */
    start: string;
    /**
     * ISO 8601 end timestamp in UTC (e.g., 2024-02-05T23:59:59Z)
     */
    end: string;
  };
  /**
   * ISO 4217 currency code
   */
  currency: string;
  /**
   * Combined metrics across all returned media buys. Only included in API responses (get_media_buy_delivery), not in webhook notifications.
   */
  aggregated_totals?: {
    /**
     * Total impressions delivered across all media buys
     */
    impressions: number;
    /**
     * Total amount spent across all media buys
     */
    spend: number;
    /**
     * Total clicks across all media buys (if applicable)
     */
    clicks?: number;
    /**
     * Total video completions across all media buys (if applicable)
     */
    video_completions?: number;
    /**
     * Number of media buys included in the response
     */
    media_buy_count: number;
  };
  /**
   * Array of delivery data for media buys. When used in webhook notifications, may contain multiple media buys aggregated by publisher. When used in get_media_buy_delivery API responses, typically contains requested media buys.
   */
  media_buy_deliveries: {
    /**
     * Publisher's media buy identifier
     */
    media_buy_id: string;
    /**
     * Buyer's reference identifier for this media buy
     */
    buyer_ref?: string;
    /**
     * Current media buy status. In webhook context, reporting_delayed indicates data temporarily unavailable.
     */
    status: 'pending' | 'active' | 'paused' | 'completed' | 'failed' | 'reporting_delayed';
    /**
     * When delayed data is expected to be available (only present when status is reporting_delayed)
     */
    expected_availability?: string;
    /**
     * Indicates this delivery contains updated data for a previously reported period. Buyer should replace previous period data with these totals.
     */
    is_adjusted?: boolean;
    pricing_model?: PricingModel;
    totals: DeliveryMetrics & {
      /**
       * Effective rate paid per unit based on pricing_model (e.g., actual CPM for 'cpm', actual cost per completed view for 'cpcv', actual cost per point for 'cpp')
       */
      effective_rate?: number;
    };
    /**
     * Metrics broken down by package
     */
    by_package: (DeliveryMetrics & {
      /**
       * Publisher's package identifier
       */
      package_id: string;
      /**
       * Buyer's reference identifier for this package
       */
      buyer_ref?: string;
      /**
       * Delivery pace (1.0 = on track, <1.0 = behind, >1.0 = ahead)
       */
      pacing_index?: number;
      pricing_model: PricingModel1;
      /**
       * The pricing rate for this package in the specified currency. For fixed-rate pricing, this is the agreed rate (e.g., CPM rate of 12.50 means $12.50 per 1,000 impressions). For auction-based pricing, this represents the effective rate based on actual delivery.
       */
      rate: number;
      /**
       * ISO 4217 currency code (e.g., USD, EUR, GBP) for this package's pricing. Indicates the currency in which the rate and spend values are denominated. Different packages can use different currencies when supported by the publisher.
       */
      currency: string;
      /**
       * System-reported operational state of this package. Reflects actual delivery state independent of buyer pause control.
       */
      delivery_status?: 'delivering' | 'completed' | 'budget_exhausted' | 'flight_ended' | 'goal_met';
      /**
       * Whether this package is currently paused by the buyer
       */
      paused?: boolean;
    })[];
    /**
     * Day-by-day delivery
     */
    daily_breakdown?: {
      /**
       * Date (YYYY-MM-DD)
       */
      date: string;
      /**
       * Daily impressions
       */
      impressions: number;
      /**
       * Daily spend
       */
      spend: number;
    }[];
  }[];
  /**
   * Task-specific errors and warnings (e.g., missing delivery data, reporting platform issues)
   */
  errors?: Error[];
  context?: ContextObject;
  ext?: ExtensionObject;
}
/**
 * Standard delivery metrics that can be reported at media buy, package, or creative level
 */
export interface DeliveryMetrics {
  /**
   * Impressions delivered
   */
  impressions?: number;
  /**
   * Amount spent
   */
  spend?: number;
  /**
   * Total clicks
   */
  clicks?: number;
  /**
   * Click-through rate (clicks/impressions)
   */
  ctr?: number;
  /**
   * Views at threshold (for CPV)
   */
  views?: number;
  /**
   * 100% completions (for CPCV)
   */
  completed_views?: number;
  /**
   * Completion rate (completed_views/impressions)
   */
  completion_rate?: number;
  /**
   * Conversions (reserved for future CPA pricing support)
   */
  conversions?: number;
  /**
   * Leads generated (reserved for future CPL pricing support)
   */
  leads?: number;
  /**
   * Gross Rating Points delivered (for CPP)
   */
  grps?: number;
  /**
   * Unique reach - units depend on measurement provider (e.g., individuals, households, devices, cookies). See delivery_measurement.provider for methodology.
   */
  reach?: number;
  /**
   * Average frequency per individual (typically measured over campaign duration, but can vary by measurement provider)
   */
  frequency?: number;
  /**
   * Video quartile completion data
   */
  quartile_data?: {
    /**
     * 25% completion views
     */
    q1_views?: number;
    /**
     * 50% completion views
     */
    q2_views?: number;
    /**
     * 75% completion views
     */
    q3_views?: number;
    /**
     * 100% completion views
     */
    q4_views?: number;
  };
  /**
   * DOOH-specific metrics (only included for DOOH campaigns)
   */
  dooh_metrics?: {
    /**
     * Number of times ad played in rotation
     */
    loop_plays?: number;
    /**
     * Number of unique screens displaying the ad
     */
    screens_used?: number;
    /**
     * Total display time in seconds
     */
    screen_time_seconds?: number;
    /**
     * Actual share of voice delivered (0.0 to 1.0)
     */
    sov_achieved?: number;
    /**
     * Explanation of how DOOH impressions were calculated
     */
    calculation_notes?: string;
    /**
     * Per-venue performance breakdown
     */
    venue_breakdown?: {
      /**
       * Venue identifier
       */
      venue_id: string;
      /**
       * Human-readable venue name
       */
      venue_name?: string;
      /**
       * Venue type (e.g., 'airport', 'transit', 'retail', 'billboard')
       */
      venue_type?: string;
      /**
       * Impressions delivered at this venue
       */
      impressions: number;
      /**
       * Loop plays at this venue
       */
      loop_plays?: number;
      /**
       * Number of screens used at this venue
       */
      screens_used?: number;
    }[];
  };
  [k: string]: unknown;
}
/**
 * Standard error structure for task-specific errors and warnings
 */

// list_authorized_properties parameters
/**
 * Request parameters for discovering which publishers this agent is authorized to represent
 */
export interface ListAuthorizedPropertiesRequest {
  /**
   * Filter to specific publisher domains (optional). If omitted, returns all publishers this agent represents.
   *
   * @minItems 1
   */
  publisher_domains?: [string, ...string[]];
  context?: ContextObject;
  ext?: ExtensionObject;
}
/**
 * Opaque correlation data that is echoed unchanged in responses. Used for internal tracking, UI session IDs, trace IDs, and other caller-specific identifiers that don't affect protocol behavior. Context data is never parsed by AdCP agents - it's simply preserved and returned.
 */

// list_authorized_properties response
/**
 * Standard advertising channels supported by AdCP
 */
export interface ListAuthorizedPropertiesResponse {
  /**
   * Publisher domains this agent is authorized to represent. Buyers should fetch each publisher's adagents.json to see property definitions and verify this agent is in their authorized_agents list with authorization scope.
   *
   * @minItems 1
   */
  publisher_domains: [string, ...string[]];
  /**
   * Primary advertising channels represented in this property portfolio. Helps buying agents quickly filter relevance.
   *
   * @minItems 1
   */
  primary_channels?: [AdvertisingChannels, ...AdvertisingChannels[]];
  /**
   * Primary countries (ISO 3166-1 alpha-2 codes) where properties are concentrated. Helps buying agents quickly filter relevance.
   *
   * @minItems 1
   */
  primary_countries?: [string, ...string[]];
  /**
   * Markdown-formatted description of the property portfolio, including inventory types, audience characteristics, and special features.
   */
  portfolio_description?: string;
  /**
   * Publisher's advertising content policies, restrictions, and guidelines in natural language. May include prohibited categories, blocked advertisers, restricted tactics, brand safety requirements, or links to full policy documentation.
   */
  advertising_policies?: string;
  /**
   * ISO 8601 timestamp of when the agent's publisher authorization list was last updated. Buyers can use this to determine if their cached publisher adagents.json files might be stale.
   */
  last_updated?: string;
  /**
   * Task-specific errors and warnings (e.g., property availability issues)
   */
  errors?: Error[];
  context?: ContextObject;
  ext?: ExtensionObject;
}
/**
 * Standard error structure for task-specific errors and warnings
 */

// provide_performance_feedback parameters
/**
 * Request payload for provide_performance_feedback task
 */
export type ProvidePerformanceFeedbackRequest = ProvidePerformanceFeedbackRequest1;
/**
 * The business metric being measured
 */
export type MetricType =
  | 'overall_performance'
  | 'conversion_rate'
  | 'brand_lift'
  | 'click_through_rate'
  | 'completion_rate'
  | 'viewability'
  | 'brand_safety'
  | 'cost_efficiency';
/**
 * Source of the performance data
 */
export type FeedbackSource =
  | 'buyer_attribution'
  | 'third_party_measurement'
  | 'platform_analytics'
  | 'verification_partner';

export interface ProvidePerformanceFeedbackRequest1 {
  /**
   * Publisher's media buy identifier
   */
  media_buy_id?: string;
  /**
   * Buyer's reference for the media buy
   */
  buyer_ref?: string;
  /**
   * Time period for performance measurement
   */
  measurement_period?: {
    /**
     * ISO 8601 start timestamp for measurement period
     */
    start: string;
    /**
     * ISO 8601 end timestamp for measurement period
     */
    end: string;
  };
  /**
   * Normalized performance score (0.0 = no value, 1.0 = expected, >1.0 = above expected)
   */
  performance_index?: number;
  /**
   * Specific package within the media buy (if feedback is package-specific)
   */
  package_id?: string;
  /**
   * Specific creative asset (if feedback is creative-specific)
   */
  creative_id?: string;
  metric_type?: MetricType;
  feedback_source?: FeedbackSource;
  context?: ContextObject;
  ext?: ExtensionObject;
}
/**
 * Opaque correlation data that is echoed unchanged in responses. Used for internal tracking, UI session IDs, trace IDs, and other caller-specific identifiers that don't affect protocol behavior. Context data is never parsed by AdCP agents - it's simply preserved and returned.
 */

// provide_performance_feedback response
/**
 * Response payload for provide_performance_feedback task. Returns either success confirmation OR error information, never both.
 */
export type ProvidePerformanceFeedbackResponse =
  | {
      /**
       * Whether the performance feedback was successfully received
       */
      success: true;
      context?: ContextObject;
      ext?: ExtensionObject;
    }
  | {
      /**
       * Array of errors explaining why feedback was rejected (e.g., invalid measurement period, missing campaign data)
       *
       * @minItems 1
       */
      errors: [Error, ...Error[]];
      context?: ContextObject;
      ext?: ExtensionObject;
    };

/**
 * Opaque correlation data that is echoed unchanged in responses. Used for internal tracking, UI session IDs, trace IDs, and other caller-specific identifiers that don't affect protocol behavior. Context data is never parsed by AdCP agents - it's simply preserved and returned.
 */

// build_creative parameters
/**
 * Image asset with URL and dimensions
 */
export type HTTPMethod = 'GET' | 'POST';
/**
 * Expected content type of webhook response
 */
export type WebhookResponseType = 'html' | 'json' | 'xml' | 'javascript';
/**
 * Authentication method
 */
export type WebhookSecurityMethod = 'hmac_sha256' | 'api_key' | 'none';
/**
 * DAAST (Digital Audio Ad Serving Template) tag for third-party audio ad serving
 */
export interface BuildCreativeRequest {
  /**
   * Natural language instructions for the transformation or generation. For pure generation, this is the creative brief. For transformation, this provides guidance on how to adapt the creative.
   */
  message?: string;
  creative_manifest?: CreativeManifest;
  target_format_id: FormatID1;
  context?: ContextObject;
  ext?: ExtensionObject;
}
/**
 * Creative manifest to transform or generate from. For pure generation, this should include the target format_id and any required input assets (e.g., promoted_offerings for generative formats). For transformation (e.g., resizing, reformatting), this is the complete creative to adapt.
 */
export interface CreativeManifest {
  format_id: FormatID;
  /**
   * Product name or offering being advertised. Maps to promoted_offerings in create_media_buy request to associate creative with the product being promoted.
   */
  promoted_offering?: string;
  /**
   * Map of asset IDs to actual asset content. Each key MUST match an asset_id from the format's assets_required array (e.g., 'banner_image', 'clickthrough_url', 'video_file', 'vast_tag'). The asset_id is the technical identifier used to match assets to format requirements.
   *
   * IMPORTANT: Creative manifest validation MUST be performed in the context of the format specification. The format defines what type each asset_id should be, which eliminates any validation ambiguity.
   */
  assets: {
    /**
     * This interface was referenced by `undefined`'s JSON-Schema definition
     * via the `patternProperty` "^[a-z0-9_]+$".
     */
    [k: string]:
      | ImageAsset
      | VideoAsset
      | AudioAsset
      | VASTAsset
      | TextAsset
      | URLAsset
      | HTMLAsset
      | JavaScriptAsset
      | WebhookAsset
      | CSSAsset
      | DAASTAsset
      | PromotedOfferings;
  };
  ext?: ExtensionObject;
}
/**
 * Format identifier this manifest is for. Can be a template format (id only) or a deterministic format (id + dimensions/duration). For dimension-specific creatives, include width/height/unit in the format_id to create a unique identifier (e.g., {id: 'display_static', width: 300, height: 250, unit: 'px'}).
 */
export interface WebhookAsset {
  /**
   * Webhook URL to call for dynamic content
   */
  url: string;
  method?: HTTPMethod;
  /**
   * Maximum time to wait for response in milliseconds
   */
  timeout_ms?: number;
  /**
   * Universal macros that can be passed to webhook (e.g., {DEVICE_TYPE}, {COUNTRY})
   */
  supported_macros?: string[];
  /**
   * Universal macros that must be provided for webhook to function
   */
  required_macros?: string[];
  response_type: WebhookResponseType;
  /**
   * Security configuration for webhook calls
   */
  security: {
    method: WebhookSecurityMethod;
    /**
     * Header name for HMAC signature (e.g., 'X-Signature')
     */
    hmac_header?: string;
    /**
     * Header name for API key (e.g., 'X-API-Key')
     */
    api_key_header?: string;
  };
}
/**
 * CSS stylesheet asset
 */

// build_creative response
/**
 * Response containing the transformed or generated creative manifest, ready for use with preview_creative or sync_creatives. Returns either the complete creative manifest OR error information, never both.
 */
export type BuildCreativeResponse =
  | {
      creative_manifest: CreativeManifest;
      context?: ContextObject;
      ext?: ExtensionObject;
    }
  | {
      /**
       * Array of errors explaining why creative generation failed
       *
       * @minItems 1
       */
      errors: [Error, ...Error[]];
      context?: ContextObject;
      ext?: ExtensionObject;
    };
/**
 * Image asset with URL and dimensions
 */

// preview_creative parameters
/**
 * Request to generate previews of one or more creative manifests. Accepts either a single creative request or an array of requests for batch processing.
 */
export type PreviewCreativeRequest =
  | {
      /**
       * Discriminator indicating this is a single preview request
       */
      request_type: 'single';
      format_id: FormatID;
      creative_manifest: CreativeManifest;
      /**
       * Array of input sets for generating multiple preview variants. Each input set defines macros and context values for one preview rendering. If not provided, creative agent will generate default previews.
       */
      inputs?: {
        /**
         * Human-readable name for this input set (e.g., 'Sunny morning on mobile', 'Evening podcast ad', 'Desktop dark mode')
         */
        name: string;
        /**
         * Macro values to use for this preview. Supports all universal macros from the format's supported_macros list. See docs/media-buy/creatives/universal-macros.md for available macros.
         */
        macros?: {
          [k: string]: string;
        };
        /**
         * Natural language description of the context for AI-generated content (e.g., 'User just searched for running shoes', 'Podcast discussing weather patterns', 'Article about electric vehicles')
         */
        context_description?: string;
      }[];
      /**
       * Specific template ID for custom format rendering
       */
      template_id?: string;
      output_format?: PreviewOutputFormat;
      context?: ContextObject;
      ext?: ExtensionObject;
    }
  | {
      /**
       * Discriminator indicating this is a batch preview request
       */
      request_type: 'batch';
      /**
       * Array of preview requests (1-50 items). Each follows the single request structure.
       *
       * @minItems 1
       * @maxItems 50
       */
      requests: [
        {
          format_id: FormatID2;
          creative_manifest: CreativeManifest1;
          /**
           * Array of input sets for generating multiple preview variants
           */
          inputs?: {
            /**
             * Human-readable name for this input set
             */
            name: string;
            /**
             * Macro values to use for this preview
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
           * Specific template ID for custom format rendering
           */
          template_id?: string;
          output_format?: PreviewOutputFormat1;
        },
        ...{
          format_id: FormatID2;
          creative_manifest: CreativeManifest1;
          /**
           * Array of input sets for generating multiple preview variants
           */
          inputs?: {
            /**
             * Human-readable name for this input set
             */
            name: string;
            /**
             * Macro values to use for this preview
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
           * Specific template ID for custom format rendering
           */
          template_id?: string;
          output_format?: PreviewOutputFormat1;
        }[]
      ];
      output_format?: PreviewOutputFormat2;
      context?: ContextObject;
      ext?: ExtensionObject;
    };
/**
 * Image asset with URL and dimensions
 */
export type PreviewOutputFormat = 'url' | 'html';
/**
 * Output format for this preview. 'url' returns preview_url, 'html' returns preview_html.
 */
export type PreviewOutputFormat1 = 'url' | 'html';
/**
 * Default output format for all requests in this batch. Individual requests can override this. 'url' returns preview_url (iframe-embeddable URL), 'html' returns preview_html (raw HTML for direct embedding).
 */
export type PreviewOutputFormat2 = 'url' | 'html';

/**
 * Format identifier for rendering the preview
 */
export interface CreativeManifest1 {
  format_id: FormatID1;
  /**
   * Product name or offering being advertised. Maps to promoted_offerings in create_media_buy request to associate creative with the product being promoted.
   */
  promoted_offering?: string;
  /**
   * Map of asset IDs to actual asset content. Each key MUST match an asset_id from the format's assets_required array (e.g., 'banner_image', 'clickthrough_url', 'video_file', 'vast_tag'). The asset_id is the technical identifier used to match assets to format requirements.
   *
   * IMPORTANT: Creative manifest validation MUST be performed in the context of the format specification. The format defines what type each asset_id should be, which eliminates any validation ambiguity.
   */
  assets: {
    /**
     * This interface was referenced by `undefined`'s JSON-Schema definition
     * via the `patternProperty` "^[a-z0-9_]+$".
     */
    [k: string]:
      | ImageAsset
      | VideoAsset
      | AudioAsset
      | VASTAsset
      | TextAsset
      | URLAsset
      | HTMLAsset
      | JavaScriptAsset
      | WebhookAsset
      | CSSAsset
      | DAASTAsset
      | PromotedOfferings;
  };
  ext?: ExtensionObject;
}


// preview_creative response
/**
 * Response containing preview links for one or more creatives. Format matches the request: single preview response for single requests, batch results for batch requests.
 */
export type PreviewCreativeResponse =
  | {
      /**
       * Discriminator indicating this is a single preview response
       */
      response_type: 'single';
      /**
       * Array of preview variants. Each preview corresponds to an input set from the request. If no inputs were provided, returns a single default preview.
       *
       * @minItems 1
       */
      previews: [
        {
          /**
           * Unique identifier for this preview variant
           */
          preview_id: string;
          /**
           * Array of rendered pieces for this preview variant. Most formats render as a single piece. Companion ad formats (video + banner), multi-placement formats, and adaptive formats render as multiple pieces.
           *
           * @minItems 1
           */
          renders: [PreviewRender, ...PreviewRender[]];
          /**
           * The input parameters that generated this preview variant. Echoes back the request input or shows defaults used.
           */
          input: {
            /**
             * Human-readable name for this variant
             */
            name: string;
            /**
             * Macro values applied to this variant
             */
            macros?: {
              [k: string]: string;
            };
            /**
             * Context description applied to this variant
             */
            context_description?: string;
          };
        },
        ...{
          /**
           * Unique identifier for this preview variant
           */
          preview_id: string;
          /**
           * Array of rendered pieces for this preview variant. Most formats render as a single piece. Companion ad formats (video + banner), multi-placement formats, and adaptive formats render as multiple pieces.
           *
           * @minItems 1
           */
          renders: [PreviewRender, ...PreviewRender[]];
          /**
           * The input parameters that generated this preview variant. Echoes back the request input or shows defaults used.
           */
          input: {
            /**
             * Human-readable name for this variant
             */
            name: string;
            /**
             * Macro values applied to this variant
             */
            macros?: {
              [k: string]: string;
            };
            /**
             * Context description applied to this variant
             */
            context_description?: string;
          };
        }[]
      ];
      /**
       * Optional URL to an interactive testing page that shows all preview variants with controls to switch between them, modify macro values, and test different scenarios.
       */
      interactive_url?: string;
      /**
       * ISO 8601 timestamp when preview links expire
       */
      expires_at: string;
      context?: ContextObject;
      ext?: ExtensionObject;
    }
  | {
      /**
       * Discriminator indicating this is a batch preview response
       */
      response_type: 'batch';
      /**
       * Array of preview results corresponding to each request in the same order. results[0] is the result for requests[0], results[1] for requests[1], etc. Order is guaranteed even when some requests fail. Each result contains either a successful preview response or an error.
       *
       * @minItems 1
       */
      results: [
        (
          | {
              success?: true;
            }
          | {
              success?: false;
            }
        ),
        ...(
          | {
              success?: true;
            }
          | {
              success?: false;
            }
        )[]
      ];
      context?: ContextObject;
      ext?: ExtensionObject;
    };
/**
 * A single rendered piece of a creative preview with discriminated output format
 */
export type PreviewRender =
  | {
      /**
       * Unique identifier for this rendered piece within the variant
       */
      render_id: string;
      /**
       * Discriminator indicating preview_url is provided
       */
      output_format: 'url';
      /**
       * URL to an HTML page that renders this piece. Can be embedded in an iframe.
       */
      preview_url: string;
      /**
       * Semantic role of this rendered piece. Use 'primary' for main content, 'companion' for associated banners, descriptive strings for device variants or custom roles.
       */
      role: string;
      /**
       * Dimensions for this rendered piece
       */
      dimensions?: {
        width: number;
        height: number;
      };
      /**
       * Optional security and embedding metadata for safe iframe integration
       */
      embedding?: {
        /**
         * Recommended iframe sandbox attribute value (e.g., 'allow-scripts allow-same-origin')
         */
        recommended_sandbox?: string;
        /**
         * Whether this output requires HTTPS for secure embedding
         */
        requires_https?: boolean;
        /**
         * Whether this output supports fullscreen mode
         */
        supports_fullscreen?: boolean;
        /**
         * Content Security Policy requirements for embedding
         */
        csp_policy?: string;
      };
    }
  | {
      /**
       * Unique identifier for this rendered piece within the variant
       */
      render_id: string;
      /**
       * Discriminator indicating preview_html is provided
       */
      output_format: 'html';
      /**
       * Raw HTML for this rendered piece. Can be embedded directly in the page without iframe. Security warning: Only use with trusted creative agents as this bypasses iframe sandboxing.
       */
      preview_html: string;
      /**
       * Semantic role of this rendered piece. Use 'primary' for main content, 'companion' for associated banners, descriptive strings for device variants or custom roles.
       */
      role: string;
      /**
       * Dimensions for this rendered piece
       */
      dimensions?: {
        width: number;
        height: number;
      };
      /**
       * Optional security and embedding metadata
       */
      embedding?: {
        /**
         * Recommended iframe sandbox attribute value (e.g., 'allow-scripts allow-same-origin')
         */
        recommended_sandbox?: string;
        /**
         * Whether this output requires HTTPS for secure embedding
         */
        requires_https?: boolean;
        /**
         * Whether this output supports fullscreen mode
         */
        supports_fullscreen?: boolean;
        /**
         * Content Security Policy requirements for embedding
         */
        csp_policy?: string;
      };
    }
  | {
      /**
       * Unique identifier for this rendered piece within the variant
       */
      render_id: string;
      /**
       * Discriminator indicating both preview_url and preview_html are provided
       */
      output_format: 'both';
      /**
       * URL to an HTML page that renders this piece. Can be embedded in an iframe.
       */
      preview_url: string;
      /**
       * Raw HTML for this rendered piece. Can be embedded directly in the page without iframe. Security warning: Only use with trusted creative agents as this bypasses iframe sandboxing.
       */
      preview_html: string;
      /**
       * Semantic role of this rendered piece. Use 'primary' for main content, 'companion' for associated banners, descriptive strings for device variants or custom roles.
       */
      role: string;
      /**
       * Dimensions for this rendered piece
       */
      dimensions?: {
        width: number;
        height: number;
      };
      /**
       * Optional security and embedding metadata for safe iframe integration
       */
      embedding?: {
        /**
         * Recommended iframe sandbox attribute value (e.g., 'allow-scripts allow-same-origin')
         */
        recommended_sandbox?: string;
        /**
         * Whether this output requires HTTPS for secure embedding
         */
        requires_https?: boolean;
        /**
         * Whether this output supports fullscreen mode
         */
        supports_fullscreen?: boolean;
        /**
         * Content Security Policy requirements for embedding
         */
        csp_policy?: string;
      };
    };

/**
 * Opaque correlation data that is echoed unchanged in responses. Used for internal tracking, UI session IDs, trace IDs, and other caller-specific identifiers that don't affect protocol behavior. Context data is never parsed by AdCP agents - it's simply preserved and returned.
 */

// get_signals parameters
/**
 * A deployment target where signals can be activated (DSP, sales agent, etc.)
 */
export type Destination =
  | {
      /**
       * Discriminator indicating this is a platform-based deployment
       */
      type: 'platform';
      /**
       * Platform identifier for DSPs (e.g., 'the-trade-desk', 'amazon-dsp')
       */
      platform: string;
      /**
       * Optional account identifier on the platform
       */
      account?: string;
    }
  | {
      /**
       * Discriminator indicating this is an agent URL-based deployment
       */
      type: 'agent';
      /**
       * URL identifying the deployment agent (for sales agents, etc.)
       */
      agent_url: string;
      /**
       * Optional account identifier on the agent
       */
      account?: string;
    };
/**
 * Types of signal catalogs available for audience targeting
 */
export type SignalCatalogType = 'marketplace' | 'custom' | 'owned';

/**
 * Request parameters for discovering signals based on description
 */
export interface GetSignalsRequest {
  /**
   * Natural language description of the desired signals
   */
  signal_spec: string;
  /**
   * Deployment targets where signals need to be activated
   */
  deliver_to: {
    /**
     * List of deployment targets (DSPs, sales agents, etc.). If the authenticated caller matches one of these deployment targets, activation keys will be included in the response.
     *
     * @minItems 1
     */
    deployments: [Destination, ...Destination[]];
    /**
     * Countries where signals will be used (ISO codes)
     */
    countries: string[];
  };
  filters?: SignalFilters;
  /**
   * Maximum number of results to return
   */
  max_results?: number;
  context?: ContextObject;
  ext?: ExtensionObject;
}
/**
 * Filters to refine signal discovery results
 */
export interface SignalFilters {
  /**
   * Filter by catalog type
   */
  catalog_types?: SignalCatalogType[];
  /**
   * Filter by specific data providers
   */
  data_providers?: string[];
  /**
   * Maximum CPM price filter
   */
  max_cpm?: number;
  /**
   * Minimum coverage requirement
   */
  min_coverage_percentage?: number;
}
/**
 * Opaque correlation data that is echoed unchanged in responses. Used for internal tracking, UI session IDs, trace IDs, and other caller-specific identifiers that don't affect protocol behavior. Context data is never parsed by AdCP agents - it's simply preserved and returned.
 */

// get_signals response
/**
 * Type of signal
 */
export type Deployment =
  | {
      /**
       * Discriminator indicating this is a platform-based deployment
       */
      type: 'platform';
      /**
       * Platform identifier for DSPs
       */
      platform: string;
      /**
       * Account identifier if applicable
       */
      account?: string;
      /**
       * Whether signal is currently active on this deployment
       */
      is_live: boolean;
      activation_key?: ActivationKey;
      /**
       * Estimated time to activate if not live, or to complete activation if in progress
       */
      estimated_activation_duration_minutes?: number;
      /**
       * Timestamp when activation completed (if is_live=true)
       */
      deployed_at?: string;
    }
  | {
      /**
       * Discriminator indicating this is an agent URL-based deployment
       */
      type: 'agent';
      /**
       * URL identifying the deployment agent
       */
      agent_url: string;
      /**
       * Account identifier if applicable
       */
      account?: string;
      /**
       * Whether signal is currently active on this deployment
       */
      is_live: boolean;
      activation_key?: ActivationKey1;
      /**
       * Estimated time to activate if not live, or to complete activation if in progress
       */
      estimated_activation_duration_minutes?: number;
      /**
       * Timestamp when activation completed (if is_live=true)
       */
      deployed_at?: string;
    };
/**
 * The key to use for targeting. Only present if is_live=true AND requester has access to this deployment.
 */
export type ActivationKey =
  | {
      /**
       * Segment ID based targeting
       */
      type: 'segment_id';
      /**
       * The platform-specific segment identifier to use in campaign targeting
       */
      segment_id: string;
    }
  | {
      /**
       * Key-value pair based targeting
       */
      type: 'key_value';
      /**
       * The targeting parameter key
       */
      key: string;
      /**
       * The targeting parameter value
       */
      value: string;
    };
/**
 * The key to use for targeting. Only present if is_live=true AND requester has access to this deployment.
 */
export type ActivationKey1 =
  | {
      /**
       * Segment ID based targeting
       */
      type: 'segment_id';
      /**
       * The platform-specific segment identifier to use in campaign targeting
       */
      segment_id: string;
    }
  | {
      /**
       * Key-value pair based targeting
       */
      type: 'key_value';
      /**
       * The targeting parameter key
       */
      key: string;
      /**
       * The targeting parameter value
       */
      value: string;
    };

/**
 * Response payload for get_signals task
 */
export interface GetSignalsResponse {
  /**
   * Array of matching signals
   */
  signals: {
    /**
     * Unique identifier for the signal
     */
    signal_agent_segment_id: string;
    /**
     * Human-readable signal name
     */
    name: string;
    /**
     * Detailed signal description
     */
    description: string;
    signal_type: SignalCatalogType;
    /**
     * Name of the data provider
     */
    data_provider: string;
    /**
     * Percentage of audience coverage
     */
    coverage_percentage: number;
    /**
     * Array of deployment targets
     */
    deployments: Deployment[];
    /**
     * Pricing information
     */
    pricing: {
      /**
       * Cost per thousand impressions
       */
      cpm: number;
      /**
       * Currency code
       */
      currency: string;
    };
  }[];
  /**
   * Task-specific errors and warnings (e.g., signal discovery or pricing issues)
   */
  errors?: Error[];
  context?: ContextObject;
  ext?: ExtensionObject;
}
/**
 * Standard error structure for task-specific errors and warnings
 */

// activate_signal parameters
/**
 * A deployment target where signals can be activated (DSP, sales agent, etc.)
 */
export interface ActivateSignalRequest {
  /**
   * The universal identifier for the signal to activate
   */
  signal_agent_segment_id: string;
  /**
   * Target deployment(s) for activation. If the authenticated caller matches one of these deployment targets, activation keys will be included in the response.
   *
   * @minItems 1
   */
  deployments: [Destination, ...Destination[]];
  context?: ContextObject;
  ext?: ExtensionObject;
}
/**
 * Opaque correlation data that is echoed unchanged in responses. Used for internal tracking, UI session IDs, trace IDs, and other caller-specific identifiers that don't affect protocol behavior. Context data is never parsed by AdCP agents - it's simply preserved and returned.
 */

// activate_signal response
/**
 * Response payload for activate_signal task. Returns either complete success data OR error information, never both. This enforces atomic operation semantics - the signal is either fully activated or not activated at all.
 */
export type ActivateSignalResponse =
  | {
      /**
       * Array of deployment results for each deployment target
       */
      deployments: Deployment[];
      context?: ContextObject;
      ext?: ExtensionObject;
    }
  | {
      /**
       * Array of errors explaining why activation failed (e.g., platform connectivity issues, signal definition problems, authentication failures)
       *
       * @minItems 1
       */
      errors: [Error, ...Error[]];
      context?: ContextObject;
      ext?: ExtensionObject;
    };
/**
 * A signal deployment to a specific deployment target with activation status and key
 */
