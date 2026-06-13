import { getLatestA2ADataPartFromTask } from '../utils/a2a-artifacts';

/**
 * ADCP standardized status values as per spec PR #78.
 */
export const ADCP_STATUS = {
  SUBMITTED: 'submitted',
  WORKING: 'working',
  INPUT_REQUIRED: 'input-required',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELED: 'canceled',
  REJECTED: 'rejected',
  AUTH_REQUIRED: 'auth-required',
  UNKNOWN: 'unknown',
} as const;

export type ADCPStatus = (typeof ADCP_STATUS)[keyof typeof ADCP_STATUS];

/**
 * Fields that belong to the task envelope, not to a domain payload. Derived
 * from `ProtocolEnvelope` (core/protocol-envelope.json) plus optional fields
 * that AdCP task-response schemas place at envelope level.
 */
export const TASK_ENVELOPE_FIELDS: ReadonlySet<string> = new Set([
  'status',
  'message',
  'timestamp',
  'context_id',
  'task_id',
  'replayed',
  'push_notification_config',
  'governance_context',
  'adcp_version',
  'errors',
  'context',
  'ext',
]);

/**
 * ADCP task-lifecycle statuses that never overlap with AdCP domain status
 * enums and can be trusted from response payload `status` unconditionally.
 */
const EXCLUSIVE_TASK_STATUSES: ReadonlySet<string> = new Set([
  ADCP_STATUS.SUBMITTED,
  ADCP_STATUS.WORKING,
  ADCP_STATUS.INPUT_REQUIRED,
  ADCP_STATUS.AUTH_REQUIRED,
]);

export function isAdcpStatus(status: unknown): status is ADCPStatus {
  return typeof status === 'string' && (Object.values(ADCP_STATUS) as string[]).includes(status);
}

/**
 * Extract a task-lifecycle status from an AdCP payload while ignoring
 * domain-level `status` fields that collide with task status literals.
 */
export function extractAdcpTaskStatusFromPayload(payload: unknown): ADCPStatus | undefined {
  if (payload == null || typeof payload !== 'object' || Array.isArray(payload)) return undefined;

  const record = payload as Record<string, unknown>;
  const status = record.status;
  if (!isAdcpStatus(status)) return undefined;

  if (EXCLUSIVE_TASK_STATUSES.has(status)) {
    return status;
  }

  const hasDomainPayload = Object.keys(record).some(k => !TASK_ENVELOPE_FIELDS.has(k));
  if (hasDomainPayload) {
    return undefined;
  }

  return status;
}

/**
 * Extract the AdCP work-layer status from an A2A wrapped Task result, if
 * present. Returns `undefined` for non-AdCP A2A responses so callers can fall
 * back to the transport-layer status.
 */
export function extractAdcpStatusFromA2aTaskResult(result: unknown): ADCPStatus | undefined {
  if (result == null || typeof result !== 'object' || Array.isArray(result)) return undefined;
  if ((result as { kind?: unknown }).kind !== 'task') return undefined;
  const extracted = getLatestA2ADataPartFromTask(result);
  return extractAdcpTaskStatusFromPayload(extracted?.data);
}
