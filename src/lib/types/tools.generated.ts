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
   * Filter by format type
   */
  type?: 'audio' | 'video' | 'display';
  /**
   * Only return IAB standard formats
   */
  standard_only?: boolean;
  /**
   * Filter by format category
   */
  category?: 'standard' | 'custom';
  /**
   * Filter by specific format IDs (e.g., from get_products response)
   */
  format_ids?: string[];
}


// list_creative_formats response
/**
 * Current task state
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
export type CreativeAsset2 =
  | {
      [k: string]: unknown;
    }
  | {
      [k: string]: unknown;
    };

/**
 * Response payload for list_creative_formats task
 */
export interface ListCreativeFormatsResponse {
  /**
   * AdCP schema version used for this response
   */
  adcp_version: string;
  status?: TaskStatus;
  /**
   * Array of available creative formats
   */
  formats: Format[];
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
   * Human-readable format name
   */
  name: string;
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
   * Array of required assets for this format
   */
  assets_required?: CreativeAsset[];
  /**
   * Array of optional assets that may be included
   */
  optional_assets?: CreativeAsset2[];
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
}
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
/**
 * Standard error structure for task-specific errors and warnings
 */

// create_media_buy parameters
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
  packages: (
    | {
        [k: string]: unknown;
      }
    | {
        [k: string]: unknown;
      }
  )[];
  /**
   * Description of advertiser and what is being promoted
   */
  promoted_offering: string;
  /**
   * Purchase order number for tracking
   */
  po_number?: string;
  /**
   * Campaign start date/time in ISO 8601 format
   */
  start_time: string;
  /**
   * Campaign end date/time in ISO 8601 format
   */
  end_time: string;
  budget: Budget;
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
 * Creative asset for upload to library - supports both hosted assets and third-party snippets
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
}

// sync_creatives response
/**
 * Current task state - 'completed' for immediate success, 'working' for operations under 120s, 'submitted' for long-running operations
 */
export type CreativeStatus = 'processing' | 'approved' | 'rejected' | 'pending_review';

/**
 * Response from creative sync operation with detailed results and bulk operation summary
 */
export interface SyncCreativesResponse {
  /**
   * AdCP schema version used for this response
   */
  adcp_version: string;
  /**
   * Human-readable result message summarizing the sync operation
   */
  message: string;
  /**
   * Context ID for tracking async operations
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
   * High-level summary of sync operation results
   */
  summary?: {
    /**
     * Total number of creatives processed
     */
    total_processed: number;
    /**
     * Number of new creatives created
     */
    created: number;
    /**
     * Number of existing creatives updated
     */
    updated: number;
    /**
     * Number of creatives that were already up-to-date
     */
    unchanged: number;
    /**
     * Number of creatives that failed validation or processing
     */
    failed: number;
    /**
     * Number of creatives deleted/archived (when delete_missing=true)
     */
    deleted?: number;
  };
  /**
   * Detailed results for each creative processed
   */
  results?: {
    /**
     * Creative ID from the request
     */
    creative_id: string;
    /**
     * Action taken for this creative
     */
    action: 'created' | 'updated' | 'unchanged' | 'failed' | 'deleted';
    status?: CreativeStatus;
    /**
     * Platform-specific ID assigned to the creative
     */
    platform_id?: string;
    /**
     * List of field names that were modified (for 'updated' action)
     */
    changes?: string[];
    /**
     * Validation or processing errors (for 'failed' action)
     */
    errors?: string[];
    /**
     * Non-fatal warnings about this creative
     */
    warnings?: string[];
    /**
     * Feedback from platform review process
     */
    review_feedback?: string;
    /**
     * Recommended creative adaptations for better performance
     */
    suggested_adaptations?: {
      /**
       * Unique identifier for this adaptation
       */
      adaptation_id: string;
      /**
       * Target format ID for the adaptation
       */
      format_id: string;
      /**
       * Suggested name for the adapted creative
       */
      name: string;
      /**
       * What this adaptation does
       */
      description: string;
      /**
       * Expected performance improvement (percentage)
       */
      estimated_performance_lift?: number;
    }[];
  }[];
  /**
   * Summary of assignment operations (when assignments were included in request)
   */
  assignments_summary?: {
    /**
     * Total number of creative-package assignment operations processed
     */
    total_assignments_processed: number;
    /**
     * Number of successful creative-package assignments
     */
    assigned: number;
    /**
     * Number of creative-package unassignments
     */
    unassigned: number;
    /**
     * Number of assignment operations that failed
     */
    failed: number;
  };
  /**
   * Detailed assignment results (when assignments were included in request)
   */
  assignment_results?: {
    /**
     * Creative that was assigned/unassigned
     */
    creative_id: string;
    /**
     * Packages successfully assigned to this creative
     */
    assigned_packages?: string[];
    /**
     * Packages successfully unassigned from this creative
     */
    unassigned_packages?: string[];
    /**
     * Packages that failed to assign/unassign
     */
    failed_packages?: {
      /**
       * Package ID that failed
       */
      package_id: string;
      /**
       * Error message for the failed assignment
       */
      error: string;
    }[];
  }[];
}


// list_creatives parameters
/**
 * Filter by creative approval status
 */
export type CreativeStatus1 = 'processing' | 'approved' | 'rejected' | 'pending_review';
/**
 * Filter by third-party snippet type
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

// update_media_buy parameters
/**
 * Request parameters for updating campaign and package settings
 */
export type UpdateMediaBuyRequest = UpdateMediaBuyRequest1 & UpdateMediaBuyRequest2;
/**
 * Budget pacing strategy
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
  /**
   * New start date/time in ISO 8601 format
   */
  start_time?: string;
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
   * Date range for the report
   */
  reporting_period: {
    /**
     * ISO 8601 start timestamp
     */
    start: string;
    /**
     * ISO 8601 end timestamp
     */
    end: string;
  };
  /**
   * ISO 4217 currency code
   */
  currency: string;
  /**
   * Combined metrics across all returned media buys
   */
  aggregated_totals: {
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
   * Array of delivery data for each media buy
   */
  deliveries: {
    /**
     * Publisher's media buy identifier
     */
    media_buy_id: string;
    /**
     * Buyer's reference identifier for this media buy
     */
    buyer_ref?: string;
    /**
     * Current media buy status
     */
    status: 'pending' | 'active' | 'paused' | 'completed' | 'failed';
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
