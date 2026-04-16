// Generated AdCP core types from official schemas vlatest
// Generated at: 2026-04-16T17:21:42.864Z

// MEDIA-BUY SCHEMA
/**
 * Account lifecycle status. See the Accounts Protocol overview for the operations matrix showing which tasks are permitted in each state.
 */
export type AccountStatus = 'active' | 'pending_approval' | 'rejected' | 'payment_required' | 'suspended' | 'closed';
/**
 * Brand identifier within the house portfolio. Optional for single-brand domains.
 */
export type BrandID = string;
/**
 * Cloud storage protocol
 */
export type CloudStorageProtocol = 's3' | 'gcs' | 'azure_blob';
/**
 * Status of a media buy.
 */
export type MediaBuyStatus =
  | 'pending_creatives'
  | 'pending_start'
  | 'active'
  | 'paused'
  | 'completed'
  | 'rejected'
  | 'canceled';
/**
 * Which party initiated the cancellation. 'buyer' when canceled via update_media_buy; 'seller' when the seller cancels (e.g., policy violation, inventory withdrawal).
 */
export type CanceledBy = 'buyer' | 'seller';
/**
 * Budget pacing strategy
 */
export type Pacing = 'even' | 'asap' | 'front_loaded';
/**
 * Catalog type. Structural types: 'offering' (AdCP Offering objects), 'product' (ecommerce entries), 'inventory' (stock per location), 'store' (physical locations), 'promotion' (deals and pricing). Vertical types: 'hotel', 'flight', 'job', 'vehicle', 'real_estate', 'education', 'destination', 'app' — each with an industry-specific item schema.
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
  | 'destination'
  | 'app';
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
  | 'destination_id'
  | 'app_id';
/**
 * Metro area classification system (e.g., 'nielsen_dma', 'uk_itl2')
 */
export type MetroAreaSystem = 'nielsen_dma' | 'uk_itl1' | 'uk_itl2' | 'eurostat_nuts2' | 'custom';
/**
 * Postal code system (e.g., 'us_zip', 'gb_outward'). System name encodes country and precision.
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
  | 'au_postcode'
  | 'ch_plz'
  | 'at_plz';
/**
 * Days of the week for daypart targeting
 */
export type DayOfWeek = 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday';
/**
 * Frequency capping settings for package-level application. Two types of frequency control can be used independently or together: suppress enforces a cooldown between consecutive exposures; max_impressions + per + window caps total exposures per entity in a time window. When both suppress and max_impressions are set, an impression is delivered only if both constraints permit it (AND semantics). At least one of suppress, suppress_minutes, or max_impressions must be set.
 */
export type FrequencyCap = {
  [k: string]: unknown | undefined;
} & {
  /**
   * Cooldown period between consecutive exposures to the same entity. Prevents back-to-back ad delivery (e.g. {"interval": 60, "unit": "minutes"} for a 1-hour cooldown). Preferred over suppress_minutes.
   */
  suppress?: Duration;
  /**
   * Deprecated — use suppress instead. Cooldown period in minutes between consecutive exposures to the same entity (e.g. 60 for a 1-hour cooldown).
   */
  suppress_minutes?: number;
  /**
   * Maximum number of impressions per entity per window. For duration windows, implementations typically use a rolling window; 'campaign' applies a fixed cap across the full flight.
   */
  max_impressions?: number;
  /**
   * Entity granularity for impression counting. Required when max_impressions is set.
   */
  per?: ReachUnit;
  /**
   * Time window for the max_impressions cap (e.g. {"interval": 7, "unit": "days"} or {"interval": 1, "unit": "campaign"} for the full flight). Required when max_impressions is set.
   */
  window?: Duration;
};
/**
 * Unit of measurement for reach and audience size metrics. Different channels and measurement providers count reach in fundamentally different units, making cross-channel comparison impossible without declaring the unit.
 */
export type ReachUnit = 'individuals' | 'households' | 'devices' | 'accounts' | 'cookies' | 'custom';
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
 * Device form factor categories for targeting and reporting. Complements device-platform (operating system) with hardware classification. OpenRTB mapping: 1 (Mobile/Tablet General) → mobile, 2 (PC) → desktop, 4 (Phone) → mobile, 5 (Tablet) → tablet, 6 (Connected Device) → ctv, 7 (Set Top Box) → ctv. DOOH inventory uses dooh.
 */
export type DeviceType = 'desktop' | 'mobile' | 'tablet' | 'ctv' | 'dooh' | 'unknown';
/**
 * Remedy types available when a performance standard or billing measurement threshold is breached.
 */
export type MakegoodRemedy = 'additional_delivery' | 'credit' | 'invoice_adjustment';
/**
 * The performance metric this standard applies to.
 */
export type PerformanceStandardMetric = 'viewability' | 'ivt' | 'completion_rate' | 'brand_safety' | 'attention_score';
/**
 * Measurement standard. Required when metric is 'viewability' (MRC and GroupM define materially different thresholds). Omit for other metrics.
 */
export type ViewabilityStandard = 'mrc' | 'groupm';
/**
 * A single optimization target for a package. Packages accept an array of optimization_goals. When multiple goals are present, priority determines which the seller focuses on — 1 is highest priority (primary goal); higher numbers are secondary. Duplicate priority values result in undefined seller behavior.
 */
export type OptimizationGoal =
  | {
      kind: 'metric';
      /**
       * Seller-native metric to optimize for. Delivery metrics: clicks (link clicks, swipe-throughs, CTA taps that navigate away), views (viewable impressions), completed_views (video/audio completions — see view_duration_seconds), reach (unique audience reach — see reach_unit and target_frequency). Duration/score metrics: viewed_seconds (time in view per impression), attention_seconds (attention time per impression), attention_score (vendor-specific attention score). Audience action metrics: engagements (any direct interaction with the ad unit beyond viewing — social reactions/comments/shares, story/unit opens, interactive overlay taps, companion banner interactions on audio and CTV), follows (new followers, page likes, artist/podcast/channel subscribes), saves (saves, bookmarks, playlist adds, pins — signals of intent to return), profile_visits (visits to the brand's in-platform page — profile, artist page, channel, or storefront. Does not include external website clicks, which are covered by 'clicks').
       */
      metric:
        | 'clicks'
        | 'views'
        | 'completed_views'
        | 'viewed_seconds'
        | 'attention_seconds'
        | 'attention_score'
        | 'engagements'
        | 'follows'
        | 'saves'
        | 'profile_visits'
        | 'reach';
      /**
       * Unit for reach measurement. Required when metric is 'reach'. Must be a value declared in the product's metric_optimization.supported_reach_units.
       */
      reach_unit?: ReachUnit;
      /**
       * Target frequency band for reach optimization. Only applicable when metric is 'reach'. Frames frequency as an optimization signal: the seller should treat impressions toward entities already within the [min, max] band as lower-value, and impressions toward unreached entities as higher-value. This shifts budget toward fresh reach rather than re-reaching known users. When omitted, the seller maximizes unique reach without a frequency constraint. A hard cap can still be layered via targeting_overlay.frequency_cap if a ceiling is needed.
       */
      target_frequency?: {
        [k: string]: unknown | undefined;
      };
      /**
       * Minimum video view duration in seconds that qualifies as a completed_view for this goal. Only applicable when metric is 'completed_views'. When omitted, the seller uses their platform default (typically 2–15 seconds). Common values: 2 (Snap/LinkedIn default), 6 (TikTok), 15 (Snap 15-second views, Meta ThruPlay). Sellers declare which durations they support in metric_optimization.supported_view_durations. Sellers must reject goals with unsupported values — silent rounding would create measurement discrepancies.
       */
      view_duration_seconds?: number;
      /**
       * Target for this metric. When omitted, the seller optimizes for maximum metric volume within budget.
       */
      target?:
        | {
            kind: 'cost_per';
            /**
             * Target cost per metric unit in the buy currency
             */
            value: number;
          }
        | {
            kind: 'threshold_rate';
            /**
             * Minimum per-impression value. Units depend on the metric: proportion (clicks, views, completed_views), seconds (viewed_seconds, attention_seconds), or score (attention_score).
             */
            value: number;
          };
      /**
       * Relative priority among all optimization goals on this package. 1 = highest priority (primary goal); higher numbers are lower priority (secondary signals). When omitted, sellers may use array position as priority.
       */
      priority?: number;
    }
  | {
      kind: 'event';
      /**
       * Event source and type pairs that feed this goal. Each entry identifies a source and event type to include. When the seller supports multi_source_event_dedup (declared in get_adcp_capabilities), they deduplicate by event_id across all entries — the same business event from multiple sources counts once, using value_field and value_factor from the first matching entry. When multi_source_event_dedup is false or absent, buyers should use a single entry per goal; the seller will use only the first entry. All event sources must be configured via sync_event_sources.
       */
      event_sources: {
        /**
         * Event source to include (must be configured on this account via sync_event_sources)
         */
        event_source_id: string;
        event_type: EventType;
        /**
         * Required when event_type is 'custom'. Platform-specific name for the custom event.
         */
        custom_event_name?: string;
        /**
         * Which field in the event's custom_data carries the monetary value. The seller must use this field for value extraction and aggregation when computing ROAS and conversion value metrics. Required on at least one entry when target.kind is 'per_ad_spend' or 'maximize_value' — sellers must reject these target kinds when no event source entry includes value_field. When present without a value-oriented target, the seller may use it for delivery reporting (conversion_value, roas) but must not change the optimization objective. Common values: 'value', 'order_total', 'profit_margin'. This is not passed as a parameter to underlying platform APIs — the seller maps it to their platform's value ingestion mechanism.
         */
        value_field?: string;
        /**
         * Multiplier the seller must apply to value_field before aggregation. Use -1 for refund events (negate the value), 0.01 for values in cents, -0.01 for refunds in cents. A value of 0 zeroes out this source's value contribution (the source still counts for event dedup). Defaults to 1. This is not passed as a parameter to underlying platform APIs — the seller applies it when computing aggregated value metrics.
         */
        value_factor?: number;
      }[];
      /**
       * Target cost or return for this event goal. When omitted, the seller optimizes for maximum conversion count within budget — regardless of whether value_field is present on event sources. The presence of value_field alone does not change the optimization objective; it only makes value available for reporting. An explicit target of maximize_value or per_ad_spend is required to steer toward value.
       */
      target?:
        | {
            kind: 'cost_per';
            /**
             * Target cost per event in the buy currency
             */
            value: number;
          }
        | {
            kind: 'per_ad_spend';
            /**
             * Target return ratio (e.g., 4.0 means $4 of value per $1 spent)
             */
            value: number;
          }
        | {
            kind: 'maximize_value';
          };
      /**
       * Attribution window for this optimization goal. Values must match an option declared in the seller's conversion_tracking.attribution_windows capability. Sellers must reject windows not in their declared capabilities. When omitted, the seller uses their default window.
       */
      attribution_window?: {
        /**
         * Post-click attribution window. Conversions within this duration after a click are attributed to the ad (e.g. {"interval": 7, "unit": "days"}).
         */
        post_click: Duration;
        /**
         * Post-view attribution window. Conversions within this duration after an ad impression (without click) are attributed to the ad (e.g. {"interval": 1, "unit": "days"}).
         */
        post_view?: Duration;
      };
      /**
       * Relative priority among all optimization goals on this package. 1 = highest priority (primary goal); higher numbers are lower priority (secondary signals). When omitted, sellers may use array position as priority.
       */
      priority?: number;
    };
/**
 * Represents a purchased advertising campaign
 */
export interface MediaBuy {
  /**
   * Seller's unique identifier for the media buy
   */
  media_buy_id: string;
  account?: Account;
  status: MediaBuyStatus;
  /**
   * Reason provided by the seller when status is 'rejected'. Present only when status is 'rejected'.
   */
  rejection_reason?: string;
  /**
   * ISO 8601 timestamp when the seller confirmed this media buy. A successful create_media_buy response constitutes order confirmation.
   */
  confirmed_at?: string;
  /**
   * Cancellation metadata. Present only when status is 'canceled'.
   */
  cancellation?: {
    /**
     * ISO 8601 timestamp when this media buy was canceled.
     */
    canceled_at: string;
    canceled_by: CanceledBy;
    /**
     * Reason provided when the media buy was canceled.
     */
    reason?: string;
  };
  /**
   * Total budget amount
   */
  total_budget: number;
  /**
   * Array of packages within this media buy
   */
  packages: Package[];
  invoice_recipient?: BusinessEntity;
  /**
   * ISO 8601 timestamp for creative upload deadline
   */
  creative_deadline?: string;
  /**
   * Monotonically increasing revision number. Incremented on every state change or update. Callers MAY include this in update_media_buy requests for optimistic concurrency — sellers MUST reject with CONFLICT if the provided revision does not match the current value.
   */
  revision?: number;
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
  status: AccountStatus;
  brand?: BrandReference;
  /**
   * Domain of the entity operating this account. When the brand operates directly, this is the brand's domain.
   */
  operator?: string;
  /**
   * Who is invoiced on this account. operator: seller invoices the operator (agency or brand buying direct). agent: agent consolidates billing. advertiser: seller invoices the advertiser directly, even when a different operator places orders on their behalf. See billing_entity for the invoiced party's business details.
   */
  billing?: 'operator' | 'agent' | 'advertiser';
  billing_entity?: BusinessEntity;
  /**
   * Identifier for the rate card applied to this account
   */
  rate_card?: string;
  /**
   * Payment terms agreed for this account. Binding for all invoices when the account is active.
   */
  payment_terms?: 'net_15' | 'net_30' | 'net_45' | 'net_60' | 'net_90' | 'prepay';
  /**
   * Maximum outstanding balance allowed
   */
  credit_limit?: {
    amount: number;
    currency: string;
  };
  /**
   * Present when status is 'pending_approval'. Contains next steps for completing account activation.
   */
  setup?: {
    /**
     * URL where the human can complete the required action (credit application, legal agreement, add funds).
     */
    url?: string;
    /**
     * Human-readable description of what's needed.
     */
    message: string;
    /**
     * When this setup link expires.
     */
    expires_at?: string;
  };
  /**
   * How the seller scoped this account. operator: shared across all brands for this operator. brand: shared across all operators for this brand. operator_brand: dedicated to a specific operator+brand combination. agent: the agent's default account with no brand or operator association.
   */
  account_scope?: 'operator' | 'brand' | 'operator_brand' | 'agent';
  /**
   * Governance agent endpoints registered on this account. Authentication credentials are write-only and not included in responses — use sync_governance to set or update credentials.
   */
  governance_agents?: {
    /**
     * Governance agent endpoint URL. Must use HTTPS.
     */
    url: string;
    /**
     * Governance categories this agent handles (e.g., ['budget_authority', 'strategic_alignment']). When omitted, the agent handles all categories.
     */
    categories?: string[];
  }[];
  /**
   * Cloud storage bucket where the seller delivers offline reporting files for this account. Seller provisions a dedicated bucket or a per-account prefix within a shared bucket, and grants the buyer read access out-of-band. Access MUST be scoped so each account can only read its own prefix. Only present when the seller supports offline delivery (reporting_delivery_methods includes 'offline' in capabilities).
   */
  reporting_bucket?: {
    protocol: CloudStorageProtocol;
    /**
     * Bucket or container name
     */
    bucket: string;
    /**
     * Path prefix within the bucket. Seller appends date-based partitioning beneath this prefix.
     */
    prefix?: string;
    /**
     * Cloud region for the bucket
     */
    region?: string;
    /**
     * File format for delivered files. Parquet, Avro, and ORC use internal compression (the top-level compression field is ignored for these formats).
     */
    format?: 'jsonl' | 'csv' | 'parquet' | 'avro' | 'orc';
    /**
     * Compression applied to delivered files
     */
    compression?: 'gzip' | 'none';
    /**
     * How long reporting files are retained in the bucket before deletion. Buyers must read files within this window. Minimum recommended: 14 days.
     */
    file_retention_days: number;
    /**
     * URL to documentation for configuring buyer read access to this bucket (IAM role, service account, etc.)
     */
    setup_instructions?: string;
  };
  /**
   * When true, this is a sandbox account — no real platform calls, no real spend. For explicit accounts (require_operator_auth: true), sandbox accounts are pre-existing test accounts on the platform discovered via list_accounts. For implicit accounts, sandbox is part of the natural key: the same brand/operator pair can have both a production and sandbox account.
   */
  sandbox?: boolean;
  ext?: ExtensionObject;
}
/**
 * Brand reference identifying the advertiser
 */
export interface BrandReference {
  /**
   * Domain where /.well-known/brand.json is hosted, or the brand's operating domain
   */
  domain: string;
  brand_id?: BrandID;
}
/**
 * Business entity details for the party responsible for payment. Contains the legal name, tax IDs, address, and bank details needed for formal B2B invoicing. Corresponds to whoever billing points to (operator, agent, or advertiser). When this account appears in a response, bank details MUST be omitted (write-only).
 */
export interface BusinessEntity {
  /**
   * Registered legal name of the business entity
   */
  legal_name: string;
  /**
   * VAT identification number (e.g., DE123456789 for Germany, FR12345678901 for France). Required for B2B invoicing in the EU. Must be normalized: no spaces, dots, or dashes.
   */
  vat_id?: string;
  /**
   * Tax identification number for jurisdictions that do not use VAT (e.g., US EIN)
   */
  tax_id?: string;
  /**
   * Company registration number (e.g., HRB 12345 for German Handelsregister)
   */
  registration_number?: string;
  /**
   * Postal address for invoicing and legal correspondence
   */
  address?: {
    /**
     * Street address including building number
     */
    street: string;
    city: string;
    postal_code: string;
    /**
     * State, province, or region
     */
    region?: string;
    /**
     * ISO 3166-1 alpha-2 country code
     */
    country: string;
  };
  /**
   * Contacts for billing, legal, and operational matters. Contains personal data subject to GDPR and equivalent regulations. Implementations MUST use this data only for invoicing and account management.
   */
  contacts?: {
    /**
     * Contact's functional role in the business relationship
     */
    role: 'billing' | 'legal' | 'creative' | 'general';
    /**
     * Full name of the contact
     */
    name?: string;
    email?: string;
    phone?: string;
  }[];
  /**
   * Bank account details for payment processing. Write-only: included in requests to provide payment coordinates, but MUST NOT be echoed in responses. Sellers store these details and confirm receipt without returning them.
   */
  bank?: {
    /**
     * Name on the bank account
     */
    account_holder: string;
    /**
     * International Bank Account Number (SEPA markets)
     */
    iban?: string;
    /**
     * Bank Identifier Code / SWIFT code (SEPA markets)
     */
    bic?: string;
    /**
     * Bank routing number for non-SEPA markets (e.g., US ABA routing number, Canadian transit/institution number)
     */
    routing_number?: string;
    /**
     * Bank account number for non-SEPA markets
     */
    account_number?: string;
  };
  ext?: ExtensionObject;
}
/**
 * Extension object for platform-specific, vendor-namespaced parameters. Extensions are always optional and must be namespaced under a vendor/platform key (e.g., ext.gam, ext.roku). Used for custom capabilities, partner-specific configuration, and features being proposed for standardization.
 */
export interface ExtensionObject {}
/**
 * A specific product within a media buy (line item)
 */
export interface Package {
  /**
   * Seller's unique identifier for the package
   */
  package_id: string;
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
   * Bid price for auction-based pricing. This is the exact bid/price to honor unless the selected pricing option has max_bid=true, in which case bid_price is the buyer's maximum willingness to pay (ceiling).
   */
  bid_price?: number;
  price_breakdown?: PriceBreakdown;
  /**
   * Impression goal for this package
   */
  impressions?: number;
  /**
   * Catalogs this package promotes. Each catalog MUST have a distinct type (e.g., one product catalog, one store catalog). This constraint is enforced at the application level — sellers MUST reject requests containing multiple catalogs of the same type with a validation_error. Echoed from the create_media_buy request.
   */
  catalogs?: Catalog[];
  /**
   * Format IDs active for this package. Echoed from the create_media_buy request; omitted means all formats for the product are active.
   */
  format_ids?: FormatID[];
  targeting_overlay?: TargetingOverlay;
  measurement_terms?: MeasurementTerms;
  /**
   * Agreed performance standards for this package. When any entry specifies a vendor, creatives assigned to this package MUST include corresponding tracker_script or tracker_pixel assets from that vendor.
   */
  performance_standards?: PerformanceStandard[];
  /**
   * Creative assets assigned to this package
   */
  creative_assignments?: CreativeAssignment[];
  /**
   * Format IDs that creative assets will be provided for this package
   */
  format_ids_to_provide?: FormatID[];
  /**
   * Optimization targets for this package. The seller optimizes delivery toward these goals in priority order. Common pattern: event goals (purchase, install) as primary targets at priority 1; metric goals (clicks, views) as secondary proxy signals at priority 2+.
   */
  optimization_goals?: OptimizationGoal[];
  /**
   * Flight start date/time for this package in ISO 8601 format. When omitted, the package inherits the media buy's start_time. Sellers SHOULD always include the resolved value in responses, even when inherited.
   */
  start_time?: string;
  /**
   * Flight end date/time for this package in ISO 8601 format. When omitted, the package inherits the media buy's end_time. Sellers SHOULD always include the resolved value in responses, even when inherited.
   */
  end_time?: string;
  /**
   * Whether this package is paused by the buyer. Paused packages do not deliver impressions. Defaults to false.
   */
  paused?: boolean;
  /**
   * Whether this package has been canceled. Canceled packages stop delivery and cannot be reactivated. Defaults to false.
   */
  canceled?: boolean;
  /**
   * Cancellation metadata. Present only when canceled is true.
   */
  cancellation?: {
    /**
     * ISO 8601 timestamp when this package was canceled.
     */
    canceled_at: string;
    canceled_by: CanceledBy;
    /**
     * Reason the package was canceled.
     */
    reason?: string;
    /**
     * ISO 8601 timestamp when the seller acknowledged the cancellation. Confirms inventory has been released and billing stopped. Absent until the seller processes the cancellation.
     */
    acknowledged_at?: string;
  };
  /**
   * Agency estimate or authorization number for this package. Echoed from the buyer's request. When present on the package, takes precedence over the media buy-level estimate number.
   */
  agency_estimate_number?: string;
  /**
   * ISO 8601 timestamp for creative upload or change deadline for this package. After this deadline, creative changes are rejected. When absent, the media buy's creative_deadline applies.
   */
  creative_deadline?: string;
  context?: ContextObject;
  ext?: ExtensionObject;
}
/**
 * Breakdown of the effective price for this package. On fixed-price packages, echoes the pricing option's breakdown. On auction packages, shows the clearing price breakdown including any commission or settlement terms.
 */
export interface PriceBreakdown {
  /**
   * Rate card or base price before any adjustments. The starting point from which fixed_price is derived by applying fee and discount adjustments sequentially.
   */
  list_price: number;
  /**
   * Ordered list of price adjustments. Fee and discount adjustments walk list_price to fixed_price — fees increase the running price, discounts reduce it. Commission and settlement adjustments are disclosed for transparency but do not affect the buyer's committed price.
   */
  adjustments: {
    [k: string]: unknown | undefined;
  }[];
}
/**
 * A typed data feed. Catalogs carry the items, locations, stock levels, or pricing that publishers use to render ads. They can be synced to a platform via sync_catalogs (managed lifecycle with approval), provided inline, or fetched from an external URL. The catalog type determines the item schema and can be structural (offering, product, inventory, store, promotion) or vertical-specific (hotel, flight, job, vehicle, real_estate, education, destination, app). Selectors (ids, tags, category, query) filter items regardless of sourcing method.
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
   * Inline catalog data. The item schema depends on the catalog type: Offering objects for 'offering', StoreItem for 'store', HotelItem for 'hotel', FlightItem for 'flight', JobItem for 'job', VehicleItem for 'vehicle', RealEstateItem for 'real_estate', EducationItem for 'education', DestinationItem for 'destination', AppItem for 'app', or freeform objects for 'product', 'inventory', and 'promotion'. Mutually exclusive with url — provide one or the other, not both. Implementations should validate items against the type-specific schema.
   */
  items?: {}[];
  /**
   * Filter catalog to specific item IDs. For offering-type catalogs, these are offering_id values. For product-type catalogs, these are SKU identifiers.
   */
  ids?: string[];
  /**
   * Filter product-type catalogs by GTIN identifiers for cross-retailer catalog matching. Accepts standard GTIN formats (GTIN-8, UPC-A/GTIN-12, EAN-13/GTIN-13, GTIN-14). Only applicable when type is 'product'.
   */
  gtins?: string[];
  /**
   * Filter catalog to items with these tags. Tags are matched using OR logic — items matching any tag are included.
   */
  tags?: string[];
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
   */
  conversion_events?: EventType[];
  content_id_type?: ContentIDType;
  /**
   * Declarative normalization rules for external feeds. Maps non-standard feed field names, date formats, price encodings, and image URLs to the AdCP catalog item schema. Applied during sync_catalogs ingestion. Supports field renames, named transforms (date, divide, boolean, split), static literal injection, and assignment of image URLs to typed asset pools.
   */
  feed_field_mappings?: CatalogFieldMapping[];
}
/**
 * Declares how a field in an external feed maps to the AdCP catalog item schema. Used in sync_catalogs feed_field_mappings to normalize non-AdCP feeds (Google Merchant Center, LinkedIn Jobs XML, hotel XML, etc.) to the standard catalog item schema without requiring the buyer to preprocess every feed. Multiple mappings can assemble a nested object via dot notation (e.g., separate mappings for price.amount and price.currency).
 */
export interface CatalogFieldMapping {
  /**
   * Field name in the external feed record. Omit when injecting a static literal value (use the value property instead).
   */
  feed_field?: string;
  /**
   * Target field on the catalog item schema, using dot notation for nested fields (e.g., 'name', 'price.amount', 'location.city'). Mutually exclusive with asset_group_id.
   */
  catalog_field?: string;
  /**
   * Places the feed field value (a URL) into a typed asset pool on the catalog item's assets array. The value is wrapped as an image or video asset in a group with this ID. Use standard group IDs: 'images_landscape', 'images_vertical', 'images_square', 'logo', 'video'. Mutually exclusive with catalog_field.
   */
  asset_group_id?: string;
  /**
   * Static literal value to inject into catalog_field for every item, regardless of what the feed contains. Mutually exclusive with feed_field. Useful for fields the feed omits (e.g., currency when price is always USD, or a constant category value).
   */
  value?: {
    [k: string]: unknown | undefined;
  };
  /**
   * Named transform to apply to the feed field value before writing to the catalog schema. See transform-specific parameters (format, timezone, by, separator).
   */
  transform?: 'date' | 'divide' | 'boolean' | 'split';
  /**
   * For transform 'date': the input date format string (e.g., 'YYYYMMDD', 'MM/DD/YYYY', 'DD-MM-YYYY'). Output is always ISO 8601 (e.g., '2025-03-01'). Uses Unicode date pattern tokens.
   */
  format?: string;
  /**
   * For transform 'date': the timezone of the input value. IANA timezone identifier (e.g., 'UTC', 'America/New_York', 'Europe/Amsterdam'). Defaults to UTC when omitted.
   */
  timezone?: string;
  /**
   * For transform 'divide': the divisor to apply (e.g., 100 to convert integer cents to decimal dollars).
   */
  by?: number;
  /**
   * For transform 'split': the separator character or string to split on. Defaults to ','.
   */
  separator?: string;
  /**
   * Fallback value to use when feed_field is absent, null, or empty. Applied after any transform would have been applied. Allows optional feed fields to have a guaranteed baseline value.
   */
  default?: {
    [k: string]: unknown | undefined;
  };
  ext?: ExtensionObject;
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
 * Optional restriction overlays for media buys. Most targeting should be expressed in the brief and handled by the publisher. These fields are for functional restrictions: geographic (RCT testing, regulatory compliance, proximity targeting), age verification (alcohol, gambling), device platform (app compatibility), language (localization), and keyword targeting (search/retail media).
 */
export interface TargetingOverlay {
  /**
   * Restrict delivery to specific countries. ISO 3166-1 alpha-2 codes (e.g., 'US', 'GB', 'DE').
   */
  geo_countries?: string[];
  /**
   * Exclude specific countries from delivery. ISO 3166-1 alpha-2 codes (e.g., 'US', 'GB', 'DE').
   */
  geo_countries_exclude?: string[];
  /**
   * Restrict delivery to specific regions/states. ISO 3166-2 subdivision codes (e.g., 'US-CA', 'GB-SCT').
   */
  geo_regions?: string[];
  /**
   * Exclude specific regions/states from delivery. ISO 3166-2 subdivision codes (e.g., 'US-CA', 'GB-SCT').
   */
  geo_regions_exclude?: string[];
  /**
   * Restrict delivery to specific metro areas. Each entry specifies the classification system and target values. Seller must declare supported systems in get_adcp_capabilities.
   */
  geo_metros?: {
    system: MetroAreaSystem;
    /**
     * Metro codes within the system (e.g., ['501', '602'] for Nielsen DMAs)
     */
    values: string[];
  }[];
  /**
   * Exclude specific metro areas from delivery. Each entry specifies the classification system and excluded values. Seller must declare supported systems in get_adcp_capabilities.
   */
  geo_metros_exclude?: {
    system: MetroAreaSystem;
    /**
     * Metro codes to exclude within the system (e.g., ['501', '602'] for Nielsen DMAs)
     */
    values: string[];
  }[];
  /**
   * Restrict delivery to specific postal areas. Each entry specifies the postal system and target values. Seller must declare supported systems in get_adcp_capabilities.
   */
  geo_postal_areas?: {
    system: PostalCodeSystem;
    /**
     * Postal codes within the system (e.g., ['10001', '10002'] for us_zip)
     */
    values: string[];
  }[];
  /**
   * Exclude specific postal areas from delivery. Each entry specifies the postal system and excluded values. Seller must declare supported systems in get_adcp_capabilities.
   */
  geo_postal_areas_exclude?: {
    system: PostalCodeSystem;
    /**
     * Postal codes to exclude within the system (e.g., ['10001', '10002'] for us_zip)
     */
    values: string[];
  }[];
  /**
   * Restrict delivery to specific time windows. Each entry specifies days of week and an hour range.
   */
  daypart_targets?: DaypartTarget[];
  /**
   * @deprecated
   * Deprecated: Use TMP provider fields instead. AXE segment ID to include for targeting.
   */
  axe_include_segment?: string;
  /**
   * @deprecated
   * Deprecated: Use TMP provider fields instead. AXE segment ID to exclude from targeting.
   */
  axe_exclude_segment?: string;
  /**
   * Restrict delivery to members of these first-party CRM audiences. Only users present in the uploaded lists are eligible. References audience_id values from sync_audiences on the same seller account — audience IDs are not portable across sellers. Not for lookalike expansion — express that intent in the campaign brief. Seller must declare support in get_adcp_capabilities.
   */
  audience_include?: string[];
  /**
   * Suppress delivery to members of these first-party CRM audiences. Matched users are excluded regardless of other targeting. References audience_id values from sync_audiences on the same seller account — audience IDs are not portable across sellers. Seller must declare support in get_adcp_capabilities.
   */
  audience_exclude?: string[];
  frequency_cap?: FrequencyCap;
  property_list?: PropertyListReference;
  collection_list?: CollectionListReference;
  collection_list_exclude?: CollectionListReference;
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
     */
    accepted_methods?: AgeVerificationMethod[];
  };
  /**
   * Restrict to specific platforms. Use for technical compatibility (app only works on iOS). Values from Sec-CH-UA-Platform standard, extended for CTV.
   */
  device_platform?: DevicePlatform[];
  /**
   * Restrict to specific device form factors. Use for campaigns targeting hardware categories rather than operating systems (e.g., mobile-only promotions, CTV campaigns).
   */
  device_type?: DeviceType[];
  /**
   * Exclude specific device form factors from delivery (e.g., exclude CTV for app-install campaigns).
   */
  device_type_exclude?: DeviceType[];
  /**
   * Target users within store catchment areas from a synced store catalog. Each entry references a store-type catalog and optionally narrows to specific stores or catchment zones.
   */
  store_catchments?: {
    /**
     * Synced store-type catalog ID from sync_catalogs.
     */
    catalog_id: string;
    /**
     * Filter to specific stores within the catalog. Omit to target all stores.
     */
    store_ids?: string[];
    /**
     * Catchment zone IDs to target (e.g., 'walk', 'drive'). Omit to target all catchment zones.
     */
    catchment_ids?: string[];
  }[];
  /**
   * Target users within travel time, distance, or a custom boundary around arbitrary geographic points. Multiple entries use OR semantics — a user within range of any listed point is eligible. For campaigns targeting 10+ locations, consider using store_catchments with a location catalog instead. Seller must declare support in get_adcp_capabilities.
   */
  geo_proximity?: {
    [k: string]: unknown | undefined;
  }[];
  /**
   * Restrict to users with specific language preferences. ISO 639-1 codes (e.g., 'en', 'es', 'fr').
   */
  language?: string[];
  /**
   * Keyword targeting for search and retail media platforms. Restricts delivery to queries matching the specified keywords. Each keyword is identified by the tuple (keyword, match_type) — the same keyword string with different match types are distinct targets. Sellers SHOULD reject duplicate (keyword, match_type) pairs within a single request. Seller must declare support in get_adcp_capabilities.
   */
  keyword_targets?: {
    /**
     * The keyword to target
     */
    keyword: string;
    /**
     * Match type: broad matches related queries, phrase matches queries containing the keyword phrase, exact matches the query exactly
     */
    match_type: 'broad' | 'phrase' | 'exact';
    /**
     * Per-keyword bid price, denominated in the same currency as the package's pricing option. Overrides the package-level bid_price for this keyword. Inherits the max_bid interpretation from the pricing option: when max_bid is true, this is the keyword's bid ceiling; when false, this is the exact bid. If omitted, the package bid_price applies.
     */
    bid_price?: number;
  }[];
  /**
   * Keywords to exclude from delivery. Queries matching these keywords will not trigger the ad. Each negative keyword is identified by the tuple (keyword, match_type). Seller must declare support in get_adcp_capabilities.
   */
  negative_keywords?: {
    /**
     * The keyword to exclude
     */
    keyword: string;
    /**
     * Match type for exclusion
     */
    match_type: 'broad' | 'phrase' | 'exact';
  }[];
}
/**
 * A time window for daypart targeting. Specifies days of week and an hour range. start_hour is inclusive, end_hour is exclusive (e.g., 6-10 = 6:00am to 10:00am). Follows the Google Ads AdScheduleInfo / DV360 DayPartTargeting pattern.
 */
