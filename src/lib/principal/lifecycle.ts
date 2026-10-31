import { randomUUID } from 'node:crypto';

import type { InputHandler, TaskOptions, TaskResult } from '../core/ConversationTypes';
import { ADCPError, TaskTimeoutError, isPreDispatchError, type AdcpErrorRecovery } from '../errors';
import type {
  GetPrincipalRequest,
  GetPrincipalResponse,
  SyncPrincipalRequest,
  SyncPrincipalResponse,
} from '../types/tools.generated';
import { isValidIdempotencyKey, type MutatingRequestInput } from '../utils/idempotency';

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
    options?: TaskOptions & { allowDeactivation?: boolean; allowRevocation?: boolean }
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
  /** True only when every active destination submitted by this lifecycle call reached ready. */
  destinationsReady: boolean;
  /** Seller-computed declaration intersection and exclusions, when supported. */
  declarations: CurrentPrincipal['configuration']['declarations'];
}

/**
 * Codes a {@link PrincipalLifecycleError} carries.
 *
 * - `PRINCIPAL_TASK_INCOMPLETE`: a `get_principal` or `sync_principal` task did not complete (it
 *   failed, or is submitted or deferred; see `taskResult`).
 * - `PRINCIPAL_READ_FAILED`: `get_principal` returned a failed result (see `protocolErrors`).
 * - `PRINCIPAL_WRITE_FAILED`: `sync_principal` returned a failed result other than `CONFLICT`.
 * - `PRINCIPAL_CONFLICT_EXHAUSTED`: every guarded replacement attempt met `CONFLICT`.
 * - `PRINCIPAL_TRANSPORT_FAILED`: the `sync_principal` call threw; replay `attemptedRequest` exactly.
 * - `PRINCIPAL_IDENTITY_CHANGED`: the authenticated principal changed, its kind did not match
 *   `expectedPrincipalKind`, or its continuity could not be verified for a retry.
 * - `PRINCIPAL_INVALID_RESPONSE`: the seller answered a write with a dry-run result, or applied nothing.
 * - `PRINCIPAL_INVALID_OPTIONS`: a lifecycle option misbehaved (`createIdempotencyKey` reused a key).
 * - `PRINCIPAL_SETUP_TIMEOUT`: destination setup did not finish in time ({@link PrincipalLifecycleTimeoutError}).
 * - `PRINCIPAL_SETUP_INTERRUPTED`: the configuration disappeared or changed while setup was pending.
 * - `PRINCIPAL_LIFECYCLE_FAILED`: the default for an error constructed without a code.
 */
export type PrincipalLifecycleErrorCode =
  | 'PRINCIPAL_TASK_INCOMPLETE'
  | 'PRINCIPAL_READ_FAILED'
  | 'PRINCIPAL_WRITE_FAILED'
  | 'PRINCIPAL_CONFLICT_EXHAUSTED'
  | 'PRINCIPAL_TRANSPORT_FAILED'
  | 'PRINCIPAL_IDENTITY_CHANGED'
  | 'PRINCIPAL_INVALID_RESPONSE'
  | 'PRINCIPAL_INVALID_OPTIONS'
  | 'PRINCIPAL_SETUP_TIMEOUT'
  | 'PRINCIPAL_SETUP_INTERRUPTED'
  | 'PRINCIPAL_LIFECYCLE_FAILED';

const PRINCIPAL_LIFECYCLE_RECOVERY: Readonly<Record<PrincipalLifecycleErrorCode, AdcpErrorRecovery>> = {
  PRINCIPAL_TASK_INCOMPLETE: 'transient',
  PRINCIPAL_READ_FAILED: 'terminal',
  PRINCIPAL_WRITE_FAILED: 'terminal',
  PRINCIPAL_CONFLICT_EXHAUSTED: 'transient',
  PRINCIPAL_TRANSPORT_FAILED: 'transient',
  PRINCIPAL_IDENTITY_CHANGED: 'terminal',
  PRINCIPAL_INVALID_RESPONSE: 'terminal',
  PRINCIPAL_INVALID_OPTIONS: 'correctable',
  PRINCIPAL_SETUP_TIMEOUT: 'transient',
  PRINCIPAL_SETUP_INTERRUPTED: 'transient',
  PRINCIPAL_LIFECYCLE_FAILED: 'terminal',
};

