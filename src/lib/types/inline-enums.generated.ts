// Generated inline-union value arrays for AdCP anonymous string-literal unions
// Sources: schemas.generated.ts (compiled Zod schemas, walked via runtime introspection)
//
// Every inline `z.union([z.literal(...), ...])` (or its array-wrapped form)
// inside a named object schema gets a corresponding
// `export const ${ParentSchema}_${PropertyName}Values = [...] as const`
// here. Use these when you need to enumerate, filter, or validate against
// the spec's per-field literal sets without re-deriving from the parent
// schema — e.g.:
//
//   import { ImageAssetRequirements_FormatsValues } from '@adcp/sdk/types';
//   const formats = new Set<string>(ImageAssetRequirements_FormatsValues);
//   if (!formats.has(input)) throw new Error('unsupported image format');
//
// Property names referencing named enums (e.g. `unit: DimensionUnitSchema`)
// are intentionally skipped — use the matching `${TypeName}Values` export
// from `enums.generated.ts` instead.


// ====== ActivateSignalRequest ======

/** single | ActivateSignalRequest.action */
export const ActivateSignalRequest_ActionValues = ["activate", "deactivate"] as const;

// ====== AppItem ======

/** single | AppItem.platform */
export const AppItem_PlatformValues = ["ios", "android"] as const;

// ====== AudioAssetRequirements ======

/** array of | AudioAssetRequirements.channels */
export const AudioAssetRequirements_ChannelsValues = ["mono", "stereo"] as const;
/** array of | AudioAssetRequirements.formats */
export const AudioAssetRequirements_FormatsValues = ["mp3", "aac", "wav", "ogg", "flac"] as const;

// ====== AuthorizationResult ======

/** single | AuthorizationResult.status */
export const AuthorizationResult_StatusValues = ["authorized", "unauthorized", "unknown"] as const;

// ====== BillingNotSupportedDetails ======

/** single | BillingNotSupportedDetails.scope */
export const BillingNotSupportedDetails_ScopeValues = ["capability", "account"] as const;

// ====== BriefAsset ======

/** single | BriefAsset.objective */
export const BriefAsset_ObjectiveValues = ["awareness", "consideration", "conversion", "retention", "engagement"] as const;

// ====== BuildCreativeAsyncInputRequired ======

/** single | BuildCreativeAsyncInputRequired.reason */
export const BuildCreativeAsyncInputRequired_ReasonValues = ["APPROVAL_REQUIRED", "CREATIVE_DIRECTION_NEEDED", "ASSET_SELECTION_NEEDED"] as const;

// ====== CanonicalFormatAgentPlacementAISurfaceSponsoredPlacement ======

/** single | CanonicalFormatAgentPlacementAISurfaceSponsoredPlacement.composition_model */
export const CanonicalFormatAgentPlacementAISurfaceSponsoredPlacement_CompositionModelValues = ["deterministic", "algorithmic"] as const;
/** single | CanonicalFormatAgentPlacementAISurfaceSponsoredPlacement.output_modality */
export const CanonicalFormatAgentPlacementAISurfaceSponsoredPlacement_OutputModalityValues = ["text", "audio", "card"] as const;

// ====== CanonicalFormatDisplayTag ======

/** array of | CanonicalFormatDisplayTag.supported_tag_types */
export const CanonicalFormatDisplayTag_SupportedTagTypesValues = ["iframe", "javascript", "1x1_redirect"] as const;

// ====== CanonicalFormatHostedAudio ======

/** single | CanonicalFormatHostedAudio.asset_source */
export const CanonicalFormatHostedAudio_AssetSourceValues = ["buyer_uploaded", "publisher_host_recorded", "seller_pre_rendered_from_brief", "seller_human_designed", "agent_synthesized"] as const;
/** array of | CanonicalFormatHostedAudio.audio_codecs */
export const CanonicalFormatHostedAudio_AudioCodecsValues = ["mp3", "aac", "wav", "opus", "flac"] as const;
/** single | CanonicalFormatHostedAudio.buyer_asset_acceptance */
export const CanonicalFormatHostedAudio_BuyerAssetAcceptanceValues = ["accepted", "rejected"] as const;

// ====== CanonicalFormatHostedVideo ======

/** array of | CanonicalFormatHostedVideo.audio_codecs */
export const CanonicalFormatHostedVideo_AudioCodecsValues = ["aac", "mp3", "opus", "pcm"] as const;
/** single | CanonicalFormatHostedVideo.captions */
export const CanonicalFormatHostedVideo_CaptionsValues = ["required", "recommended", "not_required"] as const;
/** array of | CanonicalFormatHostedVideo.containers */
export const CanonicalFormatHostedVideo_ContainersValues = ["mp4", "webm", "mov"] as const;
/** single | CanonicalFormatHostedVideo.orientation */
export const CanonicalFormatHostedVideo_OrientationValues = ["vertical", "horizontal", "square"] as const;
/** array of | CanonicalFormatHostedVideo.video_codecs */
export const CanonicalFormatHostedVideo_VideoCodecsValues = ["h264", "h265", "vp8", "vp9", "av1", "prores"] as const;

// ====== CanonicalFormatHTML5Banner ======

