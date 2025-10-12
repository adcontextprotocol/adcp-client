// Tool Parameter and Response Types
// Generated from official AdCP schemas

// get_products parameters
/**
 * Type of inventory delivery
 */
export type DeliveryType = 'guaranteed' | 'non_guaranteed';

/**
 * Request parameters for discovering available advertising products
 */
export interface GetProductsRequest {
  /**
   * AdCP schema version for this request
   */
  adcp_version?: string;
  /**
   * Natural language description of campaign requirements
   */
  brief?: string;
  /**
   * Description of advertiser and what is being promoted
   */
  promoted_offering: string;
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
    format_ids?: string[];
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


// get_products response
/**
 * Current task state
 */
export type TaskStatus =
  | 'submitted'
  | 'working'
  | 'input-required'
  | 'completed'
  | 'canceled'
  | 'failed'
  | 'rejected'
  | 'auth-required'
  | 'unknown';
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
   * AdCP schema version used for this response
   */
  adcp_version: string;
  status?: TaskStatus;
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
   * AdCP schema version for this request
   */
  adcp_version?: string;
  /**
   * Return only these specific format IDs (e.g., from get_products response)
   */
  format_ids?: string[];
  /**
   * Filter by format type (technical categories with distinct requirements)
   */
  type?: 'audio' | 'video' | 'display' | 'dooh';
  /**
   * Filter to formats that include these asset types. For third-party tags, search for 'html' or 'javascript'. E.g., ['image', 'text'] returns formats with images and text, ['javascript'] returns formats accepting JavaScript tags.
   */
  asset_types?: ('image' | 'video' | 'audio' | 'text' | 'html' | 'javascript' | 'url')[];
  /**
   * Filter to formats with specific dimensions (e.g., '300x250', '728x90'). Useful with asset_types to find specific sizes like '300x250 JavaScript'
   */
  dimensions?: string;
  /**
   * Search for formats by name (case-insensitive partial match)
   */
  name_search?: string;
}


// list_creative_formats response
/**
 * Current task state
 */
export interface ListCreativeFormatsResponse {
  /**
   * AdCP schema version used for this response
   */
  adcp_version: string;
  status?: TaskStatus;
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
  /**
   * Unique identifier for the format
   */
  format_id: string;
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
   * Optional preview image URL for format browsing/discovery UI
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
   * Format category
   */
  category?: 'standard' | 'custom';
  /**
   * Whether this format follows IAB specifications or AdCP standard format definitions (found in /schemas/v1/standard-formats/)
   */
  is_standard?: boolean;
  /**
   * Technical specifications for this format (e.g., dimensions, duration, file size limits, codecs)
   */
  requirements?: {
    [k: string]: unknown;
  };
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
   * Whether this format can accept third-party served creative tags as an alternative to hosted assets
   */
  accepts_3p_tags?: boolean;
  /**
   * List of universal macros supported by this format (e.g., MEDIA_BUY_ID, CACHEBUSTER, DEVICE_ID). Used for validation and developer tooling.
   */
  supported_macros?: string[];
}
/**
 * Standard error structure for task-specific errors and warnings
 */

// create_media_buy parameters
/**
 * Package configuration for media buy creation
 */
export type PackageRequest =
  | (
      | {
          [k: string]: unknown;
        }
      | {
          [k: string]: unknown;
        }
    )
  | (
      | {
          [k: string]: unknown;
        }
      | {
          [k: string]: unknown;
        }
    );
/**
 * Brand information manifest serving as the namespace and identity for this media buy. Provides brand context, assets, and product catalog. Can be cached and reused across multiple requests.
 */
export type BrandManifest = BrandManifest1 & BrandManifest2;
export type BrandManifest1 = {
  [k: string]: unknown;
};
/**
 * Campaign start timing: 'asap' or ISO 8601 date-time
 */
export type StartTiming = 'asap' | string;
/**
 * Budget pacing strategy
 */
export type Pacing = 'even' | 'asap' | 'front_loaded';

/**
 * Request parameters for creating a media buy
 */
export interface CreateMediaBuyRequest {
  /**
   * AdCP schema version for this request
   */
  adcp_version?: string;
  /**
   * Buyer's reference identifier for this media buy
   */
  buyer_ref: string;
  /**
   * Array of package configurations
   */
  packages: PackageRequest[];
  brand_manifest: BrandManifest;
  /**
   * DEPRECATED: Use brand_manifest instead. Legacy field for describing what is being promoted.
   */
  promoted_offering?: string;
  /**
   * Purchase order number for tracking
   */
  po_number?: string;
  start_time: StartTiming;
  /**
   * Campaign end date/time in ISO 8601 format
   */
  end_time: string;
  budget: Budget;
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
 * Webhook configuration for asynchronous task notifications. Uses A2A-compatible PushNotificationConfig structure. Supports Bearer tokens (simple) or HMAC signatures (production-recommended).
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
    schemes: ['Bearer' | 'HMAC-SHA256'];
    /**
     * Credentials for authentication. For Bearer: token sent in Authorization header. For HMAC-SHA256: shared secret used to generate signature. Minimum 32 characters. Exchanged out-of-band during onboarding.
     */
    credentials: string;
  };
}


// create_media_buy response
/**
 * Current task state - 'completed' for immediate success, 'working' for operations under 120s, 'submitted' for long-running operations, 'input-required' if approval needed
 */
