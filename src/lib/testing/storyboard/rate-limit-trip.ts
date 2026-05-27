/**
 * Sequential rate-limit trip/replay support for the
 * `rate_limit_trip_runner` test-kit contract.
 *
 * The observer sends fresh-idempotency-key requests until a seller returns
 * `RATE_LIMITED`, waits the advertised retry_after, then replays the same
 * key/payload to verify the transient rate-limit response was not cached as
 * the idempotency replay result.
 */

import { randomUUID } from 'node:crypto';
import type { AdcpErrorInfo } from '../../core/ConversationTypes';
import { ADCPError, ProtocolError, ResponseTooLargeError, TaskTimeoutError } from '../../errors';
import { extractAdcpErrorInfo } from '../../utils/error-extraction';
import { isTerminalAdcpError } from '../../utils/response-unwrapper';
import type { TaskResult } from '../types';
import { executeStoryboardTask } from './task-map';
import type { RateLimitTripSpec } from './types';

export const RATE_LIMIT_TRIP_CONTRACT = 'rate_limit_trip_runner';
export const RATE_LIMIT_TRIP_MAX_ATTEMPTS_MIN = 50;
export const RATE_LIMIT_TRIP_MAX_ATTEMPTS_MAX = 500;
export const RATE_LIMIT_TRIP_DEFAULT_REPLAY_MAX_WAIT_SECONDS = 30;

export type RateLimitTripFailureCode =
  | 'rate_limit_trip_misconfigured'
  | 'rate_limit_trip_request_error'
  | 'rate_limit_trip_transport_error'
  | 'missing_retry_after'
  | 'replay_wait_exceeded';

export interface RateLimitTripResponseSnapshot {
  success: boolean;
  data?: unknown;
  /** Structured AdCP error when one was present; otherwise omitted. */
  error?: Pick<AdcpErrorInfo, 'code' | 'message' | 'recovery' | 'field' | 'suggestion' | 'retry_after' | 'details'>;
  /** Original TaskResult.error string, retained for diagnostics. */
  error_message?: string;
  adcp_error?: AdcpErrorInfo;
}

export interface RateLimitTripStructuredResult {
  attempts: number;
  target_task?: string;
  target_transport?: 'mcp' | 'a2a';
  trip_request?: Record<string, unknown>;
  replay_request?: Record<string, unknown>;
  rate_limited_request?: {
    task: string;
    attempt: number;
    idempotency_key: string;
  };
  trip_response?: RateLimitTripResponseSnapshot;
  replay_response?: RateLimitTripResponseSnapshot;
}

export type RateLimitTripObservation =
  | {
      status: 'completed';
      body: RateLimitTripStructuredResult;
    }
  | {
      status: 'not_applicable';
      skip_reason: 'rate_limit_not_triggered';
      message: string;
      body: RateLimitTripStructuredResult;
    }
  | {
      status: 'failed';
      error: RateLimitTripFailureCode;
      message: string;
      body: RateLimitTripStructuredResult;
    };

export interface RateLimitTripObserverOptions {
  /** Mint fresh idempotency keys for each burst attempt. */
  keyMinter?: () => string;
  /** Injectable sleep for fast deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Prefix for context.correlation_id tags. */
  correlationPrefix?: string;
  /** Transport label for runner output diagnostics. */
  transport?: 'mcp' | 'a2a';
}

export interface RateLimitTripTaskOptions {
  skipIdempotencyAutoInject?: boolean;
  skipAccountValidation?: boolean;
}

/**
 * Minimal client surface required by {@link RateLimitTripObserver}. The
 * easiest way to obtain one is `createTestClient(...)` from
 * `@adcp/sdk/testing`, but `SingleAgentClient` and compatible test doubles
 * also satisfy this interface.
 */
