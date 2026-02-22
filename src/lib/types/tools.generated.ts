// Tool Parameter and Response Types
// Generated from official AdCP schemas

// get_products parameters
/**
 * Brand identifier within the house portfolio. Optional for single-brand domains.
 */
export type BrandID = string;
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
 * Identifier type that the event's content_ids field should be matched against for items in this catalog. For example, 'gtin' means content_ids values are Global Trade Item Numbers, 'sku' means retailer SKUs. Omit when using a custom identifier scheme not listed in the enum.
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
 * Type of inventory delivery
 */
export type DeliveryType = 'guaranteed' | 'non_guaranteed';
/**
 * DEPRECATED: High-level categories for creative formats. These categories are lossy abstractions that don't scale well to emerging ad formats. Use the assets array in Format objects to understand creative requirements instead - it provides precise information about what asset types are needed (video, image, text, etc.).
 */
export type FormatCategory = 'audio' | 'video' | 'display' | 'native' | 'dooh' | 'rich_media' | 'universal';
/**
 * Metro classification system
 */
export type MetroAreaSystem = 'nielsen_dma' | 'uk_itl1' | 'uk_itl2' | 'eurostat_nuts2' | 'custom';
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
 * Geographic targeting level (country, region, metro, postal_area)
 */
export type GeographicTargetingLevel = 'country' | 'region' | 'metro' | 'postal_area';
/**
 * Targeting constraint for a specific signal. Uses value_type as discriminator to determine the targeting expression format.
 */
export type SignalTargeting =
  | {
      signal_id: SignalID;
      /**
       * Discriminator for binary signals
       */
      value_type: 'binary';
      /**
       * Whether to include (true) or exclude (false) users matching this signal
       */
      value: boolean;
      [k: string]: unknown | undefined;
    }
  | {
      signal_id: SignalID;
      /**
       * Discriminator for categorical signals
       */
      value_type: 'categorical';
      /**
       * Values to target. Users with any of these values will be included.
       *
       * @minItems 1
       */
      values: [string, ...string[]];
      [k: string]: unknown | undefined;
    }
  | {
      signal_id: SignalID;
      /**
       * Discriminator for numeric signals
       */
      value_type: 'numeric';
      /**
       * Minimum value (inclusive). Omit for no minimum. Must be <= max_value when both are provided. Should be >= signal's range.min if defined.
       */
      min_value?: number;
      /**
       * Maximum value (inclusive). Omit for no maximum. Must be >= min_value when both are provided. Should be <= signal's range.max if defined.
       */
      max_value?: number;
      [k: string]: unknown | undefined;
    };
/**
 * The signal to target
 */
export type SignalID =
  | {
      /**
       * Discriminator indicating this signal is from a data provider's published catalog
       */
      source: 'catalog';
      /**
       * Domain of the data provider that owns this signal (e.g., 'polk.com', 'experian.com'). The signal definition is published at this domain's /.well-known/adagents.json
       */
      data_provider_domain: string;
      /**
       * Signal identifier within the data provider's catalog (e.g., 'likely_tesla_buyers', 'income_100k_plus')
       */
      id: string;
      [k: string]: unknown | undefined;
    }
  | {
      /**
       * Discriminator indicating this signal is native to the agent (not from a data provider catalog)
       */
      source: 'agent';
      /**
       * URL of the signals agent that provides this signal (e.g., 'https://liveramp.com/.well-known/adcp/signals')
       */
      agent_url: string;
      /**
       * Signal identifier within the agent's signal set (e.g., 'custom_auto_intenders')
       */
      id: string;
      [k: string]: unknown | undefined;
    };
/**
 * The signal to target
 */
export interface GetProductsRequest {
  /**
   * Natural language description of campaign requirements.
   */
  brief?: string;
  brand?: BrandReference;
  catalog?: Catalog;
  /**
   * Account ID for product lookup. Required when the seller declares account.required_for_products = true in capabilities. Returns products with pricing specific to this account's rate card.
   */
  account_id?: string;
  /**
   * Buyer's campaign reference label. Groups related discovery and buy operations under a single campaign for CRM and ad server correlation (e.g., 'NovaDrink_Meals_Q2').
   */
  campaign_ref?: string;
  filters?: ProductFilters;
  property_list?: PropertyListReference;
  pagination?: PaginationRequest;
  context?: ContextObject;
  ext?: ExtensionObject;
}
/**
 * Brand reference for product discovery context. Resolved to full brand identity at execution time.
 */
export interface BrandReference {
  /**
   * Domain where /.well-known/brand.json is hosted, or the brand's operating domain
   */
  domain: string;
  brand_id?: BrandID;
}
/**
 * Catalog of items the buyer wants to promote. The seller matches catalog items against its inventory and returns products where matches exist. Supports all catalog types: a job catalog finds job ad products, a product catalog finds sponsored product slots. Reference a synced catalog by catalog_id, or provide inline items.
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
 * Structured filters for product discovery
 */
export interface ProductFilters {
  delivery_type?: DeliveryType;
  /**
   * Filter by pricing availability: true = products offering fixed pricing (at least one option with fixed_price), false = products offering auction pricing (at least one option without fixed_price). Products with both fixed and auction options match both true and false.
   */
  is_fixed_price?: boolean;
  /**
   * Filter by format types
   *
   * @minItems 1
   */
  format_types?: [FormatCategory, ...FormatCategory[]];
  /**
   * Filter by specific format IDs
   *
   * @minItems 1
   */
  format_ids?: [FormatID, ...FormatID[]];
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
    [k: string]: unknown | undefined;
  };
  /**
   * Filter by country coverage using ISO 3166-1 alpha-2 codes (e.g., ['US', 'CA', 'GB']). Works for all inventory types.
   *
   * @minItems 1
   */
  countries?: [string, ...string[]];
  /**
   * Filter by region coverage using ISO 3166-2 codes (e.g., ['US-NY', 'US-CA', 'GB-SCT']). Use for locally-bound inventory (regional OOH, local TV) where products have region-specific coverage.
   *
   * @minItems 1
   */
  regions?: [string, ...string[]];
  /**
   * Filter by metro coverage for locally-bound inventory (radio, DOOH, local TV). Use when products have DMA/metro-specific coverage. For digital inventory where products have broad coverage, use required_geo_targeting instead to filter by seller capability.
   *
   * @minItems 1
   */
  metros?: [
    {
      system: MetroAreaSystem;
      /**
       * Metro code within the system (e.g., '501' for NYC DMA)
       */
      code: string;
    },
    ...{
      system: MetroAreaSystem;
      /**
       * Metro code within the system (e.g., '501' for NYC DMA)
       */
      code: string;
    }[]
  ];
  /**
   * Filter by advertising channels (e.g., ['display', 'ctv', 'dooh'])
   *
   * @minItems 1
   */
  channels?: [MediaChannel, ...MediaChannel[]];
  /**
   * Filter to products executable through specific agentic ad exchanges. URLs are canonical identifiers.
   *
   * @minItems 1
   */
  required_axe_integrations?: [string, ...string[]];
  required_features?: MediaBuyFeatures;
  /**
   * Filter to products from sellers supporting specific geo targeting capabilities. Each entry specifies a targeting level (country, region, metro, postal_area) and optionally a system for levels that have multiple classification systems.
   *
   * @minItems 1
   */
  required_geo_targeting?: [
    {
      level: GeographicTargetingLevel;
      /**
       * Classification system within the level. Required for metro (e.g., 'nielsen_dma') and postal_area (e.g., 'us_zip'). Not applicable for country/region which use ISO standards.
       */
      system?: string;
    },
    ...{
      level: GeographicTargetingLevel;
      /**
       * Classification system within the level. Required for metro (e.g., 'nielsen_dma') and postal_area (e.g., 'us_zip'). Not applicable for country/region which use ISO standards.
       */
      system?: string;
    }[]
  ];
  /**
   * Filter to products supporting specific signals from data provider catalogs. Products must have the requested signals in their data_provider_signals and signal_targeting_allowed must be true (or all signals requested).
   *
   * @minItems 1
   */
  signal_targeting?: [SignalTargeting, ...SignalTargeting[]];
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
 * Filter to products from sellers supporting specific protocol features. Only features set to true are used for filtering.
 */
export interface MediaBuyFeatures {
  /**
   * Supports creatives provided inline in create_media_buy requests
   */
  inline_creative_management?: boolean;
  /**
   * Honors property_list parameter in get_products to filter results to buyer-approved properties
   */
  property_list_filtering?: boolean;
  /**
   * Full support for content_standards configuration including sampling rates and category filtering
   */
  content_standards?: boolean;
  /**
   * Supports sync_event_sources and log_event tasks for conversion event tracking
   */
  conversion_tracking?: boolean;
  /**
   * Supports sync_audiences task and audience_include/audience_exclude in targeting overlays for first-party CRM audience management
   */
  audience_targeting?: boolean;
  /**
   * Supports sync_catalogs task for catalog feed management with platform review and approval
   */
  catalog_management?: boolean;
  /**
   * Supports sandbox mode for operations without real platform calls or spend
   */
  sandbox?: boolean;
  [k: string]: boolean | undefined;
}
/**
 * [AdCP 3.0] Reference to an externally managed property list. When provided, the sales agent should filter products to only those available on properties in the list.
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
 * Standard cursor-based pagination parameters for list operations
 */
export interface PaginationRequest {
  /**
   * Maximum number of items to return per page
   */
  max_results?: number;
  /**
   * Opaque cursor from a previous response to fetch the next page
   */
  cursor?: string;
}
/**
 * Opaque correlation data that is echoed unchanged in responses. Used for internal tracking, UI session IDs, trace IDs, and other caller-specific identifiers that don't affect protocol behavior. Context data is never parsed by AdCP agents - it's simply preserved and returned.
 */
export interface ContextObject {
  [k: string]: unknown | undefined;
}
/**
 * Extension object for platform-specific, vendor-namespaced parameters. Extensions are always optional and must be namespaced under a vendor/platform key (e.g., ext.gam, ext.roku). Used for custom capabilities, partner-specific configuration, and features being proposed for standardization.
 */
export interface ExtensionObject {
  [k: string]: unknown | undefined;
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
 * Days of the week for daypart targeting
 */
export type DayOfWeek = 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday';

/**
 * Response payload for get_products task
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
   * Advertising channels this product is sold as. Products inherit from their properties' supported_channels but may narrow the scope. For example, a product covering YouTube properties might be sold as ['ctv'] even though those properties support ['olv', 'social', 'ctv'].
   */
  channels?: MediaChannel[];
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
   *
   * @minItems 1
   */
  catalog_types?: [CatalogType, ...CatalogType[]];
  /**
   * Conversion tracking for this product. Presence indicates the product supports conversion-optimized delivery. Seller-level capabilities (supported event types, UID types, attribution windows) are declared in get_adcp_capabilities.
   */
  conversion_tracking?: {
    /**
     * Action sources relevant to this product (e.g. a retail media product might have 'in_store' and 'website', while a display product might only have 'website')
     *
     * @minItems 1
     */
    action_sources?: [ActionSource, ...ActionSource[]];
    /**
     * Optimization strategies this product supports when an optimization_goal is set on a package
     *
     * @minItems 1
     */
    supported_optimization_strategies?: [
      'maximize_conversions' | 'target_cpa' | 'target_roas',
      ...('maximize_conversions' | 'target_cpa' | 'target_roas')[]
    ];
    /**
     * Whether the seller provides its own always-on measurement (e.g. Amazon sales attribution for Amazon advertisers). When true, sync_event_sources response will include seller-managed event sources with managed_by='seller'.
     */
    platform_managed?: boolean;
    [k: string]: unknown | undefined;
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
    manifest: {
      [k: string]: unknown | undefined;
    };
    [k: string]: unknown | undefined;
  };
  /**
   * Optional detailed card with carousel and full specifications. Provides rich product presentation similar to media kit pages.
   */
  product_card_detailed?: {
    format_id: FormatID;
    /**
     * Asset manifest for rendering the detailed card, structure defined by the format
     */
    manifest: {
      [k: string]: unknown | undefined;
    };
    [k: string]: unknown | undefined;
  };
  ext?: ExtensionObject;
  [k: string]: unknown | undefined;
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
 * Forecasted delivery metrics for this allocation
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

// list_creative_formats parameters
/**
 * Filter by format type (technical categories with distinct requirements)
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
  | 'url'
  | 'webhook';
/**
 * Filter to formats that meet at least this WCAG conformance level (A < AA < AAA)
 */
export type WCAGLevel = 'A' | 'AA' | 'AAA';

/**
 * Request parameters for discovering supported creative formats
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
  wcag_level?: WCAGLevel;
  /**
   * Filter to formats whose output_format_ids includes any of these format IDs. Returns formats that can produce these outputs — inspect each result's input_format_ids to see what inputs they accept.
   */
  output_format_ids?: FormatID[];
  /**
   * Filter to formats whose input_format_ids includes any of these format IDs. Returns formats that accept these creatives as input — inspect each result's output_format_ids to see what they can produce.
   */
  input_format_ids?: FormatID[];
  pagination?: PaginationRequest;
  context?: ContextObject;
  ext?: ExtensionObject;
}
/**
 * Structured format identifier with agent URL and format name. Can reference: (1) a concrete format with fixed dimensions (id only), (2) a template format without parameters (id only), or (3) a template format with parameters (id + dimensions/duration). Template formats accept parameters in format_id while concrete formats have fixed dimensions in their definition. Parameterized format IDs create unique, specific format variants.
 */

// list_creative_formats response
/**
 * DEPRECATED: High-level category for this format. Use the assets array to understand creative requirements instead - it provides precise information about what asset types are needed.
 */
export type FormatIDParameter = 'dimensions' | 'duration';
/**
 * Standardized macro placeholders for dynamic value substitution in creative tracking URLs. Macros are replaced with actual values at impression time. See docs/creative/universal-macros.mdx for detailed documentation.
 */
export type UniversalMacro =
  | 'MEDIA_BUY_ID'
  | 'PACKAGE_ID'
  | 'CREATIVE_ID'
  | 'CACHEBUSTER'
  | 'TIMESTAMP'
  | 'CLICK_URL'
  | 'GDPR'
  | 'GDPR_CONSENT'
  | 'US_PRIVACY'
  | 'GPP_STRING'
  | 'GPP_SID'
  | 'IP_ADDRESS'
  | 'LIMIT_AD_TRACKING'
  | 'DEVICE_TYPE'
  | 'OS'
  | 'OS_VERSION'
  | 'DEVICE_MAKE'
  | 'DEVICE_MODEL'
  | 'USER_AGENT'
  | 'APP_BUNDLE'
  | 'APP_NAME'
  | 'COUNTRY'
  | 'REGION'
  | 'CITY'
  | 'ZIP'
  | 'DMA'
  | 'LAT'
  | 'LONG'
  | 'DEVICE_ID'
  | 'DEVICE_ID_TYPE'
  | 'DOMAIN'
  | 'PAGE_URL'
  | 'REFERRER'
  | 'KEYWORDS'
  | 'PLACEMENT_ID'
  | 'FOLD_POSITION'
  | 'AD_WIDTH'
  | 'AD_HEIGHT'
  | 'VIDEO_ID'
  | 'VIDEO_TITLE'
  | 'VIDEO_DURATION'
  | 'VIDEO_CATEGORY'
  | 'CONTENT_GENRE'
  | 'CONTENT_RATING'
  | 'PLAYER_WIDTH'
  | 'PLAYER_HEIGHT'
  | 'POD_POSITION'
  | 'POD_SIZE'
  | 'AD_BREAK_ID'
  | 'STATION_ID'
  | 'SHOW_NAME'
  | 'EPISODE_ID'
  | 'AUDIO_DURATION'
  | 'AXEM';
/**
 * WCAG conformance level that this format achieves. For format-rendered creatives, the format guarantees this level. For opaque creatives, the format requires assets that self-certify to this level.
 */
export type AssetRequirements =
  | ImageAssetRequirements
  | VideoAssetRequirements
  | AudioAssetRequirements
  | TextAssetRequirements
  | MarkdownAssetRequirements
  | HTMLAssetRequirements
  | CSSAssetRequirements
  | JavaScriptAssetRequirements
  | VASTAssetRequirements
  | DAASTAssetRequirements
  | URLAssetRequirements
  | WebhookAssetRequirements;
/**
 * Standard delivery and performance metrics available for reporting
 */
export type CreativeAgentCapability = 'validation' | 'assembly' | 'generation' | 'preview' | 'delivery';

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
  pagination?: PaginationResponse;
  /**
   * When true, this response contains simulated data from sandbox mode.
   */
  sandbox?: boolean;
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
   * Optional URL to showcase page with examples and interactive demos of this format
   */
  example_url?: string;
  type?: FormatCategory;
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
          [k: string]: unknown | undefined;
        }
      | {
          parameters_from_format_id: true;
        }
    ),
    ...(
      | {
          [k: string]: unknown | undefined;
        }
      | {
          parameters_from_format_id: true;
        }
    )[]
  ];
  /**
   * Array of all assets supported for this format. Each asset is identified by its asset_id, which must be used as the key in creative manifests. Use the 'required' boolean on each asset to indicate whether it's mandatory.
   */
  assets?: (
    | BaseIndividualAsset
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
         * Whether this asset group is required. If true, at least min_count repetitions must be provided.
         */
        required: boolean;
        /**
         * Minimum number of repetitions required (if group is required) or allowed (if optional)
         */
        min_count: number;
        /**
         * Maximum number of repetitions allowed
         */
        max_count: number;
        /**
         * How the platform uses repetitions of this group. 'sequential' means all items display in order (carousels, playlists). 'optimize' means the platform selects the best-performing combination from alternatives (asset group optimization like Meta Advantage+ or Google Pmax).
         */
        selection_mode?: 'sequential' | 'optimize';
        /**
         * Assets within each repetition of this group
         */
        assets: BaseGroupAsset[];
      }
  )[];
  /**
   * Delivery method specifications (e.g., hosted, VAST, third-party tags)
   */
  delivery?: {
    [k: string]: unknown | undefined;
  };
  /**
   * List of universal macros supported by this format (e.g., MEDIA_BUY_ID, CACHEBUSTER, DEVICE_ID). Used for validation and developer tooling. See docs/creative/universal-macros.mdx for full documentation.
   */
  supported_macros?: (UniversalMacro | string)[];
  /**
   * Array of format IDs this format accepts as input creative manifests. When present, indicates this format can take existing creatives in these formats as input. Omit for formats that work from raw assets (images, text, etc.) rather than existing creatives.
   */
  input_format_ids?: FormatID[];
  /**
   * Array of format IDs that this format can produce as output. When present, indicates this format can build creatives in these output formats (e.g., a multi-publisher template format might produce standard display formats across many publishers). Omit for formats that produce a single fixed output (the format itself).
   */
  output_format_ids?: FormatID[];
  /**
   * Optional standard visual card (300x400px) for displaying this format in user interfaces. Can be rendered via preview_creative or pre-generated.
   */
  format_card?: {
    format_id: FormatID;
    /**
     * Asset manifest for rendering the card, structure defined by the format
     */
    manifest: {
      [k: string]: unknown | undefined;
    };
    [k: string]: unknown | undefined;
  };
  /**
   * Accessibility posture of this format. Declares the WCAG conformance level that creatives produced by this format will meet.
   */
  accessibility?: {
    wcag_level: WCAGLevel;
    /**
     * When true, all assets with x-accessibility fields must include those fields. For inspectable assets (image, video, audio), this means providing accessibility metadata like alt_text or captions. For opaque assets (HTML, JavaScript), this means providing self-declared accessibility properties.
     */
    requires_accessible_assets?: boolean;
  };
  /**
   * Optional detailed card with carousel and full specifications. Provides rich format documentation similar to ad spec pages.
   */
  format_card_detailed?: {
    format_id: FormatID;
    /**
     * Asset manifest for rendering the detailed card, structure defined by the format
     */
    manifest: {
      [k: string]: unknown | undefined;
    };
    [k: string]: unknown | undefined;
  };
  /**
   * Catalog feeds this format requires for rendering. Formats that display product listings, store locators, inventory availability, or promotional pricing declare what catalog types must be synced to the account. Buyers ensure the required catalogs are synced via sync_catalogs before submitting creatives in this format.
   *
   * @minItems 1
   */
  catalog_requirements?: [CatalogRequirements, ...CatalogRequirements[]];
  /**
   * Metrics this format can produce in delivery reporting. Buyers receive the intersection of format reported_metrics and product available_metrics. If omitted, the format defers entirely to product-level metric declarations.
   *
   * @minItems 1
   */
  reported_metrics?: [AvailableMetric, ...AvailableMetric[]];
  [k: string]: unknown | undefined;
}
/**
 * Structured format identifier with agent URL and format name
 */