/** Options for {@link PrincipalLifecycleError}. */
export interface PrincipalLifecycleErrorOptions {
  /** Defaults to `PRINCIPAL_LIFECYCLE_FAILED`. */
  code?: PrincipalLifecycleErrorCode;
  /** Defaults to the seller's first protocol error `recovery`, else the code's. */
  recovery?: AdcpErrorRecovery;
  /**
   * Pass `false` only when no bytes of the `sync_principal` write left the process. See
   * {@link isPreDispatchError}.
   */
  dispatched?: false;
  cause?: unknown;
  taskResult?: TaskResult<unknown>;
  protocolErrors?: readonly unknown[];
  appliedResponse?: AppliedPrincipal;
  /** @deprecated Use `appliedResponse`. */
  applied?: AppliedPrincipal;
  current?: CurrentPrincipal;
  attemptedRequest?: MutatingRequestInput<SyncPrincipalRequest>;
}

const RECOVERIES: ReadonlySet<string> = new Set(['transient', 'correctable', 'terminal']);

function protocolRecovery(protocolErrors: readonly unknown[] | undefined): AdcpErrorRecovery | undefined {
  const first = protocolErrors?.[0];
  const recovery = isRecord(first) ? first.recovery : undefined;
  return typeof recovery === 'string' && RECOVERIES.has(recovery) ? (recovery as AdcpErrorRecovery) : undefined;
}

export class PrincipalLifecycleError extends ADCPError {
  readonly code: PrincipalLifecycleErrorCode;
  readonly recovery: AdcpErrorRecovery;
  /** `false` when the lifecycle refused before sending any `sync_principal` write; absent otherwise. */
  declare readonly dispatched?: false;
  /** Original task result, including a resumable submitted/deferred continuation when one exists. */
  declare readonly taskResult?: TaskResult<unknown>;
  /** Structured tool-level issues returned by the seller. */
  readonly protocolErrors?: readonly unknown[];
  /** The applied `sync_principal` result, when the write was applied and a later observation step failed. */
  readonly appliedResponse?: AppliedPrincipal;
  /** Last coherent readback observed after the mutation, when available. */
  readonly current?: CurrentPrincipal;
  /** Exact helper-built write body for byte-equivalent lost-response replay. Kept non-enumerable because it may contain secrets. */
  declare readonly attemptedRequest?: MutatingRequestInput<SyncPrincipalRequest>;

  constructor(message: string, options: PrincipalLifecycleErrorOptions = {}) {
    super(message);
    this.name = 'PrincipalLifecycleError';
    this.code = options.code ?? 'PRINCIPAL_LIFECYCLE_FAILED';
    this.recovery =
      options.recovery ?? protocolRecovery(options.protocolErrors) ?? PRINCIPAL_LIFECYCLE_RECOVERY[this.code];
    if (options.dispatched === false) Object.defineProperty(this, 'dispatched', { value: false, enumerable: true });
    if (options.cause !== undefined) Object.defineProperty(this, 'cause', { value: options.cause, configurable: true });
    Object.defineProperty(this, 'taskResult', {
      value: options.taskResult,
      enumerable: false,
      writable: false,
      configurable: false,
    });
    this.protocolErrors = options.protocolErrors;
    this.appliedResponse = options.appliedResponse ?? options.applied;
    this.current = options.current;
    Object.defineProperty(this, 'attemptedRequest', {
      value: options.attemptedRequest,
      enumerable: false,
      writable: false,
      configurable: false,
    });
  }

  /**
   * The applied `sync_principal` result.
   *
   * @deprecated Use {@link PrincipalLifecycleError.appliedResponse}. Renamed so it is not read as a
   * boolean next to `dispatched`; this alias will be removed in a later release.
   */
  get applied(): AppliedPrincipal | undefined {
    return this.appliedResponse;
  }
}