export interface RateLimitTripClient {
  executeTask(
    taskName: string,
    params: Record<string, unknown>,
    inputHandler?: unknown,
    options?: RateLimitTripTaskOptions
  ): Promise<TaskResult>;
  [methodName: string]: unknown;
}

export function validateRateLimitTripSpec(spec: RateLimitTripSpec | undefined): string | null {
  if (!spec || typeof spec !== 'object') {
    return 'rate_limit_trip is required for expect_rate_limit_not_replayed';
  }
  if (typeof spec.trip_target_task !== 'string' || spec.trip_target_task.length === 0) {
    return 'rate_limit_trip.trip_target_task must be a non-empty string';
  }
  if (
    !spec.trip_target_sample_request ||
    typeof spec.trip_target_sample_request !== 'object' ||
    Array.isArray(spec.trip_target_sample_request)
  ) {
    return 'rate_limit_trip.trip_target_sample_request must be an object';
  }
  if (!Number.isInteger(spec.max_attempts)) {
    return `rate_limit_trip.max_attempts must be an integer; received ${spec.max_attempts}`;
  }
  if (spec.max_attempts < RATE_LIMIT_TRIP_MAX_ATTEMPTS_MIN || spec.max_attempts > RATE_LIMIT_TRIP_MAX_ATTEMPTS_MAX) {
    return (
      `rate_limit_trip.max_attempts must be in [${RATE_LIMIT_TRIP_MAX_ATTEMPTS_MIN}, ` +
      `${RATE_LIMIT_TRIP_MAX_ATTEMPTS_MAX}] per test-kits/rate-limit-trip-runner.yaml; ` +
      `received ${spec.max_attempts}`
    );
  }
  if (spec.replay_max_wait_seconds !== undefined) {
    if (!Number.isFinite(spec.replay_max_wait_seconds) || spec.replay_max_wait_seconds <= 0) {
      return `rate_limit_trip.replay_max_wait_seconds must be a positive finite number; received ${spec.replay_max_wait_seconds}`;
    }
  }
  return null;
}

const defaultSleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));

/**
 * Public primitive for the rate-limit trip/replay contract. Callers supply a
 * {@link RateLimitTripClient}; use `createTestClient(...)` for the standard
 * compliance-runner client.
 */
export class RateLimitTripObserver {
  constructor(
    private readonly client: RateLimitTripClient,
    private readonly defaults: RateLimitTripObserverOptions = {}
  ) {}

