'use strict';

// Only SDK delivery/signing/recovery code builds requests. The owned receiver
// is reached through a fixture route; the signed HTTPS target stays unchanged.
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const path = require('node:path');
const { setTimeout: sleep } = require('node:timers/promises');
const { createFixture } = require('./managed-seller.cjs');

async function main() {
  const [installation, phase, mode = 'standalone'] = process.argv.slice(2);
  assert.ok(['emit', 'recover'].includes(phase));
  assert.ok(['standalone', 'activity'].includes(mode));
  const req = createRequire(path.join(installation, 'package.json'));
  const server = req('@adcp/sdk/server');
  const ledger = req('@adcp/sdk/reporting/ledger');
  const reporting = req('@adcp/sdk');
  const { Pool } = req('pg');
  const input = JSON.parse(
    await new Promise(resolve => {
      let body = '';
      process.stdin
        .setEncoding('utf8')
        .on('data', chunk => (body += chunk))
        .on('end', () => resolve(body));
    })
  );
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const namespace = 'reverse-reporting-activity';
    const recipientCheckpoint =
      mode === 'activity'
        ? ledger.createPostgresReportingNotificationAttemptCheckpoint({ db: pool, namespace })
        : undefined;
    const webhookActivity =
      mode === 'activity' ? reporting.createPostgresReportingWebhookActivityV1({ db: pool, namespace }) : undefined;
    const checkpoint = recipientCheckpoint
      ? Object.assign(
          reporting.composeNotificationDeliveryAttemptCheckpoints(
            recipientCheckpoint,
            webhookActivity.checkpointDeliveryAttempt
          ),
          { activityStore: recipientCheckpoint.activityStore }
        )
      : undefined;
    const runtime = server.createPostgresPersistentNotificationRuntime({
      db: pool,
      publisherScope: 'reverse-notification-seller',
      subscriptions: { acknowledgeIsolatedDatabase: true },
      supportedAccountEventTypes: ['reporting.ledger_changed'],
      proofAdapter: { prove: async () => ({ proved: true }) },
      validateDestination: async ({ url }) => ({ allowed: url === input.target }),
      authorizeDelivery: async () => ({ authorized: true }),
      checkpointDeliveryAttempt: checkpoint,
      webhooks: {
        deliveries: { acknowledgeIsolatedDatabase: true },
        outbox: { acknowledgeIsolatedDatabase: true },
        signerKey: input.signer,
        retries: { maxAttempts: 1, initialDelayMs: 0, maxDelayMs: 0, jitter: 0 },
        ...webhookActivity?.emitterObservers,
        fetch: async (url, init) => {
          assert.equal(url, input.target);
          if (webhookActivity) {
            const pending = await webhookActivity.listActivity({
              tenantId: 'seller-test',
              principalId: 'buyer-test',
              accountId: 'reporting_core_lab',
            });
            assert.equal(pending[0].status, 'pending');
            assert.equal(pending[0].completed_at, null);
            assert.equal(pending[0].attempt, phase === 'emit' ? 1 : 2);
            const recipients = await pool.query(
              'SELECT attempt_at, settled_at FROM adcp_reporting_notification_activity_recipients'
            );
            assert.equal(recipients.rows.length, 1);
            assert.ok(recipients.rows[0].attempt_at);
            assert.equal(recipients.rows[0].settled_at, null);
          }
          return fetch(input.route, { ...init, redirect: 'error' });
        },
      },
    });
    const activity =
      mode === 'activity'
        ? ledger.createPostgresReportingNotificationActivityRuntime({
            db: pool,
            namespace,
            notifications: runtime,
            attemptCheckpoint: checkpoint,
            tenantScopeForAccount: accountId => {
              assert.equal(accountId, 'reporting_core_lab');
              return 'seller-test';
            },
          })
        : undefined;
    if (phase === 'emit') for (const migration of runtime.migrations.all) await pool.query(migration);
    if (activity) {
      if (phase === 'emit') for (const migration of activity.migrations.all) await pool.query(migration);
      if (phase === 'emit') for (const migration of webhookActivity.migrations.all) await pool.query(migration);
      await activity.probe();
      await webhookActivity.probe();
    }
    await runtime.probe();
    const scope = {
      kind: 'account',
      tenantId: 'seller-test',
      principalId: 'buyer-test',
      accountId: activity ? 'reporting_core_lab' : 'account-test',
    };
    if (phase === 'emit') {
      const subscription = await runtime.replace(scope, [
        {
          subscriber_id: 'python-buyer',
          url: input.target,
          event_types: ['reporting.ledger_changed'],
        },
      ]);
      assert.equal(subscription.outcome, 'applied');
      if (activity) {
        const sdk = req('@adcp/sdk');
        const fixture = await createFixture({ ledger, jcs: { canonicalize: sdk.canonicalize } }, pool, {
          mode: 'billing',
          notificationActivityPort: activity.port,
        });
        await fixture.controller('reliable_reporting_reconciled_billing_probe', 'prepare');
        const committed = await pool.query('SELECT revision_id FROM adcp_reporting_revisions');
        assert.deepEqual(committed.rows, [{ revision_id: 'revision-august-official' }]);
        const pending = await activity.listNotificationActivity({
          tenantId: scope.tenantId,
          accountId: scope.accountId,
        });
        assert.equal(pending.activities.length, 1);
        assert.equal(pending.activities[0].notificationType, 'reporting.ledger_changed');
        assert.equal(pending.activities[0].notificationProjectedAt, undefined);
        const projected = await activity.recoverOnce({
          ownerToken: 'first-activity-worker',
          limit: 1,
          retryAfterMs: 1000,
        });
        assert.equal(projected.retried, 1);
        assert.equal(projected.projected, 0);
        const recipients = await pool.query(
          'SELECT attempt_at, settled_at FROM adcp_reporting_notification_activity_recipients'
        );
        assert.equal(recipients.rows.length, 1);
        assert.ok(recipients.rows[0].attempt_at);
        assert.equal(recipients.rows[0].settled_at, null);
        const attempts = await webhookActivity.listActivity({
          tenantId: scope.tenantId,
          principalId: scope.principalId,
          accountId: scope.accountId,
        });
        assert.equal(attempts.length, 1);
        assert.equal(attempts[0].status, 'failed');
        assert.equal(attempts[0].http_status_code, 503);
        assert.equal(attempts[0].attempt, 1);
        console.log(
          JSON.stringify({
            status: 'passed',
            phase,
            generation: subscription.generation,
            committed_revision: committed.rows[0].revision_id,
            activity: projected,
            recipient_attempt_checkpointed: true,
            webhook_attempts: attempts,
          })
        );
        return;
      }
      const result = await runtime.emit({
        emissionId: 'reverse-emission-v1',
        notificationId: 'revision-test',
        notificationType: 'reporting.ledger_changed',
        anchor: 'account',
        tenantId: scope.tenantId,
        principalId: scope.principalId,
        accountId: scope.accountId,
        payload: {
          fired_at: new Date().toISOString(),
          account_id: scope.accountId,
          change_kind: 'revision_published',
          reporting_revision_id: 'revision-test',
          finality: 'official',
        },
      });
      assert.equal(result.deliveries.length, 1);
      assert.equal(result.deliveries[0].result.delivered, false);
      console.log(JSON.stringify({ status: 'passed', phase, generation: subscription.generation }));
    } else {
      const subscription = await runtime.read(scope);
      assert.equal(subscription.notificationConfigs.length, 1);
      if (activity) {
        const deadline = performance.now() + 5000;
        let projected;
        do {
          projected = await activity.recoverOnce({ ownerToken: 'fresh-activity-worker', limit: 1 });
          if (projected.claimed === 0) await sleep(50);
        } while (projected.claimed === 0 && performance.now() < deadline);
        assert.equal(projected.claimed, 1);
        assert.equal(projected.projected, 1);
        assert.equal(projected.retried, 0);
        const page = await activity.listNotificationActivity({ tenantId: scope.tenantId, accountId: scope.accountId });
        assert.equal(page.activities.length, 1);
        assert.ok(page.activities[0].notificationProjectedAt);
        await assert.rejects(
          activity.listNotificationActivity({ tenantId: 'other-tenant', accountId: scope.accountId }),
          /scope does not match/
        );
        const drained = await activity.recoverOnce({ ownerToken: 'fresh-activity-worker', limit: 1 });
        assert.equal(drained.claimed, 0);
        const recipients = await pool.query(
          'SELECT attempt_at, settled_at, disposition FROM adcp_reporting_notification_activity_recipients'
        );
        assert.ok(recipients.rows[0].attempt_at && recipients.rows[0].settled_at);
        assert.equal(recipients.rows[0].disposition, 'delivered');
        const attempts = await webhookActivity.listActivity({
          tenantId: scope.tenantId,
          principalId: scope.principalId,
          accountId: scope.accountId,
        });
        assert.deepEqual(
          attempts.map(value => [value.attempt, value.status, value.http_status_code]),
          [
            [2, 'success', 204],
            [1, 'failed', 503],
          ]
        );
        assert.equal(attempts[0].idempotency_key, attempts[1].idempotency_key);
        assert.equal(attempts[0].notification_id, attempts[1].notification_id);
        assert.ok(attempts.every(value => value.completed_at && !('payload' in value) && !('headers' in value)));
        const privatePrincipal = await webhookActivity.listActivity({
          tenantId: scope.tenantId,
          principalId: 'other-principal',
          accountId: scope.accountId,
        });
        assert.deepEqual(privatePrincipal, []);
        const projectedAccounts = await reporting.projectListAccountsReportingWebhookActivityV1({
          request: { include_webhook_activity: true, webhook_activity_limit: 10 },
          response: { accounts: [{ account_id: scope.accountId }] },
          tenantId: scope.tenantId,
          principalId: scope.principalId,
          activity: webhookActivity,
        });
        assert.deepEqual(projectedAccounts.accounts[0].webhook_activity, attempts);
        console.log(
          JSON.stringify({
            status: 'passed',
            phase,
            generation: subscription.generation,
            activity: projected,
            drained,
            tenant_isolation: true,
            recipient_settled: true,
            webhook_attempts: attempts,
            principal_isolation: true,
            list_accounts_projection_helper: true,
          })
        );
        return;
      }
      const recovered = await runtime.recoverOnce({ ownerToken: 'fresh-process-worker', leaseMs: 5000 });
      assert.deepEqual(recovered, { claimed: 1, settled: 1, released: 0 });
      const drained = await runtime.recoverOnce({ ownerToken: 'fresh-process-worker', leaseMs: 5000 });
      assert.deepEqual(drained, { claimed: 0, settled: 0, released: 0 });
      console.log(JSON.stringify({ status: 'passed', phase, generation: subscription.generation, recovered, drained }));
    }
  } finally {
    await pool.end();
  }
}

main().catch(error => {
  console.error(JSON.stringify({ status: 'failed', error_type: error.name, code: error.code }));
  process.exitCode = 1;
});
