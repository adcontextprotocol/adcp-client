/**
 * Canonical map of AdCP tool names to their Zod response schemas.
 *
 * Shared by response-unwrapper (runtime parsing) and testing/client
 * (compliance validation) so the two never diverge.
 */

import { z } from 'zod';
import * as schemas from '../types/schemas.generated';
import { SyncCreativesResponseStrictSchema } from '../validation/sync-creatives';
import { isPre31AdcpVersion } from './adcp-version-config';

function declaresLegacy30xPayload(response: Record<string, unknown>): boolean {
  const adcpVersion = response.adcp_version;
  if (typeof adcpVersion === 'string') {
    return (
      adcpVersion === '3' || adcpVersion === '3.0' || adcpVersion.startsWith('3.0.') || adcpVersion.startsWith('3.0-')
    );
  }
  return response.adcp_major_version === 3;
}

export function prepareResponseForSchemaValidation(
  toolName: string,
  data: unknown,
  responseAdcpVersion?: string
): unknown {
  if (toolName !== 'get_products') return data;
  if (!isPre31AdcpVersion(responseAdcpVersion)) return data;
  if (data == null || typeof data !== 'object' || Array.isArray(data)) return data;

  const response = data as Record<string, unknown>;
  if (response.adcp_version !== undefined || response.adcp_major_version !== undefined) return data;
  return { ...response, adcp_version: '3.0' };
}

const GetProductsResponseStrictSchema = schemas.GetProductsResponseSchema.superRefine((value, ctx) => {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return;
  const response = value as { products?: unknown; cache_scope?: unknown; unchanged?: unknown };
  if (declaresLegacy30xPayload(response)) return;
  if ((Array.isArray(response.products) || response.unchanged === true) && response.cache_scope === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['cache_scope'],
      message: '`cache_scope` is required when `products` is present or `unchanged` is true',
    });
  }
});

export const TOOL_RESPONSE_SCHEMAS: Partial<Record<string, z.ZodType>> = {
  // Product discovery & media buy
  get_products: GetProductsResponseStrictSchema,
  create_media_buy: schemas.CreateMediaBuyResponseSchema,
  update_media_buy: schemas.UpdateMediaBuyResponseSchema,
  get_media_buys: schemas.GetMediaBuysResponseSchema,
  get_media_buy_delivery: schemas.GetMediaBuyDeliveryResponseSchema,
  provide_performance_feedback: schemas.ProvidePerformanceFeedbackResponseSchema,

  // Creative
  list_creative_formats: schemas.ListCreativeFormatsResponseSchema,
  build_creative: schemas.BuildCreativeResponseSchema,
  preview_creative: schemas.PreviewCreativeResponseSchema,
  // Override the generated schema — it degrades creatives[] to a bare
  // record because the JSON Schema inlines the item shape. The strict
  // variant carries the per-item validator so the pipeline catches drift.
  sync_creatives: SyncCreativesResponseStrictSchema,
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

  // Property governance
  validate_property_delivery: schemas.ValidatePropertyDeliveryResponseSchema,

  // Brand rights
  get_brand_identity: schemas.GetBrandIdentityResponseSchema,
  verify_brand_claim: schemas.VerifyBrandClaimResponseSchema,
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
  verify_brand_claims: schemas.VerifyBrandClaimsResponseBulkSchema,
  search_brands: schemas.SearchBrandsResponseSchema,
};
