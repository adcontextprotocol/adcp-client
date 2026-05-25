const { test, describe } = require('node:test');
const assert = require('node:assert');

const {
  normalizeWholesaleFeedWebhookNotification,
  parseWholesaleFeedWebhookNotification,
  WholesaleFeedWebhookNotificationError,
} = require('../../dist/lib/wholesale-feed-sync/index.js');

function makeNotification(overrides = {}) {
  const event = overrides.event ?? {
    event_id: 'evt_01HZNX6R4R6ZJ65TP8W4D2H4WQ',
    event_type: 'wholesale_feed.bulk_change',
    entity_type: 'feed',
    entity_id: 'bulk-2026-q3',
    created_at: '2026-05-25T12:00:00Z',
    payload: {
      summary: 'Q3 refresh',
      affected_count: 12,
      affected_entity_type: 'product',
      applies_to: { scope: 'account', account_ids: ['acc_acme'] },
    },
  };

  return {
    idempotency_key: 'delivery-01HZNX6T5H0R3GX7X7R54PKNPS',
    notification_id: event.event_id,
    notification_type: event.event_type,
    fired_at: '2026-05-25T12:00:03Z',
    subscriber_id: 'storefront-catalog',
    account_id: 'acc_acme',
    wholesale_feed_version: 'wf-v2',
    previous_wholesale_feed_version: 'wf-v1',
    cache_scope: 'account',
    event,
    ...overrides,
  };
}

