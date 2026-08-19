import type {
  CatalogItemDeliveryMetrics,
  GeoDeliveryMetrics,
  KeywordDeliveryMetrics,
  PostalCountrySystem,
  SyncCreativesSuccess as CoreSyncCreativesSuccess,
  TasksGetResponse,
} from '../lib/types/core.generated';
import type {
  AdCPVersionEnvelope as ToolAdCPVersionEnvelope,
  CatalogItemDeliveryMetrics as ToolCatalogItemDeliveryMetrics,
  CanonicalFormatBase as ToolCanonicalFormatBase,
  GeoDeliveryMetrics as ToolGeoDeliveryMetrics,
  GetMediaBuyDeliveryCatalogItemMetrics,
  GetMediaBuyDeliveryGeoMetrics,
  GetMediaBuyDeliveryKeywordMetrics,
  KeywordDeliveryMetrics as ToolKeywordDeliveryMetrics,
  PostalCountrySystem as ToolPostalCountrySystem,
  ProtocolEnvelope as ToolProtocolEnvelope,
  RefineProposalsResponse,
  SignalDefinitionEnrichment as ToolSignalDefinitionEnrichment,
  SignalTargetingExpression as ToolSignalTargetingExpression,
  SyncCreativesSuccess as ToolSyncCreativesSuccess,
} from '../lib/types/tools.generated';

type Assert<T extends true> = T;
type AssertFalse<T extends false> = T;
type IsRequired<T, K extends keyof T> = {} extends Pick<T, K> ? false : true;
type IsOptional<T, K extends keyof T> = {} extends Pick<T, K> ? true : false;
type HasKey<T, K extends PropertyKey> = K extends keyof T ? true : false;

// Canonical core types must preserve every required property declared by their
// source JSON Schema. Compatibility widening belongs on tool-specific response
// shapes and must not leak into these shared types through codegen de-duplication.
type _GeoLevelIsRequired = Assert<IsRequired<GeoDeliveryMetrics, 'geo_level'>>;
type _GeoCodeIsRequired = Assert<IsRequired<GeoDeliveryMetrics, 'geo_code'>>;
type _KeywordIsRequired = Assert<IsRequired<KeywordDeliveryMetrics, 'keyword'>>;
type _MatchTypeIsRequired = Assert<IsRequired<KeywordDeliveryMetrics, 'match_type'>>;
type _ContentIdIsRequired = Assert<IsRequired<CatalogItemDeliveryMetrics, 'content_id'>>;
type _PostalCountryIsRequired = Assert<IsRequired<PostalCountrySystem, 'country'>>;
type _PostalSystemIsRequired = Assert<IsRequired<PostalCountrySystem, 'system'>>;
type _TaskProtocolIsRequired = Assert<IsRequired<TasksGetResponse, 'protocol'>>;

// The core copy is also reached through MCPWebhookPayload's broad async
// response union. Keep that generation path from erasing the inline
// sync_creatives result item to `{}` while the tool-local copy stays intact.
type CoreSyncCreative = CoreSyncCreativesSuccess['creatives'][number];
type ToolSyncCreative = ToolSyncCreativesSuccess['creatives'][number];
type _CoreSyncCreativeIdIsRequired = Assert<IsRequired<CoreSyncCreative, 'creative_id'>>;
type _CoreSyncCreativeActionIsRequired = Assert<IsRequired<CoreSyncCreative, 'action'>>;
type _CoreSyncCreativeHasAccount = Assert<HasKey<CoreSyncCreative, 'account'>>;
type _CoreSyncCreativeHasStatus = Assert<HasKey<CoreSyncCreative, 'status'>>;
type _CoreSyncCreativeHasPlatformId = Assert<HasKey<CoreSyncCreative, 'platform_id'>>;
type _CoreSyncCreativeHasLocalization = Assert<HasKey<CoreSyncCreative, 'localization'>>;
type _CoreSyncCreativeHasChanges = Assert<HasKey<CoreSyncCreative, 'changes'>>;
type _CoreSyncCreativeHasErrors = Assert<HasKey<CoreSyncCreative, 'errors'>>;
type _CoreSyncCreativeHasWarnings = Assert<HasKey<CoreSyncCreative, 'warnings'>>;
type _CoreSyncCreativeHasPreviewUrl = Assert<HasKey<CoreSyncCreative, 'preview_url'>>;
type _CoreSyncCreativeHasExpiresAt = Assert<HasKey<CoreSyncCreative, 'expires_at'>>;
type _CoreSyncCreativeHasAssignedTo = Assert<HasKey<CoreSyncCreative, 'assigned_to'>>;
type _CoreSyncCreativeHasAssignmentErrors = Assert<HasKey<CoreSyncCreative, 'assignment_errors'>>;
type _ToolSyncCreativeIdIsRequired = Assert<IsRequired<ToolSyncCreative, 'creative_id'>>;
type _ToolSyncCreativeActionIsRequired = Assert<IsRequired<ToolSyncCreative, 'action'>>;