export interface DaypartTarget {
  /**
   * Days of week this window applies to. Use multiple days for compact targeting (e.g., monday-friday in one object).
   */
  days: DayOfWeek[];
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
 * A time duration expressed as an interval and unit. Used for frequency cap windows, attribution windows, reach optimization windows, time budgets, and other time-based settings. When unit is 'campaign', interval must be 1 — the window spans the full campaign flight.
 */
export interface Duration {
  /**
   * Number of time units. Must be 1 when unit is 'campaign'.
   */
  interval: number;
  /**
   * Time unit. 'seconds' for sub-minute precision. 'campaign' spans the full campaign flight.
   */
  unit: 'seconds' | 'minutes' | 'hours' | 'days' | 'campaign';
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
 * Reference to a collection list for including specific collections (programs, shows) within this product. The package runs on the intersection of matched collections and this list. Use for inclusion-based collection targeting. Seller must declare support in get_adcp_capabilities.
 */
export interface CollectionListReference {
  /**
   * URL of the agent managing the collection list
   */
  agent_url: string;
  /**
   * Identifier for the collection list within the agent
   */
  list_id: string;
  /**
   * JWT or other authorization token for accessing the list. Optional if the list is public or caller has implicit access.
   */
  auth_token?: string;
}
/**
 * Agreed billing measurement and makegood terms for this package. Reflects what was negotiated — may differ from the buyer's proposal or the product's defaults. When present, these terms are binding for the package's duration.
 */
export interface MeasurementTerms {
  /**
   * Which vendor's count of the billing metric governs invoicing. The billing metric is determined by the pricing_model on the selected pricing_option (e.g., impressions for CPM, completed views for CPCV).
   */
  billing_measurement?: {
    vendor: BrandReference;
    /**
     * Maximum acceptable variance between the billing vendor's count and the other party's count before resolution is triggered (e.g., 10 means a 10% divergence triggers review).
     */
    max_variance_percent?: number;
    /**
     * Which measurement window the billing metric is reconciled against. References a window_id from the product's reporting_capabilities.measurement_windows. For broadcast TV, this is typically 'c7' (live + 7 days DVR). When absent, billing is based on the seller's standard reporting without windowed maturation.
     */
    measurement_window?: string;
  };
  /**
   * Remedies available when a performance standard or billing measurement variance is breached. Seller declares which remedy types they support. When a breach occurs, the seller proposes a remedy from this menu; the buyer accepts or disputes.
   */
  makegood_policy?: {
    /**
     * Remedy types the seller supports. Ordered by seller preference (first = preferred). Seller proposes from this list when a breach occurs; buyer accepts or disputes.
     */
    available_remedies: MakegoodRemedy[];
  };
}
/**
 * A rate threshold for a performance metric, measured by a specified vendor. The threshold is a floor or ceiling depending on the metric: viewability, completion_rate, brand_safety, and attention_score are floors (must exceed); ivt is a ceiling (must not exceed).
 */
export interface PerformanceStandard {
  metric: PerformanceStandardMetric;
  /**
   * Rate threshold as a decimal (e.g., 0.70 for 70%). Whether this is a floor or ceiling depends on the metric: for viewability, completion_rate, brand_safety, attention_score the actual rate must be >= threshold; for ivt the actual rate must be <= threshold.
   */
  threshold: number;
  standard?: ViewabilityStandard;
  vendor: BrandReference;
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
   * Relative delivery weight for this creative (0–100). When multiple creatives are assigned to the same package, weights determine impression distribution proportionally — a creative with weight 2 gets twice the delivery of weight 1. When omitted, the creative receives equal rotation with other unweighted creatives. A weight of 0 means the creative is assigned but paused (receives no delivery).
   */
  weight?: number;
  /**
   * Optional array of placement IDs where this creative should run. When omitted, the creative runs on all placements in the package. References placement_id values from the product's placements array.
   */
  placement_ids?: string[];
}
/**
 * Opaque correlation data that is echoed unchanged in responses. Used for internal tracking, UI session IDs, trace IDs, and other caller-specific identifiers that don't affect protocol behavior. Context data is never parsed by AdCP agents - it's simply preserved and returned.
 */
export interface ContextObject {}
/**
 * IPTC-aligned classification of AI involvement in producing this content
 */
export type DigitalSourceType =
  | 'digital_capture'
  | 'digital_creation'
  | 'trained_algorithmic_media'
  | 'composite_with_trained_algorithmic_media'
  | 'algorithmic_media'
  | 'composite_capture'
  | 'composite_synthetic'
  | 'human_edits'
  | 'data_driven_media';
/**
 * How long the disclosure must persist during content playback or display
 */
export type DisclosurePersistence = 'continuous' | 'initial' | 'flexible';
/**
 * Where a required disclosure should appear within a creative. Used by creative briefs to specify disclosure placement and by formats to declare which positions they can render.
 */
export type DisclosurePosition =
  | 'prominent'
  | 'footer'
  | 'audio'
  | 'subtitle'
  | 'overlay'
  | 'end_card'
  | 'pre_roll'
  | 'companion';
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
      provenance?: Provenance;
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
      provenance?: Provenance;
    };
/**
 * VAST specification version
 */
export type VASTVersion = '2.0' | '3.0' | '4.0' | '4.1' | '4.2';
/**
 * Tracking events for video ads. Includes IAB VAST 4.2 TrackingEvents, plus flattened representations of Impression, Error, VideoClicks, and ViewableImpression elements. fullscreen/exitFullscreen retained for VAST 2.x/3.x compatibility. measurableImpression is an AdCP extension for MRC measurability signals.
 */
export type VASTTrackingEvent =
  | 'impression'
  | 'creativeView'
  | 'loaded'
  | 'start'
  | 'firstQuartile'
  | 'midpoint'
  | 'thirdQuartile'
  | 'complete'
  | 'mute'
  | 'unmute'
  | 'pause'
  | 'resume'
  | 'rewind'
  | 'skip'
  | 'playerExpand'
  | 'playerCollapse'
  | 'fullscreen'
  | 'exitFullscreen'
  | 'progress'
  | 'notUsed'
  | 'otherAdInteraction'
  | 'interactiveStart'
  | 'clickTracking'
  | 'customClick'
  | 'close'
  | 'closeLinear'
  | 'error'
  | 'viewable'
  | 'notViewable'
  | 'viewUndetermined'
  | 'measurableImpression'
  | 'viewableImpression';
/**
 * Type of URL asset: 'clickthrough' for user click destination (landing page), 'tracker_pixel' for impression/event tracking via HTTP request (fires GET, expects pixel/204 response), 'tracker_script' for measurement SDKs that must load as <script> tag (OMID verification, native event trackers using method:2)
 */
export type URLAssetType = 'clickthrough' | 'tracker_pixel' | 'tracker_script';
/**
 * JavaScript module type
 */
export type JavaScriptModuleType = 'esm' | 'commonjs' | 'script';
/**
 * HTTP method
 */
export type HTTPMethod = 'GET' | 'POST';
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
  | 'COLLECTION_NAME'
  | 'INSTALLMENT_ID'
  | 'AUDIO_DURATION'
  | 'TMPX'
  | 'AXEM'
  | 'CATALOG_ID'
  | 'SKU'
  | 'GTIN'
  | 'OFFERING_ID'
  | 'JOB_ID'
  | 'HOTEL_ID'
  | 'FLIGHT_ID'
  | 'VEHICLE_ID'
  | 'LISTING_ID'
  | 'STORE_ID'
  | 'PROGRAM_ID'
  | 'DESTINATION_ID'
  | 'CREATIVE_VARIANT_ID'
  | 'APP_ITEM_ID';
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
      provenance?: Provenance;
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
      provenance?: Provenance;
    };
/**
 * DAAST specification version
 */
export type DAASTVersion = '1.0' | '1.1';
/**
 * Tracking events for audio ads. Includes DAAST-applicable events from IAB VAST/DAAST conventions, plus flattened Impression, Error, and ViewableImpression elements. creativeView included for companion ad tracking. measurableImpression is an AdCP extension.
 */
export type DAASTTrackingEvent =
  | 'impression'
  | 'creativeView'
  | 'loaded'
  | 'start'
  | 'firstQuartile'
  | 'midpoint'
  | 'thirdQuartile'
  | 'complete'
  | 'mute'
  | 'unmute'
  | 'pause'
  | 'resume'
  | 'skip'
  | 'progress'
  | 'clickTracking'
  | 'customClick'
  | 'close'
  | 'error'
  | 'viewable'
  | 'notViewable'
  | 'viewUndetermined'
  | 'measurableImpression'
  | 'viewableImpression';
/**
 * Markdown flavor used. CommonMark for strict compatibility, GFM for tables/task lists/strikethrough.
 */
export type MarkdownFlavor = 'commonmark' | 'gfm';
/**
 * Campaign-level creative context as an asset. Carries the creative brief through the manifest so it travels with the creative through regeneration, resizing, and auditing.
 */
export type BriefAsset = CreativeBrief;
/**
 * A typed data feed as a creative asset. Carries catalog context (products, stores, jobs, etc.) within the manifest's assets map.
 */
export type CatalogAsset = Catalog;
/**
 * For generative creatives: set to 'approved' to finalize, 'rejected' to request regeneration with updated assets/message. Omit for non-generative creatives (system will set based on processing state).
 */
export type CreativeStatus = 'processing' | 'pending_review' | 'approved' | 'rejected' | 'archived';
/**
 * Industry-standard identifier types for advertising creatives. These identifiers are managed by external registries and used across the supply chain to track and reference specific creative assets.
 */
export type CreativeIdentifierType = 'ad_id' | 'isci' | 'clearcast_clock';

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
   * Assets required by the format, keyed by asset_id
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
      | MarkdownAsset
      | BriefAsset
      | CatalogAsset;
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
  /**
   * Industry-standard identifiers for this creative (e.g., Ad-ID, ISCI, Clearcast clock number). In broadcast buying, these identifiers tie the creative to rotation instructions and traffic systems. A creative may have multiple identifiers when different systems reference the same asset.
   */
  industry_identifiers?: IndustryIdentifier[];
  provenance?: Provenance;
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
  provenance?: Provenance;
}
/**
 * Provenance metadata for this asset, overrides manifest-level provenance
 */
export interface Provenance {
  digital_source_type?: DigitalSourceType;
  /**
   * AI system used to generate or modify this content. Aligns with IPTC 2025.1 AI metadata fields and C2PA claim_generator.
   */
  ai_tool?: {
    /**
     * Name of the AI tool or model (e.g., 'DALL-E 3', 'Stable Diffusion XL', 'Gemini')
     */
    name: string;
    /**
     * Version identifier for the AI tool or model (e.g., '25.1', '0125', '2.1'). For generative models, use the model version rather than the API version.
     */
    version?: string;
    /**
     * Organization that provides the AI tool (e.g., 'OpenAI', 'Stability AI', 'Google')
     */
    provider?: string;
  };
  /**
   * Level of human involvement in the AI-assisted creation process
   */
  human_oversight?: 'none' | 'prompt_only' | 'selected' | 'edited' | 'directed';
  /**
   * Party declaring this provenance. Identifies who attached the provenance claim, enabling receiving parties to assess trust.
   */
  declared_by?: {
    /**
     * URL of the agent or service that declared this provenance
     */
    agent_url?: string;
    /**
     * Role of the declaring party in the supply chain
     */
    role: 'creator' | 'advertiser' | 'agency' | 'platform' | 'tool';
  };
  /**
   * When this provenance claim was made (ISO 8601). Distinct from created_time, which records when the content itself was produced. A provenance claim may be attached well after content creation, for example when retroactively declaring AI involvement for regulatory compliance.
   */
  declared_at?: string;
  /**
   * When this content was created or generated (ISO 8601)
   */
  created_time?: string;
  /**
   * C2PA Content Credentials reference. Links to the cryptographic provenance manifest for this content. Because file-level C2PA bindings break during ad-tech transcoding, this URL reference preserves the chain of provenance through the supply chain.
   */
  c2pa?: {
    /**
     * URL to the C2PA manifest store for this content
     */
    manifest_url: string;
  };
  /**
   * Regulatory disclosure requirements for this content. Indicates whether AI disclosure is required and under which jurisdictions.
   */
  disclosure?: {
    /**
     * Whether AI disclosure is required for this content based on applicable regulations
     */
    required: boolean;
    /**
     * Jurisdictions where disclosure obligations apply
     */
    jurisdictions?: {
      /**
       * ISO 3166-1 alpha-2 country code (e.g., 'US', 'DE', 'CN')
       */
      country: string;
      /**
       * Sub-national region code (e.g., 'CA' for California, 'BY' for Bavaria)
       */
      region?: string;
      /**
       * Regulation identifier (e.g., 'eu_ai_act_article_50', 'ca_sb_942', 'cn_deep_synthesis')
       */
      regulation: string;
      /**
       * Required disclosure label text for this jurisdiction, in the local language
       */
      label_text?: string;
      /**
       * How the disclosure should be rendered for this jurisdiction. Expresses the declaring party's intent for persistence and position based on regulatory requirements. Publishers control actual rendering but governance agents can audit whether guidance was followed.
       */
      render_guidance?: {
        persistence?: DisclosurePersistence;
        /**
         * Minimum display duration in milliseconds for initial persistence. Recommended when persistence is initial — without it, the duration is at the publisher's discretion. At serve time the publisher reads this from provenance since the brief is not available.
         */
        min_duration_ms?: number;
        /**
         * Preferred disclosure positions in priority order. The first position a format supports should be used.
         */
        positions?: DisclosurePosition[];
        ext?: ExtensionObject;
      };
    }[];
  };
  /**
   * Third-party verification or detection results for this content. Multiple services may independently evaluate the same content. Provenance is a claim — verification results attached by the declaring party are supplementary. The enforcing party (e.g., seller/publisher) should run its own verification via get_creative_features or calibrate_content.
   */
  verification?: {
    /**
     * Name of the verification service (e.g., 'DoubleVerify', 'Hive Moderation', 'Reality Defender')
     */
    verified_by: string;
    /**
     * When the verification was performed (ISO 8601)
     */
    verified_time?: string;
    /**
     * Verification outcome
     */
    result: 'authentic' | 'ai_generated' | 'ai_modified' | 'inconclusive';
    /**
     * Confidence score of the verification result (0.0 to 1.0)
     */
    confidence?: number;
    /**
     * URL to the full verification report
     */
    details_url?: string;
  }[];
  ext?: ExtensionObject;
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
  provenance?: Provenance;
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
  provenance?: Provenance;
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
  provenance?: Provenance;
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
  provenance?: Provenance;
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
  provenance?: Provenance;
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
  provenance?: Provenance;
}
/**
 * Webhook for server-side dynamic content rendering (DCO)
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
  provenance?: Provenance;
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
  provenance?: Provenance;
}
/**
 * Markdown-formatted text content following CommonMark specification
 */
export interface MarkdownAsset {
  /**
   * Markdown content following CommonMark spec with optional GitHub Flavored Markdown extensions
   */
  content: string;
  /**
   * Language code (e.g., 'en', 'es', 'fr')
   */
  language?: string;
  markdown_flavor?: MarkdownFlavor;
  /**
   * Whether raw HTML blocks are allowed in the markdown. False recommended for security.
   */
  allow_raw_html?: boolean;
}
/**
 * Campaign-level creative context for AI-powered creative generation. Provides the layer between brand identity (stable across campaigns) and individual creative execution (per-request). A brand has one identity (defined in brand.json) but different creative briefs for each campaign or flight.
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
  };
  /**
   * Visual and strategic reference materials such as mood boards, product shots, example creatives, and strategy documents
   */
  reference_assets?: ReferenceAsset[];
  /**
   * Regulatory and legal compliance requirements for this campaign. Campaign-specific, regional, and product-based — distinct from brand-level disclaimers in brand.json.
   */
  compliance?: {
    /**
     * Disclosures that must appear in creatives for this campaign. Each disclosure specifies the text, where it should appear, and which jurisdictions require it.
     */
    required_disclosures?: {
      /**
       * The disclosure text that must appear in the creative
       */
      text: string;
      position?: DisclosurePosition;
      /**
       * Jurisdictions where this disclosure is required. ISO 3166-1 alpha-2 country codes or ISO 3166-2 subdivision codes (e.g., 'US', 'GB', 'US-NJ', 'CA-QC'). If omitted, the disclosure applies to all jurisdictions in the campaign.
       */
      jurisdictions?: string[];
      /**
       * The regulation or legal authority requiring this disclosure (e.g., 'SEC Rule 156', 'FCA COBS 4.5', 'FDA 21 CFR 202')
       */
      regulation?: string;
      /**
       * Minimum display duration in milliseconds. For video/audio disclosures, how long the disclosure must be visible or audible. For static formats, how long the disclosure must remain on screen before any auto-advance.
       */
      min_duration_ms?: number;
      /**
       * Language of the disclosure text as a BCP 47 language tag (e.g., 'en', 'fr-CA', 'es'). When omitted, the disclosure is assumed to match the creative's language.
       */
      language?: string;
      persistence?: DisclosurePersistence;
    }[];
    /**
     * Claims that must not appear in creatives for this campaign. Creative agents should ensure generated content avoids these claims.
     */
    prohibited_claims?: string[];
  };
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
   * How the creative agent should use this asset. style_reference: match the visual style; product_shot: include this product; mood_board: overall look and feel; example_creative: example of a similar execution; logo: logo to use; strategy_doc: strategy or planning document for context; storyboard: sequential visual direction for video or multi-scene creative
   */
  role: 'style_reference' | 'product_shot' | 'mood_board' | 'example_creative' | 'logo' | 'strategy_doc' | 'storyboard';
  /**
   * Human-readable description of the asset and how it should inform creative generation
   */
  description?: string;
}
/**
 * An industry-standard identifier for an advertising creative (e.g., Ad-ID, ISCI, Clearcast clock number). These identifiers are managed by external registries and used across the supply chain to track and reference specific creative assets.
 */
export interface IndustryIdentifier {
  type: CreativeIdentifierType;
  /**
   * The identifier value (e.g., 'ABCD1234000H' for Ad-ID)
   */
  value: string;
}
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
       */
      property_ids: PropertyID[];
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
       */
      property_tags: PropertyTag[];
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
  | 'product_placement'
  | 'sponsored_intelligence';
/**
 * Type of inventory delivery
 */
export type DeliveryType = 'guaranteed' | 'non_guaranteed';
/**
 * Whether this product offers exclusive access to its inventory. Defaults to 'none' when absent. Most relevant for guaranteed products tied to specific collections or placements.
 */
export type Exclusivity = 'none' | 'category' | 'exclusive';
/**
 * A pricing model option offered by a publisher for a product. Discriminated by pricing_model field. If fixed_price is present, it's fixed pricing. If absent, it's auction-based (floor_price and price_guidance optional). Bid-based auction models may also include max_bid as a boolean signal to interpret bid_price as a buyer ceiling instead of an exact honored price.
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
 * Categorizes how a price adjustment affects the transaction
 */
export type PriceAdjustmentKind = 'fee' | 'discount' | 'commission' | 'settlement';
/**
 * Measurement system for the demographic field. Defaults to nielsen when omitted.
 */
export type DemographicSystem = 'nielsen' | 'barb' | 'agf' | 'oztam' | 'mediametrie' | 'custom';
/**
 * A forecast value with optional confidence bounds. Either mid (point estimate) or both low and high (range) must be provided. mid represents the most likely outcome. low and high represent conservative and optimistic estimates. All three can be provided together.
 */
export type ForecastRange = {
  [k: string]: unknown | undefined;
} & {
  /**
   * Conservative (low-end) forecast value
   */
  low?: number;
  /**
   * Expected (most likely) forecast value
   */
  mid?: number;
  /**
   * Optimistic (high-end) forecast value
   */
  high?: number;
};
/**
 * How to interpret the points array. 'spend' (default when omitted): points at ascending budget levels. 'availability': total available inventory, budget omitted. 'reach_freq': points at ascending reach/frequency targets. 'weekly'/'daily': metrics are per-period values. 'clicks'/'conversions': points at ascending outcome targets. 'package': each point is a distinct inventory package.
 */
export type ForecastRangeUnit =
  | 'spend'
  | 'availability'
  | 'reach_freq'
  | 'weekly'
  | 'daily'
  | 'clicks'
  | 'conversions'
  | 'package';
/**
 * Method used to produce this forecast
 */
export type ForecastMethod = 'estimate' | 'modeled' | 'guaranteed';
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
       */
      signal_ids: string[];
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
       */
      signal_tags: string[];
    };
/**
 * Overall measurement readiness level for this product given the buyer's event setup. 'insufficient' means the product cannot optimize effectively with the current setup.
 */
export type AssessmentStatus = 'insufficient' | 'minimum' | 'good' | 'excellent';
/**
 * Where the conversion event originated
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
 * Lifecycle status of the installment
 */
export type InstallmentStatus = 'scheduled' | 'tentative' | 'live' | 'postponed' | 'cancelled' | 'aired' | 'published';
/**
 * Rating system used
 */
export type ContentRatingSystem =
  | 'tv_parental'
  | 'mpaa'
  | 'podcast'
  | 'esrb'
  | 'bbfc'
  | 'fsk'
  | 'acb'
  | 'chvrs'
  | 'csa'
  | 'pegi'
  | 'custom';
/**
 * Category of the event
 */
export type SpecialCategory =
  | 'awards'
  | 'championship'
  | 'concert'
  | 'conference'
  | 'election'
  | 'festival'
  | 'gala'
  | 'holiday'
  | 'premiere'
  | 'product_launch'
  | 'reunion'
  | 'tribute';
/**
 * Role of this person on the collection or installment
 */
export type TalentRole =
  | 'host'
  | 'guest'
  | 'creator'
  | 'cast'
  | 'narrator'
  | 'producer'
  | 'correspondent'
  | 'commentator'
  | 'analyst';
/**
 * What kind of derivative content this is
 */
export type DerivativeType = 'clip' | 'highlight' | 'recap' | 'trailer' | 'bonus';
/**
 * What the publisher wants back from a TMP context match. Determines the richness level of the buyer's offer response.
 */
export type TMPResponseType = 'activation' | 'catalog_items' | 'creative' | 'deal';
/**
 * Type of user identifier. Used in audience sync, event logging, and TMP identity match requests to tell the receiver which identity graph to resolve against.
 */
