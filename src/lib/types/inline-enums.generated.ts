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


// ====== AcceptancePolicyProfile ======

/** single | AcceptancePolicyProfile.coverage */
export const AcceptancePolicyProfile_CoverageValues = ["partial", "complete"] as const;

// ====== AcceptancePolicyRule ======

/** single | AcceptancePolicyRule.disposition */
export const AcceptancePolicyRule_DispositionValues = ["allowed", "conditional", "prohibited"] as const;

// ====== AccountChangeFeedSupported ======

/** single | AccountChangeFeedSupported.event_type */
export const AccountChangeFeedSupported_EventTypeValues = ["account.change_recorded"] as const;
/** single | AccountChangeFeedSupported.read_task */
export const AccountChangeFeedSupported_ReadTaskValues = ["list_account_changes"] as const;
/** single | AccountChangeFeedSupported.registration_task */
export const AccountChangeFeedSupported_RegistrationTaskValues = ["sync_accounts"] as const;

// ====== AccountIdentityChangeBlocked ======

/** single | AccountIdentityChangeBlocked.outcome */
export const AccountIdentityChangeBlocked_OutcomeValues = ["blocked"] as const;

// ====== AccountIdentityChangePending ======

/** single | AccountIdentityChangePending.status */
export const AccountIdentityChangePending_StatusValues = ["pending_approval"] as const;

// ====== AccountIdentityChangeRejected ======

/** single | AccountIdentityChangeRejected.status */
export const AccountIdentityChangeRejected_StatusValues = ["rejected"] as const;

// ====== AccountIdentityChangeWouldApply ======

/** single | AccountIdentityChangeWouldApply.outcome */
export const AccountIdentityChangeWouldApply_OutcomeValues = ["would_apply"] as const;

// ====== AccountIdentityChangeWouldRequireApproval ======

/** single | AccountIdentityChangeWouldRequireApproval.outcome */
export const AccountIdentityChangeWouldRequireApproval_OutcomeValues = ["would_require_approval"] as const;

// ====== AccountIdentityUpdatesSupported ======

/** array of | AccountIdentityUpdatesSupported.supported_changes */
export const AccountIdentityUpdatesSupported_SupportedChangesValues = ["operator_unit_name", "operator_unit", "operator"] as const;

// ====== AccountNotificationsSupported ======

/** array of | AccountNotificationsSupported.event_types */
export const AccountNotificationsSupported_EventTypesValues = ["account.status_changed"] as const;
/** single | AccountNotificationsSupported.read_task */
export const AccountNotificationsSupported_ReadTaskValues = ["list_accounts"] as const;

// ====== AccountStatusChangedWebhook ======

/** single | AccountStatusChangedWebhook.reason_code */
export const AccountStatusChangedWebhook_ReasonCodeValues = ["seller_approved", "seller_rejected", "payment_required", "credit_limit_reached", "funds_depleted", "setup_required", "policy_review", "policy_violation", "compliance_hold", "buyer_requested", "seller_closed", "manual_update", "other"] as const;

// ====== AccountTimezoneCapability ======

/** single | AccountTimezoneCapability.account_selection */
export const AccountTimezoneCapability_AccountSelectionValues = ["seller_assigned", "buyer_selected"] as const;
/** single | AccountTimezoneCapability.mode */
export const AccountTimezoneCapability_ModeValues = ["seller_fixed", "account_fixed"] as const;

// ====== AcquireRightsAcquired ======

/** single | AcquireRightsAcquired.rights_status */
export const AcquireRightsAcquired_RightsStatusValues = ["acquired"] as const;

// ====== ActivateSignalRequest ======

/** single | ActivateSignalRequest.action */
export const ActivateSignalRequest_ActionValues = ["activate", "deactivate"] as const;

// ====== AdCPAudienceSync ======

/** single | AdCPAudienceSync.pattern */
export const AdCPAudienceSync_PatternValues = ["sync_audiences"] as const;

// ====== AdCPExtensionFileSchema ======

/** single | AdCPExtensionFileSchema.$schema */
export const AdCPExtensionFileSchema_$schemaValues = ["http://json-schema.org/draft-07/schema#"] as const;
/** single | AdCPExtensionFileSchema.type */
export const AdCPExtensionFileSchema_TypeValues = ["object"] as const;

// ====== AgentEncryptionKey ======

/** single | AgentEncryptionKey.crv */
export const AgentEncryptionKey_CrvValues = ["X25519"] as const;
/** single | AgentEncryptionKey.kty */
export const AgentEncryptionKey_KtyValues = ["OKP"] as const;
/** single | AgentEncryptionKey.use */
export const AgentEncryptionKey_UseValues = ["enc"] as const;

// ====== AgentNotificationConfig ======

/** array of | AgentNotificationConfig.event_types */
export const AgentNotificationConfig_EventTypesValues = ["capabilities.changed"] as const;

// ====== AgentPermissionDeniedDetails ======

/** single | AgentPermissionDeniedDetails.reason */
export const AgentPermissionDeniedDetails_ReasonValues = ["sandbox_only"] as const;
/** single | AgentPermissionDeniedDetails.scope */
export const AgentPermissionDeniedDetails_ScopeValues = ["agent"] as const;

// ====== AgentPlacementFormatDeclaration ======

/** single | AgentPlacementFormatDeclaration.format_kind */
export const AgentPlacementFormatDeclaration_FormatKindValues = ["agent_placement"] as const;

// ====== AgentProfilePayload ======

/** single | AgentProfilePayload.type */
export const AgentProfilePayload_TypeValues = ["sales", "creative", "signals", "governance", "measurement", "unknown"] as const;

// ====== AgentWebhookChallenge ======

/** single | AgentWebhookChallenge.type */
export const AgentWebhookChallenge_TypeValues = ["webhook.challenge"] as const;

// ====== AppItem ======

/** single | AppItem.platform */
export const AppItem_PlatformValues = ["ios", "android"] as const;

// ====== AssetOutsideAcceptedVersionIntersection ======

/** single | AssetOutsideAcceptedVersionIntersection.mismatch_reason */
export const AssetOutsideAcceptedVersionIntersection_MismatchReasonValues = ["asset_outside_acceptance"] as const;

// ====== AssetPoolBinding ======

/** single | AssetPoolBinding.kind */
export const AssetPoolBinding_KindValues = ["asset_pool"] as const;

// ====== AssignOrUpdate ======

/** single | AssignOrUpdate.operation */
export const AssignOrUpdate_OperationValues = ["assign"] as const;

// ====== AttestationBrandIssuer ======

/** single | AttestationBrandIssuer.type */
export const AttestationBrandIssuer_TypeValues = ["brand"] as const;

// ====== AttestationCredentialUriLocator ======

/** single | AttestationCredentialUriLocator.type */
export const AttestationCredentialUriLocator_TypeValues = ["credential_uri"] as const;

// ====== AttestationEvaluation ======

/** single | AttestationEvaluation.outcome */
export const AttestationEvaluation_OutcomeValues = ["verified", "not_found", "expired", "revoked", "invalid", "unsupported", "unverifiable", "untrusted_issuer", "untrusted_resolver", "subject_mismatch", "digest_mismatch", "resolution_failed"] as const;

// ====== AttestationIssuerCredentialIdLocator ======

/** single | AttestationIssuerCredentialIdLocator.type */
export const AttestationIssuerCredentialIdLocator_TypeValues = ["issuer_credential_id"] as const;

// ====== AttestationOriginIssuer ======

/** single | AttestationOriginIssuer.type */
export const AttestationOriginIssuer_TypeValues = ["origin"] as const;

// ====== AttestationResourceSubject ======

/** single | AttestationResourceSubject.type */
export const AttestationResourceSubject_TypeValues = ["resource"] as const;

// ====== AudienceEvidence ======

/** single | AudienceEvidence.evidence_type */
export const AudienceEvidence_EvidenceTypeValues = ["measured", "forecast", "seller_declared"] as const;
/** single | AudienceEvidence.relationship */
export const AudienceEvidence_RelationshipValues = ["composition", "index", "reach_estimate"] as const;
/** single | AudienceEvidence.unit */
export const AudienceEvidence_UnitValues = ["fraction", "ratio", "count"] as const;

// ====== AudienceEvidenceRequirements ======

/** single | AudienceEvidenceRequirements.evidence_presence */
export const AudienceEvidenceRequirements_EvidencePresenceValues = ["required", "when_available"] as const;
/** single | AudienceEvidenceRequirements.requirement_mode */
export const AudienceEvidenceRequirements_RequirementModeValues = ["required", "preferred"] as const;

// ====== AudienceEvidenceSelection ======

/** single | AudienceEvidenceSelection.decision_use */
export const AudienceEvidenceSelection_DecisionUseValues = ["recommendation", "eligibility", "package_construction"] as const;

// ====== AudienceForecastDimension ======

/** single | AudienceForecastDimension.kind */
export const AudienceForecastDimension_KindValues = ["audience"] as const;

// ====== AudioAsset ======

/** single | AudioAsset.asset_type */
export const AudioAsset_AssetTypeValues = ["audio"] as const;

// ====== AudioAssetRequirements ======

/** array of | AudioAssetRequirements.channels */
export const AudioAssetRequirements_ChannelsValues = ["mono", "stereo"] as const;
/** array of | AudioAssetRequirements.formats */
export const AudioAssetRequirements_FormatsValues = ["mp3", "aac", "wav", "ogg", "flac"] as const;

// ====== AuthorizationPayload ======

/** single | AuthorizationPayload.authorization_type */
export const AuthorizationPayload_AuthorizationTypeValues = ["property_ids", "property_tags", "inline_properties", "publisher_properties", "signal_ids", "signal_tags"] as const;
/** single | AuthorizationPayload.delegation_type */
export const AuthorizationPayload_DelegationTypeValues = ["direct", "delegated", "ad_network"] as const;
/** single | AuthorizationPayload.evidence */
export const AuthorizationPayload_EvidenceValues = ["adagents_json", "agent_claim", "community", "override"] as const;

// ====== AuthorizationResult ======

/** single | AuthorizationResult.status */
export const AuthorizationResult_StatusValues = ["authorized", "unauthorized", "unknown"] as const;

// ====== BaseIndividualAsset ======

/** single | BaseIndividualAsset.item_type */
export const BaseIndividualAsset_ItemTypeValues = ["individual"] as const;

// ====== BillingNotSupportedDetails ======

/** single | BillingNotSupportedDetails.scope */
export const BillingNotSupportedDetails_ScopeValues = ["capability", "account"] as const;

// ====== BoxDecoration ======

/** single | BoxDecoration.kind */
export const BoxDecoration_KindValues = ["box"] as const;

// ====== BriefAsset ======

/** single | BriefAsset.asset_type */
export const BriefAsset_AssetTypeValues = ["brief"] as const;
/** single | BriefAsset.objective */
export const BriefAsset_ObjectiveValues = ["awareness", "consideration", "conversion", "retention", "engagement"] as const;

// ====== BuildCreativeAsyncInputRequired ======

/** single | BuildCreativeAsyncInputRequired.reason */
export const BuildCreativeAsyncInputRequired_ReasonValues = ["APPROVAL_REQUIRED", "CREATIVE_DIRECTION_NEEDED", "ASSET_SELECTION_NEEDED"] as const;

// ====== BuildCreativeAsyncSubmitted ======

/** single | BuildCreativeAsyncSubmitted.status */
export const BuildCreativeAsyncSubmitted_StatusValues = ["submitted"] as const;

// ====== BuildCreativeEstimate ======

/** single | BuildCreativeEstimate.mode */
export const BuildCreativeEstimate_ModeValues = ["estimate"] as const;

// ====== BuildCreativeRequest ======

/** single | BuildCreativeRequest.keep_mode */
export const BuildCreativeRequest_KeepModeValues = ["keep_all", "keep_one", "keep_some"] as const;
/** single | BuildCreativeRequest.mode */
export const BuildCreativeRequest_ModeValues = ["execute", "estimate"] as const;

// ====== BuildCreativeVariantSuccess ======

/** single | BuildCreativeVariantSuccess.budget_status */
export const BuildCreativeVariantSuccess_BudgetStatusValues = ["complete", "capped"] as const;

// ====== CanonicalFormatAgentPlacementAISurfaceSponsoredPlacement ======

/** single | CanonicalFormatAgentPlacementAISurfaceSponsoredPlacement.composition_model */
export const CanonicalFormatAgentPlacementAISurfaceSponsoredPlacement_CompositionModelValues = ["deterministic", "algorithmic"] as const;
/** single | CanonicalFormatAgentPlacementAISurfaceSponsoredPlacement.output_modality */
export const CanonicalFormatAgentPlacementAISurfaceSponsoredPlacement_OutputModalityValues = ["text", "audio", "card"] as const;
/** single | CanonicalFormatAgentPlacementAISurfaceSponsoredPlacement.reference_mutability */
export const CanonicalFormatAgentPlacementAISurfaceSponsoredPlacement_ReferenceMutabilityValues = ["immutable_snapshot", "mutable_requires_reapproval", "mutable_auto_recheck"] as const;

// ====== CanonicalFormatDisplayTag ======

/** array of | CanonicalFormatDisplayTag.supported_delivery_types */
export const CanonicalFormatDisplayTag_SupportedDeliveryTypesValues = ["tag_url", "inline_markup", "paired_redirect"] as const;
/** array of | CanonicalFormatDisplayTag.supported_tag_types */
export const CanonicalFormatDisplayTag_SupportedTagTypesValues = ["iframe", "javascript", "1x1_redirect"] as const;

// ====== CanonicalFormatHostedAudio ======

/** single | CanonicalFormatHostedAudio.asset_source */
export const CanonicalFormatHostedAudio_AssetSourceValues = ["buyer_uploaded", "publisher_host_recorded", "seller_pre_rendered_from_brief", "seller_human_designed", "agent_synthesized", "publisher_owned_reference"] as const;
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
/** single | CanonicalFormatImage.motion_level */
export const CanonicalFormatImage_MotionLevelValues = ["static", "limited_motion"] as const;

// ====== CanonicalFormatImageCarousel ======

/** array of | CanonicalFormatImageCarousel.allowed_card_asset_types */
export const CanonicalFormatImageCarousel_AllowedCardAssetTypesValues = ["image", "video"] as const;

// ====== CanonicalFormatNativeInFeed ======

/** single | CanonicalFormatNativeInFeed.asset_source */
export const CanonicalFormatNativeInFeed_AssetSourceValues = ["buyer_uploaded", "seller_pre_rendered_from_brief", "seller_human_designed", "agent_synthesized", "publisher_owned_reference"] as const;
/** single | CanonicalFormatNativeInFeed.focus_behavior */
export const CanonicalFormatNativeInFeed_FocusBehaviorValues = ["none", "autoplay_muted", "autoplay_sound"] as const;
/** array of | CanonicalFormatNativeInFeed.image_formats */
export const CanonicalFormatNativeInFeed_ImageFormatsValues = ["jpg", "jpeg", "png", "gif", "webp"] as const;
/** single | CanonicalFormatNativeInFeed.menu_placement */
export const CanonicalFormatNativeInFeed_MenuPlacementValues = ["tile", "headline_banner"] as const;

// ====== CanonicalFormatOption ======

/** single | CanonicalFormatOption.seller_preference */
export const CanonicalFormatOption_SellerPreferenceValues = ["preferred", "accepted", "discouraged"] as const;