// The published @adcp/sdk/types/tools.generated deep import historically
// exported these canonical names. Keep them as strict core re-exports.
type _ToolCatalogContentIdIsRequired = Assert<IsRequired<ToolCatalogItemDeliveryMetrics, 'content_id'>>;
type _ToolKeywordIsRequired = Assert<IsRequired<ToolKeywordDeliveryMetrics, 'keyword'>>;
type _ToolMatchTypeIsRequired = Assert<IsRequired<ToolKeywordDeliveryMetrics, 'match_type'>>;
type _ToolGeoLevelIsRequired = Assert<IsRequired<ToolGeoDeliveryMetrics, 'geo_level'>>;
type _ToolGeoCodeIsRequired = Assert<IsRequired<ToolGeoDeliveryMetrics, 'geo_code'>>;
type _ToolPostalCountryIsRequired = Assert<IsRequired<ToolPostalCountrySystem, 'country'>>;
type _ToolProtocolStatusIsRequired = Assert<IsRequired<ToolProtocolEnvelope, 'status'>>;
type _ToolAdCPVersionEnvelopeExport = ToolAdCPVersionEnvelope;
type _ToolCanonicalFormatBaseExport = ToolCanonicalFormatBase;
type _ToolSignalDefinitionEnrichmentExport = ToolSignalDefinitionEnrichment;
type _ToolSignalTargetingExpressionExport = ToolSignalTargetingExpression;

// Refine result branches narrow CanonicalProposal; they do not replace it.
// Keep every canonical continuation field plus branch-specific lineage/status
// requirements on the generated deep-import surface and its Zod derivative.
type RefineCompleted = Extract<RefineProposalsResponse, { results: unknown }>;
type RefineSubmitted = Extract<RefineProposalsResponse, { status: 'submitted' }>;
type RefineResult = RefineCompleted['results'][number];
type RevisedProposal = Extract<RefineResult, { outcome: 'revised' }>['proposals'][number];
type PartialProposal = Extract<RefineResult, { outcome: 'partial' }>['proposals'][number];
type FinalizedProposal = Extract<RefineResult, { outcome: 'finalized' }>['proposal'];
type _RefineCompletedResultsRequired = Assert<IsRequired<RefineCompleted, 'results'>>;
type _RefineCompletedProductsRequired = Assert<IsRequired<RefineCompleted, 'products'>>;
type _RefineCompletedHasNoTaskId = AssertFalse<HasKey<RefineCompleted, 'task_id'>>;
type _RefineCompletedRejectsMixedFinalizeBatch = AssertFalse<
  [
    Extract<RefineResult, { outcome: 'revised' }>,
    Extract<RefineResult, { outcome: 'finalized' }>,
  ] extends RefineCompleted['results']
    ? true
    : false
>;
type _RefineSubmittedRejectsMixedFinalizeBatch = AssertFalse<
  [Extract<RefineResult, { outcome: 'revised' }>, Extract<RefineResult, { outcome: 'finalized' }>] extends NonNullable<
    RefineSubmitted['results']
  >
    ? true
    : false
>;
type _RevisedProposalIdRequired = Assert<IsRequired<RevisedProposal, 'proposal_id'>>;
type _RevisedCommercialTermsRequired = Assert<IsRequired<RevisedProposal, 'commercial_terms'>>;
type _RevisedTermsDigestRequired = Assert<IsRequired<RevisedProposal, 'terms_digest'>>;
type _RevisedParentProposalIdRequired = Assert<IsRequired<RevisedProposal, 'parent_proposal_id'>>;
type _PartialProposalIdRequired = Assert<IsRequired<PartialProposal, 'proposal_id'>>;
type _PartialCommercialTermsRequired = Assert<IsRequired<PartialProposal, 'commercial_terms'>>;
type _PartialTermsDigestRequired = Assert<IsRequired<PartialProposal, 'terms_digest'>>;
type _PartialParentProposalIdRequired = Assert<IsRequired<PartialProposal, 'parent_proposal_id'>>;
type _FinalizedProposalIdRequired = Assert<IsRequired<FinalizedProposal, 'proposal_id'>>;
type _FinalizedCommercialTermsRequired = Assert<IsRequired<FinalizedProposal, 'commercial_terms'>>;
type _FinalizedTermsDigestRequired = Assert<IsRequired<FinalizedProposal, 'terms_digest'>>;
type _FinalizedParentProposalIdRequired = Assert<IsRequired<FinalizedProposal, 'parent_proposal_id'>>;
type _FinalizedExpiresAtRequired = Assert<IsRequired<FinalizedProposal, 'expires_at'>>;

// Buyer-side tool responses retain tolerance for legacy sellers that predate
// the v3 breakdown identifiers. These aliases must stay distinct from the
// strict canonical authoring types above.
type _CompatContentIdIsOptional = Assert<IsOptional<GetMediaBuyDeliveryCatalogItemMetrics, 'content_id'>>;
type _CompatKeywordIsOptional = Assert<IsOptional<GetMediaBuyDeliveryKeywordMetrics, 'keyword'>>;
type _CompatMatchTypeIsOptional = Assert<IsOptional<GetMediaBuyDeliveryKeywordMetrics, 'match_type'>>;
type _CompatGeoLevelIsOptional = Assert<IsOptional<GetMediaBuyDeliveryGeoMetrics, 'geo_level'>>;
type _CompatGeoCodeIsOptional = Assert<IsOptional<GetMediaBuyDeliveryGeoMetrics, 'geo_code'>>;
