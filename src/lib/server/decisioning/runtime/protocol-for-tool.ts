/**
 * Tool-name → AdCP protocol category mapping.
 *
 * Goes on the webhook payload's `protocol` field (per `enums/adcp-protocol.json`)
 * and on the `tasks_get` lifecycle response so receivers can route to the
 * right pipeline before parsing the task body.
 *
 * The map is exported as a plain `Record<string, AdcpProtocol>` so adopters
 * with framework-extension code paths can introspect it (e.g., to build
 * per-protocol metric emitters).
 *
 * @public
 */

import type { AdCPProtocol } from '../../../types/core.generated';

type AdcpProtocol = AdCPProtocol;

/**
 * Tool-name → protocol lookup. Keys are wire tool names (snake_case). Values
 * are the 6 closed-enum protocol categories from `enums/adcp-protocol.json`.
 *
 * Tools not in this map fall through to `'media-buy'` — sales is the
 * largest specialism and the safest default for unknown tools (anything
 * the framework dispatches but isn't catalogued here is most likely a new
 * sales tool added in a downstream release).
 */
export const TOOL_PROTOCOL_MAP: Readonly<Record<string, AdcpProtocol>> = {
  // sponsored-intelligence
  si_initiate_session: 'sponsored-intelligence',
  si_send_message: 'sponsored-intelligence',
  si_end_session: 'sponsored-intelligence',
  si_get_session: 'sponsored-intelligence',

  // governance
  check_governance: 'governance',
  sync_plans: 'governance',
  report_plan_outcome: 'governance',
  get_plan_audit_logs: 'governance',
  get_media_buy_artifacts: 'governance',
  calibrate_content: 'governance',
  validate_content_delivery: 'governance',
  create_property_list: 'governance',
  update_property_list: 'governance',
  get_property_list: 'governance',
  list_property_lists: 'governance',
  delete_property_list: 'governance',
  create_collection_list: 'governance',
  update_collection_list: 'governance',
  get_collection_list: 'governance',
  list_collection_lists: 'governance',
  delete_collection_list: 'governance',
  create_content_standards: 'governance',
  update_content_standards: 'governance',
  get_content_standards: 'governance',

  // signals
  get_signals: 'signals',
  activate_signal: 'signals',

  // creative
  build_creative: 'creative',
  preview_creative: 'creative',
  get_creative_delivery: 'creative',
  list_creative_formats: 'creative',
  list_creatives: 'creative',
  sync_creatives: 'creative',

  // brand
  get_brand_identity: 'brand',
  get_rights: 'brand',
  acquire_rights: 'brand',

  // media-buy (explicit listing — anything not here falls back to media-buy)
  get_products: 'media-buy',
  create_media_buy: 'media-buy',
  update_media_buy: 'media-buy',
  get_media_buy_delivery: 'media-buy',
  sync_audiences: 'media-buy',
  sync_accounts: 'media-buy',
  list_accounts: 'media-buy',
  get_account_financials: 'media-buy',
  report_usage: 'media-buy',
  log_event: 'media-buy',
  sync_event_sources: 'media-buy',
  sync_catalogs: 'media-buy',
  provide_performance_feedback: 'media-buy',
  get_media_buys: 'media-buy',
};

/**
 * Map a v6 tool name to its AdCP protocol category. Falls back to
 * `'media-buy'` for unknown tools — see `TOOL_PROTOCOL_MAP` JSDoc.
 */
export function protocolForTool(tool: string): AdcpProtocol {
  return TOOL_PROTOCOL_MAP[tool] ?? 'media-buy';
}

/**
 * Tools whose `task_type` value is permitted in the v6.0 webhook payload
 * envelope. Spec `enums/task-type.json` is a closed 20-value enum at AdCP
 * 3.0 GA — receivers validate against it. Tools NOT in this set still
 * dispatch fine but the framework MUST NOT emit a webhook with a
 * non-spec `task_type` value (it would be rejected by spec-validating
 * subscribers).
 *
 * Tracking spec issue to widen the enum: filing as `adcontextprotocol/adcp`
 * follow-up. Until that lands the framework gates webhook delivery to
 * spec-listed tools and uses `publishStatusChange` for the rest.
 *
 * @internal
 */
export const SPEC_WEBHOOK_TASK_TYPES: ReadonlySet<string> = new Set([
  'create_media_buy',
  'update_media_buy',
  'sync_creatives',
  'activate_signal',
  'get_signals',
  'create_property_list',
  'update_property_list',
  'get_property_list',
  'list_property_lists',
  'delete_property_list',
  'sync_accounts',
  'get_account_financials',
  'get_creative_delivery',
  'sync_event_sources',
  'sync_audiences',
  'sync_catalogs',
  'log_event',
  'get_brand_identity',
  'get_rights',
  'acquire_rights',
]);
