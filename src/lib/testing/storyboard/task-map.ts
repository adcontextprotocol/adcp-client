/**
 * Maps AdCP task names (from storyboard YAML) to SingleAgentClient method names.
 *
 * Each storyboard step has a `task` field like "sync_accounts" or "get_products".
 * This map resolves those to the camelCase method on SingleAgentClient.
 *
 * Tasks without a dedicated method fall through to `executeTask()`.
 */

import type { TaskResult } from '../types';
import type { AdcpErrorInfo } from '../../core/ConversationTypes';
import { isTerminalAdcpError, readExtractionPath } from '../../utils/response-unwrapper';

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
  check_governance: 'checkGovernance',
  get_plan_audit_logs: 'getPlanAuditLogs',
  create_property_list: 'createPropertyList',
  get_property_list: 'getPropertyList',
  update_property_list: 'updatePropertyList',
  list_property_lists: 'listPropertyLists',
  delete_property_list: 'deletePropertyList',
  list_collection_lists: 'listCollectionLists',
  list_content_standards: 'listContentStandards',
  get_content_standards: 'getContentStandards',
  create_content_standards: 'createContentStandards',
  update_content_standards: 'updateContentStandards',
  calibrate_content: 'calibrateContent',
  validate_content_delivery: 'validateContentDelivery',

  // Account
  get_account_financials: 'getAccountFinancials',
  log_event: 'logEvent',

  // Sponsored Intelligence
  si_get_offering: 'siGetOffering',
  si_initiate_session: 'siInitiateSession',
  si_send_message: 'siSendMessage',
  si_terminate_session: 'siTerminateSession',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readAdcpError(value: unknown): AdcpErrorInfo | undefined {
  if (!isRecord(value)) return undefined;
  const error = value.adcp_error;
  if (!isRecord(error) || typeof error.code !== 'string') return undefined;
  return error as unknown as AdcpErrorInfo;
}

function readFirstError(value: unknown): AdcpErrorInfo | undefined {
  if (!isRecord(value) || !Array.isArray(value.errors)) return undefined;
  const first = value.errors[0];
  if (!isRecord(first) || typeof first.code !== 'string') return undefined;
  return {
    code: first.code,
    message: typeof first.message === 'string' ? first.message : String(first.code),
    ...(typeof first.recovery === 'string' && { recovery: first.recovery as AdcpErrorInfo['recovery'] }),
    ...(typeof first.field === 'string' && { field: first.field }),
    ...(typeof first.suggestion === 'string' && { suggestion: first.suggestion }),
    ...(typeof first.retry_after === 'number' && { retry_after: first.retry_after }),
    ...(isRecord(first.details) && { details: first.details }),
  };
}

function errorMessageFrom(error: AdcpErrorInfo | undefined, fallback: unknown): string | undefined {
  if (typeof error?.message === 'string' && error.message.length > 0) return error.message;
  if (typeof error?.code === 'string') return error.code;
  return typeof fallback === 'string' && fallback.length > 0 ? fallback : undefined;
}

function normalizeStoryboardTaskSuccess(
  result: unknown,
  taskName: string,
  terminalDataError?: boolean,
  adcpError?: AdcpErrorInfo
): boolean {
  if (!isRecord(result)) return true;
  if (typeof result.success === 'boolean') return result.success;
  if (result.status === 'failed' || result.status === 'rejected') return false;
  if (adcpError || result.adcpError || result.adcp_error) return false;
  if (terminalDataError ?? isTerminalAdcpError(result.data, taskName)) return false;
  return true;
}

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
  params: Record<string, unknown>,
  opts: { skipIdempotencyAutoInject?: boolean; skipAccountValidation?: boolean; signal?: AbortSignal } = {}
): Promise<TaskResult> {
  const methodName = Object.hasOwn(TASK_TO_METHOD, taskName) ? TASK_TO_METHOD[taskName] : undefined;

  // Only pass TaskOptions when a flag is actually set — avoids changing
  // behavior for the common path that relies on method defaults.
  const taskOptions =
    opts.skipIdempotencyAutoInject || opts.skipAccountValidation
      ? {
          ...(opts.skipIdempotencyAutoInject && { skipIdempotencyAutoInject: true }),
          ...(opts.skipAccountValidation && { skipAccountValidation: true }),
        }
      : undefined;

  let result;
  const invoke = async () => {
    if (methodName && typeof client[methodName] === 'function') {
      // Typed methods take (params, inputHandler?, options?). Pass options
      // only when set, otherwise they take their defaults.
      return taskOptions ? client[methodName](params, undefined, taskOptions) : client[methodName](params);
    }
    return client.executeTask(taskName, params, undefined, taskOptions);
  };

  // Retry with exponential backoff on rate limit errors
  const MAX_RETRIES = 3;
  const BASE_DELAY_MS = 2000;
  for (let attempt = 0; ; attempt++) {
    try {
      result = await raceWithSignal(invoke(), opts.signal);
      break;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isRateLimit =
        /rate limit/i.test(msg) || (/"code":\s*-32000/.test(msg) && /rate.?limit|too many|throttl/i.test(msg));
      if (isRateLimit && attempt < MAX_RETRIES) {
        const jitter = Math.random() * 1000;
        const delay = BASE_DELAY_MS * 2 ** attempt + jitter;
        await raceWithSignal(new Promise(resolve => setTimeout(resolve, delay)), opts.signal);
        continue;
      }
      throw err;
    }
  }

  // If the agent returned an async status but included data in the initial
  // response (common for agents that process synchronously but report as
  // submitted), use that data. Only poll when there's no data at all.
  const hasData = result.data !== undefined && result.data !== null;
  const isAsync = result.status === 'submitted' || result.status === 'working';
  const prePollingDebugLogs = Array.isArray(result.debug_logs) ? [...result.debug_logs] : [];
  let replacedByPolling = false;
  if (!hasData && isAsync && result.submitted?.waitForCompletion) {
    try {
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Task polling timeout')), 30_000)
      );
      result = await raceWithSignal(
        Promise.race([result.submitted.waitForCompletion(2000, opts.signal), timeout]),
        opts.signal
      );
      replacedByPolling = true;
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      // Polling failed or timed out — return the intermediate result as-is
    }
  }

  const terminalDataError = isTerminalAdcpError(result.data, taskName);
  const adcpError =
    result.adcpError ??
    result.adcp_error ??
    readAdcpError(result.data) ??
    (terminalDataError ? readFirstError(result.data) : undefined);
  const data = result.data ?? (adcpError ? { adcp_error: adcpError } : undefined);
  const success = normalizeStoryboardTaskSuccess(result, taskName, terminalDataError, adcpError);
  const error = result.error ?? (!success ? errorMessageFrom(adcpError, undefined) : undefined);
  const extractionPath = readExtractionPath(data);
  const debugLogs = Array.isArray(result.debug_logs) ? result.debug_logs : [];
  const mergedDebugLogs = replacedByPolling ? [...prePollingDebugLogs, ...debugLogs] : debugLogs;
  return {
    success,
    data,
    error,
    ...(adcpError && { adcp_error: adcpError }),
    ...(extractionPath !== undefined && { _extraction_path: extractionPath }),
    ...(mergedDebugLogs.length > 0 && { debug_logs: mergedDebugLogs }),
  };
}

function raceWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('aborted'));

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error('aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      value => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      err => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      }
    );
  });
}
