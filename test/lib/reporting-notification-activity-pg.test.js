/**
 * PostgreSQL crash-boundary tests for transactional reporting notifications.
 *
 * NODE_ENV=test REPORTING_LEDGER_PG_URL=postgres://localhost/test \
 *   node --test test/lib/reporting-notification-activity-pg.test.js
 */
const assert = require('node:assert/strict');
const { generateKeyPairSync } = require('node:crypto');
const { after, before, describe, test } = require('node:test');

const DATABASE_URL = process.env.REPORTING_LEDGER_PG_URL;

describe('transactional reporting notification activity', { skip: !DATABASE_URL && 'PostgreSQL URL not set' }, () => {
  const schema = `adcp_reporting_activity_${process.pid}`;
  let bootstrap;
  let pool;
  let ledger;
  let server;
  let notifications;
  let activity;
  let store;
  let fetchCalls;
  let validateStatusWebhook;
  // Fail-once injection points for the operational suppression paths.
  let authorizeDeliveryHook;
  let resolveCredentialHook;

  /** Minimal write-only credential binding store for the legacy Bearer path. */
  function credentialAdapter() {
    const bindings = new Map();
    let sequence = 0;
    return {
      preview: ({ credential, previousBindingId }) =>
        previousBindingId && bindings.get(previousBindingId) === credential
          ? { outcome: 'unchanged' }
          : { outcome: 'changed' },
      stage: ({ credential, previousBindingId }) => {
        if (previousBindingId && bindings.get(previousBindingId) === credential) {
          return { outcome: 'unchanged', bindingId: previousBindingId };
        }
        sequence += 1;
        const bindingId = `binding-${sequence}`;
        bindings.set(bindingId, credential);
        return { outcome: 'staged', bindingId, stageId: `stage-${sequence}` };
      },
      commit: () => {},
      discard: ({ bindingId }) => {
        bindings.delete(bindingId);
      },
      resolve: input => {
        if (resolveCredentialHook) return resolveCredentialHook(input);
        const token = bindings.get(input.bindingId);
        return { type: 'bearer', token: token ?? 'fallback-bearer-token' };
      },
    };
  }

  before(async () => {
    const { Pool } = require('pg');
    ledger = require('../../dist/lib/reporting/ledger/index.js');
    server = require('../../dist/lib/server/index.js');
    validateStatusWebhook = require('../../dist/lib/validation/schema-loader.js').getSchemaValidatorByRef(
      'core/reporting-status-changed-webhook.json'
    );
    bootstrap = new Pool({ connectionString: DATABASE_URL });
    await bootstrap.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ connectionString: DATABASE_URL, options: `-c search_path="${schema}"` });
    fetchCalls = [];
    notifications = server.createPostgresPersistentNotificationRuntime({
      db: pool,
      publisherScope: 'reporting-activity-tests',
      webhooks: {
        signerKey: signerKey(),
        fetch: async (url, init) => {
          const body = JSON.parse(init.body);
          assert.equal(validateStatusWebhook(body), true, JSON.stringify(validateStatusWebhook.errors));
          fetchCalls.push({ url, body });
          return { status: 204, headers: { get: () => undefined } };
        },
        retries: { maxAttempts: 1, initialDelayMs: 0, maxDelayMs: 0, jitter: 0 },
        sleep: async () => {},
      },
      proofAdapter: { prove: async () => ({ proved: true }) },
      validateDestination: async () => ({ allowed: true }),
      authorizeDelivery: async input => (authorizeDeliveryHook ?? (() => ({ authorized: true })))(input),
      credentialAdapter: credentialAdapter(),
      subscriptions: { acknowledgeIsolatedDatabase: true },
    });
    activity = ledger.createPostgresReportingNotificationActivityRuntime({
      db: pool,
      notifications,
      namespace: 'reporting-activity-tests',
      tenantScopeForAccount: accountId => (accountId === 'account-b' ? 'tenant-b' : 'tenant-a'),
    });
    await pool.query(ledger.REPORTING_LEDGER_MIGRATION);
    for (const migration of notifications.migrations.all) await pool.query(migration);
    for (const migration of activity.migrations.all) await pool.query(migration);
    store = new ledger.PostgresReportingLedgerStore(pool, {
      acknowledgeIsolatedDatabase: true,
      notificationActivityPort: activity.port,
    });
    await installSubscription('tenant-a', 'principal-a', 'account-a', 'https://buyer.example/a');
    await installSubscription('tenant-b', 'principal-b', 'account-b', 'https://buyer.example/b');
  });

  after(async () => {
    if (pool) await pool.end();
    if (bootstrap) {
      await bootstrap.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await bootstrap.end();
    }
  });

  test('rolls transition, activity, and outbox intent back together before commit', async () => {
    const obligation = await putObligation('rollback', 'account-a');
    const failingStore = new ledger.PostgresReportingLedgerStore(pool, {
      acknowledgeIsolatedDatabase: true,
      notificationActivityPort: {
        async recordTransition(input, transaction) {
          await activity.port.recordTransition(input, transaction);
          throw new Error('crash before commit');
        },
      },
    });
    await assert.rejects(
      () =>
        ledger.reconcileReportingStatusLifecycleV1({
          store: failingStore,
          reporting_obligation_id: obligation.reporting_obligation_id,
          ledgerAsOf: '2026-09-02T01:30:00.000Z',
        }),
      error => error.cause?.message === 'crash before commit'
    );
    assert.deepEqual(await store.listTransitions(obligation.reporting_obligation_id), []);
    assert.equal((await activity.listActivity({ tenantId: 'tenant-a', accountId: 'account-a' })).activities.length, 0);
  });

  test('recovers after commit and keeps stable retry identity after an ambiguous worker crash', async () => {
    const obligation = await putObligation('crash', 'account-a');
    const transition = await ledger.reconcileReportingStatusLifecycleV1({
      store,
      reporting_obligation_id: obligation.reporting_obligation_id,
      ledgerAsOf: '2026-09-02T01:30:00.000Z',
    });
    assert.ok(transition);
    assert.equal(fetchCalls.length, 0, 'ledger commit performs no network I/O');

    const page = await activity.listActivity({ tenantId: 'tenant-a', accountId: 'account-a' });
    const record = page.activities.find(value => value.transitionId === transition.transitionId);
    assert.ok(record);
    assert.equal(record.notificationProjectedAt, undefined);
    assert.deepEqual(
      [record.previousHealth, record.health, record.previousFinality, record.finality],
      ['waiting', 'delayed', 'none', 'none']
    );
    assert.equal(JSON.stringify(record).includes('buyer.example'), false);
    assert.equal(JSON.stringify(record).includes('route-crash'), false);

    let crashOnce = true;
    const crashRuntime = ledger.createPostgresReportingNotificationActivityRuntime({
      db: pool,
      namespace: 'reporting-activity-tests',
      tenantScopeForAccount: () => 'tenant-a',
      notifications: {
        async emit(event) {
          const result = await notifications.emit(event);
          if (crashOnce) {
            crashOnce = false;
            throw new Error('crash after webhook checkpoint');
          }
          return result;
        },
      },
    });
    const projectionErrors = [];
    const first = await crashRuntime.recoverOnce({
      ownerToken: 'activity-worker-one',
      retryAfterMs: 60_000,
      onError: async (error, claim) => {
        projectionErrors.push({ error, claim });
        throw new Error('observer failure is isolated');
      },
    });
    assert.equal(first.retried, 1);
    assert.equal(projectionErrors.length, 1);
    assert.equal(projectionErrors[0].claim.transitionId, transition.transitionId);
    assert.equal(fetchCalls.filter(value => value.body.notification_id === transition.transitionId).length, 1);
    await pool.query(
      `UPDATE adcp_reporting_notification_activity SET next_attempt_at = clock_timestamp()
        WHERE namespace = $1 AND transition_id = $2`,
      ['reporting-activity-tests', transition.transitionId]
    );
    const second = await crashRuntime.recoverOnce({ ownerToken: 'activity-worker-two' });
    assert.equal(second.projected, 1);
    const replayedCalls = fetchCalls.filter(value => value.body.notification_id === transition.transitionId);
    assert.equal(replayedCalls.length, 2, 'ambiguous delivery is allowed to repeat at least once');
    assert.equal(
      replayedCalls[0].body.idempotency_key,
      replayedCalls[1].body.idempotency_key,
      'stable emission identity reuses the existing webhook delivery binding and retry identity'
    );
  });

  test('fences concurrent workers and isolates account activity across tenants', async () => {
    const [obligationA, obligationB] = await Promise.all([
      putObligation('concurrent-a', 'account-a'),
      putObligation('concurrent-b', 'account-b'),
    ]);
    const [transitionA, transitionB] = await Promise.all([
      ledger.reconcileReportingStatusLifecycleV1({
        store,
        reporting_obligation_id: obligationA.reporting_obligation_id,
        ledgerAsOf: '2026-09-02T01:30:00.000Z',
      }),
      ledger.reconcileReportingStatusLifecycleV1({
        store,
        reporting_obligation_id: obligationB.reporting_obligation_id,
        ledgerAsOf: '2026-09-02T01:30:00.000Z',
      }),
    ]);
    assert.ok(transitionA && transitionB);
    const [workerOne, workerTwo] = await Promise.all([
      activity.recoverOnce({ ownerToken: 'concurrent-worker-one', limit: 10 }),
      activity.recoverOnce({ ownerToken: 'concurrent-worker-two', limit: 10 }),
    ]);
    assert.equal(workerOne.projected + workerTwo.projected, 2);
    assert.equal(fetchCalls.filter(value => value.body.notification_id === transitionA.transitionId).length, 1);
    assert.equal(fetchCalls.filter(value => value.body.notification_id === transitionB.transitionId).length, 1);

    const tenantA = await activity.listActivity({ tenantId: 'tenant-a', accountId: 'account-a', limit: 1 });
    assert.equal(
      tenantA.activities.every(value => value.accountId === 'account-a' && value.tenantId === 'tenant-a'),
      true
    );
    assert.equal(tenantA.hasMore, true);
    const tenantANext = await activity.listActivity({
      tenantId: 'tenant-a',
      accountId: 'account-a',
      cursor: tenantA.nextCursor,
      limit: 1,
    });
    assert.notEqual(tenantANext.activities[0]?.activityId, tenantA.activities[0]?.activityId);
    await assert.rejects(
      () => activity.listActivity({ tenantId: 'tenant-b', accountId: 'account-b', cursor: tenantA.nextCursor }),
      /cursor is invalid for the authenticated scope/
    );
    await assert.rejects(
      () => activity.listActivity({ tenantId: 'tenant-b', accountId: 'account-a' }),
      /scope does not match the trusted account directory/
    );
    const oversizedCursor = `ract1.${Buffer.from(
      JSON.stringify({
        namespace: 'reporting-activity-tests',
        tenantId: 'tenant-a',
        accountId: 'account-a',
        before: '9223372036854775808',
      })
    ).toString('base64url')}`;
    await assert.rejects(
      () => activity.listActivity({ tenantId: 'tenant-a', accountId: 'account-a', cursor: oversizedCursor }),
      /cursor is invalid/
    );
    await assert.rejects(
      () => activity.listActivity({ tenantId: 'tenant-a', accountId: 'account-a', cursor: 'x'.repeat(2_049) }),
      /cursor is invalid/
    );
    const tenantB = await activity.listActivity({ tenantId: 'tenant-b', accountId: 'account-b' });
    assert.equal(
      tenantB.activities.some(value => value.transitionId === transitionA.transitionId),
      false
    );
    assert.equal(
      tenantB.activities.some(value => value.transitionId === transitionB.transitionId),
      true
    );
  });

  test('resolves replacement and revocation through the existing subscription runtime', async () => {
    const replacementObligation = await putObligation('replacement', 'account-a');
    const replacementTransition = await ledger.reconcileReportingStatusLifecycleV1({
      store,
      reporting_obligation_id: replacementObligation.reporting_obligation_id,
      ledgerAsOf: '2026-09-02T01:30:00.000Z',
    });
    let current = await notifications.read({
      kind: 'account',
      tenantId: 'tenant-a',
      principalId: 'principal-a',
      accountId: 'account-a',
    });
    await notifications.replace(
      { kind: 'account', tenantId: 'tenant-a', principalId: 'principal-a', accountId: 'account-a' },
      [
        {
          subscriber_id: 'account-a-subscriber',
          url: 'https://buyer.example/replacement',
          event_types: ['reporting.status_changed'],
        },
      ],
      { expectedGeneration: current.generation }
    );
    const replaced = await activity.recoverOnce({ ownerToken: 'replacement-worker' });
    assert.equal(replaced.projected, 1);
    assert.deepEqual(
      fetchCalls
        .filter(value => value.body.notification_id === replacementTransition.transitionId)
        .map(value => value.url),
      ['https://buyer.example/replacement']
    );

    const revokedObligation = await putObligation('revoked', 'account-a');
    const revokedTransition = await ledger.reconcileReportingStatusLifecycleV1({
      store,
      reporting_obligation_id: revokedObligation.reporting_obligation_id,
      ledgerAsOf: '2026-09-02T01:30:00.000Z',
    });
    current = await notifications.read({
      kind: 'account',
      tenantId: 'tenant-a',
      principalId: 'principal-a',
      accountId: 'account-a',
    });
    await notifications.replace(
      { kind: 'account', tenantId: 'tenant-a', principalId: 'principal-a', accountId: 'account-a' },
      [],
      { expectedGeneration: current.generation }
    );
    const recovered = await activity.recoverOnce({ ownerToken: 'revocation-worker' });
    assert.equal(recovered.projected, 1);
    assert.equal(fetchCalls.filter(value => value.body.notification_id === revokedTransition.transitionId).length, 0);
  });

  test('keeps finality-only transitions in account activity without inventing a health webhook', async () => {
    const obligation = await putObligation('finality-only', 'account-a');
    const transition = {
      transitionId: 'rst_finality_only',
      reporting_obligation_id: obligation.reporting_obligation_id,
      previousHealth: 'waiting',
      health: 'waiting',
      previousFinality: 'none',
      finality: 'snapshot',
      issueIds: [],
      occurredAt: '2026-09-02T02:00:00.000Z',
    };
    assert.deepEqual(await store.appendTransition(transition), { inserted: true });
    const page = await activity.listActivity({ tenantId: 'tenant-a', accountId: 'account-a' });
    const record = page.activities.find(value => value.transitionId === transition.transitionId);
    assert.ok(record?.notificationProjectedAt);
    assert.equal(record.notificationType, undefined);
    const before = fetchCalls.length;
    assert.deepEqual(await activity.recoverOnce({ ownerToken: 'finality-only-worker' }), {
      claimed: 0,
      matched: 0,
      projected: 0,
      retried: 0,
      leaseLost: 0,
    });
    assert.equal(fetchCalls.length, before);
  });

  test('replays the committed recipient set so a replacement cannot add a second delivery', async () => {
    // Send succeeds, the worker crashes before settlement, and the buyer then
    // replaces its destination. The retry must replay the recipient set that was
    // committed before the first send, not re-enumerate and address the
    // replacement generation — that would deliver the same notification twice
    // under two different idempotency keys.
    const scope = {
      kind: 'account',
      tenantId: 'tenant-a',
      principalId: 'principal-freeze',
      accountId: 'account-freeze',
    };
    await installSubscription(scope.tenantId, scope.principalId, scope.accountId, 'https://buyer.example/frozen-g1');
    const obligation = await putObligation('recipient-freeze', 'account-freeze');
    const transition = await ledger.reconcileReportingStatusLifecycleV1({
      store,
      reporting_obligation_id: obligation.reporting_obligation_id,
      ledgerAsOf: '2026-09-02T01:30:00.000Z',
    });
    assert.ok(transition);
    const delivered = () => fetchCalls.filter(value => value.body.notification_id === transition.transitionId);

    const crashRuntime = ledger.createPostgresReportingNotificationActivityRuntime({
      db: pool,
      namespace: 'reporting-activity-tests',
      tenantScopeForAccount: accountId => (accountId === 'account-b' ? 'tenant-b' : 'tenant-a'),
      notifications: {
        async emit(event) {
          await notifications.emit(event);
          throw new Error('crash after send, before settlement');
        },
      },
    });
    const firstPass = await crashRuntime.recoverOnce({ ownerToken: 'recipient-freeze-worker-one' });
    assert.equal(firstPass.retried, 1, 'the ambiguous claim is released for retry');
    assert.equal(delivered().length, 1, 'the first generation was addressed once');
    assert.deepEqual(
      delivered().map(value => value.url),
      ['https://buyer.example/frozen-g1']
    );
    const committed = await readIntent(transition.transitionId);
    assert.equal(committed.state, 'pending');
    assert.ok(committed.delivery_intent_at, 'the recipient set is committed before the send');
    assert.ok(committed.delivery_attempt_at, 'the attempt is recorded before the POST, so the set is now immutable');
    assert.equal(committed.delivery_intent_round, 1);
    assert.equal(committed.recipients.length, 1);
    const firstGeneration = committed.recipients[0].destinationGeneration;
    assert.equal(committed.recipients[0].subscriberId, 'account-freeze-subscriber');

    // The buyer replaces its destination while the retry is still outstanding.
    const current = await notifications.read(scope);
    await notifications.replace(
      scope,
      [
        {
          subscriber_id: 'account-freeze-subscriber',
          url: 'https://buyer.example/frozen-g2',
          event_types: ['reporting.status_changed'],
        },
      ],
      { expectedGeneration: current.generation }
    );
    const replaced = await notifications.read(scope);
    assert.notEqual(replaced.generation, current.generation, 'the replacement is a new subscription generation');

    await pool.query(
      `UPDATE adcp_reporting_notification_activity SET next_attempt_at = clock_timestamp()
        WHERE namespace = $1 AND transition_id = $2`,
      ['reporting-activity-tests', transition.transitionId]
    );
    const recovered = await activity.recoverOnce({ ownerToken: 'recipient-freeze-worker-two' });
    assert.equal(recovered.projected, 1, 'the claim settles exactly once');
    assert.equal(recovered.matched, 0, 'the committed generation is gone, so nothing is addressed again');

    assert.equal(delivered().length, 1, 'no duplicate logical delivery');
    assert.equal(
      delivered().some(value => value.url === 'https://buyer.example/frozen-g2'),
      false,
      'the replacement generation is never addressed for an already-sent notification'
    );
    assert.equal(
      new Set(delivered().map(value => value.body.idempotency_key)).size,
      1,
      'no new idempotency key is minted for the same notification'
    );

    const settled = await readIntent(transition.transitionId);
    assert.equal(settled.state, 'projected');
    assert.equal(settled.delivery_intent_round, 1, 'no new intent round is opened after an attempt');
    assert.deepEqual(
      settled.recipients.map(value => value.destinationGeneration),
      [firstGeneration],
      'the committed recipient set is immutable across replay'
    );
    assert.equal(
      settled.delivery_intent_at.toISOString(),
      committed.delivery_intent_at.toISOString(),
      'the intent is committed once, by the first writer'
    );
    assert.equal(
      settled.delivery_attempt_at.toISOString(),
      committed.delivery_attempt_at.toISOString(),
      'the attempt marker is written once'
    );

    // Exactly-once activity survives the whole sequence.
    const page = await activity.listActivity({ tenantId: 'tenant-a', accountId: 'account-freeze' });
    assert.equal(page.activities.filter(value => value.transitionId === transition.transitionId).length, 1);
    assert.equal(JSON.stringify(page.activities).includes('buyer.example'), false);
    assert.equal(JSON.stringify(page.activities).includes('destinationGeneration'), false);
    assert.deepEqual(await activity.recoverOnce({ ownerToken: 'recipient-freeze-worker-three' }), {
      claimed: 0,
      matched: 0,
      projected: 0,
      retried: 0,
      leaseLost: 0,
    });
    assert.equal(delivered().length, 1);
  });

  test('without the freeze barrier the same replay delivers twice under two idempotency keys', async () => {
    // The hazard the barrier removes, demonstrated against the same PostgreSQL
    // runtime. The only difference from the test above is a notification runtime
    // that drops `freezeRecipients` and therefore re-enumerates subscriptions on
    // every attempt — exactly what a custom runtime does by default.
    const scope = {
      kind: 'account',
      tenantId: 'tenant-a',
      principalId: 'principal-unfrozen',
      accountId: 'account-unfrozen',
    };
    await installSubscription(scope.tenantId, scope.principalId, scope.accountId, 'https://buyer.example/unfrozen-g1');
    const obligation = await putObligation('recipient-unfrozen', 'account-unfrozen');
    const transition = await ledger.reconcileReportingStatusLifecycleV1({
      store,
      reporting_obligation_id: obligation.reporting_obligation_id,
      ledgerAsOf: '2026-09-02T01:30:00.000Z',
    });
    assert.ok(transition);
    const delivered = () => fetchCalls.filter(value => value.body.notification_id === transition.transitionId);

    const unfrozen = notify => ({
      db: pool,
      namespace: 'reporting-activity-tests',
      tenantScopeForAccount: accountId => (accountId === 'account-b' ? 'tenant-b' : 'tenant-a'),
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      notifications: { emit: ({ freezeRecipients, beforeExternalAttempt, ...event }) => notify(event) },
    });
    const crashing = ledger.createPostgresReportingNotificationActivityRuntime(
      unfrozen(async event => {
        await notifications.emit(event);
        throw new Error('crash after send, before settlement');
      })
    );
    assert.equal((await crashing.recoverOnce({ ownerToken: 'unfrozen-worker-one' })).retried, 1);
    assert.equal(delivered().length, 1);

    const current = await notifications.read(scope);
    await notifications.replace(
      scope,
      [
        {
          subscriber_id: 'account-unfrozen-subscriber',
          url: 'https://buyer.example/unfrozen-g2',
          event_types: ['reporting.status_changed'],
        },
      ],
      { expectedGeneration: current.generation }
    );
    await pool.query(
      `UPDATE adcp_reporting_notification_activity SET next_attempt_at = clock_timestamp()
        WHERE namespace = $1 AND transition_id = $2`,
      ['reporting-activity-tests', transition.transitionId]
    );
    const replaying = ledger.createPostgresReportingNotificationActivityRuntime(
      unfrozen(event => notifications.emit(event))
    );
    assert.equal((await replaying.recoverOnce({ ownerToken: 'unfrozen-worker-two' })).projected, 1);

    assert.deepEqual(
      delivered().map(value => value.url),
      ['https://buyer.example/unfrozen-g1', 'https://buyer.example/unfrozen-g2'],
      're-enumeration addresses the replacement generation for an already-sent notification'
    );
    assert.equal(
      new Set(delivered().map(value => value.body.idempotency_key)).size,
      2,
      'the second delivery carries a new idempotency key, so the buyer cannot dedupe it'
    );
  });

  test('retries operational delivery-authority failures instead of recording them as delivered', async () => {
    // Live delivery authority fails closed before any external POST. A store
    // read, an authorization callback and a credential resolution can all fail
    // transiently, and none of them says the subscriber should not receive the
    // event — so none may settle the activity as delivered.
    for (const scenario of [
      {
        suffix: 'auth',
        reason: 'authorization_error',
        bearer: false,
        arm: () => {
          authorizeDeliveryHook = () => {
            authorizeDeliveryHook = undefined;
            throw new Error('authorization backend unavailable');
          };
        },
      },
      {
        suffix: 'credential',
        reason: 'credential_unavailable',
        bearer: true,
        arm: () => {
          resolveCredentialHook = () => {
            resolveCredentialHook = undefined;
            throw new Error('credential vault unavailable');
          };
        },
      },
    ]) {
      const accountId = `account-authfail-${scenario.suffix}`;
      await installSubscription(
        'tenant-a',
        `principal-authfail-${scenario.suffix}`,
        accountId,
        `https://buyer.example/authfail-${scenario.suffix}`,
        scenario.bearer
          ? { authentication: { schemes: ['Bearer'], credentials: 'registration-bearer-token-with-sufficient-length' } }
          : {}
      );
      const isolated = isolatedActivity(`authfail-${scenario.suffix}`);
      const obligation = await putObligation(`authfail-${scenario.suffix}`, accountId, isolated.store);
      const transition = await ledger.reconcileReportingStatusLifecycleV1({
        store: isolated.store,
        reporting_obligation_id: obligation.reporting_obligation_id,
        ledgerAsOf: '2026-09-02T01:30:00.000Z',
      });
      assert.ok(transition);
      const delivered = () => fetchCalls.filter(value => value.body.notification_id === transition.transitionId);

      scenario.arm();
      const suppressed = [];
      const failedPass = await isolated.activity.recoverOnce({
        ownerToken: `authfail-${scenario.suffix}-worker-one`,
        limit: 1,
        retryAfterMs: 1,
        onError: error => suppressed.push(error),
      });
      assert.equal(failedPass.projected, 0, `${scenario.reason}: nothing is projected`);
      assert.equal(failedPass.retried, 1, `${scenario.reason}: the claim is released for retry`);
      assert.equal(delivered().length, 0, `${scenario.reason}: nothing was sent`);
      assert.equal(
        suppressed.some(error => error?.name === 'ReportingNotificationRetryableSuppressionError'),
        true,
        `${scenario.reason}: the operational suppression is surfaced, not swallowed`
      );
      assert.equal(suppressed.at(-1).reason, scenario.reason);
      const held = await readIntent(transition.transitionId, isolated.namespace);
      assert.equal(held.state, 'pending', `${scenario.reason}: the activity is not settled as delivered`);
      assert.equal(held.delivery_attempt_at, null, 'no external attempt was recorded');

      // The transient failure clears and the notification is delivered once.
      await makeClaimEligible(isolated.namespace, transition.transitionId);
      const recovered = await isolated.activity.recoverOnce({
        ownerToken: `authfail-${scenario.suffix}-worker-two`,
        limit: 1,
      });
      assert.equal(recovered.projected, 1);
      assert.equal(delivered().length, 1, `${scenario.reason}: delivered exactly once after recovery`);
      assert.equal((await readIntent(transition.transitionId, isolated.namespace)).state, 'projected');
      assert.deepEqual(
        await isolated.activity.recoverOnce({ ownerToken: `authfail-${scenario.suffix}-worker-three` }),
        {
          claimed: 0,
          matched: 0,
          projected: 0,
          retried: 0,
          leaseLost: 0,
        }
      );
      assert.equal(delivered().length, 1, `${scenario.reason}: the replay adds no delivery`);
    }
  });

  test('retries a subscription-store read failure raised after candidate enumeration', async () => {
    // The authorizer re-reads the subscription store immediately before the
    // POST. Hiding the real table between enumeration and that read makes the
    // real store throw, which must be retried rather than settled.
    const accountId = 'account-storefail';
    await installSubscription('tenant-a', 'principal-storefail', accountId, 'https://buyer.example/storefail');
    const recovery = isolatedActivity('storefail');
    const obligation = await putObligation('storefail', accountId, recovery.store);
    const transition = await ledger.reconcileReportingStatusLifecycleV1({
      store: recovery.store,
      reporting_obligation_id: obligation.reporting_obligation_id,
      ledgerAsOf: '2026-09-02T01:30:00.000Z',
    });
    assert.ok(transition);
    const delivered = () => fetchCalls.filter(value => value.body.notification_id === transition.transitionId);

    let hidden = false;
    const storeFailureRuntime = ledger.createPostgresReportingNotificationActivityRuntime({
      db: pool,
      namespace: recovery.namespace,
      tenantScopeForAccount: () => 'tenant-a',
      notifications: {
        emit: event =>
          notifications.emit({
            ...event,
            freezeRecipients: async candidates => {
              const frozen = await event.freezeRecipients(candidates);
              await pool.query('ALTER TABLE adcp_notification_subscriptions RENAME TO adcp_notification_hidden');
              hidden = true;
              return frozen;
            },
          }),
      },
    });
    const errors = [];
    try {
      const failedPass = await storeFailureRuntime.recoverOnce({
        ownerToken: 'storefail-worker-one',
        limit: 1,
        retryAfterMs: 1,
        onError: error => errors.push(error),
      });
      assert.equal(failedPass.projected, 0);
      assert.equal(failedPass.retried, 1);
    } finally {
      if (hidden) await pool.query('ALTER TABLE adcp_notification_hidden RENAME TO adcp_notification_subscriptions');
    }
    assert.equal(delivered().length, 0, 'nothing was sent while the store was unreadable');
    assert.equal(errors.length, 1);
    assert.equal(errors[0].name, 'ReportingNotificationRetryableSuppressionError');
    assert.equal(errors[0].reason, 'authorization_error');
    const held = await readIntent(transition.transitionId, recovery.namespace);
    assert.equal(held.state, 'pending');
    assert.equal(held.delivery_attempt_at, null);

    await makeClaimEligible(recovery.namespace, transition.transitionId);
    const recovered = await recovery.activity.recoverOnce({ ownerToken: 'storefail-worker-two', limit: 1 });
    assert.equal(recovered.projected, 1);
    assert.equal(delivered().length, 1, 'delivered exactly once once the store is readable again');
    assert.deepEqual(
      delivered().map(value => value.url),
      ['https://buyer.example/storefail']
    );
  });

  test('re-resolves a frozen recipient set that goes stale before any external attempt', async () => {
    // The straddle: candidates are enumerated, the buyer replaces its
    // destination, and only then is the set frozen. Nothing has been sent, so
    // the frozen generation must not strand the notification — and the
    // replacement must receive exactly one delivery, with the original
    // generation receiving none.
    const scope = {
      kind: 'account',
      tenantId: 'tenant-a',
      principalId: 'principal-straddle',
      accountId: 'account-straddle',
    };
    await installSubscription(scope.tenantId, scope.principalId, scope.accountId, 'https://buyer.example/straddle-g1');
    const recovery = isolatedActivity('straddle');
    const obligation = await putObligation('recipient-straddle', 'account-straddle', recovery.store);
    const transition = await ledger.reconcileReportingStatusLifecycleV1({
      store: recovery.store,
      reporting_obligation_id: obligation.reporting_obligation_id,
      ledgerAsOf: '2026-09-02T01:30:00.000Z',
    });
    assert.ok(transition);
    const delivered = () => fetchCalls.filter(value => value.body.notification_id === transition.transitionId);

    // Deterministic straddle: replace the destination inside the freeze
    // barrier, after enumeration resolved the old generation.
    let straddled = false;
    const straddleRuntime = ledger.createPostgresReportingNotificationActivityRuntime({
      db: pool,
      namespace: recovery.namespace,
      tenantScopeForAccount: () => 'tenant-a',
      notifications: {
        emit: event =>
          notifications.emit({
            ...event,
            freezeRecipients: async candidates => {
              const frozen = await event.freezeRecipients(candidates);
              if (!straddled) {
                straddled = true;
                const current = await notifications.read(scope);
                await notifications.replace(
                  scope,
                  [
                    {
                      subscriber_id: 'account-straddle-subscriber',
                      url: 'https://buyer.example/straddle-g2',
                      event_types: ['reporting.status_changed'],
                    },
                  ],
                  { expectedGeneration: current.generation }
                );
              }
              return frozen;
            },
          }),
      },
    });
    const errors = [];
    const straddledPass = await straddleRuntime.recoverOnce({
      ownerToken: 'straddle-worker-one',
      limit: 1,
      retryAfterMs: 1,
      onError: error => errors.push(error),
    });
    assert.equal(straddledPass.projected, 0, 'a stale frozen generation is not settled as delivered');
    assert.equal(straddledPass.retried, 1);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].reason, 'subscription_stale', 'the stale generation is a retryable suppression');
    assert.equal(delivered().length, 0, 'nothing was sent to the superseded generation');
    const straddledIntent = await readIntent(transition.transitionId, recovery.namespace);
    assert.equal(straddledIntent.delivery_intent_round, 1);
    assert.equal(straddledIntent.delivery_attempt_at, null, 'no attempt occurred, so the set stays revisable');

    // The next pass re-resolves to the replacement generation and delivers once.
    await makeClaimEligible(recovery.namespace, transition.transitionId);
    const recovered = await recovery.activity.recoverOnce({ ownerToken: 'straddle-worker-two', limit: 1 });
    assert.equal(recovered.projected, 1);
    assert.deepEqual(
      delivered().map(value => value.url),
      ['https://buyer.example/straddle-g2'],
      'exactly one delivery, to the replacement generation'
    );
    const resolvedIntent = await readIntent(transition.transitionId, recovery.namespace);
    assert.equal(resolvedIntent.delivery_intent_round, 2, 'a fresh round was committed before the attempt');
    assert.ok(resolvedIntent.delivery_attempt_at, 'the attempt marker now freezes the set');
    assert.deepEqual(
      resolvedIntent.recipients.map(value => value.subscriberId),
      ['account-straddle-subscriber']
    );
    const g2Generation = resolvedIntent.recipients[0].destinationGeneration;

    // Crash replay after the attempt adds no generation and no delivery.
    await pool.query(
      `UPDATE adcp_reporting_notification_activity
          SET state = 'pending', projected_at = NULL, retain_until = NULL, next_attempt_at = clock_timestamp()
        WHERE namespace = $1 AND transition_id = $2`,
      [recovery.namespace, transition.transitionId]
    );
    const replayed = await recovery.activity.recoverOnce({ ownerToken: 'straddle-worker-three', limit: 1 });
    assert.equal(replayed.projected, 1);
    // An ambiguous replay is allowed to repeat the POST, but only to the same
    // generation and under the same idempotency key the receiver dedupes on.
    assert.deepEqual(
      [...new Set(delivered().map(value => value.url))],
      ['https://buyer.example/straddle-g2'],
      'the replay adds no generation'
    );
    assert.equal(
      new Set(delivered().map(value => value.body.idempotency_key)).size,
      1,
      'and mints no new idempotency key'
    );
    const afterReplay = await readIntent(transition.transitionId, recovery.namespace);
    assert.equal(afterReplay.delivery_intent_round, 2, 'the committed round is immutable after an attempt');
    assert.deepEqual(
      afterReplay.recipients.map(value => value.destinationGeneration),
      [g2Generation]
    );
  });

  test('keeps a revoked subscription undelivered even while the intent is still revisable', async () => {
    // Revocation safety: a revisable intent must not become a licence to deliver
    // to something the buyer removed.
    const scope = {
      kind: 'account',
      tenantId: 'tenant-a',
      principalId: 'principal-revoke-straddle',
      accountId: 'account-revoke-straddle',
    };
    await installSubscription(scope.tenantId, scope.principalId, scope.accountId, 'https://buyer.example/revoke-s');
    const recovery = isolatedActivity('revoke-straddle');
    const obligation = await putObligation('recipient-revoke-straddle', 'account-revoke-straddle', recovery.store);
    const transition = await ledger.reconcileReportingStatusLifecycleV1({
      store: recovery.store,
      reporting_obligation_id: obligation.reporting_obligation_id,
      ledgerAsOf: '2026-09-02T01:30:00.000Z',
    });
    assert.ok(transition);
    const current = await notifications.read(scope);
    await notifications.replace(scope, [], { expectedGeneration: current.generation });

    const recovered = await recovery.activity.recoverOnce({ ownerToken: 'revoke-straddle-worker', limit: 1 });
    assert.equal(recovered.projected, 1, 'the activity settles rather than retrying forever');
    assert.equal(recovered.matched, 0);
    assert.equal(fetchCalls.filter(value => value.body.notification_id === transition.transitionId).length, 0);
    const intent = await readIntent(transition.transitionId, recovery.namespace);
    assert.equal(intent.state, 'projected');
    assert.deepEqual(intent.recipients, [], 'an empty recipient set is committed, not an unbounded retry');
  });

  test('commits a maximum-length recipient intent at the default and configured fanout ceilings', async () => {
    // A serialized single-document intent needed a size cap, and a fanout that
    // legitimately exceeded it could never commit — it would suppress, release,
    // and retry until it aged out. The relational representation has no such
    // cap: only the bounded fingerprint is indexed. Both the runtime's default
    // maxFanoutCandidates (1,000) and its documented ceiling (10,000) are
    // exercised with maximum-length recipient references.
    const longSubscriberId = `s-${'x'.repeat(220)}`;
    for (const scenario of [
      { suffix: 'fanout-default', recipients: 1_000 },
      { suffix: 'fanout-ceiling', recipients: 10_000 },
    ]) {
      const recovery = isolatedActivity(scenario.suffix);
      const obligation = await putObligation(scenario.suffix, `account-${scenario.suffix}`, recovery.store);
      const transition = await ledger.reconcileReportingStatusLifecycleV1({
        store: recovery.store,
        reporting_obligation_id: obligation.reporting_obligation_id,
        ledgerAsOf: '2026-09-02T01:30:00.000Z',
      });
      assert.ok(transition);

      // Synthesize a maximum fanout of maximum-length references. Generated
      // lazily and handed straight to the freeze barrier, so nothing larger than
      // the candidate list itself is ever held.
      const candidates = Array.from({ length: scenario.recipients }, (unused, index) => ({
        scope: {
          kind: 'account',
          tenantId: 't-'.padEnd(500, 'y'),
          principalId: 'p-'.padEnd(500, 'z'),
          accountId: `a-${index}`.padEnd(500, 'w'),
        },
        subscriberId: `${longSubscriberId}-${index}`,
        destinationGeneration: `dest_${'0'.repeat(64)}${index}`,
      }));
      let frozen;
      const capturingRuntime = ledger.createPostgresReportingNotificationActivityRuntime({
        db: pool,
        namespace: recovery.namespace,
        tenantScopeForAccount: () => 'tenant-a',
        notifications: {
          emit: async event => {
            frozen = await event.freezeRecipients(candidates);
            // None of the synthetic recipients resolves, so nothing is sent.
            return { notificationId: event.notificationId, emissionId: event.emissionId, matched: 0, deliveries: [] };
          },
        },
      });
      const pass = await capturingRuntime.recoverOnce({ ownerToken: `${scenario.suffix}-worker`, limit: 1 });
      assert.equal(pass.projected, 1, `${scenario.suffix}: a maximum fanout commits and settles`);
      assert.equal(frozen.length, scenario.recipients, `${scenario.suffix}: every recipient is committed`);

      const stored = await pool.query(
        `SELECT count(*)::integer AS count, max(length(recipient::text))::integer AS widest
           FROM adcp_reporting_notification_activity_recipients
          WHERE namespace = $1 AND transition_id = $2`,
        [recovery.namespace, transition.transitionId]
      );
      assert.equal(stored.rows[0].count, scenario.recipients);
      assert.ok(
        stored.rows[0].widest > 1_500,
        `${scenario.suffix}: references really are maximum length (${stored.rows[0].widest} bytes)`
      );
      // The same set serialized as one document would have blown a 256 KiB cap.
      assert.ok(
        stored.rows[0].widest * scenario.recipients > 256 * 1024,
        `${scenario.suffix}: this fanout is larger than a single-document cap could hold`
      );
    }
  });

  test('refuses a fanout above its configured recipient ceiling instead of poisoning the claim', async () => {
    const recovery = isolatedActivity('fanout-over', { maxRecipients: 2 });
    const obligation = await putObligation('fanout-over', 'account-fanout-over', recovery.store);
    const transition = await ledger.reconcileReportingStatusLifecycleV1({
      store: recovery.store,
      reporting_obligation_id: obligation.reporting_obligation_id,
      ledgerAsOf: '2026-09-02T01:30:00.000Z',
    });
    assert.ok(transition);
    const oversized = Array.from({ length: 3 }, (unused, index) => ({
      scope: { kind: 'account', tenantId: 'tenant-a', principalId: 'p', accountId: `a-${index}` },
      subscriberId: `subscriber-${index}`,
      destinationGeneration: `dest_${index}`,
    }));
    const errors = [];
    const overflowRuntime = ledger.createPostgresReportingNotificationActivityRuntime({
      db: pool,
      namespace: recovery.namespace,
      maxRecipients: 2,
      tenantScopeForAccount: () => 'tenant-a',
      notifications: { emit: event => event.freezeRecipients(oversized) },
    });
    const pass = await overflowRuntime.recoverOnce({
      ownerToken: 'fanout-over-worker',
      limit: 1,
      onError: error => errors.push(error),
    });
    assert.equal(pass.projected, 0, 'an unstorable fanout is not settled as delivered');
    assert.equal(pass.retried, 1);
    assert.match(errors.at(-1)?.message ?? '', /exceeds maxRecipients 2/);
    assert.match(errors.at(-1)?.message ?? '', /maxFanoutCandidates/, 'the message names the fix');
    const committed = await pool.query(
      `SELECT count(*)::integer AS count FROM adcp_reporting_notification_activity_recipients
        WHERE namespace = $1 AND transition_id = $2`,
      [recovery.namespace, transition.transitionId]
    );
    assert.equal(committed.rows[0].count, 0, 'no partial intent is committed');
  });

  test('rejects an unstorable runtime configuration at construction', async () => {
    assert.throws(
      () =>
        ledger.createPostgresReportingNotificationActivityRuntime({
          db: pool,
          notifications,
          namespace: 'reporting-activity-tests',
          tenantScopeForAccount: () => 'tenant-a',
          maxRecipients: 10_001,
        }),
      /maxRecipients must be an integer from 1 through 10000/
    );
    // The derived index budget is what makes a maximum fanout storable at all:
    // the longest permitted namespace plus a transition id, round and
    // fingerprint still fits a btree entry, so no valid configuration can
    // produce an intent that cannot be committed.
    assert.doesNotThrow(() =>
      ledger.createPostgresReportingNotificationActivityRuntime({
        db: pool,
        notifications,
        namespace: 'n'.repeat(255),
        tenantScopeForAccount: () => 'tenant-a',
        maxRecipients: 10_000,
      })
    );
    assert.throws(
      () =>
        ledger.createPostgresReportingNotificationActivityRuntime({
          db: pool,
          notifications,
          namespace: 'n'.repeat(256),
          tenantScopeForAccount: () => 'tenant-a',
        }),
      /namespace must be a non-empty UTF-8 string of at most 255 bytes/,
      'the namespace bound the index budget is derived from is itself enforced'
    );
  });

  test('without suppression classification an unsent notification settles as delivered', async () => {
    // The hazard the classification removes. The only difference from the test
    // above is a runtime that hides the suppression reason, which is what an
    // owner sees if it inspects only thrown delivery failures.
    const recovery = isolatedActivity('suppression-masked');
    await installSubscription('tenant-a', 'principal-masked', 'account-masked', 'https://buyer.example/masked');
    const obligation = await putObligation('suppression-masked', 'account-masked', recovery.store);
    const transition = await ledger.reconcileReportingStatusLifecycleV1({
      store: recovery.store,
      reporting_obligation_id: obligation.reporting_obligation_id,
      ledgerAsOf: '2026-09-02T01:30:00.000Z',
    });
    assert.ok(transition);
    const maskedRuntime = ledger.createPostgresReportingNotificationActivityRuntime({
      db: pool,
      namespace: recovery.namespace,
      tenantScopeForAccount: () => 'tenant-a',
      notifications: {
        emit: async event => {
          const result = await notifications.emit(event);
          return {
            ...result,
            deliveries: result.deliveries.map(({ result: delivery, ...rest }) => ({
              ...rest,
              result: { ...delivery, suppression: undefined },
            })),
          };
        },
      },
    });
    authorizeDeliveryHook = () => {
      authorizeDeliveryHook = undefined;
      throw new Error('authorization backend unavailable');
    };
    const pass = await maskedRuntime.recoverOnce({ ownerToken: 'suppression-masked-worker', limit: 1 });
    assert.equal(pass.projected, 1, 'the unsent notification is settled as delivered');
    assert.equal(fetchCalls.filter(value => value.body.notification_id === transition.transitionId).length, 0);
    assert.equal(
      (await readIntent(transition.transitionId, recovery.namespace)).state,
      'projected',
      'and is never retried — the notification is silently lost'
    );
    authorizeDeliveryHook = undefined;
  });

  test('without the attempt barrier a post-send replacement re-resolves and duplicates', async () => {
    // Proves the attempt barrier is what makes the frozen set immutable. The
    // freeze still runs; only `beforeExternalAttempt` is dropped, so nothing
    // records that a POST happened and the replay re-resolves.
    const scope = {
      kind: 'account',
      tenantId: 'tenant-a',
      principalId: 'principal-noattempt',
      accountId: 'account-noattempt',
    };
    const recovery = isolatedActivity('no-attempt-barrier');
    await installSubscription(scope.tenantId, scope.principalId, scope.accountId, 'https://buyer.example/noattempt-g1');
    const obligation = await putObligation('no-attempt-barrier', scope.accountId, recovery.store);
    const transition = await ledger.reconcileReportingStatusLifecycleV1({
      store: recovery.store,
      reporting_obligation_id: obligation.reporting_obligation_id,
      ledgerAsOf: '2026-09-02T01:30:00.000Z',
    });
    assert.ok(transition);
    const delivered = () => fetchCalls.filter(value => value.body.notification_id === transition.transitionId);

    const unbarriered = notify =>
      ledger.createPostgresReportingNotificationActivityRuntime({
        db: pool,
        namespace: recovery.namespace,
        tenantScopeForAccount: () => 'tenant-a',
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        notifications: { emit: ({ beforeExternalAttempt, ...event }) => notify(event) },
      });
    const crashing = unbarriered(async event => {
      await notifications.emit(event);
      throw new Error('crash after send, before settlement');
    });
    assert.equal((await crashing.recoverOnce({ ownerToken: 'noattempt-worker-one', limit: 1 })).retried, 1);
    assert.equal(delivered().length, 1);
    assert.equal(
      (await readIntent(transition.transitionId, recovery.namespace)).delivery_attempt_at,
      null,
      'nothing recorded that a POST happened'
    );

    const current = await notifications.read(scope);
    await notifications.replace(
      scope,
      [
        {
          subscriber_id: 'account-noattempt-subscriber',
          url: 'https://buyer.example/noattempt-g2',
          event_types: ['reporting.status_changed'],
        },
      ],
      { expectedGeneration: current.generation }
    );
    await makeClaimEligible(recovery.namespace, transition.transitionId);
    const replaying = unbarriered(event => notifications.emit(event));
    assert.equal((await replaying.recoverOnce({ ownerToken: 'noattempt-worker-two', limit: 1 })).projected, 1);

    assert.deepEqual(
      delivered().map(value => value.url),
      ['https://buyer.example/noattempt-g1', 'https://buyer.example/noattempt-g2'],
      'the replay re-resolves and addresses the replacement generation'
    );
    assert.equal(
      new Set(delivered().map(value => value.body.idempotency_key)).size,
      2,
      'under a second idempotency key the buyer cannot dedupe'
    );
  });

  test('refuses legacy subscribers beside the transactional port', async () => {
    const obligation = await putObligation('subscriber-conflict', 'account-a');
    await assert.rejects(
      () =>
        ledger.reconcileReportingStatusLifecycleV1({
          store,
          reporting_obligation_id: obligation.reporting_obligation_id,
          ledgerAsOf: '2026-09-02T01:30:00.000Z',
          subscribers: [{ account_id: 'account-a', notify: async () => {} }],
        }),
      /mutually exclusive/
    );
    assert.deepEqual(await store.listTransitions(obligation.reporting_obligation_id), []);
  });

  test('rechecks legacy pending transitions inside transactional store writes', async () => {
    const obligation = await putObligation('legacy-cutover-race', 'account-a');
    const legacyStore = new ledger.PostgresReportingLedgerStore(pool, { acknowledgeIsolatedDatabase: true });
    await legacyStore.appendTransition({
      transitionId: 'rst_legacy_cutover_race',
      reporting_obligation_id: obligation.reporting_obligation_id,
      previousHealth: 'waiting',
      health: 'delayed',
      issueIds: [],
      occurredAt: '2026-09-02T01:15:00.000Z',
    });
    const listTransitions = store.listTransitions.bind(store);
    store.listTransitions = async obligationId =>
      obligationId === obligation.reporting_obligation_id ? [] : listTransitions(obligationId);
    await assert.rejects(
      () =>
        ledger.reconcileReportingStatusLifecycleV1({
          store,
          reporting_obligation_id: obligation.reporting_obligation_id,
          ledgerAsOf: '2026-09-02T01:30:00.000Z',
        }),
      error =>
        error.cause?.message ===
        'Drain or explicitly resolve legacy pending reporting transitions before enabling transactional notification activity'
    );
    store.listTransitions = listTransitions;
    await assert.rejects(
      () =>
        store.appendTransition({
          transitionId: 'rst_legacy_cutover_direct_append',
          reporting_obligation_id: obligation.reporting_obligation_id,
          previousHealth: 'delayed',
          health: 'action_required',
          issueIds: [],
          occurredAt: '2026-09-02T01:45:00.000Z',
        }),
      error =>
        error.cause?.message ===
        'Drain or explicitly resolve legacy pending reporting transitions before enabling transactional notification activity'
    );
  });

  test('progresses a pre-v14 obligation whose stored insert clock is skewed from the ledger clock', async () => {
    const obligation = await putObligation('finality-clock-skew', 'account-b');
    const obligationId = obligation.reporting_obligation_id;
    // The `created_at` insert column runs eight hours ahead of the application
    // clock the revision payloads carry. A baseline reconstructed from
    // `created_at` against the transition's application-clock `occurredAt` would
    // disagree with the lifecycle decision on every pass and wedge the
    // compare-and-set forever. Resolving the pre-v14 baseline to 'none' consults
    // neither clock, so no amount of skew can stall the lifecycle.
    await insertSkewedRevision({
      obligationId,
      revisionId: 'rrev_clock_skew_snapshot',
      revisionNumber: 1,
      finality: 'snapshot',
      createdAt: '2026-09-02T01:05:00.000Z',
      insertedAt: '2026-09-02T09:05:00.000Z',
    });
    await insertLegacyTransition({
      transitionId: 'rst_clock_skew_pre_v14',
      obligationId,
      previousHealth: 'waiting',
      health: 'delayed',
      occurredAt: '2026-09-02T01:10:00.000Z',
    });
    await insertSkewedRevision({
      obligationId,
      revisionId: 'rrev_clock_skew_official',
      revisionNumber: 2,
      finality: 'official',
      supersedesRevisionId: 'rrev_clock_skew_snapshot',
      createdAt: '2026-09-02T01:20:00.000Z',
      insertedAt: '2026-09-02T09:20:00.000Z',
    });

    const transition = await ledger.reconcileReportingStatusLifecycleV1({
      store,
      reporting_obligation_id: obligationId,
      ledgerAsOf: '2026-09-02T01:30:00.000Z',
    });
    assert.ok(transition, 'lifecycle progresses instead of wedging on a two-clock baseline');
    assert.deepEqual(
      [transition.previousHealth, transition.health, transition.previousFinality, transition.finality],
      ['delayed', 'complete', 'none', 'official']
    );
    // The baseline is committed onto the legacy row, so no later pass — and no
    // clock — can derive a different one.
    const stored = await store.listTransitions(obligationId);
    assert.deepEqual(
      stored.map(value => [value.transitionId, value.finality]),
      [
        ['rst_clock_skew_pre_v14', 'none'],
        [transition.transitionId, 'official'],
      ]
    );

    const projected = await activity.recoverOnce({ ownerToken: 'clock-skew-worker' });
    assert.equal(projected.projected, 1);
    const delivered = () => fetchCalls.filter(value => value.body.notification_id === transition.transitionId);
    assert.equal(delivered().length, 1);

    // Replaying the reconciler reads the committed baseline, so it neither
    // re-transitions nor re-notifies.
    assert.equal(
      await ledger.reconcileReportingStatusLifecycleV1({
        store,
        reporting_obligation_id: obligationId,
        ledgerAsOf: '2026-09-02T01:45:00.000Z',
      }),
      null
    );
    assert.deepEqual(await activity.recoverOnce({ ownerToken: 'clock-skew-replay-worker' }), {
      claimed: 0,
      matched: 0,
      projected: 0,
      retried: 0,
      leaseLost: 0,
    });
    assert.equal(delivered().length, 1, 'notification stays exactly-once across the replay');
    const page = await activity.listActivity({ tenantId: 'tenant-b', accountId: 'account-b' });
    assert.equal(page.activities.filter(value => value.transitionId === transition.transitionId).length, 1);
  });

  test('excludes a revision committed after a legacy transition whose payload timestamp predates it', async () => {
    // A revision can be constructed before a transition occurs and still commit
    // after it. Ordering by the revision payload's `createdAt` would count it as
    // already observed, so the backfilled baseline would jump straight to
    // 'official' and the real finality change would never be reported.
    const suppressed = await putObligation('late-commit-finality', 'account-b');
    await insertLegacyTransition({
      transitionId: 'rst_late_commit_finality',
      obligationId: suppressed.reporting_obligation_id,
      previousHealth: 'waiting',
      health: 'complete',
      occurredAt: '2026-09-02T01:30:00.000Z',
    });
    await insertSkewedRevision({
      obligationId: suppressed.reporting_obligation_id,
      revisionId: 'rrev_late_commit_official',
      revisionNumber: 1,
      finality: 'official',
      // Created a quarter hour before the legacy transition, committed after it.
      createdAt: '2026-09-02T01:15:00.000Z',
      insertedAt: '2026-09-02T01:15:00.000Z',
    });

    const finalityOnly = await ledger.reconcileReportingStatusLifecycleV1({
      store,
      reporting_obligation_id: suppressed.reporting_obligation_id,
      ledgerAsOf: '2026-09-02T02:00:00.000Z',
    });
    assert.ok(finalityOnly, 'the late-committed official revision is still reported');
    assert.deepEqual(
      [finalityOnly.previousHealth, finalityOnly.health, finalityOnly.previousFinality, finalityOnly.finality],
      ['complete', 'complete', 'none', 'official'],
      'the baseline excludes a revision that committed after the legacy transition'
    );
    assert.equal(
      (await store.listTransitions(suppressed.reporting_obligation_id))[0].finality,
      'none',
      'the committed baseline is backfilled onto the legacy row'
    );

    // Health did not change, so this stays internal activity: the AdCP status
    // webhook is health-only.
    const suppressedActivity = await activity.listActivity({ tenantId: 'tenant-b', accountId: 'account-b' });
    const suppressedRecord = suppressedActivity.activities.filter(
      value => value.transitionId === finalityOnly.transitionId
    );
    assert.equal(suppressedRecord.length, 1);
    assert.ok(suppressedRecord[0].notificationProjectedAt);
    assert.equal(suppressedRecord[0].notificationType, undefined);
    assert.equal(fetchCalls.filter(value => value.body.notification_id === finalityOnly.transitionId).length, 0);

    // Same late-commit ordering, but with a health change, so the wire
    // notification must fire exactly once across recovery and replay.
    const notified = await putObligation('late-commit-health', 'account-b');
    await insertLegacyTransition({
      transitionId: 'rst_late_commit_health',
      obligationId: notified.reporting_obligation_id,
      previousHealth: 'waiting',
      health: 'delayed',
      occurredAt: '2026-09-02T01:30:00.000Z',
    });
    await insertSkewedRevision({
      obligationId: notified.reporting_obligation_id,
      revisionId: 'rrev_late_commit_health_official',
      revisionNumber: 1,
      finality: 'official',
      createdAt: '2026-09-02T01:15:00.000Z',
      insertedAt: '2026-09-02T01:15:00.000Z',
    });
    const healthChange = await ledger.reconcileReportingStatusLifecycleV1({
      store,
      reporting_obligation_id: notified.reporting_obligation_id,
      ledgerAsOf: '2026-09-02T02:00:00.000Z',
    });
    assert.ok(healthChange);
    assert.deepEqual(
      [healthChange.previousHealth, healthChange.health, healthChange.previousFinality, healthChange.finality],
      ['delayed', 'complete', 'none', 'official']
    );
    const delivered = () => fetchCalls.filter(value => value.body.notification_id === healthChange.transitionId);
    assert.equal((await activity.recoverOnce({ ownerToken: 'late-commit-worker' })).projected, 1);
    assert.equal(delivered().length, 1);
    assert.equal(
      await ledger.reconcileReportingStatusLifecycleV1({
        store,
        reporting_obligation_id: notified.reporting_obligation_id,
        ledgerAsOf: '2026-09-02T02:15:00.000Z',
      }),
      null
    );
    assert.deepEqual(await activity.recoverOnce({ ownerToken: 'late-commit-replay-worker' }), {
      claimed: 0,
      matched: 0,
      projected: 0,
      retried: 0,
      leaseLost: 0,
    });
    assert.equal(delivered().length, 1, 'notification stays exactly-once across the replay');
  });

  test('never treats a later-committed revision as observed when recorded_at ties or steps backward', async () => {
    // `recorded_at` defaults to `clock_timestamp()`, a wall clock: it can repeat
    // within a microsecond and it can move backward across an NTP step. Both are
    // forced here, with the revision genuinely committed after the legacy
    // transition. Neither may let it count as already observed, which would make
    // `previousFinality` equal `finality` and drop the real change.
    const legacyRecordedAt = '2026-09-02T01:30:00.000000Z';
    for (const scenario of [
      { suffix: 'recorded-tie', recordedAt: legacyRecordedAt, label: 'equal recorded_at' },
      { suffix: 'recorded-backward', recordedAt: '2026-09-02T00:30:00.000000Z', label: 'backward recorded_at' },
    ]) {
      const obligation = await putObligation(`wall-clock-${scenario.suffix}`, 'account-b');
      const obligationId = obligation.reporting_obligation_id;
      await insertLegacyTransition({
        transitionId: `rst_wall_clock_${scenario.suffix.replace(/-/g, '_')}`,
        obligationId,
        previousHealth: 'waiting',
        health: 'delayed',
        occurredAt: '2026-09-02T01:30:00.000Z',
        recordedAt: legacyRecordedAt,
      });
      await insertSkewedRevision({
        obligationId,
        revisionId: `rrev_wall_clock_${scenario.suffix.replace(/-/g, '_')}`,
        revisionNumber: 1,
        finality: 'official',
        createdAt: '2026-09-02T01:45:00.000Z',
        insertedAt: '2026-09-02T01:45:00.000Z',
        recordedAt: scenario.recordedAt,
      });

      const transition = await ledger.reconcileReportingStatusLifecycleV1({
        store,
        reporting_obligation_id: obligationId,
        ledgerAsOf: '2026-09-02T02:00:00.000Z',
      });
      assert.ok(transition, `${scenario.label}: the later-committed revision is still reported`);
      assert.deepEqual(
        [transition.previousHealth, transition.health, transition.previousFinality, transition.finality],
        ['delayed', 'complete', 'none', 'official'],
        `${scenario.label}: the baseline never claims the revision was observed`
      );
      assert.equal(
        (await store.listTransitions(obligationId))[0].finality,
        'none',
        `${scenario.label}: the committed baseline is backfilled onto the legacy row`
      );

      const delivered = () => fetchCalls.filter(value => value.body.notification_id === transition.transitionId);
      assert.equal(
        (await activity.recoverOnce({ ownerToken: `wall-clock-${scenario.suffix}-worker` })).projected,
        1,
        `${scenario.label}: the health change projects once`
      );
      assert.equal(delivered().length, 1, `${scenario.label}: webhook delivered exactly once`);
      assert.equal(
        await ledger.reconcileReportingStatusLifecycleV1({
          store,
          reporting_obligation_id: obligationId,
          ledgerAsOf: '2026-09-02T02:15:00.000Z',
        }),
        null,
        `${scenario.label}: the replay re-reads the committed baseline and re-transitions nothing`
      );
      assert.deepEqual(await activity.recoverOnce({ ownerToken: `wall-clock-${scenario.suffix}-replay` }), {
        claimed: 0,
        matched: 0,
        projected: 0,
        retried: 0,
        leaseLost: 0,
      });
      assert.equal(delivered().length, 1, `${scenario.label}: notification stays exactly-once across the replay`);
      const page = await activity.listActivity({ tenantId: 'tenant-b', accountId: 'account-b' });
      assert.equal(
        page.activities.filter(value => value.transitionId === transition.transitionId).length,
        1,
        `${scenario.label}: exactly one activity row`
      );
    }
  });

  test('claims rows incrementally so a slow batch cannot expire later leases', async () => {
    const obligations = await Promise.all([
      putObligation('slow-batch-a', 'account-a'),
      putObligation('slow-batch-b', 'account-a'),
      putObligation('slow-batch-c', 'account-a'),
    ]);
    await Promise.all(
      obligations.map(obligation =>
        ledger.reconcileReportingStatusLifecycleV1({
          store,
          reporting_obligation_id: obligation.reporting_obligation_id,
          ledgerAsOf: '2026-09-02T01:30:00.000Z',
        })
      )
    );
    const emissionIds = [];
    const slowRuntime = ledger.createPostgresReportingNotificationActivityRuntime({
      db: pool,
      namespace: 'reporting-activity-tests',
      tenantScopeForAccount: () => 'tenant-a',
      notifications: {
        async emit(event) {
          emissionIds.push(event.emissionId);
          await new Promise(resolve => setTimeout(resolve, 600));
          return { notificationId: event.notificationId, emissionId: event.emissionId, matched: 0, deliveries: [] };
        },
      },
    });
    const first = slowRuntime.recoverOnce({ ownerToken: 'slow-batch-worker-one', leaseMs: 1_000, limit: 3 });
    await new Promise(resolve => setTimeout(resolve, 1_100));
    const second = slowRuntime.recoverOnce({ ownerToken: 'slow-batch-worker-two', leaseMs: 1_000, limit: 3 });
    await Promise.all([first, second]);
    assert.equal(emissionIds.length, 3);
    assert.equal(new Set(emissionIds).size, 3);
  });

  test('prevents a stale worker from settling a claim taken over by another generation', async () => {
    const obligation = await putObligation('lease-takeover', 'account-a');
    const transition = await ledger.reconcileReportingStatusLifecycleV1({
      store,
      reporting_obligation_id: obligation.reporting_obligation_id,
      ledgerAsOf: '2026-09-02T01:30:00.000Z',
    });
    assert.ok(transition);
    const staleRuntime = ledger.createPostgresReportingNotificationActivityRuntime({
      db: pool,
      namespace: 'reporting-activity-tests',
      tenantScopeForAccount: () => 'tenant-a',
      notifications: {
        async emit(event) {
          await pool.query(
            `UPDATE adcp_reporting_notification_activity
                SET lease_owner = 'takeover-worker', lease_version = lease_version + 1,
                    lease_expires_at = clock_timestamp() + INTERVAL '1 minute'
              WHERE namespace = $1 AND transition_id = $2 AND state = 'pending'`,
            ['reporting-activity-tests', event.notificationId]
          );
          return { notificationId: event.notificationId, emissionId: event.emissionId, matched: 0, deliveries: [] };
        },
      },
    });
    const stale = await staleRuntime.recoverOnce({ ownerToken: 'stale-worker', leaseMs: 1_000, limit: 1 });
    assert.equal(stale.leaseLost, 1);
    const row = await pool.query(
      `SELECT state, lease_owner FROM adcp_reporting_notification_activity
        WHERE namespace = $1 AND transition_id = $2`,
      ['reporting-activity-tests', transition.transitionId]
    );
    assert.deepEqual(row.rows[0], { state: 'pending', lease_owner: 'takeover-worker' });
    await pool.query(
      `UPDATE adcp_reporting_notification_activity SET lease_expires_at = clock_timestamp() - INTERVAL '1 second'
        WHERE namespace = $1 AND transition_id = $2`,
      ['reporting-activity-tests', transition.transitionId]
    );
    assert.equal((await activity.recoverOnce({ ownerToken: 'takeover-recovery', limit: 1 })).projected, 1);
  });

  test('renews an active lease while a slow emission outlives multiple lease periods', async () => {
    const obligation = await putObligation('lease-heartbeat', 'account-a');
    await ledger.reconcileReportingStatusLifecycleV1({
      store,
      reporting_obligation_id: obligation.reporting_obligation_id,
      ledgerAsOf: '2026-09-02T01:30:00.000Z',
    });
    let emissions = 0;
    const slowRuntime = ledger.createPostgresReportingNotificationActivityRuntime({
      db: pool,
      namespace: 'reporting-activity-tests',
      tenantScopeForAccount: () => 'tenant-a',
      notifications: {
        async emit(event) {
          emissions += 1;
          await new Promise(resolve => setTimeout(resolve, 2_500));
          return { notificationId: event.notificationId, emissionId: event.emissionId, matched: 0, deliveries: [] };
        },
      },
    });
    const first = slowRuntime.recoverOnce({ ownerToken: 'heartbeat-worker-one', leaseMs: 1_000, limit: 1 });
    await new Promise(resolve => setTimeout(resolve, 1_200));
    const competing = await slowRuntime.recoverOnce({ ownerToken: 'heartbeat-worker-two', leaseMs: 1_000, limit: 1 });
    assert.equal(competing.claimed, 0);
    assert.equal((await first).projected, 1);
    assert.equal(emissions, 1);
  });

  test('atomically backpressures a tenant whose pending activity reaches its configured cap', async () => {
    const cappedActivity = ledger.createPostgresReportingNotificationActivityRuntime({
      db: pool,
      notifications,
      namespace: 'reporting-capacity-tests',
      tenantScopeForAccount: () => 'tenant-a',
      maxPendingPerTenant: 1,
    });
    const cappedStore = new ledger.PostgresReportingLedgerStore(pool, {
      acknowledgeIsolatedDatabase: true,
      notificationActivityPort: cappedActivity.port,
    });
    const [first, second] = await Promise.all([
      putObligation('capacity-a', 'account-a'),
      putObligation('capacity-b', 'account-b'),
    ]);
    const attempts = await Promise.allSettled(
      [first, second].map(obligation =>
        ledger.reconcileReportingStatusLifecycleV1({
          store: cappedStore,
          reporting_obligation_id: obligation.reporting_obligation_id,
          ledgerAsOf: '2026-09-02T01:30:00.000Z',
        })
      )
    );
    assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(attempts.filter(result => result.status === 'rejected').length, 1);
    const winnerIndex = attempts.findIndex(result => result.status === 'fulfilled');
    const winningObligation = [first, second][winnerIndex];
    const losingObligation = [first, second][winnerIndex === 0 ? 1 : 0];
    const firstTransition = attempts[winnerIndex].value;
    assert.ok(firstTransition);
    const replayClient = await pool.connect();
    try {
      await replayClient.query('BEGIN');
      await cappedActivity.port.recordTransition(
        { transition: firstTransition, obligation: winningObligation },
        replayClient
      );
      await replayClient.query('COMMIT');
    } catch (error) {
      await replayClient.query('ROLLBACK');
      throw error;
    } finally {
      replayClient.release();
    }
    const pending = await pool.query(
      `SELECT transition_id FROM adcp_reporting_notification_activity
        WHERE namespace = 'reporting-capacity-tests' AND tenant_scope = 'tenant-a' AND state = 'pending'`
    );
    assert.equal(pending.rowCount, 1);
    assert.deepEqual(await cappedStore.listTransitions(losingObligation.reporting_obligation_id), []);
  });

  test('roundtrips a returned cursor at maximum escaped scope lengths', async () => {
    const namespace = '\u0001'.repeat(255);
    const tenantId = '\u0002'.repeat(512);
    const accountId = '\u0003'.repeat(512);
    const scopedActivity = ledger.createPostgresReportingNotificationActivityRuntime({
      db: pool,
      notifications,
      namespace,
      tenantScopeForAccount: () => tenantId,
    });
    const obligation = await putObligation('maximum-escaped-cursor', accountId);
    for (const index of [1, 2]) {
      await recordActivityIntent(scopedActivity, obligation, {
        transitionId: `rst_maximum_escaped_cursor_${index}`,
        reporting_obligation_id: obligation.reporting_obligation_id,
        previousHealth: 'waiting',
        health: 'waiting',
        previousFinality: index === 1 ? 'none' : 'snapshot',
        finality: 'snapshot',
        issueIds: [],
        occurredAt: `2026-09-02T0${index}:00:00.000Z`,
      });
    }
    const firstPage = await scopedActivity.listActivity({ tenantId, accountId, limit: 1 });
    assert.ok(Buffer.byteLength(firstPage.nextCursor, 'utf8') > 2_048);
    const secondPage = await scopedActivity.listActivity({
      tenantId,
      accountId,
      cursor: firstPage.nextCursor,
      limit: 1,
    });
    assert.equal(secondPage.activities.length, 1);
    assert.notEqual(secondPage.activities[0].transitionId, firstPage.activities[0].transitionId);
  });

  test('prunes only expired projected activity within its namespace and batch bound', async () => {
    const pruneActivity = ledger.createPostgresReportingNotificationActivityRuntime({
      db: pool,
      notifications,
      namespace: 'reporting-prune-tests',
      tenantScopeForAccount: () => 'tenant-a',
    });
    const otherActivity = ledger.createPostgresReportingNotificationActivityRuntime({
      db: pool,
      notifications,
      namespace: 'reporting-prune-other',
      tenantScopeForAccount: () => 'tenant-a',
    });
    const obligation = await putObligation('pruning', 'account-a');
    for (const transitionId of ['rst_prune_expired_1', 'rst_prune_expired_2', 'rst_prune_expired_3']) {
      await recordActivityIntent(pruneActivity, obligation, finalityOnlyTransition(transitionId, obligation));
    }
    await recordActivityIntent(pruneActivity, obligation, finalityOnlyTransition('rst_prune_unexpired', obligation));
    await recordActivityIntent(pruneActivity, obligation, {
      ...finalityOnlyTransition('rst_prune_pending', obligation),
      previousHealth: 'waiting',
      health: 'delayed',
    });
    await recordActivityIntent(
      otherActivity,
      obligation,
      finalityOnlyTransition('rst_prune_other_namespace', obligation)
    );
    await pool.query(
      `UPDATE adcp_reporting_notification_activity
          SET retain_until = clock_timestamp() - interval '1 second'
        WHERE transition_id = ANY($1::text[])`,
      [['rst_prune_expired_1', 'rst_prune_expired_2', 'rst_prune_expired_3', 'rst_prune_other_namespace']]
    );
    assert.equal(await pruneActivity.pruneProjected({ limit: 2 }), 2);
    const afterFirstBatch = await pool.query(
      `SELECT namespace, transition_id, state
         FROM adcp_reporting_notification_activity
        WHERE namespace IN ('reporting-prune-tests', 'reporting-prune-other')`
    );
    assert.equal(
      afterFirstBatch.rows.filter(
        row => row.namespace === 'reporting-prune-tests' && row.transition_id.startsWith('rst_prune_expired_')
      ).length,
      1
    );
    assert.ok(afterFirstBatch.rows.some(row => row.transition_id === 'rst_prune_pending' && row.state === 'pending'));
    assert.ok(afterFirstBatch.rows.some(row => row.transition_id === 'rst_prune_unexpired'));
    assert.ok(afterFirstBatch.rows.some(row => row.transition_id === 'rst_prune_other_namespace'));
    assert.equal(await pruneActivity.pruneProjected({ limit: 2 }), 1);
    assert.equal(await otherActivity.pruneProjected({ limit: 2 }), 1);
  });

  async function installSubscription(tenantId, principalId, accountId, url, extra = {}) {
    const result = await notifications.replace({ kind: 'account', tenantId, principalId, accountId }, [
      { subscriber_id: `${accountId}-subscriber`, url, event_types: ['reporting.status_changed'], ...extra },
    ]);
    assert.equal(result.outcome, 'applied');
  }

  async function recordActivityIntent(runtime, obligation, transition) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await runtime.port.recordTransition({ transition, obligation }, client);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  function finalityOnlyTransition(transitionId, obligation) {
    return {
      transitionId,
      reporting_obligation_id: obligation.reporting_obligation_id,
      previousHealth: 'waiting',
      health: 'waiting',
      previousFinality: 'none',
      finality: 'snapshot',
      issueIds: [],
      occurredAt: '2026-09-02T02:00:00.000Z',
    };
  }

  /**
   * Inserts a revision whose payload `createdAt` (application clock) and
   * `created_at` insert column (database clock) deliberately disagree.
   */
  async function insertSkewedRevision(input) {
    await pool.query(
      `INSERT INTO adcp_reporting_revisions
         (revision_id, obligation_id, revision_number, finality, kind, supersedes_revision_id,
          content_sha256, data, created_at, recorded_at)
       VALUES ($1, $2, $3, $4, $4, $5, $6, $7::jsonb, $8, COALESCE($9::timestamptz, clock_timestamp()))`,
      [
        input.revisionId,
        input.obligationId,
        input.revisionNumber,
        input.finality,
        input.supersedesRevisionId ?? null,
        `sha256:${input.revisionId}`,
        JSON.stringify({
          reporting_revision_id: input.revisionId,
          reporting_obligation_id: input.obligationId,
          revisionNumber: input.revisionNumber,
          finality: input.finality,
          kind: input.finality,
          createdAt: input.createdAt,
          ...(input.supersedesRevisionId ? { supersedes_reporting_revision_id: input.supersedesRevisionId } : {}),
        }),
        input.insertedAt,
        input.recordedAt ?? null,
      ]
    );
  }

  /**
   * Activity runtime + ledger store in their own namespace. Recovery claims
   * namespace-wide, so a test that asserts exact per-claim metrics must not
   * share a namespace with any other test.
   */
  function isolatedActivity(suffix, overrides = {}) {
    const isolatedNamespace = `reporting-activity-${suffix}`;
    const isolated = ledger.createPostgresReportingNotificationActivityRuntime({
      db: pool,
      notifications,
      namespace: isolatedNamespace,
      tenantScopeForAccount: accountId => (accountId === 'account-b' ? 'tenant-b' : 'tenant-a'),
      ...overrides,
    });
    return {
      namespace: isolatedNamespace,
      activity: isolated,
      store: new ledger.PostgresReportingLedgerStore(pool, {
        acknowledgeIsolatedDatabase: true,
        notificationActivityPort: isolated.port,
      }),
    };
  }

  /** Makes a released claim immediately claimable without depending on wall-clock slack. */
  async function makeClaimEligible(intentNamespace, transitionId) {
    await pool.query(
      `UPDATE adcp_reporting_notification_activity SET next_attempt_at = clock_timestamp()
        WHERE namespace = $1 AND transition_id = $2`,
      [intentNamespace, transitionId]
    );
  }

  async function readIntent(transitionId, intentNamespace = 'reporting-activity-tests') {
    const parent = await pool.query(
      `SELECT state, delivery_intent_round, delivery_intent_at, delivery_attempt_at
         FROM adcp_reporting_notification_activity
        WHERE namespace = $1 AND transition_id = $2`,
      [intentNamespace, transitionId]
    );
    const recipients = await pool.query(
      `SELECT recipient.recipient FROM adcp_reporting_notification_activity_recipients recipient
         JOIN adcp_reporting_notification_activity activity
           ON activity.namespace = recipient.namespace
          AND activity.transition_id = recipient.transition_id
          AND activity.delivery_intent_round = recipient.intent_round
        WHERE recipient.namespace = $1 AND recipient.transition_id = $2
        ORDER BY recipient.recipient_fingerprint`,
      [intentNamespace, transitionId]
    );
    return { ...parent.rows[0], recipients: recipients.rows.map(row => row.recipient) };
  }

  /**
   * Commits a pre-SDK-14 transition row: no `finality`, already notified.
   * `recordedAt` pins the insert wall clock so a test can force ties and
   * backward steps against later-committed revisions.
   */
  async function insertLegacyTransition(input) {
    await pool.query(
      `INSERT INTO adcp_reporting_transitions (transition_id, obligation_id, data, occurred_at, recorded_at)
       VALUES ($1, $2, $3::jsonb, $4, COALESCE($5::timestamptz, clock_timestamp()))`,
      [
        input.transitionId,
        input.obligationId,
        JSON.stringify({
          transitionId: input.transitionId,
          reporting_obligation_id: input.obligationId,
          previousHealth: input.previousHealth,
          health: input.health,
          issueIds: [],
          occurredAt: input.occurredAt,
          notifiedAt: input.occurredAt,
        }),
        input.occurredAt,
        input.recordedAt ?? null,
      ]
    );
  }

  async function putObligation(suffix, accountId, target = store) {
    const configuration = configurationFixture(suffix, accountId);
    await target.putConfiguration(configuration);
    const obligation = obligationFixture(suffix, configuration);
    await target.putObligation(obligation);
    return obligation;
  }
});

