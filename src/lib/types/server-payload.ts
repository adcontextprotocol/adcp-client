/**
 * Server-side handler payload helpers.
 *
 * Generated AdCP response types describe the transport/wire shape. In v3.1
 * that includes protocol envelope fields such as `status: TaskStatus`,
 * `task_id`, and `adcp_version`. Server handlers should return only the
 * domain payload; the SDK stamps the protocol envelope at dispatch time.
 */

import type { TaskStatus } from './tools.generated';

type ProtocolTaskStatus = TaskStatus;

type ProtocolStatusKey<T> = 'status' extends keyof T
  ? NonNullable<T['status']> extends ProtocolTaskStatus
    ? 'status'
    : never
  : never;

type ProtocolEnvelopeKeys<T> =
  | ProtocolStatusKey<T>
  | 'context_id'
  | 'task_id'
  | 'message'
  | 'timestamp'
  | 'replayed'
  | 'adcp_error'
  | 'push_notification_config'
  | 'payload'
  | 'adcp_version'
  | 'adcp_major_version';

/**
 * Domain payload shape a server handler returns for a generated wire response.
 *
 * Use this when a generated `*Response` type includes protocol-envelope fields
 * the SDK owns. Domain-level `status` fields are preserved unless their entire
 * type is the protocol `TaskStatus` vocabulary.
 */
export type ServerPayload<T> = T extends unknown ? Omit<T, ProtocolEnvelopeKeys<T>> : never;