export interface BaseIndividualAsset {
  /**
   * Discriminator indicating this is an individual asset
   */
  item_type: 'individual';
  /**
   * Unique identifier for this asset. Creative manifests MUST use this exact value as the key in the assets object.
   */
  asset_id: string;
  /**
   * Optional descriptive label for this asset's purpose (e.g., 'hero_image', 'logo', 'third_party_tracking'). Not used for referencing assets in manifests—use asset_id instead. This field is for human-readable documentation and UI display only.
   */
  asset_role?: string;
  /**
   * Whether this asset is required (true) or optional (false). Required assets must be provided for a valid creative. Optional assets enhance the creative but are not mandatory.
   */
  required: boolean;
}
export interface BaseGroupAsset {
  /**
   * Identifier for this asset within the group
   */
  asset_id: string;
  /**
   * Optional descriptive label for this asset's purpose. Not used for referencing assets in manifests—use asset_id instead. This field is for human-readable documentation and UI display only.
   */
  asset_role?: string;
  /**
   * Whether this asset is required within each repetition of the group
   */
  required: boolean;
}
/**
 * Structured format identifier with agent URL and format name. Can reference: (1) a concrete format with fixed dimensions (id only), (2) a template format without parameters (id only), or (3) a template format with parameters (id + dimensions/duration). Template formats accept parameters in format_id while concrete formats have fixed dimensions in their definition. Parameterized format IDs create unique, specific format variants.
 */
export interface CatalogRequirements {
  catalog_type: CatalogType;
  /**
   * Whether this catalog type must be present. When true, creatives using this format must reference a synced catalog of this type.
   */
  required?: boolean;
  /**
   * Minimum number of items the catalog must contain for this format to render properly (e.g., a carousel might require at least 3 products)
   */
  min_items?: number;
  /**
   * Fields that must be present and non-empty on every item in the catalog. Field names are catalog-type-specific (e.g., 'title', 'price', 'image_url' for product catalogs; 'store_id', 'quantity' for inventory feeds).
   *
   * @minItems 1
   */
  required_fields?: [string, ...string[]];
  /**
   * Accepted feed formats for this catalog type. When specified, the synced catalog must use one of these formats. When omitted, any format is accepted.
   *
   * @minItems 1
   */
  feed_formats?: [FeedFormat, ...FeedFormat[]];
  /**
   * Per-offering creative requirements. Only applicable when catalog_type is 'offering'. Declares what asset groups (headlines, images, videos) each offering must provide, along with count bounds and per-asset technical constraints.
   *
   * @minItems 1
   */
  offering_asset_constraints?: [OfferingAssetConstraint, ...OfferingAssetConstraint[]];
  [k: string]: unknown | undefined;
}
/**
 * Declares per-group creative requirements that each offering must satisfy. Allows formats to specify what asset groups (headlines, images, videos) offerings must provide, along with count and per-asset technical constraints.
 */
export interface OfferingAssetConstraint {
  /**
   * The asset group this constraint applies to. Values are format-defined vocabulary — each format chooses its own group IDs (e.g., 'headlines', 'images', 'videos'). Buyers discover them via list_creative_formats.
   */
  asset_group_id: string;
  asset_type: AssetContentType;
  /**
   * Whether this asset group must be present in each offering. Defaults to true.
   */
  required?: boolean;
  /**
   * Minimum number of items required in this group.
   */
  min_count?: number;
  /**
   * Maximum number of items allowed in this group.
   */
  max_count?: number;
  asset_requirements?: AssetRequirements;
  ext?: ExtensionObject;
  [k: string]: unknown | undefined;
}
/**
 * Requirements for image creative assets. These define the technical constraints for image files.
 */
export interface ImageAssetRequirements {
  /**
   * Minimum width in pixels. For exact dimensions, set min_width = max_width.
   */
  min_width?: number;
  /**
   * Maximum width in pixels. For exact dimensions, set min_width = max_width.
   */
  max_width?: number;
  /**
   * Minimum height in pixels. For exact dimensions, set min_height = max_height.
   */
  min_height?: number;
  /**
   * Maximum height in pixels. For exact dimensions, set min_height = max_height.
   */
  max_height?: number;
  /**
   * Required aspect ratio (e.g., '16:9', '1:1', '1.91:1')
   */
  aspect_ratio?: string;
  /**
   * Accepted image file formats
   */
  formats?: ('jpg' | 'jpeg' | 'png' | 'gif' | 'webp' | 'svg' | 'avif')[];
  /**
   * Maximum file size in kilobytes
   */
  max_file_size_kb?: number;
  /**
   * Whether the image must support transparency (requires PNG, WebP, or GIF)
   */
  transparency_required?: boolean;
  /**
   * Whether animated images (GIF, animated WebP) are accepted
   */
  animation_allowed?: boolean;
  /**
   * Maximum animation duration in milliseconds (if animation_allowed is true)
   */
  max_animation_duration_ms?: number;
  [k: string]: unknown | undefined;
}
/**
 * Requirements for video creative assets. These define the technical constraints for video files.
 */
export interface VideoAssetRequirements {
  /**
   * Minimum width in pixels
   */
  min_width?: number;
  /**
   * Maximum width in pixels
   */
  max_width?: number;
  /**
   * Minimum height in pixels
   */
  min_height?: number;
  /**
   * Maximum height in pixels
   */
  max_height?: number;
  /**
   * Required aspect ratio (e.g., '16:9', '9:16')
   */
  aspect_ratio?: string;
  /**
   * Minimum duration in milliseconds
   */
  min_duration_ms?: number;
  /**
   * Maximum duration in milliseconds
   */
  max_duration_ms?: number;
  /**
   * Accepted video container formats
   */
  containers?: ('mp4' | 'webm' | 'mov' | 'avi' | 'mkv')[];
  /**
   * Accepted video codecs
   */
  codecs?: ('h264' | 'h265' | 'vp8' | 'vp9' | 'av1')[];
  /**
   * Maximum file size in kilobytes
   */
  max_file_size_kb?: number;
  /**
   * Minimum video bitrate in kilobits per second
   */
  min_bitrate_kbps?: number;
  /**
   * Maximum video bitrate in kilobits per second
   */
  max_bitrate_kbps?: number;
  /**
   * Accepted frame rates in frames per second (e.g., [24, 30, 60])
   */
  frame_rates?: number[];
  /**
   * Whether the video must include an audio track
   */
  audio_required?: boolean;
  [k: string]: unknown | undefined;
}
/**
 * Requirements for audio creative assets.
 */
export interface AudioAssetRequirements {
  /**
   * Minimum duration in milliseconds
   */
  min_duration_ms?: number;
  /**
   * Maximum duration in milliseconds
   */
  max_duration_ms?: number;
  /**
   * Accepted audio file formats
   */
  formats?: ('mp3' | 'aac' | 'wav' | 'ogg' | 'flac')[];
  /**
   * Maximum file size in kilobytes
   */
  max_file_size_kb?: number;
  /**
   * Accepted sample rates in Hz (e.g., [44100, 48000])
   */
  sample_rates?: number[];
  /**
   * Accepted audio channel configurations
   */
  channels?: ('mono' | 'stereo')[];
  /**
   * Minimum audio bitrate in kilobits per second
   */
  min_bitrate_kbps?: number;
  /**
   * Maximum audio bitrate in kilobits per second
   */
  max_bitrate_kbps?: number;
  [k: string]: unknown | undefined;
}
/**
 * Requirements for text creative assets such as headlines, body copy, and CTAs.
 */
export interface TextAssetRequirements {
  /**
   * Minimum character length
   */
  min_length?: number;
  /**
   * Maximum character length
   */
  max_length?: number;
  /**
   * Minimum number of lines
   */
  min_lines?: number;
  /**
   * Maximum number of lines
   */
  max_lines?: number;
  /**
   * Regex pattern defining allowed characters (e.g., '^[a-zA-Z0-9 .,!?-]+$')
   */
  character_pattern?: string;
  /**
   * List of prohibited words or phrases
   */
  prohibited_terms?: string[];
  [k: string]: unknown | undefined;
}
/**
 * Requirements for markdown creative assets.
 */
export interface MarkdownAssetRequirements {
  /**
   * Maximum character length
   */
  max_length?: number;
  [k: string]: unknown | undefined;
}
/**
 * Requirements for HTML creative assets. These define the execution environment constraints that the HTML must be compatible with.
 */
export interface HTMLAssetRequirements {
  /**
   * Maximum file size in kilobytes for the HTML asset
   */
  max_file_size_kb?: number;
  /**
   * Sandbox environment the HTML must be compatible with. 'none' = direct DOM access, 'iframe' = standard iframe isolation, 'safeframe' = IAB SafeFrame container, 'fencedframe' = Privacy Sandbox fenced frame
   */
  sandbox?: 'none' | 'iframe' | 'safeframe' | 'fencedframe';
  /**
   * Whether the HTML creative can load external resources (scripts, images, fonts, etc.). When false, all resources must be inlined or bundled.
   */
  external_resources_allowed?: boolean;
  /**
   * List of domains the HTML creative may reference for external resources. Only applicable when external_resources_allowed is true.
   */
  allowed_external_domains?: string[];
  [k: string]: unknown | undefined;
}
/**
 * Requirements for CSS creative assets.
 */
export interface CSSAssetRequirements {
  /**
   * Maximum file size in kilobytes
   */
  max_file_size_kb?: number;
  [k: string]: unknown | undefined;
}
/**
 * Requirements for JavaScript creative assets. These define the execution environment constraints that the JavaScript must be compatible with.
 */
export interface JavaScriptAssetRequirements {
  /**
   * Maximum file size in kilobytes for the JavaScript asset
   */
  max_file_size_kb?: number;
  /**
   * Required JavaScript module format. 'script' = classic script, 'module' = ES modules, 'iife' = immediately invoked function expression
   */
  module_type?: 'script' | 'module' | 'iife';
  /**
   * Whether the JavaScript must use strict mode
   */
  strict_mode_required?: boolean;
  /**
   * Whether the JavaScript can load external resources dynamically
   */
  external_resources_allowed?: boolean;
  /**
   * List of domains the JavaScript may reference for external resources. Only applicable when external_resources_allowed is true.
   */
  allowed_external_domains?: string[];
  [k: string]: unknown | undefined;
}
/**
 * Requirements for VAST (Video Ad Serving Template) creative assets.
 */
export interface VASTAssetRequirements {
  /**
   * Required VAST version
   */
  vast_version?: '2.0' | '3.0' | '4.0' | '4.1' | '4.2';
  [k: string]: unknown | undefined;
}
/**
 * Requirements for DAAST (Digital Audio Ad Serving Template) creative assets.
 */
export interface DAASTAssetRequirements {
  /**
   * Required DAAST version. DAAST 1.0 is the current IAB standard.
   */
  daast_version?: '1.0';
  [k: string]: unknown | undefined;
}
/**
 * Requirements for URL assets such as click-through URLs, tracking pixels, and landing pages.
 */
export interface URLAssetRequirements {
  /**
   * Standard role for this URL asset. Use this to constrain which purposes are valid for this URL slot. Complements asset_role (which is a human-readable label) by providing a machine-readable enum.
   */
  role?:
    | 'clickthrough'
    | 'landing_page'
    | 'impression_tracker'
    | 'click_tracker'
    | 'viewability_tracker'
    | 'third_party_tracker';
  /**
   * Allowed URL protocols. HTTPS is recommended for all ad URLs.
   */
  protocols?: ('https' | 'http')[];
  /**
   * List of allowed domains for the URL
   */
  allowed_domains?: string[];
  /**
   * Maximum URL length in characters
   */
  max_length?: number;
  /**
   * Whether the URL supports macro substitution (e.g., ${CACHEBUSTER})
   */
  macro_support?: boolean;
  [k: string]: unknown | undefined;
}
/**
 * Requirements for webhook creative assets.
 */
export interface WebhookAssetRequirements {
  /**
   * Allowed HTTP methods
   */
  methods?: ('GET' | 'POST')[];
  [k: string]: unknown | undefined;
}
/**
 * Extension object for platform-specific, vendor-namespaced parameters. Extensions are always optional and must be namespaced under a vendor/platform key (e.g., ext.gam, ext.roku). Used for custom capabilities, partner-specific configuration, and features being proposed for standardization.
 */

// create_media_buy parameters
/**
 * Budget pacing strategy
 */
export type Pacing = 'even' | 'asap' | 'front_loaded';
/**
 * Catalog type. Structural types: 'offering' (AdCP Offering objects), 'product' (ecommerce entries), 'inventory' (stock per location), 'store' (physical locations), 'promotion' (deals and pricing). Vertical types: 'hotel', 'flight', 'job', 'vehicle', 'real_estate', 'education', 'destination' — each with an industry-specific item schema.
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
 * Brand identifier within the house portfolio. Optional for single-brand domains.
 */
export type StartTiming = 'asap' | string;
/**
 * Authentication schemes for push notification endpoints
 */
export type AuthenticationScheme = 'Bearer' | 'HMAC-SHA256';
/**
 * Standard delivery and performance metrics available for reporting
 */
export interface CreateMediaBuyRequest {
  /**
   * Buyer's reference identifier for this media buy
   */
  buyer_ref: string;
  /**
   * Buyer's campaign reference label. Groups related discovery and buy operations under a single campaign for CRM and ad server correlation (e.g., 'NovaDrink_Meals_Q2').
   */
  campaign_ref?: string;
  /**
   * Account to bill for this media buy. Required when the agent has access to multiple accounts; when omitted, the seller uses the agent's sole account. The seller maps the agent's brand + operator to an account during sync_accounts; the agent passes that account_id here.
   */
  account_id?: string;
  /**
   * ID of a proposal from get_products to execute. When provided with total_budget, the publisher converts the proposal's allocation percentages into packages automatically. Alternative to providing packages array.
   */
  proposal_id?: string;
  /**
   * Total budget for the media buy when executing a proposal. The publisher applies the proposal's allocation percentages to this amount to derive package budgets.
   */
  total_budget?: {
    /**
     * Total budget amount
     */
    amount: number;
    /**
     * ISO 4217 currency code
     */
    currency: string;
  };
  /**
   * Array of package configurations. Required when not using proposal_id. When executing a proposal, this can be omitted and packages will be derived from the proposal's allocations.
   */
  packages?: PackageRequest[];
  brand: BrandReference;
  /**
   * Purchase order number for tracking
   */
  po_number?: string;
  start_time: StartTiming;
  /**
   * Campaign end date/time in ISO 8601 format
   */
  end_time: string;
  reporting_webhook?: ReportingWebhook;
  /**
   * Optional webhook configuration for content artifact delivery. Used by governance agents to validate content adjacency. Seller pushes artifacts to this endpoint; orchestrator forwards to governance agent for validation.
   */
  artifact_webhook?: {
    /**
     * Webhook endpoint URL for artifact delivery
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
       * @maxItems 1
       */
      schemes: [] | [AuthenticationScheme];
      /**
       * Credentials for authentication. For Bearer: token sent in Authorization header. For HMAC-SHA256: shared secret used to generate signature. Minimum 32 characters. Exchanged out-of-band during onboarding.
       */
      credentials: string;
    };
    /**
     * How artifacts are delivered. 'realtime' pushes artifacts as impressions occur. 'batched' aggregates artifacts and pushes periodically (see batch_frequency).
     */
    delivery_mode: 'realtime' | 'batched';
    /**
     * For batched delivery, how often to push artifacts. Required when delivery_mode is 'batched'.
     */
    batch_frequency?: 'hourly' | 'daily';
    /**
     * Fraction of impressions to include (0-1). 1.0 = all impressions, 0.1 = 10% sample. Default: 1.0
     */
    sampling_rate?: number;
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
  /**
   * Impression goal for this package
   */
  impressions?: number;
  /**
   * Whether this package should be created in a paused state. Paused packages do not deliver impressions. Defaults to false.
   */
  paused?: boolean;
  catalog?: Catalog;
  optimization_goal?: OptimizationGoal;
  targeting_overlay?: TargetingOverlay;
  /**
   * Assign existing library creatives to this package with optional weights and placement targeting
   *
   * @minItems 1
   */
  creative_assignments?: [CreativeAssignment, ...CreativeAssignment[]];
  /**
   * Upload new creative assets and assign to this package (creatives will be added to library). Use creative_assignments instead for existing library creatives.
   *
   * @minItems 1
   * @maxItems 100
   */
  creatives?: [CreativeAsset, ...CreativeAsset[]];
  ext?: ExtensionObject;
  [k: string]: unknown | undefined;
}
/**
 * Structured format identifier with agent URL and format name. Can reference: (1) a concrete format with fixed dimensions (id only), (2) a template format without parameters (id only), or (3) a template format with parameters (id + dimensions/duration). Template formats accept parameters in format_id while concrete formats have fixed dimensions in their definition. Parameterized format IDs create unique, specific format variants.
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
    [k: string]: unknown | undefined;
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
    [k: string]: unknown | undefined;
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
   *
   * @minItems 1
   */
  placement_ids?: [string, ...string[]];
  [k: string]: unknown | undefined;
}
/**
 * Structured format identifier with agent URL and format name. Can reference: (1) a concrete format with fixed dimensions (id only), (2) a template format without parameters (id only), or (3) a template format with parameters (id + dimensions/duration). Template formats accept parameters in format_id while concrete formats have fixed dimensions in their definition. Parameterized format IDs create unique, specific format variants.
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
/**
 * Extension object for platform-specific, vendor-namespaced parameters. Extensions are always optional and must be namespaced under a vendor/platform key (e.g., ext.gam, ext.roku). Used for custom capabilities, partner-specific configuration, and features being proposed for standardization.
 */
export interface ReportingWebhook {
  /**
   * Webhook endpoint URL for reporting notifications
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
  /**
   * Frequency for automated reporting delivery. Must be supported by all products in the media buy.
   */
  reporting_frequency: 'hourly' | 'daily' | 'monthly';
  /**
   * Optional list of metrics to include in webhook notifications. If omitted, all available metrics are included. Must be subset of product's available_metrics.
   */
  requested_metrics?: AvailableMetric[];
  [k: string]: unknown | undefined;
}
/**
 * Opaque correlation data that is echoed unchanged in responses. Used for internal tracking, UI session IDs, trace IDs, and other caller-specific identifiers that don't affect protocol behavior. Context data is never parsed by AdCP agents - it's simply preserved and returned.
 */

// create_media_buy response
/**
 * Response payload for create_media_buy task. Returns either complete success data OR error information, never both. This enforces atomic operation semantics - the media buy is either fully created or not created at all.
 */
export type CreateMediaBuyResponse = CreateMediaBuySuccess | CreateMediaBuyError;
/**
 * Budget pacing strategy
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
}
/**
 * Account billed for this media buy. Includes advertiser, billing proxy (if any), and rate card applied.
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
export interface CreateMediaBuyError {
  /**
   * Array of errors explaining why the operation failed
   */
  errors: Error[];
  context?: ContextObject;
  ext?: ExtensionObject;
}
/**
 * Standard error structure for task-specific errors and warnings
 */

// sync_creatives parameters
/**
 * Catalog type. Structural types: 'offering' (AdCP Offering objects), 'product' (ecommerce entries), 'inventory' (stock per location), 'store' (physical locations), 'promotion' (deals and pricing). Vertical types: 'hotel', 'flight', 'job', 'vehicle', 'real_estate', 'education', 'destination' — each with an industry-specific item schema.
 */
export type ValidationMode = 'strict' | 'lenient';
/**
 * Authentication schemes for push notification endpoints
 */
