/**
 * Canonical map of AdCP tool names to their Zod request schemas.
 *
 * Use with MCP SDK's server.tool() for type-safe tool registration:
 *
 *   import { TOOL_REQUEST_SCHEMAS } from '@adcp/client';
 *   server.tool('get_products', TOOL_REQUEST_SCHEMAS.get_products.shape, handler);
 */

import { z } from 'zod';
import * as schemas from '../types/schemas.generated';

/**
 * Make `account` optional for MCP tool registration so requests missing it
 * reach the handler, which can return a proper adcpError('INVALID_REQUEST')
 * instead of a raw MCP schema validation error. The schema_validation
 * storyboard sends create_media_buy without account to test error handling.
 */
function withOptionalAccount<T extends z.ZodObject<any>>(schema: T) {
  return schema.extend({ account: schema.shape.account.optional() });
}

export const TOOL_REQUEST_SCHEMAS: Partial<Record<string, z.ZodType>> = {
  // Product discovery & media buy
  get_products: schemas.GetProductsRequestSchema,
  create_media_buy: withOptionalAccount(schemas.CreateMediaBuyRequestSchema),
  update_media_buy: withOptionalAccount(schemas.UpdateMediaBuyRequestSchema),
  get_media_buys: schemas.GetMediaBuysRequestSchema,
  get_media_buy_delivery: schemas.GetMediaBuyDeliveryRequestSchema,
  provide_performance_feedback: schemas.ProvidePerformanceFeedbackRequestSchema,

  // Creative
  list_creative_formats: schemas.ListCreativeFormatsRequestSchema,
  build_creative: schemas.BuildCreativeRequestSchema,
  preview_creative: schemas.PreviewCreativeRequestSchema,
  sync_creatives: schemas.SyncCreativesRequestSchema,
  list_creatives: schemas.ListCreativesRequestSchema,
  get_creative_delivery: schemas.GetCreativeDeliveryRequestSchema,

  // Signals
  get_signals: schemas.GetSignalsRequestSchema,
  activate_signal: schemas.ActivateSignalRequestSchema,

  // Account & audience
  sync_accounts: schemas.SyncAccountsRequestSchema,
  list_accounts: schemas.ListAccountsRequestSchema,
  sync_governance: schemas.SyncGovernanceRequestSchema,
  sync_audiences: schemas.SyncAudiencesRequestSchema,
  report_usage: schemas.ReportUsageRequestSchema,
  get_account_financials: schemas.GetAccountFinancialsRequestSchema,

  // Catalogs & events
  sync_catalogs: schemas.SyncCatalogsRequestSchema,
  sync_event_sources: schemas.SyncEventSourcesRequestSchema,
  log_event: schemas.LogEventRequestSchema,
  get_media_buy_artifacts: schemas.GetMediaBuyArtifactsRequestSchema,

  // Creative (additional)
  get_creative_features: schemas.GetCreativeFeaturesRequestSchema,

  // Governance — property lists & content standards
  create_property_list: schemas.CreatePropertyListRequestSchema,
  get_property_list: schemas.GetPropertyListRequestSchema,
  update_property_list: schemas.UpdatePropertyListRequestSchema,
  list_property_lists: schemas.ListPropertyListsRequestSchema,
  delete_property_list: schemas.DeletePropertyListRequestSchema,
  list_content_standards: schemas.ListContentStandardsRequestSchema,
  get_content_standards: schemas.GetContentStandardsRequestSchema,
  create_content_standards: schemas.CreateContentStandardsRequestSchema,
  update_content_standards: schemas.UpdateContentStandardsRequestSchema,
  calibrate_content: schemas.CalibrateContentRequestSchema,
  validate_content_delivery: schemas.ValidateContentDeliveryRequestSchema,
  validate_property_delivery: schemas.ValidatePropertyDeliveryRequestSchema,

  // Campaign governance
  sync_plans: schemas.SyncPlansRequestSchema,
  check_governance: schemas.CheckGovernanceRequestSchema,
  report_plan_outcome: schemas.ReportPlanOutcomeRequestSchema,
  get_plan_audit_logs: schemas.GetPlanAuditLogsRequestSchema,

  // Collection lists
  create_collection_list: schemas.CreateCollectionListRequestSchema,
  update_collection_list: schemas.UpdateCollectionListRequestSchema,
  get_collection_list: schemas.GetCollectionListRequestSchema,
  list_collection_lists: schemas.ListCollectionListsRequestSchema,
  delete_collection_list: schemas.DeleteCollectionListRequestSchema,

  // Sponsored Intelligence
  si_get_offering: schemas.SIGetOfferingRequestSchema,
  si_initiate_session: schemas.SIInitiateSessionRequestSchema,
  si_send_message: schemas.SISendMessageRequestSchema,
  si_terminate_session: schemas.SITerminateSessionRequestSchema,

  // Capabilities
  get_adcp_capabilities: schemas.GetAdCPCapabilitiesRequestSchema,

  // Test controller
  comply_test_controller: schemas.ComplyTestControllerRequestSchema,

  // Brand rights
  get_brand_identity: schemas.GetBrandIdentityRequestSchema,
  get_rights: schemas.GetRightsRequestSchema,
  acquire_rights: schemas.AcquireRightsRequestSchema,
};
