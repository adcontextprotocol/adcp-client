// Generated const-array enum exports for AdCP string-literal unions
// Generated at: 2026-04-25T01:18:01.027Z
// Sources:
//   - core.generated.ts (core types)
//   - tools.generated.ts (tool types)
//
// Every `export type Name = 'a' | 'b' | 'c'` in the generated TypeScript
// has a corresponding `export const NameValues = ['a', 'b', 'c'] as const`
// here. Use these when you need to enumerate, filter, or validate against
// the spec's literal sets — e.g.:
//
//   import { MediaChannelValues } from '@adcp/client/types';
//   const channels = new Set<string>(MediaChannelValues);
//   if (!channels.has(input)) throw new Error('unknown channel');

// ====== CORE ENUMS ======

export const AccountStatusValues = ["active", "pending_approval", "rejected", "payment_required", "suspended", "closed"] as const;
export const ActionSourceValues = ["website", "app", "offline", "phone_call", "chat", "email", "in_store", "system_generated", "other"] as const;
export const AdCPProtocolValues = ["media-buy", "signals", "governance", "creative", "brand", "sponsored-intelligence"] as const;
export const AdCPSpecialismValues = ["audience-sync", "brand-rights", "collection-lists", "content-standards", "creative-ad-server", "creative-generative", "creative-template", "governance-aware-seller", "governance-delivery-monitor", "governance-spend-authority", "property-lists", "sales-broadcast-tv", "sales-catalog-driven", "sales-guaranteed", "sales-non-guaranteed", "sales-proposal-mode", "sales-social", "signal-marketplace", "signal-owned", "signed-requests"] as const;
export const AdvertiserIndustryValues = ["automotive", "automotive.electric_vehicles", "automotive.parts_accessories", "automotive.luxury", "beauty_cosmetics", "beauty_cosmetics.skincare", "beauty_cosmetics.fragrance", "beauty_cosmetics.haircare", "cannabis", "cpg", "cpg.personal_care", "cpg.household", "dating", "education", "education.higher_education", "education.online_learning", "education.k12", "energy_utilities", "energy_utilities.renewable", "fashion_apparel", "fashion_apparel.luxury", "fashion_apparel.sportswear", "finance", "finance.banking", "finance.insurance", "finance.investment", "finance.cryptocurrency", "food_beverage", "food_beverage.alcohol", "food_beverage.restaurants", "food_beverage.packaged_goods", "gambling_betting", "gambling_betting.sports_betting", "gambling_betting.casino", "gaming", "gaming.mobile", "gaming.console_pc", "gaming.esports", "government_nonprofit", "government_nonprofit.political", "government_nonprofit.charity", "healthcare", "healthcare.pharmaceutical", "healthcare.medical_devices", "healthcare.wellness", "home_garden", "home_garden.furniture", "home_garden.home_improvement", "media_entertainment", "media_entertainment.podcasts", "media_entertainment.music", "media_entertainment.film_tv", "media_entertainment.publishing", "media_entertainment.live_events", "pets", "professional_services", "professional_services.legal", "professional_services.consulting", "real_estate", "real_estate.residential", "real_estate.commercial", "recruitment_hr", "retail", "retail.ecommerce", "retail.department_stores", "sports_fitness", "sports_fitness.equipment", "sports_fitness.teams_leagues", "technology", "technology.software", "technology.hardware", "technology.ai_ml", "telecom", "telecom.mobile_carriers", "telecom.internet_providers", "transportation_logistics", "travel_hospitality", "travel_hospitality.airlines", "travel_hospitality.hotels", "travel_hospitality.cruise", "travel_hospitality.tourism"] as const;
export const AgeVerificationMethodValues = ["facial_age_estimation", "id_document", "digital_id", "credit_card", "world_id"] as const;
export const AgeVerificationMethod1Values = ["facial_age_estimation", "id_document", "digital_id", "credit_card", "world_id"] as const;
export const AssessmentStatusValues = ["insufficient", "minimum", "good", "excellent"] as const;
export const AssetContentTypeValues = ["image", "video", "audio", "text", "markdown", "html", "css", "javascript", "vast", "daast", "url", "webhook", "brief", "catalog"] as const;
export const AttributionModelValues = ["last_touch", "first_touch", "linear", "time_decay", "data_driven"] as const;
export const AudienceSourceValues = ["synced", "platform", "third_party", "lookalike", "retargeting", "unknown"] as const;
export const AudienceStatusValues = ["processing", "ready", "too_small"] as const;
export const AuthenticationSchemeValues = ["Bearer", "HMAC-SHA256"] as const;
export const AvailableMetricValues = ["impressions", "spend", "clicks", "ctr", "video_completions", "completion_rate", "conversions", "conversion_value", "roas", "cost_per_acquisition", "new_to_brand_rate", "viewability", "engagement_rate", "views", "completed_views", "leads", "reach", "frequency", "grps", "quartile_data", "dooh_metrics", "cost_per_click"] as const;
export const BrandAgentTypeValues = ["brand", "rights", "measurement", "governance", "creative", "sales", "buying", "signals"] as const;
export const CanceledByValues = ["buyer", "seller"] as const;
export const CatalogActionValues = ["created", "updated", "unchanged", "failed", "deleted"] as const;
export const CatalogItemStatusValues = ["approved", "pending", "rejected", "warning"] as const;
export const CatalogTypeValues = ["offering", "product", "inventory", "store", "promotion", "hotel", "flight", "job", "vehicle", "real_estate", "education", "destination", "app"] as const;
export const CloudStorageProtocolValues = ["s3", "gcs", "azure_blob"] as const;
export const CoBrandingRequirementValues = ["required", "optional", "none"] as const;
export const CollectionCadenceValues = ["daily", "weekly", "monthly", "seasonal", "event", "irregular"] as const;
export const CollectionRelationshipValues = ["spinoff", "companion", "sequel", "prequel", "crossover"] as const;
export const CollectionStatusValues = ["active", "hiatus", "ended", "upcoming"] as const;
export const ConsentBasisValues = ["consent", "legitimate_interest", "contract", "legal_obligation"] as const;
export const ContentIDTypeValues = ["sku", "gtin", "offering_id", "job_id", "hotel_id", "flight_id", "vehicle_id", "listing_id", "store_id", "program_id", "destination_id", "app_id"] as const;
export const ContentRatingSystemValues = ["tv_parental", "mpaa", "podcast", "esrb", "bbfc", "fsk", "acb", "chvrs", "csa", "pegi", "custom"] as const;
export const CreativeActionValues = ["created", "updated", "unchanged", "failed", "deleted"] as const;
export const CreativeAgentCapabilityValues = ["validation", "assembly", "generation", "preview", "delivery"] as const;
export const CreativeApprovalStatusValues = ["pending_review", "approved", "rejected"] as const;
export const CreativeIdentifierTypeValues = ["ad_id", "isci", "clearcast_clock"] as const;
export const CreativeQualityValues = ["draft", "production"] as const;
export const CreativeSortFieldValues = ["created_date", "updated_date", "name", "status", "assignment_count"] as const;
export const CreativeStatusValues = ["processing", "pending_review", "approved", "rejected", "archived"] as const;
export const DAASTTrackingEventValues = ["impression", "creativeView", "loaded", "start", "firstQuartile", "midpoint", "thirdQuartile", "complete", "mute", "unmute", "pause", "resume", "skip", "progress", "clickTracking", "customClick", "close", "error", "viewable", "notViewable", "viewUndetermined", "measurableImpression", "viewableImpression"] as const;
export const DAASTVersionValues = ["1.0", "1.1"] as const;
export const DayOfWeekValues = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;
export const DelegationAuthorityValues = ["full", "execute_only", "propose_only"] as const;
export const DeliveryTypeValues = ["guaranteed", "non_guaranteed"] as const;
export const DemographicSystemValues = ["nielsen", "barb", "agf", "oztam", "mediametrie", "custom"] as const;
export const DerivativeTypeValues = ["clip", "highlight", "recap", "trailer", "bonus"] as const;
export const DevicePlatformValues = ["ios", "android", "windows", "macos", "linux", "chromeos", "tvos", "tizen", "webos", "fire_os", "roku_os", "unknown"] as const;
export const DeviceTypeValues = ["desktop", "mobile", "tablet", "ctv", "dooh", "unknown"] as const;
export const DigitalSourceTypeValues = ["digital_capture", "digital_creation", "trained_algorithmic_media", "composite_with_trained_algorithmic_media", "algorithmic_media", "composite_capture", "composite_synthetic", "human_edits", "data_driven_media"] as const;
export const DimensionUnitValues = ["px", "dp", "inches", "cm", "mm", "pt"] as const;
export const DisclosurePersistenceValues = ["continuous", "initial", "flexible"] as const;
export const DisclosurePositionValues = ["prominent", "footer", "audio", "subtitle", "overlay", "end_card", "pre_roll", "companion"] as const;
export const DistanceUnitValues = ["km", "mi", "m"] as const;
export const DistributionIdentifierTypeValues = ["apple_podcast_id", "spotify_collection_id", "rss_url", "podcast_guid", "amazon_music_id", "iheart_id", "podcast_index_id", "youtube_channel_id", "youtube_playlist_id", "amazon_title_id", "roku_channel_id", "pluto_channel_id", "tubi_id", "peacock_id", "tiktok_id", "twitch_channel", "imdb_id", "gracenote_id", "eidr_id", "domain", "substack_id"] as const;
export const ErrorCodeValues = ["INVALID_REQUEST", "AUTH_REQUIRED", "RATE_LIMITED", "SERVICE_UNAVAILABLE", "POLICY_VIOLATION", "PRODUCT_NOT_FOUND", "PRODUCT_UNAVAILABLE", "PROPOSAL_EXPIRED", "BUDGET_TOO_LOW", "CREATIVE_REJECTED", "UNSUPPORTED_FEATURE", "AUDIENCE_TOO_SMALL", "ACCOUNT_NOT_FOUND", "ACCOUNT_SETUP_REQUIRED", "ACCOUNT_AMBIGUOUS", "ACCOUNT_PAYMENT_REQUIRED", "ACCOUNT_SUSPENDED", "COMPLIANCE_UNSATISFIED", "GOVERNANCE_DENIED", "BUDGET_EXHAUSTED", "BUDGET_EXCEEDED", "CONFLICT", "IDEMPOTENCY_CONFLICT", "IDEMPOTENCY_EXPIRED", "CREATIVE_DEADLINE_EXCEEDED", "INVALID_STATE", "MEDIA_BUY_NOT_FOUND", "NOT_CANCELLABLE", "PACKAGE_NOT_FOUND", "CREATIVE_NOT_FOUND", "SIGNAL_NOT_FOUND", "SESSION_NOT_FOUND", "PLAN_NOT_FOUND", "REFERENCE_NOT_FOUND", "SESSION_TERMINATED", "VALIDATION_ERROR", "PRODUCT_EXPIRED", "PROPOSAL_NOT_COMMITTED", "IO_REQUIRED", "TERMS_REJECTED", "REQUOTE_REQUIRED", "VERSION_UNSUPPORTED", "CAMPAIGN_SUSPENDED", "GOVERNANCE_UNAVAILABLE", "PERMISSION_DENIED"] as const;
export const EscalationSeverityValues = ["info", "warning", "critical"] as const;
export const EventTypeValues = ["page_view", "view_content", "select_content", "select_item", "search", "share", "add_to_cart", "remove_from_cart", "viewed_cart", "add_to_wishlist", "initiate_checkout", "add_payment_info", "purchase", "refund", "lead", "qualify_lead", "close_convert_lead", "disqualify_lead", "complete_registration", "subscribe", "start_trial", "app_install", "app_launch", "contact", "schedule", "donate", "submit_application", "custom"] as const;
export const ExclusivityValues = ["none", "category", "exclusive"] as const;
export const FeedbackSourceValues = ["buyer_attribution", "third_party_measurement", "platform_analytics", "verification_partner"] as const;
export const FeedFormatValues = ["google_merchant_center", "facebook_catalog", "shopify", "linkedin_jobs", "custom"] as const;
export const ForecastableMetricValues = ["audience_size", "reach", "frequency", "impressions", "clicks", "spend", "views", "completed_views", "grps", "engagements", "follows", "saves", "profile_visits", "measured_impressions", "downloads", "plays"] as const;
export const ForecastMethodValues = ["estimate", "modeled", "guaranteed"] as const;
export const ForecastRangeUnitValues = ["spend", "availability", "reach_freq", "weekly", "daily", "clicks", "conversions", "package"] as const;
export const FormatIDParameterValues = ["dimensions", "duration"] as const;
export const FrequencyCapScopeValues = ["package"] as const;
export const GenreTaxonomyValues = ["iab_content_3.0", "iab_content_2.2", "gracenote", "eidr", "apple_genres", "google_genres", "roku", "amazon_genres", "custom"] as const;
export const GeographicTargetingLevelValues = ["country", "region", "metro", "postal_area"] as const;
export const GovernanceDomainValues = ["campaign", "property", "creative", "content_standards"] as const;
export const GovernanceModeValues = ["audit", "advisory", "enforce"] as const;
export const GovernancePhaseValues = ["purchase", "modification", "delivery"] as const;
export const HistoryEntryTypeValues = ["request", "response"] as const;
export const HTTPMethodValues = ["GET", "POST"] as const;
export const InstallmentStatusValues = ["scheduled", "tentative", "live", "postponed", "cancelled", "aired", "published"] as const;
export const JavaScriptModuleTypeValues = ["esm", "commonjs", "script"] as const;
export const LandingPageRequirementValues = ["any", "retailer_site_only", "must_include_retailer"] as const;
export const MakegoodRemedyValues = ["additional_delivery", "credit", "invoice_adjustment"] as const;
export const MarkdownFlavorValues = ["commonmark", "gfm"] as const;
export const MatchIDTypeValues = ["hashed_email", "hashed_phone", "rampid", "id5", "uid2", "euid", "pairid", "maid", "other"] as const;
export const MediaBuyStatusValues = ["pending_creatives", "pending_start", "active", "paused", "completed", "rejected", "canceled"] as const;
export const MediaChannelValues = ["display", "olv", "social", "search", "ctv", "linear_tv", "radio", "streaming_audio", "podcast", "dooh", "ooh", "print", "cinema", "email", "gaming", "retail_media", "influencer", "affiliate", "product_placement", "sponsored_intelligence"] as const;
export const MetricTypeValues = ["overall_performance", "conversion_rate", "brand_lift", "click_through_rate", "completion_rate", "viewability", "brand_safety", "cost_efficiency"] as const;
export const MetroAreaSystemValues = ["nielsen_dma", "uk_itl1", "uk_itl2", "eurostat_nuts2", "custom"] as const;
export const NotificationTypeValues = ["scheduled", "final", "delayed", "adjusted"] as const;
export const OutcomeTypeValues = ["completed", "failed", "delivery"] as const;
export const PacingValues = ["even", "asap", "front_loaded"] as const;
export const PerformanceStandardMetricValues = ["viewability", "ivt", "completion_rate", "brand_safety", "attention_score"] as const;
export const PolicyCategoryValues = ["regulation", "standard"] as const;
export const PolicyEnforcementLevelValues = ["must", "should", "may"] as const;
export const PostalCodeSystemValues = ["us_zip", "us_zip_plus_four", "gb_outward", "gb_full", "ca_fsa", "ca_full", "de_plz", "fr_code_postal", "au_postcode", "ch_plz", "at_plz"] as const;
export const PreviewOutputFormatValues = ["url", "html"] as const;
export const PriceAdjustmentKindValues = ["fee", "discount", "commission", "settlement"] as const;
export const PricingModelValues = ["cpm", "vcpm", "cpc", "cpcv", "cpv", "cpp", "cpa", "flat_rate", "time"] as const;
export const ProductionQualityValues = ["professional", "prosumer", "ugc"] as const;
export const PropertyIdentifierTypesValues = ["domain", "subdomain", "network_id", "ios_bundle", "android_package", "apple_app_store_id", "google_play_id", "roku_store_id", "fire_tv_asin", "samsung_app_id", "apple_tv_bundle", "bundle_id", "venue_id", "screen_id", "openooh_venue_type", "rss_url", "apple_podcast_id", "spotify_collection_id", "podcast_guid", "station_id", "facility_id"] as const;
export const PropertyTypeValues = ["website", "mobile_app", "ctv_app", "desktop_app", "dooh", "podcast", "radio", "linear_tv", "streaming_audio", "ai_assistant"] as const;
export const ProposalStatusValues = ["draft", "committed"] as const;
export const PublisherIdentifierTypesValues = ["tag_id", "duns", "lei", "seller_id", "gln"] as const;
export const PurchaseTypeValues = ["media_buy", "rights_license", "signal_activation", "creative_services"] as const;
export const ReachUnitValues = ["individuals", "households", "devices", "accounts", "cookies", "custom"] as const;
export const ReportingFrequencyValues = ["hourly", "daily", "monthly"] as const;
export const RestrictedAttributeValues = ["racial_ethnic_origin", "political_opinions", "religious_beliefs", "trade_union_membership", "health_data", "sex_life_sexual_orientation", "genetic_data", "biometric_data", "age", "familial_status"] as const;
export const RightTypeValues = ["talent", "character", "brand_ip", "music", "stock_media"] as const;
export const RightUseValues = ["likeness", "voice", "name", "endorsement", "motion_capture", "signature", "catchphrase", "sync", "background_music", "editorial", "commercial", "ai_generated_image"] as const;
export const SignalCatalogTypeValues = ["marketplace", "custom", "owned"] as const;
export const SignalSourceValues = ["catalog", "agent"] as const;
export const SignalValueTypeValues = ["binary", "categorical", "numeric"] as const;
export const SISessionStatusValues = ["active", "pending_handoff", "complete", "terminated"] as const;
export const SortDirectionValues = ["asc", "desc"] as const;
export const SortMetricValues = ["impressions", "spend", "clicks", "ctr", "views", "completed_views", "completion_rate", "conversions", "conversion_value", "roas", "cost_per_acquisition", "new_to_brand_rate", "leads", "grps", "reach", "frequency", "engagements", "follows", "saves", "profile_visits", "engagement_rate", "cost_per_click"] as const;
export const SpecialCategoryValues = ["awards", "championship", "concert", "conference", "election", "festival", "gala", "holiday", "premiere", "product_launch", "reunion", "tribute"] as const;
export const TalentRoleValues = ["host", "guest", "creator", "cast", "narrator", "producer", "correspondent", "commentator", "analyst"] as const;
export const TaskStatusValues = ["submitted", "working", "input-required", "completed", "canceled", "failed", "rejected", "auth-required", "unknown"] as const;
export const TaskTypeValues = ["create_media_buy", "update_media_buy", "sync_creatives", "activate_signal", "get_signals", "create_property_list", "update_property_list", "get_property_list", "list_property_lists", "delete_property_list", "sync_accounts", "get_account_financials", "get_creative_delivery", "sync_event_sources", "sync_audiences", "sync_catalogs", "log_event", "get_brand_identity", "get_rights", "acquire_rights"] as const;
export const TMPResponseTypeValues = ["activation", "catalog_items", "creative", "deal"] as const;
export const TransportModeValues = ["walking", "cycling", "driving", "public_transport"] as const;
export const UIDTypeValues = ["rampid", "rampid_derived", "id5", "uid2", "euid", "pairid", "maid", "hashed_email", "publisher_first_party", "other"] as const;
export const UniversalMacroValues = ["MEDIA_BUY_ID", "PACKAGE_ID", "CREATIVE_ID", "CACHEBUSTER", "TIMESTAMP", "CLICK_URL", "GDPR", "GDPR_CONSENT", "US_PRIVACY", "GPP_STRING", "GPP_SID", "IP_ADDRESS", "LIMIT_AD_TRACKING", "DEVICE_TYPE", "OS", "OS_VERSION", "DEVICE_MAKE", "DEVICE_MODEL", "USER_AGENT", "APP_BUNDLE", "APP_NAME", "COUNTRY", "REGION", "CITY", "ZIP", "DMA", "LAT", "LONG", "DEVICE_ID", "DEVICE_ID_TYPE", "DOMAIN", "PAGE_URL", "REFERRER", "KEYWORDS", "PLACEMENT_ID", "FOLD_POSITION", "AD_WIDTH", "AD_HEIGHT", "VIDEO_ID", "VIDEO_TITLE", "VIDEO_DURATION", "VIDEO_CATEGORY", "CONTENT_GENRE", "CONTENT_RATING", "PLAYER_WIDTH", "PLAYER_HEIGHT", "POD_POSITION", "POD_SIZE", "AD_BREAK_ID", "STATION_ID", "COLLECTION_NAME", "INSTALLMENT_ID", "AUDIO_DURATION", "TMPX", "AXEM", "CATALOG_ID", "SKU", "GTIN", "OFFERING_ID", "JOB_ID", "HOTEL_ID", "FLIGHT_ID", "VEHICLE_ID", "LISTING_ID", "STORE_ID", "PROGRAM_ID", "DESTINATION_ID", "CREATIVE_VARIANT_ID", "APP_ITEM_ID"] as const;
export const UpdateFrequencyValues = ["realtime", "hourly", "daily", "weekly"] as const;
export const URLAssetTypeValues = ["clickthrough", "tracker_pixel", "tracker_script"] as const;
export const ValidationModeValues = ["strict", "lenient"] as const;
export const VASTTrackingEventValues = ["impression", "creativeView", "loaded", "start", "firstQuartile", "midpoint", "thirdQuartile", "complete", "mute", "unmute", "pause", "resume", "rewind", "skip", "playerExpand", "playerCollapse", "fullscreen", "exitFullscreen", "progress", "notUsed", "otherAdInteraction", "interactiveStart", "clickTracking", "customClick", "close", "closeLinear", "error", "viewable", "notViewable", "viewUndetermined", "measurableImpression", "viewableImpression"] as const;
export const VASTVersionValues = ["2.0", "3.0", "4.0", "4.1", "4.2"] as const;
export const ViewabilityStandardValues = ["mrc", "groupm"] as const;
export const WCAGLevelValues = ["A", "AA", "AAA"] as const;
export const WebhookResponseTypeValues = ["html", "json", "xml", "javascript"] as const;
export const WebhookSecurityMethodValues = ["hmac_sha256", "api_key", "none"] as const;
export const XEntityTypesValues = ["advertiser_brand", "rights_holder_brand", "rights_grant", "account", "operator", "media_buy", "package", "product", "product_pricing_option", "vendor_pricing_option", "creative", "creative_format", "audience", "signal", "signal_activation_id", "event_source", "collection_list", "property_list", "catalog", "property", "media_plan", "governance_plan", "governance_registry_policy", "governance_inline_policy", "governance_check", "content_standards", "task", "si_session", "offering"] as const;