// ====== CanonicalFormatSponsoredPlacementRetailMediaCatalogDriven ======

/** single | CanonicalFormatSponsoredPlacementRetailMediaCatalogDriven.fanout_mode */
export const CanonicalFormatSponsoredPlacementRetailMediaCatalogDriven_FanoutModeValues = ["per_item", "multi_item_in_creative", "single_item"] as const;
/** single | CanonicalFormatSponsoredPlacementRetailMediaCatalogDriven.item_production_model */
export const CanonicalFormatSponsoredPlacementRetailMediaCatalogDriven_ItemProductionModelValues = ["buyer_uploaded", "seller_pre_rendered_from_brief", "seller_human_designed", "agent_synthesized"] as const;
/** array of | CanonicalFormatSponsoredPlacementRetailMediaCatalogDriven.supported_id_types */
export const CanonicalFormatSponsoredPlacementRetailMediaCatalogDriven_SupportedIdTypesValues = ["asin", "sku", "gtin", "offering_id", "store_id", "hotel_id", "flight_id", "vehicle_id", "listing_id", "program_id", "destination_id", "app_id", "job_id"] as const;

// ====== CanonicalFormatTarget ======

/** single | CanonicalFormatTarget.kind */
export const CanonicalFormatTarget_KindValues = ["canonical"] as const;

// ====== CanonicalFormatVASTVideo ======

/** single | CanonicalFormatVASTVideo.creative_type */
export const CanonicalFormatVASTVideo_CreativeTypeValues = ["linear", "nonlinear", "either"] as const;
/** single | CanonicalFormatVASTVideo.vpaid_version */
export const CanonicalFormatVASTVideo_VpaidVersionValues = ["1.0", "2.0"] as const;

// ====== CanonicalMediaBuyAction ======

/** single | CanonicalMediaBuyAction.task */
export const CanonicalMediaBuyAction_TaskValues = ["control_media_buy", "refine_proposals", "sync_creatives"] as const;

// ====== CanonicalProposal ======

/** single | CanonicalProposal.proposal_kind */
export const CanonicalProposal_ProposalKindValues = ["new_media_buy", "media_buy_update", "media_buy_cancellation"] as const;

// ====== CanonicalReportingCapabilities ======

/** single | CanonicalReportingCapabilities.date_range_support */
export const CanonicalReportingCapabilities_DateRangeSupportValues = ["date_range", "lifetime_only"] as const;

// ====== CanvasConstraint ======

/** single | CanvasConstraint.constraint */
export const CanvasConstraint_ConstraintValues = ["safe_area", "reserved_region", "decoration_only_edge", "no_text_or_logos"] as const;

// ====== CapabilitiesChangedWebhook ======

/** single | CapabilitiesChangedWebhook.reason */
export const CapabilitiesChangedWebhook_ReasonValues = ["configuration_changed", "deployment_changed", "capability_enabled", "capability_disabled", "protocol_versions_changed", "manual_refresh", "other"] as const;

// ====== CapabilityChangeNotificationsSupported ======

/** single | CapabilityChangeNotificationsSupported.registration_task */
export const CapabilityChangeNotificationsSupported_RegistrationTaskValues = ["sync_agent_notification_configs"] as const;

// ====== CardAsset ======

/** single | CardAsset.asset_type */
export const CardAsset_AssetTypeValues = ["card"] as const;

// ====== CatalogAsset ======

/** single | CatalogAsset.asset_type */
export const CatalogAsset_AssetTypeValues = ["catalog"] as const;

// ====== CatalogFieldMapping ======

/** single | CatalogFieldMapping.transform */
export const CatalogFieldMapping_TransformValues = ["date", "divide", "boolean", "split"] as const;

// ====== CatalogItemAvailabilityError ======

/** single | CatalogItemAvailabilityError.recovery */
export const CatalogItemAvailabilityError_RecoveryValues = ["transient", "correctable", "terminal"] as const;
/** single | CatalogItemAvailabilityError.source */
export const CatalogItemAvailabilityError_SourceValues = ["producer", "sdk"] as const;

// ====== CatalogItemAvailabilityState ======

/** single | CatalogItemAvailabilityState.availability */
export const CatalogItemAvailabilityState_AvailabilityValues = ["active", "suppressed"] as const;
/** single | CatalogItemAvailabilityState.status */
export const CatalogItemAvailabilityState_StatusValues = ["found", "failed"] as const;

// ====== CatalogItemAvailabilityUpdate ======

/** single | CatalogItemAvailabilityUpdate.action */
export const CatalogItemAvailabilityUpdate_ActionValues = ["suppress", "restore"] as const;
/** single | CatalogItemAvailabilityUpdate.reason */
export const CatalogItemAvailabilityUpdate_ReasonValues = ["out_of_stock", "back_in_stock", "content_unavailable", "content_available", "promotion_start", "promotion_end", "time_window_started", "time_window_expired", "buyer_request", "other"] as const;

// ====== CatalogItemAvailabilityUpdateResult ======

/** single | CatalogItemAvailabilityUpdateResult.status */
export const CatalogItemAvailabilityUpdateResult_StatusValues = ["applied", "unchanged", "failed"] as const;

// ====== CatalogItemReferenceNotFoundError ======

/** single | CatalogItemReferenceNotFoundError.code */
export const CatalogItemReferenceNotFoundError_CodeValues = ["REFERENCE_NOT_FOUND"] as const;
/** single | CatalogItemReferenceNotFoundError.message */
export const CatalogItemReferenceNotFoundError_MessageValues = ["Catalog item not found"] as const;
/** single | CatalogItemReferenceNotFoundError.recovery */
export const CatalogItemReferenceNotFoundError_RecoveryValues = ["correctable"] as const;

// ====== CheckGovernanceResponse ======

/** single | CheckGovernanceResponse.check_type */
export const CheckGovernanceResponse_CheckTypeValues = ["intent", "execution"] as const;

// ====== CleanRoom ======

/** single | CleanRoom.pattern */
export const CleanRoom_PatternValues = ["clean_room"] as const;

// ====== CollectionListApplication ======

/** single | CollectionListApplication.effect */
export const CollectionListApplication_EffectValues = ["include", "exclude"] as const;
/** single | CollectionListApplication.list_type */
export const CollectionListApplication_ListTypeValues = ["collection"] as const;

// ====== CollectionListChangedWebhook ======

/** single | CollectionListChangedWebhook.event */
export const CollectionListChangedWebhook_EventValues = ["collection_list_changed"] as const;

// ====== CollectionPayload ======

/** single | CollectionPayload.status */
export const CollectionPayload_StatusValues = ["active", "stale", "removed"] as const;

// ====== CommitmentError ======

/** single | CommitmentError.status */
export const CommitmentError_StatusValues = ["failed"] as const;

// ====== CommittedMediaBuy ======

/** single | CommittedMediaBuy.status */
export const CommittedMediaBuy_StatusValues = ["completed"] as const;

// ====== CompatibilityPurchaseCoordinatorInput ======

/** array of | CompatibilityPurchaseCoordinatorInput.accepted_losses */
export const CompatibilityPurchaseCoordinatorInput_AcceptedLossesValues = ["feed_version_not_atomic", "pricing_version_not_atomic", "mutation_idempotency_not_guaranteed"] as const;

// ====== ContextMatchRequest ======

/** single | ContextMatchRequest.type */
export const ContextMatchRequest_TypeValues = ["context_match_request"] as const;

// ====== ContextMatchResponse ======

/** single | ContextMatchResponse.type */
export const ContextMatchResponse_TypeValues = ["context_match_response"] as const;

// ====== ControllerError ======

/** single | ControllerError.error */
export const ControllerError_ErrorValues = ["INVALID_TRANSITION", "INVALID_STATE", "NOT_FOUND", "UNKNOWN_SCENARIO", "INVALID_PARAMS", "FORBIDDEN", "JCS_NON_FINITE_NUMBER", "INTERNAL_ERROR"] as const;

// ====== CoordinatedPlacementsFormatDeclaration ======

/** single | CoordinatedPlacementsFormatDeclaration.format_kind */
export const CoordinatedPlacementsFormatDeclaration_FormatKindValues = ["coordinated_placements"] as const;

// ====== CPAPricingOption ======

/** single | CPAPricingOption.pricing_model */
export const CPAPricingOption_PricingModelValues = ["cpa"] as const;

// ====== CPCPricingOption ======

/** single | CPCPricingOption.pricing_model */
export const CPCPricingOption_PricingModelValues = ["cpc"] as const;

// ====== CPCVPricingOption ======

/** single | CPCVPricingOption.pricing_model */
export const CPCVPricingOption_PricingModelValues = ["cpcv"] as const;

// ====== CpmPricing ======

/** single | CpmPricing.model */
export const CpmPricing_ModelValues = ["cpm"] as const;

// ====== CPPPricingOption ======

/** single | CPPPricingOption.pricing_model */
export const CPPPricingOption_PricingModelValues = ["cpp"] as const;

// ====== CPVPricingOption ======

/** single | CPVPricingOption.pricing_model */
export const CPVPricingOption_PricingModelValues = ["cpv"] as const;

// ====== CreateMediaBuyAsyncInputRequired ======

/** single | CreateMediaBuyAsyncInputRequired.reason */
export const CreateMediaBuyAsyncInputRequired_ReasonValues = ["APPROVAL_REQUIRED", "BUDGET_EXCEEDS_LIMIT"] as const;

// ====== CreativeApproved ======

/** single | CreativeApproved.approval_status */
export const CreativeApproved_ApprovalStatusValues = ["approved"] as const;

// ====== CreativeAssignment ======

/** single | CreativeAssignment.rotation_mode */
export const CreativeAssignment_RotationModeValues = ["weighted", "even", "sequential", "random"] as const;

// ====== CreativeAssignmentChangedWebhook ======

/** single | CreativeAssignmentChangedWebhook.change_kind */
export const CreativeAssignmentChangedWebhook_ChangeKindValues = ["assigned", "unassigned", "approval_changed"] as const;
/** single | CreativeAssignmentChangedWebhook.notification_type */
export const CreativeAssignmentChangedWebhook_NotificationTypeValues = ["creative.assignment_changed"] as const;

// ====== CreativeAuditObservation ======

/** single | CreativeAuditObservation.code */
export const CreativeAuditObservation_CodeValues = ["OVERSIGHT_DISCLOSURE_CARVEOUT_CLAIMED"] as const;
/** single | CreativeAuditObservation.recovery */
export const CreativeAuditObservation_RecoveryValues = ["informational"] as const;
/** single | CreativeAuditObservation.severity */
export const CreativeAuditObservation_SeverityValues = ["audit-worthy"] as const;

// ====== CreativeCapabilityTarget ======

/** single | CreativeCapabilityTarget.kind */
export const CreativeCapabilityTarget_KindValues = ["capability"] as const;

// ====== CreativeLocalization ======

/** single | CreativeLocalization.unmatched_locale_action */
export const CreativeLocalization_UnmatchedLocaleActionValues = ["serve_default", "do_not_serve"] as const;

// ====== CreativeLocalizationReadback ======

/** single | CreativeLocalizationReadback.locale_matching */
export const CreativeLocalizationReadback_LocaleMatchingValues = ["rfc4647_lookup"] as const;

// ====== CreativePendingReview ======

/** single | CreativePendingReview.approval_status */
export const CreativePendingReview_ApprovalStatusValues = ["pending_review"] as const;

// ====== CreativePurgedWebhook ======

/** single | CreativePurgedWebhook.initiator */
export const CreativePurgedWebhook_InitiatorValues = ["seller", "system"] as const;
/** single | CreativePurgedWebhook.notification_type */
export const CreativePurgedWebhook_NotificationTypeValues = ["creative.purged"] as const;
/** single | CreativePurgedWebhook.purge_kind */
export const CreativePurgedWebhook_PurgeKindValues = ["soft", "hard"] as const;

// ====== CreativeStatusChangedWebhook ======

/** single | CreativeStatusChangedWebhook.notification_type */
export const CreativeStatusChangedWebhook_NotificationTypeValues = ["creative.status_changed"] as const;

// ====== CreativeVariable ======

/** single | CreativeVariable.variable_type */
export const CreativeVariable_VariableTypeValues = ["text", "image", "video", "audio", "url", "number", "boolean", "color", "date"] as const;

// ====== CSSAsset ======

/** single | CSSAsset.asset_type */
export const CSSAsset_AssetTypeValues = ["css"] as const;

// ====== CustomFormatDeclaration ======

/** single | CustomFormatDeclaration.format_kind */
export const CustomFormatDeclaration_FormatKindValues = ["custom"] as const;

// ====== DAASTAudioFormatDeclaration ======

/** single | DAASTAudioFormatDeclaration.format_kind */
export const DAASTAudioFormatDeclaration_FormatKindValues = ["audio_daast"] as const;

// ====== DAASTTrackerAsset ======

/** single | DAASTTrackerAsset.asset_type */
export const DAASTTrackerAsset_AssetTypeValues = ["daast_tracker"] as const;
/** single | DAASTTrackerAsset.target */
export const DAASTTrackerAsset_TargetValues = ["linear", "companion"] as const;

// ====== DAASTTrackerConstraints ======

/** single | DAASTTrackerConstraints.daast_event */
export const DAASTTrackerConstraints_DaastEventValues = ["creativeView", "start", "firstQuartile", "midpoint", "thirdQuartile", "complete", "mute", "unmute", "pause", "resume", "rewind", "skip", "progress", "close"] as const;

// ====== Dataset ======

/** single | Dataset.kind */
export const Dataset_KindValues = ["dataset"] as const;

// ====== DatasetQuery ======

/** single | DatasetQuery.pattern */
export const DatasetQuery_PatternValues = ["dataset_query"] as const;

// ====== DestinationItem ======

/** single | DestinationItem.destination_type */
export const DestinationItem_DestinationTypeValues = ["beach", "mountain", "urban", "cultural", "adventure", "wellness", "cruise"] as const;

// ====== DevicePlatformForecastDimension ======

/** single | DevicePlatformForecastDimension.kind */
export const DevicePlatformForecastDimension_KindValues = ["device_platform"] as const;

// ====== DeviceTypeForecastDimension ======

/** single | DeviceTypeForecastDimension.kind */
export const DeviceTypeForecastDimension_KindValues = ["device_type"] as const;

// ====== DiagnosticIssue ======

/** single | DiagnosticIssue.severity */
export const DiagnosticIssue_SeverityValues = ["error", "warning", "info"] as const;

// ====== DigestAttestation ======

/** single | DigestAttestation.attestation_mode */
export const DigestAttestation_AttestationModeValues = ["digest"] as const;
/** single | DigestAttestation.method */
export const DigestAttestation_MethodValues = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;
/** single | DigestAttestation.purpose */
export const DigestAttestation_PurposeValues = ["platform_primary", "measurement", "attribution", "creative_serving", "identity", "other"] as const;

// ====== DirectIdentifiersSource ======

/** single | DirectIdentifiersSource.selection_type */
export const DirectIdentifiersSource_SelectionTypeValues = ["identifiers"] as const;

// ====== DisplayTagFormatDeclaration ======

/** single | DisplayTagFormatDeclaration.format_kind */
export const DisplayTagFormatDeclaration_FormatKindValues = ["display_tag"] as const;

// ====== DistributionIDsSource ======

/** single | DistributionIDsSource.selection_type */
export const DistributionIDsSource_SelectionTypeValues = ["distribution_ids"] as const;

