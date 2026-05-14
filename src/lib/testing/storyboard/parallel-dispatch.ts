/**
 * Parallel-dispatch runner support for the `parallel_dispatch_runner`
 * test-kit contract. Drives the concurrent-retry phase of the idempotency
 * storyboard (rule 9 / first-insert-wins): two `create_media_buy` calls
 * with the same `idempotency_key` race the seller's INSERT and must
 * resolve to one resource. Spec:
 * `test-kits/parallel-dispatch-runner.yaml`.
 *
 * Modes:
 *   - `process_local` (default): fan out N requests via `Promise.all`. Event-
 *     loop concurrent, sufficient to exercise the seller's INSERT race per
 *     the contract YAML's `not_required_to_synthesize_packet_schedule`.
 *   - `distributed`: barrier-synced workers across processes — out of scope
 *     for this module. Callers grade the step `not_applicable` when the
 *     storyboard requests `distributed` and the runner cannot satisfy it.
 *
 * In-flight resolution: a dispatch that returns `IDEMPOTENCY_IN_FLIGHT` or
 * (legacy) `SERVICE_UNAVAILABLE` with a `retry_after` hint retries with the
 * SAME idempotency_key after the hint elapses. The runner caps retries so
 * a stuck seller can't pin a barrier indefinitely; the outer barrier
 * timeout is the second line of defense.
 */

import type { TaskResult } from '../types';
import { executeStoryboardTask } from './task-map';
import type { CrossResponseDispatch, CrossResponseSet } from './validations';
import type { ParallelDispatchSpec } from './types';

/**
 * Minimum and maximum parallel dispatches per the contract YAML. The
 * `count_max: 10` is a soft ceiling — every runner mode MUST support up to
 * 10 parallel dispatches per the spec's
 * `every_runner_mode_supports_up_to_10` note.
 */
export const PARALLEL_DISPATCH_COUNT_MIN = 2;
export const PARALLEL_DISPATCH_COUNT_MAX = 10;
/** Default barrier timeout when the storyboard omits `barrier_timeout_ms`. */
export const PARALLEL_DISPATCH_DEFAULT_BARRIER_MS = 5000;
/**
 * Per-dispatch retry budget for the in-flight branch. The outer barrier
 * (default 5s, configurable) is the real cap — the dispatcher honors the
 * seller's `retry_after` hint, then clamps every sleep to the remaining
 * barrier so the budget mostly matters when a misbehaving seller floods
 * tiny hints. 5 is enough headroom for that case without letting a stuck
 * seller pin the runner past the barrier.
 */
const IN_FLIGHT_RETRY_BUDGET = 5;
/** Floor for the in-flight retry sleep so a misbehaving seller can't busy-loop the runner. */
const IN_FLIGHT_MIN_SLEEP_MS = 50;

/**
 * The contract id storyboards declare on `requires_contract` to opt into
 * parallel-dispatch grading. Runners without the contract in scope grade
 * the step `not_applicable`.
 */
export const PARALLEL_DISPATCH_CONTRACT = 'parallel_dispatch_runner';

/**
 * In-flight resolution: error codes the runner treats as "retry with the
 * same idempotency_key after retry_after." `IDEMPOTENCY_IN_FLIGHT` is the
 * AdCP 3.1 wire code; `SERVICE_UNAVAILABLE` is accepted as a legacy
 * fallback so the runner grades SDKs that haven't migrated yet against
 * the same contract.
 */
const IN_FLIGHT_ERROR_CODES = new Set(['IDEMPOTENCY_IN_FLIGHT', 'SERVICE_UNAVAILABLE']);

/** Parsed `(code, retry_after_seconds)` from a TaskResult, when present. */
interface AdcpErrorInfo {
  code: string;
  retry_after_seconds?: number;
}

function extractAdcpError(tr: TaskResult): AdcpErrorInfo | undefined {
  const data = tr.data as Record<string, unknown> | undefined;
  const err = data?.adcp_error as Record<string, unknown> | undefined;
  if (!err || typeof err.code !== 'string') return undefined;
  const retry = err.retry_after;
  return {
    code: err.code,
    ...(typeof retry === 'number' && Number.isFinite(retry) ? { retry_after_seconds: retry } : {}),
  };
}

/**
 * Configuration accepted by {@link dispatchOnceWithInflightRetry}.
 */