function signerKey() {
  const { privateKey } = generateKeyPairSync('ed25519');
  return {
    keyid: 'reporting-activity-test',
    alg: 'ed25519',
    privateKey: {
      ...privateKey.export({ format: 'jwk' }),
      kid: 'reporting-activity-test',
      alg: 'ed25519',
      adcp_use: 'request-signing',
      key_ops: ['sign'],
    },
  };
}

function configurationFixture(suffix, accountId) {
  return {
    configurationId: `configuration-${suffix}`,
    account: { account_id: accountId },
    sourceScope: { route: `route-${suffix}` },
    delivery_config_id: `delivery-${suffix}`,
    delivery_config_version: 1,
    offeringId: `offering-${suffix}`,
    report_definition_id: `report-${suffix}`,
    feedPurpose: 'analytics',
    requiredFinality: 'snapshot',
    requestedMetrics: ['impressions'],
    requestedDimensions: ['media_buy_id'],
    constituents: [],
    mediaBuyIds: [`media-buy-${suffix}`],
    sourceTimezone: 'UTC',
    schedule: {
      anchor: '2026-09-01T00:00:00.000Z',
      periodMilliseconds: 86_400_000,
      deliverySlaMilliseconds: 0,
      recoveryWindowMilliseconds: 86_400_000,
    },
    sourceSettings: {},
    contract: { schemaUri: 'https://example.invalid/reporting.json', schemaSha256: 'a'.repeat(64) },
    installedAt: '2026-09-01T00:00:00.000Z',
    semanticFingerprint: `sha256:${suffix}`,
  };
}

