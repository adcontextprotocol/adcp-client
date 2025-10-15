// Tool Parameter and Response Types
// Generated from official AdCP schemas

// get_products parameters
/**
 * Brand information manifest providing brand context, assets, and product catalog. Can be provided inline or as a URL reference to a hosted manifest.
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
 * Type of inventory delivery
 */
export type DeliveryType = 'guaranteed' | 'non_guaranteed';

/**
 * Request parameters for discovering available advertising products
 */
export interface GetProductsRequest {
  /**
   * Natural language description of campaign requirements
   */
  brief?: string;
  brand_manifest: BrandManifestReference;
  /**
   * Structured filters for product discovery
   */
  filters?: {
    delivery_type?: DeliveryType;
    /**
     * Filter for fixed price vs auction products
     */
    is_fixed_price?: boolean;
    /**
     * Filter by format types
     */
    format_types?: ('video' | 'display' | 'audio')[];
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
    [k: string]: unknown;
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
    [k: string]: unknown;
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
    [k: string]: unknown;
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
    [k: string]: unknown;
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
    [k: string]: unknown;
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
    [k: string]: unknown;
  };
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


// get_products response
/**
 * Represents available advertising inventory
 */
export type Product = Product1 & Product2;
/**
 * Type of identifier for this property
 */
export type PropertyIdentifierTypes =
  | 'domain'
  | 'subdomain'
  | 'network_id'
  | 'ios_bundle'
  | 'android_package'
  | 'apple_app_store_id'
  | 'google_play_id'
  | 'roku_store_id'
  | 'fire_tv_asin'
  | 'samsung_app_id'
  | 'apple_tv_bundle'
  | 'bundle_id'
  | 'venue_id'
  | 'screen_id'
  | 'openooh_venue_type'
  | 'rss_url'
  | 'apple_podcast_id'
  | 'spotify_show_id'
  | 'podcast_guid';
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
export type Product2 =
  | {
      [k: string]: unknown;
    }
  | {
      [k: string]: unknown;
    };

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
}
export interface Product1 {
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
   * Array of advertising properties covered by this product for adagents.json validation
   *
   * @minItems 1
   */
  properties?: [Property, ...Property[]];
  /**
   * Tags identifying groups of properties covered by this product (use list_authorized_properties to get full property details)
   *
   * @minItems 1
   */
  property_tags?: [string, ...string[]];
  /**
   * Array of supported creative format IDs - structured format_id objects with agent_url and id
   */
  format_ids: FormatID[];
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
    [k: string]: unknown;
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
 * An advertising property that can be validated via adagents.json
 */
export interface Property {
  /**
   * Type of advertising property
   */
  property_type: 'website' | 'mobile_app' | 'ctv_app' | 'dooh' | 'podcast' | 'radio' | 'streaming_audio';
  /**
   * Human-readable property name
   */
  name: string;
  /**
   * Array of identifiers for this property
   *
   * @minItems 1
   */
  identifiers: [
    {
      type: PropertyIdentifierTypes;
      /**
       * The identifier value. For domain type: 'example.com' matches www.example.com and m.example.com only; 'subdomain.example.com' matches that specific subdomain; '*.example.com' matches all subdomains
       */
      value: string;
    },
    ...{
      type: PropertyIdentifierTypes;
      /**
       * The identifier value. For domain type: 'example.com' matches www.example.com and m.example.com only; 'subdomain.example.com' matches that specific subdomain; '*.example.com' matches all subdomains
       */
      value: string;
    }[]
  ];
  /**
   * Tags for categorization and grouping (e.g., network membership, content categories)
   */
  tags?: string[];
  /**
   * Domain where adagents.json should be checked for authorization validation
   */
  publisher_domain: string;
}
/**
 * Structured format identifier with agent URL and format name
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
    [k: string]: unknown;
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
    [k: string]: unknown;
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
/**
 * Standard error structure for task-specific errors and warnings
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


// list_creative_formats parameters
/**
 * Request parameters for discovering supported creative formats
 */
export interface ListCreativeFormatsRequest {
  /**
   * Return only these specific format IDs (e.g., from get_products response)
   */
  format_ids?: FormatID[];
  /**
   * Filter by format type (technical categories with distinct requirements)
   */
  type?: 'audio' | 'video' | 'display' | 'dooh';
  /**
   * Filter to formats that include these asset types. For third-party tags, search for 'html' or 'javascript'. E.g., ['image', 'text'] returns formats with images and text, ['javascript'] returns formats accepting JavaScript tags.
   */
  asset_types?: ('image' | 'video' | 'audio' | 'text' | 'html' | 'javascript' | 'url')[];
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
}
/**
 * Structured format identifier with agent URL and format name
 */

// list_creative_formats response
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
    capabilities?: ('validation' | 'assembly' | 'generation' | 'preview')[];
    [k: string]: unknown;
  }[];
  /**
   * Task-specific errors and warnings (e.g., format availability issues)
   */
  errors?: Error[];
}
/**
 * Represents a creative format with its requirements
 */
