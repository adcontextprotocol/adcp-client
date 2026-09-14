import { ADCPError, ConfigurationError } from '../errors';
import type { AccountChange } from '../types';
import type { AccountChangeRecordedWebhook } from '../types/core.generated';
export type { AccountChangeRecordedWebhook } from '../types/core.generated';
import type { AdvisoryThroughCursor } from '../client/account-change-cursor';
import { getSchemaValidatorByRef } from '../validation/schema-loader';
import { assertAccountChangeJsonSize } from '../client/account-change-json';

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

export interface AccountChangeNotificationOptions {
  /** Receiver limit, default 64 KiB. Increase explicitly for large vendor extensions. */
  maxBytes?: number;
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
  identity: AccountChangeNotificationIdentity,
  options: AccountChangeNotificationOptions = {}
): NormalizedAccountChangeNotification {
  let parsed: unknown;
  const maxBytes = options.maxBytes ?? 64 * 1024;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError('maxBytes must be a positive safe integer.');
  try {
    if (
      (typeof input === 'string' && Buffer.byteLength(input) > maxBytes) ||
      (input instanceof Uint8Array && input.byteLength > maxBytes)
    )
      throw new Error('Body size limit exceeded');
    parsed = input instanceof Uint8Array ? new TextDecoder('utf-8', { fatal: true }).decode(input) : input;
    parsed = typeof parsed === 'string' ? JSON.parse(parsed) : parsed;
    assertAccountChangeJsonSize(parsed, maxBytes);
    parsed = structuredClone(parsed);
  } catch {
    throw new AccountChangeNotificationError('account_change_body_malformed', '$');
  }
  const validator = getSchemaValidatorByRef('core/account-change-recorded-webhook.json');
  if (!validator) throw new ConfigurationError('Bundled account.change_recorded schema is unavailable.', 'schemas');
  if (!validator(parsed)) {
    throw new AccountChangeNotificationError(
      'account_change_schema_invalid',
      safeSchemaField(validator.errors?.[0]?.instancePath)
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
    equalInstant(change.recorded_at, normalized.recordedAt, 'recorded_at');
    equal(change.action, normalized.action, 'action');
    equalResource(change.resource, resource);
  }
  if (identity.previous) {
    const previous = identity.previous;
    equal(previous.accountId, normalized.accountId, 'account_id');
    equal(previous.subscriberId, normalized.subscriberId, 'subscriber_id');
    equal(previous.changeId, normalized.changeId, 'change_id');
    equalInstant(previous.recordedAt, normalized.recordedAt, 'recorded_at');
    equal(previous.action, normalized.action, 'action');
    equalResource(previous.resource, resource);
    if (previous.idempotencyKey === normalized.idempotencyKey) {
      equalInstant(previous.firedAt, normalized.firedAt, 'fired_at');
      equal(previous.throughCursor?.value, normalized.throughCursor?.value, 'through_cursor');
    }
  }
  return normalized;
}

export const normalizeAccountChangeNotification = parseAccountChangeNotification;

function safeSchemaField(path: string | undefined): string {
  if (!path) return '$';
  // Dictionary keys are seller-controlled and must never reach error/log text.
  if (path.startsWith('/resource/parent_ids')) return 'resource.parent_ids';
  if (path.startsWith('/ext')) return 'ext';
  const known = new Set([
    'idempotency_key',
    'notification_id',
    'notification_type',
    'fired_at',
    'subscriber_id',
    'account_id',
    'change_id',
    'recorded_at',
    'action',
    'through_cursor',
    'resource',
    'resource.type',
    'resource.resource_id',
  ]);
  const field = path.slice(1).replaceAll('/', '.');
  return known.has(field) ? field : '$';
}

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

// Compare equivalent RFC 3339 encodings without collapsing sub-millisecond
// identity (Date.parse alone would silently discard fractional precision).
function equalInstant(actual: string, expected: string, field: string): void {
  if (actual === expected) return;
  const canonical = (value: string) => {
    const match = /^(.*T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/i.exec(value);
    if (!match) return undefined;
    const seconds = Date.parse(match[1]! + match[3]!);
    return Number.isFinite(seconds) ? `${seconds}:${(match[2] ?? '').replace(/0+$/, '')}` : undefined;
  };
  const left = canonical(actual);
  if (left === undefined || left !== canonical(expected)) {
    throw new AccountChangeNotificationError('account_change_identity_mismatch', field);
  }
}
