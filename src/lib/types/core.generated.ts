// Generated AdCP core types from official schemas vlatest
// Generated at: 2026-02-22T00:32:13.357Z

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
 * Metro area classification system (e.g., 'nielsen_dma', 'uk_itl2')
 */
export type MetroAreaSystem = 'nielsen_dma' | 'uk_itl1' | 'uk_itl2' | 'eurostat_nuts2' | 'custom';
/**
 * Metro area classification system (e.g., 'nielsen_dma', 'uk_itl2')
 */
export type PostalCodeSystem =
  | 'us_zip'
  | 'us_zip_plus_four'
  | 'gb_outward'
  | 'gb_full'
  | 'ca_fsa'
  | 'ca_full'
  | 'de_plz'
  | 'fr_code_postal'
  | 'au_postcode';
/**
 * Postal code system (e.g., 'us_zip', 'gb_outward'). System name encodes country and precision.
 */
export type DayOfWeek = 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday';
/**
 * Methods for verifying user age for compliance. Does not include 'inferred' as it is not accepted for regulatory compliance.
 */
export type AgeVerificationMethod = 'facial_age_estimation' | 'id_document' | 'digital_id' | 'credit_card' | 'world_id';
/**
 * Operating system platforms for device targeting. Browser values from Sec-CH-UA-Platform standard, extended for CTV.
 */
export type DevicePlatform =
  | 'ios'
  | 'android'
  | 'windows'
  | 'macos'
  | 'linux'
  | 'chromeos'
  | 'tvos'
  | 'tizen'
  | 'webos'
  | 'fire_os'
  | 'roku_os'
  | 'unknown';
/**
 * Event type to optimize for (e.g. purchase, lead)
 */
export type EventType =
  | 'page_view'
  | 'view_content'
  | 'select_content'
  | 'select_item'
  | 'search'
  | 'share'
  | 'add_to_cart'
  | 'remove_from_cart'
  | 'viewed_cart'
  | 'add_to_wishlist'
  | 'initiate_checkout'
  | 'add_payment_info'
  | 'purchase'
  | 'refund'
  | 'lead'
  | 'qualify_lead'
  | 'close_convert_lead'
  | 'disqualify_lead'
  | 'complete_registration'
  | 'subscribe'
  | 'start_trial'
  | 'app_install'
  | 'app_launch'
  | 'contact'
  | 'schedule'
  | 'donate'
  | 'submit_application'
  | 'custom';

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
  /**
   * Buyer's campaign reference label. Groups related operations under a single campaign for CRM and ad server correlation.
   */
  campaign_ref?: string;
  account?: Account;
  status: MediaBuyStatus;
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
  ext?: ExtensionObject;
}
/**
 * Account billed for this media buy
 */
export interface Account {
  /**
   * Unique identifier for this account
   */
  account_id: string;
  /**
   * Human-readable account name (e.g., 'Acme', 'Acme c/o Pinnacle')
   */
  name: string;
  /**
   * The advertiser whose rates apply to this account
   */
  advertiser?: string;
  /**
   * Optional intermediary who receives invoices on behalf of the advertiser (e.g., agency)
   */
  billing_proxy?: string;
  /**
   * Account status. pending_approval: seller reviewing (credit, contracts). payment_required: credit limit reached or funds depleted. suspended: was active, now paused. closed: terminated.
   */
  status: 'active' | 'pending_approval' | 'payment_required' | 'suspended' | 'closed';
  /**
   * House domain where brand.json is hosted. Canonical identity anchor for the brand.
   */
  house?: string;
  /**
   * Brand ID within the house portfolio (from brand.json)
   */
  brand_id?: string;
  /**
   * Domain of the entity operating this account
   */
  operator?: string;
  /**
   * Who is invoiced on this account. brand: seller invoices the brand directly. operator: seller invoices the operator (agency). agent: agent consolidates billing.
   */
  billing?: 'brand' | 'operator' | 'agent';
  /**
   * Identifier for the rate card applied to this account
   */
  rate_card?: string;
  /**
   * Payment terms (e.g., 'net_30', 'prepay')
   */
  payment_terms?: string;
  /**
   * Maximum outstanding balance allowed
   */
  credit_limit?: {
    amount: number;
    currency: string;
  };
  /**
   * When true, this is a sandbox account. All requests using this account_id are treated as sandbox — no real platform calls, no real spend.
   */
  sandbox?: boolean;
  ext?: ExtensionObject;
  [k: string]: unknown | undefined;
}
/**
 * Extension object for platform-specific, vendor-namespaced parameters. Extensions are always optional and must be namespaced under a vendor/platform key (e.g., ext.gam, ext.roku). Used for custom capabilities, partner-specific configuration, and features being proposed for standardization.
 */
export interface ExtensionObject {
  [k: string]: unknown | undefined;
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
  optimization_goal?: OptimizationGoal;
  /**
   * Whether this package is paused by the buyer. Paused packages do not deliver impressions. Defaults to false.
   */
  paused?: boolean;
  ext?: ExtensionObject;
  [k: string]: unknown | undefined;
}
/**
 * Optional restriction overlays for media buys. Most targeting should be expressed in the brief and handled by the publisher. These fields are for functional restrictions: geographic (RCT testing, regulatory compliance), age verification (alcohol, gambling), device platform (app compatibility), and language (localization).
 */
export interface TargetingOverlay {
  /**
   * Restrict delivery to specific countries. ISO 3166-1 alpha-2 codes (e.g., 'US', 'GB', 'DE').
   *
   * @minItems 1
   */
  geo_countries?: [string, ...string[]];
  /**
   * Exclude specific countries from delivery. ISO 3166-1 alpha-2 codes (e.g., 'US', 'GB', 'DE').
   *
   * @minItems 1
   */
  geo_countries_exclude?: [string, ...string[]];
  /**
   * Restrict delivery to specific regions/states. ISO 3166-2 subdivision codes (e.g., 'US-CA', 'GB-SCT').
   *
   * @minItems 1
   */
  geo_regions?: [string, ...string[]];
  /**
   * Exclude specific regions/states from delivery. ISO 3166-2 subdivision codes (e.g., 'US-CA', 'GB-SCT').
   *
   * @minItems 1
   */
  geo_regions_exclude?: [string, ...string[]];
  /**
   * Restrict delivery to specific metro areas. Each entry specifies the classification system and target values. Seller must declare supported systems in get_adcp_capabilities.
   *
   * @minItems 1
   */
  geo_metros?: [
    {
      system: MetroAreaSystem;
      /**
       * Metro codes within the system (e.g., ['501', '602'] for Nielsen DMAs)
       *
       * @minItems 1
       */
      values: [string, ...string[]];
    },
    ...{
      system: MetroAreaSystem;
      /**
       * Metro codes within the system (e.g., ['501', '602'] for Nielsen DMAs)
       *
       * @minItems 1
       */
      values: [string, ...string[]];
    }[]
  ];
  /**
   * Exclude specific metro areas from delivery. Each entry specifies the classification system and excluded values. Seller must declare supported systems in get_adcp_capabilities.
   *
   * @minItems 1
   */
  geo_metros_exclude?: [
    {
      system: MetroAreaSystem;
      /**
       * Metro codes to exclude within the system (e.g., ['501', '602'] for Nielsen DMAs)
       *
       * @minItems 1
       */
      values: [string, ...string[]];
    },
    ...{
      system: MetroAreaSystem;
      /**
       * Metro codes to exclude within the system (e.g., ['501', '602'] for Nielsen DMAs)
       *
       * @minItems 1
       */
      values: [string, ...string[]];
    }[]
  ];
  /**
   * Restrict delivery to specific postal areas. Each entry specifies the postal system and target values. Seller must declare supported systems in get_adcp_capabilities.
   *
   * @minItems 1
   */
  geo_postal_areas?: [
    {
      system: PostalCodeSystem;
      /**
       * Postal codes within the system (e.g., ['10001', '10002'] for us_zip)
       *
       * @minItems 1
       */
      values: [string, ...string[]];
    },
    ...{
      system: PostalCodeSystem;
      /**
       * Postal codes within the system (e.g., ['10001', '10002'] for us_zip)
       *
       * @minItems 1
       */
      values: [string, ...string[]];
    }[]
  ];
  /**
   * Exclude specific postal areas from delivery. Each entry specifies the postal system and excluded values. Seller must declare supported systems in get_adcp_capabilities.
   *
   * @minItems 1
   */
  geo_postal_areas_exclude?: [
    {
      system: PostalCodeSystem;
      /**
       * Postal codes to exclude within the system (e.g., ['10001', '10002'] for us_zip)
       *
       * @minItems 1
       */
      values: [string, ...string[]];
    },
    ...{
      system: PostalCodeSystem;
      /**
       * Postal codes to exclude within the system (e.g., ['10001', '10002'] for us_zip)
       *
       * @minItems 1
       */
      values: [string, ...string[]];
    }[]
  ];
  /**
   * Restrict delivery to specific time windows. Each entry specifies days of week and an hour range.
   *
   * @minItems 1
   */
  daypart_targets?: [DaypartTarget, ...DaypartTarget[]];
  /**
   * AXE segment ID to include for targeting
   */
  axe_include_segment?: string;
  /**
   * AXE segment ID to exclude from targeting
   */
  axe_exclude_segment?: string;
  /**
   * Restrict delivery to members of these first-party CRM audiences. Only users present in the uploaded lists are eligible. References audience_id values from sync_audiences on the same seller account — audience IDs are not portable across sellers. Not for lookalike expansion — express that intent in the campaign brief. Seller must declare support in get_adcp_capabilities.
   *
   * @minItems 1
   */
  audience_include?: [string, ...string[]];
  /**
   * Suppress delivery to members of these first-party CRM audiences. Matched users are excluded regardless of other targeting. References audience_id values from sync_audiences on the same seller account — audience IDs are not portable across sellers. Seller must declare support in get_adcp_capabilities.
   *
   * @minItems 1
   */
  audience_exclude?: [string, ...string[]];
  frequency_cap?: FrequencyCap;
  property_list?: PropertyListReference;
  /**
   * Age restriction for compliance. Use for legal requirements (alcohol, gambling), not audience targeting.
   */
  age_restriction?: {
    /**
     * Minimum age required
     */
    min: number;
    /**
     * Whether verified age (not inferred) is required for compliance
     */
    verification_required?: boolean;
    /**
     * Accepted verification methods. If omitted, any method the platform supports is acceptable.
     *
     * @minItems 1
     */
    accepted_methods?: [AgeVerificationMethod, ...AgeVerificationMethod[]];
  };
  /**
   * Restrict to specific platforms. Use for technical compatibility (app only works on iOS). Values from Sec-CH-UA-Platform standard, extended for CTV.
   *
   * @minItems 1
   */
  device_platform?: [DevicePlatform, ...DevicePlatform[]];
  /**
   * Target users within store catchment areas from a synced store catalog. Each entry references a store-type catalog and optionally narrows to specific stores or catchment zones.
   *
   * @minItems 1
   */
  store_catchments?: [
    {
      /**
       * Synced store-type catalog ID from sync_catalogs.
       */
      catalog_id: string;
      /**
       * Filter to specific stores within the catalog. Omit to target all stores.
       *
       * @minItems 1
       */
      store_ids?: [string, ...string[]];
      /**
       * Catchment zone IDs to target (e.g., 'walk', 'drive'). Omit to target all catchment zones.
       *
       * @minItems 1
       */
      catchment_ids?: [string, ...string[]];
      [k: string]: unknown | undefined;
    },
    ...{
      /**
       * Synced store-type catalog ID from sync_catalogs.
       */
      catalog_id: string;
      /**
       * Filter to specific stores within the catalog. Omit to target all stores.
       *
       * @minItems 1
       */
      store_ids?: [string, ...string[]];
      /**
       * Catchment zone IDs to target (e.g., 'walk', 'drive'). Omit to target all catchment zones.
       *
       * @minItems 1
       */
      catchment_ids?: [string, ...string[]];
      [k: string]: unknown | undefined;
    }[]
  ];
  /**
   * Restrict to users with specific language preferences. ISO 639-1 codes (e.g., 'en', 'es', 'fr').
   *
   * @minItems 1
   */
  language?: [string, ...string[]];
  [k: string]: unknown | undefined;
}
/**
 * A time window for daypart targeting. Specifies days of week and an hour range. start_hour is inclusive, end_hour is exclusive (e.g., 6-10 = 6:00am to 10:00am). Follows the Google Ads AdScheduleInfo / DV360 DayPartTargeting pattern.
 */