export interface DispatchOnceOptions {
  /**
   * Cooperative deadline (epoch ms) past which retries are abandoned. Set by
   * the caller to align with the outer barrier — a dispatch that's still
   * IDEMPOTENCY_IN_FLIGHT at the deadline returns its most recent
   * TaskResult so the barrier-timeout grading path can record the seller's
   * last-seen error code.
   */
  deadlineMs: number;
}

/**
 * Validate a {@link ParallelDispatchSpec} or return a structured authoring
 * error. Returns `null` when the spec is well-formed. The runner surfaces
 * the error as a `parallel_dispatch_misconfigured` step result rather than
 * silently clamping — silent clamping would let a storyboard advertise a
 * `count_max: 50` test that the runner only partially executed.
 */
export function validateParallelDispatchSpec(spec: ParallelDispatchSpec): string | null {
  if (!Number.isInteger(spec.count)) {
    return `parallel_dispatch.count must be an integer; received ${spec.count}`;
  }
  if (spec.count < PARALLEL_DISPATCH_COUNT_MIN || spec.count > PARALLEL_DISPATCH_COUNT_MAX) {
    return (
      `parallel_dispatch.count must be in [${PARALLEL_DISPATCH_COUNT_MIN}, ${PARALLEL_DISPATCH_COUNT_MAX}] ` +
      `per test-kits/parallel-dispatch-runner.yaml; received ${spec.count}`
    );
  }
  if (spec.barrier_timeout_ms !== undefined) {
    if (!Number.isFinite(spec.barrier_timeout_ms) || spec.barrier_timeout_ms <= 0) {
      return `parallel_dispatch.barrier_timeout_ms must be a positive finite number; received ${spec.barrier_timeout_ms}`;
    }
  }
  if (spec.mode !== undefined && spec.mode !== 'process_local' && spec.mode !== 'distributed') {
    return `parallel_dispatch.mode must be 'process_local' or 'distributed'; received '${spec.mode}'`;
  }
  return null;
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));

/**
 * Run one dispatch and retry on the in-flight branch. Returns the dispatch's
 * terminal `TaskResult` (success, terminal error, or last-seen in-flight
 * after the deadline). Catches thrown errors and shapes them into a
 * synthetic error TaskResult so callers see a uniform `TaskResult`-shaped
 * outcome.
 */
export async function dispatchOnceWithInflightRetry(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- client surface varies (TestClient)
  client: any,
  taskName: string,
  request: Record<string, unknown>,
  opts: DispatchOnceOptions
): Promise<{ taskResult: TaskResult; error?: string }> {
  let lastTaskResult: TaskResult | undefined;
  let lastError: string | undefined;
  for (let attempt = 0; attempt < IN_FLIGHT_RETRY_BUDGET; attempt++) {
    try {
      const tr = await executeStoryboardTask(client, taskName, request);
      lastTaskResult = tr;
      lastError = undefined;
      if (tr.success) {
        return { taskResult: tr };
      }
      const err = extractAdcpError(tr);
      if (!err || !IN_FLIGHT_ERROR_CODES.has(err.code)) {
        return { taskResult: tr };
      }
      // Honor the seller's retry hint when present (clamped to [50ms, 3600s]
      // per spec retry_after range). Default to 200 ms — enough headroom
      // for the first request's INSERT to commit on a healthy seller, short
      // enough that the barrier timeout dominates on a stuck one.
      const hintMs = err.retry_after_seconds !== undefined ? Math.floor(err.retry_after_seconds * 1000) : 200;
      const sleepMs = Math.max(IN_FLIGHT_MIN_SLEEP_MS, Math.min(3_600_000, hintMs));
      const remaining = opts.deadlineMs - Date.now();
      if (remaining <= 0) {
        return { taskResult: tr };
      }
      await sleep(Math.min(sleepMs, remaining));
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      const remaining = opts.deadlineMs - Date.now();
      if (remaining <= 0) break;
      // Thrown SDK errors aren't `IDEMPOTENCY_IN_FLIGHT` by definition (the
      // SDK only throws on transport / parse failures); stop retrying so we
      // surface the thrown error rather than masking it as a retry storm.
      break;
    }
  }
  if (lastTaskResult) {
    return { taskResult: lastTaskResult, ...(lastError ? { error: lastError } : {}) };
  }
  return {
    taskResult: {
      success: false,
      ...(lastError !== undefined && { error: lastError }),
    },
    ...(lastError !== undefined && { error: lastError }),
  };
}

