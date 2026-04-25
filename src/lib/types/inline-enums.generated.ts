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
//   import { ImageAssetRequirements_FormatsValues } from '@adcp/client/types';
//   const formats = new Set<string>(ImageAssetRequirements_FormatsValues);
//   if (!formats.has(input)) throw new Error('unsupported image format');
//
// Property names referencing named enums (e.g. `unit: DimensionUnitSchema`)
// are intentionally skipped — use the matching `${TypeName}Values` export
// from `enums.generated.ts` instead.


// ====== Account ======

/** single | Account.account_scope */
export const Account_AccountScopeValues = ["operator", "brand", "operator_brand", "agent"] as const;
/** single | Account.billing */
export const Account_BillingValues = ["operator", "agent", "advertiser"] as const;
/** single | Account.payment_terms */
export const Account_PaymentTermsValues = ["net_15", "net_30", "net_45", "net_60", "net_90", "prepay"] as const;

// ====== ActivateSignalRequest ======

/** single | ActivateSignalRequest.action */
export const ActivateSignalRequest_ActionValues = ["activate", "deactivate"] as const;

// ====== AppItem ======

/** single | AppItem.platform */
export const AppItem_PlatformValues = ["ios", "android"] as const;

// ====== AudioAsset ======

/** single | AudioAsset.channels */
export const AudioAsset_ChannelsValues = ["mono", "stereo", "5.1", "7.1"] as const;

// ====== AudioAssetRequirements ======

/** array of | AudioAssetRequirements.channels */
export const AudioAssetRequirements_ChannelsValues = ["mono", "stereo"] as const;
/** array of | AudioAssetRequirements.formats */
export const AudioAssetRequirements_FormatsValues = ["mp3", "aac", "wav", "ogg", "flac"] as const;

// ====== AuthorizationResult ======

/** single | AuthorizationResult.status */
export const AuthorizationResult_StatusValues = ["authorized", "unauthorized", "unknown"] as const;

// ====== BriefAsset1 ======

/** single | BriefAsset1.objective */
export const BriefAsset1_ObjectiveValues = ["awareness", "consideration", "conversion", "retention", "engagement"] as const;

// ====== BuildCreativeAsyncInputRequired ======

/** single | BuildCreativeAsyncInputRequired.reason */
export const BuildCreativeAsyncInputRequired_ReasonValues = ["APPROVAL_REQUIRED", "CREATIVE_DIRECTION_NEEDED", "ASSET_SELECTION_NEEDED"] as const;

// ====== CatalogFieldMapping ======

/** single | CatalogFieldMapping.transform */
export const CatalogFieldMapping_TransformValues = ["date", "divide", "boolean", "split"] as const;

// ====== CheckGovernanceResponse ======

/** single | CheckGovernanceResponse.status */
export const CheckGovernanceResponse_StatusValues = ["approved", "denied", "conditions"] as const;

// ====== Collection ======

/** single | Collection.kind */
export const Collection_KindValues = ["series", "publication", "event_series", "rotation"] as const;

// ====== CollectionListFilters ======

/** array of | CollectionListFilters.kinds */
export const CollectionListFilters_KindsValues = ["series", "publication", "event_series", "rotation"] as const;

// ====== ComplyTestControllerRequest ======

/** single | ComplyTestControllerRequest.scenario */
export const ComplyTestControllerRequest_ScenarioValues = ["list_scenarios", "force_creative_status", "force_account_status", "force_media_buy_status", "force_session_status", "simulate_delivery", "simulate_budget_spend", "seed_product", "seed_pricing_option", "seed_creative", "seed_plan", "seed_media_buy"] as const;

// ====== ControllerError ======

/** single | ControllerError.error */
export const ControllerError_ErrorValues = ["INVALID_TRANSITION", "INVALID_STATE", "NOT_FOUND", "UNKNOWN_SCENARIO", "INVALID_PARAMS", "FORBIDDEN", "INTERNAL_ERROR"] as const;

// ====== CreateMediaBuyAsyncInputRequired ======