export interface DaypartTarget {
  /**
   * Days of week this window applies to. Use multiple days for compact targeting (e.g., monday-friday in one object).
   *
   * @minItems 1
   */
  days: [DayOfWeek, ...DayOfWeek[]];
  /**
   * Start hour (inclusive), 0-23 in 24-hour format. 0 = midnight, 6 = 6:00am, 18 = 6:00pm.
   */
  start_hour: number;
  /**
   * End hour (exclusive), 1-24 in 24-hour format. 10 = 10:00am, 24 = midnight. Must be greater than start_hour.
   */
  end_hour: number;
  /**
   * Optional human-readable name for this time window (e.g., 'Morning Drive', 'Prime Time')
   */
  label?: string;
}
/**
 * Frequency capping settings for package-level application
 */
export interface FrequencyCap {
  /**
   * Minutes to suppress after impression
   */
  suppress_minutes: number;
  [k: string]: unknown | undefined;
}
/**
 * Reference to a property list for targeting specific properties within this product. The package runs on the intersection of the product's publisher_properties and this list. Sellers SHOULD return a validation error if the product has property_targeting_allowed: false.
 */
export interface PropertyListReference {
  /**
   * URL of the agent managing the property list
   */
  agent_url: string;
  /**
   * Identifier for the property list within the agent
   */
  list_id: string;
  /**
   * JWT or other authorization token for accessing the list. Optional if the list is public or caller has implicit access.
   */
  auth_token?: string;
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
  [k: string]: unknown | undefined;
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
  [k: string]: unknown | undefined;
}
/**
 * Conversion optimization goal for a package. Tells the seller which event source and event type to optimize delivery against. Provide at most one of target_roas or target_cpa. If neither is provided, the seller optimizes for maximum conversions within budget.
 */
export interface OptimizationGoal {
  /**
   * Event source to optimize against (must be configured on this account via sync_event_sources)
   */
  event_source_id: string;
  event_type: EventType;
  /**
   * Target return on ad spend (e.g. 4.0 = $4 conversion value per $1 spent). Mutually exclusive with target_cpa.
   */
  target_roas?: number;
  /**
   * Target cost per acquisition in the buy currency. Mutually exclusive with target_roas.
   */
  target_cpa?: number;
  /**
   * Attribution window for this optimization goal. Values must match an option declared in the seller's conversion_tracking.attribution_windows capability. When omitted, the seller uses their default window.
   */
  attribution_window?: {
    /**
     * Click-through attribution window (e.g. '7d', '28d', '30d')
     */
    click_through: string;
    /**
     * View-through attribution window (e.g. '1d', '7d')
     */
    view_through?: string;
    [k: string]: unknown | undefined;
  };
  [k: string]: unknown | undefined;
}

// CREATIVE-ASSET SCHEMA
/**
 * Catalog type. Structural types: 'offering' (AdCP Offering objects), 'product' (ecommerce entries), 'inventory' (stock per location), 'store' (physical locations), 'promotion' (deals and pricing). Vertical types: 'hotel', 'flight', 'job', 'vehicle', 'real_estate', 'education', 'destination' — each with an industry-specific item schema.
 */
export type CatalogType =
  | 'offering'
  | 'product'
  | 'inventory'
  | 'store'
  | 'promotion'
  | 'hotel'
  | 'flight'
  | 'job'
  | 'vehicle'
  | 'real_estate'
  | 'education'
  | 'destination';
/**
 * Format of the external feed at url. Required when url points to a non-AdCP feed (e.g., Google Merchant Center XML, Meta Product Catalog). Omit for offering-type catalogs where the feed is native AdCP JSON.
 */
export type FeedFormat = 'google_merchant_center' | 'facebook_catalog' | 'shopify' | 'linkedin_jobs' | 'custom';
/**
 * How often the platform should re-fetch the feed from url. Only applicable when url is provided. Platforms may use this as a hint for polling schedules.
 */
export type UpdateFrequency = 'realtime' | 'hourly' | 'daily' | 'weekly';
/**
 * Standard marketing event types for event logging, aligned with IAB ECAPI
 */
export type ContentIDType =
  | 'sku'
  | 'gtin'
  | 'offering_id'
  | 'job_id'
  | 'hotel_id'
  | 'flight_id'
  | 'vehicle_id'
  | 'listing_id'
  | 'store_id'
  | 'program_id'
  | 'destination_id';
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
      /**
       * URL to captions file (WebVTT, SRT, etc.)
       */
      captions_url?: string;
      /**
       * URL to audio description track for visually impaired users
       */
      audio_description_url?: string;
      [k: string]: unknown | undefined;
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
      /**
       * URL to captions file (WebVTT, SRT, etc.)
       */
      captions_url?: string;
      /**
       * URL to audio description track for visually impaired users
       */
      audio_description_url?: string;
      [k: string]: unknown | undefined;
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
      /**
       * URL to text transcript of the audio content
       */
      transcript_url?: string;
      [k: string]: unknown | undefined;
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
      /**
       * URL to text transcript of the audio content
       */
      transcript_url?: string;
      [k: string]: unknown | undefined;
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
export type URLAssetType = 'clickthrough' | 'tracker_pixel' | 'tracker_script';
/**
 * For generative creatives: set to 'approved' to finalize, 'rejected' to request regeneration with updated assets/message. Omit for non-generative creatives (system will set based on processing state).
 */