export class PrincipalLifecycleTimeoutError extends PrincipalLifecycleError {
  constructor(
    message = 'Timed out waiting for principal destination setup.',
    options: Pick<PrincipalLifecycleErrorOptions, 'appliedResponse' | 'applied' | 'current'> = {}
  ) {
    super(message, { ...options, code: 'PRINCIPAL_SETUP_TIMEOUT' });
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

function isFailedGetPrincipalResponse(value: unknown): value is GetPrincipalResponse {
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
  written: boolean,
  acceptFailedData?: (value: unknown) => value is T,
  attemptedRequest?: MutatingRequestInput<SyncPrincipalRequest>
): T {
  if (result.success && result.status === 'completed') return result.data;
  if (!result.success && result.status === 'failed' && acceptFailedData?.(result.data)) {
    return result.data;
  }
  const cause = result.success ? undefined : (result.errorInstance ?? new Error(result.error));
  // A local refusal of this task is pre-dispatch for the lifecycle only while no earlier write was sent.
  const refusedLocally = !written && isPreDispatchError(cause);
  throw new PrincipalLifecycleError(`${operation} did not complete successfully (status: ${result.status}).`, {
    code: 'PRINCIPAL_TASK_INCOMPLETE',
    ...(refusedLocally ? { dispatched: false as const, recovery: 'correctable' as const } : {}),
    cause,
    taskResult: result,
    attemptedRequest,
  });
}

function conflictResponse(response: SyncPrincipalResponse): boolean {
  return response.result.kind === 'failed' && response.result.errors.some(error => error.code === 'CONFLICT');
}

const IDENTITY_CHANGED = { code: 'PRINCIPAL_IDENTITY_CHANGED' } as const;

function assertSamePrincipal(
  previous: GetPrincipalResponse['result'],
  refreshed: GetPrincipalResponse['result']
): void {
  if (previous.kind === 'unconfigured') {
    throw new PrincipalLifecycleError(
      'Cannot retry a principal conflict because the initial read did not expose an identity continuity fence.',
      IDENTITY_CHANGED
    );
  }
  if (previous.kind !== 'current' && previous.kind !== 'recognized') {
    throw new PrincipalLifecycleError('Cannot retry a failed principal read.', IDENTITY_CHANGED);
  }
  if (
    (refreshed.kind !== 'current' && refreshed.kind !== 'recognized') ||
    refreshed.principal_id !== previous.principal_id ||
    refreshed.principal_kind !== previous.principal_kind
  ) {
    throw new PrincipalLifecycleError('Authenticated principal changed during guarded replacement.', IDENTITY_CHANGED);
  }
}

function assertAppliedToSamePrincipal(previous: GetPrincipalResponse['result'], applied: AppliedPrincipal): void {
  if (
    (previous.kind === 'current' || previous.kind === 'recognized') &&
    (applied.principal_id !== previous.principal_id || applied.principal_kind !== previous.principal_kind)
  ) {
    throw new PrincipalLifecycleError('Authenticated principal changed during guarded replacement.', {
      ...IDENTITY_CHANGED,
      appliedResponse: applied,
    });
  }
}

function assertExpectedPrincipalKind(
  principal: GetPrincipalResponse['result'] | AppliedPrincipal,
  expectedPrincipalKind: PrincipalKind | undefined,
  written: boolean
): void {
  if (
    expectedPrincipalKind !== undefined &&
    'principal_kind' in principal &&
    principal.principal_kind !== expectedPrincipalKind
  ) {
    throw new PrincipalLifecycleError(
      `Authenticated principal kind did not match the caller's ${expectedPrincipalKind} assertion.`,
      { ...IDENTITY_CHANGED, ...(written ? {} : { dispatched: false as const }) }
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
  if (expectedActiveDestinationIds === undefined || expectedActiveDestinationIds.size === 0) return 'ready';
  const destinations = current.configuration.reporting_destinations ?? [];
  if (
    [...expectedActiveDestinationIds].some(
      destinationId => !destinations.some(destination => destination.destination_id === destinationId)
    )
  ) {
    return 'pending';
  }
  const relevantDestinations = destinations.filter(destination =>
    expectedActiveDestinationIds.has(destination.destination_id)
  );
  if (
    relevantDestinations.some(
      destination =>
        destination.configuration.active !== true ||
        destination.state === 'action_required' ||
        destination.state === 'inactive' ||
        destination.state === 'rejected'
    )
  ) {
    return 'terminal';
  }
  return relevantDestinations.every(destination => destination.state === 'ready') ? 'ready' : 'pending';
}

async function readCurrent(
  client: PrincipalLifecycleClient,
  options: PrincipalLifecycleOptions,
  written: boolean,
  remainingMs?: number
): Promise<GetPrincipalResponse['result']> {
  const response = completedData(
    await client.getPrincipal({}, options.inputHandler, taskOptions(options, remainingMs)),
    'get_principal',
    written,
    isFailedGetPrincipalResponse
  );
  if (response.result.kind === 'failed') {
    throw new PrincipalLifecycleError('get_principal returned a failed result.', {
      code: 'PRINCIPAL_READ_FAILED',
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
  return guardedSyncPrincipalLifecycle(client, configuration, options);
}

/**
 * {@link syncPrincipalLifecycle} with a check of each configuration read before the guarded
 * write that replaces it, including the fresh read after a conflict. Section helpers use it to
 * refuse a replacement the caller did not intend against the configuration actually replaced.
 * @internal
 */
export async function guardedSyncPrincipalLifecycle(
  client: PrincipalLifecycleClient,
  configuration: PrincipalConfiguration,
  options: PrincipalLifecycleOptions = {},
  assertReplaceable?: (prior: GetPrincipalResponse['result'], context: { written: boolean }) => void
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
  // Whether any sync_principal write may have left the process. Until then a refusal is pre-dispatch.
  let written = false;
  let prior = await readCurrent(client, options, written);
  assertExpectedPrincipalKind(prior, options.expectedPrincipalKind, written);
  assertReplaceable?.(prior, { written });
  let applied: AppliedPrincipal | undefined;
  const attemptedIdempotencyKeys = new Set<string>();

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const idempotencyKey = createIdempotencyKey();
    if (typeof idempotencyKey !== 'string' || !isValidIdempotencyKey(idempotencyKey)) {
      throw new TypeError('createIdempotencyKey must return a valid AdCP idempotency key.');
    }
    if (attemptedIdempotencyKeys.has(idempotencyKey)) {
      throw new PrincipalLifecycleError('createIdempotencyKey must return a fresh key for each conflict retry.', {
        code: 'PRINCIPAL_INVALID_OPTIONS',
      });
    }
    attemptedIdempotencyKeys.add(idempotencyKey);
    const request: MutatingRequestInput<SyncPrincipalRequest> = {
      idempotency_key: idempotencyKey,
      configuration: desiredConfiguration,
      ...(prior.kind === 'current' ? { expected_configuration_version: prior.configuration_version } : {}),
      ...(options.expectedPrincipalKind !== undefined
        ? { expected_principal_kind: options.expectedPrincipalKind }
        : prior.kind === 'current' || prior.kind === 'recognized'
          ? { expected_principal_kind: prior.principal_kind }
          : {}),
    };
    let taskResult: TaskResult<SyncPrincipalResponse>;
    const writtenBefore = written;
    written = true;
    try {
      // The lifecycle replaces whole sections by contract and checks what it replaces itself, so the
      // client's raw-write guard does not run again here.
      taskResult = await client.syncPrincipal(request, options.inputHandler, {
        ...taskOptions(options),
        allowDeactivation: true,
        allowRevocation: true,
      });
    } catch (error) {
      const refusedLocally = !writtenBefore && isPreDispatchError(error);
      throw new PrincipalLifecycleError('sync_principal transport failed; replay attemptedRequest exactly.', {
        code: 'PRINCIPAL_TRANSPORT_FAILED',
        ...(refusedLocally ? { dispatched: false as const, recovery: 'correctable' as const } : {}),
        cause: error,
        attemptedRequest: request,
      });
    }
    const response = completedData(taskResult, 'sync_principal', writtenBefore, isFailedSyncPrincipalResponse, request);
    if (response.result.kind === 'applied') {
      assertAppliedToSamePrincipal(prior, response.result);
      assertExpectedPrincipalKind(response.result, options.expectedPrincipalKind, written);
      applied = response.result;
      break;
    }
    if (response.result.kind === 'validated') {
      throw new PrincipalLifecycleError('sync_principal unexpectedly returned a dry-run result.', {
        code: 'PRINCIPAL_INVALID_RESPONSE',
      });
    }
    if (!conflictResponse(response) || attempt === maxAttempts) {
      throw new PrincipalLifecycleError(
        conflictResponse(response)
          ? `Principal configuration changed during all ${maxAttempts} guarded replacement attempts.`
          : 'sync_principal returned a failed result.',
        {
          code: conflictResponse(response) ? 'PRINCIPAL_CONFLICT_EXHAUSTED' : 'PRINCIPAL_WRITE_FAILED',
          taskResult,
          protocolErrors: response.result.errors,
          attemptedRequest: request,
        }
      );
    }
    const refreshed = await readCurrent(client, options, written);
    assertSamePrincipal(prior, refreshed);
    assertExpectedPrincipalKind(refreshed, options.expectedPrincipalKind, written);
    assertReplaceable?.(refreshed, { written });
    prior = refreshed;
  }

  if (!applied) {
    throw new PrincipalLifecycleError('Principal configuration was not applied.', {
      code: 'PRINCIPAL_INVALID_RESPONSE',
    });
  }
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
      if (remaining <= 0) throw new PrincipalLifecycleTimeoutError(undefined, { appliedResponse: applied, current });
      const delay = Math.min(pollIntervalMs, remaining);
      await wait(delay, options.signal);
      if (delay === remaining)
        throw new PrincipalLifecycleTimeoutError(undefined, { appliedResponse: applied, current });
      const remainingAfterWait = deadline - Date.now();
      if (remainingAfterWait <= 0)
        throw new PrincipalLifecycleTimeoutError(undefined, { appliedResponse: applied, current });
      const configuredTaskTimeout = options.taskOptions?.timeout;
      const lifecycleBoundsRead =
        configuredTaskTimeout === undefined ||
        configuredTaskTimeout === 0 ||
        configuredTaskTimeout >= remainingAfterWait;
      let readback: GetPrincipalResponse['result'];
      try {
        readback = await readCurrent(client, options, written, remainingAfterWait);
      } catch (error) {
        if (error instanceof TaskTimeoutError && lifecycleBoundsRead) {
          throw new PrincipalLifecycleTimeoutError(undefined, { appliedResponse: applied, current });
        }
        if (error instanceof PrincipalLifecycleError) {
          throw new PrincipalLifecycleError(error.message, {
            code: error.code,
            recovery: error.recovery,
            cause: error,
            taskResult: error.taskResult,
            protocolErrors: error.protocolErrors,
            appliedResponse: applied,
            current,
          });
        }
        throw error;
      }
      if (readback.kind !== 'current') {
        throw new PrincipalLifecycleError('Principal configuration disappeared while destination setup was pending.', {
          code: 'PRINCIPAL_SETUP_INTERRUPTED',
          appliedResponse: applied,
          current,
        });
      }
      if (
        readback.principal_id !== applied.principal_id ||
        readback.principal_kind !== applied.principal_kind ||
        readback.configuration_version !== applied.configuration_version
      ) {
        throw new PrincipalLifecycleError('Principal configuration changed while destination setup was pending.', {
          code: 'PRINCIPAL_SETUP_INTERRUPTED',
          appliedResponse: applied,
          current,
        });
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