/** single | CreateMediaBuyAsyncInputRequired.reason */
export const CreateMediaBuyAsyncInputRequired_ReasonValues = ["APPROVAL_REQUIRED", "BUDGET_EXCEEDS_LIMIT"] as const;

// ====== CreateMediaBuySuccess ======

/** array of | CreateMediaBuySuccess.valid_actions */
export const CreateMediaBuySuccess_ValidActionsValues = ["pause", "resume", "cancel", "update_budget", "update_dates", "update_packages", "add_packages", "sync_creatives"] as const;

// ====== CreativeBrief ======

/** single | CreativeBrief.objective */
export const CreativeBrief_ObjectiveValues = ["awareness", "consideration", "conversion", "retention", "engagement"] as const;

// ====== CreativeVariable ======

/** single | CreativeVariable.variable_type */
export const CreativeVariable_VariableTypeValues = ["text", "image", "video", "audio", "url", "number", "boolean", "color", "date"] as const;

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

// ====== FeatureRequirement ======

/** single | FeatureRequirement.if_not_covered */
export const FeatureRequirement_IfNotCoveredValues = ["exclude", "include"] as const;

// ====== FlatFeePricing ======

/** single | FlatFeePricing.period */
export const FlatFeePricing_PeriodValues = ["monthly", "quarterly", "annual", "campaign"] as const;

// ====== GetAccountFinancialsSuccess ======

/** single | GetAccountFinancialsSuccess.payment_status */
export const GetAccountFinancialsSuccess_PaymentStatusValues = ["current", "past_due", "suspended"] as const;
/** single | GetAccountFinancialsSuccess.payment_terms */
export const GetAccountFinancialsSuccess_PaymentTermsValues = ["net_15", "net_30", "net_45", "net_60", "net_90", "prepay"] as const;

// ====== GetAdCPCapabilitiesRequest ======

/** array of | GetAdCPCapabilitiesRequest.protocols */
export const GetAdCPCapabilitiesRequest_ProtocolsValues = ["media_buy", "signals", "governance", "sponsored_intelligence", "creative"] as const;

// ====== GetAdCPCapabilitiesResponse ======

/** array of | GetAdCPCapabilitiesResponse.supported_protocols */
export const GetAdCPCapabilitiesResponse_SupportedProtocolsValues = ["media_buy", "signals", "governance", "sponsored_intelligence", "creative", "brand"] as const;

// ====== GetBrandIdentityRequest ======

/** array of | GetBrandIdentityRequest.fields */
export const GetBrandIdentityRequest_FieldsValues = ["description", "industries", "keller_type", "logos", "colors", "fonts", "visual_guidelines", "tone", "tagline", "voice_synthesis", "assets", "rights"] as const;

// ====== GetBrandIdentitySuccess ======

/** array of | GetBrandIdentitySuccess.available_fields */
export const GetBrandIdentitySuccess_AvailableFieldsValues = ["description", "industries", "keller_type", "logos", "colors", "fonts", "visual_guidelines", "tone", "tagline", "voice_synthesis", "assets", "rights"] as const;
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

// ====== HTMLAssetRequirements ======

/** single | HTMLAssetRequirements.sandbox */
export const HTMLAssetRequirements_SandboxValues = ["none", "iframe", "safeframe", "fencedframe"] as const;

// ====== ImageAssetRequirements ======

/** single | ImageAssetRequirements.color_space */
export const ImageAssetRequirements_ColorSpaceValues = ["rgb", "cmyk", "grayscale"] as const;
/** array of | ImageAssetRequirements.formats */
export const ImageAssetRequirements_FormatsValues = ["jpg", "jpeg", "png", "gif", "webp", "svg", "avif", "tiff", "pdf", "eps"] as const;

// ====== JavaScriptAssetRequirements ======

/** single | JavaScriptAssetRequirements.module_type */
export const JavaScriptAssetRequirements_ModuleTypeValues = ["script", "module", "iife"] as const;

// ====== JobItem ======