export interface Format {
  format_id: FormatID;
  /**
   * Base URL of the agent that provides this format (authoritative source). E.g., 'https://reference.adcp.org', 'https://dco.example.com'
   */
  agent_url?: string;
  /**
   * Human-readable format name
   */
  name: string;
  /**
   * Plain text explanation of what this format does and what assets it requires
   */
  description?: string;
  /**
   * Optional preview image URL for format browsing/discovery UI. Should be 400x300px (4:3 aspect ratio) PNG or JPG. Used as thumbnail/card image in format browsers.
   */
  preview_image?: string;
  /**
   * Optional URL to showcase page with examples and interactive demos of this format
   */
  example_url?: string;
  /**
   * Media type of this format - determines rendering method and asset requirements
   */
  type: 'audio' | 'video' | 'display' | 'native' | 'dooh' | 'rich_media' | 'universal';
  /**
   * Specification of rendered pieces for this format. Most formats produce a single render. Companion ad formats (video + banner), adaptive formats, and multi-placement formats produce multiple renders. Each render specifies its role and dimensions.
   *
   * @minItems 1
   */
  renders?: [
    {
      /**
       * Semantic role of this rendered piece (e.g., 'primary', 'companion', 'mobile_variant')
       */
      role: string;
      /**
       * Dimensions for this rendered piece
       */
      dimensions: {
        /**
         * Fixed width in specified units
         */
        width?: number;
        /**
         * Fixed height in specified units
         */
        height?: number;
        /**
         * Minimum width for responsive renders
         */
        min_width?: number;
        /**
         * Minimum height for responsive renders
         */
        min_height?: number;
        /**
         * Maximum width for responsive renders
         */
        max_width?: number;
        /**
         * Maximum height for responsive renders
         */
        max_height?: number;
        /**
         * Indicates which dimensions are responsive/fluid
         */
        responsive?: {
          width: boolean;
          height: boolean;
          [k: string]: unknown;
        };
        /**
         * Fixed aspect ratio constraint (e.g., '16:9', '4:3', '1:1')
         */
        aspect_ratio?: string;
        /**
         * Unit of measurement for dimensions
         */
        unit: 'px' | 'dp' | 'inches' | 'cm';
        [k: string]: unknown;
      };
      [k: string]: unknown;
    },
    ...{
      /**
       * Semantic role of this rendered piece (e.g., 'primary', 'companion', 'mobile_variant')
       */
      role: string;
      /**
       * Dimensions for this rendered piece
       */
      dimensions: {
        /**
         * Fixed width in specified units
         */
        width?: number;
        /**
         * Fixed height in specified units
         */
        height?: number;
        /**
         * Minimum width for responsive renders
         */
        min_width?: number;
        /**
         * Minimum height for responsive renders
         */
        min_height?: number;
        /**
         * Maximum width for responsive renders
         */
        max_width?: number;
        /**
         * Maximum height for responsive renders
         */
        max_height?: number;
        /**
         * Indicates which dimensions are responsive/fluid
         */
        responsive?: {
          width: boolean;
          height: boolean;
          [k: string]: unknown;
        };
        /**
         * Fixed aspect ratio constraint (e.g., '16:9', '4:3', '1:1')
         */
        aspect_ratio?: string;
        /**
         * Unit of measurement for dimensions
         */
        unit: 'px' | 'dp' | 'inches' | 'cm';
        [k: string]: unknown;
      };
      [k: string]: unknown;
    }[]
  ];
  /**
   * Array of required assets or asset groups for this format. Can contain individual assets or repeatable asset sequences (e.g., carousel products, slideshow frames).
   */
  assets_required?: (
    | {
        /**
         * Identifier for this asset in the format
         */
        asset_id: string;
        /**
         * Type of asset
         */
        asset_type: 'image' | 'video' | 'audio' | 'text' | 'html' | 'javascript' | 'url' | 'brand_manifest';
        /**
         * Purpose of this asset (e.g., 'hero_image', 'logo', 'headline', 'cta_button')
         */
        asset_role?: string;
        /**
         * Whether this asset is required
         */
        required?: boolean;
        /**
         * Technical requirements for this asset (dimensions, file size, duration, etc.)
         */
        requirements?: {
          [k: string]: unknown;
        };
        [k: string]: unknown;
      }
    | {
        /**
         * Identifier for this asset group (e.g., 'product', 'slide', 'card')
         */
        asset_group_id: string;
        /**
         * Indicates this is a repeatable asset group
         */
        repeatable: true;
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
          /**
           * Type of asset
           */
          asset_type: 'image' | 'video' | 'audio' | 'text' | 'html' | 'javascript' | 'url' | 'brand_manifest';
          /**
           * Purpose of this asset
           */
          asset_role?: string;
          /**
           * Whether this asset is required in each repetition
           */
          required?: boolean;
          /**
           * Technical requirements for this asset
           */
          requirements?: {
            [k: string]: unknown;
          };
          [k: string]: unknown;
        }[];
        [k: string]: unknown;
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
}
/**
 * Structured format identifier with agent URL and format name
 */
export interface FormatID1 {
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
 * Standard error structure for task-specific errors and warnings
 */

// create_media_buy parameters
/**
 * Budget pacing strategy
 */
export type Pacing = 'even' | 'asap' | 'front_loaded';
/**
 * VAST (Video Ad Serving Template) tag for third-party video ad serving
 */
export type VASTAsset = VASTAsset1 & VASTAsset2;
export type VASTAsset2 =
  | {
      [k: string]: unknown;
    }
  | {
      [k: string]: unknown;
    };
/**
 * DAAST (Digital Audio Ad Serving Template) tag for third-party audio ad serving
 */
export type DAASTAsset = DAASTAsset1 & DAASTAsset2;
export type DAASTAsset2 =
  | {
      [k: string]: unknown;
    }
  | {
      [k: string]: unknown;
    };
/**
 * Brand information manifest serving as the namespace and identity for this media buy. Provides brand context, assets, and product catalog. Can be provided inline or as a URL reference to a hosted manifest. Can be cached and reused across multiple requests.
 */
export type StartTiming = 'asap' | string;

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
  brand_manifest: BrandManifestReference;
  /**
   * Purchase order number for tracking
   */
  po_number?: string;
  start_time: StartTiming;
  /**
   * Campaign end date/time in ISO 8601 format
   */
  end_time: string;
  /**
   * Total budget for this media buy. Currency is determined by the pricing_option_id selected in each package.
   */
  budget: number;
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
    [k: string]: unknown;
  };
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
}
/**
 * Structured format identifier with agent URL and format name
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
      | PromotedOfferingsAsset
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
 * Structured format identifier with agent URL and format name
 */