export type CreativeStatus = 'processing' | 'approved' | 'rejected' | 'pending_review' | 'archived';

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
  catalog?: Catalog;
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
      [k: string]: string | undefined;
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
  status?: CreativeStatus;
  /**
   * Optional delivery weight for creative rotation when uploading via create_media_buy or update_media_buy (0-100). If omitted, platform determines rotation. Only used during upload to media buy - not stored in creative library.
   */
  weight?: number;
  /**
   * Optional array of placement IDs where this creative should run when uploading via create_media_buy or update_media_buy. References placement_id values from the product's placements array. If omitted, creative runs on all placements. Only used during upload to media buy - not stored in creative library.
   */
  placement_ids?: string[];
}
/**
 * Format identifier specifying which format this creative conforms to. Can be: (1) concrete format_id referencing a format with fixed dimensions, (2) template format_id referencing a template format, or (3) parameterized format_id with dimensions/duration parameters for template formats.
 */
export interface Catalog {
  /**
   * Buyer's identifier for this catalog. Required when syncing via sync_catalogs. When used in creatives, references a previously synced catalog on the account.
   */
  catalog_id?: string;
  /**
   * Human-readable name for this catalog (e.g., 'Summer Products 2025', 'Amsterdam Store Locations').
   */
  name?: string;
  type: CatalogType;
  /**
   * URL to an external catalog feed. The platform fetches and resolves items from this URL. For offering-type catalogs, the feed contains an array of Offering objects. For other types, the feed format is determined by feed_format. When omitted with type 'product', the platform uses its synced copy of the brand's product catalog.
   */
  url?: string;
  feed_format?: FeedFormat;
  update_frequency?: UpdateFrequency;
  /**
   * Inline catalog data. The item schema depends on the catalog type: Offering objects for 'offering', StoreItem for 'store', HotelItem for 'hotel', FlightItem for 'flight', JobItem for 'job', VehicleItem for 'vehicle', RealEstateItem for 'real_estate', EducationItem for 'education', DestinationItem for 'destination', or freeform objects for 'product', 'inventory', and 'promotion'. Mutually exclusive with url — provide one or the other, not both. Implementations should validate items against the type-specific schema.
   *
   * @minItems 1
   */
  items?: [{}, ...{}[]];
  /**
   * Filter catalog to specific item IDs. For offering-type catalogs, these are offering_id values. For product-type catalogs, these are SKU identifiers.
   *
   * @minItems 1
   */
  ids?: [string, ...string[]];
  /**
   * Filter product-type catalogs by GTIN identifiers for cross-retailer catalog matching. Accepts standard GTIN formats (GTIN-8, UPC-A/GTIN-12, EAN-13/GTIN-13, GTIN-14). Only applicable when type is 'product'.
   *
   * @minItems 1
   */
  gtins?: [string, ...string[]];
  /**
   * Filter catalog to items with these tags. Tags are matched using OR logic — items matching any tag are included.
   *
   * @minItems 1
   */
  tags?: [string, ...string[]];
  /**
   * Filter catalog to items in this category (e.g., 'beverages/soft-drinks', 'chef-positions').
   */
  category?: string;
  /**
   * Natural language filter for catalog items (e.g., 'all pasta sauces under $5', 'amsterdam vacancies').
   */
  query?: string;
  /**
   * Event types that represent conversions for items in this catalog. Declares what events the platform should attribute to catalog items — e.g., a job catalog converts via submit_application, a product catalog via purchase. The event's content_ids field carries the item IDs that connect back to catalog items. Use content_id_type to declare what identifier type content_ids values represent.
   *
   * @minItems 1
   */
  conversion_events?: [EventType, ...EventType[]];
  content_id_type?: ContentIDType;
  [k: string]: unknown | undefined;
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
   * Width in pixels
   */
  width: number;
  /**
   * Height in pixels
   */
  height: number;
  /**
   * Image file format (jpg, png, gif, webp, etc.)
   */
  format?: string;
  /**
   * Alternative text for accessibility
   */
  alt_text?: string;
  [k: string]: unknown | undefined;
}
/**
 * Video asset with URL and technical specifications including audio track properties
 */
export interface VideoAsset {
  /**
   * URL to the video asset
   */
  url: string;
  /**
   * Width in pixels
   */
  width: number;
  /**
   * Height in pixels
   */
  height: number;
  /**
   * Video duration in milliseconds
   */
  duration_ms?: number;
  /**
   * File size in bytes
   */
  file_size_bytes?: number;
  /**
   * Video container format (mp4, webm, mov, etc.)
   */
  container_format?: string;
  /**
   * Video codec used (h264, h265, vp9, av1, prores, etc.)
   */
  video_codec?: string;
  /**
   * Video stream bitrate in kilobits per second
   */
  video_bitrate_kbps?: number;
  /**
   * Frame rate as string to preserve precision (e.g., '23.976', '29.97', '30')
   */
  frame_rate?: string;
  /**
   * Whether the video uses constant (CFR) or variable (VFR) frame rate
   */
  frame_rate_type?: 'constant' | 'variable';
  /**
   * Scan type of the video
   */
  scan_type?: 'progressive' | 'interlaced';
  /**
   * Color space of the video
   */
  color_space?: 'rec709' | 'rec2020' | 'rec2100' | 'srgb' | 'dci_p3';
  /**
   * HDR format if applicable, or 'sdr' for standard dynamic range
   */
  hdr_format?: 'sdr' | 'hdr10' | 'hdr10_plus' | 'hlg' | 'dolby_vision';
  /**
   * Chroma subsampling format
   */
  chroma_subsampling?: '4:2:0' | '4:2:2' | '4:4:4';
  /**
   * Video bit depth
   */
  video_bit_depth?: 8 | 10 | 12;
  /**
   * GOP/keyframe interval in seconds
   */
  gop_interval_seconds?: number;
  /**
   * GOP structure type
   */
  gop_type?: 'closed' | 'open';
  /**
   * Position of moov atom in MP4 container
   */
  moov_atom_position?: 'start' | 'end';
  /**
   * Whether the video contains an audio track
   */
  has_audio?: boolean;
  /**
   * Audio codec used (aac, aac_lc, he_aac, pcm, mp3, ac3, eac3, etc.)
   */
  audio_codec?: string;
  /**
   * Audio sampling rate in Hz (e.g., 44100, 48000)
   */
  audio_sampling_rate_hz?: number;
  /**
   * Audio channel configuration
   */
  audio_channels?: 'mono' | 'stereo' | '5.1' | '7.1';
  /**
   * Audio bit depth
   */
  audio_bit_depth?: 16 | 24 | 32;
  /**
   * Audio bitrate in kilobits per second
   */
  audio_bitrate_kbps?: number;
  /**
   * Integrated loudness in LUFS
   */
  audio_loudness_lufs?: number;
  /**
   * True peak level in dBFS
   */
  audio_true_peak_dbfs?: number;
  /**
   * URL to captions file (WebVTT, SRT, etc.)
   */
  captions_url?: string;
  /**
   * URL to text transcript of the video content
   */
  transcript_url?: string;
  /**
   * URL to audio description track for visually impaired users
   */
  audio_description_url?: string;
  [k: string]: unknown | undefined;
}
/**
 * Audio asset with URL and technical specifications
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
   * File size in bytes
   */
  file_size_bytes?: number;
  /**
   * Audio container/file format (mp3, m4a, aac, wav, ogg, flac, etc.)
   */
  container_format?: string;
  /**
   * Audio codec used (aac, aac_lc, he_aac, pcm, mp3, vorbis, opus, flac, ac3, eac3, etc.)
   */
  codec?: string;
  /**
   * Sampling rate in Hz (e.g., 44100, 48000, 96000)
   */
  sampling_rate_hz?: number;
  /**
   * Channel configuration
   */
  channels?: 'mono' | 'stereo' | '5.1' | '7.1';
  /**
   * Bit depth
   */
  bit_depth?: 16 | 24 | 32;
  /**
   * Bitrate in kilobits per second
   */
  bitrate_kbps?: number;
  /**
   * Integrated loudness in LUFS
   */
  loudness_lufs?: number;
  /**
   * True peak level in dBFS
   */
  true_peak_dbfs?: number;
  /**
   * URL to text transcript of the audio content
   */
  transcript_url?: string;
  [k: string]: unknown | undefined;
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
  [k: string]: unknown | undefined;
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
  /**
   * Self-declared accessibility properties for this opaque creative
   */
  accessibility?: {
    /**
     * Text alternative describing the creative content
     */
    alt_text?: string;
    /**
     * Whether the creative can be fully operated via keyboard
     */
    keyboard_navigable?: boolean;
    /**
     * Whether the creative respects prefers-reduced-motion or provides pause/stop controls
     */
    motion_control?: boolean;
    /**
     * Whether the creative has been tested with screen readers
     */
    screen_reader_tested?: boolean;
  };
  [k: string]: unknown | undefined;
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
  [k: string]: unknown | undefined;
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
  /**
   * Self-declared accessibility properties for this opaque creative
   */
  accessibility?: {
    /**
     * Text alternative describing the creative content
     */
    alt_text?: string;
    /**
     * Whether the creative can be fully operated via keyboard
     */
    keyboard_navigable?: boolean;
    /**
     * Whether the creative respects prefers-reduced-motion or provides pause/stop controls
     */
    motion_control?: boolean;
    /**
     * Whether the creative has been tested with screen readers
     */
    screen_reader_tested?: boolean;
  };
  [k: string]: unknown | undefined;
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
  [k: string]: unknown | undefined;
}