export interface SyncCreativesRequest {
  /**
   * Account that owns these creatives. Optional if the agent has a single account or the seller can determine the account from context. Required if the agent has multiple accounts and the seller cannot route automatically.
   */
  account_id?: string;
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

// sync_creatives response
/**
 * Response from creative sync operation. Returns either per-creative results (best-effort processing) OR operation-level errors (complete failure). This enforces atomic semantics at the operation level while allowing per-item failures within successful operations.
 */
export type SyncCreativesResponse = SyncCreativesSuccess | SyncCreativesError;
/**
 * Action taken for this creative
 */
export type CreativeAction = 'created' | 'updated' | 'unchanged' | 'failed' | 'deleted';

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
      /**
       * Error message for this package assignment
       *
       * This interface was referenced by `undefined`'s JSON-Schema definition
       * via the `patternProperty` "^[a-zA-Z0-9_-]+$".
       */
      [k: string]: string;
    };
  }[];
  /**
   * When true, this response contains simulated data from sandbox mode.
   */
  sandbox?: boolean;
  context?: ContextObject;
  ext?: ExtensionObject;
}
/**
 * Account that owns this creative
 */
export interface SyncCreativesError {
  /**
   * Operation-level errors that prevented processing any creatives (e.g., authentication failure, service unavailable, invalid request format)
   */
  errors: Error[];
  context?: ContextObject;
  ext?: ExtensionObject;
}
/**
 * Standard error structure for task-specific errors and warnings
 */

// list_creatives parameters
/**
 * Status of a creative asset
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
  pagination?: PaginationRequest;
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
 * Filter criteria for querying creative assets from the centralized library. By default, archived creatives are excluded from results. To include archived creatives, explicitly filter by status='archived' or include 'archived' in the statuses array.
 */
export interface CreativeFilters {
  /**
   * Filter creatives by owning accounts. Useful for agencies managing multiple client accounts.
   *
   * @minItems 1
   */
  account_ids?: [string, ...string[]];
  /**
   * Filter by creative format types (e.g., video, audio, display)
   *
   * @minItems 1
   */
  formats?: [string, ...string[]];
  /**
   * Filter by creative approval statuses
   *
   * @minItems 1
   */
  statuses?: [CreativeStatus, ...CreativeStatus[]];
  /**
   * Filter by creative tags (all tags must match)
   *
   * @minItems 1
   */
  tags?: [string, ...string[]];
  /**
   * Filter by creative tags (any tag must match)
   *
   * @minItems 1
   */
  tags_any?: [string, ...string[]];
  /**
   * Filter by creative names containing this text (case-insensitive)
   */
  name_contains?: string;
  /**
   * Filter by specific creative IDs
   *
   * @minItems 1
   * @maxItems 100
   */
  creative_ids?: [string, ...string[]];
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
   * Filter creatives assigned to any of these packages
   *
   * @minItems 1
   */
  assigned_to_packages?: [string, ...string[]];
  /**
   * Filter creatives assigned to any of these media buys
   *
   * @minItems 1
   */
  media_buy_ids?: [string, ...string[]];
  /**
   * Filter creatives assigned to media buys with any of these buyer references
   *
   * @minItems 1
   */
  buyer_refs?: [string, ...string[]];
  /**
   * Filter for unassigned creatives when true, assigned creatives when false
   */
  unassigned?: boolean;
  /**
   * Filter creatives that have performance data when true
   */
  has_performance_data?: boolean;
  [k: string]: unknown | undefined;
}
/**
 * Standard cursor-based pagination parameters for list operations
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
      [k: string]: unknown | undefined;
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
      [k: string]: unknown | undefined;
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
    total_matching?: number;
    /**
     * Number of creatives returned in this response
     */
    returned?: number;
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
  pagination: PaginationResponse;
  /**
   * Array of creative assets matching the query
   */
  creatives: {
    /**
     * Unique identifier for the creative
     */
    creative_id: string;
    account?: Account;
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
    catalog?: Catalog;
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
         * Buyer's reference identifier for this package
         */
        buyer_ref?: string;
        /**
         * When this assignment was created
         */
        assigned_date: string;
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
     * Number of creatives being processed
     */
    processing?: number;
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
  /**
   * When true, this response contains simulated data from sandbox mode.
   */
  sandbox?: boolean;
  context?: ContextObject;
  ext?: ExtensionObject;
}
/**
 * Standard cursor-based pagination metadata for list responses
 */

// update_media_buy parameters
/**
 * Request parameters for updating campaign and package settings
 */
export type UpdateMediaBuyRequest = {
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
  packages?: PackageUpdate[];
  reporting_webhook?: ReportingWebhook;
  push_notification_config?: PushNotificationConfig;
  context?: ContextObject;
  ext?: ExtensionObject;
} & {
  [k: string]: unknown | undefined;
};
/**
 * Campaign start timing: 'asap' or ISO 8601 date-time
 */
export type PackageUpdate = {
  /**
   * Publisher's ID of package to update
   */
  package_id?: string;
  /**
   * Buyer's reference for the package to update
   */
  buyer_ref?: string;
  /**
   * Updated budget allocation for this package in the currency specified by the pricing option
   */
  budget?: number;
  pacing?: Pacing;
  /**
   * Updated bid price for auction-based pricing options (only applies when pricing_option is auction-based)
   */
  bid_price?: number;
  /**
   * Updated impression goal for this package
   */
  impressions?: number;
  /**
   * Pause/resume specific package (true = paused, false = active)
   */
  paused?: boolean;
  catalog?: Catalog;
  optimization_goal?: OptimizationGoal;
  targeting_overlay?: TargetingOverlay;
  /**
   * Replace creative assignments for this package with optional weights and placement targeting. Uses replacement semantics - omit to leave assignments unchanged.
   */
  creative_assignments?: CreativeAssignment[];
  /**
   * Upload new creative assets and assign to this package (creatives will be added to library). Use creative_assignments instead for existing library creatives.
   *
   * @minItems 1
   * @maxItems 100
   */
  creatives?: [CreativeAsset, ...CreativeAsset[]];
  ext?: ExtensionObject;
  [k: string]: unknown | undefined;
} & {
  [k: string]: unknown | undefined;
};
/**
 * Budget pacing strategy
 */

// update_media_buy response
/**
 * Response payload for update_media_buy task. Returns either complete success data OR error information, never both. This enforces atomic operation semantics - updates are either fully applied or not applied at all.
 */
export type UpdateMediaBuyResponse = UpdateMediaBuySuccess | UpdateMediaBuyError;
/**
 * Budget pacing strategy
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
}
/**
 * A specific product within a media buy (line item)
 */
export interface UpdateMediaBuyError {
  /**
   * Array of errors explaining why the operation failed
   */
  errors: Error[];
  context?: ContextObject;
  ext?: ExtensionObject;
}
/**
 * Standard error structure for task-specific errors and warnings
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
   * Filter delivery data to a specific account. When provided, only returns media buys belonging to this account. When omitted, returns data across all accessible accounts. Optional if the agent has a single account.
   */
  account_id?: string;
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
   * Start date for reporting period (YYYY-MM-DD). When omitted along with end_date, returns campaign lifetime data. Only accepted when the product's reporting_capabilities.date_range_support is 'date_range'.
   */
  start_date?: string;
  /**
   * End date for reporting period (YYYY-MM-DD). When omitted along with start_date, returns campaign lifetime data. Only accepted when the product's reporting_capabilities.date_range_support is 'date_range'.
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
 * Attribution model used to assign credit when multiple touchpoints exist
 */
export type AttributionModel = 'last_touch' | 'first_touch' | 'linear' | 'time_decay' | 'data_driven';
/**
 * Pricing model used for this media buy
 */
export type PricingModel = 'cpm' | 'vcpm' | 'cpc' | 'cpcv' | 'cpv' | 'cpp' | 'cpa' | 'flat_rate' | 'time';
/**
 * The event type
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
  attribution_window?: AttributionWindow;
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
     * Total conversions across all media buys (if applicable)
     */
    conversions?: number;
    /**
     * Total conversion value across all media buys (if applicable)
     */
    conversion_value?: number;
    /**
     * Aggregate return on ad spend across all media buys (total conversion_value / total spend)
     */
    roas?: number;
    /**
     * Fraction of total conversions across all media buys from first-time brand buyers (weighted by conversion volume, not a simple average of per-buy rates)
     */
    new_to_brand_rate?: number;
    /**
     * Aggregate cost per conversion across all media buys (total spend / total conversions)
     */
    cost_per_acquisition?: number;
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
     * Buyer's campaign reference label. Groups related operations under a single campaign for CRM and ad server correlation.
     */
    campaign_ref?: string;
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
      pricing_model: PricingModel;
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
      /**
       * Delivery by catalog item within this package. Available for catalog-driven packages when the seller supports item-level reporting.
       */
      by_catalog_item?: (DeliveryMetrics & {
        /**
         * Catalog item identifier (e.g., SKU, GTIN, job_id, offering_id)
         */
        content_id: string;
        content_id_type?: ContentIDType;
      })[];
      /**
       * Metrics broken down by creative within this package. Available when the seller supports creative-level reporting.
       */
      by_creative?: (DeliveryMetrics & {
        /**
         * Creative identifier matching the creative assignment
         */
        creative_id: string;
        /**
         * Observed delivery share for this creative within the package during the reporting period, expressed as a percentage (0-100). Reflects actual delivery distribution, not a configured setting.
         */
        weight?: number;
      })[];
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
      /**
       * Daily conversions
       */
      conversions?: number;
      /**
       * Daily conversion value
       */
      conversion_value?: number;
      /**
       * Daily return on ad spend (conversion_value / spend)
       */
      roas?: number;
      /**
       * Daily fraction of conversions from first-time brand buyers (0 = none, 1 = all)
       */
      new_to_brand_rate?: number;
    }[];
  }[];
  /**
   * Task-specific errors and warnings (e.g., missing delivery data, reporting platform issues)
   */
  errors?: Error[];
  /**
   * When true, this response contains simulated data from sandbox mode.
   */
  sandbox?: boolean;
  context?: ContextObject;
  ext?: ExtensionObject;
}
/**
 * Attribution methodology and lookback windows used for conversion metrics in this response. All media buys from a single seller share the same attribution methodology. Enables cross-platform comparison (e.g., Amazon 14-day click vs. Criteo 30-day click).
 */
export interface AttributionWindow {
  /**
   * Click-through attribution window in days. Conversions occurring within this many days after a click are attributed to the ad.
   */
  click_window_days?: number;
  /**
   * View-through attribution window in days. Conversions occurring within this many days after an ad impression (without click) are attributed to the ad.
   */
  view_window_days?: number;
  model: AttributionModel;
  [k: string]: unknown | undefined;
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
   * Total conversions attributed to this delivery. When by_event_type is present, this equals the sum of all by_event_type[].count entries.
   */
  conversions?: number;
  /**
   * Total monetary value of attributed conversions (in the reporting currency)
   */
  conversion_value?: number;
  /**
   * Return on ad spend (conversion_value / spend)
   */
  roas?: number;
  /**
   * Cost per conversion (spend / conversions)
   */
  cost_per_acquisition?: number;
  /**
   * Fraction of conversions from first-time brand buyers (0 = none, 1 = all)
   */
  new_to_brand_rate?: number;
  /**
   * Leads generated (convenience alias for by_event_type where event_type='lead')
   */
  leads?: number;
  /**
   * Conversion metrics broken down by event type. Spend-derived metrics (ROAS, CPA) are only available at the package/totals level since spend cannot be attributed to individual event types.
   */
  by_event_type?: {
    event_type: EventType;
    /**
     * Event source that produced these conversions (for disambiguation when multiple event sources are configured)
     */
    event_source_id?: string;
    /**
     * Number of events of this type
     */
    count: number;
    /**
     * Total monetary value of events of this type
     */
    value?: number;
    [k: string]: unknown | undefined;
  }[];
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
      [k: string]: unknown | undefined;
    }[];
    [k: string]: unknown | undefined;
  };
  /**
   * Viewability metrics. Viewable rate should be calculated as viewable_impressions / measurable_impressions (not total impressions), since some environments cannot measure viewability.
   */
  viewability?: {
    /**
     * Impressions where viewability could be measured. Excludes environments without measurement capability (e.g., non-Intersection Observer browsers, certain app environments).
     */
    measurable_impressions?: number;
    /**
     * Impressions that met the viewability threshold defined by the measurement standard.
     */
    viewable_impressions?: number;
    /**
     * Viewable impression rate (viewable_impressions / measurable_impressions). Range 0.0 to 1.0.
     */
    viewable_rate?: number;
    /**
     * Viewability measurement standard. 'mrc': 50% of pixels in view for 1 second (display) or 2 seconds (video), per MRC/IAB guidelines. 'groupm': 100% of pixels in view for the same durations. These are materially different thresholds and should not be compared across standards.
     */
    standard?: 'mrc' | 'groupm';
    [k: string]: unknown | undefined;
  };
  /**
   * Platform-specific engagement rate (0.0 to 1.0). Definition varies by platform (e.g., likes+comments+shares/impressions on social, interactions/impressions on rich media).
   */
  engagement_rate?: number;
  /**
   * Cost per click (spend / clicks)
   */
  cost_per_click?: number;
  /**
   * Conversion metrics broken down by action source (website, app, in_store, etc.). Useful for omnichannel sellers where conversions occur across digital and physical channels.
   */
  by_action_source?: {
    action_source: ActionSource;
    /**
     * Event source that produced these conversions (for disambiguation when multiple event sources are configured)
     */
    event_source_id?: string;
    /**
     * Number of conversions from this action source
     */
    count: number;
    /**
     * Total monetary value of conversions from this action source
     */
    value?: number;
    [k: string]: unknown | undefined;
  }[];
  [k: string]: unknown | undefined;
}
/**
 * Standard error structure for task-specific errors and warnings
 */

// provide_performance_feedback parameters
/**
 * Request payload for provide_performance_feedback task
 */
export type ProvidePerformanceFeedbackRequest = {
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
} & {
  [k: string]: unknown | undefined;
};
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

/**
 * Opaque correlation data that is echoed unchanged in responses. Used for internal tracking, UI session IDs, trace IDs, and other caller-specific identifiers that don't affect protocol behavior. Context data is never parsed by AdCP agents - it's simply preserved and returned.
 */

// provide_performance_feedback response
/**
 * Response payload for provide_performance_feedback task. Returns either success confirmation OR error information, never both.
 */
export type ProvidePerformanceFeedbackResponse = ProvidePerformanceFeedbackSuccess | ProvidePerformanceFeedbackError;

/**
 * Success response - feedback received and processed
 */
export interface ProvidePerformanceFeedbackSuccess {
  /**
   * Whether the performance feedback was successfully received
   */
  success: true;
  /**
   * When true, this response contains simulated data from sandbox mode.
   */
  sandbox?: boolean;
  context?: ContextObject;
  ext?: ExtensionObject;
}
/**
 * Opaque correlation data that is echoed unchanged in responses. Used for internal tracking, UI session IDs, trace IDs, and other caller-specific identifiers that don't affect protocol behavior. Context data is never parsed by AdCP agents - it's simply preserved and returned.
 */
export interface ProvidePerformanceFeedbackError {
  /**
   * Array of errors explaining why feedback was rejected (e.g., invalid measurement period, missing campaign data)
   */
  errors: Error[];
  context?: ContextObject;
  ext?: ExtensionObject;
}
/**
 * Standard error structure for task-specific errors and warnings
 */

// sync_event_sources parameters
/**
 * Standard marketing event types for event logging, aligned with IAB ECAPI
 */
export interface SyncEventSourcesRequest {
  /**
   * Account to configure event sources for
   */
  account_id: string;
  /**
   * Event sources to sync (create or update). When omitted, the call is discovery-only and returns all existing event sources on the account without modification.
   */
  event_sources?: {
    /**
     * Unique identifier for this event source
     */
    event_source_id: string;
    /**
     * Human-readable name for this event source
     */
    name?: string;
    /**
     * Event types this source handles (e.g. purchase, lead). If omitted, accepts all event types.
     */
    event_types?: EventType[];
    /**
     * Domains authorized to send events for this event source
     */
    allowed_domains?: string[];
  }[];
  /**
   * When true, event sources not included in this sync will be removed
   */
  delete_missing?: boolean;
  context?: ContextObject;
  ext?: ExtensionObject;
}
/**
 * Opaque correlation data that is echoed unchanged in responses. Used for internal tracking, UI session IDs, trace IDs, and other caller-specific identifiers that don't affect protocol behavior. Context data is never parsed by AdCP agents - it's simply preserved and returned.
 */

// sync_event_sources response
/**
 * Response from event source sync operation. Returns either per-source results OR operation-level errors.
 */
export type SyncEventSourcesResponse = SyncEventSourcesSuccess | SyncEventSourcesError;
/**
 * Standard marketing event types for event logging, aligned with IAB ECAPI
 */
export interface SyncEventSourcesSuccess {
  /**
   * Results for each event source, including both synced and seller-managed sources on the account
   */
  event_sources: {
    /**
     * Event source ID from the request
     */
    event_source_id: string;
    /**
     * Name of the event source
     */
    name?: string;
    /**
     * Seller-assigned identifier for this event source (the ID in the seller's ad platform)
     */
    seller_id?: string;
    /**
     * Event types this source handles
     */
    event_types?: EventType[];
    action_source?: ActionSource;
    /**
     * Who manages this event source. 'buyer' = configured via this sync. 'seller' = always-on, managed by the seller (e.g. Amazon sales attribution for Amazon advertisers).
     */
    managed_by?: 'buyer' | 'seller';
    /**
     * Implementation details for activating this event source (e.g. JavaScript tag, pixel URL)
     */
    setup?: {
      /**
       * Code snippet to place on the site (JavaScript, HTML pixel, etc.)
       */
      snippet?: string;
      /**
       * Type of implementation. 'server_only' means no client-side tag is needed.
       */
      snippet_type?: 'javascript' | 'html' | 'pixel_url' | 'server_only';
      /**
       * Human/agent-readable setup instructions
       */
      instructions?: string;
    };
    /**
     * Action taken for this event source
     */
    action: 'created' | 'updated' | 'unchanged' | 'deleted' | 'failed';
    /**
     * Errors for this event source (only present when action='failed')
     */
    errors?: string[];
  }[];
  /**
   * When true, this response contains simulated data from sandbox mode.
   */
  sandbox?: boolean;
  context?: ContextObject;
  ext?: ExtensionObject;
}
/**
 * Opaque correlation data that is echoed unchanged in responses. Used for internal tracking, UI session IDs, trace IDs, and other caller-specific identifiers that don't affect protocol behavior. Context data is never parsed by AdCP agents - it's simply preserved and returned.
 */
export interface SyncEventSourcesError {
  /**
   * Operation-level errors that prevented processing
   */
  errors: Error[];
  context?: ContextObject;
  ext?: ExtensionObject;
}
/**
 * Standard error structure for task-specific errors and warnings
 */

// log_event parameters
/**
 * Standard event type
 */
export type UserMatch = {
  [k: string]: unknown | undefined;
} & {
  /**
   * Universal ID values for user matching
   *
   * @minItems 1
   */
  uids?: [
    {
      type: UIDType;
      /**
       * Universal ID value
       */
      value: string;
      [k: string]: unknown | undefined;
    },
    ...{
      type: UIDType;
      /**
       * Universal ID value
       */
      value: string;
      [k: string]: unknown | undefined;
    }[]
  ];
  /**
   * SHA-256 hash of lowercase, trimmed email address. Buyer must normalize before hashing: lowercase, trim whitespace.
   */
  hashed_email?: string;
  /**
   * SHA-256 hash of E.164-formatted phone number (e.g. +12065551234). Buyer must normalize to E.164 before hashing.
   */
  hashed_phone?: string;
  /**
   * Platform click identifier (fbclid, gclid, ttclid, ScCid, etc.)
   */
  click_id?: string;
  /**
   * Type of click identifier (e.g. fbclid, gclid, ttclid, msclkid, ScCid)
   */
  click_id_type?: string;
  /**
   * Client IP address for probabilistic matching
   */
  client_ip?: string;
  /**
   * Client user agent string for probabilistic matching
   */
  client_user_agent?: string;
  ext?: ExtensionObject;
  [k: string]: unknown | undefined;
};
/**
 * Universal ID type
 */