/** single | JobItem.employment_type */
export const JobItem_EmploymentTypeValues = ["full_time", "part_time", "contract", "temporary", "internship", "freelance"] as const;
/** single | JobItem.experience_level */
export const JobItem_ExperienceLevelValues = ["entry_level", "mid_level", "senior", "director", "executive"] as const;

// ====== ListCreativeFormatsRequestCreativeAgent ======

/** array of | ListCreativeFormatsRequestCreativeAgent.asset_types */
export const ListCreativeFormatsRequestCreativeAgent_AssetTypesValues = ["image", "video", "audio", "text", "html", "javascript", "url"] as const;
/** single | ListCreativeFormatsRequestCreativeAgent.type */
export const ListCreativeFormatsRequestCreativeAgent_TypeValues = ["audio", "video", "display", "dooh"] as const;

// ====== ListCreativesRequest ======

/** array of | ListCreativesRequest.fields */
export const ListCreativesRequest_FieldsValues = ["creative_id", "name", "format_id", "status", "created_date", "updated_date", "tags", "assignments", "snapshot", "items", "variables", "concept", "pricing_options"] as const;

// ====== ListScenariosSuccess ======

/** array of | ListScenariosSuccess.scenarios */
export const ListScenariosSuccess_ScenariosValues = ["force_creative_status", "force_account_status", "force_media_buy_status", "force_session_status", "simulate_delivery", "simulate_budget_spend", "seed_product", "seed_pricing_option", "seed_creative", "seed_plan", "seed_media_buy"] as const;

// ====== PackageStatus ======

/** single | PackageStatus.snapshot_unavailable_reason */
export const PackageStatus_SnapshotUnavailableReasonValues = ["SNAPSHOT_UNSUPPORTED", "SNAPSHOT_TEMPORARILY_UNAVAILABLE", "SNAPSHOT_PERMISSION_DENIED"] as const;

// ====== PerformanceFeedback ======

/** single | PerformanceFeedback.status */
export const PerformanceFeedback_StatusValues = ["accepted", "queued", "applied", "rejected"] as const;

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

// ====== RATE_LIMITEDDetails ======

/** single | RATE_LIMITEDDetails.scope */
export const RATE_LIMITEDDetails_ScopeValues = ["account", "tool", "global"] as const;

// ====== RealEstateItem ======

/** single | RealEstateItem.listing_type */
export const RealEstateItem_ListingTypeValues = ["for_sale", "for_rent"] as const;
/** single | RealEstateItem.property_type */
export const RealEstateItem_PropertyTypeValues = ["house", "apartment", "condo", "townhouse", "land", "commercial"] as const;

// ====== ReferenceAsset ======

/** single | ReferenceAsset.role */
export const ReferenceAsset_RoleValues = ["style_reference", "product_shot", "mood_board", "example_creative", "logo", "strategy_doc", "storyboard"] as const;

// ====== ReportingCapabilities ======

/** single | ReportingCapabilities.date_range_support */
export const ReportingCapabilities_DateRangeSupportValues = ["date_range", "lifetime_only"] as const;

// ====== ReportPlanOutcomeResponse ======

/** single | ReportPlanOutcomeResponse.status */
export const ReportPlanOutcomeResponse_StatusValues = ["accepted", "findings"] as const;

// ====== RightsConstraint ======

/** single | RightsConstraint.approval_status */
export const RightsConstraint_ApprovalStatusValues = ["pending", "approved", "rejected"] as const;

// ====== RightsPricingOption ======

/** single | RightsPricingOption.period */
export const RightsPricingOption_PeriodValues = ["daily", "weekly", "monthly", "quarterly", "annual", "one_time"] as const;

// ====== RightsTerms ======

/** single | RightsTerms.period */
export const RightsTerms_PeriodValues = ["daily", "weekly", "monthly", "quarterly", "annual", "one_time"] as const;

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

// ====== UpdateMediaBuySuccess ======

/** array of | UpdateMediaBuySuccess.valid_actions */
export const UpdateMediaBuySuccess_ValidActionsValues = ["pause", "resume", "cancel", "update_budget", "update_dates", "update_packages", "add_packages", "sync_creatives"] as const;

