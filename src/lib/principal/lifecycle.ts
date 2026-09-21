import { randomUUID } from 'node:crypto';

import type { InputHandler, TaskOptions, TaskResult } from '../core/ConversationTypes';
import { TaskTimeoutError } from '../errors';
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
type PrincipalKind = CurrentPrincipal['principal_kind'];

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
  /** Maximum total guarded replacement attempts, including the first write. Defaults to 3; maximum 10. */
  maxAttempts?: number;
  /** Maximum wall-clock time spent waiting for destination setup. Defaults to 60 seconds; maximum 24 hours. */
  setupTimeoutMs?: number;
  /** Delay between setup-state reads. Defaults to one second; maximum 2^31-1 milliseconds. */
  pollIntervalMs?: number;
  /** Optional caller assertion for the authenticated principal kind. */
  expectedPrincipalKind?: PrincipalKind;
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
  /** Original task result, including a resumable submitted/deferred continuation when one exists. */
  readonly taskResult?: TaskResult<unknown>;
  /** Structured tool-level issues returned by the seller. */
  readonly protocolErrors?: readonly unknown[];

  constructor(
    message: string,
    options: { cause?: unknown; taskResult?: TaskResult<unknown>; protocolErrors?: readonly unknown[] } = {}
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'PrincipalLifecycleError';
    this.taskResult = options.taskResult;
    this.protocolErrors = options.protocolErrors;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isFailedSyncPrincipalResponse(value: unknown): value is SyncPrincipalResponse {
  if (!isRecord(value) || !isRecord(value.result) || value.result.kind !== 'failed') return false;
  return (
    Array.isArray(value.result.errors) &&
    value.result.errors.length > 0 &&
    value.result.errors.every(error => isRecord(error) && typeof error.code === 'string')
  );
}

function completedData<T>(
  result: TaskResult<T>,
  operation: string,
  acceptFailedData?: (value: unknown) => value is T
): T {
  if (result.success && result.status === 'completed') return result.data;
  if (!result.success && result.status === 'failed' && acceptFailedData?.(result.data)) {
    return result.data;
  }
  throw new PrincipalLifecycleError(`${operation} did not complete successfully (status: ${result.status}).`, {
    cause: result.success ? undefined : (result.errorInstance ?? new Error(result.error)),
    taskResult: result,
  });
}

function conflictResponse(response: SyncPrincipalResponse): boolean {
  return response.result.kind === 'failed' && response.result.errors.some(error => error.code === 'CONFLICT');
}

function assertSamePrincipal(
  previous: GetPrincipalResponse['result'],
  refreshed: GetPrincipalResponse['result']
): void {
  if (previous.kind === 'unconfigured') {
    throw new PrincipalLifecycleError(
      'Cannot retry a principal conflict because the initial read did not expose an identity continuity fence.'
    );
  }
  if (previous.kind !== 'current' && previous.kind !== 'recognized') {
    throw new PrincipalLifecycleError('Cannot retry a failed principal read.');
  }
  if (
    (refreshed.kind !== 'current' && refreshed.kind !== 'recognized') ||
    refreshed.principal_id !== previous.principal_id ||
    refreshed.principal_kind !== previous.principal_kind
  ) {
    throw new PrincipalLifecycleError('Authenticated principal changed during guarded replacement.');
  }
}

function assertAppliedToSamePrincipal(previous: GetPrincipalResponse['result'], applied: AppliedPrincipal): void {
  if (
    (previous.kind === 'current' || previous.kind === 'recognized') &&
    (applied.principal_id !== previous.principal_id || applied.principal_kind !== previous.principal_kind)
  ) {
    throw new PrincipalLifecycleError('Authenticated principal changed during guarded replacement.');
  }
}

function assertExpectedPrincipalKind(
  principal: GetPrincipalResponse['result'] | AppliedPrincipal,
  expectedPrincipalKind?: PrincipalKind
): void {
  if (
    expectedPrincipalKind !== undefined &&
    'principal_kind' in principal &&
    principal.principal_kind !== expectedPrincipalKind
  ) {
    throw new PrincipalLifecycleError(
      `Authenticated principal kind did not match the caller's ${expectedPrincipalKind} assertion.`
    );
  }
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

function destinationOutcome(
  current: CurrentPrincipal,
  expectedActiveDestinationIds?: ReadonlySet<string>
): 'ready' | 'pending' | 'terminal' {
  const destinations = current.configuration.reporting_destinations ?? [];
  if (
    expectedActiveDestinationIds &&
    [...expectedActiveDestinationIds].some(
      destinationId => !destinations.some(destination => destination.destination_id === destinationId)
    )
  ) {
    return 'pending';
  }
  const relevantDestinations = destinations.filter(
    destination =>
      destination.configuration.active || expectedActiveDestinationIds?.has(destination.destination_id) === true
  );
  if (
    relevantDestinations.some(
      destination =>
        destination.state === 'action_required' || destination.state === 'inactive' || destination.state === 'rejected'
    )
  ) {
    return 'terminal';
  }
  return relevantDestinations.every(destination => destination.state === 'ready') ? 'ready' : 'pending';
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
    throw new PrincipalLifecycleError('get_principal returned a failed result.', {
      protocolErrors: response.result.errors,
    });
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
  const expectedActiveDestinationIds =
    desiredConfiguration.reporting_destinations === undefined
      ? undefined
      : new Set(
          desiredConfiguration.reporting_destinations
            .filter(destination => destination.active)
            .map(destination => destination.destination_id)
        );
  let prior = await readCurrent(client, options);
  assertExpectedPrincipalKind(prior, options.expectedPrincipalKind);
  let applied: AppliedPrincipal | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const request: MutatingRequestInput<SyncPrincipalRequest> = {
      idempotency_key: createIdempotencyKey(),
      configuration: desiredConfiguration,
      ...(prior.kind === 'current' ? { expected_configuration_version: prior.configuration_version } : {}),
      ...(options.expectedPrincipalKind !== undefined
        ? { expected_principal_kind: options.expectedPrincipalKind }
        : prior.kind === 'current' || prior.kind === 'recognized'
          ? { expected_principal_kind: prior.principal_kind }
          : {}),
    };
    const taskResult = await client.syncPrincipal(request, options.inputHandler, taskOptions(options));
    const response = completedData(taskResult, 'sync_principal', isFailedSyncPrincipalResponse);
    if (response.result.kind === 'applied') {
      assertAppliedToSamePrincipal(prior, response.result);
      assertExpectedPrincipalKind(response.result, options.expectedPrincipalKind);
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
          : 'sync_principal returned a failed result.',
        { taskResult, protocolErrors: response.result.errors }
      );
    }
    const refreshed = await readCurrent(client, options);
    assertSamePrincipal(prior, refreshed);
    assertExpectedPrincipalKind(refreshed, options.expectedPrincipalKind);
    prior = refreshed;
  }

  if (!applied) throw new PrincipalLifecycleError('Principal configuration was not applied.');
  let current: CurrentPrincipal = {
    kind: 'current',
    principal_id: applied.principal_id,
    principal_kind: applied.principal_kind,
    configuration_version: applied.configuration_version,
    configuration: applied.configuration,
  };
  let outcome = destinationOutcome(current, expectedActiveDestinationIds);
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
      const configuredTaskTimeout = options.taskOptions?.timeout;
      const lifecycleBoundsRead =
        configuredTaskTimeout === undefined ||
        configuredTaskTimeout === 0 ||
        configuredTaskTimeout >= remainingAfterWait;
      let readback: GetPrincipalResponse['result'];
      try {
        readback = await readCurrent(client, options, remainingAfterWait);
      } catch (error) {
        if (error instanceof TaskTimeoutError && lifecycleBoundsRead) {
          throw new PrincipalLifecycleTimeoutError();
        }
        throw error;
      }
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
      outcome = destinationOutcome(current, expectedActiveDestinationIds);
    }
  }

  return {
    applied,
    current,
    destinationsReady: outcome === 'ready',
    declarations: current.configuration.declarations,
  };
}