export type UIDType = 'rampid' | 'id5' | 'uid2' | 'euid' | 'pairid' | 'external_id' | 'maid' | 'other';
/**
 * Where the event originated
 */
export interface LogEventRequest {
  /**
   * Event source configured on the account via sync_event_sources
   */
  event_source_id: string;
  /**
   * Test event code for validation without affecting production data. Events with this code appear in the platform's test events UI.
   */
  test_event_code?: string;
  /**
   * Events to log
   *
   * @maxItems 10000
   */
  events: Event[];
  context?: ContextObject;
  ext?: ExtensionObject;
}
/**
 * A marketing event (conversion, engagement, or custom) for attribution and optimization
 */
export interface Event {
  /**
   * Unique identifier for deduplication (scoped to event_type + event_source_id)
   */
  event_id: string;
  event_type: EventType;
  /**
   * ISO 8601 timestamp when the event occurred
   */
  event_time: string;
  user_match?: UserMatch;
  custom_data?: EventCustomData;
  action_source?: ActionSource;
  /**
   * URL where the event occurred (required when action_source is 'website')
   */
  event_source_url?: string;
  /**
   * Name for custom events (used when event_type is 'custom')
   */
  custom_event_name?: string;
  ext?: ExtensionObject;
  [k: string]: unknown | undefined;
}
/**
 * Extension object for platform-specific, vendor-namespaced parameters. Extensions are always optional and must be namespaced under a vendor/platform key (e.g., ext.gam, ext.roku). Used for custom capabilities, partner-specific configuration, and features being proposed for standardization.
 */
export interface EventCustomData {
  /**
   * Monetary value of the event (should be accompanied by currency)
   */
  value?: number;
  /**
   * ISO 4217 currency code
   */
  currency?: string;
  /**
   * Unique order or transaction identifier
   */
  order_id?: string;
  /**
   * Item identifiers for catalog attribution. Values are matched against catalog items using the identifier type declared by the catalog's content_id_type field (e.g., SKUs, GTINs, or vertical-specific IDs like job_id).
   */
  content_ids?: string[];
  /**
   * Category of content associated with the event (e.g., 'product', 'job', 'hotel'). Corresponds to the catalog type when used for catalog attribution.
   */
  content_type?: string;
  /**
   * Name of the product or content
   */
  content_name?: string;
  /**
   * Category of the product or content
   */
  content_category?: string;
  /**
   * Number of items in the event
   */
  num_items?: number;
  /**
   * Search query for search events
   */
  search_string?: string;
  /**
   * Per-item details for e-commerce events
   */
  contents?: {
    /**
     * Product or content identifier
     */
    id: string;
    /**
     * Quantity of this item
     */
    quantity?: number;
    /**
     * Price per unit of this item
     */
    price?: number;
    /**
     * Brand name of this item
     */
    brand?: string;
    [k: string]: unknown | undefined;
  }[];
  ext?: ExtensionObject;
  [k: string]: unknown | undefined;
}
/**
 * Opaque correlation data that is echoed unchanged in responses. Used for internal tracking, UI session IDs, trace IDs, and other caller-specific identifiers that don't affect protocol behavior. Context data is never parsed by AdCP agents - it's simply preserved and returned.
 */

// log_event response
/**
 * Response from event logging operation. Returns either event processing results OR operation-level errors.
 */
export type LogEventResponse = LogEventSuccess | LogEventError;

/**
 * Success response - events received and queued for processing
 */
export interface LogEventSuccess {
  /**
   * Number of events received
   */
  events_received: number;
  /**
   * Number of events successfully queued for processing
   */
  events_processed: number;
  /**
   * Events that failed validation
   */
  partial_failures?: {
    /**
     * ID of the failed event
     */
    event_id: string;
    /**
     * Error code
     */
    code: string;
    /**
     * Human-readable error message
     */
    message: string;
  }[];
  /**
   * Non-fatal issues (low match quality, missing recommended fields, deprecation notices)
   */
  warnings?: string[];
  /**
   * Overall match quality score for the batch (0.0 = no matches, 1.0 = all matched)
   */
  match_quality?: number;
  /**
   * When true, this response contains simulated data from sandbox mode.
   */
  sandbox?: boolean;
  context?: ContextObject;
  ext?: ExtensionObject;
}
/**
 * Opaque correlation data that is echoed unchanged in responses. Used for internal tracking, UI session IDs, trace IDs, and other caller-specific identifiers that don't affect protocol behavior. Context data is never parsed by AdCP agents - it's simply preserved and returned.
 */
export interface LogEventError {
  /**
   * Operation-level errors
   */
  errors: Error[];
  context?: ContextObject;
  ext?: ExtensionObject;
}
/**
 * Standard error structure for task-specific errors and warnings
 */

// sync_audiences parameters
/**
 * Hashed identifiers for a CRM audience member. All identifiers must be normalized before hashing: emails to lowercase+trim, phone numbers to E.164 format (e.g. +12065551234). At least one identifier is required. Providing multiple identifiers for the same person improves match rates. Composite identifiers (e.g. hashed first name + last name + zip for Google Customer Match) are not yet standardized — use the ext field for platform-specific extensions.
 */
export type AudienceMember = {
  [k: string]: unknown | undefined;
} & {
  /**
   * SHA-256 hash of lowercase, trimmed email address.
   */
  hashed_email?: string;
  /**
   * SHA-256 hash of E.164-formatted phone number (e.g. +12065551234).
   */
  hashed_phone?: string;
  /**
   * Universal ID values (MAIDs, RampID, UID2, etc.) for user matching.
   *
   * @minItems 1
   */
  uids?: [
    {
      type: UIDType;
      /**
       * Universal ID value
       */
      value: string;
      [k: string]: unknown | undefined;
    },
    ...{
      type: UIDType;
      /**
       * Universal ID value
       */
      value: string;
      [k: string]: unknown | undefined;
    }[]
  ];
  ext?: ExtensionObject;
  [k: string]: unknown | undefined;
};
/**
 * Universal ID type
 */
export interface SyncAudiencesRequest {
  /**
   * Account to manage audiences for
   */
  account_id: string;
  /**
   * Audiences to sync (create or update). When omitted, the call is discovery-only and returns all existing audiences on the account without modification.
   */
  audiences?: {
    /**
     * Buyer's identifier for this audience. Used to reference the audience in targeting overlays.
     */
    audience_id: string;
    /**
     * Human-readable name for this audience
     */
    name?: string;
    /**
     * Members to add to this audience. Hashed before sending — normalize emails to lowercase+trim, phones to E.164.
     */
    add?: AudienceMember[];
    /**
     * Members to remove from this audience. If the same identifier appears in both add and remove in a single request, remove takes precedence.
     */
    remove?: AudienceMember[];
    /**
     * When true, delete this audience from the account entirely. All other fields on this audience object are ignored. Use this to delete a specific audience without affecting others.
     */
    delete?: boolean;
    /**
     * GDPR lawful basis for processing this audience list. Informational — not validated by the protocol, but required by some sellers operating in regulated markets (e.g. EU). When omitted, the buyer asserts they have a lawful basis appropriate to their jurisdiction.
     */
    consent_basis?: 'consent' | 'legitimate_interest' | 'contract' | 'legal_obligation';
  }[];
  /**
   * When true, buyer-managed audiences on the account not included in this sync will be removed. Does not affect seller-managed audiences. Do not combine with an omitted audiences array or all buyer-managed audiences will be deleted.
   */
  delete_missing?: boolean;
  context?: ContextObject;
  ext?: ExtensionObject;
}
/**
 * Extension object for platform-specific, vendor-namespaced parameters. Extensions are always optional and must be namespaced under a vendor/platform key (e.g., ext.gam, ext.roku). Used for custom capabilities, partner-specific configuration, and features being proposed for standardization.
 */

// sync_audiences response
/**
 * Response from audience sync operation. Returns either per-audience results OR operation-level errors.
 */
export type SyncAudiencesResponse = SyncAudiencesSuccess | SyncAudiencesError;

/**
 * Success response - sync operation processed audiences
 */
export interface SyncAudiencesSuccess {
  /**
   * Results for each audience on the account
   */
  audiences: {
    /**
     * Audience ID from the request (buyer's identifier)
     */
    audience_id: string;
    /**
     * Name of the audience
     */
    name?: string;
    /**
     * Seller-assigned identifier for this audience in their ad platform
     */
    seller_id?: string;
    /**
     * Action taken for this audience. 'status' is present when action is created, updated, or unchanged. 'status' is absent when action is deleted or failed.
     */
    action: 'created' | 'updated' | 'unchanged' | 'deleted' | 'failed';
    /**
     * Matching status. Present when action is created, updated, or unchanged; absent when action is deleted or failed. 'processing': platform is still matching members against its user base. 'ready': audience is available for targeting, matched_count is populated. 'too_small': matched audience is below the platform's minimum size — add more members and re-sync.
     */
    status?: 'processing' | 'ready' | 'too_small';
    /**
     * Number of members submitted in this sync operation (delta, not cumulative). In discovery-only calls (no audiences array), this is 0.
     */
    uploaded_count?: number;
    /**
     * Total members matched to platform users across all syncs (cumulative, not just this call). Populated when status is 'ready'.
     */
    matched_count?: number;
    /**
     * ISO 8601 timestamp of when the most recent sync operation was accepted by the platform. Useful for agents reasoning about audience freshness. Omitted if the seller does not track this.
     */
    last_synced_at?: string;
    /**
     * Minimum matched audience size required for targeting on this platform. Populated when status is 'too_small'. Helps agents know how many more members are needed.
     */
    minimum_size?: number;
    /**
     * Errors for this audience (only present when action='failed')
     */
    errors?: Error[];
  }[];
  /**
   * When true, this response contains simulated data from sandbox mode.
   */
  sandbox?: boolean;
  context?: ContextObject;
  ext?: ExtensionObject;
}
/**
 * Standard error structure for task-specific errors and warnings
 */
export interface SyncAudiencesError {
  /**
   * Operation-level errors that prevented processing
   */
  errors: Error[];
  context?: ContextObject;
  ext?: ExtensionObject;
}


// sync_catalogs parameters
/**
 * Catalog type. Structural types: 'offering' (AdCP Offering objects), 'product' (ecommerce entries), 'inventory' (stock per location), 'store' (physical locations), 'promotion' (deals and pricing). Vertical types: 'hotel', 'flight', 'job', 'vehicle', 'real_estate', 'education', 'destination' — each with an industry-specific item schema.
 */
export interface SyncCatalogsRequest {
  /**
   * Account that owns these catalogs. Required if the agent has multiple accounts and the seller cannot route automatically.
   */
  account_id?: string;
  /**
   * Array of catalog feeds to sync (create or update). When omitted, the call is discovery-only and returns all existing catalogs on the account without modification.
   *
   * @maxItems 50
   */
  catalogs?: Catalog[];
  /**
   * Optional filter to limit sync scope to specific catalog IDs. When provided, only these catalogs will be created/updated. Other catalogs on the account are unaffected.
   *
   * @maxItems 50
   */
  catalog_ids?: string[];
  /**
   * When true, buyer-managed catalogs on the account not included in this sync will be removed. Does not affect seller-managed catalogs. Do not combine with an omitted catalogs array or all buyer-managed catalogs will be deleted.
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
 * A typed data feed. Catalogs carry the items, locations, stock levels, or pricing that publishers use to render ads. They can be synced to a platform via sync_catalogs (managed lifecycle with approval), provided inline, or fetched from an external URL. The catalog type determines the item schema and can be structural (offering, product, inventory, store, promotion) or vertical-specific (hotel, flight, job, vehicle, real_estate, education, destination). Selectors (ids, tags, category, query) filter items regardless of sourcing method.
 */

// sync_catalogs response
/**
 * Response from catalog sync operation. Returns either per-catalog results (best-effort processing) OR operation-level errors (complete failure). Platforms may approve, reject, or flag individual items within each catalog (similar to Google Merchant Center product review).
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
  }[];
  /**
   * When true, this response contains simulated data from sandbox mode.
   */
  sandbox?: boolean;
  context?: ContextObject;
  ext?: ExtensionObject;
}
/**
 * Opaque correlation data that is echoed unchanged in responses. Used for internal tracking, UI session IDs, trace IDs, and other caller-specific identifiers that don't affect protocol behavior. Context data is never parsed by AdCP agents - it's simply preserved and returned.
 */
export interface SyncCatalogsError {
  /**
   * Operation-level errors that prevented processing any catalogs (e.g., authentication failure, service unavailable, invalid request format)
   */
  errors: Error[];
  context?: ContextObject;
  ext?: ExtensionObject;
}
/**
 * Standard error structure for task-specific errors and warnings
 */

// build_creative parameters
/**
 * Catalog type. Structural types: 'offering' (AdCP Offering objects), 'product' (ecommerce entries), 'inventory' (stock per location), 'store' (physical locations), 'promotion' (deals and pricing). Vertical types: 'hotel', 'flight', 'job', 'vehicle', 'real_estate', 'education', 'destination' — each with an industry-specific item schema.
 */
export type HTTPMethod = 'GET' | 'POST';
/**
 * Standardized macro placeholders for dynamic value substitution in creative tracking URLs. Macros are replaced with actual values at impression time. See docs/creative/universal-macros.mdx for detailed documentation.
 */
export type WebhookResponseType = 'html' | 'json' | 'xml' | 'javascript';
/**
 * Authentication method
 */
export type WebhookSecurityMethod = 'hmac_sha256' | 'api_key' | 'none';
/**
 * DAAST (Digital Audio Ad Serving Template) tag for third-party audio ad serving
 */
export type CreativeBriefReference = CreativeBrief | string;

/**
 * Request to transform or generate a creative manifest. Takes a source manifest (which may be minimal for pure generation) and produces a target manifest in the specified format.
 */
export interface BuildCreativeRequest {
  /**
   * Natural language instructions for the transformation or generation. For pure generation, this is the creative brief. For transformation, this provides guidance on how to adapt the creative.
   */
  message?: string;
  creative_manifest?: CreativeManifest;
  target_format_id: FormatID;
  brand?: BrandReference;
  creative_brief?: CreativeBriefReference;
  context?: ContextObject;
  ext?: ExtensionObject;
}
/**
 * Creative manifest to transform or generate from. For pure generation, this should include the target format_id and any required input assets. For transformation (e.g., resizing, reformatting), this is the complete creative to adapt.
 */
export interface CreativeManifest {
  format_id: FormatID;
  catalog?: Catalog;
  /**
   * Map of asset IDs to actual asset content. Each key MUST match an asset_id from the format's assets array (e.g., 'banner_image', 'clickthrough_url', 'video_file', 'vast_tag'). The asset_id is the technical identifier used to match assets to format requirements.
   *
   * IMPORTANT: Full validation requires format context. The format defines what type each asset_id should be. Standalone schema validation only checks structural conformance — each asset must match at least one valid asset type schema.
   */
  assets: {
    [k: string]: unknown | undefined;
  };
  ext?: ExtensionObject;
  [k: string]: unknown | undefined;
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
   * Universal macros that can be passed to webhook (e.g., DEVICE_TYPE, COUNTRY). See docs/creative/universal-macros.mdx for full list.
   */
  supported_macros?: (UniversalMacro | string)[];
  /**
   * Universal macros that must be provided for webhook to function
   */
  required_macros?: (UniversalMacro | string)[];
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
  [k: string]: unknown | undefined;
}
/**
 * CSS stylesheet asset
 */
export interface CreativeBrief {
  /**
   * Campaign or flight name for identification
   */
  name: string;
  /**
   * Campaign objective that guides creative tone and call-to-action strategy
   */
  objective?: 'awareness' | 'consideration' | 'conversion' | 'retention' | 'engagement';
  /**
   * Desired tone for this campaign, modulating the brand's base tone (e.g., 'playful and festive', 'premium and aspirational')
   */
  tone?: string;
  /**
   * Target audience description for this campaign
   */
  audience?: string;
  /**
   * Creative territory or positioning the campaign should occupy
   */
  territory?: string;
  /**
   * Messaging framework for the campaign
   */
  messaging?: {
    /**
     * Primary headline
     */
    headline?: string;
    /**
     * Supporting tagline or sub-headline
     */
    tagline?: string;
    /**
     * Call-to-action text
     */
    cta?: string;
    /**
     * Key messages to communicate in priority order
     */
    key_messages?: string[];
    [k: string]: unknown | undefined;
  };
  /**
   * Visual and strategic reference materials such as mood boards, product shots, example creatives, and strategy documents
   */
  reference_assets?: ReferenceAsset[];
  [k: string]: unknown | undefined;
}
/**
 * A reference asset that provides creative context. Carries visual materials (mood boards, product shots, example creatives) with semantic roles that tell creative agents how to use them.
 */
export interface ReferenceAsset {
  /**
   * URL to the reference asset (image, video, or document)
   */
  url: string;
  /**
   * How the creative agent should use this asset. style_reference: match the visual style; product_shot: include this product; mood_board: overall look and feel; example_creative: example of a similar execution; logo: logo to use; strategy_doc: strategy or planning document for context
   */
  role: 'style_reference' | 'product_shot' | 'mood_board' | 'example_creative' | 'logo' | 'strategy_doc';
  /**
   * Human-readable description of the asset and how it should inform creative generation
   */
  description?: string;
  [k: string]: unknown | undefined;
}
/**
 * Opaque correlation data that is echoed unchanged in responses. Used for internal tracking, UI session IDs, trace IDs, and other caller-specific identifiers that don't affect protocol behavior. Context data is never parsed by AdCP agents - it's simply preserved and returned.
 */

// build_creative response
/**
 * Response containing the transformed or generated creative manifest, ready for use with preview_creative or sync_creatives. Returns either the complete creative manifest OR error information, never both.
 */
export type BuildCreativeResponse = BuildCreativeSuccess | BuildCreativeError;
/**
 * Catalog type. Structural types: 'offering' (AdCP Offering objects), 'product' (ecommerce entries), 'inventory' (stock per location), 'store' (physical locations), 'promotion' (deals and pricing). Vertical types: 'hotel', 'flight', 'job', 'vehicle', 'real_estate', 'education', 'destination' — each with an industry-specific item schema.
 */
export interface BuildCreativeSuccess {
  creative_manifest: CreativeManifest;
  /**
   * When true, this response contains simulated data from sandbox mode.
   */
  sandbox?: boolean;
  context?: ContextObject;
  ext?: ExtensionObject;
}
/**
 * The generated or transformed creative manifest
 */
export interface BuildCreativeError {
  /**
   * Array of errors explaining why creative generation failed
   */
  errors: Error[];
  context?: ContextObject;
  ext?: ExtensionObject;
}
/**
 * Standard error structure for task-specific errors and warnings
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
      format_id?: FormatID;
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
         * Macro values to use for this preview. Supports all universal macros from the format's supported_macros list. See docs/creative/universal-macros.md for available macros.
         */
        macros?: {
          [k: string]: string | undefined;
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
       * @maxItems 50
       */
      requests: {
        format_id?: FormatID;
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
            [k: string]: string | undefined;
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
        output_format?: PreviewOutputFormat;
      }[];
      output_format?: PreviewOutputFormat;
      context?: ContextObject;
      ext?: ExtensionObject;
    }
  | {
      /**
       * Discriminator indicating this is a variant preview request
       */
      request_type: 'variant';
      /**
       * Platform-assigned variant identifier from get_creative_delivery response
       */
      variant_id: string;
      /**
       * Creative identifier for context
       */
      creative_id?: string;
      output_format?: PreviewOutputFormat;
      context?: ContextObject;
      ext?: ExtensionObject;
    };
/**
 * Catalog type. Structural types: 'offering' (AdCP Offering objects), 'product' (ecommerce entries), 'inventory' (stock per location), 'store' (physical locations), 'promotion' (deals and pricing). Vertical types: 'hotel', 'flight', 'job', 'vehicle', 'real_estate', 'education', 'destination' — each with an industry-specific item schema.
 */
export type PreviewOutputFormat = 'url' | 'html';
/**
 * Output format for this preview. 'url' returns preview_url, 'html' returns preview_html.
 */
