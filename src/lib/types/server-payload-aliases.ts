/**
 * Named server/adopter payload aliases for generated AdCP response types.
 *
 * Generated `*Response` and `*Success` types describe wire responses. Server
 * handlers return the domain payload before the SDK stamps protocol envelope
 * fields such as `status`, `task_id`, and `adcp_version`. These aliases make
 * that distinction discoverable from the public barrels.
 */

import type {
  ActivateSignalSuccess,
  BuildCreativeMultiSuccess,
  BuildCreativeSuccess,
  CalibrateContentResponse,
  CheckGovernanceResponse,
  CreateCollectionListResponse,
  CreateContentStandardsResponse,
  CreateMediaBuySuccess,
  CreatePropertyListResponse,
  DeleteCollectionListResponse,
  DeletePropertyListResponse,
  GetAccountFinancialsResponse,
  GetAccountFinancialsSuccess,
  GetAdCPCapabilitiesResponse,
  GetCollectionListResponse,
  GetContentStandardsResponse,
  GetCreativeDeliveryResponse,
  GetCreativeFeaturesResponse,
  GetMediaBuyArtifactsResponse,
  GetMediaBuyDeliveryResponse,
  GetMediaBuysResponse,
  GetPlanAuditLogsResponse,
  GetProductsResponse,
  GetPropertyListResponse,
  GetSignalsResponse,
  ListAccountsResponse,
  ListCollectionListsResponse,
  ListContentStandardsResponse,
  ListCreativeFormatsResponse,
  ListCreativesResponse,
  ListPropertyListsResponse,
  LogEventSuccess,
  PreviewCreativeResponse,
  ProvidePerformanceFeedbackSuccess,
  ReportPlanOutcomeResponse,
  ReportUsageResponse,
  SIGetOfferingResponse,
  SIInitiateSessionResponse,
  SISendMessageResponse,
  SITerminateSessionResponse,
  SyncAccountsResponse,
  SyncAccountsSuccess,
  SyncAudiencesSuccess,
  SyncCatalogsSuccess,
  SyncCreativesError,
  SyncCreativesSuccess,
  SyncEventSourcesSuccess,
  SyncGovernanceResponse,
  SyncGovernanceSuccess,
  SyncPlansResponse,
  UpdateCollectionListResponse,
  UpdateContentStandardsResponse,
  UpdateMediaBuySuccess,
  UpdatePropertyListResponse,
  ValidateContentDeliveryResponse,
} from './tools.generated';
import type {
  AcquireRightsAcquired,
  AcquireRightsPendingApproval,
  AcquireRightsRejected,
  CreativeApproved,
  CreativePendingReview,
  CreativeRejected,
  GetBrandIdentitySuccess,
  GetRightsResponse,
  GetRightsSuccess,
  UpdateRightsSuccess,
} from './core.generated';
import type { RequireCacheScopeWhenProducts, ServerPayload } from './server-payload';

export type GetAdCPCapabilitiesPayload = ServerPayload<GetAdCPCapabilitiesResponse>;

export type ListAccountsPayload = ServerPayload<ListAccountsResponse>;
export type SyncAccountsPayload = ServerPayload<SyncAccountsResponse>;
export type SyncAccountsSuccessPayload = ServerPayload<SyncAccountsSuccess>;
export type SyncGovernancePayload = ServerPayload<SyncGovernanceResponse>;
export type SyncGovernanceSuccessPayload = ServerPayload<SyncGovernanceSuccess>;
export type ReportUsagePayload = ServerPayload<ReportUsageResponse>;
export type GetAccountFinancialsPayload = ServerPayload<GetAccountFinancialsResponse>;
export type GetAccountFinancialsSuccessPayload = ServerPayload<GetAccountFinancialsSuccess>;

export type GetProductsPayload = RequireCacheScopeWhenProducts<ServerPayload<GetProductsResponse>>;
export type CreateMediaBuyPayload = ServerPayload<CreateMediaBuySuccess>;
export type UpdateMediaBuyPayload = ServerPayload<UpdateMediaBuySuccess>;
export type GetMediaBuysPayload = ServerPayload<GetMediaBuysResponse>;
export type GetMediaBuyDeliveryPayload = ServerPayload<GetMediaBuyDeliveryResponse>;
export type ProvidePerformanceFeedbackPayload = ServerPayload<ProvidePerformanceFeedbackSuccess>;
/** Canonical server handler payload alias for `list_creative_formats`. */
export type ListCreativeFormatsPayload = ServerPayload<ListCreativeFormatsResponse>;
/** Equivalent alias retained for response-centric naming/search. Prefer `ListCreativeFormatsPayload` in new code. */
export type ListCreativeFormatsResponsePayload = ListCreativeFormatsPayload;
/** Equivalent alias retained for server-centric naming/search. Prefer `ListCreativeFormatsPayload` in new code. */
export type ListCreativeFormatsServerPayload = ListCreativeFormatsPayload;
export type ListCreativesPayload = ServerPayload<ListCreativesResponse>;
export type SyncCreativesSuccessPayload = ServerPayload<SyncCreativesSuccess>;
export type SyncCreativesErrorPayload = ServerPayload<SyncCreativesError>;
export type SyncCreativesPayload = SyncCreativesSuccessPayload | SyncCreativesErrorPayload;
export type SyncCatalogsPayload = ServerPayload<SyncCatalogsSuccess>;
export type SyncEventSourcesPayload = ServerPayload<SyncEventSourcesSuccess>;
export type LogEventPayload = ServerPayload<LogEventSuccess>;

