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
import { generateIdempotencyKey } from '../../utils/idempotency';
import { BUILD_ASSETS_FROM_FORMAT_DIRECTIVE, findUnresolvedCreativeAssetDirectives } from './creative-assets';
import type { MediaBuyLifecycleCoordinatorOptions } from '../../media-buy/compatibility';
import { ConfigurationError } from '../../errors';

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
  list_products: 'listProducts',
  request_proposals: 'requestProposals',
  refine_proposals: 'refineProposals',
  decline_proposals: 'declineProposals',
  buy_products: 'buyProducts',
  accept_proposal: 'acceptProposal',
  control_media_buy: 'controlMediaBuy',
  create_media_buy: 'createMediaBuy',
  update_media_buy: 'updateMediaBuy',
  get_media_buys: 'getMediaBuys',
  get_media_buy_delivery: 'getMediaBuyDelivery',
  provide_performance_feedback: 'providePerformanceFeedback',

  // Creative
  list_creative_formats: 'listCreativeFormats',
  build_creative: 'buildCreativeLegacy',
  preview_creative: 'previewCreativeLegacy',
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

/** Storyboards grade the selected protocol wire, not the SDK's canonical API. */
const LEGACY_CREATIVE_TASK_TO_METHOD: Readonly<Record<string, string>> = {
  get_products: 'getProductsLegacy',
  get_media_buys: 'getMediaBuysLegacy',
  create_media_buy: 'createMediaBuyLegacy',
  update_media_buy: 'updateMediaBuyLegacy',
  sync_creatives: 'syncCreativesLegacy',
  list_creatives: 'listCreativesLegacy',
};

const COMPATIBILITY_COORDINATOR_METHODS: Readonly<Record<string, string>> = {
  list_products: 'listProducts',
  request_proposals: 'requestProposals',
  refine_proposals: 'refineProposals',
  decline_proposals: 'declineProposals',
  buy_products: 'buyProducts',
  accept_proposal: 'acceptProposal',
  control_media_buy: 'controlMediaBuy',
  get_media_buys: 'getMediaBuys',
  get_media_buy_delivery: 'getMediaBuyDelivery',
};

interface CompatibilityCoordinatorCacheEntry {
  promise: Promise<any>;
  leases: number;
  disposing: boolean;
}

interface CompatibilityCoordinatorLease {
  coordinator: any;
  release(): void;
}

const compatibilityCoordinators = new WeakMap<object, Map<string, CompatibilityCoordinatorCacheEntry>>();
const MAX_COMPATIBILITY_COORDINATORS_PER_CLIENT = 32;

function disposeCompatibilityCoordinator(entry: CompatibilityCoordinatorCacheEntry): void {
  if (entry.disposing) return;
  entry.disposing = true;
  void entry.promise.then(coordinator => coordinator.dispose?.()).catch(() => undefined);
}

function evictLeastRecentlyUsedInactiveCoordinator(
  byOptions: Map<string, CompatibilityCoordinatorCacheEntry>
): boolean {
  const inactive = [...byOptions].find(([, entry]) => entry.leases === 0);
  if (!inactive) return false;
  const [key, entry] = inactive;
  byOptions.delete(key);
  disposeCompatibilityCoordinator(entry);
  return true;
}

