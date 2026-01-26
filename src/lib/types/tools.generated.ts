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
 * Request parameters for discovering available advertising products
 */
export interface GetProductsRequest {
  /**
   * Natural language description of campaign requirements. When refining a proposal, can include instructions like 'focus more on German speakers' or 'increase mobile allocation'.
   */
  brief?: string;
  /**
   * Optional proposal ID to refine. When provided with a brief, the publisher will use the brief as refinement instructions for the specified proposal and return an updated version.
   */
  proposal_id?: string;
  brand_manifest?: BrandManifestReference;
  filters?: ProductFilters;
  property_list?: PropertyListReference;
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
   * URL to the brand's privacy policy. Used for consumer consent flows when personal data may be shared with the advertiser. AI platforms can use this to present explicit privacy choices to users before data handoff.
   */
  privacy_policy_url?: string;
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
   * Brand voice configuration for audio/conversational experiences
   */
  voice?: {
    /**
     * TTS provider (e.g., 'elevenlabs', 'openai', 'amazon_polly')
     */
    provider?: string;
    /**
     * Provider-specific voice identifier
     */
    voice_id?: string;
    /**
     * Provider-specific voice settings (speed, pitch, etc.)
     */
    settings?: {
      [k: string]: unknown | undefined;
    };
  };
  /**
   * Brand avatar configuration for visual conversational experiences
   */
  avatar?: {
    /**
     * Avatar provider (e.g., 'd-id', 'heygen', 'synthesia')
     */
    provider?: string;
    /**
     * Provider-specific avatar identifier
     */
    avatar_id?: string;
    /**
     * Provider-specific avatar settings
     */
    settings?: {
      [k: string]: unknown | undefined;
    };
  };
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
      [k: string]: unknown | undefined;
    };
    [k: string]: unknown | undefined;
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
     * Format of the product feed. Use 'openai_product_feed' for feeds conforming to the OpenAI Commerce Product Feed specification.
     */
    feed_format?: 'google_merchant_center' | 'facebook_catalog' | 'openai_product_feed' | 'custom';
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
    /**
     * Agentic checkout endpoint configuration. Enables AI agents to complete purchases on behalf of users through a structured checkout API.
     */
    agentic_checkout?: {
      /**
       * Base URL for checkout session API (e.g., https://merchant.com/api/checkout_sessions)
       */
      endpoint: string;
      /**
       * Checkout API specification implemented by the endpoint
       */
      spec: 'openai_agentic_checkout_v1';
      /**
       * Payment providers supported by this checkout endpoint
       */
      supported_payment_providers?: string[];
    };
    [k: string]: unknown | undefined;
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
    [k: string]: unknown | undefined;
  };
  /**
   * Filter by country coverage using ISO 3166-1 alpha-2 codes (e.g., ['US', 'CA', 'GB']). Works for all inventory types.
   */
  countries?: string[];
  /**
   * Filter by region coverage using ISO 3166-2 codes (e.g., ['US-NY', 'US-CA', 'GB-SCT']). Use for locally-bound inventory (regional OOH, local TV) where products have region-specific coverage.
   */
  regions?: string[];
  /**
   * Filter by metro coverage for locally-bound inventory (radio, DOOH, local TV). Use when products have DMA/metro-specific coverage. For digital inventory where products have broad coverage, use required_geo_targeting instead to filter by seller capability.
   */
  metros?: {
    system: MetroAreaSystem;
    /**
     * Metro code within the system (e.g., '501' for NYC DMA)
     */
    code: string;
  }[];
  /**
   * Filter by advertising channels (e.g., ['display', 'video', 'dooh'])
   */
  channels?: MediaChannel[];
  /**
   * Filter to products executable through specific agentic ad exchanges. URLs are canonical identifiers.
   */
  required_axe_integrations?: string[];
  required_features?: MediaBuyFeatures;
  /**
   * Filter to products from sellers supporting specific geo targeting capabilities. Each entry specifies a targeting level (country, region, metro, postal_area) and optionally a system for levels that have multiple classification systems.
   */
  required_geo_targeting?: {
    level: GeographicTargetingLevel;
    /**
     * Classification system within the level. Required for metro (e.g., 'nielsen_dma') and postal_area (e.g., 'us_zip'). Not applicable for country/region which use ISO standards.
     */
    system?: string;
  }[];
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
 * Type of inventory delivery
 */