export type GetSignalsPayload = ServerPayload<GetSignalsResponse>;
export type ActivateSignalPayload = ServerPayload<ActivateSignalSuccess>;

export type SyncAudiencesPayload = ServerPayload<SyncAudiencesSuccess>;

export type BuildCreativePayload = ServerPayload<BuildCreativeSuccess>;
export type BuildCreativeMultiPayload = ServerPayload<BuildCreativeMultiSuccess>;
export type PreviewCreativePayload = ServerPayload<PreviewCreativeResponse>;
export type GetCreativeDeliveryPayload = ServerPayload<GetCreativeDeliveryResponse>;

export type CreatePropertyListPayload = ServerPayload<CreatePropertyListResponse>;
export type UpdatePropertyListPayload = ServerPayload<UpdatePropertyListResponse>;
export type GetPropertyListPayload = ServerPayload<GetPropertyListResponse>;
export type ListPropertyListsPayload = ServerPayload<ListPropertyListsResponse>;
export type DeletePropertyListPayload = ServerPayload<DeletePropertyListResponse>;
export type CreateCollectionListPayload = ServerPayload<CreateCollectionListResponse>;
export type UpdateCollectionListPayload = ServerPayload<UpdateCollectionListResponse>;
export type GetCollectionListPayload = ServerPayload<GetCollectionListResponse>;
export type ListCollectionListsPayload = ServerPayload<ListCollectionListsResponse>;
export type DeleteCollectionListPayload = ServerPayload<DeleteCollectionListResponse>;

export type ListContentStandardsPayload = ServerPayload<ListContentStandardsResponse>;
export type GetContentStandardsPayload = ServerPayload<GetContentStandardsResponse>;
export type CreateContentStandardsPayload = ServerPayload<CreateContentStandardsResponse>;
export type UpdateContentStandardsPayload = ServerPayload<UpdateContentStandardsResponse>;
export type CalibrateContentPayload = ServerPayload<CalibrateContentResponse>;
export type ValidateContentDeliveryPayload = ServerPayload<ValidateContentDeliveryResponse>;
export type GetMediaBuyArtifactsPayload = ServerPayload<GetMediaBuyArtifactsResponse>;
export type GetCreativeFeaturesPayload = ServerPayload<GetCreativeFeaturesResponse>;

export type SyncPlansPayload = ServerPayload<SyncPlansResponse>;
export type CheckGovernancePayload = ServerPayload<CheckGovernanceResponse>;
export type ReportPlanOutcomePayload = ServerPayload<ReportPlanOutcomeResponse>;
export type GetPlanAuditLogsPayload = ServerPayload<GetPlanAuditLogsResponse>;

export type SIGetOfferingPayload = ServerPayload<SIGetOfferingResponse>;
export type SIInitiateSessionPayload = ServerPayload<SIInitiateSessionResponse>;
export type SISendMessagePayload = ServerPayload<SISendMessageResponse>;
export type SITerminateSessionPayload = ServerPayload<SITerminateSessionResponse>;

export type GetBrandIdentityPayload = ServerPayload<GetBrandIdentitySuccess>;
export type GetRightsPayload = ServerPayload<GetRightsSuccess>;
export type GetRightsResponsePayload = ServerPayload<GetRightsResponse>;
export type AcquireRightsAcquiredPayload = ServerPayload<AcquireRightsAcquired>;
export type AcquireRightsPendingApprovalPayload = ServerPayload<AcquireRightsPendingApproval>;
export type AcquireRightsRejectedPayload = ServerPayload<AcquireRightsRejected>;
export type AcquireRightsPayload =
  | AcquireRightsAcquiredPayload
  | AcquireRightsPendingApprovalPayload
  | AcquireRightsRejectedPayload;
export type UpdateRightsPayload = ServerPayload<UpdateRightsSuccess>;

export type CreativeApprovedPayload = ServerPayload<CreativeApproved>;
export type CreativeRejectedPayload = ServerPayload<CreativeRejected>;
export type CreativePendingReviewPayload = ServerPayload<CreativePendingReview>;
export type CreativeApprovalPayload = CreativeApprovedPayload | CreativeRejectedPayload | CreativePendingReviewPayload;