export type UIDType =
  | 'rampid'
  | 'id5'
  | 'uid2'
  | 'euid'
  | 'pairid'
  | 'maid'
  | 'hashed_email'
  | 'publisher_first_party'
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
  exclusivity?: Exclusivity;
  /**
   * Available pricing models for this product
   */
  pricing_options: PricingOption[];
  forecast?: DeliveryForecast;
  outcome_measurement?: OutcomeMeasurement;
  /**
   * Measurement provider and methodology for delivery metrics. The buyer accepts the declared provider as the source of truth for the buy. When absent, buyers should apply their own measurement defaults.
   */
  delivery_measurement?: {
    /**
     * Measurement provider(s) used for this product (e.g., 'Google Ad Manager with IAS viewability', 'Nielsen DAR', 'Geopath for DOOH impressions')
     */
    provider: string;
    /**
     * Additional details about measurement methodology in plain language (e.g., 'MRC-accredited viewability. 50% in-view for 1s display / 2s video', 'Panel-based demographic measurement updated monthly')
     */
    notes?: string;
  };
  measurement_terms?: MeasurementTerms;
  /**
   * Seller's default performance standards for this product: viewability, IVT, completion rate, brand safety, attention score. Buyers may propose different standards at media buy creation. When absent, no structured performance standards apply.
   */
  performance_standards?: PerformanceStandard[];
  cancellation_policy?: CancellationPolicy;
  reporting_capabilities: ReportingCapabilities;
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
   * Metric optimization capabilities for this product. Presence indicates the product supports optimization_goals with kind: 'metric'. No event source or conversion tracking setup required — the seller tracks these metrics natively.
   */
  metric_optimization?: {
    /**
     * Metric kinds this product can optimize for. Buyers should only request metric goals for kinds listed here.
     */
    supported_metrics: (
      | 'clicks'
      | 'views'
      | 'completed_views'
      | 'viewed_seconds'
      | 'attention_seconds'
      | 'attention_score'
      | 'engagements'
      | 'follows'
      | 'saves'
      | 'profile_visits'
      | 'reach'
    )[];
    /**
     * Reach units this product can optimize for. Required when supported_metrics includes 'reach'. Buyers must set reach_unit to a value in this list on reach optimization goals — sellers reject unsupported values.
     */
    supported_reach_units?: ReachUnit[];
    /**
     * Video view duration thresholds (in seconds) this product supports for completed_views goals. Only relevant when supported_metrics includes 'completed_views'. When absent, the seller uses their platform default. Buyers must set view_duration_seconds to a value in this list — sellers reject unsupported values.
     */
    supported_view_durations?: number[];
    /**
     * Target kinds available for metric goals on this product. Values match target.kind on the optimization goal. Only these target kinds are accepted — goals with unlisted target kinds will be rejected. When omitted, buyers can set target-less metric goals (maximize volume within budget) but cannot set specific targets.
     */
    supported_targets?: ('cost_per' | 'threshold_rate')[];
  };
  /**
   * Maximum number of optimization_goals this product accepts on a package. When absent, no limit is declared. Most social platforms accept only 1 goal — buyers sending arrays longer than this value should expect the seller to use only the highest-priority (lowest priority number) goal.
   */
  max_optimization_goals?: number;
  measurement_readiness?: MeasurementReadiness;
  /**
   * Conversion event tracking for this product. Presence indicates the product supports optimization_goals with kind: 'event'. Seller-level capabilities (supported event types, UID types, attribution windows) are declared in get_adcp_capabilities.
   */
  conversion_tracking?: {
    /**
     * Action sources relevant to this product (e.g. a retail media product might have 'in_store' and 'website', while a display product might only have 'website')
     */
    action_sources?: ActionSource[];
    /**
     * Target kinds available for event goals on this product. Values match target.kind on the optimization goal. cost_per: target cost per conversion event. per_ad_spend: target return on ad spend (requires value_field on event sources). maximize_value: maximize total conversion value without a specific ratio target (requires value_field). Only these target kinds are accepted — goals with unlisted target kinds will be rejected. A goal without a target implicitly maximizes conversion count within budget — no declaration needed for that mode. When omitted, buyers can still set target-less event goals.
     */
    supported_targets?: ('cost_per' | 'per_ad_spend' | 'maximize_value')[];
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
   * Expiration timestamp. After this time, the product may no longer be available for purchase and create_media_buy may reject packages referencing it.
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
  /**
   * Collections available in this product. Each entry references collections declared in an adagents.json by domain and collection ID. Buyers resolve full collection objects from the referenced adagents.json.
   */
  collections?: CollectionSelector[];
  /**
   * Whether buyers can target a subset of this product's collections. When false (default), the product is a bundle — buyers get all listed collections. When true, buyers can select specific collections in the media buy.
   */
  collection_targeting_allowed?: boolean;
  /**
   * Specific installments included in this product. Each installment references its parent collection via collection_id when the product spans multiple collections. When absent with collections present, the product covers the collections broadly (run-of-collection).
   */
  installments?: Installment[];
  /**
   * Registry policy IDs the seller enforces for this product. Enforcement level comes from the policy registry. Buyers can filter products by required policies.
   */
  enforced_policies?: string[];
  /**
   * Trusted Match Protocol capabilities for this product. When present, the product supports real-time contextual and/or identity matching via TMP. Buyers use this to determine what response types the publisher can accept and whether brands can be selected dynamically at match time.
   */
  trusted_match?: {
    /**
     * Whether this product supports Context Match requests. When true, the publisher's TMP router will send context match requests to registered providers for this product's inventory.
     */
    context_match: boolean;
    /**
     * Whether this product supports Identity Match requests. When true, the publisher's TMP router will send identity match requests to evaluate user eligibility.
     */
    identity_match?: boolean;
    /**
     * What the publisher can accept back from context match.
     */
    response_types?: TMPResponseType[];
    /**
     * Whether the buyer can select a brand at match time. When false (default), the brand must be specified on the media buy/package. When true, the buyer's offer can include any brand — the publisher applies approval rules at match time. Enables multi-brand agreements where the holding company or buyer agent selects brand based on context.
     */
    dynamic_brands?: boolean;
    /**
     * TMP providers integrated with this product's inventory. Each entry identifies a provider by agent_url (from the registry) and declares what match types it supports for this product. The product-level context_match and identity_match booleans declare what the product supports overall; the per-provider booleans declare which provider handles each match type. Enables buyer discovery: 'find products where a specific provider does context matching.'
     */
    providers?: {
      /**
       * Provider's agent URL from the registry. Canonical identifier for this TMP provider.
       */
      agent_url: string;
      /**
       * Whether this provider handles context match for this product.
       */
      context_match?: boolean;
      /**
       * Whether this provider handles identity match for this product.
       */
      identity_match?: boolean;
      /**
       * ISO 3166-1 alpha-2 country codes this provider serves for identity match. The router uses this to select the correct regional provider based on the request's country field. Required when identity_match is true.
       */
      countries?: string[];
      /**
       * Identity types this regional provider can resolve. The router filters providers whose uid_types includes the request's uid_type. Required when identity_match is true.
       */
      uid_types?: UIDType[];
    }[];
  };
  /**
   * Instructions for submitting physical creative materials (print, static OOH, cinema). Present only for products requiring physical delivery outside the digital creative assignment flow. Buyer agents MUST validate url and email domains against the seller's known domains (from adagents.json) before submitting materials. Never auto-submit without human confirmation.
   */
  material_submission?: {
    /**
     * HTTPS URL for uploading or submitting physical creative materials
     */
    url?: string;
    /**
     * Email address for creative material submission
     */
    email?: string;
    /**
     * Human-readable instructions for material submission (file naming conventions, shipping address, etc.)
     */
    instructions?: string;
    ext?: ExtensionObject;
  };
  ext?: ExtensionObject;
}
/**
 * Represents a specific ad placement within a product's inventory. When the publisher declares a placement registry in adagents.json, products SHOULD reuse those placement_id values. Reusing a registered placement_id preserves the registry's semantic identity; product-level placement objects may narrow format_ids or add operational detail, but SHOULD NOT redefine the placement's meaning incompatibly.
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
   * Optional tags for grouping placements within a product (e.g., 'homepage', 'native', 'premium'). When the placement_id comes from the publisher registry, these should align with the registry tags unless the product is narrowing scope.
   */
  tags?: string[];
  /**
   * Format IDs supported by this specific placement. Can include: (1) concrete format_ids (fixed dimensions), (2) template format_ids without parameters (accepts any dimensions/duration), or (3) parameterized format_ids (specific dimension/duration constraints).
   */
  format_ids?: FormatID[];
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
   * When true, bid_price is interpreted as the buyer's maximum willingness to pay (ceiling) rather than an exact price. Sellers may optimize actual clearing prices between floor_price and bid_price based on delivery pacing. When false or absent, bid_price (if provided) is the exact bid/price to honor.
   */
  max_bid?: boolean;
  price_guidance?: PriceGuidance;
  /**
   * Minimum spend requirement per package using this pricing option, in the specified currency
   */
  min_spend_per_package?: number;
  price_breakdown?: PriceBreakdown;
  /**
   * Adjustment kinds applicable to this pricing option. Tells buyer agents which adjustments are available before negotiation. When absent, no adjustments are pre-declared — the buyer should check price_breakdown if present.
   */
  eligible_adjustments?: PriceAdjustmentKind[];
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
   * When true, bid_price is interpreted as the buyer's maximum willingness to pay (ceiling) rather than an exact price. Sellers may optimize actual clearing prices between floor_price and bid_price based on delivery pacing. When false or absent, bid_price (if provided) is the exact bid/price to honor.
   */
  max_bid?: boolean;
  price_guidance?: PriceGuidance;
  /**
   * Minimum spend requirement per package using this pricing option, in the specified currency
   */
  min_spend_per_package?: number;
  price_breakdown?: PriceBreakdown;
  /**
   * Adjustment kinds applicable to this pricing option. Tells buyer agents which adjustments are available before negotiation. When absent, no adjustments are pre-declared — the buyer should check price_breakdown if present.
   */
  eligible_adjustments?: PriceAdjustmentKind[];
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
   * When true, bid_price is interpreted as the buyer's maximum willingness to pay (ceiling) rather than an exact price. Sellers may optimize actual clearing prices between floor_price and bid_price based on delivery pacing. When false or absent, bid_price (if provided) is the exact bid/price to honor.
   */
  max_bid?: boolean;
  price_guidance?: PriceGuidance;
  /**
   * Minimum spend requirement per package using this pricing option, in the specified currency
   */
  min_spend_per_package?: number;
  price_breakdown?: PriceBreakdown;
  /**
   * Adjustment kinds applicable to this pricing option. Tells buyer agents which adjustments are available before negotiation. When absent, no adjustments are pre-declared — the buyer should check price_breakdown if present.
   */
  eligible_adjustments?: PriceAdjustmentKind[];
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
   * When true, bid_price is interpreted as the buyer's maximum willingness to pay (ceiling) rather than an exact price. Sellers may optimize actual clearing prices between floor_price and bid_price based on delivery pacing. When false or absent, bid_price (if provided) is the exact bid/price to honor.
   */
  max_bid?: boolean;
  price_guidance?: PriceGuidance;
  /**
   * Minimum spend requirement per package using this pricing option, in the specified currency
   */
  min_spend_per_package?: number;
  price_breakdown?: PriceBreakdown;
  /**
   * Adjustment kinds applicable to this pricing option. Tells buyer agents which adjustments are available before negotiation. When absent, no adjustments are pre-declared — the buyer should check price_breakdown if present.
   */
  eligible_adjustments?: PriceAdjustmentKind[];
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
   * When true, bid_price is interpreted as the buyer's maximum willingness to pay (ceiling) rather than an exact price. Sellers may optimize actual clearing prices between floor_price and bid_price based on delivery pacing. When false or absent, bid_price (if provided) is the exact bid/price to honor.
   */
  max_bid?: boolean;
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
        };
  };
  /**
   * Minimum spend requirement per package using this pricing option, in the specified currency
   */
  min_spend_per_package?: number;
  price_breakdown?: PriceBreakdown;
  /**
   * Adjustment kinds applicable to this pricing option. Tells buyer agents which adjustments are available before negotiation. When absent, no adjustments are pre-declared — the buyer should check price_breakdown if present.
   */
  eligible_adjustments?: PriceAdjustmentKind[];
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
  };
  /**
   * Minimum spend requirement per package using this pricing option, in the specified currency
   */
  min_spend_per_package?: number;
  price_breakdown?: PriceBreakdown;
  /**
   * Adjustment kinds applicable to this pricing option. Tells buyer agents which adjustments are available before negotiation. When absent, no adjustments are pre-declared — the buyer should check price_breakdown if present.
   */
  eligible_adjustments?: PriceAdjustmentKind[];
}
/**
 * Cost Per Acquisition pricing. Advertiser pays a fixed price when a specified conversion event occurs. The event_type field declares which event triggers billing (e.g., purchase, lead, app_install).
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
  price_breakdown?: PriceBreakdown;
  /**
   * Adjustment kinds applicable to this pricing option. Tells buyer agents which adjustments are available before negotiation. When absent, no adjustments are pre-declared — the buyer should check price_breakdown if present.
   */
  eligible_adjustments?: PriceAdjustmentKind[];
}
/**
 * Flat rate pricing for sponsorships, takeovers, and DOOH exclusive placements. A fixed total cost regardless of delivery volume. For duration-scaled pricing (rate × time units), use the `time` model instead. If fixed_price is present, it's fixed pricing. If absent, it's auction-based.
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
  parameters?: DoohParameters;
  /**
   * Minimum spend requirement per package using this pricing option, in the specified currency
   */
  min_spend_per_package?: number;
  price_breakdown?: PriceBreakdown;
  /**
   * Adjustment kinds applicable to this pricing option. Tells buyer agents which adjustments are available before negotiation. When absent, no adjustments are pre-declared — the buyer should check price_breakdown if present.
   */
  eligible_adjustments?: PriceAdjustmentKind[];
}
/**
 * DOOH inventory allocation parameters. Sponsorship and takeover flat_rate options omit this field entirely — only include for digital out-of-home inventory.
 */
export interface DoohParameters {
  /**
   * Discriminator identifying this as DOOH parameters
   */
  type: 'dooh';
  /**
   * Guaranteed share of voice as a percentage (0-100)
   */
  sov_percentage?: number;
  /**
   * Duration of the ad loop rotation in seconds
   */
  loop_duration_seconds?: number;
  /**
   * Minimum number of plays per hour guaranteed
   */
  min_plays_per_hour?: number;
  /**
   * Named collection of screens included in this buy
   */
  venue_package?: string;
  /**
   * Duration of the DOOH slot in hours (e.g., 24 for a full-day takeover)
   */
  duration_hours?: number;
  /**
   * Named daypart for this slot (e.g., morning_commute, evening_rush)
   */
  daypart?: string;
  /**
   * Estimated audience impressions for this slot (informational, not a delivery guarantee)
   */
  estimated_impressions?: number;
}
/**
 * Cost per time unit (hour, day, week, or month) - rate scales with campaign duration. If fixed_price is present, it's fixed pricing. If absent, it's auction-based.
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
  };
  /**
   * Minimum spend requirement per package using this pricing option, in the specified currency
   */
  min_spend_per_package?: number;
  price_breakdown?: PriceBreakdown;
  /**
   * Adjustment kinds applicable to this pricing option. Tells buyer agents which adjustments are available before negotiation. When absent, no adjustments are pre-declared — the buyer should check price_breakdown if present.
   */
  eligible_adjustments?: PriceAdjustmentKind[];
}
/**
 * Forecasted delivery metrics for this product. Gives buyers an estimate of expected performance before requesting a proposal.
 */
export interface DeliveryForecast {
  /**
   * Forecasted delivery data points. For spend curves (default), points at ascending budget levels show how metrics scale with spend. For availability forecasts, points represent total available inventory independent of budget. See forecast_range_unit for interpretation.
   */
  points: ForecastPoint[];
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
  /**
   * Third-party measurement provider whose data was used to produce this forecast. Distinct from demographic_system, which specifies demographic notation — measurement_source identifies whose data produced the forecast numbers. Should be present when measured_impressions is used. Lowercase slug format.
   */
  measurement_source?: string;
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
}
/**
 * A forecast data point. When budget is present, the point pairs a spend level with expected delivery — multiple points at ascending budgets form a curve. When budget is omitted, the point represents total available inventory for the requested targeting and dates, independent of spend.
 */
export interface ForecastPoint {
  /**
   * Human-readable name for this forecast point. Required when forecast_range_unit is 'package' so buyer agents can identify and reference individual packages. Optional for other forecast types.
   */
  label?: string;
  /**
   * Budget amount for this forecast point. Required for spend curves; omit for availability forecasts where the metrics represent total available inventory. For allocation-level forecasts, this is the absolute budget for that allocation (not the percentage). For proposal-level forecasts, this is the total proposal budget. When omitted, use metrics.spend to express the estimated cost of the available inventory.
   */
  budget?: number;
  /**
   * Forecasted metric values. Keys are forecastable-metric enum values for delivery/engagement or event-type enum values for outcomes. Values are ForecastRange objects (low/mid/high). Use { "mid": value } for point estimates. When budget is present, these are the expected metrics at that spend level. When budget is omitted, these represent total available inventory — use spend to express the estimated cost. Additional keys beyond the documented properties are allowed for event-type values (purchase, lead, app_install, etc.).
   */
  metrics: {
    audience_size?: ForecastRange;
    reach?: ForecastRange;
    frequency?: ForecastRange;
    impressions?: ForecastRange;
    clicks?: ForecastRange;
    spend?: ForecastRange;
    views?: ForecastRange;
    completed_views?: ForecastRange;
    grps?: ForecastRange;
    engagements?: ForecastRange;
    follows?: ForecastRange;
    saves?: ForecastRange;
    profile_visits?: ForecastRange;
    measured_impressions?: ForecastRange;
    downloads?: ForecastRange;
    plays?: ForecastRange;
    [k: string]: ForecastRange | undefined;
  };
}
/**
 * Business outcome measurement capabilities included with a product (e.g., incremental sales lift, brand lift, foot traffic). Distinct from delivery_measurement, which declares who counts ad impressions.
 */
export interface OutcomeMeasurement {
  /**
   * Type of measurement
   */
  type: string;
  /**
   * Attribution methodology
   */
  attribution: string;
  /**
   * Attribution window as a structured duration (e.g., {"interval": 30, "unit": "days"}).
   */
  window?: Duration;
  /**
   * Reporting frequency and format
   */
  reporting: string;
}
/**
 * Cancellation terms for this product. Declares the minimum notice period required before cancellation takes effect and any penalties for insufficient notice. Relevant for guaranteed delivery products. Buyers accept these terms by creating a media buy against the product.
 */
export interface CancellationPolicy {
  notice_period: Duration;
  /**
   * Fee applied when the notice period is not met.
   */
  cancellation_fee: {
    /**
     * Fee calculation method. 'percent_remaining': percentage of remaining uncommitted spend. 'full_commitment': buyer owes the full committed budget regardless of delivery. 'fixed_fee': flat monetary amount. 'none': no financial fee (cancellation with notice is free).
     */
    type: 'percent_remaining' | 'full_commitment' | 'fixed_fee' | 'none';
    /**
     * Fee rate as a decimal proportion of remaining committed spend. Required when type is 'percent_remaining' (e.g., 0.5 means 50% of remaining spend).
     */
    rate?: number;
    /**
     * Fixed fee amount in the buy's currency. Required when type is 'fixed_fee'.
     */
    amount?: number;
  };
}
/**
 * Reporting capabilities available for a product
 */
export interface ReportingCapabilities {
  /**
   * Supported reporting frequency options
   */
  available_reporting_frequencies: ReportingFrequency[];
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
   * Whether this product supports keyword-level metric breakdowns in delivery reporting (by_keyword within by_package)
   */
  supports_keyword_breakdown?: boolean;
  supports_geo_breakdown?: GeographicBreakdownSupport;
  /**
   * Whether this product supports device type breakdowns in delivery reporting (by_device_type within by_package)
   */
  supports_device_type_breakdown?: boolean;
  /**
   * Whether this product supports device platform breakdowns in delivery reporting (by_device_platform within by_package)
   */
  supports_device_platform_breakdown?: boolean;
  /**
   * Whether this product supports audience segment breakdowns in delivery reporting (by_audience within by_package)
   */
  supports_audience_breakdown?: boolean;
  /**
   * Whether this product supports placement breakdowns in delivery reporting (by_placement within by_package)
   */
  supports_placement_breakdown?: boolean;
  /**
   * Whether delivery data can be filtered to arbitrary date ranges. 'date_range' means the platform supports start_date/end_date parameters. 'lifetime_only' means the platform returns campaign lifetime totals and date range parameters are not accepted.
   */
  date_range_support: 'date_range' | 'lifetime_only';
  /**
   * Measurement maturation windows available for this product. Used by broadcast and linear TV sellers where measurement accumulates over time (Live, C3, C7). Each window defines an accumulation period and expected data availability. When present, delivery reports reference a specific window_id. Digital-only sellers typically omit this.
   */
  measurement_windows?: MeasurementWindow[];
}
/**
 * Geographic breakdown support for this product. Declares which geo levels and systems are available for by_geo reporting within by_package.
 */
export interface GeographicBreakdownSupport {
  /**
   * Supports country-level geo breakdown (ISO 3166-1 alpha-2)
   */
  country?: boolean;
  /**
   * Supports region/state-level geo breakdown (ISO 3166-2)
   */
  region?: boolean;
  /**
   * Metro area breakdown support. Keys are metro-system enum values; true means supported.
   */
  metro?: {
    [k: string]: boolean | undefined;
  };
  /**
   * Postal area breakdown support. Keys are postal-system enum values; true means supported.
   */
  postal_area?: {
    [k: string]: boolean | undefined;
  };
}
/**
 * A measurement maturation window for broadcast and linear TV. Broadcast measurement is not delayed data — it matures over time as time-shifted (DVR) viewing accumulates. Each window represents a defined accumulation period after the live broadcast.
 */
export interface MeasurementWindow {
  /**
   * Identifier for this measurement window. Standard values: 'live' (real-time viewers only), 'c3' (live + 3 days time-shifted), 'c7' (live + 7 days time-shifted). Sellers may define custom windows for other accumulation periods.
   */
  window_id: string;
  /**
   * Human-readable description of what this window measures
   */
  description?: string;
  /**
   * Number of days after live broadcast included in this window. 0 = live only, 3 = live + 3 days DVR, 7 = live + 7 days DVR.
   */
  duration_days: number;
  /**
   * Expected number of days after broadcast before this window's data is available from the measurement vendor. For example, C7 window data from VideoAmp typically arrives ~22 days after broadcast (7-day accumulation + ~15-day processing).
   */
  expected_availability_days?: number;
  /**
   * Whether this window is the basis for delivery guarantees and reconciliation. A product typically has one guarantee basis window (e.g., C7 for most US broadcast). Buyers reconcile against the guarantee basis window's final numbers.
   */
  is_guarantee_basis?: boolean;
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
  /**
   * Whether creatives must include provenance metadata. When true, the seller requires buyers to attach provenance declarations to creative submissions. The seller may independently verify claims via get_creative_features.
   */
  provenance_required?: boolean;
}
/**
 * Assessment of whether the buyer's event source setup is sufficient for this product to optimize effectively. Only present when the seller can evaluate the buyer's account context. Buyers should check this before creating media buys with event-based optimization goals.
 */
export interface MeasurementReadiness {
  status: AssessmentStatus;
  /**
   * Event types this product needs for effective optimization. Buyers should ensure their event sources cover these types.
   */
  required_event_types?: EventType[];
  /**
   * Event types this product requires that the buyer has not configured. Empty or absent when all required types are covered.
   */
  missing_event_types?: EventType[];
  /**
   * Actionable issues preventing full measurement readiness. Sellers should limit to the top 3-5 most actionable items. Buyer agents should sort by severity rather than relying on array position.
   */
  issues?: DiagnosticIssue[];
  /**
   * Seller explanation of the readiness assessment, recommendations for improvement, or context about what the buyer needs to change.
   */
  notes?: string;
}
/**
 * An actionable issue detected during a health or readiness assessment. Used by event source health and measurement readiness to surface problems and recommendations.
 */
export interface DiagnosticIssue {
  /**
   * 'error': blocks optimization until resolved. 'warning': optimization works but effectiveness is reduced. 'info': suggestion for improvement.
   */
  severity: 'error' | 'warning' | 'info';
  /**
   * Human/agent-readable description of the issue and how to resolve it.
   */
  message: string;
}
/**
 * References collections declared in an adagents.json. Buyers resolve full collection objects by fetching the adagents.json at the given domain and matching collection_ids against its collections array.
 */
export interface CollectionSelector {
  /**
   * Domain where the adagents.json declaring these collections is hosted (e.g., 'mrbeast.com'). The collections array in that file contains the authoritative collection definitions.
   */
  publisher_domain: string;
  /**
   * Collection IDs from the adagents.json collections array. Each ID must match a collection_id declared in that file.
   */
  collection_ids: string[];
}
/**
 * A single bookable unit within a collection — one episode, issue, event, or rotation period. The parent collection's kind indicates how to interpret each installment: TV/podcast episodes, print issues, live event airings, newsletter editions, or DOOH rotation periods. Installments inherit collection-level fields they don't override: content_rating defaults to the collection's baseline, guest_talent is additive to the collection's recurring talent, and topics add context beyond the collection's genre.
 */
export interface Installment {
  /**
   * Unique identifier for this installment within the collection
   */
  installment_id: string;
  /**
   * Parent collection reference. Required when the product spans multiple collections. Maps to a collection_id declared in one of the publishers' adagents.json files referenced by the product's collection selectors.
   */
  collection_id?: string;
  /**
   * Installment title
   */
  name?: string;
  /**
   * Season identifier (e.g., '1', '2024', 'spring_2026')
   */
  season?: string;
  /**
   * Installment number within the season (e.g., '3', '47')
   */
  installment_number?: string;
  /**
   * When the installment airs or publishes (ISO 8601)
   */
  scheduled_at?: string;
  status?: InstallmentStatus;
  /**
   * Expected duration of the installment in seconds
   */
  duration_seconds?: number;
  /**
   * Whether the end time is approximate (live events, sports)
   */
  flexible_end?: boolean;
  /**
   * When this installment data expires and should be re-queried. Agents should re-query before committing budget to products with tentative installments.
   */
  valid_until?: string;
  content_rating?: ContentRating;
  /**
   * Content topics for this installment. Uses the same taxonomy as the collection's genre_taxonomy when present. Enables installment-level brand safety evaluation beyond content_rating.
   */
  topics?: string[];
  special?: Special;
  /**
   * Installment-specific guests and talent. Additive to the collection's recurring talent.
   */
  guest_talent?: Talent[];
  ad_inventory?: AdInventoryConfiguration;
  deadlines?: InstallmentDeadlines;
  /**
   * When this installment is a clip, highlight, or recap derived from a full installment. The source installment_id must reference an installment within the same response.
   */
  derivative_of?: {
    /**
     * The source installment this content is derived from
     */
    installment_id: string;
    type: DerivativeType;
  };
  ext?: ExtensionObject;
}
/**
 * Installment-specific content rating. Overrides the collection's baseline content_rating when present.
 */
export interface ContentRating {
  system: ContentRatingSystem;
  /**
   * Rating value within the system (e.g., 'TV-PG', 'R', 'explicit')
   */
  rating: string;
}
/**
 * Installment-specific event context. When present, this installment is anchored to a real-world event. Overrides the collection-level special when present.
 */
export interface Special {
  /**
   * Name of the event (e.g., 'Olympics 2028', 'Super Bowl LXI')
   */
  name: string;
  category?: SpecialCategory;
  /**
   * When the event starts (ISO 8601)
   */
  starts?: string;
  /**
   * When the event ends (ISO 8601). Omit for single-day events.
   */
  ends?: string;
}
/**
 * A person associated with a collection or installment, with an optional link to their brand.json identity
 */
export interface Talent {
  role: TalentRole;
  /**
   * Person's name as credited on the collection
   */
  name: string;
  /**
   * URL to this person's brand.json entry. Enables buyer agents to evaluate the talent's brand identity and associations.
   */
  brand_url?: string;
}
/**
 * Break-based ad inventory for this installment. For non-break formats (host reads, integrations), use product placements.
 */
export interface AdInventoryConfiguration {
  /**
   * Number of planned ad breaks in the installment
   */
  expected_breaks: number;
  /**
   * Total seconds of ad time across all breaks
   */
  total_ad_seconds?: number;
  /**
   * Maximum duration in seconds for a single ad within a break. Buyers need this to know whether their creative fits.
   */
  max_ad_duration_seconds?: number;
  /**
   * Whether ad breaks are dynamic and driven by live conditions (sports timeouts, election coverage). When false, all breaks are pre-defined.
   */
  unplanned_breaks?: boolean;
  /**
   * Ad format types supported in breaks (e.g., 'video', 'audio', 'display')
   */
  supported_formats?: string[];
}
/**
 * Booking, cancellation, and material submission deadlines for this installment. Present when the installment has time-sensitive inventory that requires advance commitment or material delivery.
 */
export interface InstallmentDeadlines {
  /**
   * Last date/time to book a placement in this installment (ISO 8601). After this point, the seller will not accept new bookings.
   */
  booking_deadline?: string;
  /**
   * Last date/time to cancel without penalty (ISO 8601). Cancellations after this point may incur fees per the seller's terms.
   */
  cancellation_deadline?: string;
  /**
   * Stages for creative material submission. Items MUST be in chronological order by due_at (earliest first). Typical pattern: 'draft' for raw materials the seller will process, 'final' for production-ready assets. Print example: draft artwork then press-ready PDF. Influencer example: talking points then approved script.
   */
  material_deadlines?: MaterialDeadline[];
}
/**
 * A deadline for creative material submission. Sellers declare stages to distinguish draft materials (e.g., talking points, raw artwork) from production-ready assets (e.g., approved scripts, press-ready PDFs).
 */
export interface MaterialDeadline {
  /**
   * Submission stage identifier. Use 'draft' for materials that need seller processing and 'final' for production-ready assets. Sellers may define additional stages.
   */
  stage: string;
  /**
   * When materials for this stage are due (ISO 8601)
   */
  due_at: string;
  /**
   * What the seller needs at this stage (e.g., 'Talking points and brand guidelines', 'Press-ready PDF with bleed')
   */
  label?: string;
}

// TARGETING SCHEMA

// PROPERTY SCHEMA
/**
 * Type of advertising property
 */
export type PropertyType =
  | 'website'
  | 'mobile_app'
  | 'ctv_app'
  | 'desktop_app'
  | 'dooh'
  | 'podcast'
  | 'radio'
  | 'linear_tv'
  | 'streaming_audio'
  | 'ai_assistant';
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
  | 'spotify_collection_id'
  | 'podcast_guid'
  | 'station_id'
  | 'facility_id';
/**
 * An advertising property that can be validated via adagents.json
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
  | 'get_account_financials'
  | 'get_creative_delivery'
  | 'sync_event_sources'
  | 'sync_audiences'
  | 'sync_catalogs'
  | 'log_event'
  | 'get_brand_identity'
  | 'get_rights'
  | 'acquire_rights';
/**
 * AdCP domain this task belongs to. Helps classify the operation type at a high level.
 */
export type AdCPDomain = 'media-buy' | 'signals' | 'governance' | 'creative' | 'brand';
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
  | BuildCreativeResponse
  | BuildCreativeAsyncWorking
  | BuildCreativeAsyncInputRequired
  | BuildCreativeAsyncSubmitted
  | SyncCreativesResponse
  | SyncCreativesAsyncWorking
  | SyncCreativesAsyncInputRequired
  | SyncCreativesAsyncSubmitted
  | SyncCatalogsResponse
  | SyncCatalogsAsyncWorking
  | SyncCatalogsAsyncInputRequired
  | SyncCatalogsAsyncSubmitted;
/**
 * Lifecycle status of this proposal. When absent, the proposal is ready to buy (backward compatible). 'draft' means indicative pricing — finalize via refine before purchasing. 'committed' means firm pricing with inventory reserved until expires_at.
 */
export type ProposalStatus = 'draft' | 'committed';
/**
 * Response for completed or failed create_media_buy
 */
export type CreateMediaBuyResponse = CreateMediaBuySuccess | CreateMediaBuyError;
/**
 * Selects an audience by signal reference or natural language description. Uses 'type' as the primary discriminator (signal vs description). Signal selectors additionally use 'value_type' to determine the targeting expression format (matching signal-targeting.json variants).
 */
export type AudienceSelector =
  | {
      /**
       * Discriminator for signal-based selectors
       */
      type: 'signal';
      signal_id: SignalID;
      /**
       * Discriminator for binary signals
       */
      value_type: 'binary';
      /**
       * Whether to include (true) or exclude (false) users matching this signal
       */
      value: boolean;
    }
  | {
      /**
       * Discriminator for signal-based selectors
       */
      type: 'signal';
      signal_id: SignalID;
      /**
       * Discriminator for categorical signals
       */
      value_type: 'categorical';
      /**
       * Values to target. Users with any of these values will be included.
       */
      values: string[];
    }
  | {
      /**
       * Discriminator for signal-based selectors
       */
      type: 'signal';
      signal_id: SignalID;
      /**
       * Discriminator for numeric signals
       */
      value_type: 'numeric';
      /**
       * Minimum value (inclusive). Omit for no minimum. Must be <= max_value when both are provided.
       */
      min_value?: number;
      /**
       * Maximum value (inclusive). Omit for no maximum. Must be >= min_value when both are provided.
       */
      max_value?: number;
    }
  | {
      /**
       * Discriminator for description-based selectors
       */
      type: 'description';
      /**
       * Natural language description of the audience (e.g., 'likely EV buyers', 'high net worth individuals', 'vulnerable communities')
       */
      description: string;
      /**
       * Optional grouping hint for the governance agent (e.g., 'demographic', 'behavioral', 'contextual', 'financial')
       */
      category?: string;
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
    };
/**
 * Response for completed or failed update_media_buy
 */
export type UpdateMediaBuyResponse = UpdateMediaBuySuccess | UpdateMediaBuyError;
/**
 * Response for completed or failed build_creative
 */
export type BuildCreativeResponse = BuildCreativeSuccess | BuildCreativeMultiSuccess | BuildCreativeError;
/**
 * Types of rights usage that can be licensed through the brand protocol. Aligned with DDEX UseType direction for interoperability with music and media rights systems.
 */
export type RightUse =
  | 'likeness'
  | 'voice'
  | 'name'
  | 'endorsement'
  | 'motion_capture'
  | 'signature'
  | 'catchphrase'
  | 'sync'
  | 'background_music'
  | 'editorial'
  | 'commercial';
/**
 * Type of rights (talent, music, etc.). Helps identify constraints when a creative combines multiple rights types.
 */