function obligationFixture(suffix, configuration) {
  return {
    reporting_obligation_id: `obligation-${suffix}`,
    configurationId: configuration.configurationId,
    account: configuration.account,
    sourceScope: configuration.sourceScope,
    delivery_config_id: configuration.delivery_config_id,
    delivery_config_version: configuration.delivery_config_version,
    offeringId: configuration.offeringId,
    report_definition_id: configuration.report_definition_id,
    feedPurpose: configuration.feedPurpose,
    requiredFinality: configuration.requiredFinality,
    periodOrdinal: 0,
    period: { start: '2026-09-01T00:00:00.000Z', end: '2026-09-02T00:00:00.000Z', sourceTimezone: 'UTC' },
    schedule: configuration.schedule,
    scopeResolvedAt: '2026-09-02T00:00:00.000Z',
    coverage: {
      status: 'full',
      evaluatedAt: '2026-09-02T00:00:00.000Z',
      mediaBuyIds: configuration.mediaBuyIds,
      fullyCoveredMediaBuyIds: configuration.mediaBuyIds,
      partiallyCoveredMediaBuyIds: [],
      unsupportedMediaBuyIds: [],
      unknownMediaBuyIds: [],
    },
    requestedMetrics: configuration.requestedMetrics,
    requestedDimensions: configuration.requestedDimensions,
    constituents: configuration.constituents,
    mediaBuyIds: configuration.mediaBuyIds,
    sourceSettings: configuration.sourceSettings,
    contract: configuration.contract,
    expectedAt: '2026-09-02T01:00:00.000Z',
    recoveryDeadlineAt: '2026-09-02T02:00:00.000Z',
    publicationOffsets: [],
    nextAttemptAt: '2026-09-02T01:00:00.000Z',
    attemptCount: 0,
    state: 'pending',
    semanticFingerprint: `sha256:obligation-${suffix}`,
    createdAt: '2026-09-02T00:00:00.000Z',
  };
}