/** single | CanonicalFormatHTML5Banner.clicktag_macro */
export const CanonicalFormatHTML5Banner_ClicktagMacroValues = ["clickTag", "clickTAG"] as const;
/** single | CanonicalFormatHTML5Banner.mraid_version */
export const CanonicalFormatHTML5Banner_MraidVersionValues = ["2.0", "3.0"] as const;

// ====== CanonicalFormatImage ======

/** array of | CanonicalFormatImage.image_formats */
export const CanonicalFormatImage_ImageFormatsValues = ["jpg", "jpeg", "png", "gif", "webp", "svg"] as const;

// ====== CanonicalFormatImageCarousel ======

/** array of | CanonicalFormatImageCarousel.allowed_card_asset_types */
export const CanonicalFormatImageCarousel_AllowedCardAssetTypesValues = ["image", "video"] as const;

// ====== CanonicalFormatNativeInFeed ======

/** single | CanonicalFormatNativeInFeed.asset_source */
export const CanonicalFormatNativeInFeed_AssetSourceValues = ["buyer_uploaded", "seller_pre_rendered_from_brief", "seller_human_designed", "agent_synthesized"] as const;
/** array of | CanonicalFormatNativeInFeed.image_formats */
export const CanonicalFormatNativeInFeed_ImageFormatsValues = ["jpg", "jpeg", "png", "gif", "webp"] as const;

// ====== CanonicalFormatSponsoredPlacementRetailMediaCatalogDriven ======

/** single | CanonicalFormatSponsoredPlacementRetailMediaCatalogDriven.fanout_mode */
export const CanonicalFormatSponsoredPlacementRetailMediaCatalogDriven_FanoutModeValues = ["per_item", "multi_item_in_creative", "single_item"] as const;
/** array of | CanonicalFormatSponsoredPlacementRetailMediaCatalogDriven.supported_catalog_types */
export const CanonicalFormatSponsoredPlacementRetailMediaCatalogDriven_SupportedCatalogTypesValues = ["product", "store", "offering", "hotel", "flight", "vehicle", "real_estate", "education", "destination", "app", "job", "inventory"] as const;
/** array of | CanonicalFormatSponsoredPlacementRetailMediaCatalogDriven.supported_id_types */
export const CanonicalFormatSponsoredPlacementRetailMediaCatalogDriven_SupportedIdTypesValues = ["asin", "sku", "gtin", "offering_id", "store_id", "hotel_id", "flight_id", "vehicle_id", "listing_id", "program_id", "destination_id", "app_id", "job_id"] as const;

// ====== CanonicalFormatVASTVideo ======

/** single | CanonicalFormatVASTVideo.vpaid_version */
export const CanonicalFormatVASTVideo_VpaidVersionValues = ["1.0", "2.0"] as const;

// ====== CatalogFieldMapping ======

/** single | CatalogFieldMapping.transform */
export const CatalogFieldMapping_TransformValues = ["date", "divide", "boolean", "split"] as const;

// ====== ComplyTestControllerRequest ======

/** single | ComplyTestControllerRequest.scenario */
export const ComplyTestControllerRequest_ScenarioValues = ["list_scenarios", "force_creative_status", "force_account_status", "force_media_buy_status", "force_create_media_buy_arm", "force_task_completion", "force_session_status", "simulate_delivery", "simulate_budget_spend", "seed_product", "seed_pricing_option", "seed_creative", "seed_plan", "seed_media_buy", "seed_creative_format", "query_upstream_traffic"] as const;

// ====== ControllerError ======

/** single | ControllerError.error */
export const ControllerError_ErrorValues = ["INVALID_TRANSITION", "INVALID_STATE", "NOT_FOUND", "UNKNOWN_SCENARIO", "INVALID_PARAMS", "FORBIDDEN", "INTERNAL_ERROR"] as const;

// ====== CreateMediaBuyAsyncInputRequired ======

/** single | CreateMediaBuyAsyncInputRequired.reason */
export const CreateMediaBuyAsyncInputRequired_ReasonValues = ["APPROVAL_REQUIRED", "BUDGET_EXCEEDS_LIMIT"] as const;

// ====== CreativePurgedWebhook ======

/** single | CreativePurgedWebhook.initiator */
export const CreativePurgedWebhook_InitiatorValues = ["seller", "system"] as const;
/** single | CreativePurgedWebhook.purge_kind */
export const CreativePurgedWebhook_PurgeKindValues = ["soft", "hard"] as const;

// ====== CreativeVariable ======

/** single | CreativeVariable.variable_type */
export const CreativeVariable_VariableTypeValues = ["text", "image", "video", "audio", "url", "number", "boolean", "color", "date"] as const;

// ====== DAASTTrackerAsset ======

/** single | DAASTTrackerAsset.target */
export const DAASTTrackerAsset_TargetValues = ["linear", "companion"] as const;

// ====== DestinationItem ======

/** single | DestinationItem.destination_type */
export const DestinationItem_DestinationTypeValues = ["beach", "mountain", "urban", "cultural", "adventure", "wellness", "cruise"] as const;

// ====== DiagnosticIssue ======

/** single | DiagnosticIssue.severity */
export const DiagnosticIssue_SeverityValues = ["error", "warning", "info"] as const;

// ====== Duration ======