export type PricingOption =
  | CPMPricingOption
  | VCPMPricingOption
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
   * Optional array of proposed media plans with budget allocations across products. Publishers include proposals when they can provide strategic guidance based on the brief. Proposals are actionable - buyers can refine them via subsequent get_products calls or execute them directly via create_media_buy.
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
      [k: string]: unknown | undefined;
    };
    [k: string]: unknown | undefined;
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
  /**
   * Optional pricing guidance for auction-based bidding. Helps buyers calibrate bids with historical percentiles.
   */
  price_guidance?: {
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
  /**
   * Optional pricing guidance for auction-based bidding. Helps buyers calibrate bids with historical percentiles.
   */
  price_guidance?: {
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
  [k: string]: unknown | undefined;
}
/**
 * Cost Per Click pricing. If fixed_price is present, it's fixed pricing. If absent, it's auction-based.
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
  /**
   * Optional pricing guidance for auction-based bidding. Helps buyers calibrate bids with historical percentiles.
   */
  price_guidance?: {
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
  [k: string]: unknown | undefined;
}
/**
 * Cost Per Completed View (100% video/audio completion) pricing. If fixed_price is present, it's fixed pricing. If absent, it's auction-based.
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
  /**
   * Optional pricing guidance for auction-based bidding. Helps buyers calibrate bids with historical percentiles.
   */
  price_guidance?: {
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
  [k: string]: unknown | undefined;
}
/**
 * Cost Per View (at publisher-defined threshold) pricing for video/audio. If fixed_price is present, it's fixed pricing. If absent, it's auction-based.
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
  /**
   * Optional pricing guidance for auction-based bidding. Helps buyers calibrate bids with historical percentiles.
   */
  price_guidance?: {
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
 * Cost Per Point (Gross Rating Point) pricing for TV and audio campaigns. If fixed_price is present, it's fixed pricing. If absent, it's auction-based.
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
  /**
   * Optional pricing guidance for auction-based bidding. Helps buyers calibrate bids with historical percentiles.
   */
  price_guidance?: {
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
   * CPP-specific parameters for demographic targeting
   */
  parameters: {
    /**
     * Target demographic in Nielsen format (P18-49, M25-54, W35+, etc.)
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
  /**
   * Optional pricing guidance for auction-based bidding. Helps buyers calibrate bids with historical percentiles.
   */
  price_guidance?: {
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
   * Metrics available in reporting. Impressions and spend are always implicitly included.
   */
  available_metrics: AvailableMetric[];
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
  [k: string]: unknown | undefined;
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
  [k: string]: unknown | undefined;
}
/**
 * Extension object for platform-specific, vendor-namespaced parameters. Extensions are always optional and must be namespaced under a vendor/platform key (e.g., ext.gam, ext.roku). Used for custom capabilities, partner-specific configuration, and features being proposed for standardization.
 */
export interface Proposal {
  /**
   * Unique identifier for this proposal. Used to refine the proposal in subsequent get_products calls or to execute it via create_media_buy.
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
  ext?: ExtensionObject;
  [k: string]: unknown | undefined;
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
    [k: string]: unknown | undefined;
  };
  [k: string]: unknown | undefined;
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
   * Array of all assets supported for this format. Each asset is identified by its asset_id, which must be used as the key in creative manifests. Use the 'required' boolean on each asset to indicate whether it's mandatory. This field replaces the deprecated 'assets_required' and enables full asset discovery for buyers and AI agents.
   */
  assets?: (
    | {
        /**
         * Discriminator indicating this is an individual asset
         */
        item_type: 'individual';
        /**
         * Unique identifier for this asset. Creative manifests MUST use this exact value as the key in the assets object.
         */
        asset_id: string;
        asset_type: AssetContentType;
        /**
         * Optional descriptive label for this asset's purpose (e.g., 'hero_image', 'logo', 'third_party_tracking'). Not used for referencing assets in manifests—use asset_id instead. This field is for human-readable documentation and UI display only.
         */
        asset_role?: string;
        /**
         * Whether this asset is required (true) or optional (false). Required assets must be provided for a valid creative. Optional assets enhance the creative but are not mandatory.
         */
        required: boolean;
        /**
         * Technical requirements for this asset (dimensions, file size, duration, etc.). For template formats, use parameters_from_format_id: true to indicate asset parameters must match the format_id parameters (width/height/unit and/or duration_ms).
         */
        requirements?: {
          [k: string]: unknown | undefined;
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
         * Assets within each repetition of this group
         */
        assets: {
          /**
           * Identifier for this asset within the group
           */
          asset_id: string;
          asset_type: AssetContentType1;
          /**
           * Optional descriptive label for this asset's purpose. Not used for referencing assets in manifests—use asset_id instead. This field is for human-readable documentation and UI display only.
           */
          asset_role?: string;
          /**
           * Whether this asset is required within each repetition of the group
           */
          required: boolean;
          /**
           * Technical requirements for this asset. For template formats, use parameters_from_format_id: true to indicate asset parameters must match the format_id parameters (width/height/unit and/or duration_ms).
           */
          requirements?: {
            [k: string]: unknown | undefined;
          };
        }[];
      }
  )[];
  /**
   * Delivery method specifications (e.g., hosted, VAST, third-party tags)
   */
  delivery?: {
    [k: string]: unknown | undefined;
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
      [k: string]: unknown | undefined;
    };
    [k: string]: unknown | undefined;
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
      [k: string]: unknown | undefined;
    };
    [k: string]: unknown | undefined;
  };
  [k: string]: unknown | undefined;
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
  [k: string]: unknown | undefined;
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
export type DAASTVersion1 = '1.0' | '1.1';
/**
 * Brand information manifest containing assets, themes, and guidelines. Can be provided inline or as a URL reference to a hosted manifest.
 */
export type URLAssetType = 'clickthrough' | 'tracker_pixel' | 'tracker_script';
/**
 * For generative creatives: set to 'approved' to finalize, 'rejected' to request regeneration with updated assets/message. Omit for non-generative creatives (system will set based on processing state).
 */
export type CreativeStatus = 'processing' | 'approved' | 'rejected' | 'pending_review' | 'archived';
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
 * Standard delivery and performance metrics available for reporting
 */
export interface CreateMediaBuyRequest {
  /**
   * Buyer's reference identifier for this media buy
   */
  buyer_ref: string;
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
  targeting_overlay?: TargetingOverlay;
  /**
   * Assign existing library creatives to this package with optional weights and placement targeting
   */
  creative_assignments?: CreativeAssignment[];
  /**
   * Upload new creative assets and assign to this package (creatives will be added to library). Use creative_assignments instead for existing library creatives.
   *
   * @maxItems 100
   */
  creatives?: CreativeAsset[];
  ext?: ExtensionObject;
  [k: string]: unknown | undefined;
}
/**
 * Structured format identifier with agent URL and format name. Can reference: (1) a concrete format with fixed dimensions (id only), (2) a template format without parameters (id only), or (3) a template format with parameters (id + dimensions/duration). Template formats accept parameters in format_id while concrete formats have fixed dimensions in their definition. Parameterized format IDs create unique, specific format variants.
 */
export interface TargetingOverlay {
  /**
   * Restrict delivery to specific countries. ISO 3166-1 alpha-2 codes (e.g., 'US', 'GB', 'DE').
   */
  geo_countries?: string[];
  /**
   * Restrict delivery to specific regions/states. ISO 3166-2 subdivision codes (e.g., 'US-CA', 'GB-SCT').
   */
  geo_regions?: string[];
  /**
   * Restrict delivery to specific metro areas. Each entry specifies the classification system and target values. Seller must declare supported systems in get_adcp_capabilities.
   */
  geo_metros?: {
    system: MetroAreaSystem;
    /**
     * Metro codes within the system (e.g., ['501', '602'] for Nielsen DMAs)
     *
     * @minItems 1
     */
    values: [string, ...string[]];
  }[];
  /**
   * Restrict delivery to specific postal areas. Each entry specifies the postal system and target values. Seller must declare supported systems in get_adcp_capabilities.
   */
  geo_postal_areas?: {
    system: PostalCodeSystem;
    /**
     * Postal codes within the system (e.g., ['10001', '10002'] for us_zip)
     *
     * @minItems 1
     */
    values: [string, ...string[]];
  }[];
  /**
   * AXE segment ID to include for targeting
   */
  axe_include_segment?: string;
  /**
   * AXE segment ID to exclude from targeting
   */
  axe_exclude_segment?: string;
  frequency_cap?: FrequencyCap;
  [k: string]: unknown | undefined;
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
 * Video asset with URL and specifications
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
   * Video file format (mp4, webm, mov, etc.)
   */
  format?: string;
  /**
   * Video bitrate in kilobits per second
   */
  bitrate_kbps?: number;
  [k: string]: unknown | undefined;
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
  [k: string]: unknown | undefined;
}
/**
 * Complete offering specification combining brand manifest, product selectors, and optional SI agent endpoint. Provides all context needed for creative generation and/or conversational experiences about what is being promoted. When si_agent_url is present, hosts can connect users to conversational experiences about any of the offerings.
 */
export interface PromotedOfferings {
  brand_manifest: BrandManifestReference;
  /**
   * MCP endpoint URL for the brand's SI agent. When present, hosts can connect users to conversational experiences about any of the offerings. The agent handles si_get_offering lookups and full conversations.
   */
  si_agent_url?: string;
  product_selectors?: PromotedProducts;
  /**
   * Offerings available for promotion. Each offering can include creative assets (via portfolio_ref or inline assets) for traditional ads. When si_agent_url is set at the parent level, hosts can offer conversational experiences about any of these offerings.
   */
  offerings?: Offering[];
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
    [k: string]: unknown | undefined;
  };
  [k: string]: unknown | undefined;
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
  [k: string]: unknown | undefined;
}
/**
 * A promotable offering from a brand. Can represent a campaign, product promotion, service, or any other thing the brand wants to make available. Offerings can be promoted via traditional creatives (using portfolio_ref or assets) or conversational SI experiences (via si_agent_url at the promoted-offerings level).
 */
export interface Offering {
  /**
   * Unique identifier for this offering. Used by hosts to reference specific offerings in si_get_offering calls.
   */
  offering_id: string;
  /**
   * Human-readable offering name (e.g., 'Winter Sale', 'Free Trial', 'Enterprise Platform')
   */
  name: string;
  /**
   * Description of what's being offered
   */
  description?: string;
  /**
   * Short promotional tagline for the offering
   */
  tagline?: string;
  /**
   * When the offering becomes available. If not specified, offering is immediately available.
   */
  valid_from?: string;
  /**
   * When the offering expires. If not specified, offering has no expiration.
   */
  valid_to?: string;
  /**
   * URL for checkout/purchase flow when the brand doesn't support agentic checkout.
   */
  checkout_url?: string;
  /**
   * Landing page URL for this offering.
   */
  landing_url?: string;
  /**
   * Assets specific to this offering (images, videos, copy)
   */
  assets?: {
    [k: string]: unknown | undefined;
  }[];
  /**
   * Reference to a creative portfolio for this offering. Portfolios contain organized creative assets across formats, enabling consistent ad delivery for this specific offering.
   */
  portfolio_ref?: string;
  /**
   * Keywords for matching this offering to user intent. Hosts use these for retrieval/relevance scoring.
   */
  keywords?: string[];
  /**
   * Categories this offering belongs to (e.g., 'measurement', 'identity', 'programmatic')
   */
  categories?: string[];
  ext?: ExtensionObject;
  [k: string]: unknown | undefined;
}
/**
 * Extension object for platform-specific, vendor-namespaced parameters. Extensions are always optional and must be namespaced under a vendor/platform key (e.g., ext.gam, ext.roku). Used for custom capabilities, partner-specific configuration, and features being proposed for standardization.
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
 * Optional webhook configuration for automated reporting delivery
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
  /**
   * Whether this package is paused by the buyer. Paused packages do not deliver impressions. Defaults to false.
   */
  paused?: boolean;
  ext?: ExtensionObject;
  [k: string]: unknown | undefined;
}
/**
 * Optional geographic refinements for media buys. Most targeting should be expressed in the brief and handled by the publisher. These fields are primarily for geographic restrictions (RCT testing, regulatory compliance).
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
 * JavaScript module type
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
/**
 * Opaque correlation data that is echoed unchanged in responses. Used for internal tracking, UI session IDs, trace IDs, and other caller-specific identifiers that don't affect protocol behavior. Context data is never parsed by AdCP agents - it's simply preserved and returned.
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
 * Filter criteria for querying creative assets from the centralized library. By default, archived creatives are excluded from results. To include archived creatives, explicitly filter by status='archived' or include 'archived' in the statuses array.
 */
export interface CreativeFilters {
  /**
   * Filter by creative format types (e.g., video, audio, display)
   */
  formats?: string[];
  /**
   * Filter by creative approval statuses
   */
  statuses?: CreativeStatus[];
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
  [k: string]: unknown | undefined;
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
  targeting_overlay?: TargetingOverlay;
  /**
   * Replace creative assignments for this package with optional weights and placement targeting. Uses replacement semantics - omit to leave assignments unchanged.
   */
  creative_assignments?: CreativeAssignment[];
  /**
   * Upload new creative assets and assign to this package (creatives will be added to library). Use creative_assignments instead for existing library creatives.
   *
   * @maxItems 100
   */
  creatives?: CreativeAsset[];
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
      [k: string]: unknown | undefined;
    }[];
    [k: string]: unknown | undefined;
  };
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

// build_creative parameters
/**
 * VAST (Video Ad Serving Template) tag for third-party video ad serving
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
  [k: string]: unknown | undefined;
}
/**
 * CSS stylesheet asset
 */

// build_creative response
/**
 * Response containing the transformed or generated creative manifest, ready for use with preview_creative or sync_creatives. Returns either the complete creative manifest OR error information, never both.
 */
export type BuildCreativeResponse = BuildCreativeSuccess | BuildCreativeError;
/**
 * VAST (Video Ad Serving Template) tag for third-party video ad serving
 */
export interface BuildCreativeSuccess {
  creative_manifest: CreativeManifest;
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
        output_format?: PreviewOutputFormat1;
      }[];
      output_format?: PreviewOutputFormat2;
      context?: ContextObject;
      ext?: ExtensionObject;
    };