export type RightType = 'talent' | 'character' | 'brand_ip' | 'music' | 'stock_media';
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
   * Client-generated identifier that was embedded in the webhook URL by the buyer. Publishers echo this back in webhook payloads so clients can correlate notifications without parsing URL paths. Typically generated as a unique ID per task invocation.
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
  /**
   * Seller's response to each change request in the refine array, matched by position. Each entry acknowledges whether the corresponding ask was applied, partially applied, or unable to be fulfilled. MUST contain the same number of entries in the same order as the request's refine array. Only present when the request used buying_mode: 'refine'.
   */
  refinement_applied?: {
    /**
     * Echoes the scope from the corresponding refine entry. Allows orchestrators to cross-validate alignment.
     */
    scope?: 'request' | 'product' | 'proposal';
    /**
     * Echoes the id from the corresponding refine entry (for product and proposal scopes).
     */
    id?: string;
    /**
     * 'applied': the ask was fulfilled. 'partial': the ask was partially fulfilled — see notes for details. 'unable': the seller could not fulfill the ask — see notes for why.
     */
    status: 'applied' | 'partial' | 'unable';
    /**
     * Seller explanation of what was done, what couldn't be done, or why. Recommended when status is 'partial' or 'unable'.
     */
    notes?: string;
  }[];
  /**
   * Declares what the seller could not finish within the buyer's time_budget or due to internal limits. Each entry identifies a scope that is missing or partial. Absent when the response is fully complete.
   */
  incomplete?: {
    /**
     * 'products': not all inventory sources were searched. 'pricing': products returned but pricing is absent or unconfirmed. 'forecast': products returned but forecast data is absent. 'proposals': proposals were not generated or are incomplete.
     */
    scope: 'products' | 'pricing' | 'forecast' | 'proposals';
    /**
     * Human-readable explanation of what is missing and why.
     */
    description: string;
    /**
     * How much additional time would resolve this scope. Allows the buyer to decide whether to retry with a larger time_budget.
     */
    estimated_wait?: Duration;
  }[];
  pagination?: PaginationResponse;
  /**
   * When true, this response contains simulated data from sandbox mode.
   */
  sandbox?: boolean;
  context?: ContextObject;
  ext?: ExtensionObject;
}
/**
 * A proposed media plan with budget allocations across products. Represents the publisher's strategic recommendation for how to structure a campaign based on the brief. Proposals are actionable - buyers can execute them directly via create_media_buy by providing the proposal_id.
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
   */
  allocations: ProductAllocation[];
  proposal_status?: ProposalStatus;
  /**
   * When this proposal expires and can no longer be executed. For draft proposals, indicates when indicative pricing becomes stale. For committed proposals, indicates when the inventory hold lapses — the buyer must call create_media_buy before this time.
   */
  expires_at?: string;
  insertion_order?: InsertionOrder;
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
  };
  /**
   * Explanation of how this proposal aligns with the campaign brief
   */
  brief_alignment?: string;
  forecast?: DeliveryForecast;
  ext?: ExtensionObject;
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
   * Recommended flight start date/time for this allocation in ISO 8601 format. Allows publishers to propose per-flight scheduling within a proposal. When omitted, the allocation applies to the full campaign date range.
   */
  start_time?: string;
  /**
   * Recommended flight end date/time for this allocation in ISO 8601 format. Allows publishers to propose per-flight scheduling within a proposal. When omitted, the allocation applies to the full campaign date range.
   */
  end_time?: string;
  /**
   * Recommended time windows for this allocation in spot-plan proposals.
   */
  daypart_targets?: DaypartTarget[];
  forecast?: DeliveryForecast;
  ext?: ExtensionObject;
}
/**
 * Formal insertion order attached to a committed proposal. Present when the seller requires a signed agreement before the media buy can proceed. The buyer references the io_id in io_acceptance on create_media_buy.
 */
export interface InsertionOrder {
  /**
   * Unique identifier for this insertion order. Referenced by io_acceptance on create_media_buy.
   */
  io_id: string;
  /**
   * Summary fields echoed from the committed proposal for agent verification. Buyer agents use these to confirm the IO matches what was negotiated before a human signs. These are read-only summaries, not negotiation surfaces — deal terms live on products and packages.
   */
  terms?: {
    /**
     * Advertiser name or identifier
     */
    advertiser?: string;
    /**
     * Publisher name or identifier
     */
    publisher?: string;
    /**
     * Total committed budget
     */
    total_budget?: {
      amount: number;
      /**
       * ISO 4217 currency code
       */
      currency: string;
    };
    /**
     * Campaign start date
     */
    flight_start?: string;
    /**
     * Campaign end date
     */
    flight_end?: string;
    /**
     * Payment terms
     */
    payment_terms?: 'net_30' | 'net_60' | 'net_90' | 'prepaid' | 'due_on_receipt';
  };
  /**
   * URL to a human-readable document containing the full insertion order terms
   */
  terms_url?: string;
  /**
   * URL to an electronic signing service (e.g., DocuSign) for human signature workflows. When present, a human must sign before the buyer agent can proceed with create_media_buy.
   */
  signing_url?: string;
  /**
   * Whether the buyer must accept this IO before creating a media buy. When true, create_media_buy requires an io_acceptance referencing this io_id.
   */
  requires_signature: boolean;
}
/**
 * Standard error structure for task-specific errors and warnings
 */
export interface Error {
  /**
   * Error code for programmatic handling. Standard codes are defined in error-code.json and enable autonomous agent recovery. Sellers MAY use codes not in the standard vocabulary for platform-specific errors; agents MUST handle unknown codes gracefully by falling back to the recovery classification.
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
   * Seconds to wait before retrying the operation. Sellers MUST return values between 1 and 3600. Clients MUST clamp values outside this range.
   */
  retry_after?: number;
  /**
   * Additional task-specific error details
   */
  details?: {};
  /**
   * Agent recovery classification. transient: retry after delay (rate limit, service unavailable, timeout). correctable: fix the request and resend (invalid field, budget too low, creative rejected). terminal: requires human action (account suspended, payment required, account not found).
   */
  recovery?: 'transient' | 'correctable' | 'terminal';
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
}
/**
 * Success response - media buy created successfully
 */
export interface CreateMediaBuySuccess {
  /**
   * Seller's unique identifier for the created media buy
   */
  media_buy_id: string;
  account?: Account;
  invoice_recipient?: BusinessEntity;
  status?: MediaBuyStatus;
  /**
   * ISO 8601 timestamp when this media buy was confirmed by the seller. A successful create_media_buy response constitutes order confirmation.
   */
  confirmed_at?: string;
  /**
   * ISO 8601 timestamp for creative upload deadline
   */
  creative_deadline?: string;
  /**
   * Initial revision number for this media buy. Use in subsequent update_media_buy requests for optimistic concurrency.
   */
  revision?: number;
  /**
   * Actions the buyer can perform on this media buy after creation. Saves a round-trip to get_media_buys.
   */
  valid_actions?: (
    | 'pause'
    | 'resume'
    | 'cancel'
    | 'update_budget'
    | 'update_dates'
    | 'update_packages'
    | 'add_packages'
    | 'sync_creatives'
  )[];
  /**
   * Array of created packages with complete state information
   */
  packages: Package[];
  planned_delivery?: PlannedDelivery;
  /**
   * When true, this response contains simulated data from sandbox mode.
   */
  sandbox?: boolean;
  context?: ContextObject;
  ext?: ExtensionObject;
}
/**
 * Agreed billing measurement and makegood terms for this package. Reflects what was negotiated — may differ from the buyer's proposal or the product's defaults. When present, these terms are binding for the package's duration.
 */
export interface MeasurementTerms1 {
  /**
   * Which vendor's count of the billing metric governs invoicing. The billing metric is determined by the pricing_model on the selected pricing_option (e.g., impressions for CPM, completed views for CPCV).
   */
  billing_measurement?: {
    vendor: BrandReference;
    /**
     * Maximum acceptable variance between the billing vendor's count and the other party's count before resolution is triggered (e.g., 10 means a 10% divergence triggers review).
     */
    max_variance_percent?: number;
    /**
     * Which measurement window the billing metric is reconciled against. References a window_id from the product's reporting_capabilities.measurement_windows. For broadcast TV, this is typically 'c7' (live + 7 days DVR). When absent, billing is based on the seller's standard reporting without windowed maturation.
     */
    measurement_window?: string;
  };
  /**
   * Remedies available when a performance standard or billing measurement variance is breached. Seller declares which remedy types they support. When a breach occurs, the seller proposes a remedy from this menu; the buyer accepts or disputes.
   */
  makegood_policy?: {
    /**
     * Remedy types the seller supports. Ordered by seller preference (first = preferred). Seller proposes from this list when a breach occurs; buyer accepts or disputes.
     */
    available_remedies: MakegoodRemedy[];
  };
}
/**
 * The seller's interpreted delivery parameters. Describes what the seller will actually run -- geo, channels, flight dates, frequency caps, and budget. Present when the account has governance_agents or when the seller chooses to provide delivery transparency.
 */
export interface PlannedDelivery {
  /**
   * Geographic targeting the seller will apply.
   */
  geo?: {
    /**
     * ISO 3166-1 alpha-2 country codes where ads will deliver.
     */
    countries?: string[];
    /**
     * ISO 3166-2 subdivision codes where ads will deliver.
     */
    regions?: string[];
  };
  /**
   * Channels the seller will deliver on.
   */
  channels?: MediaChannel[];
  /**
   * Actual flight start the seller will use.
   */
  start_time?: string;
  /**
   * Actual flight end the seller will use.
   */
  end_time?: string;
  frequency_cap?: FrequencyCap;
  /**
   * Human-readable summary of the audience the seller will target.
   */
  audience_summary?: string;
  /**
   * Structured audience targeting the seller will activate. Each entry is either a signal reference or a descriptive criterion. When present, governance agents MUST use this for bias/fairness validation and SHOULD ignore audience_summary for validation purposes. The audience_summary field is a human-readable rendering of this array, not an independent declaration.
   */
  audience_targeting?: AudienceSelector[];
  /**
   * Total budget the seller will deliver against.
   */
  total_budget?: number;
  /**
   * ISO 4217 currency code for the budget.
   */
  currency?: string;
  /**
   * Registry policy IDs the seller will enforce for this delivery.
   */
  enforced_policies?: string[];
  ext?: ExtensionObject;
}
/**
 * Error response - operation failed, no media buy created
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
}
/**
 * Acknowledgment for submitted create_media_buy
 */
export interface CreateMediaBuyAsyncSubmitted {
  context?: ContextObject;
  ext?: ExtensionObject;
}
/**
 * Success response - media buy updated successfully
 */
export interface UpdateMediaBuySuccess {
  /**
   * Seller's identifier for the media buy
   */
  media_buy_id: string;
  status?: MediaBuyStatus;
  /**
   * Revision number after this update. Use this value in subsequent update_media_buy requests for optimistic concurrency.
   */
  revision?: number;
  /**
   * ISO 8601 timestamp when changes take effect (null if pending approval)
   */
  implementation_date?: string | null;
  invoice_recipient?: BusinessEntity;
  /**
   * Array of packages that were modified with complete state information
   */
  affected_packages?: Package[];
  /**
   * Actions the buyer can perform after this update. Saves a round-trip to get_media_buys.
   */
  valid_actions?: (
    | 'pause'
    | 'resume'
    | 'cancel'
    | 'update_budget'
    | 'update_dates'
    | 'update_packages'
    | 'add_packages'
    | 'sync_creatives'
  )[];
  /**
   * When true, this response contains simulated data from sandbox mode.
   */
  sandbox?: boolean;
  context?: ContextObject;
  ext?: ExtensionObject;
}
/**
 * Error response - operation failed, no changes applied
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
}
/**
 * Acknowledgment for submitted update_media_buy
 */
export interface UpdateMediaBuyAsyncSubmitted {
  context?: ContextObject;
  ext?: ExtensionObject;
}
/**
 * Single-format success response. Returned when the request used target_format_id.
 */
export interface BuildCreativeSuccess {
  creative_manifest: CreativeManifest;
  /**
   * When true, this response contains simulated data from sandbox mode.
   */
  sandbox?: boolean;
  /**
   * ISO 8601 timestamp when generated asset URLs in the manifest expire. Set to the earliest expiration across all generated assets. Re-build the creative after this time to get fresh URLs.
   */
  expires_at?: string;
  /**
   * Preview renders included when the request set include_preview to true and the agent supports it. Contains the same content fields as a preview_creative single response (previews, interactive_url, expires_at) minus the response_type discriminator, so clients can reuse the same preview rendering logic.
   */
  preview?: {
    /**
     * Array of preview variants. Each preview corresponds to an input set from preview_inputs, or a single default preview if no inputs were provided.
     */
    previews: {
      /**
       * Unique identifier for this preview variant
       */
      preview_id: string;
      /**
       * Array of rendered pieces for this preview variant. Most formats render as a single piece. Companion ad formats render as multiple pieces.
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
     * Optional URL to an interactive testing page that shows all preview variants with controls to switch between them.
     */
    interactive_url?: string;
    /**
     * ISO 8601 timestamp when preview URLs expire. May differ from the manifest's expires_at.
     */
    expires_at: string;
  };
  preview_error?: Error;
  /**
   * Which rate card pricing option was applied for this build. Present when the creative agent charges for its services. Pass this in report_usage to identify which pricing option was applied.
   */
  pricing_option_id?: string;
  /**
   * Cost incurred for this build, denominated in currency. May be 0 for CPM-priced creatives where cost accrues at serve time rather than build time.
   */
  vendor_cost?: number;
  /**
   * ISO 4217 currency code for vendor_cost.
   */
  currency?: string;
  consumption?: CreativeConsumption;
  context?: ContextObject;
  ext?: ExtensionObject;
}
/**
 * The generated or transformed creative manifest
 */
export interface CreativeManifest {
  format_id: FormatID;
  /**
   * Map of asset IDs to actual asset content. Each key MUST match an asset_id from the format's assets array (e.g., 'banner_image', 'clickthrough_url', 'video_file', 'vast_tag'). The asset_id is the technical identifier used to match assets to format requirements.
   *
   * IMPORTANT: Full validation requires format context. The format defines what type each asset_id should be. Standalone schema validation only checks structural conformance — each asset must match at least one valid asset type schema.
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
      | MarkdownAsset
      | BriefAsset
      | CatalogAsset;
  };
  /**
   * Rights constraints attached to this creative. Each entry represents constraints from a single rights holder. A creative may combine multiple rights constraints (e.g., talent likeness + music license). For v1, rights constraints are informational metadata — the buyer/orchestrator manages creative lifecycle against these terms.
   */
  rights?: RightsConstraint[];
  /**
   * Industry-standard identifiers for this specific manifest (e.g., Ad-ID, ISCI, Clearcast clock number). When present, overrides creative-level identifiers. Use when different format versions of the same source creative have distinct Ad-IDs (e.g., the :15 and :30 cuts).
   */
  industry_identifiers?: IndustryIdentifier[];
  provenance?: Provenance;
  ext?: ExtensionObject;
}
/**
 * Rights metadata attached to a creative manifest. Each entry represents constraints from a single rights holder. A creative may combine multiple rights constraints (e.g., talent likeness + music license). For v1, rights constraints are informational metadata — the buyer/orchestrator manages creative lifecycle against these terms.
 */
export interface RightsConstraint {
  /**
   * Rights grant identifier from the acquire_rights response
   */
  rights_id: string;
  /**
   * The agent that granted these rights
   */
  rights_agent: {
    /**
     * MCP endpoint URL of the rights agent
     */
    url: string;
    /**
     * Agent identifier
     */
    id: string;
  };
  /**
   * Start of the rights validity period
   */
  valid_from?: string;
  /**
   * End of the rights validity period. Creative should not be served after this time.
   */
  valid_until?: string;
  /**
   * Rights uses covered by this constraint
   */
  uses: RightUse[];
  /**
   * Countries where this creative may be served under these rights (ISO 3166-1 alpha-2). If omitted, no country restriction. When both countries and excluded_countries are present, the effective set is countries minus excluded_countries.
   */
  countries?: string[];
  /**
   * Countries excluded from rights availability (ISO 3166-1 alpha-2). Use when the grant is worldwide except specific markets.
   */
  excluded_countries?: string[];
  /**
   * Maximum total impressions allowed for the full validity period (valid_from to valid_until). This is the absolute cap across all creatives using this rights grant, not a per-creative or per-period limit.
   */
  impression_cap?: number;
  right_type?: RightType;
  /**
   * Approval status from the rights holder at manifest creation time (snapshot, not a live value)
   */
  approval_status?: 'pending' | 'approved' | 'rejected';
  /**
   * URL where downstream supply chain participants can verify this rights grant is active. Returns HTTP 200 with the current grant status, or 404 if revoked. Enables SSPs and verification vendors to confirm rights before serving.
   */
  verification_url?: string;
  ext?: ExtensionObject;
}
/**
 * Structured consumption details for this build. Informational — lets the buyer verify that vendor_cost is consistent with the rate card. vendor_cost is the billing source of truth.
 */
export interface CreativeConsumption {
  /**
   * LLM or generation tokens consumed during creative generation.
   */
  tokens?: number;
  /**
   * Number of images produced during generation.
   */
  images_generated?: number;
  /**
   * Number of render passes performed (video, animation).
   */
  renders?: number;
  /**
   * Processing time billed, in seconds. For compute-time pricing models.
   */
  duration_seconds?: number;
}
/**
 * Multi-format success response. Returned when the request used target_format_ids. Contains one manifest per requested format. Multi-format requests are atomic — all formats must succeed or the entire request fails with an error response. Array order corresponds to the target_format_ids request order.
 */
export interface BuildCreativeMultiSuccess {
  /**
   * Array of generated creative manifests, one per requested format. Each manifest contains its own format_id identifying which format it was generated for.
   */
  creative_manifests: CreativeManifest[];
  /**
   * When true, this response contains simulated data from sandbox mode.
   */
  sandbox?: boolean;
  /**
   * ISO 8601 timestamp when the earliest generated asset URL expires across all manifests. Re-build after this time to get fresh URLs.
   */
  expires_at?: string;
  /**
   * Preview renders included when the request set include_preview to true and the agent supports it. Contains one default preview per requested format. preview_inputs is ignored for multi-format requests.
   */
  preview?: {
    /**
     * Array of preview entries, one per requested format. Array order matches creative_manifests. Each entry includes a format_id for explicit correlation.
     */
    previews: {
      /**
       * Unique identifier for this preview
       */
      preview_id: string;
      format_id: FormatID;
      /**
       * Array of rendered pieces for this format's preview. Most formats render as a single piece. Companion ad formats render as multiple pieces.
       */
      renders: PreviewRender[];
      /**
       * The input parameters that generated this preview. For multi-format responses, this is always a default input.
       */
      input: {
        /**
         * Human-readable name for this preview
         */
        name: string;
        /**
         * Macro values applied to this preview
         */
        macros?: {
          [k: string]: string | undefined;
        };
        /**
         * Context description applied to this preview
         */
        context_description?: string;
      };
    }[];
    /**
     * Optional URL to an interactive testing page that shows all format previews with controls to switch between them.
     */
    interactive_url?: string;
    /**
     * ISO 8601 timestamp when preview URLs expire. May differ from the manifest's expires_at.
     */
    expires_at: string;
  };
  preview_error?: Error;
  /**
   * Which rate card pricing option was applied for this build. Represents the total cost of the entire multi-format build call. Present when the creative agent charges for its services.
   */
  pricing_option_id?: string;
  /**
   * Total cost incurred for this multi-format build, denominated in currency. May be 0 for CPM-priced creatives where cost accrues at serve time.
   */
  vendor_cost?: number;
  /**
   * ISO 4217 currency code for vendor_cost.
   */
  currency?: string;
  consumption?: CreativeConsumption;
  context?: ContextObject;
  ext?: ExtensionObject;
}
/**
 * Error response - creative generation failed
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
 * Progress data for working build_creative
 */
export interface BuildCreativeAsyncWorking {
  /**
   * Completion percentage (0-100)
   */
  percentage?: number;
  /**
   * Current step or phase of the operation (e.g., 'generating_assets', 'resolving_macros', 'rendering_preview')
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
}
/**
 * Input requirements for build_creative needing user input
 */
export interface BuildCreativeAsyncInputRequired {
  /**
   * Reason code indicating why input is needed
   */
  reason?: 'APPROVAL_REQUIRED' | 'CREATIVE_DIRECTION_NEEDED' | 'ASSET_SELECTION_NEEDED';
  /**
   * Optional validation errors or warnings explaining why input is required.
   */
  errors?: Error[];
  context?: ContextObject;
  ext?: ExtensionObject;
}
/**
 * Acknowledgment for submitted build_creative
 */
export interface BuildCreativeAsyncSubmitted {
  context?: ContextObject;
  ext?: ExtensionObject;
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
    account?: Account1;
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
    errors?: Error[];
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
      [k: string]: string | undefined;
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
export interface Account1 {
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
  status: AccountStatus;
  brand?: BrandReference;
  /**
   * Domain of the entity operating this account. When the brand operates directly, this is the brand's domain.
   */
  operator?: string;
  /**
   * Who is invoiced on this account. operator: seller invoices the operator (agency or brand buying direct). agent: agent consolidates billing. advertiser: seller invoices the advertiser directly, even when a different operator places orders on their behalf. See billing_entity for the invoiced party's business details.
   */
  billing?: 'operator' | 'agent' | 'advertiser';
  billing_entity?: BusinessEntity;
  /**
   * Identifier for the rate card applied to this account
   */
  rate_card?: string;
  /**
   * Payment terms agreed for this account. Binding for all invoices when the account is active.
   */
  payment_terms?: 'net_15' | 'net_30' | 'net_45' | 'net_60' | 'net_90' | 'prepay';
  /**
   * Maximum outstanding balance allowed
   */
  credit_limit?: {
    amount: number;
    currency: string;
  };
  /**
   * Present when status is 'pending_approval'. Contains next steps for completing account activation.
   */
  setup?: {
    /**
     * URL where the human can complete the required action (credit application, legal agreement, add funds).
     */
    url?: string;
    /**
     * Human-readable description of what's needed.
     */
    message: string;
    /**
     * When this setup link expires.
     */
    expires_at?: string;
  };
  /**
   * How the seller scoped this account. operator: shared across all brands for this operator. brand: shared across all operators for this brand. operator_brand: dedicated to a specific operator+brand combination. agent: the agent's default account with no brand or operator association.
   */
  account_scope?: 'operator' | 'brand' | 'operator_brand' | 'agent';
  /**
   * Governance agent endpoints registered on this account. Authentication credentials are write-only and not included in responses — use sync_governance to set or update credentials.
   */
  governance_agents?: {
    /**
     * Governance agent endpoint URL. Must use HTTPS.
     */
    url: string;
    /**
     * Governance categories this agent handles (e.g., ['budget_authority', 'strategic_alignment']). When omitted, the agent handles all categories.
     */
    categories?: string[];
  }[];
  /**
   * Cloud storage bucket where the seller delivers offline reporting files for this account. Seller provisions a dedicated bucket or a per-account prefix within a shared bucket, and grants the buyer read access out-of-band. Access MUST be scoped so each account can only read its own prefix. Only present when the seller supports offline delivery (reporting_delivery_methods includes 'offline' in capabilities).
   */
  reporting_bucket?: {
    protocol: CloudStorageProtocol;
    /**
     * Bucket or container name
     */
    bucket: string;
    /**
     * Path prefix within the bucket. Seller appends date-based partitioning beneath this prefix.
     */
    prefix?: string;
    /**
     * Cloud region for the bucket
     */
    region?: string;
    /**
     * File format for delivered files. Parquet, Avro, and ORC use internal compression (the top-level compression field is ignored for these formats).
     */
    format?: 'jsonl' | 'csv' | 'parquet' | 'avro' | 'orc';
    /**
     * Compression applied to delivered files
     */
    compression?: 'gzip' | 'none';
    /**
     * How long reporting files are retained in the bucket before deletion. Buyers must read files within this window. Minimum recommended: 14 days.
     */
    file_retention_days: number;
    /**
     * URL to documentation for configuring buyer read access to this bucket (IAM role, service account, etc.)
     */
    setup_instructions?: string;
  };
  /**
   * When true, this is a sandbox account — no real platform calls, no real spend. For explicit accounts (require_operator_auth: true), sandbox accounts are pre-existing test accounts on the platform discovered via list_accounts. For implicit accounts, sandbox is part of the natural key: the same brand/operator pair can have both a production and sandbox account.
   */
  sandbox?: boolean;
  ext?: ExtensionObject;
}
/**
 * Error response - operation failed completely, no creatives were processed
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
}
/**
 * Acknowledgment for submitted sync_creatives
 */
export interface SyncCreativesAsyncSubmitted {
  context?: ContextObject;
  ext?: ExtensionObject;
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
    errors?: Error[];
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
 * Error response - operation failed completely, no catalogs were processed
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
}
/**
 * Acknowledgment for submitted sync_catalogs
 */
export interface SyncCatalogsAsyncSubmitted {
  context?: ContextObject;
  ext?: ExtensionObject;
}


// GAP SCHEMAS — types not reachable from root schemas or tool definitions
// a2ui/component.json
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
}


// a2ui/surface.json
/**
 * A contiguous UI region containing components
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
  dataModel?: {};
}

// brand/acquire-rights-request.json
/**
 * Authentication schemes for push notification endpoints
 */
export type AuthenticationScheme = 'Bearer' | 'HMAC-SHA256';

/**
 * Binding contractual request to acquire rights from a brand agent. Parallels create_media_buy — the buyer selects a pricing_option_id from a get_rights response and provides campaign details. The agent clears against existing contracts and returns terms, generation credentials, and disclosure requirements.
 */
export interface AcquireRightsRequest {
  /**
   * The AdCP major version the buyer's payloads conform to. Sellers validate against their supported major_versions and return VERSION_UNSUPPORTED if unsupported. When omitted, the seller assumes its highest supported version.
   */
  adcp_major_version?: number;
  /**
   * Rights offering identifier from get_rights response
   */
  rights_id: string;
  /**
   * Selected pricing option from the rights offering
   */
  pricing_option_id: string;
  buyer: BrandReference;
  /**
   * Campaign details for rights clearance
   */
  campaign: {
    /**
     * Description of how the rights will be used
     */
    description: string;
    /**
     * Specific rights uses for this campaign
     */
    uses: RightUse[];
    /**
     * Countries where the campaign will run (ISO 3166-1 alpha-2)
     */
    countries?: string[];
    /**
     * Creative formats that will be produced
     */
    format_ids?: FormatID[];
    /**
     * Estimated total impressions for the campaign
     */
    estimated_impressions?: number;
    /**
     * Campaign start date (ISO 8601)
     */
    start_date?: string;
    /**
     * Campaign end date (ISO 8601)
     */
    end_date?: string;
  };
  revocation_webhook: PushNotificationConfig;
  push_notification_config?: PushNotificationConfig;
  /**
   * Client-generated key for safe retries. Resubmitting with the same key returns the original response rather than creating a duplicate acquisition. MUST be unique per (seller, request) pair to prevent cross-seller correlation. Use a fresh UUID v4 for each request.
   */
  idempotency_key?: string;
  context?: ContextObject;
  ext?: ExtensionObject;
}
/**
 * Webhook for rights revocation notifications. If the rights holder needs to revoke rights (talent scandal, contract violation, etc.), they POST a revocation-notification to this URL. The buyer is responsible for stopping creative delivery upon receipt.
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
     */
    schemes: AuthenticationScheme[];
    /**
     * Credentials for authentication. For Bearer: token sent in Authorization header. For HMAC-SHA256: shared secret used to generate signature. Minimum 32 characters. Exchanged out-of-band during onboarding.
     */
    credentials: string;
  };
}
/**
 * Result of a rights acquisition request. Returns one of three statuses: acquired (with terms and generation credentials), pending_approval (requires rights holder review), or rejected (with reason). Uses discriminated union on status field.
 */
export type AcquireRightsResponse =
  | AcquireRightsAcquired
  | AcquireRightsPendingApproval
  | AcquireRightsRejected
  | AcquireRightsError;
export interface AcquireRightsAcquired {
  /**
   * Rights grant identifier
   */
  rights_id: string;
  /**
   * Rights have been cleared and credentials issued
   */
  status: 'acquired';
  /**
   * Brand identifier of the rights subject
   */
  brand_id: string;
  terms: RightsTerms;
  /**
   * Scoped credentials for generating rights-cleared content
   */
  generation_credentials: GenerationCredential[];
  /**
   * Usage restrictions and requirements
   */
  restrictions?: string[];
  /**
   * Required disclosure for creatives using these rights
   */
  disclosure?: {
    /**
     * Whether disclosure is required
     */
    required: boolean;
    /**
     * Disclosure text to include with the creative
     */
    text?: string;
  };
  approval_webhook?: PushNotificationConfig;
  /**
   * Endpoint for reporting usage against these rights
   */
  usage_reporting_url?: string;
  rights_constraint: RightsConstraint;
  context?: ContextObject;
  ext?: ExtensionObject;
}
/**
 * Agreed contractual terms
 */
export interface RightsTerms {
  pricing_option_id: string;
  amount: number;
  currency: string;
  period?: 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'annual' | 'one_time';
  uses: RightUse[];
  impression_cap?: number;
  overage_cpm?: number;
  start_date?: string;
  end_date?: string;
  /**
   * Exclusivity terms if applicable
   */
  exclusivity?: {
    scope?: string;
    countries?: string[];
  };
}
/**
 * A scoped credential issued by an LLM provider for generating rights-cleared content. The rights agent coordinates with the provider to issue the credential; the provider enforces usage constraints at generation time. Any creative agent can use the credential.
 */
export interface GenerationCredential {
  /**
   * LLM or generation service provider identifier (e.g., 'midjourney', 'elevenlabs', 'stability')
   */
  provider: string;
  /**
   * Scoped API key or token for generating rights-cleared content. The provider validates this key at generation time to verify the caller is authorized.
   */
  rights_key: string;
  /**
   * Which rights uses this credential covers
   */
  uses: RightUse[];
  /**
   * When this credential expires. Key lifetime is determined by the provider.
   */
  expires_at?: string;
  /**
   * Provider API endpoint to use with this credential, if different from the provider's default
   */
  endpoint?: string;
  ext?: ExtensionObject;
}
export interface AcquireRightsPendingApproval {
  rights_id: string;
  /**
   * Rights require approval from the rights holder
   */
  status: 'pending_approval';
  brand_id: string;
  /**
   * Explanation of what requires approval
   */
  detail?: string;
  /**
   * Expected time for approval decision (e.g., '48h', '3 business days')
   */
  estimated_response_time?: string;
  context?: ContextObject;
  ext?: ExtensionObject;
}
export interface AcquireRightsRejected {
  rights_id: string;
  /**
   * Rights request was rejected
   */
  status: 'rejected';
  brand_id: string;
  /**
   * Why the rights request was rejected. May be sanitized to protect confidential brand rules — e.g., 'This violates our public figures brand guidelines' rather than naming the specific rule.
   */
  reason: string;
  /**
   * Actionable alternatives the buyer can try. If present, the rejection is fixable — the buyer can adjust their request. If absent, the rejection is final for this talent/rights combination.
   */
  suggestions?: string[];
  context?: ContextObject;
  ext?: ExtensionObject;
}
export interface AcquireRightsError {
  errors: Error[];
  context?: ContextObject;
  ext?: ExtensionObject;
}

// brand/get-brand-identity-request.json
/**
 * Request brand identity data from a brand agent. Core identity (house, names, description, logos) is always public. Linked accounts get deeper data: high-res assets, voice configs, tone guidelines, and rights availability.
 */
export interface GetBrandIdentityRequest {
  /**
   * The AdCP major version the buyer's payloads conform to. Sellers validate against their supported major_versions and return VERSION_UNSUPPORTED if unsupported. When omitted, the seller assumes its highest supported version.
   */
  adcp_major_version?: number;
  /**
   * Brand identifier from brand.json brands array
   */
  brand_id: string;
  /**
   * Optional identity sections to include in the response. When omitted, all sections the caller is authorized to see are returned. Core fields (brand_id, house, names) are always returned and do not need to be requested.
   */
  fields?: (
    | 'description'
    | 'industries'
    | 'keller_type'
    | 'logos'
    | 'colors'
    | 'fonts'
    | 'visual_guidelines'
    | 'tone'
    | 'tagline'
    | 'voice_synthesis'
    | 'assets'
    | 'rights'
  )[];
  /**
   * Intended use case, so the agent can tailor the response. A 'voice_synthesis' use case returns voice configs; a 'likeness' use case returns high-res photos and appearance guidelines.
   */
  use_case?: string;
  context?: ContextObject;
  ext?: ExtensionObject;
}