// ====== DoohParameters ======

/** single | DoohParameters.type */
export const DoohParameters_TypeValues = ["dooh"] as const;

// ====== DownstreamConnectionRequirement ======

/** single | DownstreamConnectionRequirement.connection_type */
export const DownstreamConnectionRequirement_ConnectionTypeValues = ["advertiser_account", "publisher_identity", "post_authorization"] as const;
/** single | DownstreamConnectionRequirement.scope */
export const DownstreamConnectionRequirement_ScopeValues = ["account", "identity", "post", "unknown"] as const;
/** single | DownstreamConnectionRequirement.status */
export const DownstreamConnectionRequirement_StatusValues = ["connected", "missing", "pending", "expired", "revoked", "not_required", "unknown"] as const;

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

// ====== EventSurface ======

/** single | EventSurface.category */
export const EventSurface_CategoryValues = ["owned_property", "website", "app", "offline", "phone_call", "chat", "email", "in_store", "system_generated", "other"] as const;

// ====== FileTransfer ======

/** single | FileTransfer.pattern */
export const FileTransfer_PatternValues = ["file_transfer"] as const;

// ====== FlatFeePricing ======

/** single | FlatFeePricing.model */
export const FlatFeePricing_ModelValues = ["flat_fee"] as const;
/** single | FlatFeePricing.period */
export const FlatFeePricing_PeriodValues = ["monthly", "quarterly", "annual", "campaign"] as const;

// ====== FlatRatePricingOption ======

/** single | FlatRatePricingOption.pricing_model */
export const FlatRatePricingOption_PricingModelValues = ["flat_rate"] as const;

// ====== GeoForecastDimension ======

/** single | GeoForecastDimension.kind */
export const GeoForecastDimension_KindValues = ["geo"] as const;

// ====== GeographicPlaceCatalogEntry ======

/** single | GeographicPlaceCatalogEntry.status */
export const GeographicPlaceCatalogEntry_StatusValues = ["active", "removal_planned", "deprecated"] as const;

// ====== GeographicPlaceResolver ======

/** single | GeographicPlaceResolver.auth */
export const GeographicPlaceResolver_AuthValues = ["none", "seller_credentials"] as const;
/** single | GeographicPlaceResolver.protocol */
export const GeographicPlaceResolver_ProtocolValues = ["adcp_geo_place_resolver_v1"] as const;

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

// ====== GetMediaBuysResponseMediaBuy ======

/** array of | GetMediaBuysResponseMediaBuy.indicator_types_evaluated */
export const GetMediaBuysResponseMediaBuy_IndicatorTypesEvaluatedValues = ["budget_constrained"] as const;

// ====== GetProductsAsyncInputRequired ======

/** single | GetProductsAsyncInputRequired.reason */
export const GetProductsAsyncInputRequired_ReasonValues = ["CLARIFICATION_NEEDED", "BUDGET_REQUIRED"] as const;

// ====== GetProductsCompletion ======

/** single | GetProductsCompletion.cache_scope */
export const GetProductsCompletion_CacheScopeValues = ["public", "account"] as const;

// ====== GetProductsRequest ======

/** single | GetProductsRequest.buying_mode */
export const GetProductsRequest_BuyingModeValues = ["brief", "wholesale", "refine"] as const;
/** array of | GetProductsRequest.fields */
export const GetProductsRequest_FieldsValues = ["product_id", "name", "description", "publisher_properties", "channels", "video_placement_types", "audio_distribution_types", "sponsored_placement_types", "social_placement_surfaces", "format_options", "placements", "delivery_type", "exclusivity", "pricing_options", "forecast", "reporting_capabilities", "measurement_terms", "performance_standards", "catalog_types", "signal_targeting_allowed", "signal_targeting_rules", "demographic_targeting", "audience_evidence", "audience_evidence_selections", "max_optimization_goals", "catalog_match", "list_applications", "brief_relevance", "acceptance_policy_profile_ids", "expires_at", "allowed_actions", "format_ids", "outcome_measurement", "delivery_measurement", "creative_policy", "metric_optimization", "conversion_tracking", "data_provider_signals", "included_signals", "signal_targeting_options", "overlay_support", "targeting_resolution", "collections", "collection_targeting_allowed", "installments", "is_custom", "product_card", "product_card_detailed", "enforced_policies", "trusted_match"] as const;

// ====== GetSignalsRequest ======

/** single | GetSignalsRequest.discovery_mode */
export const GetSignalsRequest_DiscoveryModeValues = ["brief", "wholesale"] as const;
/** array of | GetSignalsRequest.fields */
export const GetSignalsRequest_FieldsValues = ["signal_ref", "signal_id", "signal_agent_segment_id", "name", "description", "value_type", "categories", "range", "demographic_predicate", "signal_type", "data_provider", "coverage_percentage", "deployments", "pricing_options", "taxonomy", "data_sources", "methodology", "segmentation_criteria", "criteria_url", "refresh_cadence", "lookback_window", "onboarder", "modeling", "audience_expansion", "device_expansion", "countries", "consent_basis", "restricted_attributes", "policy_categories", "art9_basis", "data_subject_rights", "last_updated"] as const;

// ====== GroupDaastAsset ======

/** single | GroupDaastAsset.asset_type */
export const GroupDaastAsset_AssetTypeValues = ["daast"] as const;

// ====== GroupHtmlAsset ======

/** single | GroupHtmlAsset.asset_type */
export const GroupHtmlAsset_AssetTypeValues = ["html"] as const;

// ====== GroupImageAsset ======

/** single | GroupImageAsset.asset_type */
export const GroupImageAsset_AssetTypeValues = ["image"] as const;

// ====== GroupJavaScriptAsset ======

/** single | GroupJavaScriptAsset.asset_type */
export const GroupJavaScriptAsset_AssetTypeValues = ["javascript"] as const;

// ====== GroupMarkdownAsset ======

/** single | GroupMarkdownAsset.asset_type */
export const GroupMarkdownAsset_AssetTypeValues = ["markdown"] as const;

// ====== GroupTextAsset ======

/** single | GroupTextAsset.asset_type */
export const GroupTextAsset_AssetTypeValues = ["text"] as const;

// ====== GroupUrlAsset ======

/** single | GroupUrlAsset.asset_type */
export const GroupUrlAsset_AssetTypeValues = ["url"] as const;

// ====== GroupVastAsset ======

/** single | GroupVastAsset.asset_type */
export const GroupVastAsset_AssetTypeValues = ["vast"] as const;

// ====== GroupVideoAsset ======

/** single | GroupVideoAsset.asset_type */
export const GroupVideoAsset_AssetTypeValues = ["video"] as const;

// ====== GroupWebhookAsset ======

/** single | GroupWebhookAsset.asset_type */
export const GroupWebhookAsset_AssetTypeValues = ["webhook"] as const;

// ====== HostedAudioFormatDeclaration ======

/** single | HostedAudioFormatDeclaration.format_kind */
export const HostedAudioFormatDeclaration_FormatKindValues = ["audio_hosted"] as const;

// ====== HostedVideoFormatDeclaration ======

/** single | HostedVideoFormatDeclaration.format_kind */
export const HostedVideoFormatDeclaration_FormatKindValues = ["video_hosted"] as const;

// ====== HTML5FormatDeclaration ======

/** single | HTML5FormatDeclaration.format_kind */
export const HTML5FormatDeclaration_FormatKindValues = ["html5"] as const;

// ====== HTMLAssetRequirements ======

/** single | HTMLAssetRequirements.sandbox */
export const HTMLAssetRequirements_SandboxValues = ["none", "iframe", "safeframe", "fencedframe"] as const;

// ====== IdentityMatchRequest ======

/** single | IdentityMatchRequest.type */
export const IdentityMatchRequest_TypeValues = ["identity_match_request"] as const;

// ====== IdentityMatchResponse ======

/** single | IdentityMatchResponse.type */
export const IdentityMatchResponse_TypeValues = ["identity_match_response"] as const;

// ====== ImageAssetRequirements ======

/** single | ImageAssetRequirements.color_space */
export const ImageAssetRequirements_ColorSpaceValues = ["rgb", "cmyk", "grayscale"] as const;
/** array of | ImageAssetRequirements.formats */
export const ImageAssetRequirements_FormatsValues = ["jpg", "jpeg", "png", "gif", "webp", "svg", "avif", "tiff", "pdf", "eps"] as const;

// ====== ImageCarouselFormatDeclaration ======

/** single | ImageCarouselFormatDeclaration.format_kind */
export const ImageCarouselFormatDeclaration_FormatKindValues = ["image_carousel"] as const;

// ====== ImageDecoration ======

/** single | ImageDecoration.fit */
export const ImageDecoration_FitValues = ["contain", "cover", "stretch"] as const;

// ====== Impact ======

/** single | Impact.area */
export const Impact_AreaValues = ["account_id", "media_buys", "reporting", "approval", "billing", "grants", "other"] as const;
/** single | Impact.effect */
export const Impact_EffectValues = ["preserved", "revalidation_required", "revoke_and_regrant", "blocked"] as const;

// ====== Impairment ======

/** single | Impairment.resource_type */
export const Impairment_ResourceTypeValues = ["audience", "creative", "catalog_item", "event_source", "property"] as const;

// ====== InlineMarkup ======

/** single | InlineMarkup.delivery_type */
export const InlineMarkup_DeliveryTypeValues = ["inline_markup"] as const;
/** single | InlineMarkup.markup_type */
export const InlineMarkup_MarkupTypeValues = ["iframe_javascript", "javascript", "standard"] as const;

// ====== InspectedDocumentVersionMismatch ======

/** single | InspectedDocumentVersionMismatch.mismatch_reason */
export const InspectedDocumentVersionMismatch_MismatchReasonValues = ["document_version_mismatch"] as const;

// ====== JavaScriptAssetRequirements ======

/** single | JavaScriptAssetRequirements.module_type */
export const JavaScriptAssetRequirements_ModuleTypeValues = ["script", "module", "iife"] as const;

// ====== JobItem ======

/** single | JobItem.employment_type */
export const JobItem_EmploymentTypeValues = ["full_time", "part_time", "contract", "temporary", "internship", "freelance"] as const;
/** single | JobItem.experience_level */
export const JobItem_ExperienceLevelValues = ["entry_level", "mid_level", "senior", "director", "executive"] as const;

// ====== ListAccountChangesRequest ======

/** single | ListAccountChangesRequest.starting_position */
export const ListAccountChangesRequest_StartingPositionValues = ["earliest", "latest"] as const;

// ====== ListCreativeFormatsResponse ======

/** single | ListCreativeFormatsResponse.source */
export const ListCreativeFormatsResponse_SourceValues = ["publisher", "aao_mirror", "agent_derived"] as const;

// ====== ListCreativesRequest ======

/** single | ListCreativesRequest.assignment_projection */
export const ListCreativesRequest_AssignmentProjectionValues = ["all", "matching"] as const;
/** array of | ListCreativesRequest.fields */
export const ListCreativesRequest_FieldsValues = ["creative_id", "name", "format_id", "format_kind", "format_option_ref", "assets", "status", "created_date", "updated_date", "tags", "rights", "rights_attestation_evaluations", "localization", "localization_unavailable", "assignments", "snapshot", "items", "variables", "concept", "pricing_options"] as const;

// ====== MacroDeclaration ======

/** single | MacroDeclaration.unavailable_behavior */
export const MacroDeclaration_UnavailableBehaviorValues = ["preserve", "omit_parameter", "dialect_sentinel", "reject"] as const;

// ====== MacroEncoding ======

/** single | MacroEncoding.kind */
export const MacroEncoding_KindValues = ["none", "rfc3986", "iab_vast_uri"] as const;

// ====== MacroProcessingCapability ======

/** single | MacroProcessingCapability.mapping_status */
export const MacroProcessingCapability_MappingStatusValues = ["verified_universal", "dialect_defined"] as const;
/** single | MacroProcessingCapability.operation */
export const MacroProcessingCapability_OperationValues = ["translate_to_native", "resolve_value"] as const;

// ====== MacroResolutionResult ======

/** single | MacroResolutionResult.status */
export const MacroResolutionResult_StatusValues = ["resolvable", "preserved_for_downstream", "unsupported", "ambiguous"] as const;

// ====== MacroTranslationTarget ======

/** single | MacroTranslationTarget.next_operation */
export const MacroTranslationTarget_NextOperationValues = ["resolve_value"] as const;

// ====== MaxBidWithCostPer ======

/** single | MaxBidWithCostPer.kind */
export const MaxBidWithCostPer_KindValues = ["max_bid_with_cost_per"] as const;

// ====== MaxBidWithRoas ======

/** single | MaxBidWithRoas.kind */
export const MaxBidWithRoas_KindValues = ["max_bid_with_roas"] as const;

// ====== NativeInFeedFormatDeclaration ======

/** single | NativeInFeedFormatDeclaration.format_kind */
export const NativeInFeedFormatDeclaration_FormatKindValues = ["native_in_feed"] as const;

// ====== NotificationConfig ======

/** single | NotificationConfig.product_payload_view */
export const NotificationConfig_ProductPayloadViewValues = ["canonical", "legacy"] as const;

// ====== OfferPrice ======

/** single | OfferPrice.model */
export const OfferPrice_ModelValues = ["cpm", "cpc", "cpcv", "cpa", "flat"] as const;

// ====== OpportunityContext ======

/** single | OpportunityContext.close_reason */
export const OpportunityContext_CloseReasonValues = ["accepted_with_seller", "purchased_elsewhere", "selected_alternative", "not_pursued", "budget_changed", "timing_changed", "other"] as const;
/** single | OpportunityContext.intent */
export const OpportunityContext_IntentValues = ["test", "speculative", "planning", "live_rfp"] as const;
/** single | OpportunityContext.phase */
export const OpportunityContext_PhaseValues = ["exploratory", "planning", "active_sourcing"] as const;

// ====== PackageSignalTargetingGroup ======

/** single | PackageSignalTargetingGroup.operator */
export const PackageSignalTargetingGroup_OperatorValues = ["any", "none"] as const;

// ====== PackageSignalTargetingGroups ======

/** single | PackageSignalTargetingGroups.operator */
export const PackageSignalTargetingGroups_OperatorValues = ["all"] as const;

// ====== PackageStatus ======

/** array of | PackageStatus.indicator_types_evaluated */
export const PackageStatus_IndicatorTypesEvaluatedValues = ["creative_diversity_low", "audience_saturation", "inventory_shortfall_forecast", "pacing_risk", "budget_constrained"] as const;

// ====== PairedRedirect ======

/** single | PairedRedirect.delivery_type */
export const PairedRedirect_DeliveryTypeValues = ["paired_redirect"] as const;

// ====== PercentOfMediaPricing ======

/** single | PercentOfMediaPricing.model */
export const PercentOfMediaPricing_ModelValues = ["percent_of_media"] as const;

// ====== PerformanceFeedback ======

/** single | PerformanceFeedback.status */
export const PerformanceFeedback_StatusValues = ["accepted", "queued", "applied", "rejected"] as const;

// ====== PerUnitPricing ======

/** single | PerUnitPricing.model */
export const PerUnitPricing_ModelValues = ["per_unit"] as const;

// ====== PixelTrackerAsset ======

/** single | PixelTrackerAsset.asset_type */
export const PixelTrackerAsset_AssetTypeValues = ["pixel_tracker"] as const;
/** single | PixelTrackerAsset.method */
export const PixelTrackerAsset_MethodValues = ["img", "js"] as const;

