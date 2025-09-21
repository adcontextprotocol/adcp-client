// Generated AdCP core types from official schemas v1.5.0
// Generated at: 2025-09-21T19:15:46.794Z

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
   * Array of product IDs to include in this package
   */
  products?: string[];
  budget?: Budget;
  /**
   * Impression goal for this package
   */
  impressions?: number;
  targeting_overlay?: Targeting;
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
 * Audience targeting criteria
 */
export interface Targeting {
  /**
   * Target specific countries (ISO codes)
   */
  geo_country_any_of?: string[];
  /**
   * Target specific regions/states
   */
  geo_region_any_of?: string[];
  /**
   * Target specific metro areas (DMA codes)
   */
  geo_metro_any_of?: string[];
  /**
   * Target specific postal/ZIP codes
   */
  geo_postal_code_any_of?: string[];
  /**
   * Audience segment IDs to target
   */
  audience_segment_any_of?: string[];
  /**
   * AXE segment ID to include for targeting
   */
  axe_include_segment?: string;
  /**
   * AXE segment ID to exclude from targeting
   */
  axe_exclude_segment?: string;
  /**
   * Signal IDs from get_signals
   */
  signals?: string[];
  /**
   * Target specific device types
   */
  device_type_any_of?: ('desktop' | 'mobile' | 'tablet' | 'connected_tv' | 'smart_speaker')[];
  /**
   * Target specific operating systems
   */
  os_any_of?: ('windows' | 'macos' | 'ios' | 'android' | 'linux' | 'roku' | 'tvos' | 'other')[];
  /**
   * Target specific browsers
   */
  browser_any_of?: ('chrome' | 'firefox' | 'safari' | 'edge' | 'other')[];
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
 * Creative asset for upload to library - supports both hosted assets and third-party snippets
 */
export type CreativeAsset = CreativeAsset1 & CreativeAsset2;
/**
 * Type of snippet content
 */
export type SnippetType = 'vast_xml' | 'vast_url' | 'html' | 'javascript' | 'iframe' | 'daast_url';
/**
 * Sub-asset for multi-asset creative formats, including carousel images and native ad template variables
 */
export type SubAsset = SubAsset1 & SubAsset2;
export type SubAsset2 =
  | {
      [k: string]: unknown;
    }
  | {
      [k: string]: unknown;
    };
export type CreativeAsset2 = {
  [k: string]: unknown;
};

export interface CreativeAsset1 {
  /**
   * Unique identifier for the creative
   */
  creative_id: string;
  /**
   * Human-readable creative name
   */
  name: string;
  /**
   * Creative format type (e.g., video, audio, display)
   */
  format: string;
  /**
   * URL of the creative file (for hosted assets)
   */
  media_url?: string;
  /**
   * Third-party tag, VAST XML, or code snippet (for third-party served assets)
   */
  snippet?: string;
  snippet_type?: SnippetType;
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
   * Sub-assets for multi-asset formats like carousels
   */
  assets?: SubAsset[];
}
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
   * Cost per thousand impressions in USD
   */
  cpm?: number;
  /**
   * Minimum budget requirement in USD
   */
  min_spend?: number;
  measurement?: Measurement;
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
 * Audience targeting criteria
 */
export interface Targeting {
  /**
   * Target specific countries (ISO codes)
   */
  geo_country_any_of?: string[];
  /**
   * Target specific regions/states
   */
  geo_region_any_of?: string[];
  /**
   * Target specific metro areas (DMA codes)
   */
  geo_metro_any_of?: string[];
  /**
   * Target specific postal/ZIP codes
   */
  geo_postal_code_any_of?: string[];
  /**
   * Audience segment IDs to target
   */
  audience_segment_any_of?: string[];
  /**
   * AXE segment ID to include for targeting
   */
  axe_include_segment?: string;
  /**
   * AXE segment ID to exclude from targeting
   */
  axe_exclude_segment?: string;
  /**
   * Signal IDs from get_signals
   */
  signals?: string[];
  /**
   * Target specific device types
   */
  device_type_any_of?: ('desktop' | 'mobile' | 'tablet' | 'connected_tv' | 'smart_speaker')[];
  /**
   * Target specific operating systems
   */
  os_any_of?: ('windows' | 'macos' | 'ios' | 'android' | 'linux' | 'roku' | 'tvos' | 'other')[];
  /**
   * Target specific browsers
   */
  browser_any_of?: ('chrome' | 'firefox' | 'safari' | 'edge' | 'other')[];
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