// ====== URLAssetRequirements ======

/** array of | URLAssetRequirements.protocols */
export const URLAssetRequirements_ProtocolsValues = ["https", "http"] as const;
/** single | URLAssetRequirements.role */
export const URLAssetRequirements_RoleValues = ["clickthrough", "landing_page", "impression_tracker", "click_tracker", "viewability_tracker", "third_party_tracker"] as const;

// ====== ValidationResult ======

/** single | ValidationResult.status */
export const ValidationResult_StatusValues = ["compliant", "non_compliant", "not_covered", "unidentified"] as const;

// ====== VehicleItem ======

/** single | VehicleItem.body_style */
export const VehicleItem_BodyStyleValues = ["sedan", "suv", "truck", "coupe", "convertible", "wagon", "van", "hatchback"] as const;
/** single | VehicleItem.condition */
export const VehicleItem_ConditionValues = ["new", "used", "certified_pre_owned"] as const;
/** single | VehicleItem.fuel_type */
export const VehicleItem_FuelTypeValues = ["gasoline", "diesel", "electric", "hybrid", "plug_in_hybrid"] as const;
/** single | VehicleItem.transmission */
export const VehicleItem_TransmissionValues = ["automatic", "manual", "cvt"] as const;

// ====== VideoAsset ======

/** single | VideoAsset.audio_channels */
export const VideoAsset_AudioChannelsValues = ["mono", "stereo", "5.1", "7.1"] as const;
/** single | VideoAsset.chroma_subsampling */
export const VideoAsset_ChromaSubsamplingValues = ["4:2:0", "4:2:2", "4:4:4"] as const;
/** single | VideoAsset.color_space */
export const VideoAsset_ColorSpaceValues = ["rec709", "rec2020", "rec2100", "srgb", "dci_p3"] as const;
/** single | VideoAsset.frame_rate_type */
export const VideoAsset_FrameRateTypeValues = ["constant", "variable"] as const;
/** single | VideoAsset.gop_type */
export const VideoAsset_GopTypeValues = ["closed", "open"] as const;
/** single | VideoAsset.hdr_format */
export const VideoAsset_HdrFormatValues = ["sdr", "hdr10", "hdr10_plus", "hlg", "dolby_vision"] as const;
/** single | VideoAsset.moov_atom_position */
export const VideoAsset_MoovAtomPositionValues = ["start", "end"] as const;
/** single | VideoAsset.scan_type */
export const VideoAsset_ScanTypeValues = ["progressive", "interlaced"] as const;

// ====== VideoAssetRequirements ======

/** array of | VideoAssetRequirements.audio_channels */
export const VideoAssetRequirements_AudioChannelsValues = ["mono", "stereo", "5.1", "7.1"] as const;
/** array of | VideoAssetRequirements.audio_codecs */
export const VideoAssetRequirements_AudioCodecsValues = ["aac", "pcm", "ac3", "eac3", "mp3", "opus", "vorbis", "flac"] as const;
/** array of | VideoAssetRequirements.codecs */
export const VideoAssetRequirements_CodecsValues = ["h264", "h265", "vp8", "vp9", "av1", "prores"] as const;
/** array of | VideoAssetRequirements.containers */
export const VideoAssetRequirements_ContainersValues = ["mp4", "webm", "mov", "avi", "mkv"] as const;
/** single | VideoAssetRequirements.frame_rate_type */
export const VideoAssetRequirements_FrameRateTypeValues = ["constant", "variable"] as const;
/** single | VideoAssetRequirements.gop_type */
export const VideoAssetRequirements_GopTypeValues = ["closed", "open"] as const;
/** single | VideoAssetRequirements.moov_atom_position */
export const VideoAssetRequirements_MoovAtomPositionValues = ["start", "end"] as const;
/** single | VideoAssetRequirements.scan_type */
export const VideoAssetRequirements_ScanTypeValues = ["progressive", "interlaced"] as const;