// ====== PlacementForecastDimension ======

/** single | PlacementForecastDimension.kind */
export const PlacementForecastDimension_KindValues = ["placement"] as const;

// ====== PlacementPresentationDocument ======

/** single | PlacementPresentationDocument.schema_version */
export const PlacementPresentationDocument_SchemaVersionValues = ["1.0"] as const;

// ====== PlacementPresentationReference ======

/** single | PlacementPresentationReference.media_type */
export const PlacementPresentationReference_MediaTypeValues = ["application/vnd.adcp.placement-presentation+json"] as const;

// ====== PlatformDistribution ======

/** single | PlatformDistribution.pattern */
export const PlatformDistribution_PatternValues = ["platform_distribution"] as const;

// ====== PlatformSegment ======

/** single | PlatformSegment.kind */
export const PlatformSegment_KindValues = ["platform_segment"] as const;

// ====== PolicyEntry ======

/** single | PolicyEntry.source */
export const PolicyEntry_SourceValues = ["registry", "inline"] as const;

// ====== PolicyViolationDetails ======

/** single | PolicyViolationDetails.origin */
export const PolicyViolationDetails_OriginValues = ["buyer_plan", "registry", "seller"] as const;

// ====== PostalAreaSupport ======

/** array of | PostalAreaSupport.AT */
export const PostalAreaSupport_ATValues = ["plz"] as const;
/** array of | PostalAreaSupport.AU */
export const PostalAreaSupport_AUValues = ["postcode"] as const;
/** array of | PostalAreaSupport.BR */
export const PostalAreaSupport_BRValues = ["cep"] as const;
/** array of | PostalAreaSupport.FR */
export const PostalAreaSupport_FRValues = ["code_postal"] as const;
/** array of | PostalAreaSupport.IN */
export const PostalAreaSupport_INValues = ["pin"] as const;
/** array of | PostalAreaSupport.ZA */
export const PostalAreaSupport_ZAValues = ["postal_code"] as const;

// ====== PreviewCreativeBatchResponse ======

/** single | PreviewCreativeBatchResponse.response_type */
export const PreviewCreativeBatchResponse_ResponseTypeValues = ["batch"] as const;

// ====== PreviewCreativeRequest ======

/** single | PreviewCreativeRequest.request_type */
export const PreviewCreativeRequest_RequestTypeValues = ["single", "batch", "variant"] as const;

// ====== PreviewCreativeSingleResponse ======

/** single | PreviewCreativeSingleResponse.response_type */
export const PreviewCreativeSingleResponse_ResponseTypeValues = ["single"] as const;

// ====== PreviewCreativeVariantResponse ======

/** single | PreviewCreativeVariantResponse.response_type */
export const PreviewCreativeVariantResponse_ResponseTypeValues = ["variant"] as const;

// ====== PreviewRendererMetadata ======

/** single | PreviewRendererMetadata.rendering_origin */
export const PreviewRendererMetadata_RenderingOriginValues = ["platform_native", "agent_approximation"] as const;

// ====== Price ======

/** single | Price.period */
export const Price_PeriodValues = ["night", "month", "year", "one_time"] as const;

// ====== ProductCardReferenceAsset ======

/** single | ProductCardReferenceAsset.role */
export const ProductCardReferenceAsset_RoleValues = ["coverage_map", "sample_render", "environment_photo", "media_kit", "logo", "other"] as const;

// ====== ProductDefaultPlacements ======

/** single | ProductDefaultPlacements.mode */
export const ProductDefaultPlacements_ModeValues = ["default"] as const;

// ====== ProductLocalFormatOptionReference ======

/** single | ProductLocalFormatOptionReference.scope */
export const ProductLocalFormatOptionReference_ScopeValues = ["product"] as const;

// ====== PropertyError ======

/** single | PropertyError.code */
export const PropertyError_CodeValues = ["PROPERTY_NOT_FOUND", "PROPERTY_NOT_MONITORED", "LIST_NOT_FOUND", "LIST_ACCESS_DENIED", "METHODOLOGY_NOT_SUPPORTED", "JURISDICTION_NOT_SUPPORTED"] as const;

// ====== PropertyFeatureDefinition ======

/** single | PropertyFeatureDefinition.type */
export const PropertyFeatureDefinition_TypeValues = ["binary", "quantitative", "categorical"] as const;

// ====== PropertyFeatureResult ======

/** single | PropertyFeatureResult.coverage_status */
export const PropertyFeatureResult_CoverageStatusValues = ["covered", "not_covered", "pending"] as const;

// ====== PropertyListApplication ======

/** single | PropertyListApplication.list_type */
export const PropertyListApplication_ListTypeValues = ["property"] as const;

// ====== PropertyListChangedWebhook ======

/** single | PropertyListChangedWebhook.event */
export const PropertyListChangedWebhook_EventValues = ["property_list_changed"] as const;

// ====== Provenance ======

/** single | Provenance.human_oversight */
export const Provenance_HumanOversightValues = ["none", "prompt_only", "selected", "edited", "directed"] as const;

// ====== ProvidePerformanceFeedbackSuccess ======

/** single | ProvidePerformanceFeedbackSuccess.application_status */
export const ProvidePerformanceFeedbackSuccess_ApplicationStatusValues = ["accepted", "applied", "not_applied"] as const;

// ====== PublishedPostAsset ======

/** single | PublishedPostAsset.asset_type */
export const PublishedPostAsset_AssetTypeValues = ["published_post"] as const;

// ====== PublisherCatalogFormatOptionReference ======

/** single | PublisherCatalogFormatOptionReference.scope */
export const PublisherCatalogFormatOptionReference_ScopeValues = ["publisher"] as const;

// ====== PublisherCatalogPlacementIdentity ======

/** single | PublisherCatalogPlacementIdentity.kind */
export const PublisherCatalogPlacementIdentity_KindValues = ["publisher_ref"] as const;

// ====== PublisherCollectionsSource ======

/** single | PublisherCollectionsSource.selection_type */
export const PublisherCollectionsSource_SelectionTypeValues = ["publisher_collections"] as const;

// ====== PublisherDesignatedPreviewProvider ======

/** single | PublisherDesignatedPreviewProvider.authority */
export const PublisherDesignatedPreviewProvider_AuthorityValues = ["publisher_designated"] as const;

// ====== PublisherEntry ======

/** single | PublisherEntry.discovery_method */
export const PublisherEntry_DiscoveryMethodValues = ["direct", "authoritative_location", "adagents_authoritative", "ads_txt_managerdomain"] as const;
/** single | PublisherEntry.status */
export const PublisherEntry_StatusValues = ["authorized", "revoked"] as const;

// ====== PublisherGenresSource ======

/** single | PublisherGenresSource.selection_type */
export const PublisherGenresSource_SelectionTypeValues = ["publisher_genres"] as const;

// ====== PublisherPropertyIDsSource ======

/** single | PublisherPropertyIDsSource.selection_type */
export const PublisherPropertyIDsSource_SelectionTypeValues = ["publisher_ids"] as const;

// ====== PublisherTagsSource ======

/** single | PublisherTagsSource.selection_type */
export const PublisherTagsSource_SelectionTypeValues = ["publisher_tags"] as const;

// ====== RateLimitedDetails ======

/** single | RateLimitedDetails.scope */
export const RateLimitedDetails_ScopeValues = ["account", "tool", "global"] as const;

// ====== RawAttestation ======

/** single | RawAttestation.attestation_mode */
export const RawAttestation_AttestationModeValues = ["raw"] as const;

// ====== RealEstateItem ======

/** single | RealEstateItem.listing_type */
export const RealEstateItem_ListingTypeValues = ["for_sale", "for_rent"] as const;
/** single | RealEstateItem.property_type */
export const RealEstateItem_PropertyTypeValues = ["house", "apartment", "condo", "townhouse", "land", "commercial"] as const;

// ====== ReferenceAsset ======

/** single | ReferenceAsset.role */
export const ReferenceAsset_RoleValues = ["style_reference", "product_shot", "mood_board", "example_creative", "logo", "strategy_doc", "storyboard"] as const;

// ====== ReferenceRenderer ======

/** single | ReferenceRenderer.runtime */
export const ReferenceRenderer_RuntimeValues = ["browser-esm"] as const;

// ====== RepeatableGroupAsset ======

/** single | RepeatableGroupAsset.item_type */
export const RepeatableGroupAsset_ItemTypeValues = ["repeatable_group"] as const;
/** single | RepeatableGroupAsset.selection_mode */
export const RepeatableGroupAsset_SelectionModeValues = ["sequential", "optimize"] as const;

// ====== ReplaceAssignment ======

/** single | ReplaceAssignment.operation */
export const ReplaceAssignment_OperationValues = ["replace"] as const;

// ====== ReportedOutcomeError ======

/** single | ReportedOutcomeError.classification_source */
export const ReportedOutcomeError_ClassificationSourceValues = ["seller_response_copy", "buyer_classification"] as const;

// ====== ReportingWebhook ======

/** single | ReportingWebhook.reporting_frequency */
export const ReportingWebhook_ReportingFrequencyValues = ["hourly", "daily", "monthly"] as const;

// ====== ReportPlanAdjustmentRequest ======

/** single | ReportPlanAdjustmentRequest.action */
export const ReportPlanAdjustmentRequest_ActionValues = ["report", "review"] as const;
/** single | ReportPlanAdjustmentRequest.adjustment_type */
export const ReportPlanAdjustmentRequest_AdjustmentTypeValues = ["decommitment", "refund", "credit", "makegood"] as const;
/** single | ReportPlanAdjustmentRequest.decision */
export const ReportPlanAdjustmentRequest_DecisionValues = ["accept", "dispute"] as const;

// ====== ReportPlanAdjustmentResponse ======

/** single | ReportPlanAdjustmentResponse.adjustment_state */
export const ReportPlanAdjustmentResponse_AdjustmentStateValues = ["reported", "verified", "disputed"] as const;

// ====== ReportPlanOutcomeResponse ======

/** single | ReportPlanOutcomeResponse.delivery_reconciliation_status */
export const ReportPlanOutcomeResponse_DeliveryReconciliationStatusValues = ["consistent", "measurement_variance", "disputed", "unmatched", "closed_unresolved"] as const;
/** single | ReportPlanOutcomeResponse.outcome_state */
export const ReportPlanOutcomeResponse_OutcomeStateValues = ["accepted", "findings"] as const;

// ====== RepresentationRejection ======

/** single | RepresentationRejection.code */
export const RepresentationRejection_CodeValues = ["incompatible_format_kind", "format_option_mismatch", "unsupported_delivery_type", "vast_version_mismatch", "macro_unsupported", "tracker_contract_mismatch", "asset_requirement_failed", "other"] as const;

// ====== ResponsePayload ======

/** single | ResponsePayload.task */
export const ResponsePayload_TaskValues = ["verify_brand_claim", "verify_brand_claims"] as const;
/** single | ResponsePayload.typ */
export const ResponsePayload_TypValues = ["adcp-response-payload+jws"] as const;

// ====== ResponsiveCreativeFormatDeclaration ======

/** single | ResponsiveCreativeFormatDeclaration.format_kind */
export const ResponsiveCreativeFormatDeclaration_FormatKindValues = ["responsive_creative"] as const;

// ====== RevenueSharePricingOption ======

/** single | RevenueSharePricingOption.pricing_model */
export const RevenueSharePricingOption_PricingModelValues = ["revenue_share"] as const;

// ====== RightsConstraint ======

/** single | RightsConstraint.approval_status */
export const RightsConstraint_ApprovalStatusValues = ["pending", "approved", "rejected"] as const;
/** single | RightsConstraint.grant_status */
export const RightsConstraint_GrantStatusValues = ["active", "paused", "revoked"] as const;

// ====== ScalarBinding ======

/** single | ScalarBinding.kind */
export const ScalarBinding_KindValues = ["scalar"] as const;

// ====== SearchBrandResult ======

/** single | SearchBrandResult.relationship_trust */
export const SearchBrandResult_RelationshipTrustValues = ["inline", "mutual", "leaf_only", "house_only", "standalone", "unverifiable"] as const;

// ====== SelectedPlacements ======

/** single | SelectedPlacements.mode */
export const SelectedPlacements_ModeValues = ["selected"] as const;

// ====== SellerInlinePlacementIdentity ======

/** single | SellerInlinePlacementIdentity.kind */
export const SellerInlinePlacementIdentity_KindValues = ["seller_inline"] as const;

// ====== SellerRenderedStatefulDisplayFormatDeclaration ======

/** single | SellerRenderedStatefulDisplayFormatDeclaration.format_kind */
export const SellerRenderedStatefulDisplayFormatDeclaration_FormatKindValues = ["seller_rendered_stateful_display"] as const;

// ====== SIComponentCatalog ======

/** single | SIComponentCatalog.catalogId */
export const SIComponentCatalog_CatalogIdValues = ["si-standard"] as const;
/** array of | SIComponentCatalog.components */
export const SIComponentCatalog_ComponentsValues = ["Text", "Button", "Link", "Image", "Card", "ProductCard", "List", "Row", "Column", "IntegrationAction", "AppHandoff"] as const;

// ====== SignalCoverageForecast ======

/** single | SignalCoverageForecast.bucket_semantics */
export const SignalCoverageForecast_BucketSemanticsValues = ["exclusive", "overlapping"] as const;
/** single | SignalCoverageForecast.forecast_range_unit */
export const SignalCoverageForecast_ForecastRangeUnitValues = ["availability"] as const;

// ====== SignalDefinition ======

/** single | SignalDefinition.art9_basis */
export const SignalDefinition_Art9BasisValues = ["explicit_consent", "manifestly_made_public", "substantial_public_interest", "vital_interests"] as const;
/** single | SignalDefinition.audience_scope */
export const SignalDefinition_AudienceScopeValues = ["single_domain", "cross_domain_owned", "cross_domain_unowned", "offline"] as const;
/** array of | SignalDefinition.data_sources */
export const SignalDefinition_DataSourcesValues = ["app_behavior", "app_usage", "web_usage", "geo_location", "email", "tv_ott_or_stb_device", "panel", "online_ecommerce", "credit_data", "loyalty_card", "transaction", "online_survey", "offline_survey", "public_record_census", "public_record_voter_file", "public_record_other", "offline_transaction"] as const;
/** array of | SignalDefinition.id_types */
export const SignalDefinition_IdTypesValues = ["cookie", "mobile_id", "platform_id", "user_enabled_id"] as const;
/** single | SignalDefinition.lookback_window */
export const SignalDefinition_LookbackWindowValues = ["intra_day", "daily", "weekly", "monthly", "bi_monthly", "quarterly", "bi_annually", "annually"] as const;
/** single | SignalDefinition.methodology */
export const SignalDefinition_MethodologyValues = ["observed", "declared", "derived", "inferred", "modeled"] as const;

// ====== SignalSelectionGroupRule ======

/** single | SignalSelectionGroupRule.selection_mode */
export const SignalSelectionGroupRule_SelectionModeValues = ["optional", "required", "fixed"] as const;

// ====== SignalTargetingRules ======

/** single | SignalTargetingRules.resolution_model */
export const SignalTargetingRules_ResolutionModelValues = ["direct_targeting", "seller_planned"] as const;

// ====== SignedSuccessPayload ======