export interface ImageAsset {
  asset_type: 'image';
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
  asset_type: 'video';
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
  asset_type: 'audio';
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
  asset_type: 'text';
  /**
   * Text content
   */
  content: string;
  /**
   * Maximum character length constraint
   */
  max_length?: number;
  /**
   * Language code (e.g., 'en', 'es', 'fr')
   */
  language?: string;
}
/**
 * HTML content asset
 */
export interface HTMLAsset {
  asset_type: 'html';
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
  asset_type: 'css';
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
  asset_type: 'javascript';
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
  asset_type?: 'vast';
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
   * Maximum allowed wrapper/redirect depth
   */
  max_wrapper_depth?: number;
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
  asset_type?: 'daast';
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
 * Reference to promoted offerings specification
 */
export interface PromotedOfferingsAsset {
  asset_type: 'promoted_offerings';
  /**
   * URL of the advertiser's brand or offering (e.g., https://retailer.com)
   */
  url?: string;
  /**
   * Brand colors
   */
  colors?: {
    primary?: string;
    secondary?: string;
    accent?: string;
    [k: string]: unknown;
  };
  /**
   * Brand fonts
   */
  fonts?: string[];
  /**
   * Brand tone/voice
   */
  tone?: string;
}
/**
 * URL reference asset
 */
export interface URLAsset {
  asset_type: 'url';
  /**
   * URL reference
   */
  url: string;
  /**
   * Description of what this URL points to
   */
  description?: string;
}
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
    schemes: ['Bearer' | 'HMAC-SHA256'];
    /**
     * Credentials for authentication. For Bearer: token sent in Authorization header. For HMAC-SHA256: shared secret used to generate signature. Minimum 32 characters. Exchanged out-of-band during onboarding.
     */
    credentials: string;
  };
}