// PRODUCT SCHEMA
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
      [k: string]: unknown | undefined;
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
      [k: string]: unknown | undefined;
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
      [k: string]: unknown | undefined;
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
 * Standardized advertising media channels describing how buyers allocate budget. Channels are planning abstractions, not technical substrates. See the Media Channel Taxonomy specification for detailed definitions.
 */
export type MediaChannel =
  | 'display'
  | 'olv'
  | 'social'
  | 'search'
  | 'ctv'
  | 'linear_tv'
  | 'radio'
  | 'streaming_audio'
  | 'podcast'
  | 'dooh'
  | 'ooh'
  | 'print'
  | 'cinema'
  | 'email'
  | 'gaming'
  | 'retail_media'
  | 'influencer'
  | 'affiliate'
  | 'product_placement';
/**
 * Type of inventory delivery
 */
export type DeliveryType = 'guaranteed' | 'non_guaranteed';
/**
 * A pricing model option offered by a publisher for a product. Discriminated by pricing_model field. If fixed_price is present, it's fixed pricing. If absent, it's auction-based (floor_price and price_guidance optional).
 */
export type PricingOption =
  | CPMPricingOption
  | VCPMPricingOption
  | CPCPricingOption
  | CPCVPricingOption
  | CPVPricingOption
  | CPPPricingOption
  | CPAPricingOption
  | FlatRatePricingOption
  | TimeBasedPricingOption;
/**
 * Measurement system for the demographic field. Defaults to nielsen when omitted.
 */
export type DemographicSystem = 'nielsen' | 'barb' | 'agf' | 'oztam' | 'mediametrie' | 'custom';
/**
 * Standard marketing event types for event logging, aligned with IAB ECAPI
 */
export type ForecastRangeUnit = 'spend' | 'reach_freq' | 'weekly' | 'daily' | 'clicks' | 'conversions';
/**
 * Method used to produce this forecast
 */
export type ForecastMethod = 'estimate' | 'modeled' | 'guaranteed';
/**
 * Measurement system for the demographic field. Ensures buyer and seller agree on demographic notation.
 */
export type ReachUnit = 'individuals' | 'households' | 'devices' | 'accounts' | 'cookies' | 'custom';
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
  | 'conversion_value'
  | 'roas'
  | 'cost_per_acquisition'
  | 'new_to_brand_rate'
  | 'viewability'
  | 'engagement_rate'
  | 'views'
  | 'completed_views'
  | 'leads'
  | 'reach'
  | 'frequency'
  | 'grps'
  | 'quartile_data'
  | 'dooh_metrics'
  | 'cost_per_click';
/**
 * Co-branding requirement
 */
export type CoBrandingRequirement = 'required' | 'optional' | 'none';
/**
 * Landing page requirements
 */
export type LandingPageRequirement = 'any' | 'retailer_site_only' | 'must_include_retailer';
/**
 * Selects signals from a data provider's adagents.json catalog. Used for product definitions and agent authorization. Supports three selection patterns: all signals, specific IDs, or by tags.
 */
export type DataProviderSignalSelector =
  | {
      /**
       * Domain where data provider's adagents.json is hosted (e.g., 'polk.com')
       */
      data_provider_domain: string;
      /**
       * Discriminator indicating all signals from this data provider are included
       */
      selection_type: 'all';
      [k: string]: unknown | undefined;
    }
  | {
      /**
       * Domain where data provider's adagents.json is hosted (e.g., 'polk.com')
       */
      data_provider_domain: string;
      /**
       * Discriminator indicating selection by specific signal IDs
       */
      selection_type: 'by_id';
      /**
       * Specific signal IDs from the data provider's catalog
       *
       * @minItems 1
       */
      signal_ids: [string, ...string[]];
      [k: string]: unknown | undefined;
    }
  | {
      /**
       * Domain where data provider's adagents.json is hosted (e.g., 'polk.com')
       */
      data_provider_domain: string;
      /**
       * Discriminator indicating selection by signal tags
       */
      selection_type: 'by_tag';
      /**
       * Signal tags from the data provider's catalog. Selector covers all signals with these tags
       *
       * @minItems 1
       */
      signal_tags: [string, ...string[]];
      [k: string]: unknown | undefined;
    };
/**
 * The type of catalog feed. Determines the item schema and how the platform resolves catalog items. Multiple catalog types can be synced to the same account and referenced together in creatives.
 */
export type ActionSource =
  | 'website'
  | 'app'
  | 'offline'
  | 'phone_call'
  | 'chat'
  | 'email'
  | 'in_store'
  | 'system_generated'
  | 'other';

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
   */
  publisher_properties: PublisherPropertySelector[];
  /**
   * Advertising channels this product is sold as. Products inherit from their properties' supported_channels but may narrow the scope. For example, a product covering YouTube properties might be sold as ['ctv'] even though those properties support ['olv', 'social', 'ctv'].
   */
  channels?: MediaChannel[];
  /**
   * Array of supported creative format IDs - structured format_id objects with agent_url and id
   */
  format_ids: FormatID[];
  /**
   * Optional array of specific placements within this product. When provided, buyers can target specific placements when assigning creatives.
   */
  placements?: Placement[];
  delivery_type: DeliveryType;
  /**
   * Available pricing models for this product
   */
  pricing_options: PricingOption[];
  forecast?: DeliveryForecast;
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
   * Whether buyers can filter this product to a subset of its publisher_properties. When false (default), the product is 'all or nothing' - buyers must accept all properties or the product is excluded from property_list filtering results.
   */
  property_targeting_allowed?: boolean;
  /**
   * Data provider signals available for this product. Buyers fetch signal definitions from each data provider's adagents.json and can verify agent authorization.
   */
  data_provider_signals?: DataProviderSignalSelector[];
  /**
   * Whether buyers can filter this product to a subset of its data_provider_signals. When false (default), the product includes all listed signals as a bundle. When true, buyers can target specific signals.
   */
  signal_targeting_allowed?: boolean;
  /**
   * Catalog types this product supports for catalog-driven campaigns. A sponsored product listing declares ["product"], a job board declares ["job", "offering"]. Buyers match synced catalogs to products via this field.
   */
  catalog_types?: CatalogType[];
  /**
   * Conversion tracking for this product. Presence indicates the product supports conversion-optimized delivery. Seller-level capabilities (supported event types, UID types, attribution windows) are declared in get_adcp_capabilities.
   */
  conversion_tracking?: {
    /**
     * Action sources relevant to this product (e.g. a retail media product might have 'in_store' and 'website', while a display product might only have 'website')
     */
    action_sources?: ActionSource[];
    /**
     * Optimization strategies this product supports when an optimization_goal is set on a package
     */
    supported_optimization_strategies?: ('maximize_conversions' | 'target_cpa' | 'target_roas')[];
    /**
     * Whether the seller provides its own always-on measurement (e.g. Amazon sales attribution for Amazon advertisers). When true, sync_event_sources response will include seller-managed event sources with managed_by='seller'.
     */
    platform_managed?: boolean;
  };
  /**
   * When the buyer provides a catalog on get_products, indicates which catalog items are eligible for this product. Only present for products where catalog matching is relevant (e.g., sponsored product listings, job boards, hotel ads).
   */
  catalog_match?: {
    /**
     * GTINs from the buyer's catalog that are eligible on this product's inventory. Standard GTIN formats (GTIN-8 through GTIN-14). Only present for product-type catalogs with GTIN matching.
     */
    matched_gtins?: string[];
    /**
     * Item IDs from the buyer's catalog that matched this product's inventory. The ID type depends on the catalog type and content_id_type (e.g., SKUs for product catalogs, job_ids for job catalogs, offering_ids for offering catalogs).
     */
    matched_ids?: string[];
    /**
     * Number of catalog items that matched this product's inventory.
     */
    matched_count?: number;
    /**
     * Total catalog items evaluated from the buyer's catalog.
     */
    submitted_count: number;
  };
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
    format_id: FormatID;
    /**
     * Asset manifest for rendering the card, structure defined by the format
     */
    manifest: {};
  };
  /**
   * Optional detailed card with carousel and full specifications. Provides rich product presentation similar to media kit pages.
   */
  product_card_detailed?: {
    format_id: FormatID;
    /**
     * Asset manifest for rendering the detailed card, structure defined by the format
     */
    manifest: {};
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
  [k: string]: unknown | undefined;
}
/**
 * Cost Per Mille (cost per 1,000 impressions) pricing. If fixed_price is present, it's fixed pricing. If absent, it's auction-based.
 */