/** single | SignedSuccessPayload.claim_type */
export const SignedSuccessPayload_ClaimTypeValues = ["subsidiary", "parent", "property", "trademark"] as const;

// ====== SIIdentity ======

/** array of | SIIdentity.consent_scope */
export const SIIdentity_ConsentScopeValues = ["name", "email", "shipping_address", "phone", "locale"] as const;

// ====== SITerminateSessionRequest ======

/** single | SITerminateSessionRequest.reason */
export const SITerminateSessionRequest_ReasonValues = ["handoff_transaction", "handoff_complete", "user_exit", "session_timeout", "host_terminated"] as const;

// ====== SIUIElement ======

/** single | SIUIElement.type */
export const SIUIElement_TypeValues = ["text", "link", "image", "product_card", "carousel", "action_button", "app_handoff", "integration_actions"] as const;

// ====== SourceLocalizationReadback ======

/** single | SourceLocalizationReadback.role */
export const SourceLocalizationReadback_RoleValues = ["source"] as const;

// ====== SponsoredPlacementFormatDeclaration ======

/** single | SponsoredPlacementFormatDeclaration.format_kind */
export const SponsoredPlacementFormatDeclaration_FormatKindValues = ["sponsored_placement"] as const;

// ====== SyncAgentNotificationConfigsResponse ======

/** single | SyncAgentNotificationConfigsResponse.action */
export const SyncAgentNotificationConfigsResponse_ActionValues = ["updated", "unchanged", "cleared", "failed"] as const;

// ====== SyncCatalogsAsyncInputRequired ======

/** single | SyncCatalogsAsyncInputRequired.reason */
export const SyncCatalogsAsyncInputRequired_ReasonValues = ["APPROVAL_REQUIRED", "FEED_VALIDATION", "ITEM_REVIEW", "FEED_ACCESS"] as const;

// ====== SyncCreativesAsyncInputRequired ======

/** single | SyncCreativesAsyncInputRequired.reason */
export const SyncCreativesAsyncInputRequired_ReasonValues = ["APPROVAL_REQUIRED", "ASSET_CONFIRMATION", "FORMAT_CLARIFICATION"] as const;

// ====== TagURL ======

/** single | TagURL.delivery_type */
export const TagURL_DeliveryTypeValues = ["tag_url"] as const;

// ====== TargetLocalizationReadback ======

/** single | TargetLocalizationReadback.role */
export const TargetLocalizationReadback_RoleValues = ["target"] as const;

// ====== ThirdPartyFormatTarget ======

/** single | ThirdPartyFormatTarget.kind */
export const ThirdPartyFormatTarget_KindValues = ["third_party_format"] as const;

// ====== TimeBasedPricingOption ======

/** single | TimeBasedPricingOption.pricing_model */
export const TimeBasedPricingOption_PricingModelValues = ["time"] as const;

// ====== TMPError ======

/** single | TMPError.code */
export const TMPError_CodeValues = ["invalid_request", "unknown_package", "seller_not_authorized", "rate_limited", "timeout", "internal_error", "provider_unavailable"] as const;
/** single | TMPError.type */
export const TMPError_TypeValues = ["error"] as const;

// ====== TMPIdentityMatch ======

/** single | TMPIdentityMatch.pattern */
export const TMPIdentityMatch_PatternValues = ["tmp_identity_match"] as const;

// ====== TMPProviderRegistration ======

/** single | TMPProviderRegistration.status */
export const TMPProviderRegistration_StatusValues = ["active", "inactive", "draining"] as const;

// ====== TransformerParam ======

/** single | TransformerParam.type */
export const TransformerParam_TypeValues = ["string", "number", "integer", "boolean"] as const;
/** single | TransformerParam.value_source */
export const TransformerParam_ValueSourceValues = ["inline", "range", "enumerable", "free_text"] as const;

// ====== Unassign ======

/** single | Unassign.operation */
export const Unassign_OperationValues = ["unassign"] as const;

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

/** single | VASTTrackerAsset.asset_type */
export const VASTTrackerAsset_AssetTypeValues = ["vast_tracker"] as const;
/** single | VASTTrackerAsset.target */
export const VASTTrackerAsset_TargetValues = ["linear", "non_linear", "companion"] as const;

// ====== VASTTrackerConstraints ======

/** single | VASTTrackerConstraints.vast_event */
export const VASTTrackerConstraints_VastEventValues = ["creativeView", "loaded", "start", "firstQuartile", "midpoint", "thirdQuartile", "complete", "mute", "unmute", "pause", "resume", "rewind", "skip", "playerExpand", "playerCollapse", "fullscreen", "exitFullscreen", "progress", "acceptInvitation", "adExpand", "adCollapse", "minimize", "overlayViewDuration", "otherAdInteraction", "interactiveStart", "close", "closeLinear"] as const;

// ====== VASTVideoFormatDeclaration ======

/** single | VASTVideoFormatDeclaration.format_kind */
export const VASTVideoFormatDeclaration_FormatKindValues = ["video_vast"] as const;

// ====== VCPMPricingOption ======

/** single | VCPMPricingOption.pricing_model */
export const VCPMPricingOption_PricingModelValues = ["vcpm"] as const;

// ====== VehicleItem ======

/** single | VehicleItem.body_style */
export const VehicleItem_BodyStyleValues = ["sedan", "suv", "truck", "coupe", "convertible", "wagon", "van", "hatchback"] as const;
/** single | VehicleItem.condition */
export const VehicleItem_ConditionValues = ["new", "used", "certified_pre_owned"] as const;
/** single | VehicleItem.fuel_type */
export const VehicleItem_FuelTypeValues = ["gasoline", "diesel", "electric", "hybrid", "plug_in_hybrid"] as const;
/** single | VehicleItem.transmission */
export const VehicleItem_TransmissionValues = ["automatic", "manual", "cvt"] as const;

// ====== VendorMetricOptimizationSupportedMetric ======

/** array of | VendorMetricOptimizationSupportedMetric.supported_targets */
export const VendorMetricOptimizationSupportedMetric_SupportedTargetsValues = ["cost_per", "threshold_rate"] as const;

// ====== VerifyParentClaim ======

/** single | VerifyParentClaim.claim_type */
export const VerifyParentClaim_ClaimTypeValues = ["parent"] as const;

// ====== VerifySubsidiaryClaim ======

/** single | VerifySubsidiaryClaim.claim_type */
export const VerifySubsidiaryClaim_ClaimTypeValues = ["subsidiary"] as const;

// ====== VerifyTrademarkClaim ======

/** single | VerifyTrademarkClaim.claim_type */
export const VerifyTrademarkClaim_ClaimTypeValues = ["trademark"] as const;

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

// ====== ZipAsset ======

/** single | ZipAsset.asset_type */
export const ZipAsset_AssetTypeValues = ["zip"] as const;

// ====== Deprecated aliases — duplicate literal sets ======
// Re-exported under their original parent-prefixed names; resolve
// to the same array reference as the canonical export. Migrate
// imports to the canonical name; aliases remain for one minor
// version. (adcp-client#941)