// brand/get-brand-identity-response.json
/**
 * Brand identity data from a brand agent. Core identity (house, names, description, logos) is always public. Authorized callers receive richer data (high-res assets, voice synthesis, tone guidelines, rights availability). Includes available_fields to signal what the caller could unlock by linking their account.
 */
export type GetBrandIdentityResponse = GetBrandIdentitySuccess | GetBrandIdentityError;
/**
 * Type of asset content
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
  | 'webhook'
  | 'brief'
  | 'catalog';
export interface GetBrandIdentitySuccess {
  /**
   * Brand identifier
   */
  brand_id: string;
  /**
   * The house (corporate entity) this brand belongs to. Always returned regardless of authorization level.
   */
  house: {
    /**
     * House domain (e.g., nikeinc.com)
     */
    domain: string;
    /**
     * House display name
     */
    name: string;
  };
  /**
   * Localized brand names with BCP 47 locale code keys (e.g., 'en_US', 'fr_CA'). Bare language codes ('en') are accepted as wildcards for backwards compatibility.
   */
  names: {
    [k: string]: string | undefined;
  }[];
  /**
   * Brand description
   */
  description?: string;
  /**
   * Brand industries.
   */
  industries?: string[];
  /**
   * Brand architecture type: master (primary brand of house), sub_brand (carries parent name), endorsed (independent identity backed by parent), independent (operates separately)
   */
  keller_type?: 'master' | 'sub_brand' | 'endorsed' | 'independent';
  /**
   * Brand logos. Public callers get standard logos; authorized callers also receive high-res variants. Shape matches brand.json logo definition.
   */
  logos?: {
    /**
     * URL to the logo asset
     */
    url: string;
    /**
     * Logo aspect ratio orientation
     */
    orientation?: 'square' | 'horizontal' | 'vertical' | 'stacked';
    /**
     * Background compatibility
     */
    background?: 'dark-bg' | 'light-bg' | 'transparent-bg';
    /**
     * Logo variant type
     */
    variant?: 'primary' | 'secondary' | 'icon' | 'wordmark' | 'full-lockup';
    /**
     * Additional semantic tags
     */
    tags?: string[];
    /**
     * When to use this logo variant
     */
    usage?: string;
    /**
     * Width in pixels
     */
    width?: number;
    /**
     * Height in pixels
     */
    height?: number;
  }[];
  /**
   * Brand color palette. Each role accepts a single hex color or an array of hex colors. Shape matches brand.json colors definition.
   */
  colors?: {
    primary?: string | string[];
    secondary?: string | string[];
    accent?: string | string[];
    background?: string | string[];
    text?: string | string[];
  };
  /**
   * Brand typography. Each key is a role name (e.g., 'primary', 'secondary') referenced by type_scale entries. Values are either a CSS font-family string or a structured object with family name and font files. Shape matches brand.json fonts definition.
   */
  fonts?: {
    /**
     * Primary font family
     */
    primary?:
      | string
      | {
          /**
           * CSS font-family name
           */
          family: string;
          files?: {
            /**
             * HTTPS URL to the font file
             */
            url: string;
            /**
             * CSS numeric font-weight
             */
            weight?: number;
            /**
             * Variable font weight axis range as [min, max]
             */
            weight_range?: number[];
            /**
             * CSS font-style
             */
            style?: 'normal' | 'italic' | 'oblique';
          }[];
          /**
           * OpenType feature tags to enable (e.g., ['ss01', 'tnum'])
           */
          opentype_features?: string[];
          /**
           * Ordered fallback font-family names for script coverage
           */
          fallbacks?: string[];
        };
    /**
     * Secondary font family
     */
    secondary?:
      | string
      | {
          /**
           * CSS font-family name
           */
          family: string;
          files?: {
            /**
             * HTTPS URL to the font file
             */
            url: string;
            /**
             * CSS numeric font-weight
             */
            weight?: number;
            /**
             * Variable font weight axis range as [min, max]
             */
            weight_range?: number[];
            /**
             * CSS font-style
             */
            style?: 'normal' | 'italic' | 'oblique';
          }[];
          /**
           * OpenType feature tags to enable (e.g., ['ss01', 'tnum'])
           */
          opentype_features?: string[];
          /**
           * Ordered fallback font-family names for script coverage
           */
          fallbacks?: string[];
        };
    [k: string]:
      | (
          | string
          | {
              /**
               * CSS font-family name
               */
              family: string;
              files?: {
                /**
                 * HTTPS URL to the font file
                 */
                url: string;
                /**
                 * CSS numeric font-weight
                 */
                weight?: number;
                /**
                 * Variable font weight axis range as [min, max]
                 */
                weight_range?: number[];
                /**
                 * CSS font-style
                 */
                style?: 'normal' | 'italic' | 'oblique';
              }[];
              /**
               * OpenType feature tags to enable (e.g., ['ss01', 'tnum'])
               */
              opentype_features?: string[];
              /**
               * Ordered fallback font-family names for script coverage
               */
              fallbacks?: string[];
            }
        )
      | undefined;
  };
  /**
   * Structured visual rules for generative creative systems (photography, graphic_style, colorways, type_scale, motion). Matches brand.json visual_guidelines definition. Authorized callers only.
   */
  visual_guidelines?: {};
  /**
   * Brand voice and messaging guidelines
   */
  tone?: {
    /**
     * Brand personality described as comma-separated adjectives (e.g., 'enthusiastic, warm, competitive')
     */
    voice?: string;
    /**
     * Personality traits that characterize the brand voice, used as prompt guidance
     */
    attributes?: string[];
    /**
     * Approved messaging approaches, content themes, and reference points
     */
    dos?: string[];
    /**
     * Prohibited topics, competitor references, and phrasings to avoid
     */
    donts?: string[];
  };
  /**
   * Brand tagline or slogan. Accepts a plain string or a localized array matching the names pattern.
   */
  tagline?:
    | string
    | {
        [k: string]: string | undefined;
      }[];
  /**
   * Voice synthesis configuration for AI-generated audio
   */
  voice_synthesis?: {
    provider?: string;
    voice_id?: string;
    settings?: {};
  };
  /**
   * Available brand assets (images, audio, video). Authorized callers only. Shape matches brand.json asset definition.
   */
  assets?: {
    /**
     * Unique identifier
     */
    asset_id: string;
    asset_type: AssetContentType;
    /**
     * URL to CDN-hosted asset file
     */
    url: string;
    /**
     * Tags for discovery
     */
    tags?: string[];
    /**
     * Human-readable name
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
     * File format (e.g., 'jpg', 'mp4')
     */
    format?: string;
  }[];
  /**
   * Rights availability summary. For detailed pricing, use get_rights.
   */
  rights?: {
    available_uses?: RightUse[];
    /**
     * Countries where rights are available (ISO 3166-1 alpha-2). If omitted, rights are available worldwide.
     */
    countries?: string[];
    /**
     * Countries excluded from availability (ISO 3166-1 alpha-2)
     */
    excluded_countries?: string[];
    exclusivity_model?: string;
    content_restrictions?: string[];
  };
  /**
   * Fields available but not returned in this response due to authorization level. Tells the caller what they would gain by linking their account via sync_accounts. Values match the request fields enum.
   */
  available_fields?: (
    | 'description'
    | 'industries'
    | 'keller_type'
    | 'logos'
    | 'colors'
    | 'fonts'
    | 'visual_guidelines'
    | 'tone'
    | 'tagline'
    | 'voice_synthesis'
    | 'assets'
    | 'rights'
  )[];
  context?: ContextObject;
  ext?: ExtensionObject;
}
export interface GetBrandIdentityError {
  errors: Error[];
  context?: ContextObject;
  ext?: ExtensionObject;
}

// brand/get-rights-request.json
/**
 * Search for licensable rights across a brand agent's roster. Returns matches with pricing. Discovery is natural-language-first — no taxonomy for categories. The agent interprets intent from the query and filters based on the buyer's brand compatibility.
 */
export interface GetRightsRequest {
  /**
   * The AdCP major version the buyer's payloads conform to. Sellers validate against their supported major_versions and return VERSION_UNSUPPORTED if unsupported. When omitted, the seller assumes its highest supported version.
   */
  adcp_major_version?: number;
  /**
   * Natural language description of desired rights. The agent interprets intent, budget signals, and compatibility from this text.
   */
  query: string;
  /**
   * Rights uses being requested. The agent returns options covering these uses, potentially bundled into composite pricing.
   */
  uses: RightUse[];
  buyer_brand?: BrandReference;
  /**
   * Countries where rights are needed (ISO 3166-1 alpha-2). Filters to rights available in these markets.
   */
  countries?: string[];
  /**
   * Search within a specific brand's rights. If omitted, searches across the agent's full roster.
   */
  brand_id?: string;
  right_type?: RightType;
  /**
   * Include filtered-out results in the excluded array with reasons. Defaults to false.
   */
  include_excluded?: boolean;
  pagination?: PaginationRequest;
  context?: ContextObject;
  ext?: ExtensionObject;
}
/**
 * Pagination parameters for large result sets
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

// brand/get-rights-response.json
/**
 * Licensable rights matching the search criteria, with pricing options. Each result is a complete snapshot of current availability (stateless, DDEX PIE pattern). Excluded results explain why they were filtered out.
 */
export type GetRightsResponse = GetRightsSuccess | GetRightsError;
/**
 * Pricing model (cpm, flat_rate, etc.)
 */
export type PricingModel = 'cpm' | 'vcpm' | 'cpc' | 'cpcv' | 'cpv' | 'cpp' | 'cpa' | 'flat_rate' | 'time';

export interface GetRightsSuccess {
  /**
   * Matching rights with pricing options, ranked by relevance
   */
  rights: {
    /**
     * Identifier for this rights offering. Referenced in acquire_rights.
     */
    rights_id: string;
    /**
     * Brand identifier from the agent's roster
     */
    brand_id: string;
    /**
     * Display name of the rights subject
     */
    name: string;
    /**
     * Description of the rights subject
     */
    description?: string;
    right_type?: RightType;
    /**
     * Relevance score from 0 to 1
     */
    match_score?: number;
    /**
     * Human-readable reasons for the match
     */
    match_reasons?: string[];
    /**
     * Rights uses available for licensing
     */
    available_uses: RightUse[];
    /**
     * Countries where rights are available (ISO 3166-1 alpha-2). When both countries and excluded_countries are present, the effective set is countries minus excluded_countries. If neither is present, all countries are available.
     */
    countries?: string[];
    /**
     * Countries excluded from availability
     */
    excluded_countries?: string[];
    /**
     * Current exclusivity availability
     */
    exclusivity_status?: {
      /**
       * Whether exclusivity is available
       */
      available?: boolean;
      /**
       * Active exclusivity commitments that may affect availability. Implementers should use vague descriptions ('exclusive commitment in this category') rather than specific deal terms to protect confidential business relationships.
       */
      existing_exclusives?: string[];
    };
    /**
     * Available pricing options for these rights
     */
    pricing_options: RightsPricingOption[];
    /**
     * Content restrictions or approval requirements
     */
    content_restrictions?: string[];
    /**
     * Preview-only assets for evaluation
     */
    preview_assets?: {
      url: string;
      usage?: string;
    }[];
  }[];
  /**
   * Results that matched but were filtered out, with reasons
   */
  excluded?: {
    brand_id: string;
    name?: string;
    /**
     * Why this result was excluded. May be sanitized to protect confidential brand rules.
     */
    reason: string;
    /**
     * Actionable alternatives if the exclusion is fixable (e.g., 'Available in BE and DE markets'). Absent if the exclusion is final.
     */
    suggestions?: string[];
  }[];
  context?: ContextObject;
  ext?: ExtensionObject;
}
/**
 * A pricing option for licensable rights. Separate from media-buy pricing options — rights pricing includes period, impression caps, overage rates, and use-type scoping.
 */
export interface RightsPricingOption {
  /**
   * Unique identifier for this pricing option. Referenced in acquire_rights and report_usage.
   */
  pricing_option_id: string;
  model: PricingModel;
  /**
   * Price amount. Interpretation depends on model: CPM = cost per 1,000 impressions, flat_rate = fixed cost per period.
   */
  price: number;
  /**
   * ISO 4217 currency code
   */
  currency: string;
  /**
   * Which rights uses this pricing option covers. A single option can bundle multiple uses (e.g., likeness + voice).
   */
  uses: RightUse[];
  /**
   * Billing period for flat_rate and time-based models
   */
  period?: 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'annual' | 'one_time';
  /**
   * Maximum impressions included in this pricing option per period
   */
  impression_cap?: number;
  /**
   * CPM rate applied to impressions exceeding the impression_cap
   */
  overage_cpm?: number;
  /**
   * Human-readable description of this pricing option
   */
  description?: string;
  ext?: ExtensionObject;
}
export interface GetRightsError {
  errors: Error[];
  context?: ContextObject;
  ext?: ExtensionObject;
}

// collection/base-collection-source.json
/**
 * A source of collections for a collection list. Supports three selection patterns: distribution identifiers (cross-publisher), publisher-specific collection IDs, or publisher-specific genres.
 */
export type BaseCollectionSource = DistributionIDsSource | PublisherCollectionsSource | PublisherGenresSource;
/**
 * Type of distribution identifier
 */
export type DistributionIdentifierType =
  | 'apple_podcast_id'
  | 'spotify_collection_id'
  | 'rss_url'
  | 'podcast_guid'
  | 'amazon_music_id'
  | 'iheart_id'
  | 'podcast_index_id'
  | 'youtube_channel_id'
  | 'youtube_playlist_id'
  | 'amazon_title_id'
  | 'roku_channel_id'
  | 'pluto_channel_id'
  | 'tubi_id'
  | 'peacock_id'
  | 'tiktok_id'
  | 'twitch_channel'
  | 'imdb_id'
  | 'gracenote_id'
  | 'eidr_id'
  | 'domain'
  | 'substack_id';
/**
 * Taxonomy for the genre values. Required so sellers can interpret genre strings unambiguously. Use 'custom' for free-form values negotiated out of band.
 */
export type GenreTaxonomy =
  | 'iab_content_3.0'
  | 'iab_content_2.2'
  | 'gracenote'
  | 'eidr'
  | 'apple_genres'
  | 'google_genres'
  | 'roku'
  | 'amazon_genres'
  | 'custom';

/**
 * Select collections by platform-independent distribution identifiers. The primary mechanism for cross-publisher collection matching.
 */
export interface DistributionIDsSource {
  /**
   * Discriminator indicating selection by platform-independent distribution identifiers
   */
  selection_type: 'distribution_ids';
  /**
   * Platform-independent identifiers (imdb_id, gracenote_id, eidr_id, etc.). Each identifier uniquely identifies a collection across all publishers.
   */
  identifiers: {
    type: DistributionIdentifierType;
    /**
     * The identifier value
     */
    value: string;
  }[];
}
/**
 * Select specific collections within a publisher's adagents.json by collection ID
 */
export interface PublisherCollectionsSource {
  /**
   * Discriminator indicating selection by specific collection IDs within a publisher
   */
  selection_type: 'publisher_collections';
  /**
   * Domain where publisher's adagents.json is hosted
   */
  publisher_domain: string;
  /**
   * Specific collection IDs from the publisher's adagents.json
   */
  collection_ids: string[];
}
/**
 * Select all collections from a publisher matching genre criteria. Use when excluding entire content categories from a specific publisher.
 */
export interface PublisherGenresSource {
  /**
   * Discriminator indicating selection by genre within a publisher
   */
  selection_type: 'publisher_genres';
  /**
   * Domain where publisher's adagents.json is hosted
   */
  publisher_domain: string;
  /**
   * Genre values to match against the publisher's collections
   */
  genres: string[];
  genre_taxonomy: GenreTaxonomy;
}


// collection/collection-list-changed-webhook.json
/**
 * Webhook notification sent when a collection list's resolved collections change. Contains a summary only — recipients must call get_collection_list to retrieve the updated collections.
 */
export interface CollectionListChangedWebhook {
  /**
   * The event type
   */
  event: 'collection_list_changed';
  /**
   * ID of the collection list that changed
   */
  list_id: string;
  /**
   * Name of the collection list
   */
  list_name?: string;
  /**
   * Summary of changes to the resolved list
   */
  change_summary?: {
    /**
     * Number of collections added since last resolution
     */
    collections_added?: number;
    /**
     * Number of collections removed since last resolution
     */
    collections_removed?: number;
    /**
     * Total collections in the resolved list
     */
    total_collections?: number;
  };
  /**
   * When the list was re-resolved
   */
  resolved_at: string;
  /**
   * When the consumer should refresh from the governance agent
   */
  cache_valid_until?: string;
  /**
   * Cryptographic signature of the webhook payload, signed with the agent's private key. Recipients MUST verify this signature.
   */
  signature: string;
  ext?: ExtensionObject;
}

// collection/collection-list-filters.json
/**
 * Production quality tier for collection content. Maps to OpenRTB content.prodq: professional=1, prosumer=2, ugc=3. Seller-declared — no external validation.
 */
export type ProductionQuality = 'professional' | 'prosumer' | 'ugc';

/**
 * Filters that dynamically modify a collection list when resolved. Include filters are allowlists (only matching collections pass). Exclude filters are blocklists (matching collections are removed). When both are present for the same dimension, include is applied first, then exclude narrows further.
 */
export interface CollectionListFilters {
  /**
   * Exclude collections with any of these content ratings (OR logic). This is a metadata filter on the collection's declared content_rating field — it does not evaluate episode content.
   */
  content_ratings_exclude?: ContentRating[];
  /**
   * Include only collections with any of these content ratings (OR logic). Collections without a declared content_rating are excluded.
   */
  content_ratings_include?: ContentRating[];
  /**
   * Exclude collections tagged with any of these genres (OR logic). Values are interpreted against genre_taxonomy when present.
   */
  genres_exclude?: string[];
  /**
   * Include only collections with any of these genres (OR logic). Collections without genre metadata are excluded. Values are interpreted against genre_taxonomy when present.
   */
  genres_include?: string[];
  genre_taxonomy?: GenreTaxonomy;
  /**
   * Filter to these collection kinds
   */
  kinds?: ('series' | 'publication' | 'event_series' | 'rotation')[];
  /**
   * Always exclude collections with these distribution identifiers
   */
  exclude_distribution_ids?: {
    type: DistributionIdentifierType;
    /**
     * The identifier value
     */
    value: string;
  }[];
  /**
   * Filter by production quality tier
   */
  production_quality?: ProductionQuality[];
}

// collection/collection-list.json
/**
 * A managed collection list with optional filters for dynamic evaluation. Lists are resolved at setup time and cached by orchestrators/sellers for real-time use. Collections represent programs, shows, and other content entities independent of which properties carry them.
 */
export interface CollectionList {
  /**
   * Unique identifier for this collection list
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
   * Array of collection sources to evaluate. Each entry is a discriminated union: distribution_ids (platform-independent identifiers), publisher_collections (publisher_domain + collection_ids), or publisher_genres (publisher_domain + genres). If omitted, queries the agent's entire collection database.
   */
  base_collections?: BaseCollectionSource[];
  filters?: CollectionListFilters;
  brand?: BrandReference;
  /**
   * URL to receive notifications when the resolved list changes
   */
  webhook_url?: string;
  /**
   * Recommended cache duration for resolved list. Consumers should re-fetch after this period. Defaults to 168 (one week) because collection metadata changes less frequently than property metadata.
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
   * Number of collections in the resolved list (at time of last resolution)
   */
  collection_count?: number;
}

// content-standards/artifact-webhook-payload.json
/**
 * Authentication for secured URLs
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
      credentials?: {};
    }
  | {
      method: 'signed_url';
    };
/**
 * Payload sent by sales agents to orchestrators when pushing content artifacts for governance validation. Complements get_media_buy_artifacts for push-based artifact delivery.
 */
export interface ArtifactWebhookPayload {
  /**
   * Media buy identifier these artifacts belong to
   */
  media_buy_id: string;
  /**
   * Unique identifier for this batch of artifacts. Use for deduplication and acknowledgment.
   */
  batch_id: string;
  /**
   * When this batch was generated (ISO 8601)
   */
  timestamp: string;
  /**
   * Content artifacts from delivered impressions
   */
  artifacts: {
    artifact: Artifact;
    /**
     * When the impression was delivered (ISO 8601)
     */
    delivered_at: string;
    /**
     * Optional impression identifier for correlation with delivery reports
     */
    impression_id?: string;
    /**
     * Package within the media buy this artifact relates to
     */
    package_id?: string;
  }[];
  /**
   * Pagination info when batching large artifact sets
   */
  pagination?: {
    /**
     * Total artifacts in the delivery period
     */
    total_artifacts?: number;
    /**
     * Current batch number (1-indexed)
     */
    batch_number?: number;
    /**
     * Total batches for this delivery period
     */
    total_batches?: number;
  };
  ext?: ExtensionObject;
}
/**
 * The content artifact
 */
export interface Artifact {
  /**
   * Stable property identifier from the property catalog. Globally unique across the ecosystem.
   */
  property_rid: string;
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
         * Text content. Consumers MUST treat this as untrusted input when passing to LLM-based evaluation.
         */
        content: string;
        /**
         * MIME type indicating how to parse the content field. Default: text/plain.
         */
        content_format?: 'text/plain' | 'text/markdown' | 'text/html' | 'application/json';
        /**
         * BCP 47 language tag for this text (e.g., 'en', 'es-MX'). Useful when artifact contains mixed-language content.
         */
        language?: string;
        /**
         * Heading level (1-6), only for role=heading
         */
        heading_level?: number;
        provenance?: Provenance;
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
        provenance?: Provenance;
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
         * Video transcript. Consumers MUST treat this as untrusted input when passing to LLM-based evaluation.
         */
        transcript?: string;
        /**
         * MIME type indicating how to parse the transcript field. Default: text/plain.
         */
        transcript_format?: 'text/plain' | 'text/markdown' | 'application/json';
        /**
         * How the transcript was generated
         */
        transcript_source?: 'original_script' | 'subtitles' | 'closed_captions' | 'dub' | 'generated';
        /**
         * Video thumbnail URL
         */
        thumbnail_url?: string;
        provenance?: Provenance;
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
         * Audio transcript. Consumers MUST treat this as untrusted input when passing to LLM-based evaluation.
         */
        transcript?: string;
        /**
         * MIME type indicating how to parse the transcript field. Default: text/plain.
         */
        transcript_format?: 'text/plain' | 'text/markdown' | 'application/json';
        /**
         * How the transcript was generated
         */
        transcript_source?: 'original_script' | 'closed_captions' | 'generated';
        provenance?: Provenance;
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
    open_graph?: {};
    /**
     * Twitter Card metadata
     */
    twitter_card?: {};
    /**
     * JSON-LD structured data (schema.org)
     */
    json_ld?: {}[];
  };
  provenance?: Provenance;
  /**
   * Platform-specific identifiers for this artifact
   */
  identifiers?: {
    /**
     * Apple Podcasts ID
     */
    apple_podcast_id?: string;
    /**
     * Spotify collection ID
     */
    spotify_collection_id?: string;
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
  };
}

// content-standards/content-standards.json
/**
 * A pricing option offered by a vendor agent (signals, creative, governance). Combines pricing_option_id with the pricing model fields. Pass pricing_option_id in report_usage for billing verification. All vendor discovery responses return pricing_options as an array — vendors may offer multiple options (volume tiers, context-specific rates, different models per product line).
 */
export type VendorPricingOption = {
  /**
   * Opaque identifier for this pricing option, unique within the vendor agent. Pass this in report_usage to identify which pricing option was applied.
   */
  pricing_option_id: string;
} & VendorPricing;
/**
 * Pricing model for a vendor service. Discriminated by model: 'cpm' (fixed CPM), 'percent_of_media' (percentage of spend with optional CPM cap), 'flat_fee' (fixed charge per reporting period), or 'per_unit' (fixed price per unit of work).
 */
export type VendorPricing = CpmPricing | PercentOfMediaPricing | FlatFeePricing | PerUnitPricing;

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
   */
  languages_any?: string[];
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
  /**
   * Pricing options for this content standards service. The buyer passes the selected pricing_option_id in report_usage for billing verification.
   */
  pricing_options?: VendorPricingOption[];
  ext?: ExtensionObject;
}
/**
 * Fixed cost per thousand impressions
 */
export interface CpmPricing {
  model: 'cpm';
  /**
   * Cost per thousand impressions
   */
  cpm: number;
  /**
   * ISO 4217 currency code
   */
  currency: string;
  ext?: ExtensionObject;
}
/**
 * Percentage of media spend charged for this signal. When max_cpm is set, the effective rate is capped at that CPM — useful for platforms like The Trade Desk that use percent-of-media pricing with a CPM ceiling.
 */
export interface PercentOfMediaPricing {
  model: 'percent_of_media';
  /**
   * Percentage of media spend, e.g. 15 = 15%
   */
  percent: number;
  /**
   * Optional CPM cap. When set, the effective charge is min(percent × media_spend_per_mille, max_cpm).
   */
  max_cpm?: number;
  /**
   * ISO 4217 currency code for the resulting charge
   */
  currency: string;
  ext?: ExtensionObject;
}
/**
 * Fixed charge per billing period, regardless of impressions or spend. Used for licensed data bundles and audience subscriptions.
 */
export interface FlatFeePricing {
  model: 'flat_fee';
  /**
   * Fixed charge for the billing period
   */
  amount: number;
  /**
   * Billing period for the flat fee.
   */
  period: 'monthly' | 'quarterly' | 'annual' | 'campaign';
  /**
   * ISO 4217 currency code
   */
  currency: string;
  ext?: ExtensionObject;
}
/**
 * Fixed price per unit of work. Used for creative transformation (per format), AI generation (per image, per token), and rendering (per variant). The unit field describes what is counted; unit_price is the cost per one unit.
 */
export interface PerUnitPricing {
  model: 'per_unit';
  /**
   * What is counted — e.g. 'format', 'image', 'token', 'variant', 'render', 'evaluation'.
   */
  unit: string;
  /**
   * Cost per one unit
   */
  unit_price: number;
  /**
   * ISO 4217 currency code
   */
  currency: string;
  ext?: ExtensionObject;
}


// core/account-ref.json
/**
 * Reference to an account by seller-assigned ID or natural key. Use account_id for explicit accounts (require_operator_auth: true, discovered via list_accounts). Use the natural key (brand + operator) for implicit accounts (require_operator_auth: false, declared via sync_accounts). For sandbox: explicit accounts use account_id (pre-existing test account), implicit accounts use the natural key with sandbox: true.
 */
export type AccountReference =
  | {
      /**
       * Seller-assigned account identifier (from sync_accounts or list_accounts)
       */
      account_id: string;
    }
  | {
      brand: BrandReference;
      /**
       * Domain of the entity operating on the brand's behalf. When the brand operates directly, this is the brand's domain.
       */
      operator: string;
      /**
       * When true, references the sandbox account for this brand/operator pair. Defaults to false (production account).
       */
      sandbox?: boolean;
    };

// core/activation-key.json
/**
 * Universal identifier for using a signal on a destination platform. Can be either a segment ID or a key-value pair depending on the platform's targeting mechanism.
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


// core/agent-encryption-key.json
/**
 * X25519 public key for HPKE encryption. Used for TMPX exposure token encryption with HPKE mode_base.
 */
export interface AgentEncryptionKey {
  /**
   * Key identifier. Opaque — MUST NOT encode geographic or deployment information.
   */
  kid: string;
  /**
   * JWK key type. Must be OKP for X25519.
   */
  kty: 'OKP';
  /**
   * Curve name. Must be X25519 for TMPX encryption.
   */
  crv: 'X25519';
  /**
   * JWK use value. Must be enc for encryption keys.
   */
  use: 'enc';
  /**
   * Base64url-encoded X25519 public key (32 bytes).
   */
  x: string;
}


// core/agent-signing-key.json
/**
 * Publisher-attested public key material for an authorized agent. Buyers use these keys to verify signed agent responses against the trust anchor published in adagents.json rather than trusting key discovery from the agent domain alone.
 */
export interface AgentSigningKey {
  /**
   * Key identifier for selecting the correct signing key.
   */
  kid: string;
  /**
   * JWK key type, such as 'OKP', 'EC', or 'RSA'.
   */
  kty: string;
  /**
   * Expected signing algorithm for this key, such as 'EdDSA' or 'RS256'.
   */
  alg?: string;
  /**
   * Optional JWK use value. Typically 'sig' for signing keys.
   */
  use?: string;
  /**
   * Curve name for OKP or EC keys, such as 'Ed25519' or 'P-256'.
   */
  crv?: string;
  /**
   * Base64url-encoded public key x coordinate or public key value for OKP keys.
   */
  x?: string;
  /**
   * Base64url-encoded public key y coordinate for EC keys.
   */
  y?: string;
  /**
   * Base64url-encoded RSA modulus.
   */
  n?: string;
  /**
   * Base64url-encoded RSA public exponent.
   */
  e?: string;
}


// core/attribution-window.json
/**
 * Attribution model used to assign credit when multiple touchpoints exist
 */
export type AttributionModel = 'last_touch' | 'first_touch' | 'linear' | 'time_decay' | 'data_driven';

/**
 * Describes the attribution methodology and lookback windows used for conversion measurement. Enables cross-platform comparison by making attribution methodology transparent.
 */
export interface AttributionWindow {
  /**
   * Post-click attribution window. Conversions occurring within this duration after a click are attributed to the ad.
   */
  post_click?: Duration;
  /**
   * Post-view attribution window. Conversions occurring within this duration after an ad impression (without click) are attributed to the ad.
   */
  post_view?: Duration;
  model: AttributionModel;
}

// core/audience-member.json
/**
 * A CRM audience member identified by a buyer-assigned external_id and at least one matchable identifier. All identifiers must be normalized before hashing: emails to lowercase+trim, phone numbers to E.164 format (e.g. +12065551234). Providing multiple identifiers for the same person improves match rates. Composite identifiers (e.g. hashed first name + last name + zip for Google Customer Match) are not yet standardized — use the ext field for platform-specific extensions.
 */
export type AudienceMember = {
  [k: string]: unknown | undefined;
} & {
  /**
   * Buyer-assigned stable identifier for this audience member (e.g. CRM record ID, loyalty ID). Used for deduplication, removal, and cross-referencing with buyer systems. Adapters for CDPs that don't natively assign IDs can derive one (e.g. hash of the member's identifiers).
   */
  external_id: string;
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
   */
  uids?: {
    type: UIDType;
    /**
     * Universal ID value
     */
    value: string;
  }[];
  ext?: ExtensionObject;
};

// core/catchment.json
/**
 * A catchment area definition for a store or location. Defines the geographic area from which a store draws customers. Three methods are supported: isochrone inputs (travel time + transport mode, platform resolves the shape), simple radius (distance from location), or pre-computed GeoJSON geometry (buyer provides the exact boundary). Provide exactly one method per catchment.
 */