export interface CPMPricingOption {
  /**
   * Unique identifier for this pricing option within the product
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
   * Fixed price per unit. If present, this is fixed pricing. If absent, auction-based.
   */
  fixed_price?: number;
  /**
   * Minimum acceptable bid for auction pricing (mutually exclusive with fixed_price). Bids below this value will be rejected.
   */
  floor_price?: number;
  price_guidance?: PriceGuidance;
  /**
   * Minimum spend requirement per package using this pricing option, in the specified currency
   */
  min_spend_per_package?: number;
  [k: string]: unknown | undefined;
}
/**
 * Optional pricing guidance for auction-based bidding
 */
export interface PriceGuidance {
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
  [k: string]: unknown | undefined;
}
/**
 * Viewable Cost Per Mille (cost per 1,000 viewable impressions) pricing - MRC viewability standard. If fixed_price is present, it's fixed pricing. If absent, it's auction-based.
 */
export interface VCPMPricingOption {
  /**
   * Unique identifier for this pricing option within the product
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
   * Fixed price per unit. If present, this is fixed pricing. If absent, auction-based.
   */
  fixed_price?: number;
  /**
   * Minimum acceptable bid for auction pricing (mutually exclusive with fixed_price). Bids below this value will be rejected.
   */
  floor_price?: number;
  price_guidance?: PriceGuidance;
  /**
   * Minimum spend requirement per package using this pricing option, in the specified currency
   */
  min_spend_per_package?: number;
  [k: string]: unknown | undefined;
}
/**
 * Optional pricing guidance for auction-based bidding
 */
export interface CPCPricingOption {
  /**
   * Unique identifier for this pricing option within the product
   */
  pricing_option_id: string;
  /**
   * Cost per click
   */
  pricing_model: 'cpc';
  /**
   * ISO 4217 currency code
   */
  currency: string;
  /**
   * Fixed price per click. If present, this is fixed pricing. If absent, auction-based.
   */
  fixed_price?: number;
  /**
   * Minimum acceptable bid for auction pricing (mutually exclusive with fixed_price). Bids below this value will be rejected.
   */
  floor_price?: number;
  price_guidance?: PriceGuidance;
  /**
   * Minimum spend requirement per package using this pricing option, in the specified currency
   */
  min_spend_per_package?: number;
  [k: string]: unknown | undefined;
}
/**
 * Optional pricing guidance for auction-based bidding
 */
export interface CPCVPricingOption {
  /**
   * Unique identifier for this pricing option within the product
   */
  pricing_option_id: string;
  /**
   * Cost per completed view (100% completion)
   */
  pricing_model: 'cpcv';
  /**
   * ISO 4217 currency code
   */
  currency: string;
  /**
   * Fixed price per completed view. If present, this is fixed pricing. If absent, auction-based.
   */
  fixed_price?: number;
  /**
   * Minimum acceptable bid for auction pricing (mutually exclusive with fixed_price). Bids below this value will be rejected.
   */
  floor_price?: number;
  price_guidance?: PriceGuidance;
  /**
   * Minimum spend requirement per package using this pricing option, in the specified currency
   */
  min_spend_per_package?: number;
  [k: string]: unknown | undefined;
}
/**
 * Optional pricing guidance for auction-based bidding
 */
export interface CPVPricingOption {
  /**
   * Unique identifier for this pricing option within the product
   */
  pricing_option_id: string;
  /**
   * Cost per view at threshold
   */
  pricing_model: 'cpv';
  /**
   * ISO 4217 currency code
   */
  currency: string;
  /**
   * Fixed price per view. If present, this is fixed pricing. If absent, auction-based.
   */
  fixed_price?: number;
  /**
   * Minimum acceptable bid for auction pricing (mutually exclusive with fixed_price). Bids below this value will be rejected.
   */
  floor_price?: number;
  price_guidance?: PriceGuidance;
  /**
   * CPV-specific parameters defining the view threshold
   */
  parameters: {
    view_threshold:
      | number
      | {
          /**
           * Seconds of viewing required
           */
          duration_seconds: number;
          [k: string]: unknown | undefined;
        };
    [k: string]: unknown | undefined;
  };
  /**
   * Minimum spend requirement per package using this pricing option, in the specified currency
   */
  min_spend_per_package?: number;
  [k: string]: unknown | undefined;
}
/**
 * Optional pricing guidance for auction-based bidding
 */
export interface CPPPricingOption {
  /**
   * Unique identifier for this pricing option within the product
   */
  pricing_option_id: string;
  /**
   * Cost per Gross Rating Point
   */
  pricing_model: 'cpp';
  /**
   * ISO 4217 currency code
   */
  currency: string;
  /**
   * Fixed price per rating point. If present, this is fixed pricing. If absent, auction-based.
   */
  fixed_price?: number;
  /**
   * Minimum acceptable bid for auction pricing (mutually exclusive with fixed_price). Bids below this value will be rejected.
   */
  floor_price?: number;
  price_guidance?: PriceGuidance;
  /**
   * CPP-specific parameters for demographic targeting
   */
  parameters: {
    demographic_system?: DemographicSystem;
    /**
     * Target demographic code within the specified demographic_system (e.g., P18-49 for Nielsen, ABC1 Adults for BARB)
     */
    demographic: string;
    /**
     * Minimum GRPs/TRPs required
     */
    min_points?: number;
    [k: string]: unknown | undefined;
  };
  /**
   * Minimum spend requirement per package using this pricing option, in the specified currency
   */
  min_spend_per_package?: number;
  [k: string]: unknown | undefined;
}
/**
 * Optional pricing guidance for auction-based bidding
 */
export interface CPAPricingOption {
  /**
   * Unique identifier for this pricing option within the product
   */
  pricing_option_id: string;
  /**
   * Cost per acquisition (conversion event)
   */
  pricing_model: 'cpa';
  /**
   * The conversion event type that triggers billing (e.g., purchase, lead, app_install)
   */
  event_type: EventType;
  /**
   * Name of the custom event when event_type is 'custom'. Required when event_type is 'custom', ignored otherwise.
   */
  custom_event_name?: string;
  /**
   * When present, only events from this specific event source count toward billing. Allows different CPA rates for different sources (e.g., online vs in-store purchases). Must match an event source configured via sync_event_sources.
   */
  event_source_id?: string;
  /**
   * ISO 4217 currency code
   */
  currency: string;
  /**
   * Fixed price per acquisition in the specified currency
   */
  fixed_price: number;
  /**
   * Minimum spend requirement per package using this pricing option, in the specified currency
   */
  min_spend_per_package?: number;
  [k: string]: unknown | undefined;
}
/**
 * Flat rate pricing for DOOH, sponsorships, and time-based campaigns. If fixed_price is present, it's fixed pricing. If absent, it's auction-based.
 */
export interface FlatRatePricingOption {
  /**
   * Unique identifier for this pricing option within the product
   */
  pricing_option_id: string;
  /**
   * Fixed cost regardless of delivery volume
   */
  pricing_model: 'flat_rate';
  /**
   * ISO 4217 currency code
   */
  currency: string;
  /**
   * Flat rate cost. If present, this is fixed pricing. If absent, auction-based.
   */
  fixed_price?: number;
  /**
   * Minimum acceptable bid for auction pricing (mutually exclusive with fixed_price). Bids below this value will be rejected.
   */
  floor_price?: number;
  price_guidance?: PriceGuidance;
  /**
   * Flat rate parameters for DOOH and time-based campaigns
   */
  parameters?: {
    /**
     * Duration in hours for time-based pricing
     */
    duration_hours?: number;
    /**
     * Guaranteed share of voice (0-100)
     */
    sov_percentage?: number;
    /**
     * Duration of ad loop rotation in seconds
     */
    loop_duration_seconds?: number;
    /**
     * Minimum plays per hour
     */
    min_plays_per_hour?: number;
    /**
     * Named venue package identifier
     */
    venue_package?: string;
    /**
     * Estimated impressions (informational)
     */
    estimated_impressions?: number;
    /**
     * Specific daypart for time-based pricing
     */
    daypart?: string;
    [k: string]: unknown | undefined;
  };
  /**
   * Minimum spend requirement per package using this pricing option, in the specified currency
   */
  min_spend_per_package?: number;
  [k: string]: unknown | undefined;
}
/**
 * Optional pricing guidance for auction-based bidding
 */