// create_media_buy response
/**
 * Response payload for create_media_buy task
 */
export interface CreateMediaBuyResponse {
  /**
   * Publisher's unique identifier for the created media buy
   */
  media_buy_id?: string;
  /**
   * Buyer's reference identifier for this media buy
   */
  buyer_ref: string;
  /**
   * ISO 8601 timestamp for creative upload deadline
   */
  creative_deadline?: string;
  /**
   * Array of created packages
   */
  packages?: {
    /**
     * Publisher's unique identifier for the package
     */
    package_id: string;
    /**
     * Buyer's reference identifier for the package
     */
    buyer_ref: string;
  }[];
  /**
   * Task-specific errors and warnings (e.g., partial package creation failures)
   */
  errors?: Error[];
}
/**
 * Standard error structure for task-specific errors and warnings
 */

// sync_creatives parameters
/**
 * VAST (Video Ad Serving Template) tag for third-party video ad serving
 */
export interface SyncCreativesRequest {
  /**
   * Array of creative assets to sync (create or update)
   *
   * @maxItems 100
   */
  creatives: CreativeAsset[];
  /**
   * When true, only provided fields are updated (partial update). When false, entire creative is replaced (full upsert).
   */
  patch?: boolean;
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
  /**
   * Validation strictness. 'strict' fails entire sync on any validation error. 'lenient' processes valid creatives and reports errors.
   */
  validation_mode?: 'strict' | 'lenient';
  push_notification_config?: PushNotificationConfig;
}
/**
 * Creative asset for upload to library - supports static assets, generative formats, and third-party snippets
 */

// sync_creatives response
/**
 * Response from creative sync operation with results for each creative
 */