async function compatibilityCoordinator(
  client: any,
  options: MediaBuyLifecycleCoordinatorOptions
): Promise<CompatibilityCoordinatorLease> {
  let byOptions = compatibilityCoordinators.get(client);
  if (!byOptions) {
    byOptions = new Map();
    compatibilityCoordinators.set(client, byOptions);
  }
  const key = JSON.stringify({
    preferredLifecycle: options.preferredLifecycle ?? 'auto',
    allowedLosses: [...(options.allowedLosses ?? [])].sort(),
    principalScope: options.principalScope,
  });
  let entry = byOptions.get(key);
  if (entry) {
    byOptions.delete(key);
    byOptions.set(key, entry);
  } else {
    if (
      byOptions.size >= MAX_COMPATIBILITY_COORDINATORS_PER_CLIENT &&
      !evictLeastRecentlyUsedInactiveCoordinator(byOptions)
    ) {
      throw new ConfigurationError(
        `Cannot create more than ${MAX_COMPATIBILITY_COORDINATORS_PER_CLIENT} concurrent media-buy lifecycle compatibility partitions for one client. Wait for an active storyboard task to finish before using another principalScope.`,
        'mediaBuyLifecycleCompatibility.principalScope'
      );
    }
    entry = {
      promise: Promise.resolve(client.negotiateMediaBuyLifecycle(options)),
      leases: 0,
      disposing: false,
    };
    byOptions.set(key, entry);
    void entry.promise.catch(() => {
      if (byOptions!.get(key) === entry) byOptions!.delete(key);
    });
  }
  entry.leases += 1;
  try {
    const coordinator = await entry.promise;
    let released = false;
    return {
      coordinator,
      release() {
        if (released) return;
        released = true;
        entry!.leases -= 1;
      },
    };
  } catch (error) {
    entry.leases -= 1;
    throw error;
  }
}

export interface StoryboardTaskExecutionOptions {
  skipIdempotencyAutoInject?: boolean;
  skipAccountValidation?: boolean;
  responseProjection?: 'raw';
  mediaBuyLifecycleCompatibility?: MediaBuyLifecycleCoordinatorOptions;
  signal?: AbortSignal;
}

/**
 * Schema-compliance steps grade seller evidence before SDK convenience
 * projection. Flow storyboards and fixture seeding intentionally keep the
 * canonical SDK projection because they consume normalized product shapes.
 */
export function defaultStoryboardResponseProjection(
  taskName: string,
  complyScenario: string | undefined
): 'raw' | undefined {
  return taskName === 'get_products' && complyScenario === 'schema_compliance' ? 'raw' : undefined;
}

function gradesLegacyCreativeWire(client: unknown): boolean {
  const version = readClientAdcpVersion(client);
  if (version === undefined) return false;
  const match = /^v?(\d+)(?:\.(\d+))?/.exec(version.trim());
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2] ?? 0);
  return major < 3 || (major === 3 && minor < 2);
}