export interface TimeBasedPricingOption {
  /**
   * Unique identifier for this pricing option within the product
   */
  pricing_option_id: string;
  /**
   * Cost per time unit - rate scales with campaign duration
   */
  pricing_model: 'time';
  /**
   * ISO 4217 currency code
   */
  currency: string;
  /**
   * Cost per time unit. If present, this is fixed pricing. If absent, auction-based.
   */
  fixed_price?: number;
  /**
   * Minimum acceptable bid per time unit for auction pricing (mutually exclusive with fixed_price). Bids below this value will be rejected.
   */
  floor_price?: number;
  price_guidance?: PriceGuidance;
  /**
   * Time-based pricing parameters
   */
  parameters: {
    /**
     * The time unit for pricing. Total cost = fixed_price × number of time_units in the campaign flight.
     */
    time_unit: 'hour' | 'day' | 'week' | 'month';
    /**
     * Minimum booking duration in time_units
     */
    min_duration?: number;
    /**
     * Maximum booking duration in time_units. Must be >= min_duration when both are present.
     */
    max_duration?: number;
    [k: string]: unknown | undefined;
  };
  /**
   * Minimum spend requirement per package using this pricing option, in the specified currency
   */
  min_spend_per_package?: number;
  [k: string]: unknown | undefined;
}
/**
 * Optional pricing guidance for auction-based bidding
 */
export interface DeliveryForecast {
  /**
   * Forecasted delivery at one or more budget levels. A single point is a standard forecast; multiple points ordered by ascending budget form a curve showing how metrics scale with spend. Each point pairs a budget with metric ranges.
   *
   * @minItems 1
   */
  points: [ForecastPoint, ...ForecastPoint[]];
  forecast_range_unit?: ForecastRangeUnit;
  method: ForecastMethod;
  /**
   * ISO 4217 currency code for monetary values in this forecast (spend, budget)
   */
  currency: string;
  demographic_system?: DemographicSystem;
  /**
   * Target demographic code within the specified demographic_system. For Nielsen: P18-49, M25-54, W35+. For BARB: ABC1 Adults, 16-34. For AGF: E 14-49.
   */
  demographic?: string;
  reach_unit?: ReachUnit;
  /**
   * When this forecast was computed
   */
  generated_at?: string;
  /**
   * When this forecast expires. After this time, the forecast should be refreshed. Forecast expiry does not affect proposal executability.
   */
  valid_until?: string;
  ext?: ExtensionObject;
  [k: string]: unknown | undefined;
}
/**
 * A forecast at a specific budget level. A single point represents a standard forecast; multiple points ordered by ascending budget form a curve showing how delivery metrics scale with spend.
 */
export interface ForecastPoint {
  /**
   * Budget amount for this forecast point. For allocation-level forecasts, this is the absolute budget for that allocation (not the percentage). For proposal-level forecasts, this is the total proposal budget.
   */
  budget: number;
  /**
   * Forecasted metric values at this budget level. Keys are either forecastable-metric values for delivery/engagement (impressions, reach, spend, etc.) or event-type values for outcomes (purchase, lead, app_install, etc.). Values are ForecastRange objects (low/mid/high). Use { "mid": value } for point estimates. Include spend when the platform predicts it will differ from budget.
   */
  metrics: {
    [k: string]: ForecastRange | undefined;
  };
  [k: string]: unknown | undefined;
}
/**
 * A forecast value with optional low/high bounds. The mid value represents the most likely outcome. When low and high are provided, they represent conservative and optimistic estimates respectively.
 */
export interface ForecastRange {
  /**
   * Conservative (low-end) forecast value
   */
  low?: number;
  /**
   * Expected (most likely) forecast value
   */
  mid: number;
  /**
   * Optimistic (high-end) forecast value
   */
  high?: number;
  [k: string]: unknown | undefined;
}
/**
 * Extension object for platform-specific, vendor-namespaced parameters. Extensions are always optional and must be namespaced under a vendor/platform key (e.g., ext.gam, ext.roku). Used for custom capabilities, partner-specific configuration, and features being proposed for standardization.
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
  [k: string]: unknown | undefined;
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
   * Metrics available in reporting. Impressions and spend are always implicitly included. When a creative format declares reported_metrics, buyers receive the intersection of these product-level metrics and the format's reported_metrics.
   */
  available_metrics: AvailableMetric[];
  /**
   * Whether this product supports creative-level metric breakdowns in delivery reporting (by_creative within by_package)
   */
  supports_creative_breakdown?: boolean;
  /**
   * Whether delivery data can be filtered to arbitrary date ranges. 'date_range' means the platform supports start_date/end_date parameters. 'lifetime_only' means the platform returns campaign lifetime totals and date range parameters are not accepted.
   */
  date_range_support: 'date_range' | 'lifetime_only';
  [k: string]: unknown | undefined;
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
  [k: string]: unknown | undefined;
}
/**
 * Structured format identifier with agent URL and format name. Can reference: (1) a concrete format with fixed dimensions (id only), (2) a template format without parameters (id only), or (3) a template format with parameters (id + dimensions/duration). Template formats accept parameters in format_id while concrete formats have fixed dimensions in their definition. Parameterized format IDs create unique, specific format variants.
 */
export type PropertyType =
  | 'website'
  | 'mobile_app'
  | 'ctv_app'
  | 'desktop_app'
  | 'dooh'
  | 'podcast'
  | 'radio'
  | 'streaming_audio';
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
 * Tag for categorizing publisher properties. Must be lowercase alphanumeric with underscores only.
 */
export interface Property {
  property_id?: PropertyID;
  property_type: PropertyType;
  /**
   * Human-readable property name
   */
  name: string;
  /**
   * Array of identifiers for this property
   */
  identifiers: {
    type: PropertyIdentifierTypes;
    /**
     * The identifier value. For domain type: 'example.com' matches base domain plus www and m subdomains; 'edition.example.com' matches that specific subdomain; '*.example.com' matches ALL subdomains but NOT base domain
     */
    value: string;
  }[];
  /**
   * Tags for categorization and grouping (e.g., network membership, content categories)
   */
  tags?: PropertyTag[];
  /**
   * Advertising channels this property supports (e.g., ['display', 'olv', 'social']). Publishers declare which channels their inventory aligns with. Properties may support multiple channels. See the Media Channel Taxonomy for definitions.
   */
  supported_channels?: MediaChannel[];
  /**
   * Domain where adagents.json should be checked for authorization validation. Optional in adagents.json (file location implies domain).
   */
  publisher_domain?: string;
}

// MCP-WEBHOOK-PAYLOAD SCHEMA
/**
 * Type of AdCP operation that triggered this webhook. Enables webhook handlers to route to appropriate processing logic.
 */
export type TaskType =
  | 'create_media_buy'
  | 'update_media_buy'
  | 'sync_creatives'
  | 'activate_signal'
  | 'get_signals'
  | 'create_property_list'
  | 'update_property_list'
  | 'get_property_list'
  | 'list_property_lists'
  | 'delete_property_list'
  | 'sync_accounts'
  | 'get_creative_delivery'
  | 'sync_event_sources'
  | 'sync_audiences'
  | 'sync_catalogs'
  | 'log_event';
/**
 * AdCP domain this task belongs to. Helps classify the operation type at a high level.
 */
export type AdCPDomain = 'media-buy' | 'signals' | 'governance' | 'creative';
/**
 * Current task status. Webhooks are triggered for status changes after initial submission.
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
 * Task-specific payload matching the status. For completed/failed, contains the full task response. For working/input-required/submitted, contains status-specific data. This is the data layer that AdCP specs - same structure used in A2A status.message.parts[].data.
 */
export type AdCPAsyncResponseData =
  | GetProductsResponse
  | GetProductsAsyncWorking
  | GetProductsAsyncInputRequired
  | GetProductsAsyncSubmitted
  | CreateMediaBuyResponse
  | CreateMediaBuyAsyncWorking
  | CreateMediaBuyAsyncInputRequired
  | CreateMediaBuyAsyncSubmitted
  | UpdateMediaBuyResponse
  | UpdateMediaBuyAsyncWorking
  | UpdateMediaBuyAsyncInputRequired
  | UpdateMediaBuyAsyncSubmitted
  | SyncCreativesResponse
  | SyncCreativesAsyncWorking
  | SyncCreativesAsyncInputRequired
  | SyncCreativesAsyncSubmitted
  | SyncCatalogsResponse
  | SyncCatalogsAsyncWorking
  | SyncCatalogsAsyncInputRequired
  | SyncCatalogsAsyncSubmitted;
/**
 * Selects properties from a publisher's adagents.json. Used for both product definitions and agent authorization. Supports three selection patterns: all properties, specific IDs, or by tags.
 */
export type CreateMediaBuyResponse = CreateMediaBuySuccess | CreateMediaBuyError;
/**
 * Budget pacing strategy
 */
export type UpdateMediaBuyResponse = UpdateMediaBuySuccess | UpdateMediaBuyError;
/**
 * Response for completed or failed sync_creatives
 */
export type SyncCreativesResponse = SyncCreativesSuccess | SyncCreativesError;
/**
 * Action taken for this creative
 */
export type CreativeAction = 'created' | 'updated' | 'unchanged' | 'failed' | 'deleted';
/**
 * Response for completed or failed sync_catalogs
 */
export type SyncCatalogsResponse = SyncCatalogsSuccess | SyncCatalogsError;
/**
 * Action taken for this catalog
 */
export type CatalogAction = 'created' | 'updated' | 'unchanged' | 'failed' | 'deleted';
/**
 * Item review status
 */
export type CatalogItemStatus = 'approved' | 'pending' | 'rejected' | 'warning';

