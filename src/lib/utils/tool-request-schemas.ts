/**
 * Canonical map of AdCP tool names to their Zod request schemas.
 *
 * Use with MCP SDK's server.registerTool() for type-safe tool registration:
 *
 *   import { TOOL_REQUEST_SCHEMAS } from '@adcp/sdk';
 *   server.registerTool(
 *     'get_products',
 *     { inputSchema: TOOL_REQUEST_SCHEMAS.get_products.shape },
 *     handler
 *   );
 */

import { z } from 'zod';
import * as schemas from '../types/schemas.generated';

type InputShape = Record<string, z.ZodType>;
type WithOptionalAccountShape<TShape extends InputShape & { account: z.ZodType }> = Omit<TShape, 'account'> & {
  account: z.ZodOptional<TShape['account']>;
};

/**
 * Make `account` optional for MCP tool registration so requests missing it
 * reach the handler, which can return a proper adcpError('INVALID_REQUEST')
 * instead of a raw MCP schema validation error. The schema_validation
 * storyboard sends create_media_buy without account to test error handling.
 */
function withOptionalAccount<TShape extends InputShape & { account: z.ZodType }>(
  schema: z.ZodObject<TShape>
): z.ZodObject<WithOptionalAccountShape<TShape>, any> {
  return schema.extend({ account: schema.shape.account.optional() }) as z.ZodObject<
    WithOptionalAccountShape<TShape>,
    any
  >;
}

const CreateMediaBuyToolRequestSchema = withOptionalAccount(schemas.CreateMediaBuyRequestSchema);
const UpdateMediaBuyToolRequestSchema = withOptionalAccount(schemas.UpdateMediaBuyRequestSchema);

/**
 * Exact schema types for tool names known at build time. Prefer this type for
 * key-preserving helpers; use {@link ToolRequestSchemas} when accepting a
 * runtime string that may not match a known tool.
 */
export type KnownToolRequestSchemas = {
  get_products: typeof schemas.GetProductsRequestSchema;
  create_media_buy: typeof CreateMediaBuyToolRequestSchema;
  update_media_buy: typeof UpdateMediaBuyToolRequestSchema;
  get_media_buys: typeof schemas.GetMediaBuysRequestSchema;
  get_media_buy_delivery: typeof schemas.GetMediaBuyDeliveryRequestSchema;
  provide_performance_feedback: typeof schemas.ProvidePerformanceFeedbackRequestSchema;
  list_creative_formats: typeof schemas.ListCreativeFormatsRequestSchema;
  build_creative: typeof schemas.BuildCreativeRequestSchema;
  preview_creative: typeof schemas.PreviewCreativeRequestSchema;
  sync_creatives: typeof schemas.SyncCreativesRequestSchema;
  list_creatives: typeof schemas.ListCreativesRequestSchema;
  get_creative_delivery: typeof schemas.GetCreativeDeliveryRequestSchema;
  get_signals: typeof schemas.GetSignalsRequestSchema;
  activate_signal: typeof schemas.ActivateSignalRequestSchema;
  sync_accounts: typeof schemas.SyncAccountsRequestSchema;
  list_accounts: typeof schemas.ListAccountsRequestSchema;
  sync_governance: typeof schemas.SyncGovernanceRequestSchema;
  sync_audiences: typeof schemas.SyncAudiencesRequestSchema;
  report_usage: typeof schemas.ReportUsageRequestSchema;
  get_account_financials: typeof schemas.GetAccountFinancialsRequestSchema;
  sync_catalogs: typeof schemas.SyncCatalogsRequestSchema;
  sync_event_sources: typeof schemas.SyncEventSourcesRequestSchema;
  log_event: typeof schemas.LogEventRequestSchema;
  get_media_buy_artifacts: typeof schemas.GetMediaBuyArtifactsRequestSchema;
  get_creative_features: typeof schemas.GetCreativeFeaturesRequestSchema;
  create_property_list: typeof schemas.CreatePropertyListRequestSchema;
  get_property_list: typeof schemas.GetPropertyListRequestSchema;
  update_property_list: typeof schemas.UpdatePropertyListRequestSchema;
  list_property_lists: typeof schemas.ListPropertyListsRequestSchema;
  delete_property_list: typeof schemas.DeletePropertyListRequestSchema;
  list_content_standards: typeof schemas.ListContentStandardsRequestSchema;
  get_content_standards: typeof schemas.GetContentStandardsRequestSchema;
  create_content_standards: typeof schemas.CreateContentStandardsRequestSchema;
  update_content_standards: typeof schemas.UpdateContentStandardsRequestSchema;
  calibrate_content: typeof schemas.CalibrateContentRequestSchema;
  validate_content_delivery: typeof schemas.ValidateContentDeliveryRequestSchema;
  validate_property_delivery: typeof schemas.ValidatePropertyDeliveryRequestSchema;
  sync_plans: typeof schemas.SyncPlansRequestSchema;
  check_governance: typeof schemas.CheckGovernanceRequestSchema;
  report_plan_outcome: typeof schemas.ReportPlanOutcomeRequestSchema;
  get_plan_audit_logs: typeof schemas.GetPlanAuditLogsRequestSchema;
  create_collection_list: typeof schemas.CreateCollectionListRequestSchema;
  update_collection_list: typeof schemas.UpdateCollectionListRequestSchema;
  get_collection_list: typeof schemas.GetCollectionListRequestSchema;
  list_collection_lists: typeof schemas.ListCollectionListsRequestSchema;
  delete_collection_list: typeof schemas.DeleteCollectionListRequestSchema;
  si_get_offering: typeof schemas.SIGetOfferingRequestSchema;
  si_initiate_session: typeof schemas.SIInitiateSessionRequestSchema;
  si_send_message: typeof schemas.SISendMessageRequestSchema;
  si_terminate_session: typeof schemas.SITerminateSessionRequestSchema;
  get_adcp_capabilities: typeof schemas.GetAdCPCapabilitiesRequestSchema;
  comply_test_controller: typeof schemas.ComplyTestControllerRequestSchema;
  get_brand_identity: typeof schemas.GetBrandIdentityRequestSchema;
  get_rights: typeof schemas.GetRightsRequestSchema;
  acquire_rights: typeof schemas.AcquireRightsRequestSchema;
  update_rights: typeof schemas.UpdateRightsRequestSchema;
};

export type ToolRequestSchemas = Readonly<KnownToolRequestSchemas> & {
  // Dynamic lookups are supported for callers that receive tool names at
  // runtime, but they must narrow the result before dereferencing `.shape`.
  readonly [toolName: string]: z.ZodObject<any> | undefined;
};

export const TOOL_REQUEST_SCHEMAS: ToolRequestSchemas = {
  // Product discovery & media buy
  get_products: schemas.GetProductsRequestSchema,
  create_media_buy: CreateMediaBuyToolRequestSchema,
  update_media_buy: UpdateMediaBuyToolRequestSchema,
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
  update_rights: schemas.UpdateRightsRequestSchema,
};