function readClientAdcpVersion(client: unknown): string | undefined {
  if (client === null || typeof client !== 'object') return undefined;
  const getAdcpVersion = (client as { getAdcpVersion?: unknown }).getAdcpVersion;
  if (typeof getAdcpVersion !== 'function') return undefined;
  let version: unknown;
  try {
    version = getAdcpVersion.call(client);
  } catch {
    return undefined;
  }
  return typeof version === 'string' ? version : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readCreativeWireHint(params: Record<string, unknown>): 'legacy' | 'canonical' | undefined {
  if (!isRecord(params.ext) || !isRecord(params.ext.adcp)) return undefined;
  const wire = params.ext.adcp.creative_wire;
  return wire === 'legacy' || wire === 'canonical' ? wire : undefined;
}

function withLegacyCreativeWireHint(params: Record<string, unknown>): Record<string, unknown> {
  if (readCreativeWireHint(params)) return params;
  const ext = isRecord(params.ext) ? params.ext : {};
  const adcp = isRecord(ext.adcp) ? ext.adcp : {};
  return {
    ...params,
    ext: {
      ...ext,
      adcp: { ...adcp, creative_wire: 'legacy' },
    },
  };
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
  adcpError?: AdcpErrorInfo,
  responseAdcpVersion?: string
): boolean {
  if (!isRecord(result)) return true;
  if (typeof result.success === 'boolean') return result.success;
  if (result.status === 'failed') return false;
  if (result.status === 'rejected' && isTerminalAdcpError(result, taskName, responseAdcpVersion)) return false;
  if (adcpError || result.adcpError || result.adcp_error) return false;
  if (terminalDataError ?? isTerminalAdcpError(result.data, taskName, responseAdcpVersion)) return false;
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
  opts: StoryboardTaskExecutionOptions = {}
): Promise<TaskResult> {
  const unresolvedAssetDirectives = findUnresolvedCreativeAssetDirectives(params);
  if (unresolvedAssetDirectives.length > 0) {
    return {
      success: false,
      error:
        `Request contains unexpanded storyboard directive '${BUILD_ASSETS_FROM_FORMAT_DIRECTIVE}' at ` +
        `${unresolvedAssetDirectives.join(', ')}. ` +
        'Call expandCreativeAssetDirectives(params, context, testKit) before passing params to executeStoryboardTask.',
    };
  }

  // AdCP 3.1 transition storyboards default to the legacy creative wire, but
  // canonical-specific storyboards can opt into the canonical wire. Product
  // discovery still uses getProductsLegacy in either case because that method
  // preserves the seller response; wire selection and response projection are
  // independent concerns.
  const forceRawProjection = opts.responseProjection === 'raw';
  const mediaBuyPackages = [params.packages, params.new_packages].flatMap(value => (Array.isArray(value) ? value : []));
  const preserveExplicitLegacySelectorRoutes =
    (taskName === 'create_media_buy' || taskName === 'update_media_buy') &&
    mediaBuyPackages.some(
      pkg => pkg != null && typeof pkg === 'object' && Object.hasOwn(pkg as Record<string, unknown>, 'format_ids')
    );
  const useLegacyCreativeMethod =
    forceRawProjection ||
    preserveExplicitLegacySelectorRoutes ||
    (gradesLegacyCreativeWire(client) && readCreativeWireHint(params) !== 'canonical');
  const legacyMethodName = useLegacyCreativeMethod ? LEGACY_CREATIVE_TASK_TO_METHOD[taskName] : undefined;
  const methodName =
    legacyMethodName ?? (Object.hasOwn(TASK_TO_METHOD, taskName) ? TASK_TO_METHOD[taskName] : undefined);
  // Product discovery must remain ambiguous during the 3.1 transition so a
  // seller can dual-emit format_ids + format_options. The legacy method keeps
  // the raw response shape; it must not force the seller onto a legacy-only
  // response. Other creative lifecycle methods retain explicit legacy routing.
  const callParams =
    legacyMethodName && taskName !== 'get_products' && !forceRawProjection && !preserveExplicitLegacySelectorRoutes
      ? withLegacyCreativeWireHint(params)
      : params;
  const compatibilityMethod = opts.mediaBuyLifecycleCompatibility
    ? COMPATIBILITY_COORDINATOR_METHODS[taskName]
    : undefined;
  const compatibilityMutation = new Set([
    'request_proposals',
    'refine_proposals',
    'decline_proposals',
    'buy_products',
    'accept_proposal',
    'control_media_buy',
  ]).has(taskName);
  const stableCallParams =
    compatibilityMethod &&
    compatibilityMutation &&
    !opts.skipIdempotencyAutoInject &&
    typeof callParams.idempotency_key !== 'string'
      ? { ...callParams, idempotency_key: generateIdempotencyKey() }
      : callParams;

  // Only pass TaskOptions when a flag is actually set — avoids changing
  // behavior for the common path that relies on method defaults.
  const taskOptions =
    opts.skipIdempotencyAutoInject || opts.skipAccountValidation || opts.signal
      ? {
          ...(opts.skipIdempotencyAutoInject && { skipIdempotencyAutoInject: true }),
          ...(opts.skipAccountValidation && { skipAccountValidation: true }),
          ...(opts.signal && { signal: opts.signal }),
        }
      : undefined;

  let result;
  let compatibilityLease: CompatibilityCoordinatorLease | undefined;
  let compatibilityAcquisition: Promise<CompatibilityCoordinatorLease> | undefined;
  let compatibilityOperation: Promise<unknown> | undefined;
  const invoke = async () => {
    if (compatibilityMethod) {
      if (!compatibilityLease) {
        const acquisition =
          compatibilityAcquisition ?? compatibilityCoordinator(client, opts.mediaBuyLifecycleCompatibility!);
        compatibilityAcquisition = acquisition;
        try {
          compatibilityLease = await acquisition;
        } catch (error) {
          if (compatibilityAcquisition === acquisition) compatibilityAcquisition = undefined;
          throw error;
        }
      }
      if (typeof compatibilityLease.coordinator[compatibilityMethod] !== 'function') {
        throw new Error(`Media-buy compatibility coordinator does not implement ${compatibilityMethod}`);
      }
      if (opts.signal?.aborted) throw opts.signal.reason ?? new Error('aborted');
      // Invoke synchronously after the abort check. No event-loop turn can
      // interleave cancellation (and lease release/eviction) between the check
      // and dispatch; the lease remains held until the returned operation
      // settles.
      compatibilityOperation = Promise.resolve(
        taskOptions
          ? compatibilityLease.coordinator[compatibilityMethod](stableCallParams, undefined, taskOptions)
          : compatibilityLease.coordinator[compatibilityMethod](stableCallParams)
      );
      return compatibilityOperation;
    }
    if (methodName && typeof client[methodName] === 'function') {
      // Typed methods take (params, inputHandler?, options?). Pass options
      // only when set, otherwise they take their defaults.
      return taskOptions ? client[methodName](callParams, undefined, taskOptions) : client[methodName](callParams);
    }
    return client.executeTask(taskName, callParams, undefined, taskOptions);
  };

  // Retry with exponential backoff on rate limit errors
  const MAX_RETRIES = 3;
  const BASE_DELAY_MS = 2000;
  try {
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
        // Bound the underlying poll itself, not only the caller-facing race.
        // Otherwise an always-working seller can retain a compatibility lease
        // (and keep polling) forever after this storyboard step times out.
        const pollingTimeoutSignal = AbortSignal.timeout(30_000);
        const pollingSignal = opts.signal ? AbortSignal.any([opts.signal, pollingTimeoutSignal]) : pollingTimeoutSignal;
        const pollingOperation = result.submitted.waitForCompletion(2000, pollingSignal);
        // A compatibility coordinator owns the continuation wrappers and
        // mutation fences installed on its initial result. Keep its cache
        // lease until the underlying poll actually settles, even when the
        // storyboard's abort/timeout race returns first.
        if (compatibilityLease) compatibilityOperation = pollingOperation;
        result = await raceWithSignal(pollingOperation, opts.signal);
        replacedByPolling = true;
      } catch (err) {
        if (opts.signal?.aborted) throw err;
        // Polling failed or timed out — return the intermediate result as-is
      }
    }

    const responseAdcpVersion = readClientAdcpVersion(client);
    const terminalDataError = isTerminalAdcpError(result.data, taskName, responseAdcpVersion);
    const adcpError =
      result.adcpError ??
      result.adcp_error ??
      readAdcpError(result.data) ??
      (terminalDataError ? readFirstError(result.data) : undefined);
    const isRawStructuredRejection =
      result.data == null &&
      result.status === 'rejected' &&
      !isTerminalAdcpError(result, taskName, responseAdcpVersion);
    const data = result.data ?? (isRawStructuredRejection ? result : adcpError ? { adcp_error: adcpError } : undefined);
    const success = normalizeStoryboardTaskSuccess(result, taskName, terminalDataError, adcpError, responseAdcpVersion);
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
  } finally {
    const release = () => compatibilityLease?.release();
    if (compatibilityOperation) {
      void compatibilityOperation.then(release, release);
    } else if (compatibilityLease) {
      release();
    } else if (compatibilityAcquisition) {
      void compatibilityAcquisition.then(
        lease => lease.release(),
        () => undefined
      );
    }
  }
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