/**
 * VAST (Video Ad Serving Template) tag for third-party video ad serving
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
    [k: string]: unknown | undefined;
  };
  ext?: ExtensionObject;
  [k: string]: unknown | undefined;
}


// preview_creative response
/**
 * Response containing preview links for one or more creatives. Format matches the request: single preview response for single requests, batch results for batch requests.
 */
export type PreviewCreativeResponse = PreviewCreativeSingleResponse | PreviewCreativeBatchResponse;
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
 * Single preview response - each preview URL returns an HTML page that can be embedded in an iframe
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
  [k: string]: unknown | undefined;
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
      activation_key?: ActivationKey1;
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
 * Standardized advertising media channels describing how buyers allocate budget. Channels are planning abstractions, not technical substrates. See the Media Channel Taxonomy specification for detailed definitions.
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
 * Type of asset. Note: Brand manifests typically contain basic media assets (image, video, audio, text). Code assets (html, javascript, css) and ad markup (vast, daast) are usually not part of brand asset libraries.
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
  brand_manifest?: BrandManifest;
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
export interface Identifier {
  type: PropertyIdentifierTypes;
  /**
   * The identifier value. For domain type: 'example.com' matches base domain plus www and m subdomains; 'edition.example.com' matches that specific subdomain; '*.example.com' matches ALL subdomains but NOT base domain
   */
  value: string;
}
/**
 * Dynamic filters to apply when resolving the list
 */
