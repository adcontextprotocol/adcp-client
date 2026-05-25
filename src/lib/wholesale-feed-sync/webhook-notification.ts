import { ADCPError } from '../errors';
import type * as V31Beta from '../types/v3-1-beta';

export type WholesaleFeedWebhookNotificationType = V31Beta.WholesaleFeedWebhook['notification_type'];
export type WholesaleFeedWebhookAffectedEntityType = 'product' | 'signal';
export type WholesaleFeedWebhookCacheScope = V31Beta.WholesaleFeedWebhook['cache_scope'];

export type WholesaleFeedWebhookNotificationErrorCode =
  | 'wholesale_feed_webhook_body_malformed'
  | 'wholesale_feed_webhook_field_missing'
  | 'wholesale_feed_webhook_field_invalid'
  | 'wholesale_feed_webhook_notification_type_mismatch'
  | 'wholesale_feed_webhook_entity_type_mismatch'
  | 'wholesale_feed_webhook_cache_scope_mismatch'
  | 'wholesale_feed_webhook_bulk_change_invalid';

export interface WholesaleFeedWebhookNotificationErrorDetails {
  field?: string;
  expected?: unknown;
  actual?: unknown;
}

export class WholesaleFeedWebhookNotificationError extends ADCPError {
  readonly code: WholesaleFeedWebhookNotificationErrorCode;
  readonly field: string | undefined;

  constructor(
    code: WholesaleFeedWebhookNotificationErrorCode,
    message: string,
    details: WholesaleFeedWebhookNotificationErrorDetails = {}
  ) {
    super(message, details);
    this.code = code;
    this.field = details.field;
  }
}

export interface NormalizedWholesaleFeedWebhookNotification {
  /** Delivery replay/dedupe key. Scope this to the authenticated sender identity. */
  idempotencyKey: string;
  /** Envelope notification identifier. Must match the nested domain event id. */
  notificationId: string;
  /** Envelope notification type. Guaranteed to match `event.event_type`. */
  notificationType: WholesaleFeedWebhookNotificationType;
  /** Tenant/account identifier for the receiving subscription. */
  accountId: string;
  /** Registered account notification subscriber id. */
  subscriberId: string;
  /** ISO timestamp when this webhook delivery was fired. */
  firedAt: string;
  wholesaleFeedVersion: string;
  previousWholesaleFeedVersion?: string;
  cacheScope: WholesaleFeedWebhookCacheScope;
  /** Stable domain event id nested under `event`. Not the delivery dedupe key. */
  eventId: string;
  eventType: WholesaleFeedWebhookNotificationType;
  entityType: 'product' | 'signal' | 'feed';
  entityId: string;
  eventCreatedAt: string;
  /** Present for `wholesale_feed.bulk_change` notifications. */
  affectedEntityType?: WholesaleFeedWebhookAffectedEntityType;
  event: V31Beta.WholesaleFeedEvent;
  webhook: V31Beta.WholesaleFeedWebhook;
}

const WHOLESALE_FEED_NOTIFICATION_TYPES = new Set<WholesaleFeedWebhookNotificationType>([
  'product.created',
  'product.updated',
  'product.priced',
  'product.removed',
  'signal.created',
  'signal.updated',
  'signal.priced',
  'signal.removed',
  'wholesale_feed.bulk_change',
]);

/**
 * Parse and normalize a canonical wholesale-feed webhook notification.
 *
 * The normalized shape intentionally separates `idempotencyKey` (delivery
 * replay/dedupe) from `eventId` / `notificationId` (domain event identity).
 * It validates envelope-level invariants, including the canonical
 * `notification_id === event.event_id` match.
 */