export interface CreativeManifest1 {
  format_id: FormatID;
  catalog?: Catalog;
  /**
   * Map of asset IDs to actual asset content. Each key MUST match an asset_id from the format's assets array (e.g., 'banner_image', 'clickthrough_url', 'video_file', 'vast_tag'). The asset_id is the technical identifier used to match assets to format requirements.
   *
   * IMPORTANT: Full validation requires format context. The format defines what type each asset_id should be. Standalone schema validation only checks structural conformance — each asset must match at least one valid asset type schema.
   */
  assets: {
    [k: string]: unknown | undefined;
  };
  ext?: ExtensionObject;
  [k: string]: unknown | undefined;
}


// preview_creative response
/**
 * Response containing preview links for one or more creatives. Format matches the request: single preview response for single requests, batch results for batch requests.
 */
export type PreviewCreativeResponse =
  | PreviewCreativeSingleResponse
  | PreviewCreativeBatchResponse
  | PreviewCreativeVariantResponse;
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
      [k: string]: unknown | undefined;
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
      [k: string]: unknown | undefined;
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
      [k: string]: unknown | undefined;
    };
/**
 * Catalog type. Structural types: 'offering' (AdCP Offering objects), 'product' (ecommerce entries), 'inventory' (stock per location), 'store' (physical locations), 'promotion' (deals and pricing). Vertical types: 'hotel', 'flight', 'job', 'vehicle', 'real_estate', 'education', 'destination' — each with an industry-specific item schema.
 */
export interface PreviewCreativeSingleResponse {
  /**
   * Discriminator indicating this is a single preview response
   */
  response_type: 'single';
  /**
   * Array of preview variants. Each preview corresponds to an input set from the request. If no inputs were provided, returns a single default preview.
   */
  previews: {
    /**
     * Unique identifier for this preview variant
     */
    preview_id: string;
    /**
     * Array of rendered pieces for this preview variant. Most formats render as a single piece. Companion ad formats (video + banner), multi-placement formats, and adaptive formats render as multiple pieces.
     */
    renders: PreviewRender[];
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
        [k: string]: string | undefined;
      };
      /**
       * Context description applied to this variant
       */
      context_description?: string;
    };
  }[];
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
/**
 * Opaque correlation data that is echoed unchanged in responses. Used for internal tracking, UI session IDs, trace IDs, and other caller-specific identifiers that don't affect protocol behavior. Context data is never parsed by AdCP agents - it's simply preserved and returned.
 */
export interface PreviewCreativeBatchResponse {
  /**
   * Discriminator indicating this is a batch preview response
   */
  response_type: 'batch';
  /**
   * Array of preview results corresponding to each request in the same order. results[0] is the result for requests[0], results[1] for requests[1], etc. Order is guaranteed even when some requests fail. Each result contains either a successful preview response or an error.
   */
  results: (PreviewBatchResultSuccess | PreviewBatchResultError)[];
  context?: ContextObject;
  ext?: ExtensionObject;
}
export interface PreviewBatchResultSuccess {
  success?: true;
}
export interface PreviewBatchResultError {
  success?: false;
}
/**
 * Variant preview response - shows what a specific creative variant looked like when served during delivery
 */
export interface PreviewCreativeVariantResponse {
  /**
   * Discriminator indicating this is a variant preview response
   */
  response_type: 'variant';
  /**
   * Platform-assigned variant identifier
   */
  variant_id: string;
  /**
   * Creative identifier this variant belongs to
   */
  creative_id?: string;
  /**
   * Array of rendered pieces for this variant. Most formats render as a single piece.
   */
  previews: {
    /**
     * Unique identifier for this preview
     */
    preview_id: string;
    /**
     * Rendered pieces for this variant
     */
    renders: PreviewRender[];
  }[];
  manifest?: CreativeManifest;
  /**
   * ISO 8601 timestamp when preview links expire
   */
  expires_at?: string;
  context?: ContextObject;
  ext?: ExtensionObject;
}
/**
 * The rendered creative manifest for this variant — the actual output that was served, not the input assets
 */

// get_creative_delivery parameters
/**
 * Request parameters for retrieving creative delivery data including variant-level metrics from a creative agent. At least one scoping filter (media_buy_ids, media_buy_buyer_refs, or creative_ids) is required.
 */
export type GetCreativeDeliveryRequest = {
  [k: string]: unknown | undefined;
} & {
  /**
   * Account context for routing and scoping. Limits results to creatives within this account. Optional if the agent has a single account or can determine routing from the media buy identifiers.
   */
  account_id?: string;
  /**
   * Filter to specific media buys by publisher ID. If omitted, returns creative delivery across all matching media buys.
   */
  media_buy_ids?: string[];
  /**
   * Filter to specific media buys by buyer reference ID. Alternative to media_buy_ids when the buyer doesn't have the publisher's identifiers.
   */
  media_buy_buyer_refs?: string[];
  /**
   * Filter to specific creatives by ID. If omitted, returns delivery for all creatives matching the other filters.
   */
  creative_ids?: string[];
  /**
   * Start date for delivery period (YYYY-MM-DD). Interpreted in the platform's reporting timezone.
   */
  start_date?: string;
  /**
   * End date for delivery period (YYYY-MM-DD). Interpreted in the platform's reporting timezone.
   */
  end_date?: string;
  /**
   * Maximum number of variants to return per creative. When omitted, the agent returns all variants. Use this to limit response size for generative creatives that may produce large numbers of variants.
   */
  max_variants?: number;
  /**
   * Pagination parameters for the creatives array in the response. When omitted, the agent returns all matching creatives.
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
  context?: ContextObject;
  ext?: ExtensionObject;
};

/**
 * Opaque correlation data that is echoed unchanged in responses. Used for internal tracking, UI session IDs, trace IDs, and other caller-specific identifiers that don't affect protocol behavior. Context data is never parsed by AdCP agents - it's simply preserved and returned.
 */

// get_creative_delivery response
/**
 * The event type
 */
export type CreativeVariant = DeliveryMetrics & {
  /**
   * Platform-assigned identifier for this variant
   */
  variant_id: string;
  manifest?: CreativeManifest;
  /**
   * Input signals that triggered generation of this variant (Tier 3). Describes why the platform created this specific variant. Platforms should provide summarized or anonymized signals rather than raw user input. For web contexts, may include page topic or URL. For conversational contexts, an anonymized content signal. For search, query category or intent. When the content context is managed through AdCP content standards, reference the artifact directly via the artifact field.
   */
  generation_context?: {
    /**
     * Type of context that triggered generation (e.g., 'web_page', 'conversational', 'search', 'app', 'dooh')
     */
    context_type?: string;
    /**
     * Reference to the content-standards artifact that provided the generation context. Links this variant to the specific piece of content (article, video, podcast segment, etc.) where the ad was placed.
     */
    artifact?: {
      property_id: Identifier;
      /**
       * Artifact identifier within the property
       */
      artifact_id: string;
    };
    ext?: ExtensionObject;
    [k: string]: unknown | undefined;
  };
};
/**
 * Catalog type. Structural types: 'offering' (AdCP Offering objects), 'product' (ecommerce entries), 'inventory' (stock per location), 'store' (physical locations), 'promotion' (deals and pricing). Vertical types: 'hotel', 'flight', 'job', 'vehicle', 'real_estate', 'education', 'destination' — each with an industry-specific item schema.
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
 * Response payload for get_creative_delivery task. Returns creative delivery data with variant-level breakdowns including manifests and metrics.
 */
export interface GetCreativeDeliveryResponse {
  /**
   * Account identifier. Present when the response spans or is scoped to a specific account.
   */
  account_id?: string;
  /**
   * Publisher's media buy identifier. Present when the request was scoped to a single media buy.
   */
  media_buy_id?: string;
  /**
   * Buyer's reference identifier for the media buy. Echoed back so the buyer can correlate without mapping publisher IDs.
   */
  media_buy_buyer_ref?: string;
  /**
   * ISO 4217 currency code for monetary values in this response (e.g., 'USD', 'EUR')
   */
  currency: string;
  /**
   * Date range for the report.
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
    /**
     * IANA timezone identifier for the reporting period (e.g., 'America/New_York', 'UTC'). Platforms report in their native timezone.
     */
    timezone?: string;
  };
  /**
   * Creative delivery data with variant breakdowns
   */
  creatives: {
    /**
     * Creative identifier
     */
    creative_id: string;
    /**
     * Publisher's media buy identifier for this creative. Present when the request spanned multiple media buys, so the buyer can correlate each creative to its media buy.
     */
    media_buy_id?: string;
    format_id?: FormatID;
    totals?: DeliveryMetrics;
    /**
     * Total number of variants for this creative. When max_variants was specified in the request, this may exceed the number of items in the variants array.
     */
    variant_count?: number;
    /**
     * Variant-level delivery breakdown. Each variant includes the rendered manifest and delivery metrics. For standard creatives, contains a single variant. For asset group optimization, one per combination. For generative creative, one per generated execution. Empty when a creative has no variants yet.
     */
    variants: CreativeVariant[];
  }[];
  /**
   * Pagination information. Present when the request included pagination parameters.
   */
  pagination?: {
    /**
     * Maximum number of creatives requested
     */
    limit: number;
    /**
     * Number of creatives skipped
     */
    offset: number;
    /**
     * Whether more creatives are available beyond this page
     */
    has_more: boolean;
    /**
     * Total number of creatives matching the request filters
     */
    total?: number;
  };
  /**
   * Task-specific errors and warnings
   */
  errors?: Error[];
  context?: ContextObject;
  ext?: ExtensionObject;
}
/**
 * Format of this creative
 */
export interface Identifier {
  type: PropertyIdentifierTypes;
  /**
   * The identifier value. For domain type: 'example.com' matches base domain plus www and m subdomains; 'edition.example.com' matches that specific subdomain; '*.example.com' matches ALL subdomains but NOT base domain
   */
  value: string;
}
/**
 * Standard error structure for task-specific errors and warnings
 */

// get_signals parameters
/**
 * Request parameters for discovering signals. Use signal_spec for natural language discovery, signal_ids for exact lookups, or both (signal_ids take precedence for exact matches, signal_spec provides additional discovery context).
 */
export type GetSignalsRequest = {
  [k: string]: unknown | undefined;
} & {
  /**
   * Natural language description of the desired signals. When used alone, enables semantic discovery. When combined with signal_ids, provides context for the agent but signal_ids matches are returned first.
   */
  signal_spec?: string;
  /**
   * Specific signals to look up by data provider and ID. Returns exact matches from the data provider's catalog. Takes precedence over signal_spec when both are provided.
   */
  signal_ids?: SignalID[];
  /**
   * Deployment targets where signals need to be activated
   */
  deliver_to: {
    /**
     * List of deployment targets (DSPs, sales agents, etc.). If the authenticated caller matches one of these deployment targets, activation keys will be included in the response.
     */
    deployments: Destination[];
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
  pagination?: PaginationRequest;
  context?: ContextObject;
  ext?: ExtensionObject;
};
/**
 * Universal signal identifier. Uses 'source' as discriminator: 'catalog' for signals from a data provider's published catalog (verifiable), 'agent' for agent-native signals (not externally verifiable).
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
      [k: string]: unknown | undefined;
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
      [k: string]: unknown | undefined;
    };
/**
 * Types of signal catalogs available for audience targeting
 */
export type SignalCatalogType = 'marketplace' | 'custom' | 'owned';

/**
 * Filters to refine signal discovery results
 */
export interface SignalFilters {
  /**
   * Filter by catalog type
   *
   * @minItems 1
   */
  catalog_types?: [SignalCatalogType, ...SignalCatalogType[]];
  /**
   * Filter by specific data providers
   *
   * @minItems 1
   */
  data_providers?: [string, ...string[]];
  /**
   * Maximum CPM price filter
   */
  max_cpm?: number;
  /**
   * Minimum coverage requirement
   */
  min_coverage_percentage?: number;
  [k: string]: unknown | undefined;
}
/**
 * Standard cursor-based pagination parameters for list operations
 */

// get_signals response
/**
 * Universal signal identifier referencing the data provider's catalog. Use this to verify authorization and look up signal definitions.
 */
export type SignalValueType = 'binary' | 'categorical' | 'numeric';
/**
 * Catalog type of signal (marketplace, custom, owned)
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
      [k: string]: unknown | undefined;
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
      activation_key?: ActivationKey;
      /**
       * Estimated time to activate if not live, or to complete activation if in progress
       */
      estimated_activation_duration_minutes?: number;
      /**
       * Timestamp when activation completed (if is_live=true)
       */
      deployed_at?: string;
      [k: string]: unknown | undefined;
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
      [k: string]: unknown | undefined;
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
      [k: string]: unknown | undefined;
    };
/**
 * The key to use for targeting. Only present if is_live=true AND requester has access to this deployment.
 */