/** single | Duration.unit */
export const Duration_UnitValues = ["seconds", "minutes", "hours", "days", "campaign"] as const;

// ====== EducationItem ======

/** single | EducationItem.degree_type */
export const EducationItem_DegreeTypeValues = ["certificate", "associate", "bachelor", "master", "doctorate", "professional", "bootcamp"] as const;
/** single | EducationItem.level */
export const EducationItem_LevelValues = ["beginner", "intermediate", "advanced"] as const;
/** single | EducationItem.modality */
export const EducationItem_ModalityValues = ["online", "in_person", "hybrid"] as const;

// ====== Error ======

/** single | Error.recovery */
export const Error_RecoveryValues = ["transient", "correctable", "terminal"] as const;
/** single | Error.source */
export const Error_SourceValues = ["producer", "sdk"] as const;

// ====== FeatureRequirement ======

/** single | FeatureRequirement.if_not_covered */
export const FeatureRequirement_IfNotCoveredValues = ["exclude", "include"] as const;

// ====== FlatFeePricing ======

/** single | FlatFeePricing.period */
export const FlatFeePricing_PeriodValues = ["monthly", "quarterly", "annual", "campaign"] as const;

// ====== GetAccountFinancialsSuccess ======

/** single | GetAccountFinancialsSuccess.payment_status */
export const GetAccountFinancialsSuccess_PaymentStatusValues = ["current", "past_due", "suspended"] as const;

// ====== GetAdCPCapabilitiesRequest ======

/** array of | GetAdCPCapabilitiesRequest.protocols */
export const GetAdCPCapabilitiesRequest_ProtocolsValues = ["media_buy", "signals", "governance", "sponsored_intelligence", "creative"] as const;

// ====== GetAdCPCapabilitiesResponse ======

/** array of | GetAdCPCapabilitiesResponse.supported_protocols */
export const GetAdCPCapabilitiesResponse_SupportedProtocolsValues = ["media_buy", "signals", "governance", "sponsored_intelligence", "creative", "brand", "measurement"] as const;

// ====== GetBrandIdentityRequest ======

/** array of | GetBrandIdentityRequest.fields */
export const GetBrandIdentityRequest_FieldsValues = ["description", "industries", "keller_type", "logos", "colors", "fonts", "visual_guidelines", "tone", "tagline", "voice_synthesis", "assets", "rights"] as const;

// ====== GetBrandIdentitySuccess ======

/** single | GetBrandIdentitySuccess.keller_type */
export const GetBrandIdentitySuccess_KellerTypeValues = ["master", "sub_brand", "endorsed", "independent"] as const;

// ====== GetMediaBuyDeliveryResponse ======

/** single | GetMediaBuyDeliveryResponse.notification_type */
export const GetMediaBuyDeliveryResponse_NotificationTypeValues = ["scheduled", "final", "delayed", "adjusted", "window_update"] as const;

// ====== GetProductsAsyncInputRequired ======

/** single | GetProductsAsyncInputRequired.reason */
export const GetProductsAsyncInputRequired_ReasonValues = ["CLARIFICATION_NEEDED", "BUDGET_REQUIRED"] as const;

// ====== GetProductsRequest ======

/** single | GetProductsRequest.buying_mode */
export const GetProductsRequest_BuyingModeValues = ["brief", "wholesale", "refine"] as const;
/** array of | GetProductsRequest.fields */
export const GetProductsRequest_FieldsValues = ["product_id", "name", "description", "publisher_properties", "channels", "format_ids", "placements", "delivery_type", "exclusivity", "pricing_options", "forecast", "outcome_measurement", "delivery_measurement", "reporting_capabilities", "creative_policy", "catalog_types", "metric_optimization", "conversion_tracking", "data_provider_signals", "max_optimization_goals", "catalog_match", "collections", "collection_targeting_allowed", "installments", "brief_relevance", "expires_at", "product_card", "product_card_detailed", "enforced_policies", "trusted_match"] as const;

// ====== GetProductsResponse ======

/** single | GetProductsResponse.cache_scope */
export const GetProductsResponse_CacheScopeValues = ["public", "account"] as const;

// ====== GetSignalsRequest ======

/** single | GetSignalsRequest.discovery_mode */
export const GetSignalsRequest_DiscoveryModeValues = ["brief", "wholesale"] as const;

// ====== HTMLAssetRequirements ======

/** single | HTMLAssetRequirements.sandbox */
export const HTMLAssetRequirements_SandboxValues = ["none", "iframe", "safeframe", "fencedframe"] as const;

// ====== ImageAssetRequirements ======

/** single | ImageAssetRequirements.color_space */
export const ImageAssetRequirements_ColorSpaceValues = ["rgb", "cmyk", "grayscale"] as const;
/** array of | ImageAssetRequirements.formats */
export const ImageAssetRequirements_FormatsValues = ["jpg", "jpeg", "png", "gif", "webp", "svg", "avif", "tiff", "pdf", "eps"] as const;

// ====== Impairment ======

/** single | Impairment.resource_type */
export const Impairment_ResourceTypeValues = ["audience", "creative", "catalog_item", "event_source", "property"] as const;

// ====== JavaScriptAssetRequirements ======