export interface SyncCreativesResponse {
  /**
   * Whether this was a dry run (no actual changes made)
   */
  dry_run?: boolean;
  /**
   * Results for each creative processed
   */
  creatives: {
    /**
     * Creative ID from the request
     */
    creative_id: string;
    /**
     * Action taken for this creative
     */
    action: 'created' | 'updated' | 'unchanged' | 'failed' | 'deleted';
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
}


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
 * Request parameters for querying creative assets from the centralized library with filtering, sorting, and pagination
 */
export interface ListCreativesRequest {
  /**
   * Filter criteria for querying creatives
   */
  filters?: {
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
     * Filter for unassigned creatives when true, assigned creatives when false
     */
    unassigned?: boolean;
    /**
     * Filter creatives that have performance data when true
     */
    has_performance_data?: boolean;
  };
  /**
   * Sorting parameters
   */
  sort?: {
    /**
     * Field to sort by
     */
    field?: 'created_date' | 'updated_date' | 'name' | 'status' | 'assignment_count' | 'performance_score';
    /**
     * Sort direction
     */
    direction?: 'asc' | 'desc';
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
}


// list_creatives response
/**
 * Current approval status of the creative
 */
export type SubAsset = SubAsset1 & SubAsset2;
export type SubAsset2 =
  | {
      [k: string]: unknown;
    }
  | {
      [k: string]: unknown;
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
      direction?: 'asc' | 'desc';
      [k: string]: unknown;
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
     * URL of the creative file (for hosted assets)
     */
    media_url?: string;
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
        | PromotedOfferingsAsset
        | URLAsset;
    };
    /**
     * Landing page URL for the creative
     */
    click_url?: string;
    /**
     * Duration in milliseconds (for video/audio)
     */
    duration?: number;
    /**
     * Width in pixels (for video/display)
     */
    width?: number;
    /**
     * Height in pixels (for video/display)
     */
    height?: number;
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
}
/**
 * Format identifier specifying which format this creative conforms to
 */
export interface SubAsset1 {
  /**
   * Type of asset. Common types: headline, body_text, thumbnail_image, product_image, featured_image, logo, cta_text, price_text, sponsor_name, author_name, click_url
   */
  asset_type?: string;
  /**
   * Unique identifier for the asset within the creative
   */
  asset_id?: string;
  /**
   * URL for media assets (images, videos, etc.)
   */
  content_uri?: string;
  /**
   * Text content for text-based assets like headlines, body text, CTA text, etc.
   */
  content?: string | string[];
}


// update_media_buy parameters
/**
 * Request parameters for updating campaign and package settings
 */
export type UpdateMediaBuyRequest = UpdateMediaBuyRequest1 & UpdateMediaBuyRequest2;
/**
 * Campaign start timing: 'asap' or ISO 8601 date-time
 */
export type UpdateMediaBuyRequest2 = {
  [k: string]: unknown;
};

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
   * Pause/resume the entire media buy
   */
  active?: boolean;
  start_time?: StartTiming;
  /**
   * New end date/time in ISO 8601 format
   */
  end_time?: string;
  /**
   * Updated total budget for this media buy. Currency is determined by the pricing_option_id selected in each package.
   */
  budget?: number;
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
}
/**
 * Optional webhook configuration for async update notifications. Publisher will send webhook when update completes if operation takes longer than immediate response time.
 */

// update_media_buy response
/**
 * Response payload for update_media_buy task
 */
export interface UpdateMediaBuyResponse {
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
   * Array of packages that were modified
   */
  affected_packages?: {
    /**
     * Publisher's package identifier
     */
    package_id: string;
    /**
     * Buyer's reference for the package
     */
    buyer_ref: string;
  }[];
  /**
   * Task-specific errors and warnings (e.g., partial update failures)
   */
  errors?: Error[];
}
/**
 * Standard error structure for task-specific errors and warnings
 */

// get_media_buy_delivery parameters
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
  status_filter?:
    | ('active' | 'pending' | 'paused' | 'completed' | 'failed' | 'all')
    | ('active' | 'pending' | 'paused' | 'completed' | 'failed')[];
  /**
   * Start date for reporting period (YYYY-MM-DD)
   */
  start_date?: string;
  /**
   * End date for reporting period (YYYY-MM-DD)
   */
  end_date?: string;
}


// get_media_buy_delivery response
/**
 * Pricing model used for this media buy
 */
export type PricingModel = 'cpm' | 'vcpm' | 'cpc' | 'cpcv' | 'cpv' | 'cpp' | 'flat_rate';

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
      [k: string]: unknown;
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
      [k: string]: unknown;
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
    [k: string]: unknown;
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
 * Request parameters for discovering all properties this agent is authorized to represent
 */
export interface ListAuthorizedPropertiesRequest {
  /**
   * Filter properties by specific tags (optional)
   */
  tags?: string[];
}


// list_authorized_properties response
/**
 * Type of identifier for this property
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
 * Response payload for list_authorized_properties task
 */
export interface ListAuthorizedPropertiesResponse {
  /**
   * Array of all properties this agent is authorized to represent
   */
  properties: Property[];
  /**
   * Metadata for each tag referenced by properties
   */
  tags?: {
    [k: string]: {
      /**
       * Human-readable name for this tag
       */
      name: string;
      /**
       * Description of what this tag represents
       */
      description: string;
    };
  };
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
   * Task-specific errors and warnings (e.g., property availability issues)
   */
  errors?: Error[];
}
/**
 * An advertising property that can be validated via adagents.json
 */