export interface GetSignalsResponse {
  /**
   * Array of matching signals
   */
  signals: {
    signal_id?: SignalID;
    /**
     * Opaque identifier used for activation. This is the signals agent's internal segment ID.
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
    value_type?: SignalValueType;
    signal_type: SignalCatalogType;
    /**
     * Human-readable name of the data provider
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
  pagination?: PaginationResponse;
  /**
   * When true, this response contains simulated data from sandbox mode.
   */
  sandbox?: boolean;
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
   */
  deployments: Destination[];
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
export type ActivateSignalResponse = ActivateSignalSuccess | ActivateSignalError;
/**
 * A signal deployment to a specific deployment target with activation status and key
 */
export interface ActivateSignalSuccess {
  /**
   * Array of deployment results for each deployment target
   */
  deployments: Deployment[];
  /**
   * When true, this response contains simulated data from sandbox mode.
   */
  sandbox?: boolean;
  context?: ContextObject;
  ext?: ExtensionObject;
}
/**
 * Opaque correlation data that is echoed unchanged in responses. Used for internal tracking, UI session IDs, trace IDs, and other caller-specific identifiers that don't affect protocol behavior. Context data is never parsed by AdCP agents - it's simply preserved and returned.
 */
export interface ActivateSignalError {
  /**
   * Array of errors explaining why activation failed (e.g., platform connectivity issues, signal definition problems, authentication failures)
   */
  errors: Error[];
  context?: ContextObject;
  ext?: ExtensionObject;
}
/**
 * Standard error structure for task-specific errors and warnings
 */

// create_property_list parameters
/**
 * A source of properties for a property list. Supports three selection patterns: publisher with tags, publisher with property IDs, or direct identifiers.
 */
export type BasePropertySource = PublisherTagsSource | PublisherPropertyIDsSource | DirectIdentifiersSource;
/**
 * Tag for categorizing publisher properties. Must be lowercase alphanumeric with underscores only.
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
 * Brand identifier within the house portfolio. Optional for single-brand domains.
 */
export interface CreatePropertyListRequest {
  /**
   * Human-readable name for the list
   */
  name: string;
  /**
   * Description of the list's purpose
   */
  description?: string;
  /**
   * Array of property sources to evaluate. Each entry is a discriminated union: publisher_tags (publisher_domain + tags), publisher_ids (publisher_domain + property_ids), or identifiers (direct identifiers). If omitted, queries the agent's entire property database.
   */
  base_properties?: BasePropertySource[];
  filters?: PropertyListFilters;
  brand?: BrandReference;
  context?: ContextObject;
  ext?: ExtensionObject;
}
/**
 * Select properties from a publisher by tag membership
 */
export interface PublisherTagsSource {
  /**
   * Discriminator indicating selection by property tags within a publisher
   */
  selection_type: 'publisher_tags';
  /**
   * Domain where publisher's adagents.json is hosted (e.g., 'raptive.com')
   */
  publisher_domain: string;
  /**
   * Property tags from the publisher's adagents.json. Selects all properties with these tags.
   *
   * @minItems 1
   */
  tags: [PropertyTag, ...PropertyTag[]];
}
/**
 * Select specific properties from a publisher by ID
 */
export interface PublisherPropertyIDsSource {
  /**
   * Discriminator indicating selection by specific property IDs within a publisher
   */
  selection_type: 'publisher_ids';
  /**
   * Domain where publisher's adagents.json is hosted (e.g., 'raptive.com')
   */
  publisher_domain: string;
  /**
   * Specific property IDs from the publisher's adagents.json
   *
   * @minItems 1
   */
  property_ids: [PropertyID, ...PropertyID[]];
}
/**
 * Select properties by direct identifiers (domains, app IDs, etc.) without publisher context
 */
export interface DirectIdentifiersSource {
  /**
   * Discriminator indicating selection by direct identifiers
   */
  selection_type: 'identifiers';
  /**
   * Direct property identifiers (domains, app IDs, etc.)
   *
   * @minItems 1
   */
  identifiers: [Identifier, ...Identifier[]];
}
/**
 * A property identifier with type and value. Used to identify properties across platforms (domains, app store IDs, etc.).
 */
export interface PropertyListFilters {
  /**
   * Property must have feature data for ALL listed countries (ISO codes). Required.
   *
   * @minItems 1
   */
  countries_all: [string, ...string[]];
  /**
   * Property must support ANY of the listed channels. Required.
   *
   * @minItems 1
   */
  channels_any: [MediaChannel, ...MediaChannel[]];
  /**
   * Filter to these property types
   *
   * @minItems 1
   */
  property_types?: [PropertyType, ...PropertyType[]];
  /**
   * Feature-based requirements. Property must pass ALL requirements (AND logic).
   *
   * @minItems 1
   */
  feature_requirements?: [FeatureRequirement, ...FeatureRequirement[]];
  /**
   * Identifiers to always exclude from results
   *
   * @minItems 1
   */
  exclude_identifiers?: [Identifier, ...Identifier[]];
}
/**
 * A feature-based requirement for property filtering. Use min_value/max_value for quantitative features, allowed_values for binary/categorical features.
 */
export interface FeatureRequirement {
  /**
   * Feature to evaluate (discovered via get_adcp_capabilities)
   */
  feature_id: string;
  /**
   * Minimum numeric value required (for quantitative features)
   */
  min_value?: number;
  /**
   * Maximum numeric value allowed (for quantitative features)
   */
  max_value?: number;
  /**
   * Values that pass the requirement (for binary/categorical features)
   *
   * @minItems 1
   */
  allowed_values?: [unknown, ...unknown[]];
  /**
   * How to handle properties where this feature is not covered. 'exclude' (default): property is removed from the list. 'include': property passes this requirement (fail-open).
   */
  if_not_covered?: 'exclude' | 'include';
}
/**
 * Brand reference. When provided, the agent automatically applies appropriate rules based on brand characteristics (industry, target_audience, etc.). Resolved at execution time.
 */

// create_property_list response
/**
 * A source of properties for a property list. Supports three selection patterns: publisher with tags, publisher with property IDs, or direct identifiers.
 */
export interface CreatePropertyListResponse {
  list: PropertyList;
  /**
   * Token that can be shared with sellers to authorize fetching this list. Store this - it is only returned at creation time.
   */
  auth_token: string;
  ext?: ExtensionObject;
}
/**
 * The created property list
 */
export interface PropertyList {
  /**
   * Unique identifier for this property list
   */
  list_id: string;
  /**
   * Human-readable name for the list
   */
  name: string;
  /**
   * Description of the list's purpose
   */
  description?: string;
  /**
   * Principal identity that owns this list
   */
  principal?: string;
  /**
   * Array of property sources to evaluate. Each entry is a discriminated union: publisher_tags (publisher_domain + tags), publisher_ids (publisher_domain + property_ids), or identifiers (direct identifiers). If omitted, queries the agent's entire property database.
   */
  base_properties?: BasePropertySource[];
  filters?: PropertyListFilters;
  brand?: BrandReference;
  /**
   * URL to receive notifications when the resolved list changes
   */
  webhook_url?: string;
  /**
   * Recommended cache duration for resolved list. Consumers should re-fetch after this period.
   */
  cache_duration_hours?: number;
  /**
   * When the list was created
   */
  created_at?: string;
  /**
   * When the list was last modified
   */
  updated_at?: string;
  /**
   * Number of properties in the resolved list (at time of last resolution)
   */
  property_count?: number;
}
/**
 * Select properties from a publisher by tag membership
 */

// update_property_list parameters
/**
 * A source of properties for a property list. Supports three selection patterns: publisher with tags, publisher with property IDs, or direct identifiers.
 */
export interface UpdatePropertyListRequest {
  /**
   * ID of the property list to update
   */
  list_id: string;
  /**
   * New name for the list
   */
  name?: string;
  /**
   * New description
   */
  description?: string;
  /**
   * Complete replacement for the base properties list (not a patch). Each entry is a discriminated union: publisher_tags (publisher_domain + tags), publisher_ids (publisher_domain + property_ids), or identifiers (direct identifiers).
   */
  base_properties?: BasePropertySource[];
  filters?: PropertyListFilters;
  brand?: BrandReference;
  /**
   * Update the webhook URL for list change notifications (set to empty string to remove)
   */
  webhook_url?: string;
  context?: ContextObject;
  ext?: ExtensionObject;
}
/**
 * Select properties from a publisher by tag membership
 */

// update_property_list response
/**
 * A source of properties for a property list. Supports three selection patterns: publisher with tags, publisher with property IDs, or direct identifiers.
 */
export interface UpdatePropertyListResponse {
  list: PropertyList;
  ext?: ExtensionObject;
}
/**
 * The updated property list
 */

// get_property_list parameters
/**
 * Request parameters for retrieving a property list with resolved identifiers
 */
export interface GetPropertyListRequest {
  /**
   * ID of the property list to retrieve
   */
  list_id: string;
  /**
   * Whether to apply filters and return resolved identifiers (default: true)
   */
  resolve?: boolean;
  /**
   * Pagination parameters. Uses higher limits than standard pagination because property lists can contain tens of thousands of identifiers.
   */
  pagination?: {
    /**
     * Maximum number of identifiers to return per page
     */
    max_results?: number;
    /**
     * Opaque cursor from a previous response to fetch the next page
     */
    cursor?: string;
  };
  context?: ContextObject;
  ext?: ExtensionObject;
}
/**
 * Opaque correlation data that is echoed unchanged in responses. Used for internal tracking, UI session IDs, trace IDs, and other caller-specific identifiers that don't affect protocol behavior. Context data is never parsed by AdCP agents - it's simply preserved and returned.
 */

// get_property_list response
/**
 * A source of properties for a property list. Supports three selection patterns: publisher with tags, publisher with property IDs, or direct identifiers.
 */
export interface GetPropertyListResponse {
  list: PropertyList;
  /**
   * Resolved identifiers that passed filters (if resolve=true). Cache these locally for real-time use.
   */
  identifiers?: Identifier[];
  pagination?: PaginationResponse;
  /**
   * When the list was resolved
   */
  resolved_at?: string;
  /**
   * Cache expiration timestamp. Re-fetch the list after this time to get updated identifiers.
   */
  cache_valid_until?: string;
  /**
   * Properties included in the list despite missing feature data. Only present when a feature_requirement has if_not_covered='include'. Maps feature_id to list of identifiers not covered for that feature.
   */
  coverage_gaps?: {
    [k: string]: Identifier[] | undefined;
  };
  ext?: ExtensionObject;
}
/**
 * The property list metadata (always returned)
 */

// list_property_lists parameters
/**
 * Request parameters for listing property lists
 */
export interface ListPropertyListsRequest {
  /**
   * Filter to lists owned by this principal
   */
  principal?: string;
  /**
   * Filter to lists whose name contains this string
   */
  name_contains?: string;
  pagination?: PaginationRequest;
  context?: ContextObject;
  ext?: ExtensionObject;
}
/**
 * Standard cursor-based pagination parameters for list operations
 */

// list_property_lists response
/**
 * A source of properties for a property list. Supports three selection patterns: publisher with tags, publisher with property IDs, or direct identifiers.
 */
export interface ListPropertyListsResponse {
  /**
   * Array of property lists (metadata only, not resolved properties)
   */
  lists: PropertyList[];
  pagination?: PaginationResponse;
  ext?: ExtensionObject;
}
/**
 * A managed property list with optional filters for dynamic evaluation. Lists are resolved at setup time and cached by orchestrators/sellers for real-time use.
 */

// delete_property_list parameters
/**
 * Request parameters for deleting a property list
 */
export interface DeletePropertyListRequest {
  /**
   * ID of the property list to delete
   */
  list_id: string;
  context?: ContextObject;
  ext?: ExtensionObject;
}
/**
 * Opaque correlation data that is echoed unchanged in responses. Used for internal tracking, UI session IDs, trace IDs, and other caller-specific identifiers that don't affect protocol behavior. Context data is never parsed by AdCP agents - it's simply preserved and returned.
 */

// delete_property_list response
/**
 * Response payload for delete_property_list task
 */
export interface DeletePropertyListResponse {
  /**
   * Whether the list was successfully deleted
   */
  deleted: boolean;
  /**
   * ID of the deleted list
   */
  list_id: string;
  ext?: ExtensionObject;
}
/**
 * Extension object for platform-specific, vendor-namespaced parameters. Extensions are always optional and must be namespaced under a vendor/platform key (e.g., ext.gam, ext.roku). Used for custom capabilities, partner-specific configuration, and features being proposed for standardization.
 */

// list_content_standards parameters
/**
 * Standardized advertising media channels describing how buyers allocate budget. Channels are planning abstractions, not technical substrates. See the Media Channel Taxonomy specification for detailed definitions.
 */
export interface ListContentStandardsRequest {
  /**
   * Filter by channel
   */
  channels?: MediaChannel[];
  /**
   * Filter by BCP 47 language tags
   */
  languages?: string[];
  /**
   * Filter by ISO 3166-1 alpha-2 country codes
   */
  countries?: string[];
  pagination?: PaginationRequest;
  context?: ContextObject;
  ext?: ExtensionObject;
}
/**
 * Standard cursor-based pagination parameters for list operations
 */

// list_content_standards response
/**
 * Response payload with list of content standards configurations
 */
export type ListContentStandardsResponse =
  | {
      /**
       * Array of content standards configurations matching the filter criteria
       */
      standards: ContentStandards[];
      /**
       * Field must not be present in success response
       */
      errors?: {
        [k: string]: unknown | undefined;
      };
      pagination?: PaginationResponse;
      context?: ContextObject;
      ext?: ExtensionObject;
    }
  | {
      errors: Error[];
      /**
       * Field must not be present in error response
       */
      standards?: {
        [k: string]: unknown | undefined;
      };
      context?: ContextObject;
      ext?: ExtensionObject;
    };
/**
 * Standardized advertising media channels describing how buyers allocate budget. Channels are planning abstractions, not technical substrates. See the Media Channel Taxonomy specification for detailed definitions.
 */
export type AssetAccess =
  | {
      method: 'bearer_token';
      /**
       * OAuth2 bearer token for Authorization header
       */
      token: string;
    }
  | {
      method: 'service_account';
      /**
       * Cloud provider
       */
      provider: 'gcp' | 'aws';
      /**
       * Service account credentials
       */
      credentials?: {
        [k: string]: unknown | undefined;
      };
    }
  | {
      method: 'signed_url';
    };
/**
 * Authentication for secured URLs
 */
export interface ContentStandards {
  /**
   * Unique identifier for this standards configuration
   */
  standards_id: string;
  /**
   * Human-readable name for this standards configuration
   */
  name?: string;
  /**
   * ISO 3166-1 alpha-2 country codes. Standards apply in ALL listed countries (AND logic).
   *
   * @minItems 1
   */
  countries_all?: [string, ...string[]];
  /**
   * Advertising channels. Standards apply to ANY of the listed channels (OR logic).
   *
   * @minItems 1
   */
  channels_any?: [MediaChannel, ...MediaChannel[]];
  /**
   * BCP 47 language tags (e.g., 'en', 'de', 'fr'). Standards apply to content in ANY of these languages (OR logic). Content in unlisted languages is not covered by these standards.
   *
   * @minItems 1
   */
  languages_any?: [string, ...string[]];
  /**
   * Natural language policy describing acceptable and unacceptable content contexts. Used by LLMs and human reviewers to make judgments.
   */
  policy?: string;
  /**
   * Training/test set to calibrate policy interpretation. Provides concrete examples of pass/fail decisions.
   */
  calibration_exemplars?: {
    /**
     * Artifacts that pass the content standards
     */
    pass?: Artifact[];
    /**
     * Artifacts that fail the content standards
     */
    fail?: Artifact[];
  };
  ext?: ExtensionObject;
}
/**
 * Content artifact for safety and suitability evaluation. An artifact represents content adjacent to an ad placement - a news article, podcast segment, video chapter, or social post. Artifacts are collections of assets (text, images, video, audio) plus metadata and signals.
 */
export interface Artifact {
  property_id: Identifier;
  /**
   * Identifier for this artifact within the property. The property owner defines the scheme (e.g., 'article_12345', 'episode_42_segment_3', 'post_abc123').
   */
  artifact_id: string;
  /**
   * Identifies a specific variant of this artifact. Use for A/B tests, translations, or temporal versions. Examples: 'en', 'es-MX', 'v2', 'headline_test_b'. The combination of artifact_id + variant_id must be unique.
   */
  variant_id?: string;
  format_id?: FormatID;
  /**
   * Optional URL for this artifact (web page, podcast feed, video page). Not all artifacts have URLs (e.g., Instagram content, podcast segments, TV scenes).
   */
  url?: string;
  /**
   * When the artifact was published (ISO 8601 format)
   */
  published_time?: string;
  /**
   * When the artifact was last modified (ISO 8601 format)
   */
  last_update_time?: string;
  /**
   * Artifact assets in document flow order - text blocks, images, video, audio
   */
  assets: (
    | {
        type: 'text';
        /**
         * Role of this text in the document. Use 'title' for the main artifact title, 'description' for summaries.
         */
        role?: 'title' | 'paragraph' | 'heading' | 'caption' | 'quote' | 'list_item' | 'description';
        /**
         * Text content
         */
        content: string;
        /**
         * BCP 47 language tag for this text (e.g., 'en', 'es-MX'). Useful when artifact contains mixed-language content.
         */
        language?: string;
        /**
         * Heading level (1-6), only for role=heading
         */
        heading_level?: number;
      }
    | {
        type: 'image';
        /**
         * Image URL
         */
        url: string;
        access?: AssetAccess;
        /**
         * Alt text or image description
         */
        alt_text?: string;
        /**
         * Image caption
         */
        caption?: string;
        /**
         * Image width in pixels
         */
        width?: number;
        /**
         * Image height in pixels
         */
        height?: number;
      }
    | {
        type: 'video';
        /**
         * Video URL
         */
        url: string;
        access?: AssetAccess;
        /**
         * Video duration in milliseconds
         */
        duration_ms?: number;
        /**
         * Video transcript
         */
        transcript?: string;
        /**
         * How the transcript was generated
         */
        transcript_source?: 'original_script' | 'subtitles' | 'closed_captions' | 'dub' | 'generated';
        /**
         * Video thumbnail URL
         */
        thumbnail_url?: string;
      }
    | {
        type: 'audio';
        /**
         * Audio URL
         */
        url: string;
        access?: AssetAccess;
        /**
         * Audio duration in milliseconds
         */
        duration_ms?: number;
        /**
         * Audio transcript
         */
        transcript?: string;
        /**
         * How the transcript was generated
         */
        transcript_source?: 'original_script' | 'closed_captions' | 'generated';
      }
  )[];
  /**
   * Rich metadata extracted from the artifact
   */
  metadata?: {
    /**
     * Canonical URL
     */
    canonical?: string;
    /**
     * Artifact author name
     */
    author?: string;
    /**
     * Artifact keywords
     */
    keywords?: string;
    /**
     * Open Graph protocol metadata
     */
    open_graph?: {
      [k: string]: unknown | undefined;
    };
    /**
     * Twitter Card metadata
     */
    twitter_card?: {
      [k: string]: unknown | undefined;
    };
    /**
     * JSON-LD structured data (schema.org)
     */
    json_ld?: {}[];
    [k: string]: unknown | undefined;
  };
  /**
   * Platform-specific identifiers for this artifact
   */
  identifiers?: {
    /**
     * Apple Podcasts ID
     */
    apple_podcast_id?: string;
    /**
     * Spotify show ID
     */
    spotify_show_id?: string;
    /**
     * Podcast GUID (from RSS feed)
     */
    podcast_guid?: string;
    /**
     * YouTube video ID
     */
    youtube_video_id?: string;
    /**
     * RSS feed URL
     */
    rss_url?: string;
    [k: string]: unknown | undefined;
  };
  [k: string]: unknown | undefined;
}
/**
 * Identifier for the property where this artifact appears
 */

// get_content_standards parameters
/**
 * Request parameters for retrieving content safety policies
 */
export interface GetContentStandardsRequest {
  /**
   * Identifier for the standards configuration to retrieve
   */
  standards_id: string;
  context?: ContextObject;
  ext?: ExtensionObject;
}
/**
 * Opaque correlation data that is echoed unchanged in responses. Used for internal tracking, UI session IDs, trace IDs, and other caller-specific identifiers that don't affect protocol behavior. Context data is never parsed by AdCP agents - it's simply preserved and returned.
 */

// get_content_standards response
/**
 * Response payload with content safety policies
 */
export type GetContentStandardsResponse =
  | ContentStandards
  | {
      errors: Error[];
      /**
       * Field must not be present in error response
       */
      standards_id?: {
        [k: string]: unknown | undefined;
      };
      context?: ContextObject;
      ext?: ExtensionObject;
    };
/**
 * Standardized advertising media channels describing how buyers allocate budget. Channels are planning abstractions, not technical substrates. See the Media Channel Taxonomy specification for detailed definitions.
 */

// create_content_standards parameters
/**
 * Standardized advertising media channels describing how buyers allocate budget. Channels are planning abstractions, not technical substrates. See the Media Channel Taxonomy specification for detailed definitions.
 */
export interface CreateContentStandardsRequest {
  /**
   * Where this standards configuration applies
   */
  scope: {
    /**
     * ISO 3166-1 alpha-2 country codes. Standards apply in ALL listed countries (AND logic).
     */
    countries_all?: string[];
    /**
     * Advertising channels. Standards apply to ANY of the listed channels (OR logic).
     */
    channels_any?: MediaChannel[];
    /**
     * BCP 47 language tags (e.g., 'en', 'de', 'fr'). Standards apply to content in ANY of these languages (OR logic). Content in unlisted languages is not covered by these standards.
     */
    languages_any: string[];
    /**
     * Human-readable description of this scope
     */
    description?: string;
  };
  /**
   * Natural language policy describing acceptable and unacceptable content contexts. Used by LLMs and human reviewers to make judgments.
   */
  policy: string;
  /**
   * Training/test set to calibrate policy interpretation. Use URL references for pages to be fetched and analyzed, or full artifacts for pre-extracted content.
   */
  calibration_exemplars?: {
    /**
     * Content that passes the standards
     */
    pass?: (
      | {
          /**
           * Indicates this is a URL reference
           */
          type: 'url';
          /**
           * Full URL to a specific page (e.g., 'https://espn.com/nba/story/_/id/12345/lakers-win')
           */
          value: string;
          /**
           * BCP 47 language tag for content at this URL
           */
          language?: string;
        }
      | Artifact
    )[];
    /**
     * Content that fails the standards
     */
    fail?: (
      | {
          /**
           * Indicates this is a URL reference
           */
          type: 'url';
          /**
           * Full URL to a specific page (e.g., 'https://news.example.com/controversial-article')
           */
          value: string;
          /**
           * BCP 47 language tag for content at this URL
           */
          language?: string;
        }
      | Artifact
    )[];
  };
  context?: ContextObject;
  ext?: ExtensionObject;
}
/**
 * Full artifact with pre-extracted content (text, images, video, audio)
 */
export type CreateContentStandardsResponse =
  | {
      /**
       * Unique identifier for the created standards configuration
       */
      standards_id: string;
      /**
       * Field must not be present in success response
       */
      errors?: {
        [k: string]: unknown | undefined;
      };
      context?: ContextObject;
      ext?: ExtensionObject;
    }
  | {
      errors: Error[];
      /**
       * If the error is a scope conflict, the ID of the existing standards that conflict
       */
      conflicting_standards_id?: string;
      /**
       * Field must not be present in error response
       */
      standards_id?: {
        [k: string]: unknown | undefined;
      };
      context?: ContextObject;
      ext?: ExtensionObject;
    };

/**
 * Opaque correlation data that is echoed unchanged in responses. Used for internal tracking, UI session IDs, trace IDs, and other caller-specific identifiers that don't affect protocol behavior. Context data is never parsed by AdCP agents - it's simply preserved and returned.
 */

// update_content_standards parameters
/**
 * Standardized advertising media channels describing how buyers allocate budget. Channels are planning abstractions, not technical substrates. See the Media Channel Taxonomy specification for detailed definitions.
 */
export interface UpdateContentStandardsRequest {
  /**
   * ID of the standards configuration to update
   */
  standards_id: string;
  /**
   * Updated scope for where this standards configuration applies
   */
  scope?: {
    /**
     * ISO 3166-1 alpha-2 country codes. Standards apply in ALL listed countries (AND logic).
     */
    countries_all?: string[];
    /**
     * Advertising channels. Standards apply to ANY of the listed channels (OR logic).
     */
    channels_any?: MediaChannel[];
    /**
     * BCP 47 language tags (e.g., 'en', 'de', 'fr'). Standards apply to content in ANY of these languages (OR logic). Content in unlisted languages is not covered by these standards.
     */
    languages_any?: string[];
    /**
     * Human-readable description of this scope
     */
    description?: string;
  };
  /**
   * Updated natural language policy describing acceptable and unacceptable content contexts.
   */
  policy?: string;
  /**
   * Updated training/test set to calibrate policy interpretation. Use URL references for pages to be fetched and analyzed, or full artifacts for pre-extracted content.
   */
  calibration_exemplars?: {
    /**
     * Content that passes the standards
     */
    pass?: (
      | {
          /**
           * Indicates this is a URL reference
           */
          type: 'url';
          /**
           * Full URL to a specific page (e.g., 'https://espn.com/nba/story/_/id/12345/lakers-win')
           */
          value: string;
          /**
           * BCP 47 language tag for content at this URL
           */
          language?: string;
        }
      | Artifact
    )[];
    /**
     * Content that fails the standards
     */
    fail?: (
      | {
          /**
           * Indicates this is a URL reference
           */
          type: 'url';
          /**
           * Full URL to a specific page (e.g., 'https://news.example.com/controversial-article')
           */
          value: string;
          /**
           * BCP 47 language tag for content at this URL
           */
          language?: string;
        }
      | Artifact
    )[];
  };
  context?: ContextObject;
  ext?: ExtensionObject;
}
/**
 * Full artifact with pre-extracted content (text, images, video, audio)
 */

// update_content_standards response
/**
 * Response from updating a content standards configuration
 */
export interface UpdateContentStandardsResponse {
  /**
   * ID of the updated standards configuration
   */
  standards_id?: string;
  /**
   * Errors that occurred during the update
   */
  errors?: Error[];
  /**
   * If scope change conflicts with another configuration, the ID of the conflicting standards
   */
  conflicting_standards_id?: string;
  context?: ContextObject;
  ext?: ExtensionObject;
}
/**
 * Standard error structure for task-specific errors and warnings
 */

// calibrate_content parameters
/**
 * Type of identifier
 */
export interface CalibrateContentRequest {
  /**
   * Standards configuration to calibrate against
   */
  standards_id: string;
  artifact: Artifact;
}
/**
 * Artifact to evaluate
 */

// calibrate_content response
/**
 * Response payload with verdict and detailed explanations for collaborative calibration
 */
export type CalibrateContentResponse =
  | {
      /**
       * Overall pass/fail verdict for the content evaluation
       */
      verdict: 'pass' | 'fail';
      /**
       * Model confidence in the verdict (0-1)
       */
      confidence?: number;
      /**
       * Detailed natural language explanation of the decision
       */
      explanation?: string;
      /**
       * Per-feature breakdown with explanations
       */
      features?: {
        /**
         * Which feature was evaluated (e.g., brand_safety, brand_suitability, competitor_adjacency)
         */
        feature_id: string;
        /**
         * Evaluation status for this feature
         */
        status: 'passed' | 'failed' | 'warning' | 'unevaluated';
        /**
         * Human-readable explanation of why this feature passed or failed
         */
        explanation?: string;
      }[];
      /**
       * Field must not be present in success response
       */
      errors?: {
        [k: string]: unknown | undefined;
      };
    }
  | {
      errors: Error[];
      /**
       * Field must not be present in error response
       */
      verdict?: {
        [k: string]: unknown | undefined;
      };
    };

/**
 * Standard error structure for task-specific errors and warnings
 */

// validate_content_delivery parameters
/**
 * Type of identifier
 */
export interface ValidateContentDeliveryRequest {
  /**
   * Standards configuration to validate against
   */
  standards_id: string;
  /**
   * Delivery records to validate (max 10,000)
   *
   * @maxItems 10000
   */
  records: {
    /**
     * Unique identifier for this delivery record
     */
    record_id: string;
    /**
     * Media buy this record belongs to (when batching across multiple buys)
     */
    media_buy_id?: string;
    /**
     * When the delivery occurred
     */
    timestamp?: string;
    artifact: Artifact;
    /**
     * ISO 3166-1 alpha-2 country code where delivery occurred
     */
    country?: string;
    /**
     * Channel type (e.g., display, video, audio, social)
     */
    channel?: string;
    /**
     * Brand information for policy evaluation. Schema TBD - placeholder for brand identifiers.
     */
    brand_context?: {
      /**
       * Brand identifier
       */
      brand_id?: string;
      /**
       * Product/SKU identifier if applicable
       */
      sku_id?: string;
    };
  }[];
  /**
   * Specific features to evaluate (defaults to all)
   */
  feature_ids?: string[];
  /**
   * Include passed records in results
   */
  include_passed?: boolean;
  context?: ContextObject;
  ext?: ExtensionObject;
}
/**
 * Artifact where ad was delivered
 */

// validate_content_delivery response
/**
 * Response payload with per-record verdicts and optional feature breakdown
 */
export type ValidateContentDeliveryResponse =
  | {
      /**
       * Summary counts across all records
       */
      summary: {
        total_records: number;
        passed_records: number;
        failed_records: number;
      };
      /**
       * Per-record evaluation results
       */
      results: {
        /**
         * Which delivery record was evaluated
         */
        record_id: string;
        /**
         * Overall pass/fail verdict for this record
         */
        verdict: 'pass' | 'fail';
        /**
         * Optional feature-level breakdown
         */
        features?: {
          feature_id: string;
          status: 'passed' | 'failed' | 'warning' | 'unevaluated';
          value?: unknown;
          message?: string;
          /**
           * Which rule triggered this result (e.g., GARM category, Scope3 standard)
           */
          rule_id?: string;
        }[];
      }[];
      /**
       * Field must not be present in success response
       */
      errors?: {
        [k: string]: unknown | undefined;
      };
      context?: ContextObject;
      ext?: ExtensionObject;
    }
  | {
      errors: Error[];
      /**
       * Field must not be present in error response
       */
      summary?: {
        [k: string]: unknown | undefined;
      };
      context?: ContextObject;
      ext?: ExtensionObject;
    };

/**
 * Opaque correlation data that is echoed unchanged in responses. Used for internal tracking, UI session IDs, trace IDs, and other caller-specific identifiers that don't affect protocol behavior. Context data is never parsed by AdCP agents - it's simply preserved and returned.
 */

// get_media_buy_artifacts parameters
/**
 * Request parameters for retrieving content artifacts from a media buy for validation
 */
export interface GetMediaBuyArtifactsRequest {
  /**
   * Filter artifacts to a specific account. When provided, only returns artifacts for media buys belonging to this account. When omitted, returns artifacts across all accessible accounts. Optional if the agent has a single account.
   */
  account_id?: string;
  /**
   * Media buy to get artifacts from
   */
  media_buy_id: string;
  /**
   * Filter to specific packages within the media buy
   */
  package_ids?: string[];
  /**
   * Sampling parameters. Defaults to the sampling rate agreed in the media buy.
   */
  sampling?: {
    /**
     * Sampling rate (0-1). 1.0 = all deliveries, 0.25 = 25% sample.
     */
    rate?: number;
    /**
     * How to select the sample
     */
    method?: 'random' | 'stratified' | 'recent' | 'failures_only';
  };
  /**
   * Filter to specific time period
   */
  time_range?: {
    /**
     * Start of time range (inclusive)
     */
    start?: string;
    /**
     * End of time range (exclusive)
     */
    end?: string;
  };
  /**
   * Pagination parameters. Uses higher limits than standard pagination because artifact result sets can be very large.
   */
  pagination?: {
    /**
     * Maximum number of artifacts to return per page
     */
    max_results?: number;
    /**
     * Opaque cursor from a previous response to fetch the next page
     */
    cursor?: string;
  };
  context?: ContextObject;
  ext?: ExtensionObject;
}
/**
 * Opaque correlation data that is echoed unchanged in responses. Used for internal tracking, UI session IDs, trace IDs, and other caller-specific identifiers that don't affect protocol behavior. Context data is never parsed by AdCP agents - it's simply preserved and returned.
 */

// get_media_buy_artifacts response
/**
 * Response containing content artifacts from a media buy for validation
 */
export type GetMediaBuyArtifactsResponse =
  | {
      /**
       * Media buy these artifacts belong to
       */
      media_buy_id: string;
      /**
       * Delivery records with full artifact content
       */
      artifacts: {
        /**
         * Unique identifier for this delivery record
         */
        record_id: string;
        /**
         * When the delivery occurred
         */
        timestamp?: string;
        /**
         * Which package this delivery belongs to
         */
        package_id?: string;
        artifact: Artifact;
        /**
         * ISO 3166-1 alpha-2 country code where delivery occurred
         */
        country?: string;
        /**
         * Channel type (e.g., display, video, audio, social)
         */
        channel?: string;
        /**
         * Brand information for policy evaluation. Schema TBD - placeholder for brand identifiers.
         */
        brand_context?: {
          /**
           * Brand identifier
           */
          brand_id?: string;
          /**
           * Product/SKU identifier if applicable
           */
          sku_id?: string;
        };
        /**
         * Seller's local model verdict for this artifact
         */
        local_verdict?: 'pass' | 'fail' | 'unevaluated';
      }[];
      /**
       * Information about how the sample was generated
       */
      sampling_info?: {
        /**
         * Total deliveries in the time range
         */
        total_deliveries?: number;
        /**
         * Number of artifacts in this response
         */
        sampled_count?: number;
        /**
         * Actual sampling rate achieved
         */
        effective_rate?: number;
        /**
         * Sampling method used
         */
        method?: 'random' | 'stratified' | 'recent' | 'failures_only';
      };
      pagination?: PaginationResponse;
      /**
       * Field must not be present in success response
       */
      errors?: {
        [k: string]: unknown | undefined;
      };
      context?: ContextObject;
      ext?: ExtensionObject;
    }
  | {
      errors: Error[];
      /**
       * Field must not be present in error response
       */
      media_buy_id?: {
        [k: string]: unknown | undefined;
      };
      context?: ContextObject;
      ext?: ExtensionObject;
    };
/**
 * Type of identifier
 */

// si_get_offering parameters
/**
 * Get offering details and availability before session handoff. Returns offering information, availability status, and optionally matching products based on context.
 */
export interface SIGetOfferingRequest {
  /**
   * Offering identifier from the catalog to get details for
   */
  offering_id: string;
  /**
   * Optional natural language context about user intent for personalized results (e.g., 'mens size 14 near Cincinnati'). Must be anonymous - no PII.
   */
  context?: string;
  /**
   * Whether to include matching products in the response
   */
  include_products?: boolean;
  /**
   * Maximum number of matching products to return
   */
  product_limit?: number;
  ext?: ExtensionObject;
}
/**
 * Extension object for platform-specific, vendor-namespaced parameters. Extensions are always optional and must be namespaced under a vendor/platform key (e.g., ext.gam, ext.roku). Used for custom capabilities, partner-specific configuration, and features being proposed for standardization.
 */

// si_get_offering response
/**
 * Offering details, availability status, and optionally matching products. Use the offering_token in si_initiate_session for correlation.
 */
export interface SIGetOfferingResponse {
  /**
   * Whether the offering is currently available
   */
  available: boolean;
  /**
   * Token to pass to si_initiate_session for session continuity. Brand stores the full query context server-side (products shown, order, context) so they can resolve references like 'the second one' when the session starts.
   */
  offering_token?: string;
  /**
   * How long this offering information is valid (seconds). Host should re-fetch after TTL expires.
   */
  ttl_seconds?: number;
  /**
   * When this offering information was retrieved
   */
  checked_at?: string;
  /**
   * Offering details
   */
  offering?: {
    /**
     * Offering identifier
     */
    offering_id?: string;
    /**
     * Offering title
     */
    title?: string;
    /**
     * Brief summary of the offering
     */
    summary?: string;
    /**
     * Short promotional tagline
     */
    tagline?: string;
    /**
     * When this offering expires
     */
    expires_at?: string;
    /**
     * Price indication (e.g., 'from $199', '50% off')
     */
    price_hint?: string;
    /**
     * Hero image for the offering
     */
    image_url?: string;
    /**
     * Landing page URL
     */
    landing_url?: string;
  };
  /**
   * Products matching the request context. Only included if include_products was true.
   */
  matching_products?: {
    /**
     * Product identifier
     */
    product_id: string;
    /**
     * Product name
     */
    name: string;
    /**
     * Display price (e.g., '$129', '$89.99')
     */
    price?: string;
    /**
     * Original price if on sale
     */
    original_price?: string;
    /**
     * Product image
     */
    image_url?: string;
    /**
     * Brief availability info (e.g., 'In stock', 'Size 14 available', '3 left')
     */
    availability_summary?: string;
    /**
     * Product detail page URL
     */
    url?: string;
  }[];
  /**
   * Total number of products matching the context (may be more than returned in matching_products)
   */
  total_matching?: number;
  /**
   * If not available, why (e.g., 'expired', 'sold_out', 'region_restricted')
   */
  unavailable_reason?: string;
  /**
   * Alternative offerings to consider if this one is unavailable
   */
  alternative_offering_ids?: string[];
  /**
   * Errors during offering lookup
   */
  errors?: Error[];
  ext?: ExtensionObject;
}
/**
 * Standard error structure for task-specific errors and warnings
 */

// si_initiate_session parameters
/**
 * Host initiates a session with a brand agent
 */
export interface SIInitiateSessionRequest {
  /**
   * Conversation handoff from the host describing what the user needs
   */
  context: string;
  identity: SIIdentity;
  /**
   * AdCP media buy ID if session was triggered by advertising
   */
  media_buy_id?: string;
  /**
   * Where this session was triggered (e.g., 'chatgpt_search', 'claude_chat')
   */
  placement?: string;
  /**
   * Brand-specific offering identifier to apply
   */
  offering_id?: string;
  supported_capabilities?: SICapabilities;
  /**
   * Token from si_get_offering response for session continuity. Brand uses this to recall what products were shown to the user, enabling natural references like 'the second one' or 'that blue shoe'.
   */
  offering_token?: string;
  ext?: ExtensionObject;
}
/**
 * User identity shared with brand agent (with explicit consent)
 */
export interface SIIdentity {
  /**
   * Whether user consented to share identity
   */
  consent_granted: boolean;
  /**
   * When consent was granted (ISO 8601)
   */
  consent_timestamp?: string;
  /**
   * What data was consented to share
   */
  consent_scope?: ('name' | 'email' | 'shipping_address' | 'phone' | 'locale')[];
  /**
   * Brand privacy policy acknowledgment
   */
  privacy_policy_acknowledged?: {
    /**
     * URL to brand's privacy policy
     */
    brand_policy_url?: string;
    /**
     * Version of policy acknowledged
     */
    brand_policy_version?: string;
    [k: string]: unknown | undefined;
  };
  /**
   * User data (only present if consent_granted is true)
   */
  user?: {
    /**
     * User's email address
     */
    email?: string;
    /**
     * User's display name
     */
    name?: string;
    /**
     * User's locale (e.g., en-US)
     */
    locale?: string;
    /**
     * User's phone number
     */
    phone?: string;
    /**
     * User's shipping address for accurate pricing
     */
    shipping_address?: {
      street?: string;
      city?: string;
      state?: string;
      postal_code?: string;
      country?: string;
      [k: string]: unknown | undefined;
    };
    [k: string]: unknown | undefined;
  };
  /**
   * Session ID for anonymous users (when consent_granted is false)
   */
  anonymous_session_id?: string;
  [k: string]: unknown | undefined;
}
/**
 * What capabilities the host supports
 */
export interface SICapabilities {
  /**
   * Interaction modalities supported
   */
  modalities?: {
    /**
     * Pure text exchange - the baseline modality
     */
    conversational?: boolean;
    /**
     * Audio-based interaction using brand voice
     */
    voice?:
      | boolean
      | {
          /**
           * TTS provider (elevenlabs, openai, etc.)
           */
          provider?: string;
          /**
           * Brand voice identifier
           */
          voice_id?: string;
          [k: string]: unknown | undefined;
        };
    /**
     * Brand video content playback
     */
    video?:
      | boolean
      | {
          /**
           * Supported video formats (mp4, webm, etc.)
           */
          formats?: string[];
          /**
           * Maximum video duration
           */
          max_duration_seconds?: number;
          [k: string]: unknown | undefined;
        };
    /**
     * Animated video presence with brand avatar
     */
    avatar?:
      | boolean
      | {
          /**
           * Avatar provider (d-id, heygen, synthesia, etc.)
           */
          provider?: string;
          /**
           * Brand avatar identifier
           */
          avatar_id?: string;
          [k: string]: unknown | undefined;
        };
    [k: string]: unknown | undefined;
  };
  /**
   * Visual components supported
   */
  components?: {
    /**
     * Standard components that all SI hosts must render
     */
    standard?: ('text' | 'link' | 'image' | 'product_card' | 'carousel' | 'action_button')[];
    /**
     * Platform-specific extensions (chatgpt_apps_sdk, maps, forms, etc.)
     */
    extensions?: {
      [k: string]: unknown | undefined;
    };
    [k: string]: unknown | undefined;
  };
  /**
   * Commerce capabilities
   */
  commerce?: {
    /**
     * Supports ACP (Agentic Commerce Protocol) checkout handoff
     */
    acp_checkout?: boolean;
    [k: string]: unknown | undefined;
  };
  /**
   * A2UI (Agent-to-UI) capabilities
   */
  a2ui?: {
    /**
     * Supports A2UI surface rendering
     */
    supported?: boolean;
    /**
     * Supported A2UI component catalogs (e.g., 'si-standard', 'standard')
     */
    catalogs?: string[];
    [k: string]: unknown | undefined;
  };
  /**
   * Supports MCP Apps for rendering A2UI surfaces in iframes
   */
  mcp_apps?: boolean;
  [k: string]: unknown | undefined;
}
/**
 * Extension object for platform-specific, vendor-namespaced parameters. Extensions are always optional and must be namespaced under a vendor/platform key (e.g., ext.gam, ext.roku). Used for custom capabilities, partner-specific configuration, and features being proposed for standardization.
 */

// si_initiate_session response
/**
 * Standard visual component that brand returns and host renders
 */
export type SIUIElement = {
  [k: string]: unknown | undefined;
} & {
  /**
   * Component type
   */
  type:
    | 'text'
    | 'link'
    | 'image'
    | 'product_card'
    | 'carousel'
    | 'action_button'
    | 'app_handoff'
    | 'integration_actions';
  /**
   * Component-specific data
   */
  data?: {
    [k: string]: unknown | undefined;
  };
  [k: string]: unknown | undefined;
};

/**
 * Brand agent's response to session initiation
 */
export interface SIInitiateSessionResponse {
  /**
   * Unique session identifier for subsequent messages
   */
  session_id: string;
  /**
   * Brand agent's initial response
   */
  response?: {
    /**
     * Conversational message from brand agent
     */
    message?: string;
    /**
     * Visual components to render
     */
    ui_elements?: SIUIElement[];
  };
  negotiated_capabilities?: SICapabilities;
  /**
   * Errors during session initiation
   */
  errors?: Error[];
  ext?: ExtensionObject;
}
/**
 * Intersection of brand and host capabilities for this session
 */

// si_send_message parameters
/**
 * Send a message to the brand agent within an active session
 */
export type SISendMessageRequest = {
  [k: string]: unknown | undefined;
} & {
  /**
   * Active session identifier
   */
  session_id: string;
  /**
   * User's message to the brand agent
   */
  message?: string;
  /**
   * Response to a previous action_button (e.g., user clicked checkout)
   */
  action_response?: {
    /**
     * The action that was triggered
     */
    action?: string;
    /**
     * Action-specific response data
     */
    payload?: {};
  };
  ext?: ExtensionObject;
};

/**
 * Extension object for platform-specific, vendor-namespaced parameters. Extensions are always optional and must be namespaced under a vendor/platform key (e.g., ext.gam, ext.roku). Used for custom capabilities, partner-specific configuration, and features being proposed for standardization.
 */

// si_send_message response
/**
 * Standard visual component that brand returns and host renders
 */
export interface SISendMessageResponse {
  /**
   * Session identifier
   */
  session_id: string;
  /**
   * Brand agent's response
   */
  response?: {
    /**
     * Conversational message from brand agent
     */
    message?: string;
    surface?: A2UISurface;
    /**
     * @deprecated
     * Visual components to render (DEPRECATED: use surface instead)
     */
    ui_elements?: SIUIElement[];
  };
  /**
   * MCP resource URI for hosts with MCP Apps support (e.g., ui://si/session-abc123)
   */
  mcp_resource_uri?: string;
  /**
   * Current session status
   */
  session_status: 'active' | 'pending_handoff' | 'complete';
  /**
   * Handoff request when session_status is pending_handoff
   */
  handoff?: {
    /**
     * Type of handoff: transaction (ready for ACP checkout) or complete (conversation done)
     */
    type?: 'transaction' | 'complete';
    /**
     * For transaction handoffs: what the user wants to purchase
     */
    intent?: {
      /**
       * The commerce action (e.g., 'purchase')
       */
      action?: string;
      /**
       * Product details for checkout
       */
      product?: {};
      /**
       * Price information
       */
      price?: {
        amount?: number;
        currency?: string;
      };
    };
    /**
     * Context to pass to ACP for seamless checkout
     */
    context_for_checkout?: {
      /**
       * Summary of the conversation leading to purchase
       */
      conversation_summary?: string;
      /**
       * Offer IDs that were applied during the conversation
       */
      applied_offers?: string[];
    };
  };
  errors?: Error[];
  ext?: ExtensionObject;
}
/**
 * A2UI surface with interactive components
 */
export interface A2UISurface {
  /**
   * Unique identifier for this surface
   */
  surfaceId: string;
  /**
   * Component catalog to use for rendering
   */
  catalogId?: string;
  /**
   * Flat list of components (adjacency list structure)
   */
  components: A2UIComponent[];
  /**
   * ID of the root component (if not specified, first component is root)
   */
  rootId?: string;
  /**
   * Application data that components can bind to
   */
  dataModel?: {
    [k: string]: unknown | undefined;
  };
  [k: string]: unknown | undefined;
}
/**
 * A component in an A2UI surface
 */
export interface A2UIComponent {
  /**
   * Unique identifier for this component within the surface
   */
  id: string;
  /**
   * ID of the parent component (null for root)
   */
  parentId?: string;
  /**
   * Component definition (keyed by component type)
   */
  component: {
    /**
     * Component properties
     */
    [k: string]: {} | undefined;
  };
  [k: string]: unknown | undefined;
}
/**
 * Standard error structure for task-specific errors and warnings
 */

// si_terminate_session parameters
/**
 * Request to terminate an SI session
 */
export interface SITerminateSessionRequest {
  /**
   * Session identifier to terminate
   */
  session_id: string;
  /**
   * Reason for termination
   */
  reason: 'handoff_transaction' | 'handoff_complete' | 'user_exit' | 'session_timeout' | 'host_terminated';
  /**
   * Context for the termination
   */
  termination_context?: {
    /**
     * Summary of the conversation
     */
    summary?: string;
    /**
     * For handoff_transaction - what user wants to buy
     */
    transaction_intent?: {
      action?: 'purchase' | 'subscribe';
      /**
       * Product/service details
       */
      product?: {};
    };
    /**
     * For host_terminated - why host ended session
     */
    cause?: string;
  };
  ext?: ExtensionObject;
}
/**
 * Extension object for platform-specific, vendor-namespaced parameters. Extensions are always optional and must be namespaced under a vendor/platform key (e.g., ext.gam, ext.roku). Used for custom capabilities, partner-specific configuration, and features being proposed for standardization.
 */

// si_terminate_session response
/**
 * Confirmation of session termination
 */
export interface SITerminateSessionResponse {
  /**
   * Terminated session identifier
   */
  session_id: string;
  /**
   * Whether session was successfully terminated
   */
  terminated: boolean;
  /**
   * ACP checkout handoff data (for handoff_transaction)
   */
  acp_handoff?: {
    /**
     * ACP checkout initiation URL
     */
    checkout_url?: string;
    /**
     * Token for ACP checkout flow
     */
    checkout_token?: string;
    /**
     * Product details for checkout
     */
    product?: {};
  };
  /**
   * Suggested follow-up actions
   */
  follow_up?: {
    action?: 'save_for_later' | 'set_reminder' | 'subscribe_updates' | 'none';
    /**
     * Data for follow-up action
     */
    data?: {};
  };
  errors?: Error[];
  ext?: ExtensionObject;
}
/**
 * Standard error structure for task-specific errors and warnings
 */

// get_adcp_capabilities parameters
/**
 * Request payload for get_adcp_capabilities task. Protocol-level capability discovery that works across all AdCP protocols.
 */
export interface GetAdCPCapabilitiesRequest {
  /**
   * Specific protocols to query capabilities for. If omitted, returns capabilities for all supported protocols.
   */
  protocols?: ('media_buy' | 'signals' | 'governance' | 'sponsored_intelligence' | 'creative')[];
  context?: ContextObject;
  ext?: ExtensionObject;
}
/**
 * Opaque correlation data that is echoed unchanged in responses. Used for internal tracking, UI session IDs, trace IDs, and other caller-specific identifiers that don't affect protocol behavior. Context data is never parsed by AdCP agents - it's simply preserved and returned.
 */

// get_adcp_capabilities response
/**
 * Methods for verifying user age for compliance. Does not include 'inferred' as it is not accepted for regulatory compliance.
 */
export interface GetAdCPCapabilitiesResponse {
  /**
   * Core AdCP protocol information
   */
  adcp: {
    /**
     * AdCP major versions supported by this seller. Major versions indicate breaking changes.
     */
    major_versions: number[];
  };
  /**
   * Which AdCP domain protocols this seller supports
   */
  supported_protocols: ('media_buy' | 'signals' | 'governance' | 'sponsored_intelligence' | 'creative')[];
  /**
   * Account management capabilities. Describes how accounts are established, what billing models are supported, and whether an account is required before browsing products.
   */
  account?: {
    /**
     * Whether the seller requires operator-level credentials. When false (default), the seller trusts the agent's identity claims — the agent authenticates once and declares brands/operators via sync_accounts. When true, each operator must authenticate independently with the seller, and the agent opens a per-operator session using the operator's credential.
     */
    require_operator_auth?: boolean;
    /**
     * OAuth authorization endpoint for obtaining operator-level credentials. Present when the seller supports OAuth for operator authentication. The agent directs the operator to this URL to authenticate and obtain a bearer token. If absent and require_operator_auth is true, operators obtain credentials out-of-band (e.g., seller portal, API key).
     */
    authorization_endpoint?: string;
    /**
     * Billing models this seller supports. brand: seller invoices the brand directly. operator: seller invoices the operator (agency). agent: agent consolidates billing.
     */
    supported_billing: ('brand' | 'operator' | 'agent')[];
    /**
     * The billing model applied when the agent omits billing from a sync_accounts request. Must be one of the values in supported_billing.
     */
    default_billing?: 'brand' | 'operator' | 'agent';
    /**
     * Whether an active account is required to call get_products. When true, the agent must establish an account via sync_accounts before browsing products. When false, get_products works without an account (account_id is optional for rate-card-specific pricing).
     */
    required_for_products?: boolean;
  };
  /**
   * Media-buy protocol capabilities. Only present if media_buy is in supported_protocols.
   */
  media_buy?: {
    features?: MediaBuyFeatures;
    /**
     * Technical execution capabilities for media buying
     */
    execution?: {
      /**
       * Agentic ad exchange (AXE) integrations supported. URLs are canonical identifiers for exchanges this seller can execute through.
       */
      axe_integrations?: string[];
      /**
       * Creative specification support
       */
      creative_specs?: {
        /**
         * VAST versions supported for video creatives
         */
        vast_versions?: string[];
        /**
         * MRAID versions supported for rich media mobile creatives
         */
        mraid_versions?: string[];
        /**
         * VPAID support for interactive video ads
         */
        vpaid?: boolean;
        /**
         * SIMID support for interactive video ads
         */
        simid?: boolean;
      };
      /**
       * Targeting capabilities. If declared true/supported, buyer can use these targeting parameters and seller MUST honor them.
       */
      targeting?: {
        /**
         * Supports country-level geo targeting using ISO 3166-1 alpha-2 codes (e.g., 'US', 'GB', 'DE')
         */
        geo_countries?: boolean;
        /**
         * Supports region/state-level geo targeting using ISO 3166-2 subdivision codes (e.g., 'US-NY', 'GB-SCT', 'DE-BY')
         */
        geo_regions?: boolean;
        /**
         * Metro area targeting support. Specifies which classification systems are supported.
         */
        geo_metros?: {
          /**
           * Supports Nielsen DMA codes (US market, e.g., '501' for NYC)
           */
          nielsen_dma?: boolean;
          /**
           * Supports UK ITL Level 1 regions
           */
          uk_itl1?: boolean;
          /**
           * Supports UK ITL Level 2 regions
           */
          uk_itl2?: boolean;
          /**
           * Supports Eurostat NUTS Level 2 regions (EU)
           */
          eurostat_nuts2?: boolean;
        };
        /**
         * Postal area targeting support. Specifies which postal code systems are supported. System names encode country and precision.
         */
        geo_postal_areas?: {
          /**
           * US 5-digit ZIP codes (e.g., '10001')
           */
          us_zip?: boolean;
          /**
           * US 9-digit ZIP+4 codes (e.g., '10001-1234')
           */
          us_zip_plus_four?: boolean;
          /**
           * UK postcode district / outward code (e.g., 'SW1', 'EC1')
           */
          gb_outward?: boolean;
          /**
           * UK full postcode (e.g., 'SW1A 1AA')
           */
          gb_full?: boolean;
          /**
           * Canadian Forward Sortation Area (e.g., 'K1A')
           */
          ca_fsa?: boolean;
          /**
           * Canadian full postal code (e.g., 'K1A 0B1')
           */
          ca_full?: boolean;
          /**
           * German Postleitzahl, 5 digits (e.g., '10115')
           */
          de_plz?: boolean;
          /**
           * French code postal, 5 digits (e.g., '75001')
           */
          fr_code_postal?: boolean;
          /**
           * Australian postcode, 4 digits (e.g., '2000')
           */
          au_postcode?: boolean;
        };
        /**
         * Age restriction capabilities for compliance (alcohol, gambling)
         */
        age_restriction?: {
          /**
           * Whether seller supports age restrictions
           */
          supported?: boolean;
          /**
           * Age verification methods this seller supports
           */
          verification_methods?: AgeVerificationMethod[];
        };
        /**
         * Whether seller supports device platform targeting (Sec-CH-UA-Platform values)
         */
        device_platform?: boolean;
        /**
         * Whether seller supports language targeting (ISO 639-1 codes)
         */
        language?: boolean;
        /**
         * Whether seller supports audience_include in targeting overlays (requires features.audience_targeting)
         */
        audience_include?: boolean;
        /**
         * Whether seller supports audience_exclude in targeting overlays (requires features.audience_targeting)
         */
        audience_exclude?: boolean;
      };
    };
    /**
     * Audience targeting capabilities. Only present when features.audience_targeting is true.
     */
    audience_targeting?: {
      /**
       * Hashed PII types accepted for audience matching. Buyers should only send identifiers the seller supports.
       */
      supported_identifier_types: ('hashed_email' | 'hashed_phone')[];
      /**
       * Universal ID types accepted for audience matching (MAIDs, RampID, UID2, etc.). MAID support varies significantly by platform — check this field before sending uids with type: maid.
       */
      supported_uid_types?: UIDType[];
      /**
       * Minimum matched audience size required for targeting. Audiences below this threshold will have status: too_small. Varies by platform (100–1000 is typical).
       */
      minimum_audience_size: number;
      /**
       * Expected matching latency range in hours after upload. Use to calibrate polling cadence and set appropriate expectations before configuring push_notification_config.
       */
      matching_latency_hours?: {
        min?: number;
        max?: number;
      };
    };
    /**
     * Seller-level conversion tracking capabilities. Only present when features.conversion_tracking is true.
     */
    conversion_tracking?: {
      /**
       * Event types this seller can track and attribute. If omitted, all standard event types are supported.
       */
      supported_event_types?: EventType[];
      /**
       * Universal ID types accepted for user matching
       */
      supported_uid_types?: UIDType[];
      /**
       * Hashed PII types accepted for user matching. Buyers must hash before sending (SHA-256, normalized).
       */
      supported_hashed_identifiers?: ('hashed_email' | 'hashed_phone')[];
      /**
       * Action sources this seller accepts events from
       */
      supported_action_sources?: ActionSource[];
      /**
       * Attribution windows available from this seller. Single-element arrays indicate fixed windows; multi-element arrays indicate configurable options the buyer can choose from via optimization_goal.attribution_window on packages.
       */
      attribution_windows?: {
        event_type?: EventType;
        /**
         * Available click-through attribution windows (e.g. ["7d"], ["7d", "14d", "30d"])
         */
        click_through: string[];
        /**
         * Available view-through attribution windows (e.g. ["1d"], ["1d", "7d", "14d"])
         */
        view_through?: string[];
      }[];
    };
    /**
     * Information about the seller's media inventory portfolio
     */
    portfolio?: {
      /**
       * Publisher domains this seller is authorized to represent. Buyers should fetch each publisher's adagents.json for property definitions.
       */
      publisher_domains: string[];
      /**
       * Primary advertising channels in this portfolio
       */
      primary_channels?: MediaChannel[];
      /**
       * Primary countries (ISO 3166-1 alpha-2) where inventory is concentrated
       */
      primary_countries?: string[];
      /**
       * Markdown-formatted description of the inventory portfolio
       */
      description?: string;
      /**
       * Advertising content policies, restrictions, and guidelines
       */
      advertising_policies?: string;
    };
  };
  /**
   * Signals protocol capabilities. Only present if signals is in supported_protocols.
   */
  signals?: {
    /**
     * Data provider domains this signals agent is authorized to resell. Buyers should fetch each data provider's adagents.json for signal catalog definitions and to verify authorization.
     */
    data_provider_domains?: string[];
    /**
     * Optional signals features supported
     */
    features?: {
      /**
       * Supports signals from data provider catalogs with structured signal_id references
       */
      catalog_signals?: boolean;
      [k: string]: boolean | undefined;
    };
  };
  /**
   * Governance protocol capabilities. Only present if governance is in supported_protocols. Governance agents provide property data like compliance scores, brand safety ratings, and sustainability metrics.
   */
  governance?: {
    /**
     * Property features this governance agent can evaluate. Each feature describes a score, rating, or certification the agent can provide for properties.
     */
    property_features?: {
      /**
       * Unique identifier for this feature (e.g., 'consent_quality', 'coppa_certified', 'carbon_score')
       */
      feature_id: string;
      /**
       * Data type: 'binary' for yes/no, 'quantitative' for numeric scores, 'categorical' for enum values
       */
      type: 'binary' | 'quantitative' | 'categorical';
      /**
       * For quantitative features, the valid range
       */
      range?: {
        /**
         * Minimum value
         */
        min: number;
        /**
         * Maximum value
         */
        max: number;
      };
      /**
       * For categorical features, the valid values
       */
      categories?: string[];
      /**
       * Human-readable description of what this feature measures
       */
      description?: string;
      /**
       * URL to documentation explaining how this feature is calculated or measured. Helps buyers understand and compare methodologies across vendors.
       */
      methodology_url?: string;
    }[];
  };
  /**
   * Sponsored Intelligence protocol capabilities. Only present if sponsored_intelligence is in supported_protocols. SI agents handle conversational brand experiences.
   */
  sponsored_intelligence?: {
    /**
     * SI agent endpoint configuration
     */
    endpoint: {
      /**
       * Available protocol transports. Hosts select based on their capabilities.
       */
      transports: {
        /**
         * Protocol transport type
         */
        type: 'mcp' | 'a2a';
        /**
         * Agent endpoint URL for this transport
         */
        url: string;
      }[];
      /**
       * Preferred transport when host supports multiple
       */
      preferred?: 'mcp' | 'a2a';
    };
    capabilities: SICapabilities;
    /**
     * URL to brand.json with colors, fonts, logos, tone
     */
    brand_url?: string;
  };
  /**
   * Creative protocol capabilities. Only present if creative is in supported_protocols.
   */
  creative?: {
    /**
     * Whether this creative agent accepts creative_brief in build_creative requests for structured campaign-level creative direction
     */
    supports_brief?: boolean;
  };
  /**
   * Extension namespaces this agent supports. Buyers can expect meaningful data in ext.{namespace} fields on responses from this agent. Extension schemas are published in the AdCP extension registry.
   */
  extensions_supported?: string[];
  /**
   * ISO 8601 timestamp of when capabilities were last updated. Buyers can use this for cache invalidation.
   */
  last_updated?: string;
  /**
   * Task-specific errors and warnings
   */
  errors?: Error[];
  context?: ContextObject;
  ext?: ExtensionObject;
}
/**
 * Optional media-buy protocol features. Used in capability declarations (seller declares support) and product filters (buyer requires support). If a seller declares a feature as true, they MUST honor requests using that feature.
 */

// list_accounts parameters
/**
 * Request parameters for listing accounts accessible to the authenticated agent
 */
export interface ListAccountsRequest {
  /**
   * Filter accounts by status. Omit to return accounts in all statuses.
   */
  status?: 'active' | 'pending_approval' | 'payment_required' | 'suspended' | 'closed';
  pagination?: PaginationRequest;
  /**
   * Filter by sandbox status. true returns only sandbox accounts, false returns only production accounts. Omit to return all accounts.
   */
  sandbox?: boolean;
  context?: ContextObject;
  ext?: ExtensionObject;
}
/**
 * Standard cursor-based pagination parameters for list operations
 */

// list_accounts response
/**
 * Response payload for list_accounts task
 */
export interface ListAccountsResponse {
  /**
   * Array of accounts accessible to the authenticated agent
   */
  accounts: Account[];
  /**
   * Task-specific errors and warnings
   */
  errors?: Error[];
  pagination?: PaginationResponse;
  context?: ContextObject;
  ext?: ExtensionObject;
}
/**
 * A billing account representing the relationship between a buyer and seller. The account determines rate cards, payment terms, and billing entity.
 */

// sync_accounts parameters
/**
 * Authentication schemes for push notification endpoints
 */
export interface SyncAccountsRequest {
  /**
   * Advertiser accounts to sync
   *
   * @maxItems 1000
   */
  accounts: {
    /**
     * House domain where brand.json is hosted (e.g., 'unilever.com', 'acme-corp.com'). This is the canonical identity anchor for the brand, resolved via /.well-known/brand.json. For single-brand houses, this alone identifies the brand.
     */
    house: string;
    /**
     * Brand ID within the house portfolio (from brand.json). Required when the house has multiple brands (e.g., 'dove' under unilever.com, 'tide' under pg.com). Omit for single-brand houses.
     */
    brand_id?: string;
    /**
     * Domain of the entity operating the seat (e.g., 'groupm.com', 'mindshare.com'). Verified against the brand's authorized_operators in brand.json. Omit if the brand operates its own seat.
     */
    operator?: string;
    /**
     * Who should be invoiced. brand: seller invoices the brand directly. operator: seller invoices the operator (agency). agent: agent consolidates billing across brands. Omit to accept the seller's default.
     */
    billing?: 'brand' | 'operator' | 'agent';
    /**
     * When true, provision this as a sandbox account. No real platform calls or billing. Sandbox accounts are identified by account_id in subsequent requests.
     */
    sandbox?: boolean;
  }[];
  /**
   * When true, accounts previously synced by this agent but not included in this request will be deactivated. Scoped to the authenticated agent — does not affect accounts managed by other agents. Use with caution.
   */
  delete_missing?: boolean;
  /**
   * When true, preview what would change without applying. Returns what would be created/updated/deactivated.
   */
  dry_run?: boolean;
  push_notification_config?: PushNotificationConfig;
  context?: ContextObject;
  ext?: ExtensionObject;
}
/**
 * Optional webhook for async notifications when account status changes (e.g., pending_approval transitions to active).
 */

// sync_accounts response
/**
 * Response from account sync operation. Returns per-account results with status and billing, or operation-level errors on complete failure.
 */
export type SyncAccountsResponse = SyncAccountsSuccess | SyncAccountsError;

/**
 * Sync operation processed accounts (individual accounts may be pending or have action=failed)
 */
export interface SyncAccountsSuccess {
  /**
   * Whether this was a dry run (no actual changes made)
   */
  dry_run?: boolean;
  /**
   * Results for each account processed
   */
  accounts: {
    /**
     * Seller-assigned account identifier. When billing is 'agent', multiple brands may share the same account_id.
     */
    account_id?: string;
    /**
     * House domain, echoed from the request
     */
    house: string;
    /**
     * Brand ID within the house portfolio, echoed from request
     */
    brand_id?: string;
    /**
     * Operator domain, echoed from request
     */
    operator?: string;
    /**
     * Human-readable account name assigned by the seller
     */
    name?: string;
    /**
     * Action taken for this account. created: new account provisioned. updated: existing account modified. unchanged: no changes needed. failed: could not process (see errors).
     */
    action: 'created' | 'updated' | 'unchanged' | 'failed';
    /**
     * Account status. active: ready for use. pending_approval: seller reviewing (credit, legal). payment_required: credit limit reached or funds depleted. suspended: was active, now paused. closed: terminated.
     */
    status: 'active' | 'pending_approval' | 'payment_required' | 'suspended' | 'closed';
    /**
     * Who is invoiced on this account. May differ from the requested billing if the seller doesn't support it.
     */
    billing?: 'brand' | 'operator' | 'agent';
    /**
     * Parent account ID when this account is a sub-account under a shared billing account
     */
    parent_account_id?: string;
    /**
     * Setup information for pending accounts. Provides the agent (or human) with next steps to complete account activation.
     */
    setup?: {
      /**
       * URL where the human can complete the required action (credit application, legal agreement, add funds)
       */
      url?: string;
      /**
       * Human-readable description of what's needed
       */
      message: string;
      /**
       * When this setup link expires
       */
      expires_at?: string;
    };
    /**
     * Rate card applied to this account
     */
    rate_card?: string;
    /**
     * Payment terms (e.g., 'net_30', 'prepay')
     */
    payment_terms?: string;
    credit_limit?: {
      amount: number;
      currency: string;
    };
    /**
     * Per-account errors (only present when action is 'failed')
     */
    errors?: Error[];
    /**
     * Non-fatal warnings about this account
     */
    warnings?: string[];
    /**
     * Whether this is a sandbox account, echoed from the request.
     */
    sandbox?: boolean;
  }[];
  context?: ContextObject;
  ext?: ExtensionObject;
}
/**
 * Standard error structure for task-specific errors and warnings
 */
export interface SyncAccountsError {
  /**
   * Operation-level errors (e.g., authentication failure, service unavailable)
   */
  errors: Error[];
  context?: ContextObject;
  ext?: ExtensionObject;
}

