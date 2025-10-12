// Generated AdCP core types from official schemas v1.7.0
// Generated at: 2025-10-12T21:09:37.319Z

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
  budget?: Budget;
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
  formats_to_provide?: string[];
  status: PackageStatus;
}
/**
 * Budget configuration for a media buy or package
 */
export interface Budget {
  /**
   * Total budget amount
   */
  total: number;
  /**
   * ISO 4217 currency code
   */
  currency: string;
  pacing?: Pacing;
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
 * Assignment of a creative asset to a package
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
}

// CREATIVE-ASSET SCHEMA
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

// PRODUCT SCHEMA
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
export type DeliveryType = 'guaranteed' | 'non_guaranteed';
export type Product2 = {
  [k: string]: unknown;
};

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
   * Array of supported creative format IDs - use list_creative_formats to get full format details
   */
  format_ids: string[];
  delivery_type: DeliveryType;
  /**
   * Whether this product has fixed pricing (true) or uses auction (false)
   */
  is_fixed_price: boolean;
  /**
   * Cost per thousand impressions
   */
  cpm?: number;
  /**
   * ISO 4217 currency code
   */
  currency?: string;
  /**
   * Minimum budget requirement
   */
  min_spend?: number;
  /**
   * Estimated exposures/impressions for guaranteed products
   */
  estimated_exposures?: number;
  /**
   * Minimum CPM for non-guaranteed products (bids below this are rejected)
   */
  floor_cpm?: number;
  /**
   * Recommended CPM to achieve min_exposures target for non-guaranteed products
   */
  recommended_cpm?: number;
  measurement?: Measurement;
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