export interface PropertyListFilters {
  /**
   * Property must have feature data for ALL listed countries (ISO codes). Required.
   */
  countries_all: string[];
  /**
   * Property must support ANY of the listed channels. Required.
   */
  channels_any: MediaChannel[];
  /**
   * Filter to these property types
   */
  property_types?: PropertyType[];
  /**
   * Feature-based requirements. Property must pass ALL requirements (AND logic).
   */
  feature_requirements?: FeatureRequirement[];
  /**
   * Identifiers to always exclude from results
   */
  exclude_identifiers?: Identifier[];
}
/**
 * A feature-based requirement for property filtering. Use min_value/max_value for quantitative features, allowed_values for binary/categorical features.
 */
export interface FeatureRequirement {
  /**
   * Feature to evaluate (discovered via list_property_features)
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
   */
  allowed_values?: unknown[];
  /**
   * How to handle properties where this feature is not covered. 'exclude' (default): property is removed from the list. 'include': property passes this requirement (fail-open).
   */
  if_not_covered?: 'exclude' | 'include';
}
/**
 * Brand identity and requirements. When provided, the agent automatically applies appropriate rules based on brand characteristics (industry, target_audience, etc.).
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
  brand_manifest?: BrandManifest;
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
  brand_manifest?: BrandManifest;
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
   * Maximum identifiers to return (for large lists)
   */
  max_results?: number;
  /**
   * Pagination cursor for large result sets
   */
  cursor?: string;
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
  /**
   * Total number of identifiers in resolved list
   */
  total_count?: number;
  /**
   * Number of identifiers returned in this response
   */
  returned_count?: number;
  /**
   * Pagination information
   */
  pagination?: {
    /**
     * Whether more results are available
     */
    has_more?: boolean;
    /**
     * Cursor for next page
     */
    cursor?: string;
  };
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
  /**
   * Maximum lists to return
   */
  max_results?: number;
  /**
   * Pagination cursor
   */
  cursor?: string;
  context?: ContextObject;
  ext?: ExtensionObject;
}
/**
 * Opaque correlation data that is echoed unchanged in responses. Used for internal tracking, UI session IDs, trace IDs, and other caller-specific identifiers that don't affect protocol behavior. Context data is never parsed by AdCP agents - it's simply preserved and returned.
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
  /**
   * Total number of lists matching criteria
   */
  total_count?: number;
  /**
   * Number of lists returned in this response
   */
  returned_count?: number;
  /**
   * Pagination information
   */
  pagination?: {
    /**
     * Whether more results are available
     */
    has_more?: boolean;
    /**
     * Cursor for next page
     */
    cursor?: string;
  };
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
  context?: ContextObject;
  ext?: ExtensionObject;
}
/**
 * Opaque correlation data that is echoed unchanged in responses. Used for internal tracking, UI session IDs, trace IDs, and other caller-specific identifiers that don't affect protocol behavior. Context data is never parsed by AdCP agents - it's simply preserved and returned.
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
export type AssetAccess1 =
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
export type AssetAccess2 =
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
 * A content standards configuration defining brand safety and suitability policies. Standards are scoped by brand, geography, and channel. Multiple standards can be active simultaneously for different scopes.
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
   */
  countries_all?: string[];
  /**
   * Advertising channels. Standards apply to ANY of the listed channels (OR logic).
   */
  channels_any?: MediaChannel[];
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
        access?: AssetAccess1;
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
        access?: AssetAccess2;
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
      | Artifact1
    )[];
  };
  context?: ContextObject;
  ext?: ExtensionObject;
}
/**
 * Full artifact with pre-extracted content (text, images, video, audio)
 */