/** single | JavaScriptAssetRequirements.module_type */
export const JavaScriptAssetRequirements_ModuleTypeValues = ["script", "module", "iife"] as const;

// ====== JobItem ======

/** single | JobItem.employment_type */
export const JobItem_EmploymentTypeValues = ["full_time", "part_time", "contract", "temporary", "internship", "freelance"] as const;
/** single | JobItem.experience_level */
export const JobItem_ExperienceLevelValues = ["entry_level", "mid_level", "senior", "director", "executive"] as const;

// ====== ListCreativeFormatsResponse ======

/** single | ListCreativeFormatsResponse.source */
export const ListCreativeFormatsResponse_SourceValues = ["publisher", "aao_mirror", "agent_derived"] as const;

// ====== ListCreativesRequest ======

/** array of | ListCreativesRequest.fields */
export const ListCreativesRequest_FieldsValues = ["creative_id", "name", "format_id", "status", "created_date", "updated_date", "tags", "assignments", "snapshot", "items", "variables", "concept", "pricing_options"] as const;

// ====== ListScenariosSuccess ======

/** array of | ListScenariosSuccess.scenarios */
export const ListScenariosSuccess_ScenariosValues = ["force_creative_status", "force_account_status", "force_media_buy_status", "force_create_media_buy_arm", "force_task_completion", "force_session_status", "simulate_delivery", "simulate_budget_spend", "seed_product", "seed_pricing_option", "seed_creative", "seed_plan", "seed_media_buy", "seed_creative_format", "query_upstream_traffic"] as const;

// ====== PerformanceFeedback ======

/** single | PerformanceFeedback.status */
export const PerformanceFeedback_StatusValues = ["accepted", "queued", "applied", "rejected"] as const;

// ====== PixelTrackerAsset ======

/** single | PixelTrackerAsset.event */
export const PixelTrackerAsset_EventValues = ["impression", "viewable_mrc_50", "viewable_mrc_100", "viewable_video_50", "audible_video_complete", "click", "custom"] as const;
/** single | PixelTrackerAsset.method */
export const PixelTrackerAsset_MethodValues = ["img", "js"] as const;

// ====== PolicyEntry ======

/** single | PolicyEntry.source */
export const PolicyEntry_SourceValues = ["registry", "inline"] as const;

// ====== PreviewCreativeRequest ======

/** single | PreviewCreativeRequest.request_type */
export const PreviewCreativeRequest_RequestTypeValues = ["single", "batch", "variant"] as const;

// ====== Price ======

/** single | Price.period */
export const Price_PeriodValues = ["night", "month", "year", "one_time"] as const;

// ====== PropertyError ======

/** single | PropertyError.code */
export const PropertyError_CodeValues = ["PROPERTY_NOT_FOUND", "PROPERTY_NOT_MONITORED", "LIST_NOT_FOUND", "LIST_ACCESS_DENIED", "METHODOLOGY_NOT_SUPPORTED", "JURISDICTION_NOT_SUPPORTED"] as const;

// ====== PropertyFeatureDefinition ======

/** single | PropertyFeatureDefinition.type */
export const PropertyFeatureDefinition_TypeValues = ["binary", "quantitative", "categorical"] as const;

// ====== PropertyFeatureResult ======

/** single | PropertyFeatureResult.coverage_status */
export const PropertyFeatureResult_CoverageStatusValues = ["covered", "not_covered", "pending"] as const;

// ====== Provenance ======

/** single | Provenance.human_oversight */
export const Provenance_HumanOversightValues = ["none", "prompt_only", "selected", "edited", "directed"] as const;

// ====== PublisherEntry ======

/** single | PublisherEntry.discovery_method */
export const PublisherEntry_DiscoveryMethodValues = ["direct", "authoritative_location", "adagents_authoritative", "ads_txt_managerdomain"] as const;
/** single | PublisherEntry.status */
export const PublisherEntry_StatusValues = ["authorized", "revoked"] as const;

// ====== RateLimitedDetails ======

/** single | RateLimitedDetails.scope */
export const RateLimitedDetails_ScopeValues = ["account", "tool", "global"] as const;

// ====== RealEstateItem ======

/** single | RealEstateItem.listing_type */
export const RealEstateItem_ListingTypeValues = ["for_sale", "for_rent"] as const;
/** single | RealEstateItem.property_type */
export const RealEstateItem_PropertyTypeValues = ["house", "apartment", "condo", "townhouse", "land", "commercial"] as const;

// ====== ReferenceAsset ======

/** single | ReferenceAsset.role */
export const ReferenceAsset_RoleValues = ["style_reference", "product_shot", "mood_board", "example_creative", "logo", "strategy_doc", "storyboard"] as const;

// ====== RepeatableGroupAsset ======

/** single | RepeatableGroupAsset.selection_mode */
export const RepeatableGroupAsset_SelectionModeValues = ["sequential", "optimize"] as const;

// ====== ReportingCapabilities ======

/** single | ReportingCapabilities.date_range_support */
export const ReportingCapabilities_DateRangeSupportValues = ["date_range", "lifetime_only"] as const;

// ====== ReportPlanOutcomeResponse ======

/** single | ReportPlanOutcomeResponse.outcome_state */
export const ReportPlanOutcomeResponse_OutcomeStateValues = ["accepted", "findings"] as const;

