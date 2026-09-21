import { randomUUID } from 'node:crypto';

import type { InputHandler, TaskOptions, TaskResult } from '../core/ConversationTypes';
import type {
  GetPrincipalRequest,
  GetPrincipalResponse,
  SyncPrincipalRequest,
  SyncPrincipalResponse,
} from '../types/tools.generated';
import type { MutatingRequestInput } from '../utils/idempotency';

type CurrentPrincipal = Extract<GetPrincipalResponse['result'], { kind: 'current' }>;
type AppliedPrincipal = Extract<SyncPrincipalResponse['result'], { kind: 'applied' }>;
type PrincipalConfiguration = SyncPrincipalRequest['configuration'];

export interface PrincipalLifecycleClient {
  getPrincipal(
    params?: GetPrincipalRequest,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<GetPrincipalResponse>>;
  syncPrincipal(
    params: MutatingRequestInput<SyncPrincipalRequest>,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<SyncPrincipalResponse>>;
}

export interface PrincipalLifecycleOptions {
  /** Maximum guarded replacement attempts after a concurrent configuration change. Defaults to 3. */
  maxAttempts?: number;
  /** Maximum wall-clock time spent waiting for destination setup. Defaults to 60 seconds. */
  setupTimeoutMs?: number;
  /** Delay between setup-state reads. Defaults to one second. */
  pollIntervalMs?: number;
  /** Caller cancellation for reads, replacement, and polling delays. */
  signal?: AbortSignal;
  /** Handler forwarded to each protocol task. */
  inputHandler?: InputHandler;
  /** Per-call task options. The lifecycle signal takes precedence. */
  taskOptions?: Omit<TaskOptions, 'signal'>;
  /** Test/host override. Called once per guarded replacement attempt. */
  createIdempotencyKey?: () => string;
}

export interface PrincipalLifecycleResult {
  applied: AppliedPrincipal;
  current: CurrentPrincipal;
  /** True only when every configured reusable destination reached ready. */
  destinationsReady: boolean;
  /** Seller-computed declaration intersection and exclusions, when supported. */
  declarations: CurrentPrincipal['configuration']['declarations'];
}

export class PrincipalLifecycleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PrincipalLifecycleError';
  }
}

