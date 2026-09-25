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
    };
    await activity.checkpointDeliveryAttempt({ ...base, attempt });
    await activity.checkpointDeliveryAttempt({ ...base, attempt });
    await assert.rejects(
      () => activity.checkpointDeliveryAttempt({ ...base, attempt: { ...attempt, payload_size_bytes: 101 } }),
      /already bound to different facts/
    );
  });

  test('composes the delivery freeze checkpoint before the activity reservation', async () => {
    const reporting = require('../../dist/lib/reporting/index.js');
    const calls = [];
    const composed = reporting.composeNotificationDeliveryAttemptCheckpoints(
      async () => calls.push('recipient-frozen'),
      async () => calls.push('activity-reserved')
    );
    await composed({});
    assert.deepEqual(calls, ['recipient-frozen', 'activity-reserved']);
  });

  test('projects only requested, principal-scoped activity onto already-visible accounts', async () => {
    const reporting = require('../../dist/lib/reporting/index.js');
    const source = {
      status: 'completed',
      accounts: [{ account_id: 'account-1', name: 'Visible', webhook_activity: [{ url: 'ADOPTER_SECRET' }] }],
      pagination: { has_more: false },
    };
    let reads = 0;
    const reader = {
      async listActivity(input) {
        reads += 1;
        return activity.listActivity(input);
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
    assert.equal(included.pagination.has_more, false);
  });
});