// ====== RightsConstraint ======

/** single | RightsConstraint.approval_status */
export const RightsConstraint_ApprovalStatusValues = ["pending", "approved", "rejected"] as const;

// ====== SIComponentCatalog ======

/** array of | SIComponentCatalog.components */
export const SIComponentCatalog_ComponentsValues = ["Text", "Button", "Link", "Image", "Card", "ProductCard", "List", "Row", "Column", "IntegrationAction", "AppHandoff"] as const;

// ====== SIIdentity ======

/** array of | SIIdentity.consent_scope */
export const SIIdentity_ConsentScopeValues = ["name", "email", "shipping_address", "phone", "locale"] as const;

// ====== SITerminateSessionRequest ======

/** single | SITerminateSessionRequest.reason */
export const SITerminateSessionRequest_ReasonValues = ["handoff_transaction", "handoff_complete", "user_exit", "session_timeout", "host_terminated"] as const;

// ====== SIUIElement ======

/** single | SIUIElement.type */
export const SIUIElement_TypeValues = ["text", "link", "image", "product_card", "carousel", "action_button", "app_handoff", "integration_actions"] as const;

// ====== SyncCatalogsAsyncInputRequired ======

/** single | SyncCatalogsAsyncInputRequired.reason */
export const SyncCatalogsAsyncInputRequired_ReasonValues = ["APPROVAL_REQUIRED", "FEED_VALIDATION", "ITEM_REVIEW", "FEED_ACCESS"] as const;

// ====== SyncCreativesAsyncInputRequired ======

/** single | SyncCreativesAsyncInputRequired.reason */
export const SyncCreativesAsyncInputRequired_ReasonValues = ["APPROVAL_REQUIRED", "ASSET_CONFIRMATION", "FORMAT_CLARIFICATION"] as const;

// ====== UpdateMediaBuyAsyncInputRequired ======

/** single | UpdateMediaBuyAsyncInputRequired.reason */
export const UpdateMediaBuyAsyncInputRequired_ReasonValues = ["APPROVAL_REQUIRED", "CHANGE_CONFIRMATION"] as const;

// ====== URLAssetRequirements ======

/** array of | URLAssetRequirements.protocols */
export const URLAssetRequirements_ProtocolsValues = ["https", "http"] as const;
/** single | URLAssetRequirements.role */
export const URLAssetRequirements_RoleValues = ["clickthrough", "landing_page", "impression_tracker", "click_tracker", "viewability_tracker", "third_party_tracker"] as const;

// ====== ValidateInputResult ======

/** single | ValidateInputResult.result_kind */
export const ValidateInputResult_ResultKindValues = ["validated_pass", "validated_fail", "unvalidatable_nondeterministic"] as const;

// ====== ValidationResult ======

/** single | ValidationResult.status */
export const ValidationResult_StatusValues = ["compliant", "non_compliant", "not_covered", "unidentified"] as const;

// ====== VASTTrackerAsset ======

/** single | VASTTrackerAsset.target */
export const VASTTrackerAsset_TargetValues = ["linear", "non_linear", "companion"] as const;

// ====== VehicleItem ======

/** single | VehicleItem.body_style */
export const VehicleItem_BodyStyleValues = ["sedan", "suv", "truck", "coupe", "convertible", "wagon", "van", "hatchback"] as const;
/** single | VehicleItem.condition */
export const VehicleItem_ConditionValues = ["new", "used", "certified_pre_owned"] as const;
/** single | VehicleItem.fuel_type */
export const VehicleItem_FuelTypeValues = ["gasoline", "diesel", "electric", "hybrid", "plug_in_hybrid"] as const;
/** single | VehicleItem.transmission */
export const VehicleItem_TransmissionValues = ["automatic", "manual", "cvt"] as const;

// ====== VerifyBrandClaimsResultSuccess ======

/** single | VerifyBrandClaimsResultSuccess.claim_type */
export const VerifyBrandClaimsResultSuccess_ClaimTypeValues = ["subsidiary", "parent", "property", "trademark"] as const;

// ====== VideoAsset ======

/** single | VideoAsset.chroma_subsampling */
export const VideoAsset_ChromaSubsamplingValues = ["4:2:0", "4:2:2", "4:4:4"] as const;
/** single | VideoAsset.color_space */
export const VideoAsset_ColorSpaceValues = ["rec709", "rec2020", "rec2100", "srgb", "dci_p3"] as const;
/** single | VideoAsset.hdr_format */
export const VideoAsset_HdrFormatValues = ["sdr", "hdr10", "hdr10_plus", "hlg", "dolby_vision"] as const;

// ====== VideoAssetRequirements ======

/** array of | VideoAssetRequirements.audio_codecs */
export const VideoAssetRequirements_AudioCodecsValues = ["aac", "pcm", "ac3", "eac3", "mp3", "opus", "vorbis", "flac"] as const;
/** array of | VideoAssetRequirements.containers */
export const VideoAssetRequirements_ContainersValues = ["mp4", "webm", "mov", "avi", "mkv"] as const;

// ====== WebhookActivityRecord ======

/** single | WebhookActivityRecord.status */
export const WebhookActivityRecord_StatusValues = ["success", "failed", "timeout", "connection_error", "pending"] as const;