/**
 * Standard envelope for HTTP-based push notifications (MCP). This defines the wire format sent to the URL configured in `pushNotificationConfig`. NOTE: This envelope is NOT used in A2A integration, which uses native Task/TaskStatusUpdateEvent messages with the AdCP payload nested in `status.message.parts[].data`.
 */
export interface MCPWebhookPayload {
  /**
   * Publisher-defined operation identifier correlating a sequence of task updates across webhooks.
   */
  operation_id?: string;
  /**
   * Unique identifier for this task. Use this to correlate webhook notifications with the original task submission.
   */
  task_id: string;
  task_type: TaskType;
  domain?: AdCPDomain;
  status: TaskStatus;
  /**
   * ISO 8601 timestamp when this webhook was generated.
   */
  timestamp: string;
  /**
   * Human-readable summary of the current task state. Provides context about what happened and what action may be needed.
   */
  message?: string;
  /**
   * Session/conversation identifier. Use this to continue the conversation if input-required status needs clarification or additional parameters.
   */
  context_id?: string;
  result?: AdCPAsyncResponseData;
}
/**
 * Response for completed or failed get_products
 */
export interface GetProductsResponse {
  /**
   * Array of matching products
   */
  products: Product[];
  /**
   * Optional array of proposed media plans with budget allocations across products. Publishers include proposals when they can provide strategic guidance based on the brief. Proposals are actionable - buyers can refine them via follow-up get_products calls within the same session, or execute them directly via create_media_buy.
   */
  proposals?: Proposal[];
  /**
   * Task-specific errors and warnings (e.g., product filtering issues)
   */
  errors?: Error[];
  /**
   * [AdCP 3.0] Indicates whether property_list filtering was applied. True if the agent filtered products based on the provided property_list. Absent or false if property_list was not provided or not supported by this agent.
   */
  property_list_applied?: boolean;
  /**
   * Whether the seller filtered results based on the provided catalog. True if the seller matched catalog items against its inventory. Absent or false if no catalog was provided or the seller does not support catalog matching.
   */
  catalog_applied?: boolean;
  pagination?: PaginationResponse;
  /**
   * When true, this response contains simulated data from sandbox mode.
   */
  sandbox?: boolean;
  context?: ContextObject;
  ext?: ExtensionObject;
  [k: string]: unknown | undefined;
}
/**
 * Represents available advertising inventory
 */
export interface Proposal {
  /**
   * Unique identifier for this proposal. Used to execute it via create_media_buy.
   */
  proposal_id: string;
  /**
   * Human-readable name for this media plan proposal
   */
  name: string;
  /**
   * Explanation of the proposal strategy and what it achieves
   */
  description?: string;
  /**
   * Budget allocations across products. Allocation percentages MUST sum to 100. Publishers are responsible for ensuring the sum equals 100; buyers SHOULD validate this before execution.
   *
   * @minItems 1
   */
  allocations: [ProductAllocation, ...ProductAllocation[]];
  /**
   * When this proposal expires and can no longer be executed. After expiration, referenced products or pricing may no longer be available.
   */
  expires_at?: string;
  /**
   * Optional budget guidance for this proposal
   */
  total_budget_guidance?: {
    /**
     * Minimum recommended budget
     */
    min?: number;
    /**
     * Recommended budget for optimal performance
     */
    recommended?: number;
    /**
     * Maximum budget before diminishing returns
     */
    max?: number;
    /**
     * ISO 4217 currency code
     */
    currency?: string;
    [k: string]: unknown | undefined;
  };
  /**
   * Explanation of how this proposal aligns with the campaign brief
   */
  brief_alignment?: string;
  forecast?: DeliveryForecast;
  ext?: ExtensionObject;
  [k: string]: unknown | undefined;
}
/**
 * A budget allocation for a specific product within a proposal. Percentages across all allocations in a proposal should sum to 100.
 */
export interface ProductAllocation {
  /**
   * ID of the product (must reference a product in the products array)
   */
  product_id: string;
  /**
   * Percentage of total budget allocated to this product (0-100)
   */
  allocation_percentage: number;
  /**
   * Recommended pricing option ID from the product's pricing_options array
   */
  pricing_option_id?: string;
  /**
   * Explanation of why this product and allocation are recommended
   */
  rationale?: string;
  /**
   * Optional ordering hint for multi-line-item plans (1-based)
   */
  sequence?: number;
  /**
   * Categorical tags for this allocation (e.g., 'desktop', 'german', 'mobile') - useful for grouping/filtering allocations by dimension
   */
  tags?: string[];
  /**
   * Recommended time windows for this allocation in spot-plan proposals.
   *
   * @minItems 1
   */
  daypart_targets?: [DaypartTarget, ...DaypartTarget[]];
  forecast?: DeliveryForecast;
  ext?: ExtensionObject;
  [k: string]: unknown | undefined;
}
/**
 * A time window for daypart targeting. Specifies days of week and an hour range. start_hour is inclusive, end_hour is exclusive (e.g., 6-10 = 6:00am to 10:00am). Follows the Google Ads AdScheduleInfo / DV360 DayPartTargeting pattern.
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
    [k: string]: unknown | undefined;
  };
  [k: string]: unknown | undefined;
}
/**
 * Standard cursor-based pagination metadata for list responses
 */
export interface PaginationResponse {
  /**
   * Whether more results are available beyond this page
   */
  has_more: boolean;
  /**
   * Opaque cursor to pass in the next request to fetch the next page. Only present when has_more is true.
   */
  cursor?: string;
  /**
   * Total number of items matching the query across all pages. Optional because not all backends can efficiently compute this.
   */
  total_count?: number;
}
/**
 * Opaque correlation data that is echoed unchanged in responses. Used for internal tracking, UI session IDs, trace IDs, and other caller-specific identifiers that don't affect protocol behavior. Context data is never parsed by AdCP agents - it's simply preserved and returned.
 */
export interface ContextObject {
  [k: string]: unknown | undefined;
}
/**
 * Progress data for working get_products
 */
export interface GetProductsAsyncWorking {
  /**
   * Progress percentage of the search operation
   */
  percentage?: number;
  /**
   * Current step in the search process (e.g., 'searching_inventory', 'validating_availability')
   */
  current_step?: string;
  /**
   * Total number of steps in the search process
   */
  total_steps?: number;
  /**
   * Current step number (1-indexed)
   */
  step_number?: number;
  context?: ContextObject;
  ext?: ExtensionObject;
  [k: string]: unknown | undefined;
}
/**
 * Input requirements for get_products needing clarification
 */
export interface GetProductsAsyncInputRequired {
  /**
   * Reason code indicating why input is needed
   */
  reason?: 'CLARIFICATION_NEEDED' | 'BUDGET_REQUIRED';
  /**
   * Partial product results that may help inform the clarification
   */
  partial_results?: Product[];
  /**
   * Suggested values or options for the required input
   */
  suggestions?: string[];
  context?: ContextObject;
  ext?: ExtensionObject;
  [k: string]: unknown | undefined;
}
/**
 * Acknowledgment for submitted get_products (custom curation)
 */
export interface GetProductsAsyncSubmitted {
  /**
   * Estimated completion time for the search
   */
  estimated_completion?: string;
  context?: ContextObject;
  ext?: ExtensionObject;
  [k: string]: unknown | undefined;
}
/**
 * Success response - media buy created successfully
 */
export interface CreateMediaBuySuccess {
  /**
   * Publisher's unique identifier for the created media buy
   */
  media_buy_id: string;
  /**
   * Buyer's reference identifier for this media buy
   */
  buyer_ref: string;
  /**
   * Buyer's campaign reference label, echoed from the request
   */
  campaign_ref?: string;
  account?: Account;
  /**
   * ISO 8601 timestamp for creative upload deadline
   */
  creative_deadline?: string;
  /**
   * Array of created packages with complete state information
   */
  packages: Package[];
  /**
   * When true, this response contains simulated data from sandbox mode.
   */
  sandbox?: boolean;
  context?: ContextObject;
  ext?: ExtensionObject;
  [k: string]: unknown | undefined;
}
/**
 * Account billed for this media buy. Includes advertiser, billing proxy (if any), and rate card applied.
 */
export interface CreateMediaBuyError {
  /**
   * Array of errors explaining why the operation failed
   *
   * @minItems 1
   */
  errors: [Error, ...Error[]];
  context?: ContextObject;
  ext?: ExtensionObject;
  [k: string]: unknown | undefined;
}
/**
 * Progress data for working create_media_buy
 */
export interface CreateMediaBuyAsyncWorking {
  /**
   * Completion percentage (0-100)
   */
  percentage?: number;
  /**
   * Current step or phase of the operation
   */
  current_step?: string;
  /**
   * Total number of steps in the operation
   */
  total_steps?: number;
  /**
   * Current step number
   */
  step_number?: number;
  context?: ContextObject;
  ext?: ExtensionObject;
  [k: string]: unknown | undefined;
}
/**
 * Input requirements for create_media_buy needing user input
 */
