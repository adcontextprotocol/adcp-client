import { ADCPError } from '../errors';
import type { AccountChange } from '../types';
import type { AccountChangeRecordedWebhook } from '../types/core.generated';
export type { AccountChangeRecordedWebhook } from '../types/core.generated';
import type { AdvisoryThroughCursor } from '../client/account-change-cursor';
import { getSchemaValidatorByRef } from '../validation/schema-loader';

export type AccountChangeNotificationErrorCode =
  | 'account_change_body_malformed'
  | 'account_change_schema_invalid'
  | 'account_change_identity_mismatch';

export class AccountChangeNotificationError extends ADCPError {
  constructor(
    public readonly code: AccountChangeNotificationErrorCode,
    public readonly field: string
  ) {
    super(`Invalid account.change_recorded delivery at ${field}.`, { field });
  }
}

export interface AccountChangeNotificationIdentity {
  /** Expected identity from the authenticated receiver's subscription, never from the payload. */
  accountId: string;
  subscriberId: string;
  /** Optional authoritative record, e.g. when correlating a fire with a drained page. */
  change?: AccountChange;
  /** Optional prior fire with this retry key or logical ID, scoped to the authenticated sender. */
  previous?: NormalizedAccountChangeNotification;
}

export interface NormalizedAccountChangeNotification {
  readonly notificationType: 'account.change_recorded';
  readonly notificationId: string;
  readonly changeId: string;
  readonly idempotencyKey: string;
  readonly accountId: string;
  readonly subscriberId: string;
  readonly firedAt: string;
  readonly recordedAt: string;
  readonly resource: AccountChange['resource'];
  readonly action: string;
  readonly throughCursor?: AdvisoryThroughCursor;
  readonly ext?: Record<string, unknown>;
}

/**
 * Validate the published schema and logical/retry identity after authenticating
 * the sender (e.g. RFC 9421 verification of the original bytes). This function
 * does not authenticate, authorize, deduplicate, or persist deliveries.
 * Unknown resource/action names remain generic invalidations.
 */
export function parseAccountChangeNotification(
  input: unknown,
  identity: AccountChangeNotificationIdentity
): NormalizedAccountChangeNotification {
  let parsed: unknown;
  try {
    parsed = input instanceof Uint8Array ? new TextDecoder('utf-8', { fatal: true }).decode(input) : input;
    parsed = typeof parsed === 'string' ? JSON.parse(parsed) : structuredClone(parsed);
  } catch {
    throw new AccountChangeNotificationError('account_change_body_malformed', '$');
  }
  const validator = getSchemaValidatorByRef('core/account-change-recorded-webhook.json');
  if (!validator) throw new Error('Bundled account.change_recorded schema is unavailable.');
  if (!validator(parsed)) {
    throw new AccountChangeNotificationError(
      'account_change_schema_invalid',
      validator.errors?.[0]?.instancePath || '$'
    );
  }
  const wire = parsed as AccountChangeRecordedWebhook;
  equal(wire.notification_id, wire.change_id, 'notification_id');
  equal(wire.account_id, identity.accountId, 'account_id');
  equal(wire.subscriber_id, identity.subscriberId, 'subscriber_id');
  if ('account_id' in wire.resource) equal(wire.resource.account_id, wire.account_id, 'resource.account_id');
  if (wire.resource.type === 'account') equal(wire.resource.resource_id, wire.account_id, 'resource.resource_id');
  // The webhook's action has a looser schema than the feed's action. Identity
  // must still be representable by a corresponding authoritative change record.
  if (!/^[a-z][a-z0-9_.-]{0,99}$/.test(wire.action)) {
    throw new AccountChangeNotificationError('account_change_schema_invalid', 'action');
  }
  const resource = { ...wire.resource, account_id: wire.account_id } as AccountChange['resource'];
  const normalized: NormalizedAccountChangeNotification = {
    notificationType: wire.notification_type,
    notificationId: wire.notification_id,
    changeId: wire.change_id,
    idempotencyKey: wire.idempotency_key,
    accountId: wire.account_id,
    subscriberId: wire.subscriber_id,
    firedAt: wire.fired_at,
    recordedAt: wire.recorded_at,
    resource,
    action: wire.action,
    ...(wire.through_cursor !== undefined && {
      throughCursor: Object.freeze({ kind: 'advisory', value: wire.through_cursor }) as AdvisoryThroughCursor,
    }),
    ...(wire.ext !== undefined && { ext: wire.ext }),
  };
  if (identity.change) {
    const change = identity.change;
    equal(change.change_id, normalized.changeId, 'change_id');
    equal(change.recorded_at, normalized.recordedAt, 'recorded_at');
    equal(change.action, normalized.action, 'action');
    equalResource(change.resource, resource);
  }
  if (identity.previous) {
    const previous = identity.previous;
    equal(previous.accountId, normalized.accountId, 'account_id');
    equal(previous.subscriberId, normalized.subscriberId, 'subscriber_id');
    equal(previous.changeId, normalized.changeId, 'change_id');
    equal(previous.recordedAt, normalized.recordedAt, 'recorded_at');
    equal(previous.action, normalized.action, 'action');
    equalResource(previous.resource, resource);
    if (previous.idempotencyKey === normalized.idempotencyKey) {
      equal(previous.firedAt, normalized.firedAt, 'fired_at');
      equal(previous.throughCursor?.value, normalized.throughCursor?.value, 'through_cursor');
    }
  }
  return normalized;
}

export const normalizeAccountChangeNotification = parseAccountChangeNotification;

function equal(actual: unknown, expected: unknown, field: string): void {
  if (actual !== expected) throw new AccountChangeNotificationError('account_change_identity_mismatch', field);
}

function equalResource(left: AccountChange['resource'], right: AccountChange['resource']): void {
  equal(left.type, right.type, 'resource.type');
  equal(left.account_id, right.account_id, 'resource.account_id');
  equal(left.resource_id, right.resource_id, 'resource.resource_id');
  const keys = new Set([...Object.keys(left.parent_ids ?? {}), ...Object.keys(right.parent_ids ?? {})]);
  for (const key of keys) equal(left.parent_ids?.[key], right.parent_ids?.[key], 'resource.parent_ids');
}