  async run(spec: RateLimitTripSpec, opts: RateLimitTripObserverOptions = {}): Promise<RateLimitTripObservation> {
    const validationError = validateRateLimitTripSpec(spec);
    if (validationError) {
      return {
        status: 'failed',
        error: 'rate_limit_trip_misconfigured',
        message: validationError,
        body: { attempts: 0 },
      };
    }

    const keyMinter = opts.keyMinter ?? this.defaults.keyMinter ?? defaultKeyMinter;
    const sleep = opts.sleep ?? this.defaults.sleep ?? defaultSleep;
    const correlationPrefix = opts.correlationPrefix ?? this.defaults.correlationPrefix ?? 'rate_limit_trip';
    const replayMaxWaitSeconds = spec.replay_max_wait_seconds ?? RATE_LIMIT_TRIP_DEFAULT_REPLAY_MAX_WAIT_SECONDS;
    const baseRequest = cloneRequest(spec.trip_target_sample_request);
    const baseBody: RateLimitTripStructuredResult = {
      attempts: 0,
      target_task: spec.trip_target_task,
      target_transport: opts.transport ?? this.defaults.transport,
    };

    let trip:
      | {
          attempt: number;
          idempotencyKey: string;
          response: TaskResult;
          error: AdcpErrorInfo;
        }
      | undefined;
    let lastTripRequest: Record<string, unknown> | undefined;

    for (let attempt = 1; attempt <= spec.max_attempts; attempt++) {
      const idempotencyKey = keyMinter();
      const request = withTripEnvelope(baseRequest, idempotencyKey, `${correlationPrefix}#trip-${attempt}`);
      lastTripRequest = request;
      let response: TaskResult;
      try {
        response = await executeStoryboardTask(this.client, spec.trip_target_task, request);
      } catch (err) {
        return transportFailureObservation(err, { ...baseBody, attempts: attempt, trip_request: request });
      }
      const error = extractTaskAdcpError(response, spec.trip_target_task);
      if (error?.code === 'RATE_LIMITED') {
        trip = { attempt, idempotencyKey, response, error };
        break;
      }
      if (error) {
        return {
          status: 'failed',
          error: 'rate_limit_trip_request_error',
          message: `Target task returned ${error.code}: ${error.message}`,
          body: {
            ...baseBody,
            attempts: attempt,
            trip_request: request,
            trip_response: snapshotTaskResult(response, spec.trip_target_task),
          },
        };
      }
    }

    if (!trip) {
      return {
        status: 'not_applicable',
        skip_reason: 'rate_limit_not_triggered',
        message: `No RATE_LIMITED response observed within ${spec.max_attempts} attempt(s).`,
        body: { ...baseBody, attempts: spec.max_attempts, ...(lastTripRequest && { trip_request: lastTripRequest }) },
      };
    }

    const commonBody: RateLimitTripStructuredResult = {
      ...baseBody,
      attempts: trip.attempt,
      trip_request: withTripEnvelope(baseRequest, trip.idempotencyKey, `${correlationPrefix}#trip-${trip.attempt}`),
      rate_limited_request: {
        task: spec.trip_target_task,
        attempt: trip.attempt,
        idempotency_key: trip.idempotencyKey,
      },
      trip_response: snapshotTaskResult(trip.response, spec.trip_target_task),
    };

    const retryAfterSeconds = readRetryAfterSeconds(trip.error);
    if (retryAfterSeconds === undefined || retryAfterSeconds <= 0) {
      return {
        status: 'failed',
        error: 'missing_retry_after',
        message: 'RATE_LIMITED response did not include a positive retry_after value.',
        body: commonBody,
      };
    }
    if (retryAfterSeconds > replayMaxWaitSeconds) {
      return {
        status: 'failed',
        error: 'replay_wait_exceeded',
        message:
          `RATE_LIMITED retry_after (${retryAfterSeconds}s) exceeds ` +
          `rate_limit_trip.replay_max_wait_seconds (${replayMaxWaitSeconds}s).`,
        body: commonBody,
      };
    }

    await sleep(Math.max(1, Math.ceil(retryAfterSeconds * 1000)));
    const replayRequest = withTripEnvelope(baseRequest, trip.idempotencyKey, `${correlationPrefix}#replay`);
    let replayResponse: TaskResult;
    try {
      replayResponse = await executeStoryboardTask(this.client, spec.trip_target_task, replayRequest);
    } catch (err) {
      return transportFailureObservation(err, { ...commonBody, replay_request: replayRequest });
    }

    return {
      status: 'completed',
      body: {
        ...commonBody,
        replay_request: replayRequest,
        replay_response: snapshotTaskResult(replayResponse, spec.trip_target_task),
      },
    };
  }
}

function transportFailureObservation(
  err: unknown,
  body: RateLimitTripStructuredResult
): Extract<RateLimitTripObservation, { status: 'failed' }> {
  const message = err instanceof Error ? err.message : String(err);
  const error =
    err instanceof ADCPError && !isTransportAdcpError(err)
      ? 'rate_limit_trip_request_error'
      : 'rate_limit_trip_transport_error';
  return {
    status: 'failed',
    error,
    message,
    body,
  };
}

function isTransportAdcpError(err: ADCPError): boolean {
  return err instanceof ProtocolError || err instanceof ResponseTooLargeError || err instanceof TaskTimeoutError;
}

function defaultKeyMinter(): string {
  return randomUUID();
}