export class PrincipalLifecycleTimeoutError extends PrincipalLifecycleError {
  constructor(message = 'Timed out waiting for principal destination setup.') {
    super(message);
    this.name = 'PrincipalLifecycleTimeoutError';
  }
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer.`);
  }
}

function assertAtMost(value: number, maximum: number, name: string): void {
  if (value > maximum) throw new RangeError(`${name} must be at most ${maximum}.`);
}

function completedData<T>(result: TaskResult<T>, operation: string): T {
  if (result.success && result.status === 'completed') return result.data;
  if (!result.success && result.status === 'failed' && 'data' in result && result.data !== undefined) {
    return result.data;
  }
  throw new PrincipalLifecycleError(`${operation} did not complete successfully.`);
}

function conflictResponse(response: SyncPrincipalResponse): boolean {
  return response.result.kind === 'failed' && response.result.errors.some(error => error.code === 'CONFLICT');
}

function taskOptions(options: PrincipalLifecycleOptions, remainingMs?: number): TaskOptions {
  const configuredTimeout = options.taskOptions?.timeout;
  const boundedConfiguredTimeout = configuredTimeout === 0 ? undefined : configuredTimeout;
  const timeout =
    remainingMs === undefined
      ? configuredTimeout
      : Math.max(1, Math.min(remainingMs, boundedConfiguredTimeout ?? remainingMs));
  return {
    ...options.taskOptions,
    ...(timeout === undefined ? {} : { timeout }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The principal lifecycle was aborted.', 'AbortError');
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal);
}

async function wait(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(abortReason(signal!));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function destinationOutcome(current: CurrentPrincipal): 'ready' | 'pending' | 'terminal' {
  const destinations = current.configuration.reporting_destinations ?? [];
  if (
    destinations.some(
      destination =>
        destination.state === 'action_required' || destination.state === 'inactive' || destination.state === 'rejected'
    )
  ) {
    return 'terminal';
  }
  return destinations.every(destination => destination.state === 'ready') ? 'ready' : 'pending';
}

async function readCurrent(
  client: PrincipalLifecycleClient,
  options: PrincipalLifecycleOptions,
  remainingMs?: number
): Promise<GetPrincipalResponse['result']> {
  const response = completedData(
    await client.getPrincipal({}, options.inputHandler, taskOptions(options, remainingMs)),
    'get_principal'
  );
  if (response.result.kind === 'failed') {
    throw new PrincipalLifecycleError('get_principal returned a failed result.');
  }
  return response.result;
}

/**
 * Read, guarded-replace, and observe one principal configuration lifecycle.
 *
 * Every replacement uses the latest seller configuration version. A structured
 * CONFLICT causes a bounded fresh read and a new logical operation. After an
 * applied response, reusable destinations are polled until all are ready or at
 * least one reaches a terminal action_required/rejected state.
 */
export async function syncPrincipalLifecycle(
  client: PrincipalLifecycleClient,
  configuration: PrincipalConfiguration,
  options: PrincipalLifecycleOptions = {}
): Promise<PrincipalLifecycleResult> {
  const maxAttempts = options.maxAttempts ?? 3;
  const setupTimeoutMs = options.setupTimeoutMs ?? 60_000;
  const pollIntervalMs = options.pollIntervalMs ?? 1_000;
  assertPositiveInteger(maxAttempts, 'maxAttempts');
  assertPositiveInteger(setupTimeoutMs, 'setupTimeoutMs');
  assertPositiveInteger(pollIntervalMs, 'pollIntervalMs');
  assertAtMost(maxAttempts, 10, 'maxAttempts');
  assertAtMost(setupTimeoutMs, 24 * 60 * 60 * 1_000, 'setupTimeoutMs');
  assertAtMost(pollIntervalMs, 2_147_483_647, 'pollIntervalMs');
  throwIfAborted(options.signal);

  const createIdempotencyKey = options.createIdempotencyKey ?? randomUUID;
  const desiredConfiguration = structuredClone(configuration);
  let prior = await readCurrent(client, options);
  let applied: AppliedPrincipal | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const request: MutatingRequestInput<SyncPrincipalRequest> = {
      idempotency_key: createIdempotencyKey(),
      configuration: desiredConfiguration,
      ...(prior.kind === 'current' ? { expected_configuration_version: prior.configuration_version } : {}),
      ...(prior.kind === 'current' || prior.kind === 'recognized'
        ? { expected_principal_kind: prior.principal_kind }
        : {}),
    };
    const response = completedData(
      await client.syncPrincipal(request, options.inputHandler, taskOptions(options)),
      'sync_principal'
    );
    if (response.result.kind === 'applied') {
      applied = response.result;
      break;
    }
    if (response.result.kind === 'validated') {
      throw new PrincipalLifecycleError('sync_principal unexpectedly returned a dry-run result.');
    }
    if (!conflictResponse(response) || attempt === maxAttempts) {
      throw new PrincipalLifecycleError(
        conflictResponse(response)
          ? `Principal configuration changed during all ${maxAttempts} guarded replacement attempts.`
          : 'sync_principal returned a failed result.'
      );
    }
    prior = await readCurrent(client, options);
  }

  if (!applied) throw new PrincipalLifecycleError('Principal configuration was not applied.');
  let current: CurrentPrincipal = {
    kind: 'current',
    principal_id: applied.principal_id,
    principal_kind: applied.principal_kind,
    configuration_version: applied.configuration_version,
    configuration: applied.configuration,
  };
  let outcome = destinationOutcome(current);
  if (outcome === 'pending') {
    const deadline = Date.now() + setupTimeoutMs;
    while (outcome === 'pending') {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new PrincipalLifecycleTimeoutError();
      const delay = Math.min(pollIntervalMs, remaining);
      await wait(delay, options.signal);
      if (delay === remaining) throw new PrincipalLifecycleTimeoutError();
      const remainingAfterWait = deadline - Date.now();
      if (remainingAfterWait <= 0) throw new PrincipalLifecycleTimeoutError();
      const readback = await readCurrent(client, options, remainingAfterWait);
      if (readback.kind !== 'current') {
        throw new PrincipalLifecycleError('Principal configuration disappeared while destination setup was pending.');
      }
      if (
        readback.principal_id !== applied.principal_id ||
        readback.principal_kind !== applied.principal_kind ||
        readback.configuration_version !== applied.configuration_version
      ) {
        throw new PrincipalLifecycleError('Principal configuration changed while destination setup was pending.');
      }
      current = readback;
      outcome = destinationOutcome(current);
    }
  }

  return {
    applied,
    current,
    destinationsReady: outcome === 'ready',
    declarations: current.configuration.declarations,
  };
}