export type Catchment = {
  /**
   * Identifier for this catchment, used to reference specific catchment areas in targeting (e.g., 'walk', 'drive', 'primary').
   */
  catchment_id: string;
  /**
   * Human-readable label for this catchment (e.g., '15-min drive', '1km walking radius').
   */
  label?: string;
  /**
   * Travel time limit for isochrone calculation. The platform resolves this to a geographic boundary based on actual transportation networks, accounting for road connectivity, transit schedules, and terrain.
   */
  travel_time?: {
    /**
     * Travel time limit.
     */
    value: number;
    /**
     * Time unit.
     */
    unit: 'min' | 'hr';
  };
  transport_mode?: TransportMode;
  /**
   * Simple radius from the store location. The platform draws a circle of this distance around the store's coordinates.
   */
  radius?: {
    /**
     * Radius distance.
     */
    value: number;
    unit: DistanceUnit;
  };
  /**
   * Pre-computed GeoJSON geometry defining the catchment boundary. Use this when the buyer has already calculated isochrones (via TravelTime, Mapbox, etc.) or has custom trade area boundaries. Supports Polygon and MultiPolygon types.
   */
  geometry?: {
    /**
     * GeoJSON geometry type.
     */
    type: 'Polygon' | 'MultiPolygon';
    /**
     * GeoJSON coordinates array. For Polygon: array of linear rings. For MultiPolygon: array of polygons.
     */
    coordinates: unknown[];
  };
  ext?: ExtensionObject;
} & {
  [k: string]: unknown | undefined;
};
/**
 * Transportation mode for isochrone calculation. Required when travel_time is provided.
 */
export type TransportMode = 'walking' | 'cycling' | 'driving' | 'public_transport';
/**
 * Distance unit.
 */
export type DistanceUnit = 'km' | 'mi' | 'm';


// core/collection-distribution.json
/**
 * A collection's presence on a specific publisher platform, identified by platform-specific identifiers. Enables cross-seller matching when the same collection is sold by different agents.
 */
export interface CollectionDistribution {
  /**
   * Domain of the publisher platform where the collection is distributed (e.g., 'youtube.com', 'spotify.com')
   */
  publisher_domain: string;
  /**
   * Platform-specific identifiers for the collection on this publisher
   */
  identifiers: {
    type: DistributionIdentifierType;
    /**
     * The identifier value
     */
    value: string;
  }[];
}


// core/collection.json
/**
 * How frequently the collection releases new installments
 */
export type CollectionCadence = 'daily' | 'weekly' | 'monthly' | 'seasonal' | 'event' | 'irregular';
/**
 * Lifecycle status of the collection
 */
export type CollectionStatus = 'active' | 'hiatus' | 'ended' | 'upcoming';
/**
 * How the collections are related
 */
export type CollectionRelationship = 'spinoff' | 'companion' | 'sequel' | 'prequel' | 'crossover';

/**
 * A recurring inventory container — a named program, publication, event series, or rotation that produces bookable installments on a defined cadence. The kind field indicates how to interpret this collection: 'series' for TV/podcast programs, 'publication' for print/newsletter titles, 'event_series' for live events, 'rotation' for DOOH scheduling. Declared in the publisher's adagents.json and referenced by products via collection selectors.
 */
export interface Collection {
  /**
   * Publisher-assigned identifier for this collection. Declared in the publisher's adagents.json collections array. Products reference collections via collection selectors with publisher_domain and collection_ids. Use distribution identifiers for cross-seller matching across publishers.
   */
  collection_id: string;
  /**
   * Human-readable collection name
   */
  name: string;
  /**
   * What kind of content program this is. Helps agents interpret installments correctly: 'series' installments are TV/podcast episodes, 'publication' installments are print issues, 'event_series' installments are live event airings, 'rotation' installments are DOOH scheduling periods. Defaults to 'series' when absent.
   */
  kind?: 'series' | 'publication' | 'event_series' | 'rotation';
  /**
   * What the collection is about
   */
  description?: string;
  /**
   * Genre tags. When genre_taxonomy is present, values are taxonomy IDs (e.g., IAB Content Taxonomy 3.0 codes). Otherwise free-form.
   */
  genre?: string[];
  /**
   * Taxonomy system for genre values (e.g., 'iab_content_3.0'). When present, genre values should be valid taxonomy IDs. Recommended for machine-readable brand safety evaluation.
   */
  genre_taxonomy?: string;
  /**
   * Primary language (BCP 47 tag, e.g., 'en', 'es-MX')
   */
  language?: string;
  content_rating?: ContentRating;
  cadence?: CollectionCadence;
  /**
   * Current or most recent season identifier (e.g., '3', '2026', 'spring_2026'). A lightweight label — not a full season object.
   */
  season?: string;
  status?: CollectionStatus;
  production_quality?: ProductionQuality;
  /**
   * Hosts, recurring cast, creators associated with the collection. Each talent entry may include a brand_url linking to their brand.json identity.
   */
  talent?: Talent[];
  special?: Special;
  limited_series?: LimitedSeries;
  /**
   * Where this collection is distributed. Each entry maps the collection to a publisher platform with platform-specific identifiers. Collections SHOULD include at least one platform-independent identifier (imdb_id, gracenote_id, eidr_id) when available.
   */
  distribution?: CollectionDistribution[];
  deadline_policy?: DeadlinePolicy;
  /**
   * Relationships to other collections (spin-offs, companion collections, etc.). Each entry references another collection by collection_id within the same publisher's adagents.json.
   */
  related_collections?: {
    /**
     * The related collection's collection_id within this seller's response
     */
    collection_id: string;
    relationship: CollectionRelationship;
  }[];
  ext?: ExtensionObject;
}
/**
 * When present, this collection is a limited series — a bounded run with a defined arc, installment count, and end date.
 */
export interface LimitedSeries {
  /**
   * Planned number of installments in the series
   */
  total_installments: number;
  /**
   * When the series begins (ISO 8601)
   */
  starts?: string;
  /**
   * When the series ends (ISO 8601)
   */
  ends?: string;
}
/**
 * Default deadline rules for installments of this collection. Agents compute absolute deadlines from each installment's scheduled_at and these lead times. Installments with explicit deadlines override this policy.
 */
export interface DeadlinePolicy {
  /**
   * Days before scheduled_at by which the placement must be booked
   */
  booking_lead_days?: number;
  /**
   * Days before scheduled_at by which cancellation is penalty-free
   */
  cancellation_lead_days?: number;
  /**
   * Default material submission stages. Items MUST be in chronological order (earliest due first). Agents compute due_at as: installment.scheduled_at minus lead_days.
   */
  material_stages?: {
    /**
     * Stage identifier. Standard values: 'draft' (needs seller processing), 'final' (production-ready).
     */
    stage: string;
    /**
     * Days before scheduled_at this stage is due
     */
    lead_days: number;
    /**
     * What the seller needs at this stage
     */
    label?: string;
  }[];
  /**
   * When true, lead_days counts business days (Mon-Fri) rather than calendar days. Defaults to false.
   */
  business_days_only?: boolean;
}

// core/creative-filters.json
/**
 * Filter criteria for querying creatives from a creative library. By default, archived creatives are excluded from results. To include archived creatives, explicitly filter by status='archived' or include 'archived' in the statuses array.
 */
export interface CreativeFilters {
  /**
   * Filter creatives by owning accounts. Useful for agencies managing multiple client accounts.
   */
  accounts?: AccountReference[];
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
   * Filter creatives assigned to any of these packages. Sales-agent-specific — standalone creative agents SHOULD ignore this filter.
   */
  assigned_to_packages?: string[];
  /**
   * Filter creatives assigned to any of these media buys. Sales-agent-specific — standalone creative agents SHOULD ignore this filter.
   */
  media_buy_ids?: string[];
  /**
   * Filter for unassigned creatives when true, assigned creatives when false. Sales-agent-specific — standalone creative agents SHOULD ignore this filter.
   */
  unassigned?: boolean;
  /**
   * When true, return only creatives that have served at least one impression. When false, return only creatives that have never served.
   */
  has_served?: boolean;
  /**
   * Filter by creative concept IDs. Concepts group related creatives across sizes and formats (e.g., Flashtalking concepts, Celtra campaign folders, CM360 creative groups).
   */
  concept_ids?: string[];
  /**
   * Filter by structured format IDs. Returns creatives that match any of these formats.
   */
  format_ids?: FormatID[];
  /**
   * When true, return only creatives with dynamic variables (DCO). When false, return only static creatives.
   */
  has_variables?: boolean;
}

// core/creative-item.json
/**
 * Item within a multi-asset creative format. Used for carousel products, native ad components, and other formats composed of multiple distinct elements.
 */
export type CreativeItem =
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


// core/creative-variable.json
/**
 * A dynamic content variable (DCO slot) on a creative. Variables represent content that can change at serve time — headlines, images, product data, etc.
 */
export interface CreativeVariable {
  /**
   * Variable identifier on the creative platform
   */
  variable_id: string;
  /**
   * Human-readable variable name
   */
  name: string;
  /**
   * Data type of the variable. Each type represents a semantic content slot: text (headlines, body copy), image/video/audio (media URLs), url (clickthrough or tracking URLs), number (prices, counts), boolean (conditional flags like show_discount or is_raining), color (hex color values), date (ISO 8601 date-time for countdowns and offer expirations).
   */
  variable_type: 'text' | 'image' | 'video' | 'audio' | 'url' | 'number' | 'boolean' | 'color' | 'date';
  /**
   * Default value used when no dynamic value is provided at serve time. All types are string-encoded: text/image/video/audio/url as literal strings, number as decimal (e.g., "42.99"), boolean as "true"/"false", color as "#RRGGBB", date as ISO 8601 (e.g., "2026-12-25T00:00:00Z").
   */
  default_value?: string;
  /**
   * Whether this variable must have a value for the creative to serve
   */
  required?: boolean;
}


// core/creative-variant.json
/**
 * A specific execution variant of a creative with delivery metrics. For catalog-driven packages, each catalog item rendered as a distinct ad execution is a variant — the variant's manifest includes the catalog reference with the specific item rendered. For asset group optimization, represents one combination of assets the platform selected. For generative creative, represents a platform-generated variant. For standard creatives, maps 1:1 with the creative itself.
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
  };
};
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
   * Content engagements counted toward the billable view threshold. For video this is a platform-defined view event (e.g., 30 seconds or video midpoint); for audio/podcast it is a stream start; for other formats it follows the pricing model's view definition. When the package uses CPV pricing, spend = views × rate.
   */
  views?: number;
  /**
   * Video/audio completions. When the package has a completed_views optimization goal with view_duration_seconds, completions are counted at that threshold rather than 100% completion.
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
  }[];
  /**
   * Gross Rating Points delivered (for CPP)
   */
  grps?: number;
  /**
   * Unique reach in the units specified by reach_unit. When reach_unit is omitted, units are unspecified — do not compare reach values across packages or media buys without a common reach_unit.
   */
  reach?: number;
  /**
   * Unit of measurement for the reach field. Aligns with the reach_unit declared on optimization goals and delivery forecasts. Required when reach is present to enable cross-platform comparison.
   */
  reach_unit?: ReachUnit;
  /**
   * Average frequency per reach unit (typically measured over campaign duration, but can vary by measurement provider). When reach_unit is 'households', this is average exposures per household; when 'accounts', per logged-in account; etc.
   */
  frequency?: number;
  /**
   * Audio/video quartile completion data
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
    standard?: ViewabilityStandard;
  };
  /**
   * Total engagements — direct interactions with the ad beyond viewing. Includes social reactions/comments/shares, story/unit opens, interactive overlay taps on CTV, companion banner interactions on audio. Platform-specific; corresponds to the 'engagements' optimization metric.
   */
  engagements?: number;
  /**
   * New followers, page likes, artist/podcast/channel subscribes attributed to this delivery.
   */
  follows?: number;
  /**
   * Saves, bookmarks, playlist adds, pins attributed to this delivery.
   */
  saves?: number;
  /**
   * Visits to the brand's in-platform page (profile, artist page, channel, or storefront) attributed to this delivery. Does not include external website clicks.
   */
  profile_visits?: number;
  /**
   * Platform-specific engagement rate (0.0 to 1.0). Typically engagements/impressions, but definition varies by platform.
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
  }[];
}
/**
 * Property where the artifact appears
 */
export interface Identifier {
  type: PropertyIdentifierTypes;
  /**
   * The identifier value. For domain type: 'example.com' matches base domain plus www and m subdomains; 'edition.example.com' matches that specific subdomain; '*.example.com' matches ALL subdomains but NOT base domain
   */
  value: string;
}


// core/date-range.json
/**
 * A date range with inclusive start and end dates (ISO 8601 calendar dates). Used for billing periods, flight dates, and other calendar-day boundaries.
 */
export interface DateRange {
  /**
   * Start date (inclusive), ISO 8601
   */
  start: string;
  /**
   * End date (inclusive), ISO 8601
   */
  end: string;
}


// core/datetime-range.json
/**
 * A datetime range with inclusive start and end timestamps (ISO 8601 with timezone). Used for measurement windows, reporting periods, and other sub-day precision boundaries.
 */
export interface DatetimeRange {
  /**
   * Start timestamp (inclusive), ISO 8601
   */
  start: string;
  /**
   * End timestamp (inclusive), ISO 8601
   */
  end: string;
}


// core/deployment.json
/**
 * A signal deployment to a specific deployment target with activation status and key
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
      activation_key?: ActivationKey;
      /**
       * Estimated time to activate if not live, or to complete activation if in progress
       */
      estimated_activation_duration_minutes?: number;
      /**
       * Timestamp when activation completed (if is_live=true)
       */
      deployed_at?: string;
    };

// core/destination-item.json
/**
 * A travel destination within a destination-type catalog. Carries the location, imagery, and pricing data that platforms use for destination ads and travel remarketing. Maps to Meta destination catalogs, Google travel ads, and similar formats.
 */
export interface DestinationItem {
  /**
   * Unique identifier for this destination.
   */
  destination_id: string;
  /**
   * Destination name (e.g., 'Barcelona', 'Bali', 'Swiss Alps').
   */
  name: string;
  /**
   * Destination description highlighting attractions and appeal.
   */
  description?: string;
  /**
   * City name, if applicable.
   */
  city?: string;
  /**
   * State, province, or region name.
   */
  region?: string;
  /**
   * ISO 3166-1 alpha-2 country code.
   */
  country?: string;
  /**
   * Geographic coordinates of the destination.
   */
  location?: {
    /**
     * Latitude in decimal degrees (WGS 84).
     */
    lat: number;
    /**
     * Longitude in decimal degrees (WGS 84).
     */
    lng: number;
  };
  /**
   * Destination category.
   */
  destination_type?: 'beach' | 'mountain' | 'urban' | 'cultural' | 'adventure' | 'wellness' | 'cruise';
  price?: Price;
  /**
   * Destination hero image URL.
   */
  image_url?: string;
  /**
   * Destination landing page or booking URL.
   */
  url?: string;
  /**
   * Destination rating (1–5).
   */
  rating?: number;
  /**
   * Tags for filtering (e.g., 'family', 'romantic', 'solo', 'winter-sun').
   */
  tags?: string[];
  /**
   * Typed creative asset pools for this destination. Uses the same OfferingAssetGroup structure as offering-type catalogs. Standard group IDs: 'images_landscape' (destination hero), 'images_vertical' (9:16 for Snap, Stories), 'images_square' (1:1). Enables formats to declare typed image requirements that map unambiguously to the right asset regardless of platform.
   */
  assets?: OfferingAssetGroup[];
  ext?: ExtensionObject;
}
/**
 * Starting price for a trip to this destination.
 */
export interface Price {
  /**
   * Monetary amount in the specified currency.
   */
  amount: number;
  /**
   * ISO 4217 currency code (e.g., 'USD', 'EUR', 'GBP').
   */
  currency: string;
  /**
   * Billing period. 'night' for hotel rates, 'month' or 'year' for salaries and rentals, 'one_time' for purchase prices. Omit when the period is obvious from context (e.g., a vehicle price is always one-time).
   */
  period?: 'night' | 'month' | 'year' | 'one_time';
}
/**
 * A structured group of creative assets within an offering, identified by a group ID and asset type. Enables offerings to carry per-group creative pools (headlines, images, videos) using the same vocabulary as format-level asset definitions.
 */
export interface OfferingAssetGroup {
  /**
   * Identifies the creative role this group fills. Values are defined by each format's offering_asset_constraints — not protocol constants. Discover them via list_creative_formats (e.g., a format might declare 'headlines', 'images', or 'videos').
   */
  asset_group_id: string;
  asset_type: AssetContentType;
  /**
   * The assets in this group. Each item should match the structure for the declared asset_type. Note: JSON Schema validation accepts any valid asset structure here; enforcement that items match asset_type is the responsibility of the consuming agent.
   */
  items: (
    | TextAsset
    | ImageAsset
    | VideoAsset
    | AudioAsset
    | URLAsset
    | HTMLAsset
    | MarkdownAsset
    | VASTAsset
    | DAASTAsset
    | CSSAsset
    | JavaScriptAsset
    | WebhookAsset
  )[];
  ext?: ExtensionObject;
}

// core/destination.json
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


// core/education-item.json
/**
 * An educational program or course within an education-type catalog. Carries the program details that platforms use for education ads and student recruitment campaigns. Maps to Google DynamicEducationAsset, schema.org Course, and similar formats.
 */
export interface EducationItem {
  /**
   * Unique identifier for this program or course.
   */
  program_id: string;
  /**
   * Program or course name (e.g., 'MSc Computer Science', 'Digital Marketing Certificate').
   */
  name: string;
  /**
   * Institution or provider name.
   */
  school: string;
  /**
   * Program description including curriculum highlights and outcomes.
   */
  description?: string;
  /**
   * Subject area or field of study (e.g., 'computer-science', 'business', 'healthcare').
   */
  subject?: string;
  /**
   * Type of credential awarded.
   */
  degree_type?: 'certificate' | 'associate' | 'bachelor' | 'master' | 'doctorate' | 'professional' | 'bootcamp';
  /**
   * Difficulty or prerequisite level.
   */
  level?: 'beginner' | 'intermediate' | 'advanced';
  price?: Price;
  /**
   * Program duration as a human-readable string (e.g., '4 weeks', '2 years', '6 months').
   */
  duration?: string;
  /**
   * Next available start date (ISO 8601 date).
   */
  start_date?: string;
  /**
   * Language of instruction (e.g., 'en', 'nl', 'es').
   */
  language?: string;
  /**
   * Delivery format.
   */
  modality?: 'online' | 'in_person' | 'hybrid';
  /**
   * Campus or instruction location (e.g., 'Amsterdam, NL'). Omit for fully online programs.
   */
  location?: string;
  /**
   * Program or institution image URL.
   */
  image_url?: string;
  /**
   * Program landing page or enrollment URL.
   */
  url?: string;
  /**
   * Tags for filtering (e.g., 'stem', 'scholarship-available', 'evening-classes').
   */
  tags?: string[];
  /**
   * Typed creative asset pools for this program. Uses the same OfferingAssetGroup structure as offering-type catalogs. Standard group IDs: 'images_landscape' (campus/program hero), 'images_vertical' (9:16 for Stories), 'logo' (institution logo). Enables formats to declare typed image requirements that map unambiguously to the right asset regardless of platform.
   */
  assets?: OfferingAssetGroup[];
  ext?: ExtensionObject;
}

// core/event-custom-data.json
/**
 * Event-specific data for attribution and reporting
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
  }[];
  ext?: ExtensionObject;
}

// core/event-source-health.json
/**
 * Health assessment for a configured event source. Sellers evaluate the quality, completeness, and volume of events received from this source. Sellers with native quality scores (Snap EQS, Meta EMQ) relay them in detail; sellers without native scores derive status from operational metrics (volume, error rates, tag activity).
 */
export interface EventSourceHealth {
  status: AssessmentStatus;
  /**
   * Seller-specific scoring detail. Only present when the seller has a native quality score to relay. Buyer agents should use status (not detail) for cross-seller decisions. Detail is supplementary context for human review or advanced diagnostics.
   */
  detail?: {
    /**
     * Seller-defined quality score. Scale varies by seller — only compare within the same seller.
     */
    score: number;
    /**
     * Maximum possible score on this seller's scale.
     */
    max_score: number;
    /**
     * Seller's name for this score (e.g., 'Event Quality Score', 'Event Match Quality').
     */
    label?: string;
  };
  /**
   * Fraction of events from this source that the seller successfully matched to ad interactions (0.0-1.0). Low match rates indicate weak user_match identifiers. Absent when the seller does not compute match rates.
   */
  match_rate?: number;
  /**
   * ISO 8601 timestamp of the most recent event received from this source. Absent when no events have been received.
   */
  last_event_at?: string;
  /**
   * ISO 8601 timestamp of when this health assessment was computed. When health is derived from reporting data, this may lag real-time. Buyer agents can use this to decide whether to trust stale assessments or re-request.
   */
  evaluated_at?: string;
  /**
   * Number of events received from this source in the last 24 hours. Zero indicates the source is configured but not firing.
   */
  events_received_24h?: number;
  /**
   * Actionable issues detected with this event source. Sellers should limit to the top 3-5 most actionable items. Buyer agents should sort by severity rather than relying on array position.
   */
  issues?: DiagnosticIssue[];
}

// core/event.json
/**
 * User identifiers for attribution matching
 */
export type UserMatch = {
  [k: string]: unknown | undefined;
} & {
  /**
   * Universal ID values for user matching
   */
  uids?: {
    type: UIDType;
    /**
     * Universal ID value
     */
    value: string;
  }[];
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
};
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
}

// core/flight-item.json
/**
 * A flight route within a flight-type catalog. Carries origin/destination, airline, pricing, and schedule data that platforms use for flight ads and dynamic travel remarketing. Maps to Google DynamicFlightsAsset, Meta flight catalogs, and similar formats.
 */
export interface FlightItem {
  /**
   * Unique identifier for this flight route or offer.
   */
  flight_id: string;
  /**
   * Departure airport or city.
   */
  origin: {
    /**
     * IATA airport code (e.g., 'AMS', 'JFK', 'LHR').
     */
    airport_code: string;
    /**
     * City name (e.g., 'Amsterdam', 'New York').
     */
    city?: string;
  };
  /**
   * Arrival airport or city.
   */
  destination: {
    /**
     * IATA airport code.
     */
    airport_code: string;
    /**
     * City name.
     */
    city?: string;
  };
  /**
   * Airline name or IATA airline code.
   */
  airline?: string;
  price?: Price;
  /**
   * Route description or promotional text.
   */
  description?: string;
  /**
   * Departure date and time (ISO 8601).
   */
  departure_time?: string;
  /**
   * Arrival date and time (ISO 8601).
   */
  arrival_time?: string;
  /**
   * Promotional image URL (typically a destination photo).
   */
  image_url?: string;
  /**
   * Booking page URL for this route.
   */
  url?: string;
  /**
   * Tags for filtering (e.g., 'direct', 'red-eye', 'business-class').
   */
  tags?: string[];
  /**
   * Typed creative asset pools for this flight. Uses the same OfferingAssetGroup structure as offering-type catalogs. Standard group IDs: 'images_landscape' (destination hero), 'images_vertical' (9:16 for Stories), 'images_square' (1:1). Enables formats to declare typed image requirements that map unambiguously to the right asset regardless of platform.
   */
  assets?: OfferingAssetGroup[];
  ext?: ExtensionObject;
}

// core/format.json
/**
 * Types of parameters that template formats accept in format_id objects to create parameterized format identifiers
 */
export type FormatIDParameter = 'dimensions' | 'duration';
/**
 * WCAG conformance level that this format achieves. For format-rendered creatives, the format guarantees this level. For opaque creatives, the format requires assets that self-certify to this level.
 */
export type WCAGLevel = 'A' | 'AA' | 'AAA';
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
  /**
   * List of parameters this format accepts in format_id. Template formats define which parameters (dimensions, duration, etc.) can be specified when instantiating the format. Empty or omitted means this is a concrete format with fixed parameters.
   */
  accepts_parameters?: FormatIDParameter[];
  /**
   * Specification of rendered pieces for this format. Most formats produce a single render. Companion ad formats (video + banner), adaptive formats, and multi-placement formats produce multiple renders. Each render specifies its role and dimensions.
   */
  renders?: (
    | {
        [k: string]: unknown | undefined;
      }
    | {
        parameters_from_format_id: true;
      }
  )[];
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
  delivery?: {};
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
    manifest: {};
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
   * Disclosure positions this format can render. Buyers use this to determine whether a format can satisfy their compliance requirements before submitting a creative. When omitted, the format makes no disclosure rendering guarantees — creative agents SHOULD treat this as incompatible with briefs that require specific disclosure positions. Values correspond to positions on creative-brief.json required_disclosures.
   */
  supported_disclosure_positions?: DisclosurePosition[];
  /**
   * Structured disclosure capabilities per position with persistence modes. Declares which persistence behaviors each disclosure position supports, enabling persistence-aware matching against provenance render guidance and brief requirements. When present, supersedes supported_disclosure_positions for persistence-aware queries. The flat supported_disclosure_positions field is retained for backward compatibility. Each position MUST appear at most once; validators and agents SHOULD reject duplicates.
   */
  disclosure_capabilities?: {
    position: DisclosurePosition;
    /**
     * Persistence modes this position supports
     */
    persistence: DisclosurePersistence[];
  }[];
  /**
   * Optional detailed card with carousel and full specifications. Provides rich format documentation similar to ad spec pages.
   */
  format_card_detailed?: {
    format_id: FormatID;
    /**
     * Asset manifest for rendering the detailed card, structure defined by the format
     */
    manifest: {};
  };
  /**
   * Metrics this format can produce in delivery reporting. Buyers receive the intersection of format reported_metrics and product available_metrics. If omitted, the format defers entirely to product-level metric declarations.
   */
  reported_metrics?: AvailableMetric[];
  /**
   * Pricing options for this format. Used by transformation and generation agents that charge per format adapted, per image generated, or per unit of work. Present when the request included include_pricing=true and account. Ad servers and library-based agents expose pricing on list_creatives instead.
   */
  pricing_options?: VendorPricingOption[];
}
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
   * Descriptive label for this asset's purpose (e.g., 'hero_image', 'logo', 'third_party_tracking'). For documentation and UI display only — manifests key assets by asset_id, not asset_role.
   */
  asset_role?: string;
  /**
   * Whether this asset is required (true) or optional (false). Required assets must be provided for a valid creative. Optional assets enhance the creative but are not mandatory.
   */
  required: boolean;
  /**
   * Publisher-controlled elements rendered on top of buyer content at this asset's position (e.g., video player controls, publisher logos). Creative agents should avoid placing critical content (CTAs, logos, key copy) within overlay bounds.
   */
  overlays?: Overlay[];
}
/**
 * A publisher-controlled element that renders on top of buyer creative content within the ad placement. Creative agents should avoid placing critical content (CTAs, logos, key copy) within overlay bounds.
 */
export interface Overlay {
  /**
   * Identifier for this overlay (e.g., 'play_pause', 'volume', 'publisher_logo', 'carousel_prev', 'carousel_next')
   */
  id: string;
  /**
   * Human-readable explanation of what this overlay is and how buyers should account for it
   */
  description?: string;
  /**
   * Optional visual reference for this overlay element. Useful for creative agents compositing previews and for buyers understanding what will appear over their content. Must include at least one of: url, light, or dark.
   */
  visual?: {
    /**
     * URL to a theme-neutral overlay graphic (SVG or PNG). Use when a single file works for all backgrounds, e.g. an SVG using CSS custom properties or currentColor.
     */
    url?: string;
    /**
     * URL to the overlay graphic for use on light/bright backgrounds (SVG or PNG)
     */
    light?: string;
    /**
     * URL to the overlay graphic for use on dark backgrounds (SVG or PNG)
     */
    dark?: string;
  };
  /**
   * Position and size of the overlay relative to the asset's own top-left corner. See 'unit' for coordinate interpretation.
   */
  bounds: {
    /**
     * Horizontal offset from the asset's left edge
     */
    x: number;
    /**
     * Vertical offset from the asset's top edge
     */
    y: number;
    /**
     * Width of the overlay
     */
    width: number;
    /**
     * Height of the overlay
     */
    height: number;
    /**
     * 'px' = absolute pixels from asset top-left. 'fraction' = proportional to asset dimensions (0.0 = edge, 1.0 = opposite edge). 'inches', 'cm', 'mm', 'pt' (1/72 inch) = physical units for print overlays, measured from asset top-left.
     */
    unit: 'px' | 'fraction' | 'inches' | 'cm' | 'mm' | 'pt';
  };
}
export interface BaseGroupAsset {
  /**
   * Identifier for this asset within the group
   */
  asset_id: string;
  /**
   * Descriptive label for this asset's purpose. For documentation and UI display only — manifests key assets by asset_id, not asset_role.
   */
  asset_role?: string;
  /**
   * Whether this asset is required within each repetition of the group
   */
  required: boolean;
  /**
   * Publisher-controlled elements rendered on top of buyer content at this asset's position (e.g., carousel navigation arrows, slide indicators). Creative agents should avoid placing critical content within overlay bounds.
   */
  overlays?: Overlay[];
}

// core/hotel-item.json
/**
 * A hotel or lodging property within a hotel-type catalog. Carries the property data that platforms use for hotel ads, dynamic remarketing, and travel campaign creatives. Maps to Google Hotel Center feeds, Meta hotel catalogs, and similar platform-native formats.
 */
export interface HotelItem {
  /**
   * Unique identifier for this property. Used to match remarketing events and inventory feeds to the correct hotel.
   */
  hotel_id: string;
  /**
   * Property name (e.g., 'Grand Hotel Amsterdam', 'Seaside Resort & Spa').
   */
  name: string;
  /**
   * Property description highlighting features and location.
   */
  description?: string;
  /**
   * Geographic coordinates of the property.
   */
  location: {
    /**
     * Latitude in decimal degrees (WGS 84).
     */
    lat: number;
    /**
     * Longitude in decimal degrees (WGS 84).
     */
    lng: number;
  };
  /**
   * Structured address for display and geocoding.
   */
  address?: {
    /**
     * Street address.
     */
    street?: string;
    /**
     * City name.
     */
    city?: string;
    /**
     * State, province, or region.
     */
    region?: string;
    /**
     * Postal or ZIP code.
     */
    postal_code?: string;
    /**
     * ISO 3166-1 alpha-2 country code.
     */
    country?: string;
  };
  /**
   * Official star rating (1–5).
   */
  star_rating?: number;
  price?: Price;
  /**
   * Primary property image URL.
   */
  image_url?: string;
  /**
   * Property landing page or booking URL.
   */
  url?: string;
  /**
   * Property phone number in E.164 format.
   */
  phone?: string;
  /**
   * Property amenities (e.g., 'pool', 'wifi', 'spa', 'parking', 'restaurant').
   */
  amenities?: string[];
  /**
   * Standard check-in time in HH:MM format (e.g., '15:00').
   */
  check_in_time?: string;
  /**
   * Standard check-out time in HH:MM format (e.g., '11:00').
   */
  check_out_time?: string;
  /**
   * Tags for filtering and targeting (e.g., 'boutique', 'family', 'business', 'luxury').
   */
  tags?: string[];
  /**
   * Date from which this item is available or this rate applies (ISO 8601, e.g., '2025-03-01'). Used for seasonal availability windows in feed imports.
   */
  valid_from?: string;
  /**
   * Date until which this item is available or this rate applies (ISO 8601, e.g., '2025-09-30'). Used for seasonal availability windows in feed imports.
   */
  valid_to?: string;
  /**
   * Typed creative asset pools for this hotel. Uses the same OfferingAssetGroup structure as offering-type catalogs. Standard group IDs: 'images_landscape' (16:9 hero images), 'images_vertical' (9:16 for Snap, Stories), 'images_square' (1:1), 'logo'. Enables formats to declare typed image requirements that map unambiguously to the right asset regardless of platform.
   */
  assets?: OfferingAssetGroup[];
  ext?: ExtensionObject;
}