export interface Artifact1 {
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
        access?: AssetAccess1;
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
        access?: AssetAccess2;
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
 * Opaque correlation data that is echoed unchanged in responses. Used for internal tracking, UI session IDs, trace IDs, and other caller-specific identifiers that don't affect protocol behavior. Context data is never parsed by AdCP agents - it's simply preserved and returned.
 */

// create_content_standards response
/**
 * Response payload for creating a content standards configuration
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
      | Artifact1
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
   * Maximum artifacts to return per request
   */
  limit?: number;
  /**
   * Pagination cursor for fetching subsequent pages
   */
  cursor?: string;
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
      /**
       * Pagination information for large result sets
       */
      pagination?: {
        /**
         * Cursor for fetching the next page
         */
        cursor?: string;
        /**
         * Whether more results are available
         */
        has_more?: boolean;
      };
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
   * Offering identifier from promoted offerings to get details for
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
    /**
     * Visual components to render
     */
    ui_elements?: SIUIElement[];
  };
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
  protocols?: ('media_buy' | 'signals' | 'sponsored_intelligence')[];
  context?: ContextObject;
  ext?: ExtensionObject;
}
/**
 * Opaque correlation data that is echoed unchanged in responses. Used for internal tracking, UI session IDs, trace IDs, and other caller-specific identifiers that don't affect protocol behavior. Context data is never parsed by AdCP agents - it's simply preserved and returned.
 */

// get_adcp_capabilities response
/**
 * Standardized advertising media channels describing how buyers allocate budget. Channels are planning abstractions, not technical substrates. See the Media Channel Taxonomy specification for detailed definitions.
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
  supported_protocols: ('media_buy' | 'signals' | 'governance' | 'sponsored_intelligence')[];
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
      };
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
   * Signals protocol capabilities. Only present if signals is in supported_protocols. Reserved for future use.
   */
  signals?: {
    /**
     * Optional signals features supported
     */
    features?: {
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
     * URL to brand manifest with colors, fonts, logos, tone
     */
    brand_manifest_url?: string;
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
