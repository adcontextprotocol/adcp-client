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
  create_content_standards: schemas.CreateContentStandardsResponseSchema,
  update_content_standards: schemas.UpdateContentStandardsResponseSchema,
  calibrate_content: schemas.CalibrateContentResponseSchema,
  validate_content_delivery: schemas.ValidateContentDeliveryResponseSchema,

  // Collection lists
  create_collection_list: schemas.CreateCollectionListResponseSchema,
  update_collection_list: schemas.UpdateCollectionListResponseSchema,
  get_collection_list: schemas.GetCollectionListResponseSchema,
  list_collection_lists: schemas.ListCollectionListsResponseSchema,
  delete_collection_list: schemas.DeleteCollectionListResponseSchema,

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

  // Property governance — validate_property_delivery has no generated schema yet.
  // Hand-written from protocol spec. Replace with generated schema when available.
  validate_property_delivery: z.union([
    z.object({ compliant: z.boolean() }).passthrough(),
    z.object({ errors: z.array(schemas.ErrorSchema) }).passthrough(),
  ]),

  // Brand rights
  get_brand_identity: schemas.GetBrandIdentityResponseSchema,
  get_rights: schemas.GetRightsResponseSchema,
  acquire_rights: schemas.AcquireRightsResponseSchema,

  // Brand rights — no schema definitions yet for these tools
  update_rights: z.union([
    z.object({ rights_id: z.string() }).passthrough(),
    z.object({ errors: z.array(schemas.ErrorSchema) }).passthrough(),
  ]),
  creative_approval: z.union([
    z.object({ decision: z.string() }).passthrough(),
    z.object({ errors: z.array(schemas.ErrorSchema) }).passthrough(),
  ]),
};

/**
 * Map of AdCP task names to the schema-index subdirectory that holds their
 * response schema. Drives the runner-output contract's `schema_id` / `schema_url`
 * fields so compliance reports tell implementors exactly which artifact to
 * re-validate against.
 *
 * The `$id` emitted for task X is `/schemas/{version}/{subdir}/{kebab(X)}-response.json`,
 * matching the convention in schemas/cache/{version}/index.json.
 */
export const TOOL_SCHEMA_SUBDIR: Partial<Record<string, string>> = {
  // Media buy
  get_products: 'media-buy',
  create_media_buy: 'media-buy',
  update_media_buy: 'media-buy',
  get_media_buys: 'media-buy',
  get_media_buy_delivery: 'media-buy',
  provide_performance_feedback: 'media-buy',
  list_creative_formats: 'media-buy',
  sync_event_sources: 'media-buy',
  log_event: 'media-buy',
  sync_audiences: 'media-buy',
  sync_catalogs: 'media-buy',
  get_media_buy_artifacts: 'media-buy',

  // Creative
  build_creative: 'creative',
  preview_creative: 'creative',
  sync_creatives: 'creative',
  list_creatives: 'creative',
  get_creative_delivery: 'creative',
  get_creative_features: 'creative',

  // Signals
  get_signals: 'signals',
  activate_signal: 'signals',

  // Account
  sync_accounts: 'account',
  list_accounts: 'account',
  sync_governance: 'account',
  report_usage: 'account',
  get_account_financials: 'account',

  // Governance — property lists, content standards, campaign governance
  create_property_list: 'governance',
  get_property_list: 'governance',
  update_property_list: 'governance',
  list_property_lists: 'governance',
  delete_property_list: 'governance',
  list_content_standards: 'content-standards',
  get_content_standards: 'content-standards',
  create_content_standards: 'content-standards',
  update_content_standards: 'content-standards',
  calibrate_content: 'content-standards',
  validate_content_delivery: 'content-standards',
  validate_property_delivery: 'governance',
  sync_plans: 'governance',
  check_governance: 'governance',
  report_plan_outcome: 'governance',
  get_plan_audit_logs: 'governance',

  // Collection lists
  create_collection_list: 'collection',
  update_collection_list: 'collection',
  get_collection_list: 'collection',
  list_collection_lists: 'collection',
  delete_collection_list: 'collection',

  // Sponsored Intelligence
  si_get_offering: 'si',
  si_initiate_session: 'si',
  si_send_message: 'si',
  si_terminate_session: 'si',

  // Capabilities
  get_adcp_capabilities: 'protocol',

  // Test controller
  comply_test_controller: 'compliance',

  // Brand rights
  get_brand_identity: 'brand',
  get_rights: 'brand',
  acquire_rights: 'brand',
  update_rights: 'brand',
  creative_approval: 'brand',
};

/**
 * Task-name kebabization matching the AdCP schema index (`{task}-response.json`).
 */
function toKebab(taskName: string): string {
  return taskName.replace(/_/g, '-');
}

/**
 * Return `{ schema_id, schema_url }` for a task's response schema, or `undefined`
 * when the task has no registered subdirectory.
 *
 * `schema_id` is the JSON-Schema `$id` convention used in schemas/cache/{version}/index.json.
 * `schema_url` is a resolvable URL an implementor can fetch to re-validate locally.
 */
export function getResponseSchemaLocator(
  taskName: string,
  adcpVersion: string
): { schema_id: string; schema_url: string } | undefined {
  const subdir = TOOL_SCHEMA_SUBDIR[taskName];
  if (!subdir) return undefined;
  const file = `${toKebab(taskName)}-response.json`;
  return {
    schema_id: `/schemas/${adcpVersion}/${subdir}/${file}`,
    schema_url: `https://adcontextprotocol.org/schemas/${adcpVersion}/${subdir}/${file}`,
  };
}