export function parseWholesaleFeedWebhookNotification(input: unknown): NormalizedWholesaleFeedWebhookNotification {
  const parsed = parseInput(input);
  const webhook = readRecord(parsed, '$');
  const event = readRecord(webhook.event, 'event');

  const idempotencyKey = readRequiredString(webhook, 'idempotency_key');
  const notificationId = readRequiredString(webhook, 'notification_id');
  const notificationType = readNotificationType(readRequiredString(webhook, 'notification_type'), 'notification_type');
  const firedAt = readRequiredString(webhook, 'fired_at');
  const subscriberId = readRequiredString(webhook, 'subscriber_id');
  const accountId = readRequiredString(webhook, 'account_id');
  const wholesaleFeedVersion = readRequiredString(webhook, 'wholesale_feed_version');
  const previousWholesaleFeedVersion = readOptionalString(webhook, 'previous_wholesale_feed_version');
  const cacheScope = readCacheScope(readRequiredString(webhook, 'cache_scope'), 'cache_scope');

  const eventId = readRequiredString(event, 'event.event_id');
  if (notificationId !== eventId) {
    throw new WholesaleFeedWebhookNotificationError(
      'wholesale_feed_webhook_field_invalid',
      'wholesale-feed webhook notification_id must match event.event_id.',
      { field: 'notification_id', expected: eventId, actual: notificationId }
    );
  }

  const eventType = readNotificationType(readRequiredString(event, 'event.event_type'), 'event.event_type');
  if (notificationType !== eventType) {
    throw new WholesaleFeedWebhookNotificationError(
      'wholesale_feed_webhook_notification_type_mismatch',
      'wholesale-feed webhook notification_type must match event.event_type.',
      { field: 'notification_type', expected: eventType, actual: notificationType }
    );
  }

  const entityType = readEntityType(readRequiredString(event, 'event.entity_type'), 'event.entity_type');
  assertEntityTypeMatchesNotification(notificationType, entityType);
  const entityId = readRequiredString(event, 'event.entity_id');
  const eventCreatedAt = readRequiredString(event, 'event.created_at');
  const payload = readRecord(event.payload, 'event.payload');

  const payloadScope = readRequiredPayloadScope(payload);
  if (payloadScope !== cacheScope) {
    throw new WholesaleFeedWebhookNotificationError(
      'wholesale_feed_webhook_cache_scope_mismatch',
      'wholesale-feed webhook cache_scope must match event.payload.applies_to.scope.',
      { field: 'cache_scope', expected: payloadScope, actual: cacheScope }
    );
  }

  const affectedEntityType = validatePayloadForEvent(notificationType, entityId, payload);

  return {
    idempotencyKey,
    notificationId,
    notificationType,
    accountId,
    subscriberId,
    firedAt,
    wholesaleFeedVersion,
    ...(previousWholesaleFeedVersion !== undefined && { previousWholesaleFeedVersion }),
    cacheScope,
    eventId,
    eventType,
    entityType,
    entityId,
    eventCreatedAt,
    ...(affectedEntityType !== undefined && { affectedEntityType }),
    event: event as V31Beta.WholesaleFeedEvent,
    webhook: webhook as V31Beta.WholesaleFeedWebhook,
  };
}

export const normalizeWholesaleFeedWebhookNotification = parseWholesaleFeedWebhookNotification;

function parseInput(input: unknown): unknown {
  if (typeof input === 'string') return parseJson(input);
  if (input instanceof Uint8Array) return parseJson(new TextDecoder().decode(input));
  return input;
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new WholesaleFeedWebhookNotificationError(
      'wholesale_feed_webhook_body_malformed',
      'wholesale-feed webhook body must be valid JSON.',
      { field: '$', actual: err instanceof Error ? err.message : String(err) }
    );
  }
}

function readRecord(value: unknown, field: string): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  throw new WholesaleFeedWebhookNotificationError(
    field === '$' ? 'wholesale_feed_webhook_body_malformed' : 'wholesale_feed_webhook_field_invalid',
    field === '$'
      ? 'wholesale-feed webhook body must be a JSON object.'
      : `wholesale-feed webhook field ${field} must be an object.`,
    { field, expected: 'object', actual: describeValue(value) }
  );
}

