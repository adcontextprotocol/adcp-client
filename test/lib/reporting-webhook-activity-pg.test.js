const assert = require('node:assert/strict');
const { after, before, describe, test } = require('node:test');

const DATABASE_URL = process.env.REPORTING_LEDGER_PG_URL;

describe('Postgres reporting webhook activity', { skip: !DATABASE_URL && 'PostgreSQL URL not set' }, () => {
  const schema = `adcp_reporting_webhook_activity_${process.pid}`;
  let bootstrap;
  let pool;
  let activity;

  before(async () => {
    const { Pool } = require('pg');
    const reporting = require('../../dist/lib/reporting/index.js');
    bootstrap = new Pool({ connectionString: DATABASE_URL });
    await bootstrap.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ connectionString: DATABASE_URL, options: `-c search_path="${schema}"` });
    activity = reporting.createPostgresReportingWebhookActivityV1({
      db: pool,
      namespace: 'reporting-production-v1',
    });
    await pool.query(activity.migrations.activity);
    await pool.query(activity.migrations.activity);
  });

  after(async () => {
    if (pool) await pool.end();
    if (bootstrap) {
      await bootstrap.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await bootstrap.end();
    }
  });

  test('reserves before delivery, sanitizes URLs, completes, and scopes by principal', async () => {
    await activity.probe();
    const context = {
      kind: 'adcp_notification_subscription',
      version: 1,
      scope: { kind: 'account', tenantId: 'tenant-1', principalId: 'buyer-1', accountId: 'account-1' },
      eventAnchor: 'account',
      accountId: 'account-1',
      subscriberId: 'buyer-primary',
      destinationGeneration: 'destination-generation-1',
      eventType: 'reporting.ledger_changed',
      notificationId: 'revision-1',
    };
    const attempt = {
      delivery_id: 'delivery-1',
      idempotency_key: 'idempotency-key-0001',
      attempt: 1,
      url: 'https://buyer.example/webhooks/v1/super-secret-token?bearer=secret#fragment',
      payload_size_bytes: 321,
      attemptAuthorizationContext: context,
    };
    await activity.checkpointDeliveryAttempt({
      scope: context.scope,
      eventAnchor: 'account',
      accountId: context.accountId,
      subscriberId: context.subscriberId,
      destinationGeneration: context.destinationGeneration,
      eventType: context.eventType,
      notificationId: context.notificationId,
      attempt,
      signal: new AbortController().signal,
    });

    const pending = await activity.listActivity({
      tenantId: 'tenant-1',
      principalId: 'buyer-1',
      accountId: 'account-1',
    });
    assert.equal(pending.length, 1);
    assert.deepEqual(pending[0], {
      idempotency_key: 'idempotency-key-0001',
      notification_id: 'revision-1',
      subscriber_id: 'buyer-primary',
      fired_at: pending[0].fired_at,
      completed_at: null,
      notification_type: 'reporting.ledger_changed',
      attempt: 1,
      status: 'pending',
      url: 'https://buyer.example/webhooks/v1/redacted',
      http_status_code: null,
      response_time_ms: null,
      payload_size_bytes: 321,
      error_message: null,
    });
    assert.deepEqual(
      await activity.listActivity({ tenantId: 'tenant-1', principalId: 'buyer-2', accountId: 'account-1' }),
      []
    );

    await activity.emitterObservers.onAttemptResult({
      ...attempt,
      status: 503,
      durationMs: 47,
      error: 'HTTP 503 response body containing a secret that must not be retained',
      willRetry: true,
    });
    const completed = await activity.listActivity({
      tenantId: 'tenant-1',
      principalId: 'buyer-1',
      accountId: 'account-1',
    });
    assert.equal(completed[0].status, 'failed');
    assert.equal(completed[0].http_status_code, 503);
    assert.equal(completed[0].response_time_ms, 47);
    assert.equal(completed[0].error_message, 'HTTP non-success response');

    const storage = await pool.query(
      'SELECT tenant_key, principal_key, url, error_message FROM adcp_reporting_webhook_attempts'
    );
    const encoded = JSON.stringify(storage.rows);
    assert.doesNotMatch(encoded, /tenant-1|buyer-1|super-secret-token|bearer=secret|response body/);
  });

  test('keeps one immutable reservation per transport attempt', async () => {
    const base = {
      scope: { kind: 'caller', tenantId: 'tenant-2', principalId: 'buyer-2' },
      eventAnchor: 'account',
      accountId: 'account-2',
      subscriberId: 'audit-bus',
      destinationGeneration: 'destination-generation-2',
      eventType: 'reporting.status_changed',
      notificationId: 'transition-2',
      signal: new AbortController().signal,
    };
    const attempt = {
      delivery_id: 'delivery-2',
      idempotency_key: 'idempotency-key-0002',
      attempt: 1,
      url: 'https://buyer.example/reporting/callback',
      payload_size_bytes: 100,
      attemptAuthorizationContext: {
        kind: 'adcp_notification_subscription',
        version: 1,
        scope: base.scope,
        accountId: base.accountId,
        subscriberId: base.subscriberId,
        eventType: base.eventType,
        notificationId: base.notificationId,
      },
    };
    const firstOrdinal = await activity.checkpointDeliveryAttempt({ ...base, attempt });
    assert.equal(firstOrdinal, 1);
    const secondOrdinal = await activity.checkpointDeliveryAttempt({ ...base, attempt });
    assert.equal(secondOrdinal, 2);

    const concurrent = { ...attempt, delivery_id: 'delivery-concurrent', idempotency_key: 'idempotency-concurrent' };
    const ordinals = await Promise.all(
      Array.from({ length: 16 }, () => activity.checkpointDeliveryAttempt({ ...base, attempt: concurrent }))
    );
    assert.deepEqual(
      ordinals.sort((left, right) => left - right),
      Array.from({ length: 16 }, (_value, index) => index + 1),
      'concurrent replicas receive distinct dense ordinals'
    );
  });

  test('fails loudly when an attempt result has no durable reservation', async () => {
    await assert.rejects(
      () =>
        activity.emitterObservers.onAttemptResult({
          delivery_id: 'missing-delivery',
          idempotency_key: 'missing-idempotency-key',
          attempt: 1,
          url: 'https://buyer.example/webhooks',
          payload_size_bytes: 42,
          durationMs: 10,
          status: 204,
          willRetry: false,
          attemptAuthorizationContext: {
            kind: 'adcp_notification_subscription',
            version: 1,
            scope: { kind: 'caller', tenantId: 'tenant-missing', principalId: 'principal-missing' },
            accountId: 'account-missing',
            subscriberId: 'subscriber-missing',
            eventType: 'reporting.status_changed',
            notificationId: 'notification-missing',
          },
        }),
      /no matching durable reservation/
    );
  });

  test('passes caller-anchored non-reporting notifications without requiring an account ID', async () => {
    await activity.checkpointDeliveryAttempt({
      scope: { kind: 'caller', tenantId: 'tenant-caller', principalId: 'principal-caller' },
      eventAnchor: 'caller',
      subscriberId: 'caller-subscriber',
      destinationGeneration: 'caller-generation',
      eventType: 'capabilities.changed',
      notificationId: 'caller-notification',
      attempt: {
        delivery_id: 'caller-delivery',
        idempotency_key: 'caller-idempotency-key',
        attempt: 1,
        url: 'https://buyer.example/webhooks',
        payload_size_bytes: 42,
      },
      signal: new AbortController().signal,
    });
    const stored = await pool.query(
      `SELECT count(*)::integer AS count FROM adcp_reporting_webhook_attempts
        WHERE notification_id = 'caller-notification'`
    );
    assert.equal(stored.rows[0].count, 0);
  });

  test('prunes orphaned reservations after preserving their truthful pending window', async () => {
    const base = {
      scope: { kind: 'caller', tenantId: 'tenant-orphan', principalId: 'buyer-orphan' },
      eventAnchor: 'account',
      accountId: 'account-orphan',
      subscriberId: 'orphan-audit',
      destinationGeneration: 'destination-generation-orphan',
      eventType: 'reporting.delivery_ready',
      notificationId: 'delivery-orphan',
      signal: new AbortController().signal,
    };
    await activity.checkpointDeliveryAttempt({
      ...base,
      attempt: {
        delivery_id: 'delivery-orphan',
        idempotency_key: 'idempotency-key-orphan-0001',
        attempt: 1,
        url: 'https://buyer.example/reporting/callback',
        payload_size_bytes: 100,
      },
    });
    await pool.query(
      `UPDATE adcp_reporting_webhook_attempts
          SET fired_at = clock_timestamp() - INTERVAL '31 days'
        WHERE account_id = 'account-orphan'`
    );
    await pool.query(
      `UPDATE adcp_reporting_webhook_attempts_ordinals
          SET changed_at = clock_timestamp() - INTERVAL '31 days'
        WHERE account_id = 'account-orphan'`
    );
    await activity.pruneCompleted({ limit: 10 });
    const rows = await activity.listActivity({
      tenantId: 'tenant-orphan',
      principalId: 'buyer-orphan',
      accountId: 'account-orphan',
    });
    assert.equal(rows.length, 0);
    const ordinals = await pool.query(
      `SELECT count(*)::integer AS count FROM adcp_reporting_webhook_attempts_ordinals
        WHERE account_id = 'account-orphan'`
    );
    assert.equal(ordinals.rows[0].count, 0);
  });

  test('composes checkpoints in caller order', async () => {
    const reporting = require('../../dist/lib/reporting/index.js');
    const calls = [];
    const composed = reporting.composeNotificationDeliveryAttemptCheckpoints(
      async () => {
        calls.push('recipient-frozen');
      },
      async () => {
        calls.push('activity-reserved');
      }
    );
    await composed({});
    assert.deepEqual(calls, ['recipient-frozen', 'activity-reserved']);
  });

  test('projects only requested, principal-scoped activity onto already-visible accounts', async () => {
    const reporting = require('../../dist/lib/reporting/index.js');
    const source = {
      status: 'completed',
      accounts: [
        { account_id: 'account-1', name: 'Visible', webhook_activity: [{ url: 'ADOPTER_SECRET' }] },
        { account_id: 'account-2', name: 'Also visible' },
      ],
      pagination: { has_more: false },
    };
    let reads = 0;
    const reader = {
      async listActivity() {
        throw new Error('projection should use the bounded batch reader');
      },
      async listActivityBatch(input) {
        reads += 1;
        return activity.listActivityBatch(input);
      },
    };
    const omitted = await reporting.projectListAccountsReportingWebhookActivityV1({
      response: source,
      request: { include_webhook_activity: false },
      tenantId: 'tenant-1',
      principalId: 'buyer-1',
      activity: reader,
    });
    assert.equal('webhook_activity' in omitted.accounts[0], false);
    assert.equal(reads, 0);
    assert.equal(source.accounts[0].webhook_activity[0].url, 'ADOPTER_SECRET', 'the adopter response is not mutated');

    const included = await reporting.projectListAccountsReportingWebhookActivityV1({
      response: source,
      request: { include_webhook_activity: true, webhook_activity_limit: 1 },
      tenantId: 'tenant-1',
      principalId: 'buyer-1',
      activity: reader,
    });
    assert.equal(reads, 1);
    assert.equal(included.accounts[0].webhook_activity.length, 1);
    assert.equal(included.accounts[0].webhook_activity[0].idempotency_key, 'idempotency-key-0001');
    assert.deepEqual(included.accounts[1].webhook_activity, []);
    assert.equal(included.pagination.has_more, false);

    const [stored] = await activity.listActivity({
      tenantId: 'tenant-1',
      principalId: 'buyer-1',
      accountId: 'account-1',
    });
    const withNonReportingActivity = await reporting.projectListAccountsReportingWebhookActivityV1({
      response: {
        accounts: [
          {
            account_id: 'account-1',
            webhook_activity: [
              {
                ...stored,
                idempotency_key: 'account-event-0001',
                notification_type: 'account.change_recorded',
                url: 'https://buyer.example/private/token?secret=1',
              },
            ],
          },
        ],
      },
      request: { include_webhook_activity: true, webhook_activity_limit: 2 },
      tenantId: 'tenant-1',
      principalId: 'buyer-1',
      activity: reader,
    });
    assert.deepEqual(
      withNonReportingActivity.accounts[0].webhook_activity.map(record => record.notification_type),
      ['reporting.ledger_changed', 'account.change_recorded']
    );
    assert.equal(
      withNonReportingActivity.accounts[0].webhook_activity[1].url,
      'https://buyer.example/redacted/redacted'
    );
  });
});