export interface CreateMediaBuyAsyncInputRequired {
  /**
   * Reason code indicating why input is needed
   */
  reason?: 'APPROVAL_REQUIRED' | 'BUDGET_EXCEEDS_LIMIT';
  /**
   * Optional validation errors or warnings for debugging purposes. Helps explain why input is required.
   */
  errors?: Error[];
  context?: ContextObject;
  ext?: ExtensionObject;
  [k: string]: unknown | undefined;
}
/**
 * Acknowledgment for submitted create_media_buy
 */
export interface CreateMediaBuyAsyncSubmitted {
  context?: ContextObject;
  ext?: ExtensionObject;
  [k: string]: unknown | undefined;
}
/**
 * Success response - media buy updated successfully
 */
export interface UpdateMediaBuySuccess {
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
  /**
   * When true, this response contains simulated data from sandbox mode.
   */
  sandbox?: boolean;
  context?: ContextObject;
  ext?: ExtensionObject;
  [k: string]: unknown | undefined;
}
/**
 * Error response - operation failed, no changes applied
 */
export interface UpdateMediaBuyError {
  /**
   * Array of errors explaining why the operation failed
   *
   * @minItems 1
   */
  errors: [Error, ...Error[]];
  context?: ContextObject;
  ext?: ExtensionObject;
  [k: string]: unknown | undefined;
}
/**
 * Progress data for working update_media_buy
 */
export interface UpdateMediaBuyAsyncWorking {
  /**
   * Completion percentage (0-100)
   */
  percentage?: number;
  /**
   * Current step or phase of the operation
   */
  current_step?: string;
  /**
   * Total number of steps in the operation
   */
  total_steps?: number;
  /**
   * Current step number
   */
  step_number?: number;
  context?: ContextObject;
  ext?: ExtensionObject;
  [k: string]: unknown | undefined;
}
/**
 * Input requirements for update_media_buy needing user input
 */
export interface UpdateMediaBuyAsyncInputRequired {
  /**
   * Reason code indicating why input is needed
   */
  reason?: 'APPROVAL_REQUIRED' | 'CHANGE_CONFIRMATION';
  context?: ContextObject;
  ext?: ExtensionObject;
  [k: string]: unknown | undefined;
}
/**
 * Acknowledgment for submitted update_media_buy
 */
export interface UpdateMediaBuyAsyncSubmitted {
  context?: ContextObject;
  ext?: ExtensionObject;
  [k: string]: unknown | undefined;
}
/**
 * Success response - sync operation processed creatives (may include per-item failures)
 */
export interface SyncCreativesSuccess {
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
    account?: Account;
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
      [k: string]: unknown | undefined;
    };
    [k: string]: unknown | undefined;
  }[];
  /**
   * When true, this response contains simulated data from sandbox mode.
   */
  sandbox?: boolean;
  context?: ContextObject;
  ext?: ExtensionObject;
  [k: string]: unknown | undefined;
}
/**
 * Account that owns this creative
 */
export interface SyncCreativesError {
  /**
   * Operation-level errors that prevented processing any creatives (e.g., authentication failure, service unavailable, invalid request format)
   *
   * @minItems 1
   */
  errors: [Error, ...Error[]];
  context?: ContextObject;
  ext?: ExtensionObject;
  [k: string]: unknown | undefined;
}
/**
 * Progress data for working sync_creatives
 */
export interface SyncCreativesAsyncWorking {
  /**
   * Completion percentage (0-100)
   */
  percentage?: number;
  /**
   * Current step or phase of the operation
   */
  current_step?: string;
  /**
   * Total number of steps in the operation
   */
  total_steps?: number;
  /**
   * Current step number
   */
  step_number?: number;
  /**
   * Number of creatives processed so far
   */
  creatives_processed?: number;
  /**
   * Total number of creatives to process
   */
  creatives_total?: number;
  context?: ContextObject;
  ext?: ExtensionObject;
  [k: string]: unknown | undefined;
}
/**
 * Input requirements for sync_creatives needing user input
 */
export interface SyncCreativesAsyncInputRequired {
  /**
   * Reason code indicating why buyer input is needed
   */
  reason?: 'APPROVAL_REQUIRED' | 'ASSET_CONFIRMATION' | 'FORMAT_CLARIFICATION';
  context?: ContextObject;
  ext?: ExtensionObject;
  [k: string]: unknown | undefined;
}
/**
 * Acknowledgment for submitted sync_creatives
 */
export interface SyncCreativesAsyncSubmitted {
  context?: ContextObject;
  ext?: ExtensionObject;
  [k: string]: unknown | undefined;
}
/**
 * Success response - sync operation processed catalogs (may include per-catalog failures)
 */
export interface SyncCatalogsSuccess {
  /**
   * Whether this was a dry run (no actual changes made)
   */
  dry_run?: boolean;
  /**
   * Results for each catalog processed. Items with action='failed' indicate per-catalog validation/processing failures, not operation-level failures.
   */
  catalogs: {
    /**
     * Catalog ID from the request
     */
    catalog_id: string;
    action: CatalogAction;
    /**
     * Platform-specific ID assigned to the catalog
     */
    platform_id?: string;
    /**
     * Total number of items in the catalog after sync
     */
    item_count?: number;
    /**
     * Number of items approved by the platform. Populated when the platform performs item-level review.
     */
    items_approved?: number;
    /**
     * Number of items pending platform review. Common for product catalogs where items must pass content policy checks.
     */
    items_pending?: number;
    /**
     * Number of items rejected by the platform. Check item_issues for rejection reasons.
     */
    items_rejected?: number;
    /**
     * Per-item issues reported by the platform (rejections, warnings). Only present when the platform performs item-level review.
     */
    item_issues?: {
      /**
       * ID of the catalog item with an issue
       */
      item_id: string;
      status: CatalogItemStatus;
      /**
       * Reasons for rejection or warning
       */
      reasons?: string[];
      [k: string]: unknown | undefined;
    }[];
    /**
     * ISO 8601 timestamp of when the most recent sync was accepted by the platform
     */
    last_synced_at?: string;
    /**
     * ISO 8601 timestamp of when the platform will next fetch the feed URL. Only present for URL-based catalogs with update_frequency.
     */
    next_fetch_at?: string;
    /**
     * Field names that were modified (only present when action='updated')
     */
    changes?: string[];
    /**
     * Validation or processing errors (only present when action='failed')
     */
    errors?: string[];
    /**
     * Non-fatal warnings about this catalog
     */
    warnings?: string[];
    [k: string]: unknown | undefined;
  }[];
  /**
   * When true, this response contains simulated data from sandbox mode.
   */
  sandbox?: boolean;
  context?: ContextObject;
  ext?: ExtensionObject;
  [k: string]: unknown | undefined;
}
/**
 * Error response - operation failed completely, no catalogs were processed
 */
export interface SyncCatalogsError {
  /**
   * Operation-level errors that prevented processing any catalogs (e.g., authentication failure, service unavailable, invalid request format)
   *
   * @minItems 1
   */
  errors: [Error, ...Error[]];
  context?: ContextObject;
  ext?: ExtensionObject;
  [k: string]: unknown | undefined;
}
/**
 * Progress data for working sync_catalogs
 */
export interface SyncCatalogsAsyncWorking {
  /**
   * Completion percentage (0-100)
   */
  percentage?: number;
  /**
   * Current step or phase of the operation (e.g., 'Fetching product feed', 'Validating items', 'Platform review')
   */
  current_step?: string;
  /**
   * Total number of steps in the operation
   */
  total_steps?: number;
  /**
   * Current step number
   */
  step_number?: number;
  /**
   * Number of catalogs processed so far
   */
  catalogs_processed?: number;
  /**
   * Total number of catalogs to process
   */
  catalogs_total?: number;
  /**
   * Total number of catalog items processed across all catalogs
   */
  items_processed?: number;
  /**
   * Total number of catalog items to process across all catalogs
   */
  items_total?: number;
  context?: ContextObject;
  ext?: ExtensionObject;
  [k: string]: unknown | undefined;
}
/**
 * Input requirements for sync_catalogs needing buyer input
 */
export interface SyncCatalogsAsyncInputRequired {
  /**
   * Reason code indicating why buyer input is needed. APPROVAL_REQUIRED: platform requires explicit approval before activating the catalog. FEED_VALIDATION: feed URL returned unexpected format or schema errors. ITEM_REVIEW: platform flagged items for manual review. FEED_ACCESS: platform cannot access the feed URL (authentication, CORS, etc.).
   */
  reason?: 'APPROVAL_REQUIRED' | 'FEED_VALIDATION' | 'ITEM_REVIEW' | 'FEED_ACCESS';
  context?: ContextObject;
  ext?: ExtensionObject;
  [k: string]: unknown | undefined;
}
/**
 * Acknowledgment for submitted sync_catalogs
 */
export interface SyncCatalogsAsyncSubmitted {
  context?: ContextObject;
  ext?: ExtensionObject;
  [k: string]: unknown | undefined;
}