function readRequiredRecord(obj: Record<string, unknown>, field: string): Record<string, unknown> {
  const key = field.includes('.') ? field.slice(field.lastIndexOf('.') + 1) : field;
  const value = obj[key];
  if (value === undefined) {
    throw new WholesaleFeedWebhookNotificationError(
      'wholesale_feed_webhook_field_missing',
      `wholesale-feed webhook field ${field} must be an object.`,
      { field, expected: 'object', actual: describeValue(value) }
    );
  }
  return readRecord(value, field);
}

function readRequiredString(obj: Record<string, unknown>, field: string): string {
  const key = field.includes('.') ? field.slice(field.lastIndexOf('.') + 1) : field;
  const value = obj[key];
  if (typeof value === 'string' && value.length > 0) return value;
  throw new WholesaleFeedWebhookNotificationError(
    value === undefined ? 'wholesale_feed_webhook_field_missing' : 'wholesale_feed_webhook_field_invalid',
    `wholesale-feed webhook field ${field} must be a non-empty string.`,
    { field, expected: 'non-empty string', actual: describeValue(value) }
  );
}

function readRequiredNonEmptyArray(obj: Record<string, unknown>, field: string): unknown[] {
  const key = field.includes('.') ? field.slice(field.lastIndexOf('.') + 1) : field;
  const value = obj[key];
  if (Array.isArray(value) && value.length > 0) return value;
  throw new WholesaleFeedWebhookNotificationError(
    value === undefined ? 'wholesale_feed_webhook_field_missing' : 'wholesale_feed_webhook_field_invalid',
    `wholesale-feed webhook field ${field} must be a non-empty array.`,
    { field, expected: 'non-empty array', actual: describeValue(value) }
  );
}

function readRequiredPositiveInteger(obj: Record<string, unknown>, field: string): number {
  const key = field.includes('.') ? field.slice(field.lastIndexOf('.') + 1) : field;
  const value = obj[key];
  if (Number.isInteger(value) && (value as number) > 0) return value as number;
  throw new WholesaleFeedWebhookNotificationError(
    value === undefined ? 'wholesale_feed_webhook_field_missing' : 'wholesale_feed_webhook_field_invalid',
    `wholesale-feed webhook field ${field} must be a positive integer.`,
    { field, expected: 'positive integer', actual: describeValue(value) }
  );
}

function readOptionalString(obj: Record<string, unknown>, field: string): string | undefined {
  const value = obj[field];
  if (value === undefined) return undefined;
  if (typeof value === 'string' && value.length > 0) return value;
  throw new WholesaleFeedWebhookNotificationError(
    'wholesale_feed_webhook_field_invalid',
    `wholesale-feed webhook field ${field} must be a non-empty string when present.`,
    { field, expected: 'non-empty string', actual: describeValue(value) }
  );
}

function readNotificationType(value: string, field: string): WholesaleFeedWebhookNotificationType {
  if (WHOLESALE_FEED_NOTIFICATION_TYPES.has(value as WholesaleFeedWebhookNotificationType)) {
    return value as WholesaleFeedWebhookNotificationType;
  }
  throw new WholesaleFeedWebhookNotificationError(
    'wholesale_feed_webhook_field_invalid',
    `wholesale-feed webhook field ${field} is not a supported wholesale-feed notification type.`,
    { field, expected: [...WHOLESALE_FEED_NOTIFICATION_TYPES], actual: value }
  );
}

function readCacheScope(value: string, field: string): WholesaleFeedWebhookCacheScope {
  if (value === 'public' || value === 'account') return value;
  throw new WholesaleFeedWebhookNotificationError(
    'wholesale_feed_webhook_field_invalid',
    `wholesale-feed webhook field ${field} must be "public" or "account".`,
    { field, expected: ['public', 'account'], actual: value }
  );
}

function readEntityType(value: string, field: string): NormalizedWholesaleFeedWebhookNotification['entityType'] {
  if (value === 'product' || value === 'signal' || value === 'feed') return value;
  throw new WholesaleFeedWebhookNotificationError(
    'wholesale_feed_webhook_field_invalid',
    `wholesale-feed webhook field ${field} must be "product", "signal", or "feed".`,
    { field, expected: ['product', 'signal', 'feed'], actual: value }
  );
}