// --- AccountChangeRecordedWebhook ---
/** @deprecated use `AccountChangeFeedSupported_EventTypeValues` — same literal set, AccountChangeRecordedWebhook.notification_type duplicates the canonical export. */
export const AccountChangeRecordedWebhook_NotificationTypeValues = AccountChangeFeedSupported_EventTypeValues;
// --- AccountNotificationsSupported ---
/** @deprecated use `AccountChangeFeedSupported_RegistrationTaskValues` — same literal set, AccountNotificationsSupported.registration_task duplicates the canonical export. */
export const AccountNotificationsSupported_RegistrationTaskValues = AccountChangeFeedSupported_RegistrationTaskValues;
// --- AccountStatusChangedWebhook ---
/** @deprecated use `AccountNotificationsSupported_EventTypesValues` — same literal set, AccountStatusChangedWebhook.notification_type duplicates the canonical export. */
export const AccountStatusChangedWebhook_NotificationTypeValues = AccountNotificationsSupported_EventTypesValues;
// --- AcquireRightsPendingApproval ---
/** @deprecated use `AccountIdentityChangePending_StatusValues` — same literal set, AcquireRightsPendingApproval.rights_status duplicates the canonical export. */
export const AcquireRightsPendingApproval_RightsStatusValues = AccountIdentityChangePending_StatusValues;
// --- AcquireRightsRejected ---
/** @deprecated use `AccountIdentityChangeRejected_StatusValues` — same literal set, AcquireRightsRejected.rights_status duplicates the canonical export. */
export const AcquireRightsRejected_RightsStatusValues = AccountIdentityChangeRejected_StatusValues;
// --- AgentWebhookChallenge ---
/** @deprecated use `AgentNotificationConfig_EventTypesValues` — same literal set, AgentWebhookChallenge.event_types duplicates the canonical export. */
export const AgentWebhookChallenge_EventTypesValues = AgentNotificationConfig_EventTypesValues;
/** @deprecated use `AgentPermissionDeniedDetails_ScopeValues` — same literal set, AgentWebhookChallenge.scope duplicates the canonical export. */
export const AgentWebhookChallenge_ScopeValues = AgentPermissionDeniedDetails_ScopeValues;
// --- AttestationAgentIssuer ---
/** @deprecated use `AgentPermissionDeniedDetails_ScopeValues` — same literal set, AttestationAgentIssuer.type duplicates the canonical export. */
export const AttestationAgentIssuer_TypeValues = AgentPermissionDeniedDetails_ScopeValues;
// --- AttestationAgentSubject ---
/** @deprecated use `AgentPermissionDeniedDetails_ScopeValues` — same literal set, AttestationAgentSubject.type duplicates the canonical export. */
export const AttestationAgentSubject_TypeValues = AgentPermissionDeniedDetails_ScopeValues;
// --- AttestationBrandSubject ---
/** @deprecated use `AttestationBrandIssuer_TypeValues` — same literal set, AttestationBrandSubject.type duplicates the canonical export. */
export const AttestationBrandSubject_TypeValues = AttestationBrandIssuer_TypeValues;
// --- BuildCreativeSubmitted ---
/** @deprecated use `BuildCreativeAsyncSubmitted_StatusValues` — same literal set, BuildCreativeSubmitted.status duplicates the canonical export. */
export const BuildCreativeSubmitted_StatusValues = BuildCreativeAsyncSubmitted_StatusValues;
// --- BuildCreativeVariantSuccess ---
/** @deprecated use `BuildCreativeRequest_KeepModeValues` — same literal set, BuildCreativeVariantSuccess.keep_mode_applied duplicates the canonical export. */
export const BuildCreativeVariantSuccess_KeepModeAppliedValues = BuildCreativeRequest_KeepModeValues;
// --- CanonicalAudienceEvidence ---
/** @deprecated use `AudienceEvidence_EvidenceTypeValues` — same literal set, CanonicalAudienceEvidence.evidence_type duplicates the canonical export. */
export const CanonicalAudienceEvidence_EvidenceTypeValues = AudienceEvidence_EvidenceTypeValues;
/** @deprecated use `AudienceEvidence_RelationshipValues` — same literal set, CanonicalAudienceEvidence.relationship duplicates the canonical export. */
export const CanonicalAudienceEvidence_RelationshipValues = AudienceEvidence_RelationshipValues;
/** @deprecated use `AudienceEvidence_UnitValues` — same literal set, CanonicalAudienceEvidence.unit duplicates the canonical export. */
export const CanonicalAudienceEvidence_UnitValues = AudienceEvidence_UnitValues;
// --- CanonicalAudienceEvidenceSelection ---
/** @deprecated use `AudienceEvidenceSelection_DecisionUseValues` — same literal set, CanonicalAudienceEvidenceSelection.decision_use duplicates the canonical export. */
export const CanonicalAudienceEvidenceSelection_DecisionUseValues = AudienceEvidenceSelection_DecisionUseValues;
// --- CanonicalFormatBase ---
/** @deprecated use `CanonicalFormatAgentPlacementAISurfaceSponsoredPlacement_CompositionModelValues` — same literal set, CanonicalFormatBase.composition_model duplicates the canonical export. */
export const CanonicalFormatBase_CompositionModelValues = CanonicalFormatAgentPlacementAISurfaceSponsoredPlacement_CompositionModelValues;
/** @deprecated use `CanonicalFormatAgentPlacementAISurfaceSponsoredPlacement_ReferenceMutabilityValues` — same literal set, CanonicalFormatBase.reference_mutability duplicates the canonical export. */
export const CanonicalFormatBase_ReferenceMutabilityValues = CanonicalFormatAgentPlacementAISurfaceSponsoredPlacement_ReferenceMutabilityValues;
// --- CanonicalFormatDAASTAudio ---
/** @deprecated use `CanonicalFormatAgentPlacementAISurfaceSponsoredPlacement_CompositionModelValues` — same literal set, CanonicalFormatDAASTAudio.composition_model duplicates the canonical export. */
export const CanonicalFormatDAASTAudio_CompositionModelValues = CanonicalFormatAgentPlacementAISurfaceSponsoredPlacement_CompositionModelValues;
/** @deprecated use `CanonicalFormatAgentPlacementAISurfaceSponsoredPlacement_ReferenceMutabilityValues` — same literal set, CanonicalFormatDAASTAudio.reference_mutability duplicates the canonical export. */
export const CanonicalFormatDAASTAudio_ReferenceMutabilityValues = CanonicalFormatAgentPlacementAISurfaceSponsoredPlacement_ReferenceMutabilityValues;
// --- CanonicalFormatDisplayTag ---
/** @deprecated use `CanonicalFormatAgentPlacementAISurfaceSponsoredPlacement_CompositionModelValues` — same literal set, CanonicalFormatDisplayTag.composition_model duplicates the canonical export. */
export const CanonicalFormatDisplayTag_CompositionModelValues = CanonicalFormatAgentPlacementAISurfaceSponsoredPlacement_CompositionModelValues;
/** @deprecated use `CanonicalFormatAgentPlacementAISurfaceSponsoredPlacement_ReferenceMutabilityValues` — same literal set, CanonicalFormatDisplayTag.reference_mutability duplicates the canonical export. */
export const CanonicalFormatDisplayTag_ReferenceMutabilityValues = CanonicalFormatAgentPlacementAISurfaceSponsoredPlacement_ReferenceMutabilityValues;
// --- CanonicalFormatHostedAudio ---
/** @deprecated use `AudioAssetRequirements_ChannelsValues` — same literal set, CanonicalFormatHostedAudio.audio_channels duplicates the canonical export. */
export const CanonicalFormatHostedAudio_AudioChannelsValues = AudioAssetRequirements_ChannelsValues;
/** @deprecated use `CanonicalFormatAgentPlacementAISurfaceSponsoredPlacement_CompositionModelValues` — same literal set, CanonicalFormatHostedAudio.composition_model duplicates the canonical export. */
export const CanonicalFormatHostedAudio_CompositionModelValues = CanonicalFormatAgentPlacementAISurfaceSponsoredPlacement_CompositionModelValues;
/** @deprecated use `CanonicalFormatAgentPlacementAISurfaceSponsoredPlacement_ReferenceMutabilityValues` — same literal set, CanonicalFormatHostedAudio.reference_mutability duplicates the canonical export. */
export const CanonicalFormatHostedAudio_ReferenceMutabilityValues = CanonicalFormatAgentPlacementAISurfaceSponsoredPlacement_ReferenceMutabilityValues;
// --- CanonicalFormatHostedVideo ---
/** @deprecated use `CanonicalFormatHostedAudio_AssetSourceValues` — same literal set, CanonicalFormatHostedVideo.asset_source duplicates the canonical export. */
export const CanonicalFormatHostedVideo_AssetSourceValues = CanonicalFormatHostedAudio_AssetSourceValues;
/** @deprecated use `CanonicalFormatHostedAudio_BuyerAssetAcceptanceValues` — same literal set, CanonicalFormatHostedVideo.buyer_asset_acceptance duplicates the canonical export. */
export const CanonicalFormatHostedVideo_BuyerAssetAcceptanceValues = CanonicalFormatHostedAudio_BuyerAssetAcceptanceValues;
/** @deprecated use `CanonicalFormatAgentPlacementAISurfaceSponsoredPlacement_CompositionModelValues` — same literal set, CanonicalFormatHostedVideo.composition_model duplicates the canonical export. */
export const CanonicalFormatHostedVideo_CompositionModelValues = CanonicalFormatAgentPlacementAISurfaceSponsoredPlacement_CompositionModelValues;
/** @deprecated use `CanonicalFormatAgentPlacementAISurfaceSponsoredPlacement_ReferenceMutabilityValues` — same literal set, CanonicalFormatHostedVideo.reference_mutability duplicates the canonical export. */
export const CanonicalFormatHostedVideo_ReferenceMutabilityValues = CanonicalFormatAgentPlacementAISurfaceSponsoredPlacement_ReferenceMutabilityValues;
// --- CanonicalFormatHTML5Banner ---
/** @deprecated use `CanonicalFormatAgentPlacementAISurfaceSponsoredPlacement_CompositionModelValues` — same literal set, CanonicalFormatHTML5Banner.composition_model duplicates the canonical export. */
export const CanonicalFormatHTML5Banner_CompositionModelValues = CanonicalFormatAgentPlacementAISurfaceSponsoredPlacement_CompositionModelValues;
/** @deprecated use `CanonicalFormatAgentPlacementAISurfaceSponsoredPlacement_ReferenceMutabilityValues` — same literal set, CanonicalFormatHTML5Banner.reference_mutability duplicates the canonical export. */
export const CanonicalFormatHTML5Banner_ReferenceMutabilityValues = CanonicalFormatAgentPlacementAISurfaceSponsoredPlacement_ReferenceMutabilityValues;
// --- CanonicalFormatImage ---
/** @deprecated use `CanonicalFormatHostedAudio_AssetSourceValues` — same literal set, CanonicalFormatImage.asset_source duplicates the canonical export. */
export const CanonicalFormatImage_AssetSourceValues = CanonicalFormatHostedAudio_AssetSourceValues;
/** @deprecated use `CanonicalFormatHostedAudio_BuyerAssetAcceptanceValues` — same literal set, CanonicalFormatImage.buyer_asset_acceptance duplicates the canonical export. */
export const CanonicalFormatImage_BuyerAssetAcceptanceValues = CanonicalFormatHostedAudio_BuyerAssetAcceptanceValues;
/** @deprecated use `CanonicalFormatAgentPlacementAISurfaceSponsoredPlacement_CompositionModelValues` — same literal set, CanonicalFormatImage.composition_model duplicates the canonical export. */
export const CanonicalFormatImage_CompositionModelValues = CanonicalFormatAgentPlacementAISurfaceSponsoredPlacement_CompositionModelValues;
/** @deprecated use `CanonicalFormatAgentPlacementAISurfaceSponsoredPlacement_ReferenceMutabilityValues` — same literal set, CanonicalFormatImage.reference_mutability duplicates the canonical export. */
export const CanonicalFormatImage_ReferenceMutabilityValues = CanonicalFormatAgentPlacementAISurfaceSponsoredPlacement_ReferenceMutabilityValues;
// --- CanonicalFormatImageCarousel ---
/** @deprecated use `CanonicalFormatImageCarousel_AllowedCardAssetTypesValues` — same literal set, CanonicalFormatImageCarousel.allowed_card_media_asset_types duplicates the canonical export. */
export const CanonicalFormatImageCarousel_AllowedCardMediaAssetTypesValues = CanonicalFormatImageCarousel_AllowedCardAssetTypesValues;
/** @deprecated use `CanonicalFormatAgentPlacementAISurfaceSponsoredPlacement_CompositionModelValues` — same literal set, CanonicalFormatImageCarousel.composition_model duplicates the canonical export. */
export const CanonicalFormatImageCarousel_CompositionModelValues = CanonicalFormatAgentPlacementAISurfaceSponsoredPlacement_CompositionModelValues;
/** @deprecated use `CanonicalFormatAgentPlacementAISurfaceSponsoredPlacement_ReferenceMutabilityValues` — same literal set, CanonicalFormatImageCarousel.reference_mutability duplicates the canonical export. */
export const CanonicalFormatImageCarousel_ReferenceMutabilityValues = CanonicalFormatAgentPlacementAISurfaceSponsoredPlacement_ReferenceMutabilityValues;
// --- CanonicalFormatNativeInFeed ---
/** @deprecated use `CanonicalFormatHostedAudio_BuyerAssetAcceptanceValues` — same literal set, CanonicalFormatNativeInFeed.buyer_asset_acceptance duplicates the canonical export. */
export const CanonicalFormatNativeInFeed_BuyerAssetAcceptanceValues = CanonicalFormatHostedAudio_BuyerAssetAcceptanceValues;
/** @deprecated use `CanonicalFormatAgentPlacementAISurfaceSponsoredPlacement_CompositionModelValues` — same literal set, CanonicalFormatNativeInFeed.composition_model duplicates the canonical export. */
export const CanonicalFormatNativeInFeed_CompositionModelValues = CanonicalFormatAgentPlacementAISurfaceSponsoredPlacement_CompositionModelValues;
/** @deprecated use `CanonicalFormatAgentPlacementAISurfaceSponsoredPlacement_ReferenceMutabilityValues` — same literal set, CanonicalFormatNativeInFeed.reference_mutability duplicates the canonical export. */
export const CanonicalFormatNativeInFeed_ReferenceMutabilityValues = CanonicalFormatAgentPlacementAISurfaceSponsoredPlacement_ReferenceMutabilityValues;
// --- CanonicalFormatResponsiveCreative ---
/** @deprecated use `CanonicalFormatAgentPlacementAISurfaceSponsoredPlacement_CompositionModelValues` — same literal set, CanonicalFormatResponsiveCreative.composition_model duplicates the canonical export. */
export const CanonicalFormatResponsiveCreative_CompositionModelValues = CanonicalFormatAgentPlacementAISurfaceSponsoredPlacement_CompositionModelValues;
/** @deprecated use `CanonicalFormatAgentPlacementAISurfaceSponsoredPlacement_ReferenceMutabilityValues` — same literal set, CanonicalFormatResponsiveCreative.reference_mutability duplicates the canonical export. */
export const CanonicalFormatResponsiveCreative_ReferenceMutabilityValues = CanonicalFormatAgentPlacementAISurfaceSponsoredPlacement_ReferenceMutabilityValues;
// --- CanonicalFormatSponsoredPlacementRetailMediaCatalogDriven ---
/** @deprecated use `CanonicalFormatAgentPlacementAISurfaceSponsoredPlacement_CompositionModelValues` — same literal set, CanonicalFormatSponsoredPlacementRetailMediaCatalogDriven.composition_model duplicates the canonical export. */
export const CanonicalFormatSponsoredPlacementRetailMediaCatalogDriven_CompositionModelValues = CanonicalFormatAgentPlacementAISurfaceSponsoredPlacement_CompositionModelValues;
/** @deprecated use `CanonicalFormatAgentPlacementAISurfaceSponsoredPlacement_ReferenceMutabilityValues` — same literal set, CanonicalFormatSponsoredPlacementRetailMediaCatalogDriven.reference_mutability duplicates the canonical export. */
export const CanonicalFormatSponsoredPlacementRetailMediaCatalogDriven_ReferenceMutabilityValues = CanonicalFormatAgentPlacementAISurfaceSponsoredPlacement_ReferenceMutabilityValues;
// --- CanonicalFormatVASTVideo ---
/** @deprecated use `CanonicalFormatAgentPlacementAISurfaceSponsoredPlacement_CompositionModelValues` — same literal set, CanonicalFormatVASTVideo.composition_model duplicates the canonical export. */
export const CanonicalFormatVASTVideo_CompositionModelValues = CanonicalFormatAgentPlacementAISurfaceSponsoredPlacement_CompositionModelValues;
/** @deprecated use `CanonicalFormatHostedVideo_OrientationValues` — same literal set, CanonicalFormatVASTVideo.orientation duplicates the canonical export. */
export const CanonicalFormatVASTVideo_OrientationValues = CanonicalFormatHostedVideo_OrientationValues;
/** @deprecated use `CanonicalFormatAgentPlacementAISurfaceSponsoredPlacement_ReferenceMutabilityValues` — same literal set, CanonicalFormatVASTVideo.reference_mutability duplicates the canonical export. */
export const CanonicalFormatVASTVideo_ReferenceMutabilityValues = CanonicalFormatAgentPlacementAISurfaceSponsoredPlacement_ReferenceMutabilityValues;
// --- CanonicalMediaBuyActionFields ---
/** @deprecated use `CanonicalMediaBuyAction_TaskValues` — same literal set, CanonicalMediaBuyActionFields.task duplicates the canonical export. */
export const CanonicalMediaBuyActionFields_TaskValues = CanonicalMediaBuyAction_TaskValues;
// --- CanonicalProjectionReference ---
/** @deprecated use `CanonicalFormatHostedAudio_AssetSourceValues` — same literal set, CanonicalProjectionReference.asset_source duplicates the canonical export. */
export const CanonicalProjectionReference_AssetSourceValues = CanonicalFormatHostedAudio_AssetSourceValues;
// --- CapabilitiesChangedWebhook ---
/** @deprecated use `AgentNotificationConfig_EventTypesValues` — same literal set, CapabilitiesChangedWebhook.notification_type duplicates the canonical export. */
export const CapabilitiesChangedWebhook_NotificationTypeValues = AgentNotificationConfig_EventTypesValues;
// --- CapabilityChangeNotificationsSupported ---
/** @deprecated use `AgentNotificationConfig_EventTypesValues` — same literal set, CapabilityChangeNotificationsSupported.event_types duplicates the canonical export. */
export const CapabilityChangeNotificationsSupported_EventTypesValues = AgentNotificationConfig_EventTypesValues;
// --- CatalogItemAvailabilityUpdateResult ---
/** @deprecated use `CatalogItemAvailabilityUpdate_ActionValues` — same literal set, CatalogItemAvailabilityUpdateResult.action duplicates the canonical export. */
export const CatalogItemAvailabilityUpdateResult_ActionValues = CatalogItemAvailabilityUpdate_ActionValues;
/** @deprecated use `CatalogItemAvailabilityState_AvailabilityValues` — same literal set, CatalogItemAvailabilityUpdateResult.availability duplicates the canonical export. */
export const CatalogItemAvailabilityUpdateResult_AvailabilityValues = CatalogItemAvailabilityState_AvailabilityValues;
// --- CommitmentSubmitted ---
/** @deprecated use `BuildCreativeAsyncSubmitted_StatusValues` — same literal set, CommitmentSubmitted.status duplicates the canonical export. */
export const CommitmentSubmitted_StatusValues = BuildCreativeAsyncSubmitted_StatusValues;
// --- CompactTaskSubmitted ---
/** @deprecated use `BuildCreativeAsyncSubmitted_StatusValues` — same literal set, CompactTaskSubmitted.status duplicates the canonical export. */
export const CompactTaskSubmitted_StatusValues = BuildCreativeAsyncSubmitted_StatusValues;
// --- ContextMatchResponseProviderRouter ---
/** @deprecated use `ContextMatchResponse_TypeValues` — same literal set, ContextMatchResponseProviderRouter.type duplicates the canonical export. */
export const ContextMatchResponseProviderRouter_TypeValues = ContextMatchResponse_TypeValues;
// --- ContextMatchResponseRouterPublisher ---
/** @deprecated use `ContextMatchResponse_TypeValues` — same literal set, ContextMatchResponseRouterPublisher.type duplicates the canonical export. */
export const ContextMatchResponseRouterPublisher_TypeValues = ContextMatchResponse_TypeValues;
// --- ControlApplied ---
/** @deprecated use `CommittedMediaBuy_StatusValues` — same literal set, ControlApplied.status duplicates the canonical export. */
export const ControlApplied_StatusValues = CommittedMediaBuy_StatusValues;
// --- ControlError ---
/** @deprecated use `CommitmentError_StatusValues` — same literal set, ControlError.status duplicates the canonical export. */
export const ControlError_StatusValues = CommitmentError_StatusValues;
// --- ControlSubmitted ---
/** @deprecated use `BuildCreativeAsyncSubmitted_StatusValues` — same literal set, ControlSubmitted.status duplicates the canonical export. */
export const ControlSubmitted_StatusValues = BuildCreativeAsyncSubmitted_StatusValues;
// --- CPMPricingOption ---
/** @deprecated use `CpmPricing_ModelValues` — same literal set, CPMPricingOption.pricing_model duplicates the canonical export. */
export const CPMPricingOption_PricingModelValues = CpmPricing_ModelValues;
// --- CreateMediaBuyAsyncSubmitted ---
/** @deprecated use `BuildCreativeAsyncSubmitted_StatusValues` — same literal set, CreateMediaBuyAsyncSubmitted.status duplicates the canonical export. */
export const CreateMediaBuyAsyncSubmitted_StatusValues = BuildCreativeAsyncSubmitted_StatusValues;
// --- CreateMediaBuySubmitted ---
/** @deprecated use `BuildCreativeAsyncSubmitted_StatusValues` — same literal set, CreateMediaBuySubmitted.status duplicates the canonical export. */
export const CreateMediaBuySubmitted_StatusValues = BuildCreativeAsyncSubmitted_StatusValues;
// --- CreativeBrief ---
/** @deprecated use `BriefAsset_ObjectiveValues` — same literal set, CreativeBrief.objective duplicates the canonical export. */
export const CreativeBrief_ObjectiveValues = BriefAsset_ObjectiveValues;
// --- CreativeLocalizationReadback ---
/** @deprecated use `CreativeLocalization_UnmatchedLocaleActionValues` — same literal set, CreativeLocalizationReadback.unmatched_locale_action duplicates the canonical export. */
export const CreativeLocalizationReadback_UnmatchedLocaleActionValues = CreativeLocalization_UnmatchedLocaleActionValues;
// --- CreativeOperationFormatDeclaration ---
/** @deprecated use `CanonicalFormatOption_SellerPreferenceValues` — same literal set, CreativeOperationFormatDeclaration.seller_preference duplicates the canonical export. */
export const CreativeOperationFormatDeclaration_SellerPreferenceValues = CanonicalFormatOption_SellerPreferenceValues;
// --- CreativeRejected ---
/** @deprecated use `AccountIdentityChangeRejected_StatusValues` — same literal set, CreativeRejected.approval_status duplicates the canonical export. */
export const CreativeRejected_ApprovalStatusValues = AccountIdentityChangeRejected_StatusValues;
// --- CreativeStatusChangedWebhook ---
/** @deprecated use `CreativePurgedWebhook_InitiatorValues` — same literal set, CreativeStatusChangedWebhook.initiator duplicates the canonical export. */
export const CreativeStatusChangedWebhook_InitiatorValues = CreativePurgedWebhook_InitiatorValues;
// --- CustomPricing ---
/** @deprecated use `CustomFormatDeclaration_FormatKindValues` — same literal set, CustomPricing.model duplicates the canonical export. */
export const CustomPricing_ModelValues = CustomFormatDeclaration_FormatKindValues;
// --- DAASTTrackerConstraints ---
/** @deprecated use `DAASTTrackerAsset_TargetValues` — same literal set, DAASTTrackerConstraints.target duplicates the canonical export. */
export const DAASTTrackerConstraints_TargetValues = DAASTTrackerAsset_TargetValues;
// --- Error ---
/** @deprecated use `CatalogItemAvailabilityError_RecoveryValues` — same literal set, Error.recovery duplicates the canonical export. */
export const Error_RecoveryValues = CatalogItemAvailabilityError_RecoveryValues;
/** @deprecated use `CatalogItemAvailabilityError_SourceValues` — same literal set, Error.source duplicates the canonical export. */
export const Error_SourceValues = CatalogItemAvailabilityError_SourceValues;
// --- FeatureRequirement ---
/** @deprecated use `CollectionListApplication_EffectValues` — same literal set, FeatureRequirement.if_not_covered duplicates the canonical export. */
export const FeatureRequirement_IfNotCoveredValues = CollectionListApplication_EffectValues;
// --- GetBrandIdentitySuccess ---
/** @deprecated use `GetBrandIdentityRequest_FieldsValues` — same literal set, GetBrandIdentitySuccess.available_fields duplicates the canonical export. */
export const GetBrandIdentitySuccess_AvailableFieldsValues = GetBrandIdentityRequest_FieldsValues;
// --- GetProductsAsyncSubmitted ---
/** @deprecated use `BuildCreativeAsyncSubmitted_StatusValues` — same literal set, GetProductsAsyncSubmitted.status duplicates the canonical export. */
export const GetProductsAsyncSubmitted_StatusValues = BuildCreativeAsyncSubmitted_StatusValues;
// --- GetProductsResponse ---
/** @deprecated use `GetProductsCompletion_CacheScopeValues` — same literal set, GetProductsResponse.cache_scope duplicates the canonical export. */
export const GetProductsResponse_CacheScopeValues = GetProductsCompletion_CacheScopeValues;
// --- GetProductsSubmitted ---
/** @deprecated use `BuildCreativeAsyncSubmitted_StatusValues` — same literal set, GetProductsSubmitted.status duplicates the canonical export. */
export const GetProductsSubmitted_StatusValues = BuildCreativeAsyncSubmitted_StatusValues;
// --- GetSignalsAsyncSubmitted ---
/** @deprecated use `BuildCreativeAsyncSubmitted_StatusValues` — same literal set, GetSignalsAsyncSubmitted.status duplicates the canonical export. */
export const GetSignalsAsyncSubmitted_StatusValues = BuildCreativeAsyncSubmitted_StatusValues;
// --- GetSignalsCompletion ---
/** @deprecated use `GetProductsCompletion_CacheScopeValues` — same literal set, GetSignalsCompletion.cache_scope duplicates the canonical export. */
export const GetSignalsCompletion_CacheScopeValues = GetProductsCompletion_CacheScopeValues;
// --- GetSignalsResponse ---
/** @deprecated use `GetProductsCompletion_CacheScopeValues` — same literal set, GetSignalsResponse.cache_scope duplicates the canonical export. */
export const GetSignalsResponse_CacheScopeValues = GetProductsCompletion_CacheScopeValues;
// --- GetSignalsSubmitted ---
/** @deprecated use `BuildCreativeAsyncSubmitted_StatusValues` — same literal set, GetSignalsSubmitted.status duplicates the canonical export. */
export const GetSignalsSubmitted_StatusValues = BuildCreativeAsyncSubmitted_StatusValues;
// --- GroupAudioAsset ---
/** @deprecated use `AudioAsset_AssetTypeValues` — same literal set, GroupAudioAsset.asset_type duplicates the canonical export. */
export const GroupAudioAsset_AssetTypeValues = AudioAsset_AssetTypeValues;
// --- GroupCssAsset ---
/** @deprecated use `CSSAsset_AssetTypeValues` — same literal set, GroupCssAsset.asset_type duplicates the canonical export. */
export const GroupCssAsset_AssetTypeValues = CSSAsset_AssetTypeValues;
// --- HTMLAsset ---
/** @deprecated use `GroupHtmlAsset_AssetTypeValues` — same literal set, HTMLAsset.asset_type duplicates the canonical export. */
export const HTMLAsset_AssetTypeValues = GroupHtmlAsset_AssetTypeValues;
// --- IdentityMatchResponseProviderRouter ---
/** @deprecated use `IdentityMatchResponse_TypeValues` — same literal set, IdentityMatchResponseProviderRouter.type duplicates the canonical export. */
export const IdentityMatchResponseProviderRouter_TypeValues = IdentityMatchResponse_TypeValues;
// --- IdentityMatchResponseRouterPublisher ---
/** @deprecated use `IdentityMatchResponse_TypeValues` — same literal set, IdentityMatchResponseRouterPublisher.type duplicates the canonical export. */
export const IdentityMatchResponseRouterPublisher_TypeValues = IdentityMatchResponse_TypeValues;
// --- ImageAsset ---
/** @deprecated use `GroupImageAsset_AssetTypeValues` — same literal set, ImageAsset.asset_type duplicates the canonical export. */
export const ImageAsset_AssetTypeValues = GroupImageAsset_AssetTypeValues;
// --- ImageDecoration ---
/** @deprecated use `GroupImageAsset_AssetTypeValues` — same literal set, ImageDecoration.kind duplicates the canonical export. */
export const ImageDecoration_KindValues = GroupImageAsset_AssetTypeValues;
// --- ImageFormatDeclaration ---
/** @deprecated use `GroupImageAsset_AssetTypeValues` — same literal set, ImageFormatDeclaration.format_kind duplicates the canonical export. */
export const ImageFormatDeclaration_FormatKindValues = GroupImageAsset_AssetTypeValues;
// --- IndividualAudioAsset ---
/** @deprecated use `AudioAsset_AssetTypeValues` — same literal set, IndividualAudioAsset.asset_type duplicates the canonical export. */
export const IndividualAudioAsset_AssetTypeValues = AudioAsset_AssetTypeValues;
/** @deprecated use `BaseIndividualAsset_ItemTypeValues` — same literal set, IndividualAudioAsset.item_type duplicates the canonical export. */
export const IndividualAudioAsset_ItemTypeValues = BaseIndividualAsset_ItemTypeValues;
// --- IndividualBriefAsset ---
/** @deprecated use `BriefAsset_AssetTypeValues` — same literal set, IndividualBriefAsset.asset_type duplicates the canonical export. */
export const IndividualBriefAsset_AssetTypeValues = BriefAsset_AssetTypeValues;
/** @deprecated use `BaseIndividualAsset_ItemTypeValues` — same literal set, IndividualBriefAsset.item_type duplicates the canonical export. */
export const IndividualBriefAsset_ItemTypeValues = BaseIndividualAsset_ItemTypeValues;
// --- IndividualCatalogAsset ---
/** @deprecated use `CatalogAsset_AssetTypeValues` — same literal set, IndividualCatalogAsset.asset_type duplicates the canonical export. */
export const IndividualCatalogAsset_AssetTypeValues = CatalogAsset_AssetTypeValues;
/** @deprecated use `BaseIndividualAsset_ItemTypeValues` — same literal set, IndividualCatalogAsset.item_type duplicates the canonical export. */
export const IndividualCatalogAsset_ItemTypeValues = BaseIndividualAsset_ItemTypeValues;
// --- IndividualCssAsset ---
/** @deprecated use `CSSAsset_AssetTypeValues` — same literal set, IndividualCssAsset.asset_type duplicates the canonical export. */
export const IndividualCssAsset_AssetTypeValues = CSSAsset_AssetTypeValues;
/** @deprecated use `BaseIndividualAsset_ItemTypeValues` — same literal set, IndividualCssAsset.item_type duplicates the canonical export. */
export const IndividualCssAsset_ItemTypeValues = BaseIndividualAsset_ItemTypeValues;
// --- IndividualDaastAsset ---
/** @deprecated use `GroupDaastAsset_AssetTypeValues` — same literal set, IndividualDaastAsset.asset_type duplicates the canonical export. */
export const IndividualDaastAsset_AssetTypeValues = GroupDaastAsset_AssetTypeValues;
/** @deprecated use `BaseIndividualAsset_ItemTypeValues` — same literal set, IndividualDaastAsset.item_type duplicates the canonical export. */
export const IndividualDaastAsset_ItemTypeValues = BaseIndividualAsset_ItemTypeValues;
// --- IndividualHtmlAsset ---
/** @deprecated use `GroupHtmlAsset_AssetTypeValues` — same literal set, IndividualHtmlAsset.asset_type duplicates the canonical export. */
export const IndividualHtmlAsset_AssetTypeValues = GroupHtmlAsset_AssetTypeValues;
/** @deprecated use `BaseIndividualAsset_ItemTypeValues` — same literal set, IndividualHtmlAsset.item_type duplicates the canonical export. */
export const IndividualHtmlAsset_ItemTypeValues = BaseIndividualAsset_ItemTypeValues;
// --- IndividualImageAsset ---
/** @deprecated use `GroupImageAsset_AssetTypeValues` — same literal set, IndividualImageAsset.asset_type duplicates the canonical export. */
export const IndividualImageAsset_AssetTypeValues = GroupImageAsset_AssetTypeValues;
/** @deprecated use `BaseIndividualAsset_ItemTypeValues` — same literal set, IndividualImageAsset.item_type duplicates the canonical export. */
export const IndividualImageAsset_ItemTypeValues = BaseIndividualAsset_ItemTypeValues;
// --- IndividualJavaScriptAsset ---
/** @deprecated use `GroupJavaScriptAsset_AssetTypeValues` — same literal set, IndividualJavaScriptAsset.asset_type duplicates the canonical export. */
export const IndividualJavaScriptAsset_AssetTypeValues = GroupJavaScriptAsset_AssetTypeValues;
/** @deprecated use `BaseIndividualAsset_ItemTypeValues` — same literal set, IndividualJavaScriptAsset.item_type duplicates the canonical export. */
export const IndividualJavaScriptAsset_ItemTypeValues = BaseIndividualAsset_ItemTypeValues;
// --- IndividualMarkdownAsset ---
/** @deprecated use `GroupMarkdownAsset_AssetTypeValues` — same literal set, IndividualMarkdownAsset.asset_type duplicates the canonical export. */
export const IndividualMarkdownAsset_AssetTypeValues = GroupMarkdownAsset_AssetTypeValues;
/** @deprecated use `BaseIndividualAsset_ItemTypeValues` — same literal set, IndividualMarkdownAsset.item_type duplicates the canonical export. */
export const IndividualMarkdownAsset_ItemTypeValues = BaseIndividualAsset_ItemTypeValues;
// --- IndividualTextAsset ---
/** @deprecated use `GroupTextAsset_AssetTypeValues` — same literal set, IndividualTextAsset.asset_type duplicates the canonical export. */
export const IndividualTextAsset_AssetTypeValues = GroupTextAsset_AssetTypeValues;
/** @deprecated use `BaseIndividualAsset_ItemTypeValues` — same literal set, IndividualTextAsset.item_type duplicates the canonical export. */
export const IndividualTextAsset_ItemTypeValues = BaseIndividualAsset_ItemTypeValues;
// --- IndividualUrlAsset ---
/** @deprecated use `GroupUrlAsset_AssetTypeValues` — same literal set, IndividualUrlAsset.asset_type duplicates the canonical export. */
export const IndividualUrlAsset_AssetTypeValues = GroupUrlAsset_AssetTypeValues;
/** @deprecated use `BaseIndividualAsset_ItemTypeValues` — same literal set, IndividualUrlAsset.item_type duplicates the canonical export. */
export const IndividualUrlAsset_ItemTypeValues = BaseIndividualAsset_ItemTypeValues;
// --- IndividualVastAsset ---
/** @deprecated use `GroupVastAsset_AssetTypeValues` — same literal set, IndividualVastAsset.asset_type duplicates the canonical export. */
export const IndividualVastAsset_AssetTypeValues = GroupVastAsset_AssetTypeValues;
/** @deprecated use `BaseIndividualAsset_ItemTypeValues` — same literal set, IndividualVastAsset.item_type duplicates the canonical export. */
export const IndividualVastAsset_ItemTypeValues = BaseIndividualAsset_ItemTypeValues;
// --- IndividualVideoAsset ---
/** @deprecated use `GroupVideoAsset_AssetTypeValues` — same literal set, IndividualVideoAsset.asset_type duplicates the canonical export. */
export const IndividualVideoAsset_AssetTypeValues = GroupVideoAsset_AssetTypeValues;
/** @deprecated use `BaseIndividualAsset_ItemTypeValues` — same literal set, IndividualVideoAsset.item_type duplicates the canonical export. */
export const IndividualVideoAsset_ItemTypeValues = BaseIndividualAsset_ItemTypeValues;
// --- IndividualWebhookAsset ---
/** @deprecated use `GroupWebhookAsset_AssetTypeValues` — same literal set, IndividualWebhookAsset.asset_type duplicates the canonical export. */
export const IndividualWebhookAsset_AssetTypeValues = GroupWebhookAsset_AssetTypeValues;
/** @deprecated use `BaseIndividualAsset_ItemTypeValues` — same literal set, IndividualWebhookAsset.item_type duplicates the canonical export. */
export const IndividualWebhookAsset_ItemTypeValues = BaseIndividualAsset_ItemTypeValues;
// --- IndividualZipAsset ---
/** @deprecated use `BaseIndividualAsset_ItemTypeValues` — same literal set, IndividualZipAsset.item_type duplicates the canonical export. */
export const IndividualZipAsset_ItemTypeValues = BaseIndividualAsset_ItemTypeValues;
// --- InlineMarkup ---
/** @deprecated use `DisplayTagFormatDeclaration_FormatKindValues` — same literal set, InlineMarkup.asset_type duplicates the canonical export. */
export const InlineMarkup_AssetTypeValues = DisplayTagFormatDeclaration_FormatKindValues;
// --- JavaScriptAsset ---
/** @deprecated use `GroupJavaScriptAsset_AssetTypeValues` — same literal set, JavaScriptAsset.asset_type duplicates the canonical export. */
export const JavaScriptAsset_AssetTypeValues = GroupJavaScriptAsset_AssetTypeValues;
// --- MacroResolutionResult ---
/** @deprecated use `MacroDeclaration_UnavailableBehaviorValues` — same literal set, MacroResolutionResult.unavailable_behavior duplicates the canonical export. */
export const MacroResolutionResult_UnavailableBehaviorValues = MacroDeclaration_UnavailableBehaviorValues;
// --- MarkdownAsset ---
/** @deprecated use `GroupMarkdownAsset_AssetTypeValues` — same literal set, MarkdownAsset.asset_type duplicates the canonical export. */
export const MarkdownAsset_AssetTypeValues = GroupMarkdownAsset_AssetTypeValues;
// --- MediaBuyAvailableAction ---
/** @deprecated use `CanonicalMediaBuyAction_TaskValues` — same literal set, MediaBuyAvailableAction.task duplicates the canonical export. */
export const MediaBuyAvailableAction_TaskValues = CanonicalMediaBuyAction_TaskValues;
// --- MediaBuyDeliveryWebhookResult ---
/** @deprecated use `GetMediaBuyDeliveryResponse_NotificationTypeValues` — same literal set, MediaBuyDeliveryWebhookResult.notification_type duplicates the canonical export. */
export const MediaBuyDeliveryWebhookResult_NotificationTypeValues = GetMediaBuyDeliveryResponse_NotificationTypeValues;
// --- PairedRedirect ---
/** @deprecated use `DisplayTagFormatDeclaration_FormatKindValues` — same literal set, PairedRedirect.asset_type duplicates the canonical export. */
export const PairedRedirect_AssetTypeValues = DisplayTagFormatDeclaration_FormatKindValues;
// --- PlacementPresentationReference ---
/** @deprecated use `PlacementPresentationDocument_SchemaVersionValues` — same literal set, PlacementPresentationReference.schema_version duplicates the canonical export. */
export const PlacementPresentationReference_SchemaVersionValues = PlacementPresentationDocument_SchemaVersionValues;
// --- PostalAreaSupport ---
/** @deprecated use `PostalAreaSupport_ATValues` — same literal set, PostalAreaSupport.CH duplicates the canonical export. */
export const PostalAreaSupport_CHValues = PostalAreaSupport_ATValues;
/** @deprecated use `PostalAreaSupport_ATValues` — same literal set, PostalAreaSupport.DE duplicates the canonical export. */
export const PostalAreaSupport_DEValues = PostalAreaSupport_ATValues;
// --- PreviewCreativeSubmitted ---
/** @deprecated use `BuildCreativeAsyncSubmitted_StatusValues` — same literal set, PreviewCreativeSubmitted.response_type duplicates the canonical export. */
export const PreviewCreativeSubmitted_ResponseTypeValues = BuildCreativeAsyncSubmitted_StatusValues;
/** @deprecated use `BuildCreativeAsyncSubmitted_StatusValues` — same literal set, PreviewCreativeSubmitted.status duplicates the canonical export. */
export const PreviewCreativeSubmitted_StatusValues = BuildCreativeAsyncSubmitted_StatusValues;
// --- ProductAudienceEvidenceRequirements ---
/** @deprecated use `AudienceEvidenceRequirements_EvidencePresenceValues` — same literal set, ProductAudienceEvidenceRequirements.evidence_presence duplicates the canonical export. */
export const ProductAudienceEvidenceRequirements_EvidencePresenceValues = AudienceEvidenceRequirements_EvidencePresenceValues;
/** @deprecated use `AudienceEvidenceRequirements_RequirementModeValues` — same literal set, ProductAudienceEvidenceRequirements.requirement_mode duplicates the canonical export. */
export const ProductAudienceEvidenceRequirements_RequirementModeValues = AudienceEvidenceRequirements_RequirementModeValues;
// --- ProductTarget ---
/** @deprecated use `ProductLocalFormatOptionReference_ScopeValues` — same literal set, ProductTarget.kind duplicates the canonical export. */
export const ProductTarget_KindValues = ProductLocalFormatOptionReference_ScopeValues;
// --- PropertyListApplication ---
/** @deprecated use `CollectionListApplication_EffectValues` — same literal set, PropertyListApplication.effect duplicates the canonical export. */
export const PropertyListApplication_EffectValues = CollectionListApplication_EffectValues;
// --- RawAttestation ---
/** @deprecated use `DigestAttestation_MethodValues` — same literal set, RawAttestation.method duplicates the canonical export. */
export const RawAttestation_MethodValues = DigestAttestation_MethodValues;
/** @deprecated use `DigestAttestation_PurposeValues` — same literal set, RawAttestation.purpose duplicates the canonical export. */
export const RawAttestation_PurposeValues = DigestAttestation_PurposeValues;
// --- RefineProposalsAsyncSubmitted ---
/** @deprecated use `BuildCreativeAsyncSubmitted_StatusValues` — same literal set, RefineProposalsAsyncSubmitted.status duplicates the canonical export. */
export const RefineProposalsAsyncSubmitted_StatusValues = BuildCreativeAsyncSubmitted_StatusValues;
// --- ReplaceTargetingValue ---
/** @deprecated use `ReplaceAssignment_OperationValues` — same literal set, ReplaceTargetingValue.operation duplicates the canonical export. */
export const ReplaceTargetingValue_OperationValues = ReplaceAssignment_OperationValues;
// --- ReportedOutcomeError ---
/** @deprecated use `CatalogItemAvailabilityError_RecoveryValues` — same literal set, ReportedOutcomeError.recovery duplicates the canonical export. */
export const ReportedOutcomeError_RecoveryValues = CatalogItemAvailabilityError_RecoveryValues;
// --- ReportingCapabilities ---
/** @deprecated use `CanonicalReportingCapabilities_DateRangeSupportValues` — same literal set, ReportingCapabilities.date_range_support duplicates the canonical export. */
export const ReportingCapabilities_DateRangeSupportValues = CanonicalReportingCapabilities_DateRangeSupportValues;
// --- ReportPlanAdjustmentResponse ---
/** @deprecated use `ReportPlanAdjustmentRequest_AdjustmentTypeValues` — same literal set, ReportPlanAdjustmentResponse.adjustment_type duplicates the canonical export. */
export const ReportPlanAdjustmentResponse_AdjustmentTypeValues = ReportPlanAdjustmentRequest_AdjustmentTypeValues;
// --- RequestProposalsAsyncSubmitted ---
/** @deprecated use `BuildCreativeAsyncSubmitted_StatusValues` — same literal set, RequestProposalsAsyncSubmitted.status duplicates the canonical export. */
export const RequestProposalsAsyncSubmitted_StatusValues = BuildCreativeAsyncSubmitted_StatusValues;
// --- SearchBrandResult ---
/** @deprecated use `GetBrandIdentitySuccess_KellerTypeValues` — same literal set, SearchBrandResult.keller_type duplicates the canonical export. */
export const SearchBrandResult_KellerTypeValues = GetBrandIdentitySuccess_KellerTypeValues;
// --- SignalCoverageForecast ---
/** @deprecated use `AcceptancePolicyProfile_CoverageValues` — same literal set, SignalCoverageForecast.bucket_completeness duplicates the canonical export. */
export const SignalCoverageForecast_BucketCompletenessValues = AcceptancePolicyProfile_CoverageValues;
// --- SignalDefinition ---
/** @deprecated use `SignalDefinition_LookbackWindowValues` — same literal set, SignalDefinition.refresh_cadence duplicates the canonical export. */
export const SignalDefinition_RefreshCadenceValues = SignalDefinition_LookbackWindowValues;
// --- SignalDefinitionEnrichment ---
/** @deprecated use `SignalDefinition_Art9BasisValues` — same literal set, SignalDefinitionEnrichment.art9_basis duplicates the canonical export. */
export const SignalDefinitionEnrichment_Art9BasisValues = SignalDefinition_Art9BasisValues;
/** @deprecated use `SignalDefinition_LookbackWindowValues` — same literal set, SignalDefinitionEnrichment.lookback_window duplicates the canonical export. */
export const SignalDefinitionEnrichment_LookbackWindowValues = SignalDefinition_LookbackWindowValues;
/** @deprecated use `SignalDefinition_MethodologyValues` — same literal set, SignalDefinitionEnrichment.methodology duplicates the canonical export. */
export const SignalDefinitionEnrichment_MethodologyValues = SignalDefinition_MethodologyValues;
/** @deprecated use `SignalDefinition_LookbackWindowValues` — same literal set, SignalDefinitionEnrichment.refresh_cadence duplicates the canonical export. */
export const SignalDefinitionEnrichment_RefreshCadenceValues = SignalDefinition_LookbackWindowValues;
// --- SignalSelectionGroupRule ---
/** @deprecated use `CollectionListApplication_EffectValues` — same literal set, SignalSelectionGroupRule.targeting_mode duplicates the canonical export. */
export const SignalSelectionGroupRule_TargetingModeValues = CollectionListApplication_EffectValues;
// --- SignalTargetingRules ---
/** @deprecated use `SignalSelectionGroupRule_SelectionModeValues` — same literal set, SignalTargetingRules.selection_mode duplicates the canonical export. */
export const SignalTargetingRules_SelectionModeValues = SignalSelectionGroupRule_SelectionModeValues;
// --- SyncAudiencesSubmitted ---
/** @deprecated use `BuildCreativeAsyncSubmitted_StatusValues` — same literal set, SyncAudiencesSubmitted.status duplicates the canonical export. */
export const SyncAudiencesSubmitted_StatusValues = BuildCreativeAsyncSubmitted_StatusValues;
// --- SyncCatalogsAsyncSubmitted ---
/** @deprecated use `BuildCreativeAsyncSubmitted_StatusValues` — same literal set, SyncCatalogsAsyncSubmitted.status duplicates the canonical export. */
export const SyncCatalogsAsyncSubmitted_StatusValues = BuildCreativeAsyncSubmitted_StatusValues;
// --- SyncCatalogsSubmitted ---
/** @deprecated use `BuildCreativeAsyncSubmitted_StatusValues` — same literal set, SyncCatalogsSubmitted.status duplicates the canonical export. */
export const SyncCatalogsSubmitted_StatusValues = BuildCreativeAsyncSubmitted_StatusValues;
// --- SyncCatalogsSuccess ---
/** @deprecated use `CommittedMediaBuy_StatusValues` — same literal set, SyncCatalogsSuccess.status duplicates the canonical export. */
export const SyncCatalogsSuccess_StatusValues = CommittedMediaBuy_StatusValues;
// --- SyncCreativesAsyncSubmitted ---
/** @deprecated use `BuildCreativeAsyncSubmitted_StatusValues` — same literal set, SyncCreativesAsyncSubmitted.status duplicates the canonical export. */
export const SyncCreativesAsyncSubmitted_StatusValues = BuildCreativeAsyncSubmitted_StatusValues;
// --- SyncCreativesSubmitted ---
/** @deprecated use `BuildCreativeAsyncSubmitted_StatusValues` — same literal set, SyncCreativesSubmitted.status duplicates the canonical export. */
export const SyncCreativesSubmitted_StatusValues = BuildCreativeAsyncSubmitted_StatusValues;
// --- TagURL ---
/** @deprecated use `DisplayTagFormatDeclaration_FormatKindValues` — same literal set, TagURL.asset_type duplicates the canonical export. */
export const TagURL_AssetTypeValues = DisplayTagFormatDeclaration_FormatKindValues;
// --- TextAsset ---
/** @deprecated use `GroupTextAsset_AssetTypeValues` — same literal set, TextAsset.asset_type duplicates the canonical export. */
export const TextAsset_AssetTypeValues = GroupTextAsset_AssetTypeValues;
// --- TextDecoration ---
/** @deprecated use `GroupTextAsset_AssetTypeValues` — same literal set, TextDecoration.kind duplicates the canonical export. */
export const TextDecoration_KindValues = GroupTextAsset_AssetTypeValues;
// --- TimeForecastDimension ---
/** @deprecated use `TimeBasedPricingOption_PricingModelValues` — same literal set, TimeForecastDimension.kind duplicates the canonical export. */
export const TimeForecastDimension_KindValues = TimeBasedPricingOption_PricingModelValues;
// --- UpdateMediaBuyAsyncSubmitted ---
/** @deprecated use `BuildCreativeAsyncSubmitted_StatusValues` — same literal set, UpdateMediaBuyAsyncSubmitted.status duplicates the canonical export. */
export const UpdateMediaBuyAsyncSubmitted_StatusValues = BuildCreativeAsyncSubmitted_StatusValues;
// --- UpdateMediaBuySubmitted ---
/** @deprecated use `BuildCreativeAsyncSubmitted_StatusValues` — same literal set, UpdateMediaBuySubmitted.status duplicates the canonical export. */
export const UpdateMediaBuySubmitted_StatusValues = BuildCreativeAsyncSubmitted_StatusValues;
// --- URLAsset ---
/** @deprecated use `GroupUrlAsset_AssetTypeValues` — same literal set, URLAsset.asset_type duplicates the canonical export. */
export const URLAsset_AssetTypeValues = GroupUrlAsset_AssetTypeValues;
// --- URLAsset1 ---
/** @deprecated use `GroupUrlAsset_AssetTypeValues` — same literal set, URLAsset1.asset_type duplicates the canonical export. */
export const URLAsset1_AssetTypeValues = GroupUrlAsset_AssetTypeValues;
// --- VASTTrackerConstraints ---
/** @deprecated use `VASTTrackerAsset_TargetValues` — same literal set, VASTTrackerConstraints.target duplicates the canonical export. */
export const VASTTrackerConstraints_TargetValues = VASTTrackerAsset_TargetValues;
// --- VerifyBrandClaimsResultSuccess ---
/** @deprecated use `SignedSuccessPayload_ClaimTypeValues` — same literal set, VerifyBrandClaimsResultSuccess.claim_type duplicates the canonical export. */
export const VerifyBrandClaimsResultSuccess_ClaimTypeValues = SignedSuccessPayload_ClaimTypeValues;
// --- VerifyBrandClaimSuccess ---
/** @deprecated use `SignedSuccessPayload_ClaimTypeValues` — same literal set, VerifyBrandClaimSuccess.claim_type duplicates the canonical export. */
export const VerifyBrandClaimSuccess_ClaimTypeValues = SignedSuccessPayload_ClaimTypeValues;
// --- VerifyPropertyClaim ---
/** @deprecated use `PropertyListApplication_ListTypeValues` — same literal set, VerifyPropertyClaim.claim_type duplicates the canonical export. */
export const VerifyPropertyClaim_ClaimTypeValues = PropertyListApplication_ListTypeValues;
// --- VideoAsset ---
/** @deprecated use `GroupVideoAsset_AssetTypeValues` — same literal set, VideoAsset.asset_type duplicates the canonical export. */
export const VideoAsset_AssetTypeValues = GroupVideoAsset_AssetTypeValues;
// --- VideoAssetRequirements ---
/** @deprecated use `CanonicalFormatHostedVideo_VideoCodecsValues` — same literal set, VideoAssetRequirements.codecs duplicates the canonical export. */
export const VideoAssetRequirements_CodecsValues = CanonicalFormatHostedVideo_VideoCodecsValues;
// --- WebhookAsset ---
/** @deprecated use `GroupWebhookAsset_AssetTypeValues` — same literal set, WebhookAsset.asset_type duplicates the canonical export. */
export const WebhookAsset_AssetTypeValues = GroupWebhookAsset_AssetTypeValues;
// --- WebhookChallenge ---
/** @deprecated use `AgentWebhookChallenge_TypeValues` — same literal set, WebhookChallenge.type duplicates the canonical export. */
export const WebhookChallenge_TypeValues = AgentWebhookChallenge_TypeValues;
// --- WholesaleFeedWebhook ---
/** @deprecated use `GetProductsCompletion_CacheScopeValues` — same literal set, WholesaleFeedWebhook.cache_scope duplicates the canonical export. */
export const WholesaleFeedWebhook_CacheScopeValues = GetProductsCompletion_CacheScopeValues;
/** @deprecated use `NotificationConfig_ProductPayloadViewValues` — same literal set, WholesaleFeedWebhook.product_payload_view duplicates the canonical export. */
export const WholesaleFeedWebhook_ProductPayloadViewValues = NotificationConfig_ProductPayloadViewValues;