function cloneRequest(request: Record<string, unknown>): Record<string, unknown> {
  if (typeof globalThis.structuredClone === 'function') {
    return globalThis.structuredClone(request);
  }
  return JSON.parse(JSON.stringify(request)) as Record<string, unknown>;
}

function withTripEnvelope(
  baseRequest: Record<string, unknown>,
  idempotencyKey: string,
  correlationId: string
): Record<string, unknown> {
  const request = cloneRequest(baseRequest);
  request.idempotency_key = idempotencyKey;
  const existingContext = request.context;
  if (existingContext && typeof existingContext === 'object' && !Array.isArray(existingContext)) {
    request.context = { ...(existingContext as Record<string, unknown>), correlation_id: correlationId };
  } else if (existingContext === undefined) {
    request.context = { correlation_id: correlationId };
  }
  return request;
}

export function extractTaskAdcpError(taskResult: TaskResult, taskName?: string): AdcpErrorInfo | undefined {
  if (taskResult.adcp_error) return taskResult.adcp_error;
  const data = taskResult.data as Record<string, unknown> | undefined;
  if (Array.isArray(data?.errors)) {
    if (taskResult.success !== false && taskName && !isTerminalAdcpError(data, taskName)) {
      return undefined;
    }
    const first = data.errors[0];
    if (first && typeof first === 'object' && typeof (first as Record<string, unknown>).code === 'string') {
      return buildAdcpErrorInfo(first as Record<string, unknown>);
    }
  }
  const extracted = extractAdcpErrorInfo(data);
  if (extracted) return extracted;
  const dataError = data?.error;
  if (dataError && typeof dataError === 'object' && typeof (dataError as Record<string, unknown>).code === 'string') {
    return buildAdcpErrorInfo(dataError as Record<string, unknown>);
  }
  return undefined;
}

function buildAdcpErrorInfo(obj: Record<string, unknown>): AdcpErrorInfo {
  const code = String(obj.code);
  const message = typeof obj.message === 'string' ? obj.message : code;
  const info: AdcpErrorInfo = { code, message };
  if (obj.recovery === 'transient' || obj.recovery === 'correctable' || obj.recovery === 'terminal') {
    info.recovery = obj.recovery;
  }
  if (typeof obj.field === 'string') info.field = obj.field;
  if (typeof obj.suggestion === 'string') info.suggestion = obj.suggestion;
  if (typeof obj.retry_after === 'number' && Number.isFinite(obj.retry_after)) info.retry_after = obj.retry_after;
  if (obj.details && typeof obj.details === 'object') info.details = obj.details as Record<string, unknown>;
  return info;
}

function readRetryAfterSeconds(error: AdcpErrorInfo): number | undefined {
  if (typeof error.retry_after === 'number' && Number.isFinite(error.retry_after)) return error.retry_after;
  const detailsRetry = error.details?.retry_after;
  if (typeof detailsRetry === 'number' && Number.isFinite(detailsRetry)) return detailsRetry;
  return undefined;
}

function snapshotTaskResult(taskResult: TaskResult, taskName?: string): RateLimitTripResponseSnapshot {
  const adcpError = extractTaskAdcpError(taskResult, taskName);
  return {
    success: taskResult.success,
    ...(taskResult.data !== undefined && { data: taskResult.data }),
    ...(adcpError && {
      error: {
        code: adcpError.code,
        message: adcpError.message,
        ...(adcpError.recovery && { recovery: adcpError.recovery }),
        ...(adcpError.field && { field: adcpError.field }),
        ...(adcpError.suggestion && { suggestion: adcpError.suggestion }),
        ...(adcpError.retry_after !== undefined && { retry_after: adcpError.retry_after }),
        ...(adcpError.details && { details: adcpError.details }),
      },
      adcp_error: adcpError,
    }),
    ...(taskResult.error && { error_message: taskResult.error }),
  };
}
