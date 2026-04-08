/**
 * Canonical map of AdCP tool names to their Zod response schemas.
 *
 * Shared by response-unwrapper (runtime parsing) and testing/client
 * (compliance validation) so the two never diverge.
 */

import { z } from 'zod';
import * as schemas from '../types/schemas.generated';

export const TOOL_RESPONSE_SCHEMAS: Partial<Record<string, z.ZodType>> = {
  // Product discovery & media buy
  get_products: schemas.GetProductsResponseSchema,
  create_media_buy: schemas.CreateMediaBuyResponseSchema,
  update_media_buy: schemas.UpdateMediaBuyResponseSchema,
  get_media_buys: schemas.GetMediaBuysResponseSchema,
  get_media_buy_delivery: schemas.GetMediaBuyDeliveryResponseSchema,
  provide_performance_feedback: schemas.ProvidePerformanceFeedbackResponseSchema,

  // Creative
  list_creative_formats: schemas.ListCreativeFormatsResponseSchema,
  build_creative: schemas.BuildCreativeResponseSchema,
  preview_creative: schemas.PreviewCreativeResponseSchema,
  sync_creatives: schemas.SyncCreativesResponseSchema,
  list_creatives: schemas.ListCreativesResponseSchema,
  get_creative_delivery: schemas.GetCreativeDeliveryResponseSchema,

  // Signals
  get_signals: schemas.GetSignalsResponseSchema,
  activate_signal: schemas.ActivateSignalResponseSchema,

  // Account & audience
  sync_accounts: schemas.SyncAccountsResponseSchema,
  list_accounts: schemas.ListAccountsResponseSchema,
  sync_governance: schemas.SyncGovernanceResponseSchema,
  sync_audiences: schemas.SyncAudiencesResponseSchema,
  report_usage: schemas.ReportUsageResponseSchema,
  get_account_financials: schemas.GetAccountFinancialsResponseSchema,

  // Catalogs & events
  sync_catalogs: schemas.SyncCatalogsResponseSchema,
  sync_event_sources: schemas.SyncEventSourcesResponseSchema,
  log_event: schemas.LogEventResponseSchema,
  get_media_buy_artifacts: schemas.GetMediaBuyArtifactsResponseSchema,

  // Creative (additional)
  get_creative_features: schemas.GetCreativeFeaturesResponseSchema,

  // Governance — property lists & content standards
  create_property_list: schemas.CreatePropertyListResponseSchema,
  get_property_list: schemas.GetPropertyListResponseSchema,
  update_property_list: schemas.UpdatePropertyListResponseSchema,
  list_property_lists: schemas.ListPropertyListsResponseSchema,
  delete_property_list: schemas.DeletePropertyListResponseSchema,
  list_content_standards: schemas.ListContentStandardsResponseSchema,
  get_content_standards: schemas.GetContentStandardsResponseSchema,
  calibrate_content: schemas.CalibrateContentResponseSchema,
  validate_content_delivery: schemas.ValidateContentDeliveryResponseSchema,

  // Campaign governance
  sync_plans: schemas.SyncPlansResponseSchema,
  check_governance: schemas.CheckGovernanceResponseSchema,
  report_plan_outcome: schemas.ReportPlanOutcomeResponseSchema,
  get_plan_audit_logs: schemas.GetPlanAuditLogsResponseSchema,

  // Sponsored Intelligence
  si_get_offering: schemas.SIGetOfferingResponseSchema,
  si_initiate_session: schemas.SIInitiateSessionResponseSchema,
  si_send_message: schemas.SISendMessageResponseSchema,
  si_terminate_session: schemas.SITerminateSessionResponseSchema,

  // Capabilities
  get_adcp_capabilities: schemas.GetAdCPCapabilitiesResponseSchema,

  // Test controller
  comply_test_controller: schemas.ComplyTestControllerResponseSchema,
};
