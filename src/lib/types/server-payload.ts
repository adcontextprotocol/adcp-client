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

type JsonPrimitive = string | number | boolean | null | undefined;

type StripAuthenticationCredentials<T> = T extends { authentication?: infer TAuth }
  ? Omit<T, 'authentication'> & {
      authentication?: TAuth extends object ? Omit<StripWriteOnlyResponseFields<TAuth>, 'credentials'> : TAuth;
    }
  : T;

type StripBusinessEntityBank<T> = T extends { bank?: unknown } ? Omit<T, 'bank'> : T;

type StripWriteOnlyResponseFields<T> = T extends JsonPrimitive
  ? T
  : T extends (infer TItem)[]
    ? StripWriteOnlyResponseFields<TItem>[]
    : T extends readonly (infer TItem)[]
    ? readonly StripWriteOnlyResponseFields<TItem>[]
    : T extends object
      ? StripAuthenticationCredentials<
          StripBusinessEntityBank<{
            [K in keyof T]: StripWriteOnlyResponseFields<T[K]>;
          }>
        >
      : T;

/**
 * Domain payload shape a server handler returns for a generated wire response.
 *
 * Use this when a generated `*Response` type includes protocol-envelope fields
 * the SDK owns. Domain-level `status` fields are preserved unless their entire
 * type is the protocol `TaskStatus` vocabulary.
 *
 * Write-only legacy webhook credentials and billing bank coordinates are
 * also removed from nested objects. Runtime response projection already
 * strips these; this keeps public server payload annotations aligned with
 * what can safely appear on response wires and in adopter logs.
 */
export type ServerPayload<T> = T extends unknown ? StripWriteOnlyResponseFields<Omit<T, ProtocolEnvelopeKeys<T>>> : never;