// core/job-item.json
/**
 * A job posting within a job-type catalog. Carries the position details that platforms use for job ads and recruitment campaigns. Maps to LinkedIn Jobs XML, Google DynamicJobsAsset, schema.org JobPosting, and similar formats.
 */
export interface JobItem {
  /**
   * Unique identifier for this job posting.
   */
  job_id: string;
  /**
   * Job title (e.g., 'Senior Software Engineer', 'Marketing Manager').
   */
  title: string;
  /**
   * Hiring company or organization name.
   */
  company_name: string;
  /**
   * Full job description including responsibilities and qualifications.
   */
  description: string;
  /**
   * Job location as a display string (e.g., 'Amsterdam, NL', 'Remote', 'New York, NY'). Use 'Remote' for fully remote positions.
   */
  location?: string;
  /**
   * Type of employment.
   */
  employment_type?: 'full_time' | 'part_time' | 'contract' | 'temporary' | 'internship' | 'freelance';
  /**
   * Required experience level.
   */
  experience_level?: 'entry_level' | 'mid_level' | 'senior' | 'director' | 'executive';
  /**
   * Salary range. Specify min and/or max with currency and period.
   */
  salary?: {
    /**
     * Minimum salary.
     */
    min?: number;
    /**
     * Maximum salary.
     */
    max?: number;
    /**
     * ISO 4217 currency code.
     */
    currency: string;
    /**
     * Pay period.
     */
    period: 'hour' | 'month' | 'year';
  };
  /**
   * Date the job was posted (ISO 8601 date).
   */
  date_posted?: string;
  /**
   * Application deadline (ISO 8601 date).
   */
  valid_through?: string;
  /**
   * Direct application URL.
   */
  apply_url?: string;
  /**
   * Job function categories (e.g., 'engineering', 'marketing', 'sales', 'finance').
   */
  job_functions?: string[];
  /**
   * Industry classifications (e.g., 'technology', 'healthcare', 'retail').
   */
  industries?: string[];
  /**
   * Tags for filtering (e.g., 'remote', 'visa-sponsorship', 'equity').
   */
  tags?: string[];
  /**
   * Typed creative asset pools for this job. Uses the same OfferingAssetGroup structure as offering-type catalogs. Standard group IDs: 'images_landscape' (company/role hero), 'images_vertical' (9:16 for Stories), 'logo' (company logo). Enables formats to declare typed image requirements that map unambiguously to the right asset regardless of platform.
   */
  assets?: OfferingAssetGroup[];
  ext?: ExtensionObject;
}

// core/media-buy-features.json
/**
 * Optional media-buy protocol features. Used in capability declarations (seller declares support) and product filters (buyer requires support). If a seller declares a feature as true, they MUST honor requests using that feature.
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
   * Supports sync_catalogs task for catalog feed management with platform review and approval
   */
  catalog_management?: boolean;
  [k: string]: boolean | undefined;
}


// core/offering.json
/**
 * A promotable offering from a brand. Can represent a campaign, product promotion, service, or any other thing the brand wants to make available. Offerings carry structured asset groups for creative assembly and can be promoted via traditional creatives or conversational SI experiences (via the brand's SI agent).
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
   * Landing page URL for this offering. For catalog-driven creatives, this is the per-item click-through destination that platforms map to the ad's link-out URL. Every offering in a catalog should have a landing_url unless the format provides its own destination logic.
   */
  landing_url?: string;
  /**
   * Structured asset groups for this offering. Each group carries a typed pool of creative assets (headlines, images, videos, etc.) identified by a group ID that matches format-level vocabulary.
   */
  assets?: OfferingAssetGroup[];
  /**
   * Geographic scope of this offering. Declares where the offering is relevant — for location-specific offerings such as job vacancies, in-store promotions, or local events. Platforms use this to target geographically appropriate audiences and to filter out offerings irrelevant to a user's location. Uses the same geographic structures as targeting_overlay in create_media_buy.
   */
  geo_targets?: {
    /**
     * Countries where this offering is relevant. ISO 3166-1 alpha-2 codes (e.g., 'US', 'NL', 'DE').
     */
    countries?: string[];
    /**
     * Regions or states where this offering is relevant. ISO 3166-2 subdivision codes (e.g., 'NL-NH', 'US-CA').
     */
    regions?: string[];
    /**
     * Metro areas where this offering is relevant. Each entry specifies the classification system and target values.
     */
    metros?: {
      system: MetroAreaSystem;
      /**
       * Metro codes within the system
       */
      values: string[];
    }[];
    /**
     * Postal areas where this offering is relevant. Each entry specifies the postal system and target values.
     */
    postal_areas?: {
      system: PostalCodeSystem;
      /**
       * Postal codes within the system
       */
      values: string[];
    }[];
  };
  /**
   * Keywords for matching this offering to user intent. Hosts use these for retrieval/relevance scoring.
   */
  keywords?: string[];
  /**
   * Categories this offering belongs to (e.g., 'measurement', 'identity', 'programmatic')
   */
  categories?: string[];
  ext?: ExtensionObject;
}

// core/performance-feedback.json
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
 * Represents performance feedback data for a media buy or package
 */
export interface PerformanceFeedback {
  /**
   * Unique identifier for this performance feedback submission
   */
  feedback_id: string;
  /**
   * Publisher's media buy identifier
   */
  media_buy_id: string;
  /**
   * Specific package within the media buy (if feedback is package-specific)
   */
  package_id?: string;
  /**
   * Specific creative asset (if feedback is creative-specific)
   */
  creative_id?: string;
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
  metric_type: MetricType;
  feedback_source: FeedbackSource;
  /**
   * Processing status of the performance feedback
   */
  status: 'accepted' | 'queued' | 'applied' | 'rejected';
  /**
   * ISO 8601 timestamp when feedback was submitted
   */
  submitted_at: string;
  /**
   * ISO 8601 timestamp when feedback was applied to optimization algorithms
   */
  applied_at?: string;
}


// core/placement-definition.json
/**
 * Canonical placement definition published in a publisher's adagents.json. Defines stable placement IDs that products can reuse and that authorization rules can reference. When a product reuses a registered placement_id, it is referring to this same semantic placement, not inventing a new one with the same ID.
 */
export type PlacementDefinition = {
  [k: string]: unknown | undefined;
} & {
  /**
   * Stable placement identifier unique within this adagents.json file.
   */
  placement_id: string;
  /**
   * Human-readable placement name (e.g., 'Homepage Banner', 'Pre-roll', 'Sponsored Listing Slot 1').
   */
  name: string;
  /**
   * Description of where and how this placement appears.
   */
  description?: string;
  /**
   * Tags for grouping and querying placements across properties and products (e.g., 'homepage', 'native', 'premium', 'pre_roll').
   */
  tags?: string[];
  /**
   * Property IDs in this adagents.json where this placement can appear.
   */
  property_ids?: PropertyID[];
  /**
   * Property tags in this adagents.json where this placement can appear. Useful for network-wide positions such as 'pre_roll' or 'homepage_native_feed'.
   */
  property_tags?: PropertyTag[];
  /**
   * Optional collection IDs in this adagents.json where this placement is valid. Use to narrow a placement to specific content programs carried on the selected properties.
   */
  collection_ids?: string[];
  /**
   * Optional format IDs supported by this placement across the scoped properties and collections. Lets buyers answer which formats are available on which placements without relying on product-local definitions alone.
   */
  format_ids?: FormatID[];
  ext?: ExtensionObject;
};

// core/product-filters.json
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
    }
  | {
      signal_id: SignalID;
      /**
       * Discriminator for categorical signals
       */
      value_type: 'categorical';
      /**
       * Values to target. Users with any of these values will be included.
       */
      values: string[];
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
    };
/**
 * Structured filters for product discovery
 */
export interface ProductFilters {
  delivery_type?: DeliveryType;
  exclusivity?: Exclusivity;
  /**
   * Filter by pricing availability: true = products offering fixed pricing (at least one option with fixed_price), false = products offering auction pricing (at least one option without fixed_price). Products with both fixed and auction options match both true and false.
   */
  is_fixed_price?: boolean;
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
   * Filter by advertising channels (e.g., ['display', 'ctv', 'dooh'])
   */
  channels?: MediaChannel[];
  /**
   * @deprecated
   * Deprecated: Use trusted_match filter instead. Filter to products executable through specific agentic ad exchanges. URLs are canonical identifiers.
   */
  required_axe_integrations?: string[];
  /**
   * Filter products by Trusted Match Protocol capabilities. Only products with matching TMP support are returned.
   */
  trusted_match?: {
    /**
     * Filter to products with specific TMP providers and match types. Each entry identifies a provider by agent_url and optionally requires specific match capabilities. Products must match at least one entry.
     */
    providers?: {
      /**
       * Provider's agent URL from the registry.
       */
      agent_url: string;
      /**
       * When true, require this provider to support context match.
       */
      context_match?: boolean;
      /**
       * When true, require this provider to support identity match.
       */
      identity_match?: boolean;
    }[];
    /**
     * Filter to products supporting specific TMP response types (e.g., 'activation', 'creative', 'catalog_items'). Products must support at least one of the listed types.
     */
    response_types?: TMPResponseType[];
  };
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
  /**
   * Filter to products supporting specific signals from data provider catalogs. Products must have the requested signals in their data_provider_signals and signal_targeting_allowed must be true (or all signals requested).
   */
  signal_targeting?: SignalTargeting[];
  /**
   * Filter by postal area coverage for locally-bound inventory (direct mail, DOOH, local campaigns). Use when products have postal-area-specific coverage. For digital inventory where products have broad coverage, use required_geo_targeting instead to filter by seller capability.
   */
  postal_areas?: {
    system: PostalCodeSystem;
    /**
     * Postal codes within the system (e.g., ['10001', '10002'] for us_zip)
     */
    values: string[];
  }[];
  /**
   * Filter by proximity to geographic points. Returns products with inventory coverage near these locations. Follows the same format as the targeting overlay — each entry uses exactly one method: travel_time + transport_mode, radius, or geometry. For locally-bound inventory (DOOH, radio), filters to products with coverage in the area. For digital inventory, filters to products from sellers supporting geo_proximity targeting.
   */
  geo_proximity?: {
    [k: string]: unknown | undefined;
  }[];
  /**
   * Filter to products that can meet the buyer's performance standard requirements. Each entry specifies a metric, minimum threshold, and optionally a required vendor and standard. Products that cannot meet these thresholds or do not support the specified vendors are excluded. Use this to tell the seller upfront: 'I need DoubleVerify for viewability at 70% MRC.'
   */
  required_performance_standards?: PerformanceStandard[];
  /**
   * Filter by keyword relevance for search and retail media platforms. Returns products that support keyword targeting for these terms. Allows the sell-side agent to assess keyword availability and recommend appropriate products. Use match_type to indicate the desired precision.
   */
  keywords?: {
    /**
     * The keyword to target
     */
    keyword: string;
    /**
     * Desired match type: broad matches related queries, phrase matches queries containing the keyword phrase, exact matches the query exactly. Defaults to broad.
     */
    match_type?: 'broad' | 'phrase' | 'exact';
  }[];
}

// core/protocol-envelope.json
/**
 * Standard envelope structure for AdCP task responses. This envelope is added by the protocol layer (MCP, A2A, REST) and wraps the task-specific response payload. Task response schemas should NOT include these fields - they are protocol-level concerns.
 */
export interface ProtocolEnvelope {
  /**
   * Session/conversation identifier for tracking related operations across multiple task invocations. Managed by the protocol layer to maintain conversational context.
   */
  context_id?: string;
  /**
   * Unique identifier for tracking asynchronous operations. Present when a task requires extended processing time. Used to query task status and retrieve results when complete.
   */
  task_id?: string;
  status: TaskStatus;
  /**
   * Human-readable summary of the task result. Provides natural language explanation of what happened, suitable for display to end users or for AI agent comprehension. Generated by the protocol layer based on the task response.
   */
  message?: string;
  /**
   * ISO 8601 timestamp when the response was generated. Useful for debugging, logging, cache validation, and tracking async operation progress.
   */
  timestamp?: string;
  push_notification_config?: PushNotificationConfig;
  /**
   * Opaque governance context issued by a governance agent during check_governance. Buyers attach it to governed purchase requests (media buys, rights acquisitions, signal activations, creative services); sellers persist it and include it on all subsequent governance calls for that action's lifecycle. Neither buyers nor sellers interpret this value — only the governance agent that issued it. This is the primary correlation key for audit and reporting across the governance lifecycle.
   */
  governance_context?: string;
  /**
   * The actual task-specific response data. This is the content defined in individual task response schemas (e.g., get-products-response.json, create-media-buy-response.json). Contains only domain-specific data without protocol-level fields.
   */
  payload: {};
}

// core/real-estate-item.json
/**
 * A property listing within a real-estate-type catalog. Carries the address, pricing, and specification data that platforms use for real estate ads and dynamic remarketing. Maps to Google DynamicRealEstateAsset, Meta home listing catalogs, and similar formats.
 */
export interface RealEstateItem {
  /**
   * Unique identifier for this property listing.
   */
  listing_id: string;
  /**
   * Listing title (e.g., 'Spacious 3BR Apartment in Jordaan').
   */
  title: string;
  /**
   * Property address.
   */
  address: {
    /**
     * Street address.
     */
    street?: string;
    /**
     * City name.
     */
    city?: string;
    /**
     * State, province, or region.
     */
    region?: string;
    /**
     * Postal or ZIP code.
     */
    postal_code?: string;
    /**
     * ISO 3166-1 alpha-2 country code.
     */
    country?: string;
  };
  price?: Price;
  /**
   * Type of property.
   */
  property_type?: 'house' | 'apartment' | 'condo' | 'townhouse' | 'land' | 'commercial';
  /**
   * Whether the property is for sale or rent.
   */
  listing_type?: 'for_sale' | 'for_rent';
  /**
   * Number of bedrooms.
   */
  bedrooms?: number;
  /**
   * Number of bathrooms (e.g., 2.5 for two full and one half bath).
   */
  bathrooms?: number;
  /**
   * Property size.
   */
  area?: {
    /**
     * Area value.
     */
    value: number;
    /**
     * Area unit.
     */
    unit: 'sqft' | 'sqm';
  };
  /**
   * Property description.
   */
  description?: string;
  /**
   * Geographic coordinates of the property.
   */
  location?: {
    /**
     * Latitude in decimal degrees (WGS 84).
     */
    lat: number;
    /**
     * Longitude in decimal degrees (WGS 84).
     */
    lng: number;
  };
  /**
   * Primary property image URL.
   */
  image_url?: string;
  /**
   * Listing page URL.
   */
  url?: string;
  /**
   * Neighborhood or area name.
   */
  neighborhood?: string;
  /**
   * Year the property was built.
   */
  year_built?: number;
  /**
   * Tags for filtering (e.g., 'garden', 'parking', 'renovated', 'waterfront').
   */
  tags?: string[];
  /**
   * Typed creative asset pools for this property listing. Uses the same OfferingAssetGroup structure as offering-type catalogs. Standard group IDs: 'images_landscape' (exterior/interior hero), 'images_vertical' (9:16 for Stories), 'images_square' (1:1). Enables formats to declare typed image requirements that map unambiguously to the right asset regardless of platform.
   */
  assets?: OfferingAssetGroup[];
  ext?: ExtensionObject;
}

// core/reporting-webhook.json
/**
 * Webhook configuration for automated reporting delivery. Configures where and how campaign performance reports are sent.
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
     */
    schemes: AuthenticationScheme[];
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
}


// core/requirements/asset-requirements.json
/**
 * Technical requirements for creative assets. The applicable schema is determined by the sibling asset_type field.
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
 * Unit of measurement for width/height values. Defaults to 'px' when absent. Print formats use 'inches' or 'cm'.
 */
export type DimensionUnit = 'px' | 'dp' | 'inches' | 'cm' | 'mm' | 'pt';

/**
 * Requirements for image creative assets. These define the technical constraints for image files.
 */
export interface ImageAssetRequirements {
  /**
   * Minimum width. Interpretation depends on unit (default: pixels). For exact dimensions, set min_width = max_width.
   */
  min_width?: number;
  /**
   * Maximum width. Interpretation depends on unit (default: pixels). For exact dimensions, set min_width = max_width.
   */
  max_width?: number;
  /**
   * Minimum height. Interpretation depends on unit (default: pixels). For exact dimensions, set min_height = max_height.
   */
  min_height?: number;
  /**
   * Maximum height. Interpretation depends on unit (default: pixels). For exact dimensions, set min_height = max_height.
   */
  max_height?: number;
  unit?: DimensionUnit;
  /**
   * Required aspect ratio (e.g., '16:9', '1:1', '1.91:1')
   */
  aspect_ratio?: string;
  /**
   * Accepted image file formats
   */
  formats?: ('jpg' | 'jpeg' | 'png' | 'gif' | 'webp' | 'svg' | 'avif' | 'tiff' | 'pdf' | 'eps')[];
  /**
   * Minimum resolution in dots per inch. Always in DPI regardless of the dimension unit. Standard print requires 300 DPI, newspaper 150 DPI.
   */
  min_dpi?: number;
  /**
   * Required bleed area beyond the trim size. The submitted image must be larger than the declared dimensions: total width = trim width + left bleed + right bleed, total height = trim height + top bleed + bottom bleed. For uniform bleed: total = trim + (2 * uniform). Uses the same unit as the parent dimensions.
   */
  bleed?:
    | {
        /**
         * Same bleed on all four sides
         */
        uniform: number;
      }
    | {
        top: number;
        right: number;
        bottom: number;
        left: number;
      };
  /**
   * Required color space. Print typically requires CMYK.
   */
  color_space?: 'rgb' | 'cmyk' | 'grayscale';
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
  /**
   * Maximum weight in grams for the finished physical piece (print inserts, flyers). Affects postage calculations and production constraints. Only applicable to print channels.
   */
  max_weight_grams?: number;
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
  codecs?: ('h264' | 'h265' | 'vp8' | 'vp9' | 'av1' | 'prores')[];
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
  /**
   * Required frame rate type. Broadcast and SSAI require constant frame rate for seamless splicing.
   */
  frame_rate_type?: 'constant' | 'variable';
  /**
   * Required scan type. Modern delivery requires progressive scan.
   */
  scan_type?: 'progressive' | 'interlaced';
  /**
   * Required GOP structure. SSAI and broadcast require closed GOPs for clean splice points.
   */
  gop_type?: 'closed' | 'open';
  /**
   * Minimum keyframe interval in seconds
   */
  min_gop_interval_seconds?: number;
  /**
   * Maximum keyframe interval in seconds. SSAI typically requires 1-2 second intervals.
   */
  max_gop_interval_seconds?: number;
  /**
   * Required moov atom position in MP4 container. 'start' enables progressive download without buffering the entire file.
   */
  moov_atom_position?: 'start' | 'end';
  /**
   * Accepted audio codecs (e.g., ['aac', 'pcm', 'ac3'])
   */
  audio_codecs?: ('aac' | 'pcm' | 'ac3' | 'eac3' | 'mp3' | 'opus' | 'vorbis' | 'flac')[];
  /**
   * Accepted audio sample rates in Hz (e.g., [44100, 48000])
   */
  audio_sample_rates?: number[];
  /**
   * Accepted audio channel configurations
   */
  audio_channels?: ('mono' | 'stereo' | '5.1' | '7.1')[];
  /**
   * Target integrated loudness in LUFS (e.g., -24 for broadcast, -16 for streaming)
   */
  loudness_lufs?: number;
  /**
   * Acceptable deviation from loudness_lufs target in dB (e.g., 2 means -22 to -26 LUFS for a -24 target)
   */
  loudness_tolerance_db?: number;
  /**
   * Maximum true peak level in dBFS (e.g., -2 for broadcast)
   */
  true_peak_dbfs?: number;
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
}
/**
 * Requirements for markdown creative assets.
 */
export interface MarkdownAssetRequirements {
  /**
   * Maximum character length
   */
  max_length?: number;
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
}
/**
 * Requirements for CSS creative assets.
 */
export interface CSSAssetRequirements {
  /**
   * Maximum file size in kilobytes
   */
  max_file_size_kb?: number;
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
}
/**
 * Requirements for VAST (Video Ad Serving Template) creative assets.
 */
export interface VASTAssetRequirements {
  /**
   * Required VAST version
   */
  vast_version?: '2.0' | '3.0' | '4.0' | '4.1' | '4.2';
}
/**
 * Requirements for DAAST (Digital Audio Ad Serving Template) creative assets.
 */
export interface DAASTAssetRequirements {
  /**
   * Required DAAST version. DAAST 1.0 is the current IAB standard.
   */
  daast_version?: '1.0';
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
}
/**
 * Requirements for webhook creative assets.
 */
export interface WebhookAssetRequirements {
  /**
   * Allowed HTTP methods
   */
  methods?: ('GET' | 'POST')[];
}


// core/requirements/catalog-field-binding.json
/**
 * Maps a format template slot to a catalog item field or typed asset pool. The 'kind' field identifies the binding variant. All bindings are optional — agents can still infer mappings without them.
 */
export type CatalogFieldBinding =
  | ScalarBinding
  | AssetPoolBinding
  | {
      kind: 'catalog_group';
      /**
       * The asset_group_id of a repeatable_group in the format's assets array.
       */
      format_group_id: string;
      /**
       * Each repetition of the format's repeatable_group maps to one item from the catalog.
       */
      catalog_item: true;
      /**
       * Scalar and asset pool bindings that apply within each repetition of the group. Nested catalog_group bindings are not permitted.
       */
      per_item_bindings?: (ScalarBinding | AssetPoolBinding)[];
      ext?: ExtensionObject;
    };

/**
 * Maps an individual format asset to a catalog item field via dot-notation path.
 */
export interface ScalarBinding {
  kind: 'scalar';
  /**
   * The asset_id from the format's assets array. Identifies which individual template slot this binding applies to.
   */
  asset_id: string;
  /**
   * Dot-notation path to the field on the catalog item (e.g., 'name', 'price.amount', 'location.city').
   */
  catalog_field: string;
  ext?: ExtensionObject;
}
/**
 * Maps an individual format asset to a typed asset pool on the catalog item (e.g., images_landscape, images_vertical, logo). The format slot receives the first item in the pool.
 */
export interface AssetPoolBinding {
  kind: 'asset_pool';
  /**
   * The asset_id from the format's assets array. Identifies which individual template slot this binding applies to.
   */
  asset_id: string;
  /**
   * The asset_group_id on the catalog item's assets array to pull from (e.g., 'images_landscape', 'images_vertical', 'logo').
   */
  asset_group_id: string;
  ext?: ExtensionObject;
}


// core/requirements/catalog-requirements.json
/**
 * Format-level declaration of what catalog feeds a creative needs. Formats that render product listings, store locators, or promotional content declare which catalog types must be synced and what fields each catalog must provide. Buyers use this to ensure the right catalogs are synced before submitting creatives.
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
   * Maximum number of items the format can render. Items beyond this limit are ignored. Useful for fixed-slot layouts (e.g., a 3-product card) or feed-size constraints.
   */
  max_items?: number;
  /**
   * Fields that must be present and non-empty on every item in the catalog. Field names are catalog-type-specific (e.g., 'title', 'price', 'image_url' for product catalogs; 'store_id', 'quantity' for inventory feeds).
   */
  required_fields?: string[];
  /**
   * Accepted feed formats for this catalog type. When specified, the synced catalog must use one of these formats. When omitted, any format is accepted.
   */
  feed_formats?: FeedFormat[];
  /**
   * Per-item creative asset requirements. Declares what asset groups (headlines, images, videos) each catalog item must provide in its assets array, along with count bounds and per-asset technical constraints. Applicable to 'offering' and all vertical catalog types (hotel, flight, job, etc.) whose items carry typed assets.
   */
  offering_asset_constraints?: OfferingAssetConstraint[];
  /**
   * Explicit mappings from format template slots to catalog item fields or typed asset pools. Optional — creative agents can infer mappings without them, but bindings make the relationship self-describing and enable validation. Covers scalar fields (asset_id → catalog_field), asset pools (asset_id → asset_group_id on the catalog item), and repeatable groups that iterate over catalog items.
   */
  field_bindings?: CatalogFieldBinding[];
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
}

// core/response.json
/**
 * Protocol-level response wrapper (MCP/A2A) - contains AdCP task data plus protocol fields
 */
export interface ProtocolResponse {
  /**
   * Human-readable summary
   */
  message: string;
  /**
   * Session continuity identifier
   */
  context_id?: string;
  /**
   * AdCP task-specific response data (see individual task response schemas)
   */
  data?: {
    [k: string]: unknown | undefined;
  };
}


// core/signal-definition.json
/**
 * The data type of this signal's values
 */
export type SignalValueType = 'binary' | 'categorical' | 'numeric';
/**
 * Personal data categories that may be restricted from use in audience targeting. Based on GDPR Article 9 special categories of personal data, which are also referenced by EU DSA Article 26 for advertising restrictions. Used in two places: (1) on campaign plans via restricted_attributes to declare which categories are prohibited, and (2) on signal-definition.json via restricted_attributes to declare which categories a signal touches. Governance agents match plan restrictions against signal declarations for structural validation.
 */
export type RestrictedAttribute =
  | 'racial_ethnic_origin'
  | 'political_opinions'
  | 'religious_beliefs'
  | 'trade_union_membership'
  | 'health_data'
  | 'sex_life_sexual_orientation'
  | 'genetic_data'
  | 'biometric_data';

/**
 * Definition of a signal in a data provider's catalog, published via adagents.json
 */
export interface SignalDefinition {
  /**
   * Signal identifier within this data provider's catalog
   */
  id: string;
  /**
   * Human-readable signal name
   */
  name: string;
  /**
   * Detailed description of what this signal represents and how it's derived
   */
  description?: string;
  value_type: SignalValueType;
  /**
   * Tags for grouping and filtering signals within the catalog
   */
  tags?: string[];
  /**
   * For categorical signals, the valid values users can be assigned
   */
  allowed_values?: string[];
  /**
   * Restricted attribute categories this signal touches. Data providers SHOULD declare these so governance agents can structurally match signals against a plan's restricted_attributes without relying on semantic inference from the signal name or description.
   */
  restricted_attributes?: RestrictedAttribute[];
  /**
   * Policy categories this signal is sensitive for (e.g., a children's interest signal declares ['children_directed']). Governance agents match these against a plan's policy_categories to flag sensitive data usage.
   */
  policy_categories?: string[];
  /**
   * For numeric signals, the valid value range
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
    /**
     * Unit of measurement (e.g., 'score', 'dollars', 'years')
     */
    unit?: string;
  };
}


// core/signal-filters.json
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
   */
  catalog_types?: SignalCatalogType[];
  /**
   * Filter by specific data providers
   */
  data_providers?: string[];
  /**
   * Maximum CPM filter. Applies only to signals with model='cpm'.
   */
  max_cpm?: number;
  /**
   * Maximum percent-of-media rate filter. Signals where all percent_of_media pricing options exceed this value are excluded. Does not account for max_cpm caps.
   */
  max_percent?: number;
  /**
   * Minimum coverage requirement
   */
  min_coverage_percentage?: number;
}


// core/signal-pricing-option.json
/**
 * Deprecated — use vendor-pricing-option.json for new implementations. This alias is retained for backward compatibility.
 */
export type SignalPricingOption = {
  /**
   * Opaque identifier for this pricing option, unique within the vendor agent. Pass this in report_usage to identify which pricing option was applied.
   */
  pricing_option_id: string;
} & VendorPricing;

// core/start-timing.json
/**
 * Campaign start timing: 'asap' or ISO 8601 date-time
 */
export type StartTiming = 'asap' | string;


// core/store-item.json
/**
 * A physical store or location within a store-type catalog. Carries the location data, catchment areas, and metadata that platforms use for proximity targeting, store locator creatives, and inventory-aware ad serving.
 */
export interface StoreItem {
  /**
   * Unique identifier for this store. Used to reference specific stores in targeting, inventory feeds, and creative templates.
   */
  store_id: string;
  /**
   * Human-readable store name (e.g., 'Amsterdam Flagship', 'Brooklyn Heights').
   */
  name: string;
  /**
   * Geographic coordinates of the store.
   */
  location: {
    /**
     * Latitude in decimal degrees (WGS 84).
     */
    lat: number;
    /**
     * Longitude in decimal degrees (WGS 84).
     */
    lng: number;
  };
  /**
   * Structured address for display and geocoding fallback.
   */
  address?: {
    /**
     * Street address (e.g., '123 Main St').
     */
    street?: string;
    /**
     * City name.
     */
    city?: string;
    /**
     * State, province, or region. ISO 3166-2 subdivision code preferred (e.g., 'NL-NH', 'US-CA').
     */
    region?: string;
    /**
     * Postal or ZIP code.
     */
    postal_code?: string;
    /**
     * ISO 3166-1 alpha-2 country code.
     */
    country?: string;
  };
  /**
   * Catchment areas for this store. Each defines a reachable area using travel time (isochrone), simple radius, or pre-computed GeoJSON. Multiple catchments allow different modes — e.g., 15-minute drive AND 10-minute walk.
   */
  catchments?: Catchment[];
  /**
   * Store phone number in E.164 format (e.g., '+31201234567').
   */
  phone?: string;
  /**
   * Store-specific page URL (e.g., store locator detail page).
   */
  url?: string;
  /**
   * Operating hours. Keys are ISO day names (monday–sunday), values are time ranges.
   */
  hours?: {
    /**
     * Time range in HH:MM-HH:MM format (e.g., '09:00-21:00'). Use 'closed' for days the store is not open.
     */
    [k: string]: string | undefined;
  };
  /**
   * Tags for filtering stores in targeting and creative selection (e.g., 'flagship', 'pickup', 'pharmacy').
   */
  tags?: string[];
  ext?: ExtensionObject;
}

// core/vehicle-item.json
/**
 * A vehicle listing within a vehicle-type catalog. Carries the make/model, pricing, and specification data that platforms use for automotive inventory ads. Maps to Meta Automotive Inventory Ads, Microsoft Auto Inventory feeds, Google vehicle ads, and similar formats.
 */