function assertEntityTypeMatchesNotification(
  notificationType: WholesaleFeedWebhookNotificationType,
  entityType: NormalizedWholesaleFeedWebhookNotification['entityType']
): void {
  const expected = notificationType.startsWith('product.')
    ? 'product'
    : notificationType.startsWith('signal.')
      ? 'signal'
      : 'feed';

  if (entityType !== expected) {
    throw new WholesaleFeedWebhookNotificationError(
      'wholesale_feed_webhook_entity_type_mismatch',
      'wholesale-feed webhook event.entity_type does not match event.event_type.',
      { field: 'event.entity_type', expected, actual: entityType }
    );
  }
}

function validatePayloadForEvent(
  notificationType: WholesaleFeedWebhookNotificationType,
  entityId: string,
  payload: Record<string, unknown>
): WholesaleFeedWebhookAffectedEntityType | undefined {
  switch (notificationType) {
    case 'product.created':
    case 'product.updated': {
      assertEntityIdMatchesPayload(entityId, readRequiredString(payload, 'event.payload.product_id'), 'product_id');
      readRequiredRecord(payload, 'event.payload.product');
      return undefined;
    }
    case 'product.priced': {
      assertEntityIdMatchesPayload(entityId, readRequiredString(payload, 'event.payload.product_id'), 'product_id');
      readRequiredNonEmptyArray(payload, 'event.payload.pricing_options');
      return undefined;
    }
    case 'product.removed': {
      assertEntityIdMatchesPayload(entityId, readRequiredString(payload, 'event.payload.product_id'), 'product_id');
      return undefined;
    }
    case 'signal.created':
    case 'signal.updated': {
      assertEntityIdMatchesPayload(
        entityId,
        readRequiredString(payload, 'event.payload.signal_agent_segment_id'),
        'signal_agent_segment_id'
      );
      readRequiredRecord(payload, 'event.payload.signal');
      return undefined;
    }
    case 'signal.priced': {
      assertEntityIdMatchesPayload(
        entityId,
        readRequiredString(payload, 'event.payload.signal_agent_segment_id'),
        'signal_agent_segment_id'
      );
      readRequiredNonEmptyArray(payload, 'event.payload.pricing_options');
      return undefined;
    }
    case 'signal.removed': {
      assertEntityIdMatchesPayload(
        entityId,
        readRequiredString(payload, 'event.payload.signal_agent_segment_id'),
        'signal_agent_segment_id'
      );
      return undefined;
    }
    case 'wholesale_feed.bulk_change':
      readRequiredString(payload, 'event.payload.summary');
      readRequiredPositiveInteger(payload, 'event.payload.affected_count');
      return readBulkChangeAffectedEntityType(payload);
  }
}

function assertEntityIdMatchesPayload(entityId: string, payloadEntityId: string, payloadField: string): void {
  if (entityId === payloadEntityId) return;
  throw new WholesaleFeedWebhookNotificationError(
    'wholesale_feed_webhook_field_invalid',
    `wholesale-feed webhook event.entity_id must match event.payload.${payloadField}.`,
    { field: 'event.entity_id', expected: payloadEntityId, actual: entityId }
  );
}

function readRequiredPayloadScope(payload: Record<string, unknown>): WholesaleFeedWebhookCacheScope {
  const appliesToRecord = readRequiredRecord(payload, 'event.payload.applies_to');
  return readCacheScope(
    readRequiredString(appliesToRecord, 'event.payload.applies_to.scope'),
    'event.payload.applies_to.scope'
  );
}

function readBulkChangeAffectedEntityType(payload: Record<string, unknown>): WholesaleFeedWebhookAffectedEntityType {
  const affected = payload.affected_entity_type;
  if (affected === 'product' || affected === 'signal') return affected;
  throw new WholesaleFeedWebhookNotificationError(
    'wholesale_feed_webhook_bulk_change_invalid',
    'wholesale_feed.bulk_change payload requires affected_entity_type of "product" or "signal".',
    { field: 'event.payload.affected_entity_type', expected: ['product', 'signal'], actual: describeValue(affected) }
  );
}

function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}