/**
 * Fan out N concurrent dispatches and collect the resolved set.
 *
 * Every dispatch shares the caller's `baseRequest` (so the canonical
 * payload hash matches across dispatches and the seller's idempotency
 * store sees a single logical request). Per-dispatch ergonomics:
 *
 *   - `context.correlation_id` is rewritten to a per-dispatch suffix so
 *     trace logs can attribute a delivery to a specific arm. Per the
 *     spec, `context` (object form) is excluded from the canonical
 *     payload hash, so distinct correlation_ids don't trip
 *     IDEMPOTENCY_CONFLICT.
 *   - `same_idempotency_key !== false` (default `true`): every dispatch
 *     shares `baseRequest.idempotency_key`. The runner does NOT mint
 *     fresh keys per arm — that defeats the test.
 *   - `same_idempotency_key: false`: each dispatch gets its own
 *     idempotency_key minted via `keyMinter`. Used by soak tests that
 *     want parallelism without the race semantics.
 */
export interface RunParallelDispatchesOptions {
  /** Spec block from the storyboard step. */
  spec: ParallelDispatchSpec;
  /**
   * Mint a fresh idempotency_key. Only invoked when `same_idempotency_key`
   * is explicitly `false`. Callers thread the runner's existing
   * `generateIdempotencyKey()` here.
   */
  keyMinter: () => string;
  /**
   * Correlation prefix; the runner suffixes `#<dispatch_index>` to produce
   * the per-arm correlation_id written to `context.correlation_id`. Defaults
   * to the storyboard step id.
   */
  correlationPrefix?: string;
}

export async function runParallelDispatches(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- client surface varies (TestClient)
  client: any,
  taskName: string,
  baseRequest: Record<string, unknown>,
  opts: RunParallelDispatchesOptions
): Promise<CrossResponseSet> {
  const { spec, keyMinter, correlationPrefix = 'parallel_dispatch' } = opts;
  const barrierMs = spec.barrier_timeout_ms ?? PARALLEL_DISPATCH_DEFAULT_BARRIER_MS;
  const sameKey = spec.same_idempotency_key !== false;
  const deadlineMs = Date.now() + barrierMs;

  const dispatchPromises = Array.from({ length: spec.count }, (_, index) => {
    const correlationId = `${correlationPrefix}#${index}`;
    const request: Record<string, unknown> = { ...baseRequest };
    if (!sameKey) {
      request.idempotency_key = keyMinter();
    }
    // Replace context.correlation_id without touching other fields. context
    // is hash-excluded only in object form; if a storyboard supplied a
    // string context (SI tools), leave it alone — the runner won't tag
    // those arms but the dispatch still functions.
    const existingContext = request.context;
    if (existingContext && typeof existingContext === 'object' && !Array.isArray(existingContext)) {
      request.context = { ...(existingContext as Record<string, unknown>), correlation_id: correlationId };
    } else if (existingContext === undefined) {
      request.context = { correlation_id: correlationId };
    }

    const started = Date.now();
    return dispatchWithBarrier(client, taskName, request, deadlineMs).then(outcome => {
      const dispatch: CrossResponseDispatch = {
        correlation_id: correlationId,
        duration_ms: Date.now() - started,
        ...(outcome.taskResult && { taskResult: outcome.taskResult }),
        ...(outcome.error !== undefined && { error: outcome.error }),
        ...(outcome.timed_out && { timed_out: true }),
      };
      return dispatch;
    });
  });

  const dispatches = await Promise.all(dispatchPromises);
  const resolved = dispatches
    .filter(d => d.taskResult?.success === true && !d.timed_out)
    .map(d => d.taskResult as TaskResult);
  return { dispatches, resolved };
}

interface DispatchOutcome {
  taskResult?: TaskResult;
  error?: string;
  timed_out?: boolean;
}

async function dispatchWithBarrier(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- client surface varies (TestClient)
  client: any,
  taskName: string,
  request: Record<string, unknown>,
  deadlineMs: number
): Promise<DispatchOutcome> {
  const work = dispatchOnceWithInflightRetry(client, taskName, request, { deadlineMs });
  const remaining = deadlineMs - Date.now();
  if (remaining <= 0) {
    return { timed_out: true };
  }
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<DispatchOutcome>(resolve => {
    timeoutHandle = setTimeout(() => resolve({ timed_out: true }), remaining);
  });
  try {
    const result = await Promise.race([work.then(r => r as DispatchOutcome), timeoutPromise]);
    return result;
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
}