export interface VehicleItem {
  /**
   * Unique identifier for this vehicle listing.
   */
  vehicle_id: string;
  /**
   * Listing title (e.g., '2024 Honda Civic EX Sedan').
   */
  title: string;
  /**
   * Vehicle manufacturer (e.g., 'Honda', 'Ford', 'BMW').
   */
  make: string;
  /**
   * Vehicle model (e.g., 'Civic', 'F-150', 'X5').
   */
  model: string;
  /**
   * Model year.
   */
  year: number;
  price?: Price;
  /**
   * Vehicle condition.
   */
  condition?: 'new' | 'used' | 'certified_pre_owned';
  /**
   * Vehicle Identification Number (17-character VIN).
   */
  vin?: string;
  /**
   * Trim level (e.g., 'EX', 'Limited', 'Sport').
   */
  trim?: string;
  /**
   * Odometer reading.
   */
  mileage?: {
    /**
     * Mileage value.
     */
    value: number;
    /**
     * Distance unit.
     */
    unit: 'km' | 'mi';
  };
  /**
   * Vehicle body style.
   */
  body_style?: 'sedan' | 'suv' | 'truck' | 'coupe' | 'convertible' | 'wagon' | 'van' | 'hatchback';
  /**
   * Transmission type.
   */
  transmission?: 'automatic' | 'manual' | 'cvt';
  /**
   * Fuel or powertrain type.
   */
  fuel_type?: 'gasoline' | 'diesel' | 'electric' | 'hybrid' | 'plug_in_hybrid';
  /**
   * Exterior color.
   */
  exterior_color?: string;
  /**
   * Interior color.
   */
  interior_color?: string;
  /**
   * Dealer or vehicle location.
   */
  location?: {
    /**
     * Latitude in decimal degrees (WGS 84).
     */
    lat: number;
    /**
     * Longitude in decimal degrees (WGS 84).
     */
    lng: number;
  };
  /**
   * Primary vehicle image URL.
   */
  image_url?: string;
  /**
   * Vehicle listing page URL.
   */
  url?: string;
  /**
   * Tags for filtering (e.g., 'low-mileage', 'one-owner', 'dealer-certified').
   */
  tags?: string[];
  /**
   * Typed creative asset pools for this vehicle. Uses the same OfferingAssetGroup structure as offering-type catalogs. Standard group IDs: 'images_landscape' (exterior hero), 'images_vertical' (9:16 for Stories), 'images_square' (1:1). Enables formats to declare typed image requirements that map unambiguously to the right asset regardless of platform.
   */
  assets?: OfferingAssetGroup[];
  ext?: ExtensionObject;
}

// creative/creative-feature-result.json
/**
 * A single feature evaluation result for a creative. Uses the same value structure as property-feature-value (value, confidence, expires_at, etc.).
 */
export interface CreativeFeatureResult {
  /**
   * The feature that was evaluated (e.g., 'auto_redirect', 'brand_consistency'). Features prefixed with 'registry:' reference standardized policies from the shared policy registry (e.g., 'registry:eu_ai_act_article_50'). Unprefixed feature IDs are agent-defined.
   */
  feature_id: string;
  /**
   * The feature value. Type depends on feature definition: boolean for binary, number for quantitative, string for categorical.
   */
  value: boolean | number | string;
  /**
   * Unit of measurement for quantitative values (e.g., 'percentage', 'score')
   */
  unit?: string;
  /**
   * Confidence score for this value (0-1)
   */
  confidence?: number;
  /**
   * When this feature was evaluated
   */
  measured_at?: string;
  /**
   * When this evaluation expires and should be refreshed
   */
  expires_at?: string;
  /**
   * Version of the methodology used to evaluate this feature
   */
  methodology_version?: string;
  /**
   * Additional vendor-specific details about this evaluation
   */
  details?: {};
  ext?: ExtensionObject;
}

// enums/advertiser-industry.json
/**
 * Standardized advertiser industry classification. Top-level categories classify the advertiser's primary business. Dot-notation subcategories (e.g., 'media_entertainment.podcasts') provide platform-specific precision where needed. Sellers map these to platform-native codes (Spotify ADV categories, LinkedIn industry IDs, IAB Content Taxonomy, etc.). Sellers MUST accept unknown values gracefully — treat unrecognized values as the parent category (strip the subcategory) or as uncategorized. This ensures forward compatibility as the taxonomy evolves.
 */
export type AdvertiserIndustry =
  | 'automotive'
  | 'automotive.electric_vehicles'
  | 'automotive.parts_accessories'
  | 'automotive.luxury'
  | 'beauty_cosmetics'
  | 'beauty_cosmetics.skincare'
  | 'beauty_cosmetics.fragrance'
  | 'beauty_cosmetics.haircare'
  | 'cannabis'
  | 'cpg'
  | 'cpg.personal_care'
  | 'cpg.household'
  | 'dating'
  | 'education'
  | 'education.higher_education'
  | 'education.online_learning'
  | 'education.k12'
  | 'energy_utilities'
  | 'energy_utilities.renewable'
  | 'fashion_apparel'
  | 'fashion_apparel.luxury'
  | 'fashion_apparel.sportswear'
  | 'finance'
  | 'finance.banking'
  | 'finance.insurance'
  | 'finance.investment'
  | 'finance.cryptocurrency'
  | 'food_beverage'
  | 'food_beverage.alcohol'
  | 'food_beverage.restaurants'
  | 'food_beverage.packaged_goods'
  | 'gambling_betting'
  | 'gambling_betting.sports_betting'
  | 'gambling_betting.casino'
  | 'gaming'
  | 'gaming.mobile'
  | 'gaming.console_pc'
  | 'gaming.esports'
  | 'government_nonprofit'
  | 'government_nonprofit.political'
  | 'government_nonprofit.charity'
  | 'healthcare'
  | 'healthcare.pharmaceutical'
  | 'healthcare.medical_devices'
  | 'healthcare.wellness'
  | 'home_garden'
  | 'home_garden.furniture'
  | 'home_garden.home_improvement'
  | 'media_entertainment'
  | 'media_entertainment.podcasts'
  | 'media_entertainment.music'
  | 'media_entertainment.film_tv'
  | 'media_entertainment.publishing'
  | 'media_entertainment.live_events'
  | 'pets'
  | 'professional_services'
  | 'professional_services.legal'
  | 'professional_services.consulting'
  | 'real_estate'
  | 'real_estate.residential'
  | 'real_estate.commercial'
  | 'recruitment_hr'
  | 'retail'
  | 'retail.ecommerce'
  | 'retail.department_stores'
  | 'sports_fitness'
  | 'sports_fitness.equipment'
  | 'sports_fitness.teams_leagues'
  | 'technology'
  | 'technology.software'
  | 'technology.hardware'
  | 'technology.ai_ml'
  | 'telecom'
  | 'telecom.mobile_carriers'
  | 'telecom.internet_providers'
  | 'transportation_logistics'
  | 'travel_hospitality'
  | 'travel_hospitality.airlines'
  | 'travel_hospitality.hotels'
  | 'travel_hospitality.cruise'
  | 'travel_hospitality.tourism';


// enums/audience-source.json
/**
 * Origin of an audience segment in delivery reporting breakdowns. Only 'synced' audiences are directly targetable via the targeting overlay; other sources are informational.
 */
export type AudienceSource = 'synced' | 'platform' | 'third_party' | 'lookalike' | 'retargeting' | 'unknown';


// enums/brand-agent-type.json
/**
 * Functional roles for agents declared in brand.json. Each type represents a distinct capability that a brand or house can expose via an agent endpoint.
 */
export type BrandAgentType =
  | 'brand'
  | 'rights'
  | 'measurement'
  | 'governance'
  | 'creative'
  | 'sales'
  | 'buying'
  | 'signals';


// enums/budget-authority-level.json
/**
 * The level of autonomy an agent has over budget decisions within a campaign plan.
 */
export type BudgetAuthorityLevel = 'agent_full' | 'agent_limited' | 'human_required';


// enums/consent-basis.json
/**
 * Common GDPR lawful bases relevant to advertising. Covers the Article 6(1) bases used in programmatic advertising contexts.
 */
export type ConsentBasis = 'consent' | 'legitimate_interest' | 'contract' | 'legal_obligation';


// enums/creative-agent-capability.json
/**
 * Capabilities supported by creative agents for format handling
 */
export type CreativeAgentCapability = 'validation' | 'assembly' | 'generation' | 'preview' | 'delivery';


// enums/creative-approval-status.json
/**
 * Approval state of a creative on a specific package
 */
export type CreativeApprovalStatus = 'pending_review' | 'approved' | 'rejected';


// enums/creative-quality.json
/**
 * Quality tier for creative generation, controlling the fidelity and cost tradeoff
 */
export type CreativeQuality = 'draft' | 'production';


// enums/creative-sort-field.json
/**
 * Fields available for sorting creative library listings
 */
export type CreativeSortField = 'created_date' | 'updated_date' | 'name' | 'status' | 'assignment_count';


// enums/delegation-authority.json
/**
 * Authority level granted to a delegated agent operating against a campaign plan.
 */
export type DelegationAuthority = 'full' | 'execute_only' | 'propose_only';


// enums/error-code.json
/**
 * Standard error code vocabulary for AdCP. Codes are machine-readable so agents can apply autonomous recovery strategies based on the recovery classification. Sellers MAY return codes not listed here for platform-specific errors — the error.json code field accepts any string. Agents MUST handle unknown codes by falling back to the recovery classification.
 */
export type ErrorCode =
  | 'INVALID_REQUEST'
  | 'AUTH_REQUIRED'
  | 'RATE_LIMITED'
  | 'SERVICE_UNAVAILABLE'
  | 'POLICY_VIOLATION'
  | 'PRODUCT_NOT_FOUND'
  | 'PRODUCT_UNAVAILABLE'
  | 'PROPOSAL_EXPIRED'
  | 'BUDGET_TOO_LOW'
  | 'CREATIVE_REJECTED'
  | 'UNSUPPORTED_FEATURE'
  | 'AUDIENCE_TOO_SMALL'
  | 'ACCOUNT_NOT_FOUND'
  | 'ACCOUNT_SETUP_REQUIRED'
  | 'ACCOUNT_AMBIGUOUS'
  | 'ACCOUNT_PAYMENT_REQUIRED'
  | 'ACCOUNT_SUSPENDED'
  | 'COMPLIANCE_UNSATISFIED'
  | 'GOVERNANCE_DENIED'
  | 'BUDGET_EXHAUSTED'
  | 'BUDGET_EXCEEDED'
  | 'CONFLICT'
  | 'CREATIVE_DEADLINE_EXCEEDED'
  | 'INVALID_STATE'
  | 'MEDIA_BUY_NOT_FOUND'
  | 'NOT_CANCELLABLE'
  | 'PACKAGE_NOT_FOUND'
  | 'SESSION_NOT_FOUND'
  | 'SESSION_TERMINATED'
  | 'VALIDATION_ERROR'
  | 'PRODUCT_EXPIRED'
  | 'PROPOSAL_NOT_COMMITTED'
  | 'IO_REQUIRED'
  | 'TERMS_REJECTED'
  | 'VERSION_UNSUPPORTED';


// enums/escalation-severity.json
/**
 * The severity level of a governance escalation.
 */
export type EscalationSeverity = 'info' | 'warning' | 'critical';


// enums/forecastable-metric.json
/**
 * Standard delivery and engagement metric names for forecasts. For outcome/conversion forecasts (purchases, leads, app installs, etc.), use event-type enum values as metric keys instead. The ForecastPoint metrics map accepts any string key, so both forecastable-metric and event-type values can be used together.
 */
export type ForecastableMetric =
  | 'audience_size'
  | 'reach'
  | 'frequency'
  | 'impressions'
  | 'clicks'
  | 'spend'
  | 'views'
  | 'completed_views'
  | 'grps'
  | 'engagements'
  | 'follows'
  | 'saves'
  | 'profile_visits'
  | 'measured_impressions'
  | 'downloads'
  | 'plays';


// enums/frequency-cap-scope.json
/**
 * Scope for frequency cap application
 */
export type FrequencyCapScope = 'package';


// enums/governance-domain.json
/**
 * Governance sub-domains that a registry policy applies to. Used to indicate which types of governance agents can evaluate this policy.
 */
export type GovernanceDomain = 'campaign' | 'property' | 'creative' | 'content_standards';


// enums/governance-mode.json
/**
 * Operating mode for a governance agent. Controls whether findings block execution.
 */
export type GovernanceMode = 'audit' | 'advisory' | 'enforce';


// enums/governance-phase.json
/**
 * The phase of the governed action's lifecycle that triggered the governance check.
 */
export type GovernancePhase = 'purchase' | 'modification' | 'delivery';


// enums/history-entry-type.json
/**
 * Type of entry in task execution history
 */
export type HistoryEntryType = 'request' | 'response';


// enums/match-id-type.json
/**
 * Identifier types for audience match reporting. Combines hashed PII types (from audience-member.json field names) with universal ID types (from uid-type.json).
 */
export type MatchIDType =
  | 'hashed_email'
  | 'hashed_phone'
  | 'rampid'
  | 'id5'
  | 'uid2'
  | 'euid'
  | 'pairid'
  | 'maid'
  | 'other';


// enums/notification-type.json
/**
 * Type of delivery notification for media buy reporting
 */
export type NotificationType = 'scheduled' | 'final' | 'delayed' | 'adjusted';


// enums/outcome-type.json
/**
 * The type of outcome reported to a campaign governance agent after a seller interaction.
 */
export type OutcomeType = 'completed' | 'failed' | 'delivery';


// enums/policy-category.json
/**
 * The nature of the obligation a policy represents.
 */
export type PolicyCategory = 'regulation' | 'standard';


// enums/policy-enforcement.json
/**
 * How governance agents treat violations of a policy. Uses RFC 2119 keywords.
 */
export type PolicyEnforcementLevel = 'must' | 'should' | 'may';


// enums/preview-output-format.json
/**
 * Output format for creative previews
 */
export type PreviewOutputFormat = 'url' | 'html';


// enums/publisher-identifier-types.json
/**
 * Valid identifier types for publisher/legal entity identification
 */
export type PublisherIdentifierTypes = 'tag_id' | 'duns' | 'lei' | 'seller_id' | 'gln';


// enums/purchase-type.json
/**
 * The type of financial commitment being governed.
 */
export type PurchaseType = 'media_buy' | 'rights_license' | 'signal_activation' | 'creative_services';


// enums/si-session-status.json
/**
 * State of a Sponsored Intelligence session between a host and a brand agent
 */
export type SISessionStatus = 'active' | 'pending_handoff' | 'complete' | 'terminated';


// enums/signal-source.json
/**
 * Source type for signal identifiers. Determines how the signal is referenced and whether authorization can be externally verified.
 */
export type SignalSource = 'catalog' | 'agent';


// enums/sort-direction.json
/**
 * Sort direction for list queries
 */
export type SortDirection = 'asc' | 'desc';


// enums/sort-metric.json
/**
 * Numeric delivery metrics available for sorting breakdown rows. Subset of delivery-metrics fields that are flat numeric values (excludes nested objects like quartile_data, dooh_metrics, viewability, by_event_type, by_action_source).
 */
export type SortMetric =
  | 'impressions'
  | 'spend'
  | 'clicks'
  | 'ctr'
  | 'views'
  | 'completed_views'
  | 'completion_rate'
  | 'conversions'
  | 'conversion_value'
  | 'roas'
  | 'cost_per_acquisition'
  | 'new_to_brand_rate'
  | 'leads'
  | 'grps'
  | 'reach'
  | 'frequency'
  | 'engagements'
  | 'follows'
  | 'saves'
  | 'profile_visits'
  | 'engagement_rate'
  | 'cost_per_click';


// enums/validation-mode.json
/**
 * Creative validation strictness levels
 */
export type ValidationMode = 'strict' | 'lenient';


// extensions/extension-meta.json
/**
 * Schema that all extension files must follow. Combines metadata (valid_from, docs_url) with the actual extension data schema. Extensions are auto-discovered from /schemas/extensions/*.json and included in versioned builds based on valid_from/valid_until.
 */
export interface AdCPExtensionFileSchema {
  $schema: 'http://json-schema.org/draft-07/schema#';
  /**
   * Extension ID following pattern /schemas/extensions/{namespace}.json
   */
  $id: string;
  /**
   * Human-readable title for the extension
   */
  title: string;
  /**
   * Description of what this extension provides
   */
  description: string;
  /**
   * Minimum AdCP version this extension is compatible with (e.g., '2.5'). Extension will be included in all versioned schema builds >= this version.
   */
  valid_from: string;
  /**
   * Last AdCP version this extension is compatible with (e.g., '3.0'). Omit if extension is still valid for current and future versions.
   */
  valid_until?: string;
  /**
   * URL to documentation for implementors of this extension
   */
  docs_url?: string;
  /**
   * Extensions must be objects (data within ext.{namespace})
   */
  type: 'object';
  /**
   * Schema properties defining the structure of ext.{namespace} data
   */
  properties: {};
  /**
   * Required properties within the extension data
   */
  required?: string[];
  /**
   * Whether additional properties are allowed in the extension data
   */
  additionalProperties?: {
    [k: string]: unknown | undefined;
  };
}


// governance/audience-constraints.json
/**
 * Buyer-defined audience targeting constraints for a campaign plan. Specifies who the campaign should and should not reach. The governance agent evaluates seller targeting against these constraints during check_governance.
 */
export interface AudienceConstraints {
  /**
   * Desired audience criteria. The seller's targeting should align with these. Each criterion is evaluated independently — the combined targeting should satisfy at least one inclusion criterion.
   */
  include?: AudienceSelector[];
  /**
   * Excluded audience criteria. The seller's targeting must not overlap with these. Exclusions take precedence over inclusions. Used for protected groups, vulnerable communities, regulatory restrictions, or brand safety.
   */
  exclude?: AudienceSelector[];
}


// governance/policy-entry.json
/**
 * A complete policy in the policy registry. Policies use natural language text evaluated by governance agents (LLMs), following the same pattern as Content Standards. The registry's value is in structured metadata (jurisdiction, policy category, source, enforcement level) and calibration exemplars.
 */
export interface PolicyEntry {
  /**
   * Unique identifier for this policy (e.g., "uk_hfss", "us_coppa", "alcohol_advertising").
   */
  policy_id: string;
  /**
   * Semver version string (e.g., "1.0.0"). Incremented when policy content changes.
   */
  version: string;
  /**
   * Human-readable name (e.g., "UK HFSS Restrictions").
   */
  name: string;
  /**
   * Brief summary of what this policy covers.
   */
  description?: string;
  category: PolicyCategory;
  enforcement: PolicyEnforcementLevel;
  /**
   * ISO 3166-1 alpha-2 country codes where this policy applies. Empty array means the policy is not jurisdiction-specific.
   */
  jurisdictions?: string[];
  /**
   * Named groups of jurisdictions for convenience (e.g., {"EU": ["AT","BE","BG",...]}). Governance agents expand aliases when matching against a plan's target jurisdictions.
   */
  region_aliases?: {
    [k: string]: string[] | undefined;
  };
  /**
   * Regulatory categories this policy belongs to (e.g., ["children_directed", "age_restricted"]). Used for automatic matching against a campaign plan's declared policy_categories. A single policy can belong to multiple categories.
   */
  policy_categories?: string[];
  /**
   * Advertising channels this policy applies to. If omitted or null, the policy applies to all channels.
   */
  channels?: MediaChannel[];
  /**
   * Governance sub-domains this policy applies to. Determines which types of governance agents can declare registry:{policy_id} features. For example, a policy with domains ["creative", "property"] can be declared as a feature by both creative and property governance agents.
   */
  governance_domains?: GovernanceDomain[];
  /**
   * ISO 8601 date when the regulation or standard takes effect. Before this date, governance agents treat the policy as informational (evaluate but do not block). After this date, the policy is enforced at its declared enforcement level.
   */
  effective_date?: string;
  /**
   * ISO 8601 date when the regulation or standard is no longer enforced. After this date, governance agents stop evaluating this policy. Omit if the policy has no expiration.
   */
  sunset_date?: string;
  /**
   * Link to the source regulation, standard, or legislation.
   */
  source_url?: string;
  /**
   * Name of the issuing body (e.g., "UK Food Standards Agency", "US Federal Trade Commission").
   */
  source_name?: string;
  /**
   * Natural language policy text describing what is required, prohibited, or recommended. Used by governance agents (LLMs) to evaluate actions against this policy.
   */
  policy: string;
  /**
   * Implementation notes for governance agent developers. Not used in evaluation prompts.
   */
  guidance?: string;
  /**
   * Calibration examples for governance agents, following the Content Standards pattern.
   */
  exemplars?: {
    /**
     * Scenarios that comply with this policy.
     */
    pass?: Exemplar[];
    /**
     * Scenarios that violate this policy.
     */
    fail?: Exemplar[];
  };
  ext?: ExtensionObject;
}
export interface Exemplar {
  /**
   * A concrete scenario describing an advertising action or configuration.
   */
  scenario: string;
  /**
   * Why this scenario passes or fails the policy.
   */
  explanation: string;
}

// governance/policy-ref.json
/**
 * A reference to a policy in the policy registry. Used in brand compliance configurations to declare which registry policies apply.
 */
export interface PolicyReference {
  /**
   * The unique identifier of the policy in the registry (e.g., "uk_hfss", "us_coppa").
   */
  policy_id: string;
  /**
   * Pin a specific policy version (semver). If omitted, the current version is used.
   */
  version?: string;
  /**
   * Brand-specific parameter overrides for configurable policies. The accepted shape depends on the policy's config_schema.
   */
  config?: {};
}


// media-buy/package-update.json
/**
 * Package update configuration for update_media_buy. Identifies package by package_id and specifies fields to modify. Fields not present are left unchanged. Note: product_id, format_ids, and pricing_option_id cannot be changed after creation.
 */
export interface PackageUpdate {
  /**
   * Seller's ID of package to update
   */
  package_id: string;
  /**
   * Updated budget allocation for this package in the currency specified by the pricing option
   */
  budget?: number;
  pacing?: Pacing;
  /**
   * Updated bid price for auction-based pricing options. This is the exact bid/price to honor unless selected pricing_option has max_bid=true, in which case bid_price is the buyer's maximum willingness to pay (ceiling).
   */
  bid_price?: number;
  /**
   * Updated impression goal for this package
   */
  impressions?: number;
  /**
   * Updated flight start date/time for this package in ISO 8601 format. Must fall within the media buy's date range.
   */
  start_time?: string;
  /**
   * Updated flight end date/time for this package in ISO 8601 format. Must fall within the media buy's date range.
   */
  end_time?: string;
  /**
   * Pause/resume specific package (true = paused, false = active)
   */
  paused?: boolean;
  /**
   * Cancel this specific package. Cancellation is irreversible — canceled packages stop delivery and cannot be reactivated. Sellers MAY reject with NOT_CANCELLABLE.
   */
  canceled?: true;
  /**
   * Reason for canceling this package.
   */
  cancellation_reason?: string;
  /**
   * Replace the catalogs this package promotes. Uses replacement semantics — the provided array replaces the current list. Omit to leave catalogs unchanged.
   */
  catalogs?: Catalog[];
  /**
   * Replace all optimization goals for this package. Uses replacement semantics — omit to leave goals unchanged.
   */
  optimization_goals?: OptimizationGoal[];
  targeting_overlay?: TargetingOverlay;
  /**
   * Keyword targets to add or update on this package. Upserts by (keyword, match_type) identity: if the pair already exists, its bid_price is updated; if not, a new keyword target is added. Use targeting_overlay.keyword_targets in create_media_buy to set the initial list.
   */
  keyword_targets_add?: {
    /**
     * The keyword to target
     */
    keyword: string;
    /**
     * Match type for this keyword
     */
    match_type: 'broad' | 'phrase' | 'exact';
    /**
     * Per-keyword bid price. Inherits currency and max_bid interpretation from the package's pricing option.
     */
    bid_price?: number;
  }[];
  /**
   * Keyword targets to remove from this package. Removes matching (keyword, match_type) pairs. If a specified pair is not present, sellers SHOULD treat it as a no-op for that entry.
   */
  keyword_targets_remove?: {
    /**
     * The keyword to stop targeting
     */
    keyword: string;
    /**
     * Match type to remove
     */
    match_type: 'broad' | 'phrase' | 'exact';
  }[];
  /**
   * Negative keywords to add to this package. Appends to the existing negative keyword list — does not replace it. If a keyword+match_type pair already exists, sellers SHOULD treat it as a no-op for that entry. Use targeting_overlay.negative_keywords in create_media_buy to set the initial list.
   */
  negative_keywords_add?: {
    /**
     * The keyword to exclude
     */
    keyword: string;
    /**
     * Match type for exclusion
     */
    match_type: 'broad' | 'phrase' | 'exact';
  }[];
  /**
   * Negative keywords to remove from this package. Removes matching keyword+match_type pairs from the existing list. If a specified pair is not present, sellers SHOULD treat it as a no-op for that entry.
   */
  negative_keywords_remove?: {
    /**
     * The keyword to stop excluding
     */
    keyword: string;
    /**
     * Match type to remove
     */
    match_type: 'broad' | 'phrase' | 'exact';
  }[];
  /**
   * Replace creative assignments for this package with optional weights and placement targeting. Uses replacement semantics - omit to leave assignments unchanged.
   */
  creative_assignments?: CreativeAssignment[];
  /**
   * Upload new creative assets and assign to this package (creatives will be added to library). Use creative_assignments instead for existing library creatives.
   */
  creatives?: CreativeAsset[];
  context?: ContextObject;
  ext?: ExtensionObject;
}

// property/base-property-source.json
/**
 * A source of properties for a property list. Supports three selection patterns: publisher with tags, publisher with property IDs, or direct identifiers.
 */
export type BasePropertySource = PublisherTagsSource | PublisherPropertyIDsSource | DirectIdentifiersSource;
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
   */
  tags: PropertyTag[];
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
   */
  property_ids: PropertyID[];
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
   */
  identifiers: Identifier[];
}

// property/feature-requirement.json
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
   */
  allowed_values?: unknown[];
  /**
   * How to handle properties where this feature is not covered. 'exclude' (default): property is removed from the list. 'include': property passes this requirement (fail-open).
   */
  if_not_covered?: 'exclude' | 'include';
}


// property/property-error.json
/**
 * Error information for a property that could not be evaluated
 */
export interface PropertyError {
  /**
   * Error code
   */
  code:
    | 'PROPERTY_NOT_FOUND'
    | 'PROPERTY_NOT_MONITORED'
    | 'LIST_NOT_FOUND'
    | 'LIST_ACCESS_DENIED'
    | 'METHODOLOGY_NOT_SUPPORTED'
    | 'JURISDICTION_NOT_SUPPORTED';
  property?: Property;
  /**
   * Human-readable error message
   */
  message: string;
}

// property/property-feature-definition.json
/**
 * Defines a feature that a governance agent can evaluate for properties. Used in get_adcp_capabilities to advertise agent capabilities.
 */
export interface PropertyFeatureDefinition {
  /**
   * Unique identifier for this feature (e.g., 'consent_quality', 'carbon_score'). Features prefixed with 'registry:' reference standardized policies from the shared policy registry (e.g., 'registry:us_coppa', 'registry:uk_hfss'). Unprefixed feature IDs are agent-defined.
   */
  feature_id: string;
  /**
   * Human-readable name for the feature
   */
  name: string;
  /**
   * Description of what this feature measures or represents
   */
  description?: string;
  /**
   * The type of values this feature produces: binary (true/false), quantitative (numeric range), categorical (enumerated values)
   */
  type: 'binary' | 'quantitative' | 'categorical';
  /**
   * For quantitative features, the valid range of values
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
   * For categorical features, the set of valid values
   */
  allowed_values?: string[];
  /**
   * What this feature covers (empty arrays = all)
   */
  coverage?: {
    /**
     * Property types this feature applies to
     */
    property_types?: string[];
    /**
     * Countries where this feature is available
     */
    countries?: string[];
  };
  /**
   * URL to documentation explaining how this feature is calculated/measured
   */
  methodology_url: string;
  /**
   * Version identifier for the methodology (for audit trails)
   */
  methodology_version?: string;
  ext?: ExtensionObject;
}

// property/property-feature.json
/**
 * A discrete feature assessment for a property (e.g., from app store privacy labels)
 */
export interface PropertyFeature {
  /**
   * Identifier for the feature being assessed
   */
  feature_id: string;
  /**
   * The feature value
   */
  value: string;
  /**
   * Source of the feature data (e.g., app_store_privacy_label, tcf_string)
   */
  source?: string;
}


// property/property-list-changed-webhook.json
/**
 * Webhook notification sent when a property list's resolved properties change. Contains a summary only - recipients must call get_property_list to retrieve the updated properties. This keeps payloads small and avoids redundant data transfer.
 */
export interface PropertyListChangedWebhook {
  /**
   * The event type
   */
  event: 'property_list_changed';
  /**
   * ID of the property list that changed
   */
  list_id: string;
  /**
   * Name of the property list
   */
  list_name?: string;
  /**
   * Summary of changes to the resolved list
   */
  change_summary?: {
    /**
     * Number of properties added since last resolution
     */
    properties_added?: number;
    /**
     * Number of properties removed since last resolution
     */
    properties_removed?: number;
    /**
     * Total properties in the resolved list
     */
    total_properties?: number;
  };
  /**
   * When the list was re-resolved
   */
  resolved_at: string;
  /**
   * When the consumer should refresh from the governance agent
   */
  cache_valid_until?: string;
  /**
   * Cryptographic signature of the webhook payload, signed with the agent's private key. Recipients MUST verify this signature.
   */
  signature: string;
  ext?: ExtensionObject;
}

// property/property-list-filters.json
/**
 * Filters that dynamically modify a property list when resolved
 */
export interface PropertyListFilters {
  /**
   * Property must have feature data for ALL listed countries (ISO codes). When omitted, no country restriction is applied.
   */
  countries_all?: string[];
  /**
   * Property must support ANY of the listed channels. When omitted, no channel restriction is applied.
   */
  channels_any?: MediaChannel[];
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

// property/property-list.json
/**
 * A managed property list with optional filters for dynamic evaluation. Lists are resolved at setup time and cached by orchestrators/sellers for real-time use.
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
  /**
   * Pricing options for this property list. Present when the requesting account has a billing relationship with the list provider. The buyer passes the selected pricing_option_id in report_usage.
   */
  pricing_options?: VendorPricingOption[];
}

// sponsored-intelligence/si-capabilities.json
/**
 * Capabilities that a brand agent declares or a host supports
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
        };
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
    extensions?: {};
  };
  /**
   * Commerce capabilities
   */
  commerce?: {
    /**
     * Supports ACP (Agentic Commerce Protocol) checkout handoff
     */
    acp_checkout?: boolean;
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
  };
  /**
   * Supports MCP Apps for rendering A2UI surfaces in iframes
   */
  mcp_apps?: boolean;
}


// sponsored-intelligence/si-identity.json
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
    };
  };
  /**
   * Session ID for anonymous users (when consent_granted is false)
   */
  anonymous_session_id?: string;
}


// sponsored-intelligence/si-ui-element.json
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
  data?: {};
};

