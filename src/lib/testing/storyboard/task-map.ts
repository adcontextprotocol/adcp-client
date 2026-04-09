/**
 * Maps AdCP task names (from storyboard YAML) to SingleAgentClient method names.
 *
 * Each storyboard step has a `task` field like "sync_accounts" or "get_products".
 * This map resolves those to the camelCase method on SingleAgentClient.
 *
 * Tasks without a dedicated method fall through to `executeTask()`.
 */

import type { TaskResult } from '../types';

/**
 * Map of AdCP task names to SingleAgentClient method names.
 * Only includes tasks that have dedicated typed methods.
 */
export const TASK_TO_METHOD: Record<string, string> = {
  // Account & audience
  sync_accounts: 'syncAccounts',
  list_accounts: 'listAccounts',
  sync_audiences: 'syncAudiences',

  // Product discovery & media buy
  get_products: 'getProducts',
  create_media_buy: 'createMediaBuy',
  update_media_buy: 'updateMediaBuy',
  get_media_buys: 'getMediaBuys',
  get_media_buy_delivery: 'getMediaBuyDelivery',
  provide_performance_feedback: 'providePerformanceFeedback',

  // Creative
  list_creative_formats: 'listCreativeFormats',
  build_creative: 'buildCreative',
  preview_creative: 'previewCreative',
  sync_creatives: 'syncCreatives',
  list_creatives: 'listCreatives',

  // Signals
  get_signals: 'getSignals',
  activate_signal: 'activateSignal',

  // Capabilities
  get_adcp_capabilities: 'getAdcpCapabilities',

  // Governance
  sync_plans: 'syncPlans',
  get_plan_audit_logs: 'getPlanAuditLogs',
  create_property_list: 'createPropertyList',
  get_property_list: 'getPropertyList',
  update_property_list: 'updatePropertyList',
  list_property_lists: 'listPropertyLists',
  delete_property_list: 'deletePropertyList',
  list_content_standards: 'listContentStandards',
  get_content_standards: 'getContentStandards',
  calibrate_content: 'calibrateContent',
  validate_content_delivery: 'validateContentDelivery',

  // Sponsored Intelligence
  si_get_offering: 'siGetOffering',
  si_initiate_session: 'siInitiateSession',
  si_send_message: 'siSendMessage',
  si_terminate_session: 'siTerminateSession',
};

/**
 * Execute a storyboard task against a SingleAgentClient.
 *
 * Uses the typed method if one exists, otherwise falls back to executeTask().
 * When the agent returns an async status (working/submitted), waits for
 * completion before returning — storyboard steps expect final results.
 */
export async function executeStoryboardTask(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic dispatch requires any
  client: any,
  taskName: string,
  params: Record<string, unknown>
): Promise<TaskResult> {
  const methodName = Object.hasOwn(TASK_TO_METHOD, taskName) ? TASK_TO_METHOD[taskName] : undefined;

  let result;
  if (methodName && typeof client[methodName] === 'function') {
    result = await client[methodName](params);
  } else {
    // Fall back to generic executeTask for tasks without dedicated methods
    // (e.g., sync_governance, future tasks)
    result = await client.executeTask(taskName, params);
  }

  // If the agent returned an async status but included data in the initial
  // response (common for agents that process synchronously but report as
  // submitted), use that data. Only poll when there's no data at all.
  const hasData = result.data !== undefined && result.data !== null;
  if (!hasData && result.status === 'submitted' && result.submitted?.waitForCompletion) {
    try {
      result = await result.submitted.waitForCompletion(2000);
    } catch {
      // Polling failed — return the intermediate result as-is
    }
  }

  return {
    success: result.success ?? true,
    data: result.data,
    error: result.error,
  };
}
