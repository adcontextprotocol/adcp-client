import type { TaskResult, TaskStatus } from '../core/ConversationTypes';
import { ADCP_STATUS, type ADCPStatus, extractAdcpTaskStatusFromPayload, isAdcpStatus } from '../core/task-status';

export type EffectiveTaskState =
  | Extract<
      TaskStatus,
      | 'submitted'
      | 'working'
      | 'input-required'
      | 'auth-required'
      | 'completed'
      | 'failed'
      | 'rejected'
      | 'canceled'
      | 'deferred'
      | 'governance-denied'
    >
  | 'unknown';

export interface ResolveTaskStateOptions {
  /**
   * AdCP tool name that produced the result. Supplying this lets future SDK
   * versions apply tool-specific reconciliation without changing the API shape.
   */
  toolName?: string;
}

export interface ResolvedTaskState<T> {
  /** Client/wrapper-level TaskResult status. */
  wrapperStatus: TaskResult<T>['status'];
  /** Raw payload `status` value when one is present. May be a domain status. */
  payloadStatus?: string;
  /** The task state callers should branch on. */
  effectiveState: EffectiveTaskState;
  /** Original result data, preserved as-is. */
  data: T | undefined;
  /** Advisory note when the helper had less context than it can accept. */
  hint?: string;
}

const REDUCED_PRECISION_HINT =
  'Pass options.toolName for maximum precision when reconciling payload status fields that can collide with domain statuses.';

/**
 * Reconcile a TaskResult wrapper status with an unwrapped AdCP response payload
 * status. This follows the same task-envelope guard as ProtocolResponseParser:
 * shared literals such as `canceled` and `failed` only count as task lifecycle
 * statuses when the payload shape looks like a task envelope, not a domain
 * object such as a media buy or creative.
 */
export function resolveTaskState<T>(
  result: TaskResult<T>,
  options: ResolveTaskStateOptions = {}
): ResolvedTaskState<T> {
  const wrapperStatus = result.status;
  const data = result.data;
  const payloadStatus = extractRawPayloadStatus(data);

  if (wrapperStatus === 'failed' || wrapperStatus === 'governance-denied') {
    return buildResolved(result, {
      data,
      payloadStatus,
      effectiveState: wrapperStatus,
      includeHint: !options.toolName,
    });
  }

  const payloadTaskStatus = extractPayloadTaskStatus(data);
  const effectiveState = payloadTaskStatus ?? normalizeWrapperStatus(wrapperStatus);

  return buildResolved(result, {
    data,
    payloadStatus,
    effectiveState,
    includeHint: !options.toolName,
  });
}

function buildResolved<T>(
  result: TaskResult<T>,
  fields: {
    data: T | undefined;
    payloadStatus: string | undefined;
    effectiveState: EffectiveTaskState;
    includeHint: boolean;
  }
): ResolvedTaskState<T> {
  return {
    wrapperStatus: result.status,
    ...(fields.payloadStatus !== undefined ? { payloadStatus: fields.payloadStatus } : {}),
    effectiveState: fields.effectiveState,
    data: fields.data,
    ...(fields.includeHint ? { hint: REDUCED_PRECISION_HINT } : {}),
  };
}

function normalizeWrapperStatus(status: TaskResult<unknown>['status']): EffectiveTaskState {
  if (status === 'completed') return ADCP_STATUS.COMPLETED;
  if (status === 'working') return ADCP_STATUS.WORKING;
  if (status === 'submitted') return ADCP_STATUS.SUBMITTED;
  if (status === 'input-required') return ADCP_STATUS.INPUT_REQUIRED;
  if (status === 'auth-required') return ADCP_STATUS.AUTH_REQUIRED;
  if (status === 'deferred') return 'deferred';
  if (status === 'failed') return ADCP_STATUS.FAILED;
  if (status === 'governance-denied') return 'governance-denied';
  return ADCP_STATUS.UNKNOWN;
}

function extractRawPayloadStatus(payload: unknown): string | undefined {
  const direct = getObjectRecord(payload);
  if (!direct) return undefined;
  if (typeof direct.status === 'string') return direct.status;

  const nested = getObjectRecord(direct.response);
  if (typeof nested?.status === 'string') return nested.status;

  const task = getObjectRecord(direct.task);
  if (typeof task?.status === 'string') return task.status;

  return undefined;
}

function extractPayloadTaskStatus(payload: unknown): EffectiveTaskState | undefined {
  const direct = extractTaskStatusFromRecord(payload);
  if (direct) return direct;

  const record = getObjectRecord(payload);
  if (!record) return undefined;

  const nested = extractTaskStatusFromRecord(record.response);
  if (nested) return nested;

  return extractTaskStatusFromRecord(record.task);
}

function extractTaskStatusFromRecord(payload: unknown): ADCPStatus | undefined {
  const envelopeStatus = extractAdcpTaskStatusFromPayload(payload);
  if (envelopeStatus) return envelopeStatus;

  const record = getObjectRecord(payload);
  if (!record || !isTaskStatusPayload(record) || !isAdcpStatus(record.status)) return undefined;
  return record.status;
}

function isTaskStatusPayload(record: Record<string, unknown>): boolean {
  return (
    typeof record.task_id === 'string' &&
    (typeof record.task_type === 'string' ||
      typeof record.protocol === 'string' ||
      typeof record.created_at === 'string' ||
      typeof record.updated_at === 'string')
  );
}

function getObjectRecord(value: unknown): Record<string, unknown> | undefined {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}