export interface CreateMediaBuyResponse {
  /**
   * AdCP schema version used for this response
   */
  adcp_version: string;
  status: TaskStatus;
  /**
   * Unique identifier for tracking this async operation (present for submitted/working status)
   */
  task_id?: string;
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
 * Request parameters for syncing creative assets with upsert semantics - supports bulk operations, patch updates, and assignment management
 */
export interface SyncCreativesRequest {
  /**
   * AdCP schema version for this request
   */
  adcp_version?: string;
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
/**
 * Optional webhook configuration for async sync notifications. Publisher will send webhook when sync completes if operation takes longer than immediate response time (typically for large bulk operations or manual approval/HITL).
 */

// sync_creatives response
/**
 * Current task state - 'completed' for immediate success, 'working' for operations under 120s, 'submitted' for long-running operations
 */
export interface SyncCreativesResponse {
  /**
   * AdCP schema version used for this response
   */
  adcp_version: string;
  /**
   * Human-readable result message (e.g., 'Synced 3 creatives: 2 created, 1 updated')
   */
  message: string;
  /**
   * Context ID for tracking async operations and conversational approval workflows
   */
  context_id?: string;
  status: TaskStatus;
  /**
   * Unique identifier for tracking this async operation (present for submitted/working status)
   */
  task_id?: string;
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
 * Filter by third-party snippet type
 */
export type SnippetType = 'vast_xml' | 'vast_url' | 'html' | 'javascript' | 'iframe' | 'daast_url';

/**
 * Request parameters for querying creative assets from the centralized library with filtering, sorting, and pagination
 */
export interface ListCreativesRequest {
  /**
   * AdCP schema version for this request
   */
  adcp_version?: string;
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
    snippet_type?: SnippetType;
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
   * AdCP schema version used for this response
   */
  adcp_version: string;
  /**
   * Human-readable result message
   */
  message: string;
  /**
   * Context ID for tracking related operations
   */
  context_id?: string;
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
    /**
     * Creative format type
     */
    format: string;
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
     * Third-party tag, VAST XML, or code snippet (for third-party assets)
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
   * AdCP schema version for this request
   */
  adcp_version?: string;
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
  budget?: Budget;
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
 * Budget configuration for a media buy or package
 */

// update_media_buy response
/**
 * Current task state - 'completed' for immediate success, 'working' for operations under 120s, 'submitted' for long-running operations, 'input-required' if approval needed
 */
export interface UpdateMediaBuyResponse {
  /**
   * AdCP schema version used for this response
   */
  adcp_version: string;
  status: TaskStatus;
  /**
   * Unique identifier for tracking this async operation (present for submitted/working status)
   */
  task_id?: string;
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
   * AdCP schema version for this request
   */
  adcp_version?: string;
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
 * Response payload for get_media_buy_delivery task
 */
export interface GetMediaBuyDeliveryResponse {
  /**
   * AdCP schema version used for this response
   */
  adcp_version: string;
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
     * Human-readable message (typically present when status is reporting_delayed or failed)
     */
    message?: string;
    /**
     * When delayed data is expected to be available (only present when status is reporting_delayed)
     */
    expected_availability?: string;
    /**
     * Indicates this delivery contains updated data for a previously reported period. Buyer should replace previous period data with these totals.
     */
    is_adjusted?: boolean;
    /**
     * Aggregate metrics for this media buy across all packages
     */
    totals: {
      /**
       * Total impressions delivered
       */
      impressions: number;
      /**
       * Total amount spent
       */
      spend: number;
      /**
       * Total clicks (if applicable)
       */
      clicks?: number;
      /**
       * Click-through rate (clicks/impressions)
       */
      ctr?: number;
      /**
       * Total video completions (if applicable)
       */
      video_completions?: number;
      /**
       * Video completion rate (completions/impressions)
       */
      completion_rate?: number;
    };
    /**
     * Metrics broken down by package
     */
    by_package: {
      /**
       * Publisher's package identifier
       */
      package_id: string;
      /**
       * Buyer's reference identifier for this package
       */
      buyer_ref?: string;
      /**
       * Package impressions
       */
      impressions: number;
      /**
       * Package spend
       */
      spend: number;
      /**
       * Package clicks
       */
      clicks?: number;
      /**
       * Package video completions
       */
      video_completions?: number;
      /**
       * Delivery pace (1.0 = on track, <1.0 = behind, >1.0 = ahead)
       */
      pacing_index?: number;
    }[];
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
 * Standard error structure for task-specific errors and warnings
 */

// list_authorized_properties parameters
/**
 * Request parameters for discovering all properties this agent is authorized to represent
 */
export interface ListAuthorizedPropertiesRequest {
  /**
   * AdCP schema version for this request
   */
  adcp_version?: string;
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
   * AdCP schema version used for this response
   */
  adcp_version: string;
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
   * AdCP schema version for this request
   */
  adcp_version?: string;
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
   * AdCP schema version used for this response
   */
  adcp_version: string;
  /**
   * Whether the performance feedback was successfully received
   */
  success: boolean;
  /**
   * Optional human-readable message about the feedback processing
   */
  message?: string;
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
   * AdCP schema version for this request
   */
  adcp_version?: string;
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
   * AdCP schema version used for this response
   */
  adcp_version: string;
  /**
   * Human-readable summary of the signal discovery results
   */
  message: string;
  /**
   * Session continuity identifier for follow-up requests
   */
  context_id: string;
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
   * AdCP schema version for this request
   */
  adcp_version?: string;
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
 * Current activation state: 'submitted' (pending), 'working' (processing), 'completed' (deployed), 'failed', 'input-required' (needs auth), etc.
 */
export interface ActivateSignalResponse {
  /**
   * AdCP schema version used for this response
   */
  adcp_version: string;
  /**
   * Human-readable summary of the activation status
   */
  message: string;
  /**
   * Session continuity identifier for tracking progress
   */
  context_id: string;
  /**
   * Unique identifier for tracking the activation
   */
  task_id: string;
  status: TaskStatus;
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