describe('wholesale-feed webhook notification normalizer', () => {
  test('is exported from the root, webhooks, and wholesale-feed-sync entrypoints', () => {
    const root = require('../../dist/lib/index.js');
    const webhooks = require('../../dist/lib/webhooks/index.js');

    assert.strictEqual(root.parseWholesaleFeedWebhookNotification, parseWholesaleFeedWebhookNotification);
    assert.strictEqual(root.normalizeWholesaleFeedWebhookNotification, normalizeWholesaleFeedWebhookNotification);
    assert.strictEqual(root.WholesaleFeedWebhookNotificationError, WholesaleFeedWebhookNotificationError);
    assert.strictEqual(webhooks.parseWholesaleFeedWebhookNotification, parseWholesaleFeedWebhookNotification);
    assert.strictEqual(webhooks.normalizeWholesaleFeedWebhookNotification, normalizeWholesaleFeedWebhookNotification);
    assert.strictEqual(webhooks.WholesaleFeedWebhookNotificationError, WholesaleFeedWebhookNotificationError);
  });

  test('normalizes canonical deliveries with distinct delivery and event identifiers', () => {
    const normalized = parseWholesaleFeedWebhookNotification(makeNotification());

    assert.strictEqual(normalized.idempotencyKey, 'delivery-01HZNX6T5H0R3GX7X7R54PKNPS');
    assert.strictEqual(normalized.notificationId, 'evt_01HZNX6R4R6ZJ65TP8W4D2H4WQ');
    assert.strictEqual(normalized.notificationType, 'wholesale_feed.bulk_change');
    assert.strictEqual(normalized.accountId, 'acc_acme');
    assert.strictEqual(normalized.eventId, 'evt_01HZNX6R4R6ZJ65TP8W4D2H4WQ');
    assert.strictEqual(normalized.affectedEntityType, 'product');
    assert.notStrictEqual(normalized.idempotencyKey, normalized.eventId);
    assert.strictEqual(normalized.notificationId, normalized.eventId);
  });

  test('accepts raw JSON strings and exposes the same normalized shape through the alias', () => {
    const raw = JSON.stringify(makeNotification());
    const normalized = normalizeWholesaleFeedWebhookNotification(raw);

    assert.strictEqual(normalized.subscriberId, 'storefront-catalog');
    assert.strictEqual(normalized.cacheScope, 'account');
    assert.strictEqual(normalized.previousWholesaleFeedVersion, 'wf-v1');
  });

  test('accepts raw JSON bytes', () => {
    const raw = Buffer.from(JSON.stringify(makeNotification()), 'utf8');
    const normalized = parseWholesaleFeedWebhookNotification(raw);

    assert.strictEqual(normalized.idempotencyKey, 'delivery-01HZNX6T5H0R3GX7X7R54PKNPS');
    assert.strictEqual(normalized.eventId, 'evt_01HZNX6R4R6ZJ65TP8W4D2H4WQ');
  });

  test('throws typed errors when notification_id does not match event.event_id', () => {
    assert.throws(
      () => parseWholesaleFeedWebhookNotification(makeNotification({ notification_id: 'different-notification-id' })),
      err => {
        assert.ok(err instanceof WholesaleFeedWebhookNotificationError);
        assert.strictEqual(err.code, 'wholesale_feed_webhook_field_invalid');
        assert.strictEqual(err.field, 'notification_id');
        return true;
      }
    );
  });

  test('throws typed errors for notification type mismatches', () => {
    assert.throws(
      () =>
        parseWholesaleFeedWebhookNotification(
          makeNotification({
            notification_type: 'product.updated',
          })
        ),
      err => {
        assert.ok(err instanceof WholesaleFeedWebhookNotificationError);
        assert.strictEqual(err.code, 'wholesale_feed_webhook_notification_type_mismatch');
        assert.strictEqual(err.field, 'notification_type');
        return true;
      }
    );
  });

  test('throws typed errors when bulk_change omits affected_entity_type', () => {
    const notification = makeNotification({
      event: {
        ...makeNotification().event,
        payload: {
          summary: 'Q3 refresh',
          affected_count: 12,
          applies_to: { scope: 'account', account_ids: ['acc_acme'] },
        },
      },
    });

    assert.throws(
      () => parseWholesaleFeedWebhookNotification(notification),
      err => {
        assert.ok(err instanceof WholesaleFeedWebhookNotificationError);
        assert.strictEqual(err.code, 'wholesale_feed_webhook_bulk_change_invalid');
        assert.strictEqual(err.field, 'event.payload.affected_entity_type');
        return true;
      }
    );
  });

  test('throws typed errors when a branch payload omits applies_to', () => {
    const notification = makeNotification({
      event: {
        event_id: 'evt_product_update',
        event_type: 'product.updated',
        entity_type: 'product',
        entity_id: 'prod_ctv',
        created_at: '2026-05-25T12:00:00Z',
        payload: {
          product_id: 'prod_ctv',
          product: {},
        },
      },
    });

    assert.throws(
      () => parseWholesaleFeedWebhookNotification(notification),
      err => {
        assert.ok(err instanceof WholesaleFeedWebhookNotificationError);
        assert.strictEqual(err.code, 'wholesale_feed_webhook_field_missing');
        assert.strictEqual(err.field, 'event.payload.applies_to');
        return true;
      }
    );
  });

  test('throws typed errors when entity_id does not match the branch payload identifier', () => {
    const notification = makeNotification({
      event: {
        event_id: 'evt_product_update',
        event_type: 'product.updated',
        entity_type: 'product',
        entity_id: 'prod_ctv_old',
        created_at: '2026-05-25T12:00:00Z',
        payload: {
          product_id: 'prod_ctv_new',
          product: {},
          applies_to: { scope: 'account', account_ids: ['acc_acme'] },
        },
      },
    });

    assert.throws(
      () => parseWholesaleFeedWebhookNotification(notification),
      err => {
        assert.ok(err instanceof WholesaleFeedWebhookNotificationError);
        assert.strictEqual(err.code, 'wholesale_feed_webhook_field_invalid');
        assert.strictEqual(err.field, 'event.entity_id');
        return true;
      }
    );
  });

  test('throws typed errors when envelope cache_scope contradicts payload scope', () => {
    assert.throws(
      () => parseWholesaleFeedWebhookNotification(makeNotification({ cache_scope: 'public' })),
      err => {
        assert.ok(err instanceof WholesaleFeedWebhookNotificationError);
        assert.strictEqual(err.code, 'wholesale_feed_webhook_cache_scope_mismatch');
        assert.strictEqual(err.field, 'cache_scope');
        return true;
      }
    );
  });
});