// ====== WholesaleFeedWebhook ======

/** single | WholesaleFeedWebhook.notification_type */
export const WholesaleFeedWebhook_NotificationTypeValues = ["product.created", "product.updated", "product.priced", "product.removed", "signal.created", "signal.updated", "signal.priced", "signal.removed", "wholesale_feed.bulk_change"] as const;

// ====== Deprecated aliases — duplicate literal sets ======
// Re-exported under their original parent-prefixed names; resolve
// to the same array reference as the canonical export. Migrate
// imports to the canonical name; aliases remain for one minor
// version. (adcp-client#941)

// --- BriefAsset1 ---
/** @deprecated use `BriefAsset_ObjectiveValues` — same literal set, BriefAsset1.objective duplicates the canonical export. */
export const BriefAsset1_ObjectiveValues = BriefAsset_ObjectiveValues;
// --- BriefAsset2 ---
/** @deprecated use `BriefAsset_ObjectiveValues` — same literal set, BriefAsset2.objective duplicates the canonical export. */
export const BriefAsset2_ObjectiveValues = BriefAsset_ObjectiveValues;
// --- BriefAsset3 ---
/** @deprecated use `BriefAsset_ObjectiveValues` — same literal set, BriefAsset3.objective duplicates the canonical export. */
export const BriefAsset3_ObjectiveValues = BriefAsset_ObjectiveValues;
// --- BriefAsset4 ---
/** @deprecated use `BriefAsset_ObjectiveValues` — same literal set, BriefAsset4.objective duplicates the canonical export. */
export const BriefAsset4_ObjectiveValues = BriefAsset_ObjectiveValues;
// --- BriefAsset5 ---
/** @deprecated use `BriefAsset_ObjectiveValues` — same literal set, BriefAsset5.objective duplicates the canonical export. */
export const BriefAsset5_ObjectiveValues = BriefAsset_ObjectiveValues;
// --- BriefAsset6 ---
/** @deprecated use `BriefAsset_ObjectiveValues` — same literal set, BriefAsset6.objective duplicates the canonical export. */
export const BriefAsset6_ObjectiveValues = BriefAsset_ObjectiveValues;
// --- BriefAsset7 ---
/** @deprecated use `BriefAsset_ObjectiveValues` — same literal set, BriefAsset7.objective duplicates the canonical export. */
export const BriefAsset7_ObjectiveValues = BriefAsset_ObjectiveValues;
// --- BuildCreativeInputRequired ---
/** @deprecated use `BuildCreativeAsyncInputRequired_ReasonValues` — same literal set, BuildCreativeInputRequired.reason duplicates the canonical export. */
export const BuildCreativeInputRequired_ReasonValues = BuildCreativeAsyncInputRequired_ReasonValues;
// --- CanonicalFormatBase ---
/** @deprecated use `CanonicalFormatAgentPlacementAISurfaceSponsoredPlacement_CompositionModelValues` — same literal set, CanonicalFormatBase.composition_model duplicates the canonical export. */
export const CanonicalFormatBase_CompositionModelValues = CanonicalFormatAgentPlacementAISurfaceSponsoredPlacement_CompositionModelValues;
// --- CanonicalFormatDAASTAudio ---
/** @deprecated use `CanonicalFormatAgentPlacementAISurfaceSponsoredPlacement_CompositionModelValues` — same literal set, CanonicalFormatDAASTAudio.composition_model duplicates the canonical export. */
export const CanonicalFormatDAASTAudio_CompositionModelValues = CanonicalFormatAgentPlacementAISurfaceSponsoredPlacement_CompositionModelValues;
// --- CanonicalFormatDisplayTag ---
/** @deprecated use `CanonicalFormatAgentPlacementAISurfaceSponsoredPlacement_CompositionModelValues` — same literal set, CanonicalFormatDisplayTag.composition_model duplicates the canonical export. */
export const CanonicalFormatDisplayTag_CompositionModelValues = CanonicalFormatAgentPlacementAISurfaceSponsoredPlacement_CompositionModelValues;
// --- CanonicalFormatHostedAudio ---
/** @deprecated use `AudioAssetRequirements_ChannelsValues` — same literal set, CanonicalFormatHostedAudio.audio_channels duplicates the canonical export. */
export const CanonicalFormatHostedAudio_AudioChannelsValues = AudioAssetRequirements_ChannelsValues;
/** @deprecated use `CanonicalFormatAgentPlacementAISurfaceSponsoredPlacement_CompositionModelValues` — same literal set, CanonicalFormatHostedAudio.composition_model duplicates the canonical export. */
export const CanonicalFormatHostedAudio_CompositionModelValues = CanonicalFormatAgentPlacementAISurfaceSponsoredPlacement_CompositionModelValues;
// --- CanonicalFormatHostedVideo ---
/** @deprecated use `CanonicalFormatHostedAudio_AssetSourceValues` — same literal set, CanonicalFormatHostedVideo.asset_source duplicates the canonical export. */
export const CanonicalFormatHostedVideo_AssetSourceValues = CanonicalFormatHostedAudio_AssetSourceValues;
/** @deprecated use `CanonicalFormatHostedAudio_BuyerAssetAcceptanceValues` — same literal set, CanonicalFormatHostedVideo.buyer_asset_acceptance duplicates the canonical export. */
export const CanonicalFormatHostedVideo_BuyerAssetAcceptanceValues = CanonicalFormatHostedAudio_BuyerAssetAcceptanceValues;
/** @deprecated use `CanonicalFormatAgentPlacementAISurfaceSponsoredPlacement_CompositionModelValues` — same literal set, CanonicalFormatHostedVideo.composition_model duplicates the canonical export. */
export const CanonicalFormatHostedVideo_CompositionModelValues = CanonicalFormatAgentPlacementAISurfaceSponsoredPlacement_CompositionModelValues;
// --- CanonicalFormatHTML5Banner ---
/** @deprecated use `CanonicalFormatAgentPlacementAISurfaceSponsoredPlacement_CompositionModelValues` — same literal set, CanonicalFormatHTML5Banner.composition_model duplicates the canonical export. */
export const CanonicalFormatHTML5Banner_CompositionModelValues = CanonicalFormatAgentPlacementAISurfaceSponsoredPlacement_CompositionModelValues;
// --- CanonicalFormatImage ---
/** @deprecated use `CanonicalFormatHostedAudio_AssetSourceValues` — same literal set, CanonicalFormatImage.asset_source duplicates the canonical export. */
export const CanonicalFormatImage_AssetSourceValues = CanonicalFormatHostedAudio_AssetSourceValues;
/** @deprecated use `CanonicalFormatHostedAudio_BuyerAssetAcceptanceValues` — same literal set, CanonicalFormatImage.buyer_asset_acceptance duplicates the canonical export. */
export const CanonicalFormatImage_BuyerAssetAcceptanceValues = CanonicalFormatHostedAudio_BuyerAssetAcceptanceValues;
/** @deprecated use `CanonicalFormatAgentPlacementAISurfaceSponsoredPlacement_CompositionModelValues` — same literal set, CanonicalFormatImage.composition_model duplicates the canonical export. */
export const CanonicalFormatImage_CompositionModelValues = CanonicalFormatAgentPlacementAISurfaceSponsoredPlacement_CompositionModelValues;
// --- CanonicalFormatImageCarousel ---
/** @deprecated use `CanonicalFormatImageCarousel_AllowedCardAssetTypesValues` — same literal set, CanonicalFormatImageCarousel.allowed_card_media_asset_types duplicates the canonical export. */
export const CanonicalFormatImageCarousel_AllowedCardMediaAssetTypesValues = CanonicalFormatImageCarousel_AllowedCardAssetTypesValues;
/** @deprecated use `CanonicalFormatAgentPlacementAISurfaceSponsoredPlacement_CompositionModelValues` — same literal set, CanonicalFormatImageCarousel.composition_model duplicates the canonical export. */
export const CanonicalFormatImageCarousel_CompositionModelValues = CanonicalFormatAgentPlacementAISurfaceSponsoredPlacement_CompositionModelValues;
// --- CanonicalFormatNativeInFeed ---
/** @deprecated use `CanonicalFormatHostedAudio_BuyerAssetAcceptanceValues` — same literal set, CanonicalFormatNativeInFeed.buyer_asset_acceptance duplicates the canonical export. */
export const CanonicalFormatNativeInFeed_BuyerAssetAcceptanceValues = CanonicalFormatHostedAudio_BuyerAssetAcceptanceValues;
/** @deprecated use `CanonicalFormatAgentPlacementAISurfaceSponsoredPlacement_CompositionModelValues` — same literal set, CanonicalFormatNativeInFeed.composition_model duplicates the canonical export. */
export const CanonicalFormatNativeInFeed_CompositionModelValues = CanonicalFormatAgentPlacementAISurfaceSponsoredPlacement_CompositionModelValues;
// --- CanonicalFormatResponsiveCreative ---
/** @deprecated use `CanonicalFormatAgentPlacementAISurfaceSponsoredPlacement_CompositionModelValues` — same literal set, CanonicalFormatResponsiveCreative.composition_model duplicates the canonical export. */
export const CanonicalFormatResponsiveCreative_CompositionModelValues = CanonicalFormatAgentPlacementAISurfaceSponsoredPlacement_CompositionModelValues;
// --- CanonicalFormatSponsoredPlacementRetailMediaCatalogDriven ---
/** @deprecated use `CanonicalFormatAgentPlacementAISurfaceSponsoredPlacement_CompositionModelValues` — same literal set, CanonicalFormatSponsoredPlacementRetailMediaCatalogDriven.composition_model duplicates the canonical export. */
export const CanonicalFormatSponsoredPlacementRetailMediaCatalogDriven_CompositionModelValues = CanonicalFormatAgentPlacementAISurfaceSponsoredPlacement_CompositionModelValues;
/** @deprecated use `CanonicalFormatNativeInFeed_AssetSourceValues` — same literal set, CanonicalFormatSponsoredPlacementRetailMediaCatalogDriven.item_production_model duplicates the canonical export. */
export const CanonicalFormatSponsoredPlacementRetailMediaCatalogDriven_ItemProductionModelValues = CanonicalFormatNativeInFeed_AssetSourceValues;
// --- CanonicalFormatVASTVideo ---
/** @deprecated use `CanonicalFormatAgentPlacementAISurfaceSponsoredPlacement_CompositionModelValues` — same literal set, CanonicalFormatVASTVideo.composition_model duplicates the canonical export. */
export const CanonicalFormatVASTVideo_CompositionModelValues = CanonicalFormatAgentPlacementAISurfaceSponsoredPlacement_CompositionModelValues;
/** @deprecated use `CanonicalFormatHostedVideo_OrientationValues` — same literal set, CanonicalFormatVASTVideo.orientation duplicates the canonical export. */
export const CanonicalFormatVASTVideo_OrientationValues = CanonicalFormatHostedVideo_OrientationValues;
// --- CanonicalProjectionReference ---
/** @deprecated use `CanonicalFormatHostedAudio_AssetSourceValues` — same literal set, CanonicalProjectionReference.asset_source duplicates the canonical export. */
export const CanonicalProjectionReference_AssetSourceValues = CanonicalFormatHostedAudio_AssetSourceValues;
// --- CreateMediaBuyInputRequired ---
/** @deprecated use `CreateMediaBuyAsyncInputRequired_ReasonValues` — same literal set, CreateMediaBuyInputRequired.reason duplicates the canonical export. */
export const CreateMediaBuyInputRequired_ReasonValues = CreateMediaBuyAsyncInputRequired_ReasonValues;
// --- CreativeBrief ---
/** @deprecated use `BriefAsset_ObjectiveValues` — same literal set, CreativeBrief.objective duplicates the canonical export. */
export const CreativeBrief_ObjectiveValues = BriefAsset_ObjectiveValues;
// --- CreativeStatusChangedWebhook ---
/** @deprecated use `CreativePurgedWebhook_InitiatorValues` — same literal set, CreativeStatusChangedWebhook.initiator duplicates the canonical export. */
export const CreativeStatusChangedWebhook_InitiatorValues = CreativePurgedWebhook_InitiatorValues;
// --- GetBrandIdentitySuccess ---
/** @deprecated use `GetBrandIdentityRequest_FieldsValues` — same literal set, GetBrandIdentitySuccess.available_fields duplicates the canonical export. */
export const GetBrandIdentitySuccess_AvailableFieldsValues = GetBrandIdentityRequest_FieldsValues;
// --- GetProductsInputRequired ---
/** @deprecated use `GetProductsAsyncInputRequired_ReasonValues` — same literal set, GetProductsInputRequired.reason duplicates the canonical export. */
export const GetProductsInputRequired_ReasonValues = GetProductsAsyncInputRequired_ReasonValues;
// --- GetSignalsResponse ---
/** @deprecated use `GetProductsResponse_CacheScopeValues` — same literal set, GetSignalsResponse.cache_scope duplicates the canonical export. */
export const GetSignalsResponse_CacheScopeValues = GetProductsResponse_CacheScopeValues;
// --- SearchBrandResult ---
/** @deprecated use `GetBrandIdentitySuccess_KellerTypeValues` — same literal set, SearchBrandResult.keller_type duplicates the canonical export. */
export const SearchBrandResult_KellerTypeValues = GetBrandIdentitySuccess_KellerTypeValues;
// --- SyncCatalogsInputRequired ---
/** @deprecated use `SyncCatalogsAsyncInputRequired_ReasonValues` — same literal set, SyncCatalogsInputRequired.reason duplicates the canonical export. */
export const SyncCatalogsInputRequired_ReasonValues = SyncCatalogsAsyncInputRequired_ReasonValues;
// --- SyncCreativesInputRequired ---
/** @deprecated use `SyncCreativesAsyncInputRequired_ReasonValues` — same literal set, SyncCreativesInputRequired.reason duplicates the canonical export. */
export const SyncCreativesInputRequired_ReasonValues = SyncCreativesAsyncInputRequired_ReasonValues;
// --- UpdateMediaBuyInputRequired ---
/** @deprecated use `UpdateMediaBuyAsyncInputRequired_ReasonValues` — same literal set, UpdateMediaBuyInputRequired.reason duplicates the canonical export. */
export const UpdateMediaBuyInputRequired_ReasonValues = UpdateMediaBuyAsyncInputRequired_ReasonValues;
// --- VerifyBrandClaimSuccess ---
/** @deprecated use `VerifyBrandClaimsResultSuccess_ClaimTypeValues` — same literal set, VerifyBrandClaimSuccess.claim_type duplicates the canonical export. */
export const VerifyBrandClaimSuccess_ClaimTypeValues = VerifyBrandClaimsResultSuccess_ClaimTypeValues;
// --- VideoAssetRequirements ---
/** @deprecated use `CanonicalFormatHostedVideo_VideoCodecsValues` — same literal set, VideoAssetRequirements.codecs duplicates the canonical export. */
export const VideoAssetRequirements_CodecsValues = CanonicalFormatHostedVideo_VideoCodecsValues;
// --- WholesaleFeedWebhook ---
/** @deprecated use `GetProductsResponse_CacheScopeValues` — same literal set, WholesaleFeedWebhook.cache_scope duplicates the canonical export. */
export const WholesaleFeedWebhook_CacheScopeValues = GetProductsResponse_CacheScopeValues;