// provide_performance_feedback parameters
/**
 * Request payload for provide_performance_feedback task
 */
export interface ProvidePerformanceFeedbackRequest {
  /**
   * Publisher's media buy identifier
   */
  media_buy_id: string;
  /**
   * Time period for performance measurement
   */
  measurement_period: {
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
  performance_index: number;
  /**
   * Specific package within the media buy (if feedback is package-specific)
   */
  package_id?: string;
  /**
   * Specific creative asset (if feedback is creative-specific)
   */
  creative_id?: string;
  /**
   * The business metric being measured
   */
  metric_type?:
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
  feedback_source?: 'buyer_attribution' | 'third_party_measurement' | 'platform_analytics' | 'verification_partner';
}


// provide_performance_feedback response
/**
 * Response payload for provide_performance_feedback task
 */
export interface ProvidePerformanceFeedbackResponse {
  /**
   * Whether the performance feedback was successfully received
   */
  success: boolean;
  /**
   * Task-specific errors and warnings (e.g., invalid measurement period, missing campaign data)
   */
  errors?: Error[];
}
/**
 * Standard error structure for task-specific errors and warnings
 */

// get_signals parameters
/**
 * Request parameters for discovering signals based on description
 */
export interface GetSignalsRequest {
  /**
   * Natural language description of the desired signals
   */
  signal_spec: string;
  /**
   * Where the signals need to be delivered
   */
  deliver_to: {
    /**
     * Target platforms for signal deployment
     */
    platforms: 'all' | string[];
    /**
     * Specific platform-account combinations
     */
    accounts?: {
      /**
       * Platform identifier
       */
      platform: string;
      /**
       * Account identifier on that platform
       */
      account: string;
    }[];
    /**
     * Countries where signals will be used (ISO codes)
     */
    countries: string[];
  };
  /**
   * Filters to refine results
   */
  filters?: {
    /**
     * Filter by catalog type
     */
    catalog_types?: ('marketplace' | 'custom' | 'owned')[];
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
  };
  /**
   * Maximum number of results to return
   */
  max_results?: number;
}


// get_signals response
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
    /**
     * Type of signal
     */
    signal_type: 'marketplace' | 'custom' | 'owned';
    /**
     * Name of the data provider
     */
    data_provider: string;
    /**
     * Percentage of audience coverage
     */
    coverage_percentage: number;
    /**
     * Array of platform deployments
     */
    deployments: {
      /**
       * Platform name
       */
      platform: string;
      /**
       * Specific account if applicable
       */
      account?: string | null;
      /**
       * Whether signal is currently active
       */
      is_live: boolean;
      /**
       * Deployment scope
       */
      scope: 'platform-wide' | 'account-specific';
      /**
       * Platform-specific segment ID
       */
      decisioning_platform_segment_id?: string;
      /**
       * Time to activate if not live
       */
      estimated_activation_duration_minutes?: number;
    }[];
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
}
/**
 * Standard error structure for task-specific errors and warnings
 */

// activate_signal parameters
/**
 * Request parameters for activating a signal on a specific platform/account
 */
export interface ActivateSignalRequest {
  /**
   * The universal identifier for the signal to activate
   */
  signal_agent_segment_id: string;
  /**
   * The target platform for activation
   */
  platform: string;
  /**
   * Account identifier (required for account-specific activation)
   */
  account?: string;
}


// activate_signal response
/**
 * Response payload for activate_signal task
 */
export interface ActivateSignalResponse {
  /**
   * The platform-specific ID to use once activated
   */
  decisioning_platform_segment_id?: string;
  /**
   * Estimated time to complete (optional)
   */
  estimated_activation_duration_minutes?: number;
  /**
   * Timestamp when activation completed (optional)
   */
  deployed_at?: string;
  /**
   * Task-specific errors and warnings (e.g., activation failures, platform issues)
   */
  errors?: Error[];
}
/**
 * Standard error structure for task-specific errors and warnings
 */
