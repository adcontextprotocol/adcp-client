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
  let attemptCheckpoint;
  let notificationsWithoutCheckpoint;
  let failNextFetch = false;
  let checkpointCalls = 0;
  const checkpoints = new Map();
  const checkpointNamespaces = new Set(['reporting-activity-tests']);

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
    // Production wires one checkpoint for one namespace. The suite runs several
    // namespaces against one notification runtime, so dispatch to whichever one
    // owns the frozen recipient row.
    attemptCheckpoint = async input => {
      let lastError;
      for (const candidate of checkpointNamespaces) {
        if (!checkpoints.has(candidate)) {
          checkpoints.set(
            candidate,
            ledger.createPostgresReportingNotificationAttemptCheckpoint({ db: pool, namespace: candidate })
          );
        }
        try {
          return await checkpoints.get(candidate)(input);
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError ?? new Error('no reporting activity namespace owns this delivery');
    };
    notifications = server.createPostgresPersistentNotificationRuntime({
      db: pool,
      publisherScope: 'reporting-activity-tests',
      webhooks: {
        signerKey: signerKey(),
        fetch: async (url, init) => {
          const body = JSON.parse(init.body);
          if (body.notification_type === 'reporting.status_changed') {
            assert.equal(validateStatusWebhook(body), true, JSON.stringify(validateStatusWebhook.errors));
          }
          if (failNextFetch) {
            failNextFetch = false;
            return { status: 503, headers: { get: () => undefined } };
          }
          fetchCalls.push({ url, body });
          return { status: 204, headers: { get: () => undefined } };
        },
        retries: { maxAttempts: 1, initialDelayMs: 0, maxDelayMs: 0, jitter: 0 },
        sleep: async () => {},
      },
      proofAdapter: { prove: async () => ({ proved: true }) },
      validateDestination: async () => ({ allowed: true }),
      authorizeDelivery: async input => (authorizeDeliveryHook ?? (() => ({ authorized: true })))(input),
      checkpointDeliveryAttempt: input => {
        checkpointCalls += 1;
        return attemptCheckpoint(input);
      },
      credentialAdapter: credentialAdapter(),
      subscriptions: { acknowledgeIsolatedDatabase: true },
    });
    notificationsWithoutCheckpoint = server.createPostgresPersistentNotificationRuntime({
      db: pool,
      publisherScope: 'reporting-activity-tests',
      webhooks: {
        signerKey: signerKey(),
        fetch: async (url, init) => {
          const body = JSON.parse(init.body);
          fetchCalls.push({ url, body });
          return { status: 204, headers: { get: () => undefined } };
        },
        retries: { maxAttempts: 1, initialDelayMs: 0, maxDelayMs: 0, jitter: 0 },
        sleep: async () => {},
      },
      proofAdapter: { prove: async () => ({ proved: true }) },
      validateDestination: async () => ({ allowed: true }),
      authorizeDelivery: async () => ({ authorized: true }),
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
        hasDeliveryAttemptCheckpoint: true,
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
        hasDeliveryAttemptCheckpoint: true,
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
    assert.equal(committed.recipients.length, 1);
    assert.equal(committed.attempted, 1, 'the POST was checkpointed, so this recipient is now pinned');
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
    assert.deepEqual(
      settled.recipients.map(value => value.destinationGeneration),
      [firstGeneration],
      'the pinned recipient set is immutable across replay'
    );
    assert.equal(settled.unsettled, 0, 'every recipient reached a terminal disposition before projection');
    assert.equal(
      settled.rows[0].attempt_at.toISOString(),
      committed.rows[0].attempt_at.toISOString(),
      'the attempt checkpoint is written once'
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

  test('refuses a port that skips the freeze rather than projecting an unsent notification', async () => {
    // A port can declare checkpoint support and still never freeze. Nothing is
    // then addressable, the checkpoint has no row to mark, and a runtime that
    // trusted the declaration would settle zero outstanding recipients and
    // record the notification as delivered.
    const recovery = isolatedActivity('skips-freeze');
    await installSubscription('tenant-a', 'principal-skip', 'account-skip', 'https://buyer.example/skip');
    const obligation = await putObligation('skips-freeze', 'account-skip', recovery.store);
    const transition = await ledger.reconcileReportingStatusLifecycleV1({
      store: recovery.store,
      reporting_obligation_id: obligation.reporting_obligation_id,
      ledgerAsOf: '2026-09-02T01:30:00.000Z',
    });
    assert.ok(transition);
    const skipping = ledger.createPostgresReportingNotificationActivityRuntime({
      db: pool,
      namespace: recovery.namespace,
      tenantScopeForAccount: () => 'tenant-a',
      notifications: {
        // Declares the capability, then drops the freeze on the floor.
        hasDeliveryAttemptCheckpoint: true,
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        emit: ({ freezeRecipients, ...event }) => notifications.emit(event),
      },
    });
    const errors = [];
    const pass = await skipping.recoverOnce({
      ownerToken: 'skip-worker',
      limit: 1,
      retryAfterMs: 1,
      onError: error => errors.push(error),
    });
    assert.equal(pass.projected, 0, 'an unfrozen emission is never projected');
    assert.equal(pass.retried, 1);
    assert.match(errors.at(-1)?.message ?? '', /did not freeze its recipient set/);
    const intent = await readIntent(transition.transitionId, recovery.namespace);
    assert.equal(intent.state, 'pending', 'the activity stays pending rather than being recorded as delivered');
    assert.equal(intent.recipients.length, 0);

    // The same claim settles normally once a conforming port handles it.
    await makeClaimEligible(recovery.namespace, transition.transitionId);
    const recovered = await recovery.activity.recoverOnce({ ownerToken: 'skip-worker-two', limit: 1 });
    assert.equal(recovered.projected, 1);
    assert.equal(fetchCalls.filter(value => value.body.notification_id === transition.transitionId).length, 1);
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
      assert.equal(held.attempted, 0, 'no external attempt was checkpointed');
      assert.equal(held.unsettled, 1, 'the recipient is left unsettled, so projection is blocked');

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
        hasDeliveryAttemptCheckpoint: true,
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
    assert.equal(held.attempted, 0);
    assert.equal(held.unsettled, 1);

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
        hasDeliveryAttemptCheckpoint: true,
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
    assert.equal(straddledIntent.recipients.length, 1);
    assert.equal(straddledIntent.attempted, 0, 'no attempt was checkpointed, so the recipient stays revisable');

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
    assert.equal(
      resolvedIntent.recipients.length,
      1,
      'the superseded recipient was replaced in place, not accumulated'
    );
    assert.equal(resolvedIntent.attempted, 1, 'the replacement is now pinned by its own checkpoint');
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
    assert.deepEqual(
      afterReplay.recipients.map(value => value.destinationGeneration),
      [g2Generation],
      'the pinned recipient is immutable after an attempt'
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
          hasDeliveryAttemptCheckpoint: true,
          hasDeliveryAttemptCheckpoint: true,
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
      notifications: { hasDeliveryAttemptCheckpoint: true, emit: event => event.freezeRecipients(oversized) },
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
        hasDeliveryAttemptCheckpoint: true,
        emit: async event => {
          const result = await notifications.emit(event);
          // Exactly what an owner sees if it inspects only thrown failures: a
          // suppressed delivery looks like a completed one.
          return {
            ...result,
            deliveries: result.deliveries.map(({ result: delivery, ...rest }) => ({
              ...rest,
              result: { ...delivery, suppression: undefined, delivered: true, terminal: false },
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

    // Same freeze, but the notification runtime has no checkpointDeliveryAttempt,
    // so no recipient is ever pinned.
    const unbarriered = notify =>
      ledger.createPostgresReportingNotificationActivityRuntime({
        db: pool,
        namespace: recovery.namespace,
        tenantScopeForAccount: () => 'tenant-a',
        // Deliberately uncheckpointed: this is the hazard A/B.
        acknowledgeMissingAttemptCheckpoint: true,
        notifications: { emit: event => notify(event) },
      });
    const crashing = unbarriered(async event => {
      await notificationsWithoutCheckpoint.emit(event);
      throw new Error('crash after send, before settlement');
    });
    assert.equal((await crashing.recoverOnce({ ownerToken: 'noattempt-worker-one', limit: 1 })).retried, 1);
    assert.equal(delivered().length, 1);
    assert.equal(
      (await readIntent(transition.transitionId, recovery.namespace)).attempted,
      0,
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
    const replaying = unbarriered(event => notificationsWithoutCheckpoint.emit(event));
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

  test('checkpoints a recovered outbox delivery so it cannot be re-addressed under a replacement', async () => {
    // A recovered outbox attempt is rebuilt from a durable snapshot, which cannot
    // carry a closure. The checkpoint is therefore keyed on the durable attempt
    // context, so the outbox worker pins the recipient exactly as the original
    // emission would have. Without that, the outbox could send generation A
    // while the activity still believed the recipient unaddressed, and a
    // replacement would then be addressed as generation B under a new
    // idempotency key.
    const scope = {
      kind: 'account',
      tenantId: 'tenant-a',
      principalId: 'principal-outbox',
      accountId: 'account-outbox',
    };
    const recovery = isolatedActivity('outbox-checkpoint');
    await installSubscription(scope.tenantId, scope.principalId, scope.accountId, 'https://buyer.example/outbox-g1');
    const obligation = await putObligation('outbox-checkpoint', scope.accountId, recovery.store);
    const transition = await ledger.reconcileReportingStatusLifecycleV1({
      store: recovery.store,
      reporting_obligation_id: obligation.reporting_obligation_id,
      ledgerAsOf: '2026-09-02T01:30:00.000Z',
    });
    assert.ok(transition);
    const delivered = () => fetchCalls.filter(value => value.body.notification_id === transition.transitionId);

    // First pass: the POST fails transiently, so the delivery stays pending for
    // the outbox worker and the activity claim is released.
    failNextFetch = true;
    const firstPass = await recovery.activity.recoverOnce({
      ownerToken: 'outbox-worker-one',
      limit: 1,
      retryAfterMs: 1,
    });
    assert.equal(firstPass.projected, 0, 'an unretried delivery does not settle the activity');
    assert.equal(delivered().length, 0);
    const pending = await pool.query(
      `SELECT delivery_id, state FROM adcp_webhook_outbox
        WHERE delivery_id LIKE 'notification_%' AND state = 'pending' ORDER BY created_at DESC LIMIT 1`
    );
    assert.equal(pending.rows.length, 1, 'the failed POST left a durable outbox entry');

    // Isolate the recovered path: clear the checkpoint the fresh attempt wrote,
    // so only the outbox worker can restore it.
    await pool.query(
      `UPDATE adcp_reporting_notification_activity_recipients SET attempt_at = NULL
        WHERE namespace = $1 AND transition_id = $2`,
      [recovery.namespace, transition.transitionId]
    );
    assert.equal((await readIntent(transition.transitionId, recovery.namespace)).attempted, 0);

    const checkpointsBefore = checkpointCalls;
    const outboxPass = await notifications.recoverOnce({ ownerToken: 'outbox-delivery-worker' });
    assert.ok(outboxPass.claimed >= 1, 'the outbox worker claimed the recovered delivery');
    assert.ok(outboxPass.settled >= 1, 'and completed it');
    assert.deepEqual(
      delivered().map(value => value.url),
      ['https://buyer.example/outbox-g1'],
      'the recovered attempt is a real external POST'
    );
    assert.ok(checkpointCalls > checkpointsBefore, 'the recovered outbox attempt ran the durable checkpoint');
    assert.equal(
      (await readIntent(transition.transitionId, recovery.namespace)).attempted,
      1,
      'and pinned the recipient it addressed'
    );

    // The buyer replaces its destination. The pinned recipient must not be
    // re-addressed under the replacement generation.
    const current = await notifications.read(scope);
    await notifications.replace(
      scope,
      [
        {
          subscriber_id: 'account-outbox-subscriber',
          url: 'https://buyer.example/outbox-g2',
          event_types: ['reporting.status_changed'],
        },
      ],
      { expectedGeneration: current.generation }
    );
    await makeClaimEligible(recovery.namespace, transition.transitionId);
    const settled = await recovery.activity.recoverOnce({ ownerToken: 'outbox-worker-two', limit: 1 });
    assert.equal(settled.projected, 1);
    assert.equal(settled.matched, 0, 'the replacement generation is never addressed');
    assert.deepEqual(
      delivered().map(value => value.url),
      ['https://buyer.example/outbox-g1'],
      'no second logical delivery'
    );
    assert.equal(new Set(delivered().map(value => value.body.idempotency_key)).size, 1);
  });

  test('keeps a retryable suppression durably retryable in the delivery outbox', async () => {
    // A retryable suppression must not terminalize the only durable record of
    // the send, or a later POST failure would have nothing to retry from.
    const recovery = isolatedActivity('outbox-retryable');
    await installSubscription('tenant-a', 'principal-retryable', 'account-retryable', 'https://buyer.example/retry');
    const obligation = await putObligation('outbox-retryable', 'account-retryable', recovery.store);
    const transition = await ledger.reconcileReportingStatusLifecycleV1({
      store: recovery.store,
      reporting_obligation_id: obligation.reporting_obligation_id,
      ledgerAsOf: '2026-09-02T01:30:00.000Z',
    });
    assert.ok(transition);
    authorizeDeliveryHook = () => {
      authorizeDeliveryHook = undefined;
      throw new Error('authorization backend unavailable');
    };
    const suppressed = [];
    const failedPass = await recovery.activity.recoverOnce({
      ownerToken: 'outbox-retryable-worker-one',
      limit: 1,
      retryAfterMs: 1,
      onError: error => suppressed.push(error),
    });
    assert.equal(failedPass.projected, 0);
    assert.equal(suppressed.at(-1)?.reason, 'authorization_error');
    const outbox = await pool.query(
      `SELECT state, disposition FROM adcp_webhook_outbox
        WHERE delivery_id LIKE 'notification_%' ORDER BY created_at DESC LIMIT 1`
    );
    assert.equal(outbox.rows.length, 1, 'the send has a durable outbox entry');
    assert.equal(
      outbox.rows[0].state,
      'pending',
      'a retryable suppression leaves the delivery pending for the outbox worker'
    );
    assert.equal(outbox.rows[0].disposition, null, 'and does not terminalize it');

    await makeClaimEligible(recovery.namespace, transition.transitionId);
    const recovered = await recovery.activity.recoverOnce({ ownerToken: 'outbox-retryable-worker-two', limit: 1 });
    assert.equal(recovered.projected, 1);
    assert.equal(fetchCalls.filter(value => value.body.notification_id === transition.transitionId).length, 1);
  });

  test('revises one stale recipient without unpinning a sibling that was already addressed', async () => {
    // Per-recipient granularity: subscriber A is addressed, subscriber B goes
    // stale before its own first POST. B must be re-resolved and delivered; A
    // must stay pinned and must not be addressed again.
    const recovery = isolatedActivity('sibling-fanout');
    const scopeA = { kind: 'account', tenantId: 'tenant-a', principalId: 'principal-sib', accountId: 'account-sib' };
    await notifications.replace(scopeA, [
      { subscriber_id: 'sib-a', url: 'https://buyer.example/sib-a', event_types: ['reporting.status_changed'] },
      { subscriber_id: 'sib-b', url: 'https://buyer.example/sib-b-g1', event_types: ['reporting.status_changed'] },
    ]);
    const obligation = await putObligation('sibling-fanout', 'account-sib', recovery.store);
    const transition = await ledger.reconcileReportingStatusLifecycleV1({
      store: recovery.store,
      reporting_obligation_id: obligation.reporting_obligation_id,
      ledgerAsOf: '2026-09-02T01:30:00.000Z',
    });
    assert.ok(transition);
    const delivered = () => fetchCalls.filter(value => value.body.notification_id === transition.transitionId);

    // Replace only sib-b, after the set is frozen: sib-a is addressed in this
    // pass, sib-b is suppressed stale before its own POST.
    let straddled = false;
    const straddleRuntime = ledger.createPostgresReportingNotificationActivityRuntime({
      db: pool,
      namespace: recovery.namespace,
      tenantScopeForAccount: () => 'tenant-a',
      notifications: {
        hasDeliveryAttemptCheckpoint: true,
        emit: event =>
          notifications.emit({
            ...event,
            freezeRecipients: async candidates => {
              const frozen = await event.freezeRecipients(candidates);
              if (!straddled) {
                straddled = true;
                const current = await notifications.read(scopeA);
                await notifications.replace(
                  scopeA,
                  [
                    {
                      subscriber_id: 'sib-a',
                      url: 'https://buyer.example/sib-a',
                      event_types: ['reporting.status_changed'],
                    },
                    {
                      subscriber_id: 'sib-b',
                      url: 'https://buyer.example/sib-b-g2',
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
      ownerToken: 'sibling-worker-one',
      limit: 1,
      retryAfterMs: 1,
      onError: error => errors.push(error),
    });
    assert.equal(straddledPass.projected, 0, 'the claim is not settled while one recipient is unresolved');
    assert.equal(errors.at(-1)?.reason, 'subscription_stale');
    assert.deepEqual(
      delivered().map(value => value.url),
      ['https://buyer.example/sib-a']
    );
    const straddledIntent = await readIntent(transition.transitionId, recovery.namespace);
    assert.equal(straddledIntent.attempted, 1, 'only the addressed sibling is pinned');

    await makeClaimEligible(recovery.namespace, transition.transitionId);
    const recovered = await recovery.activity.recoverOnce({ ownerToken: 'sibling-worker-two', limit: 1 });
    assert.equal(recovered.projected, 1);
    assert.deepEqual(
      delivered()
        .map(value => value.url)
        .sort(),
      ['https://buyer.example/sib-a', 'https://buyer.example/sib-b-g2'],
      'the stale sibling is re-resolved and delivered; the pinned one is not re-addressed'
    );
    const finalIntent = await readIntent(transition.transitionId, recovery.namespace);
    assert.equal(finalIntent.recipients.length, 2, 'the superseded sibling row was replaced, not accumulated');
    assert.equal(finalIntent.unsettled, 0);
  });

  test('replaces rather than accumulates recipient rows across many pre-attempt retries', async () => {
    // Unbounded growth check: every pre-attempt retry re-resolves a different
    // destination generation, and the stored intent must stay at one row.
    const recovery = isolatedActivity('no-accumulation');
    const scope = { kind: 'account', tenantId: 'tenant-a', principalId: 'principal-grow', accountId: 'account-grow' };
    await installSubscription(scope.tenantId, scope.principalId, scope.accountId, 'https://buyer.example/grow-0');
    const obligation = await putObligation('no-accumulation', scope.accountId, recovery.store);
    const transition = await ledger.reconcileReportingStatusLifecycleV1({
      store: recovery.store,
      reporting_obligation_id: obligation.reporting_obligation_id,
      ledgerAsOf: '2026-09-02T01:30:00.000Z',
    });
    assert.ok(transition);
    const churnRuntime = ledger.createPostgresReportingNotificationActivityRuntime({
      db: pool,
      namespace: recovery.namespace,
      tenantScopeForAccount: () => 'tenant-a',
      notifications: {
        hasDeliveryAttemptCheckpoint: true,
        emit: event =>
          notifications.emit({
            ...event,
            freezeRecipients: async candidates => {
              await event.freezeRecipients(candidates);
              throw new Error('released before any external attempt');
            },
          }),
      },
    });
    for (let round = 1; round <= 6; round += 1) {
      await makeClaimEligible(recovery.namespace, transition.transitionId);
      await churnRuntime.recoverOnce({ ownerToken: `grow-worker-${round}`, limit: 1, retryAfterMs: 1 });
      const current = await notifications.read(scope);
      await notifications.replace(
        scope,
        [
          {
            subscriber_id: 'account-grow-subscriber',
            url: `https://buyer.example/grow-${round}`,
            event_types: ['reporting.status_changed'],
          },
        ],
        { expectedGeneration: current.generation }
      );
      const intent = await readIntent(transition.transitionId, recovery.namespace);
      assert.equal(intent.recipients.length, 1, `round ${round}: exactly one stored recipient`);
      assert.equal(intent.attempted, 0, `round ${round}: nothing was ever addressed`);
    }
  });

  test('passes a non-reporting notification through the reporting checkpoint untouched', async () => {
    // The checkpoint hook is runtime-wide. A notification from another
    // subsystem has no frozen reporting recipient, and failing closed on it
    // would suppress every one of its attempts until the retry horizon expired.
    const scope = { kind: 'caller', tenantId: 'tenant-a', principalId: 'principal-other' };
    const before = fetchCalls.length;
    await notifications.replace(scope, [
      {
        subscriber_id: 'other-subscriber',
        url: 'https://buyer.example/other-subsystem',
        event_types: ['capabilities.changed'],
      },
    ]);
    const emitted = await notifications.emit({
      emissionId: 'emission-other-subsystem',
      notificationId: 'notification-other-subsystem',
      notificationType: 'capabilities.changed',
      anchor: 'caller',
      tenantId: scope.tenantId,
      principalId: scope.principalId,
      payload: { repair: '/capabilities' },
    });
    assert.equal(emitted.deliveries.length, 1);
    assert.equal(emitted.deliveries[0].result?.suppression, undefined, 'it is not suppressed');
    assert.equal(emitted.deliveries[0].result?.delivered, true);
    assert.equal(fetchCalls.length, before + 1, 'the unrelated subsystem still delivers');
  });

  test('never lets a checkpoint racing a replacement address two generations', async () => {
    // Controlled trace of the race: the checkpoint for generation one is held
    // open while generation two is frozen from a snapshot that cannot see it.
    // PostgreSQL keeps both rows, so only a database-level arbiter can stop
    // both from being POSTed under distinct idempotency keys.
    const scope = { kind: 'account', tenantId: 'tenant-a', principalId: 'principal-race', accountId: 'account-race' };
    const recovery = isolatedActivity('checkpoint-race');
    await installSubscription(scope.tenantId, scope.principalId, scope.accountId, 'https://buyer.example/race-g1');
    const obligation = await putObligation('checkpoint-race', scope.accountId, recovery.store);
    const transition = await ledger.reconcileReportingStatusLifecycleV1({
      store: recovery.store,
      reporting_obligation_id: obligation.reporting_obligation_id,
      ledgerAsOf: '2026-09-02T01:30:00.000Z',
    });
    assert.ok(transition);
    const delivered = () => fetchCalls.filter(value => value.body.notification_id === transition.transitionId);

    // Freeze generation one and leave it unattempted.
    const freezeOnly = ledger.createPostgresReportingNotificationActivityRuntime({
      db: pool,
      namespace: recovery.namespace,
      tenantScopeForAccount: () => 'tenant-a',
      hasDeliveryAttemptCheckpoint: true,
      notifications: {
        hasDeliveryAttemptCheckpoint: true,
        emit: event =>
          notifications.emit({
            ...event,
            freezeRecipients: async candidates => {
              await event.freezeRecipients(candidates);
              throw new Error('stop before any attempt');
            },
          }),
      },
    });
    await freezeOnly.recoverOnce({ ownerToken: 'race-freeze', limit: 1, retryAfterMs: 1 });
    const frozen = await readIntent(transition.transitionId, recovery.namespace);
    assert.equal(frozen.recipients.length, 1);
    assert.equal(frozen.attempted, 0);
    const generationOne = frozen.recipients[0];

    // Hold the generation-one checkpoint open in its own transaction, so the
    // concurrent freeze cannot observe it.
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      const checkpointRace = ledger.createPostgresReportingNotificationAttemptCheckpoint({
        db: holder,
        namespace: recovery.namespace,
      });
      await checkpointRace({
        scope: generationOne.scope,
        eventAnchor: 'account',
        accountId: scope.accountId,
        subscriberId: generationOne.subscriberId,
        destinationGeneration: generationOne.destinationGeneration,
        eventType: 'reporting.status_changed',
        notificationId: transition.transitionId,
        signal: new AbortController().signal,
      });

      // Generation two is frozen from a snapshot that predates that commit.
      const current = await notifications.read(scope);
      await notifications.replace(
        scope,
        [
          {
            subscriber_id: 'account-race-subscriber',
            url: 'https://buyer.example/race-g2',
            event_types: ['reporting.status_changed'],
          },
        ],
        { expectedGeneration: current.generation }
      );
      await makeClaimEligible(recovery.namespace, transition.transitionId);
      const racingFreeze = freezeOnly.recoverOnce({ ownerToken: 'race-freeze-two', limit: 1, retryAfterMs: 1 });
      await new Promise(resolve => setTimeout(resolve, 150));
      await holder.query('COMMIT');
      await racingFreeze;
    } finally {
      holder.release();
    }

    // Both generations can be stored, but only one can ever be addressed.
    const raced = await readIntent(transition.transitionId, recovery.namespace);
    assert.ok(raced.recipients.length >= 1);
    assert.equal(raced.attempted, 1, 'exactly one generation is addressable');
    const secondGeneration = (await notifications.read(scope)).notificationConfigs[0].destination_generation;
    await assert.rejects(
      () =>
        ledger.createPostgresReportingNotificationAttemptCheckpoint({
          db: pool,
          namespace: recovery.namespace,
        })({
          scope: generationOne.scope,
          eventAnchor: 'account',
          accountId: scope.accountId,
          subscriberId: 'account-race-subscriber',
          destinationGeneration: secondGeneration,
          eventType: 'reporting.status_changed',
          notificationId: transition.transitionId,
          signal: new AbortController().signal,
        }),
      /could not be checkpointed|no frozen recipient/,
      'the second generation can never be checkpointed, so it can never be POSTed'
    );

    await makeClaimEligible(recovery.namespace, transition.transitionId);
    const settled = await recovery.activity.recoverOnce({ ownerToken: 'race-settle', limit: 1 });
    assert.equal(settled.projected, 1);
    assert.ok(delivered().length <= 1, 'at most one logical delivery');
    assert.equal(new Set(delivered().map(value => value.body.idempotency_key)).size <= 1, true);
  });

  test('bounds retained recipient rows while distinct subscribers keep settling', async () => {
    // One recipient stays retryable forever while a fresh subscriber settles on
    // every pass. Counting only the addressable recipients let the retained
    // terminal rows grow without bound under a pending claim.
    const scope = { kind: 'account', tenantId: 'tenant-a', principalId: 'principal-bound', accountId: 'account-bound' };
    const recovery = isolatedActivity('retained-bound', { maxRecipients: 4 });
    const stuck = {
      subscriber_id: 'bound-stuck',
      url: 'https://buyer.example/bound-stuck',
      event_types: ['reporting.status_changed'],
    };
    await notifications.replace(scope, [stuck]);
    const obligation = await putObligation('retained-bound', scope.accountId, recovery.store);
    const transition = await ledger.reconcileReportingStatusLifecycleV1({
      store: recovery.store,
      reporting_obligation_id: obligation.reporting_obligation_id,
      ledgerAsOf: '2026-09-02T01:30:00.000Z',
    });
    assert.ok(transition);
    // The stuck subscriber can never establish authority, so it never settles.
    authorizeDeliveryHook = input =>
      input.subscriberId === 'bound-stuck'
        ? (() => {
            throw new Error('authorization backend unavailable for the stuck subscriber');
          })()
        : { authorized: true };
    try {
      for (let round = 1; round <= 6; round += 1) {
        const current = await notifications.read(scope);
        await notifications.replace(
          scope,
          [
            stuck,
            {
              subscriber_id: `bound-fresh-${round}`,
              url: `https://buyer.example/bound-fresh-${round}`,
              event_types: ['reporting.status_changed'],
            },
          ],
          { expectedGeneration: current.generation }
        );
        await makeClaimEligible(recovery.namespace, transition.transitionId);
        await recovery.activity.recoverOnce({ ownerToken: `bound-worker-${round}`, limit: 1, retryAfterMs: 1 });
        const retained = await pool.query(
          `SELECT count(*)::integer AS total FROM adcp_reporting_notification_activity_recipients
            WHERE namespace = $1 AND transition_id = $2`,
          [recovery.namespace, transition.transitionId]
        );
        assert.ok(
          retained.rows[0].total <= 4,
          `round ${round}: retained rows stay within maxRecipients (saw ${retained.rows[0].total})`
        );
      }
    } finally {
      authorizeDeliveryHook = undefined;
    }
    // The claim never settled — it is bounded and loud, not silently growing.
    assert.equal((await readIntent(transition.transitionId, recovery.namespace)).state, 'pending');
  });

  test('settles a delivery whose binding is retired instead of retrying it forever', async () => {
    // A checkpointed recipient past its retry horizon can never be delivered.
    // Flattening that into a retryable failure holds the claim open until the
    // tenant's pending capacity is exhausted.
    const recovery = isolatedActivity('retired-binding');
    await installSubscription('tenant-a', 'principal-retired', 'account-retired', 'https://buyer.example/retired');
    const obligation = await putObligation('retired-binding', 'account-retired', recovery.store);
    const transition = await ledger.reconcileReportingStatusLifecycleV1({
      store: recovery.store,
      reporting_obligation_id: obligation.reporting_obligation_id,
      ledgerAsOf: '2026-09-02T01:30:00.000Z',
    });
    assert.ok(transition);
    const terminalRuntime = ledger.createPostgresReportingNotificationActivityRuntime({
      db: pool,
      namespace: recovery.namespace,
      tenantScopeForAccount: () => 'tenant-a',
      notifications: {
        hasDeliveryAttemptCheckpoint: true,
        emit: async event => {
          const resolved = [];
          await event.freezeRecipients(
            (
              await notifications.read({
                kind: 'account',
                tenantId: 'tenant-a',
                principalId: 'principal-retired',
                accountId: 'account-retired',
              })
            ).notificationConfigs.map(config => {
              const recipient = {
                scope: {
                  kind: 'account',
                  tenantId: 'tenant-a',
                  principalId: 'principal-retired',
                  accountId: 'account-retired',
                },
                subscriberId: config.subscriber_id,
                destinationGeneration: config.destination_generation,
              };
              resolved.push(recipient);
              return recipient;
            })
          );
          return {
            notificationId: event.notificationId,
            emissionId: event.emissionId,
            matched: resolved.length,
            deliveries: resolved.map(recipient => ({
              ...recipient,
              failure: { reason: 'delivery_binding_retired', terminal: true },
            })),
          };
        },
      },
    });
    const pass = await terminalRuntime.recoverOnce({ ownerToken: 'retired-worker', limit: 1 });
    assert.equal(pass.projected, 1, 'a terminal binding settles the activity rather than holding it pending');
    const intent = await readIntent(transition.transitionId, recovery.namespace);
    assert.equal(intent.state, 'projected');
    assert.equal(intent.unsettled, 0);
    assert.deepEqual(
      intent.rows.map(row => row.disposition),
      ['terminal']
    );
    assert.equal(fetchCalls.filter(value => value.body.notification_id === transition.transitionId).length, 0);
  });

  test('refuses a notification port that cannot prove it checkpoints attempts', async () => {
    assert.throws(
      () =>
        ledger.createPostgresReportingNotificationActivityRuntime({
          db: pool,
          namespace: 'reporting-activity-tests',
          tenantScopeForAccount: () => 'tenant-a',
          notifications: { emit: async () => ({ notificationId: 'x', emissionId: 'y', matched: 0, deliveries: [] }) },
        }),
      /durable pre-POST attempt checkpoint/,
      'a bare custom { emit } port fails closed'
    );
    await assert.rejects(
      () =>
        ledger
          .createPostgresReportingNotificationActivityRuntime({
            db: pool,
            namespace: 'reporting-activity-tests',
            tenantScopeForAccount: () => 'tenant-a',
            acknowledgeMissingAttemptCheckpoint: true,
            notifications: {
              emit: async () => ({ notificationId: 'x', emissionId: 'y', matched: 0, deliveries: [] }),
            },
          })
          .probe(),
      /does not prove it runs the durable/,
      'and the acknowledged form still fails the startup probe'
    );
  });

  test('never exceeds the recipient bound when a checkpoint races a replacement at the limit', async () => {
    // Bound enforcement and replacement must be one statement. Measuring first
    // let a concurrent checkpoint turn a revisable row into a pinned one before
    // the write landed, so the retained set overshot the bound and every later
    // freeze then refused — permanently, since the refusal preceded compaction.
    const scope = {
      kind: 'account',
      tenantId: 'tenant-a',
      principalId: 'principal-atomic',
      accountId: 'account-atomic',
    };
    const recovery = isolatedActivity('bound-atomic', { maxRecipients: 1 });
    await installSubscription(scope.tenantId, scope.principalId, scope.accountId, 'https://buyer.example/atomic-g1');
    const obligation = await putObligation('bound-atomic', scope.accountId, recovery.store);
    const transition = await ledger.reconcileReportingStatusLifecycleV1({
      store: recovery.store,
      reporting_obligation_id: obligation.reporting_obligation_id,
      ledgerAsOf: '2026-09-02T01:30:00.000Z',
    });
    assert.ok(transition);
    const retainedCount = async () =>
      (
        await pool.query(
          `SELECT count(*)::integer AS total FROM adcp_reporting_notification_activity_recipients
            WHERE namespace = $1 AND transition_id = $2`,
          [recovery.namespace, transition.transitionId]
        )
      ).rows[0].total;

    const freezeOnly = ledger.createPostgresReportingNotificationActivityRuntime({
      db: pool,
      namespace: recovery.namespace,
      maxRecipients: 1,
      tenantScopeForAccount: () => 'tenant-a',
      notifications: {
        hasDeliveryAttemptCheckpoint: true,
        emit: event =>
          notifications.emit({
            ...event,
            freezeRecipients: async candidates => {
              const frozen = await event.freezeRecipients(candidates);
              throw new Error('stop before any attempt');
            },
          }),
      },
    });
    await freezeOnly.recoverOnce({ ownerToken: 'atomic-freeze', limit: 1, retryAfterMs: 1 });
    const frozen = await readIntent(transition.transitionId, recovery.namespace);
    assert.equal(frozen.recipients.length, 1);
    const generationOne = frozen.recipients[0];

    // Hold the generation-one checkpoint open so the racing freeze cannot see
    // it, then replace the destination and freeze from that stale snapshot.
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await ledger.createPostgresReportingNotificationAttemptCheckpoint({
        db: holder,
        namespace: recovery.namespace,
      })({
        scope: generationOne.scope,
        eventAnchor: 'account',
        accountId: scope.accountId,
        subscriberId: generationOne.subscriberId,
        destinationGeneration: generationOne.destinationGeneration,
        eventType: 'reporting.status_changed',
        notificationId: transition.transitionId,
        signal: new AbortController().signal,
      });
      const current = await notifications.read(scope);
      await notifications.replace(
        scope,
        [
          {
            subscriber_id: 'account-atomic-subscriber',
            url: 'https://buyer.example/atomic-g2',
            event_types: ['reporting.status_changed'],
          },
        ],
        { expectedGeneration: current.generation }
      );
      await makeClaimEligible(recovery.namespace, transition.transitionId);
      const racing = freezeOnly.recoverOnce({ ownerToken: 'atomic-freeze-two', limit: 1, retryAfterMs: 1 });
      await new Promise(resolve => setTimeout(resolve, 150));
      await holder.query('COMMIT');
      await racing;
    } finally {
      holder.release();
    }
    assert.ok((await retainedCount()) <= 1, `the race never pushes the retained set past the bound`);

    // And the notification still converges: it is not stranded behind a bound
    // that no later pass could satisfy.
    await makeClaimEligible(recovery.namespace, transition.transitionId);
    const settled = await recovery.activity.recoverOnce({ ownerToken: 'atomic-settle', limit: 1 });
    assert.equal(settled.projected, 1, 'the claim settles rather than being stranded');
    assert.ok((await retainedCount()) <= 1);
    assert.ok(
      fetchCalls.filter(value => value.body.notification_id === transition.transitionId).length <= 1,
      'at most one logical delivery'
    );
  });

  test('refuses an over-budget recipient set without mutating anything', async () => {
    // A refusal must leave the stored intent exactly as it was, so a later pass
    // with a workable bound can still make progress.
    const scope = {
      kind: 'account',
      tenantId: 'tenant-a',
      principalId: 'principal-refuse',
      accountId: 'account-refuse',
    };
    const recovery = isolatedActivity('bound-refuse', { maxRecipients: 1 });
    await notifications.replace(scope, [
      { subscriber_id: 'refuse-a', url: 'https://buyer.example/refuse-a', event_types: ['reporting.status_changed'] },
    ]);
    const obligation = await putObligation('bound-refuse', scope.accountId, recovery.store);
    const transition = await ledger.reconcileReportingStatusLifecycleV1({
      store: recovery.store,
      reporting_obligation_id: obligation.reporting_obligation_id,
      ledgerAsOf: '2026-09-02T01:30:00.000Z',
    });
    assert.ok(transition);
    // One subscriber is already retained as settled, so a single new candidate
    // is still one recipient too many: this exercises the retained budget, not
    // the candidate-count guard.
    await pool.query(
      `INSERT INTO adcp_reporting_notification_activity_recipients
         (namespace, transition_id, recipient_fingerprint, subscriber_key, recipient, settled_at, disposition)
       VALUES ($1, $2, $3, $4, $5::jsonb, clock_timestamp(), 'delivered')`,
      [
        recovery.namespace,
        transition.transitionId,
        'a'.repeat(64),
        'b'.repeat(64),
        JSON.stringify({ scope, subscriberId: 'refuse-settled', destinationGeneration: 'dest_settled' }),
      ]
    );
    const overflowing = ledger.createPostgresReportingNotificationActivityRuntime({
      db: pool,
      namespace: recovery.namespace,
      maxRecipients: 1,
      tenantScopeForAccount: () => 'tenant-a',
      notifications: {
        hasDeliveryAttemptCheckpoint: true,
        emit: event => event.freezeRecipients([{ scope, subscriberId: 'refuse-a', destinationGeneration: 'dest_a' }]),
      },
    });
    const errors = [];
    const pass = await overflowing.recoverOnce({
      ownerToken: 'refuse-worker',
      limit: 1,
      retryAfterMs: 1,
      onError: error => errors.push(error),
    });
    assert.equal(pass.projected, 0);
    assert.match(errors.at(-1)?.message ?? '', /would hold 2 recipients, above maxRecipients 1/);
    const stored = await pool.query(
      `SELECT recipient_fingerprint FROM adcp_reporting_notification_activity_recipients
        WHERE namespace = $1 AND transition_id = $2`,
      [recovery.namespace, transition.transitionId]
    );
    assert.deepEqual(
      stored.rows.map(row => row.recipient_fingerprint),
      ['a'.repeat(64)],
      'the refusal mutated nothing: no insert, and the retained row survives'
    );

    // Raising the bound is the documented remedy, and the claim self-heals:
    // the refusal left no state behind that could block it.
    const widened = ledger.createPostgresReportingNotificationActivityRuntime({
      db: pool,
      notifications,
      namespace: recovery.namespace,
      maxRecipients: 4,
      tenantScopeForAccount: () => 'tenant-a',
    });
    await makeClaimEligible(recovery.namespace, transition.transitionId);
    const recovered = await widened.recoverOnce({ ownerToken: 'refuse-worker-two', limit: 1 });
    assert.equal(recovered.projected, 1, 'the claim is not stranded by the refusal');
    assert.equal(fetchCalls.filter(value => value.body.notification_id === transition.transitionId).length, 1);
  });

  test('compacts superseded terminal history before refusing on the recipient bound', async () => {
    // The refusal used to precede compaction, so a bound that compaction could
    // have satisfied stranded the notification permanently.
    const scope = {
      kind: 'account',
      tenantId: 'tenant-a',
      principalId: 'principal-compact',
      accountId: 'account-compact',
    };
    const recovery = isolatedActivity('bound-compact', { maxRecipients: 2 });
    await installSubscription(scope.tenantId, scope.principalId, scope.accountId, 'https://buyer.example/compact');
    const obligation = await putObligation('bound-compact', scope.accountId, recovery.store);
    const transition = await ledger.reconcileReportingStatusLifecycleV1({
      store: recovery.store,
      reporting_obligation_id: obligation.reporting_obligation_id,
      ledgerAsOf: '2026-09-02T01:30:00.000Z',
    });
    assert.ok(transition);
    // Two superseded generations of one already-settled subscriber. They are
    // reclaimable: only one row per subscriber carries any meaning.
    for (const [fingerprint, generation] of [
      ['c'.repeat(64), 'dest_old_one'],
      ['d'.repeat(64), 'dest_old_two'],
    ]) {
      await pool.query(
        `INSERT INTO adcp_reporting_notification_activity_recipients
           (namespace, transition_id, recipient_fingerprint, subscriber_key, recipient, settled_at, disposition)
         VALUES ($1, $2, $3, $4, $5::jsonb, clock_timestamp(), 'delivered')`,
        [
          recovery.namespace,
          transition.transitionId,
          fingerprint,
          'e'.repeat(64),
          JSON.stringify({ scope, subscriberId: 'compact-old', destinationGeneration: generation }),
        ]
      );
    }
    const before = await pool.query(
      `SELECT count(*)::integer AS total FROM adcp_reporting_notification_activity_recipients
        WHERE namespace = $1 AND transition_id = $2`,
      [recovery.namespace, transition.transitionId]
    );
    assert.equal(before.rows[0].total, 2);

    // Two retained rows plus the live recipient is three, above the bound of
    // two — unless the superseded pair is compacted first.
    await makeClaimEligible(recovery.namespace, transition.transitionId);
    const pass = await recovery.activity.recoverOnce({ ownerToken: 'compact-worker', limit: 1 });
    assert.equal(pass.projected, 1, 'compaction reclaims the superseded row, so the claim is not stranded');
    const after = await pool.query(
      `SELECT count(*)::integer AS total FROM adcp_reporting_notification_activity_recipients
        WHERE namespace = $1 AND transition_id = $2`,
      [recovery.namespace, transition.transitionId]
    );
    assert.equal(after.rows[0].total, 2, 'one row per subscriber survives: the compacted one and the live one');
    assert.equal(fetchCalls.filter(value => value.body.notification_id === transition.transitionId).length, 1);
  });

  test('keeps owning the reporting event when the checkpoint is configured for another', async () => {
    // Configuration extends the owned set; it can never remove the reporting
    // event, which would silently stop checkpointing reporting deliveries while
    // the runtime still advertised checkpoint support.
    const recovery = isolatedActivity('event-ownership');
    await installSubscription('tenant-a', 'principal-own', 'account-own', 'https://buyer.example/own');
    const obligation = await putObligation('event-ownership', 'account-own', recovery.store);
    const transition = await ledger.reconcileReportingStatusLifecycleV1({
      store: recovery.store,
      reporting_obligation_id: obligation.reporting_obligation_id,
      ledgerAsOf: '2026-09-02T01:30:00.000Z',
    });
    assert.ok(transition);
    // Freeze the recipient set without attempting, so a checkpoint is required.
    const freezeOnly = ledger.createPostgresReportingNotificationActivityRuntime({
      db: pool,
      namespace: recovery.namespace,
      tenantScopeForAccount: () => 'tenant-a',
      notifications: {
        hasDeliveryAttemptCheckpoint: true,
        emit: event =>
          notifications.emit({
            ...event,
            freezeRecipients: async candidates => {
              await event.freezeRecipients(candidates);
              throw new Error('stop before any attempt');
            },
          }),
      },
    });
    await freezeOnly.recoverOnce({ ownerToken: 'ownership-freeze', limit: 1, retryAfterMs: 1 });
    const frozen = await readIntent(transition.transitionId, recovery.namespace);
    assert.equal(frozen.recipients.length, 1);

    // A checkpoint configured only for some other event still checkpoints the
    // reporting delivery.
    const extended = ledger.createPostgresReportingNotificationAttemptCheckpoint({
      db: pool,
      namespace: recovery.namespace,
      eventTypes: ['some.other.event'],
    });
    await extended({
      scope: frozen.recipients[0].scope,
      eventAnchor: 'account',
      accountId: 'account-own',
      subscriberId: frozen.recipients[0].subscriberId,
      destinationGeneration: frozen.recipients[0].destinationGeneration,
      eventType: 'reporting.status_changed',
      notificationId: transition.transitionId,
      signal: new AbortController().signal,
    });
    assert.equal(
      (await readIntent(transition.transitionId, recovery.namespace)).attempted,
      1,
      'the mandatory reporting event is still owned and still checkpointed'
    );
    // The extra event is owned too, and is still failed closed when unfrozen.
    await assert.rejects(
      () =>
        extended({
          scope: frozen.recipients[0].scope,
          eventAnchor: 'account',
          accountId: 'account-own',
          subscriberId: frozen.recipients[0].subscriberId,
          destinationGeneration: frozen.recipients[0].destinationGeneration,
          eventType: 'some.other.event',
          notificationId: 'notification-not-frozen',
          signal: new AbortController().signal,
        }),
      /no frozen recipient/
    );
  });

  test('makes a stale worker a strict no-op after its lease is taken over', async () => {
    // After takeover the stale worker's `leased` source is empty, which made
    // every other source empty and the budget zero — so the gate passed and the
    // delete reaped the successor's frozen recipients. Its checkpoint then had
    // no row to mark, settlement counted nothing outstanding, and an unsent
    // notification could project as delivered.
    const scope = {
      kind: 'account',
      tenantId: 'tenant-a',
      principalId: 'principal-takeover',
      accountId: 'account-takeover',
    };
    const recovery = isolatedActivity('post-fence-takeover');
    await installSubscription(scope.tenantId, scope.principalId, scope.accountId, 'https://buyer.example/takeover');
    const obligation = await putObligation('post-fence-takeover', scope.accountId, recovery.store);
    const transition = await ledger.reconcileReportingStatusLifecycleV1({
      store: recovery.store,
      reporting_obligation_id: obligation.reporting_obligation_id,
      ledgerAsOf: '2026-09-02T01:30:00.000Z',
    });
    assert.ok(transition);
    const storedRecipients = async () =>
      (
        await pool.query(
          `SELECT recipient_fingerprint, settled_at FROM adcp_reporting_notification_activity_recipients
            WHERE namespace = $1 AND transition_id = $2 ORDER BY recipient_fingerprint`,
          [recovery.namespace, transition.transitionId]
        )
      ).rows;

    // The successor freezes its recipient set and leaves it unattempted.
    const freezeOnly = ledger.createPostgresReportingNotificationActivityRuntime({
      db: pool,
      namespace: recovery.namespace,
      tenantScopeForAccount: () => 'tenant-a',
      notifications: {
        hasDeliveryAttemptCheckpoint: true,
        emit: event =>
          notifications.emit({
            ...event,
            freezeRecipients: async candidates => {
              await event.freezeRecipients(candidates);
              throw new Error('stop before any attempt');
            },
          }),
      },
    });
    await freezeOnly.recoverOnce({ ownerToken: 'takeover-successor', limit: 1, retryAfterMs: 1 });
    const successorRows = await storedRecipients();
    assert.equal(successorRows.length, 1, 'the successor has a frozen, unattempted recipient');

    // A worker claims and passes its lease fence, and only then loses the lease
    // to a takeover. That is the window the fence cannot see: the replacement
    // statement still runs, with an empty leased source.
    const errors = [];
    let tookOver = false;
    const racingDb = {
      query: async (text, values) => {
        const result = await pool.query(text, values);
        if (!tookOver && /delivery_intent_at = COALESCE/.test(text)) {
          tookOver = true;
          await pool.query(
            `UPDATE adcp_reporting_notification_activity
                SET lease_owner = 'takeover-thief',
                    lease_version = lease_version + 1,
                    lease_expires_at = clock_timestamp() + INTERVAL '1 hour'
              WHERE namespace = $1 AND transition_id = $2`,
            [recovery.namespace, transition.transitionId]
          );
        }
        return result;
      },
    };
    const stale = ledger.createPostgresReportingNotificationActivityRuntime({
      db: racingDb,
      namespace: recovery.namespace,
      tenantScopeForAccount: () => 'tenant-a',
      notifications: {
        hasDeliveryAttemptCheckpoint: true,
        // The stale worker resolved nothing, so an ungated delete would reap
        // every unattempted row the successor had frozen.
        emit: async event => {
          await event.freezeRecipients([]);
          return { notificationId: event.notificationId, emissionId: event.emissionId, matched: 0, deliveries: [] };
        },
      },
    });
    await makeClaimEligible(recovery.namespace, transition.transitionId);
    const stalePass = await stale.recoverOnce({
      ownerToken: 'takeover-stale',
      limit: 1,
      retryAfterMs: 1,
      onError: error => errors.push(error),
    });
    assert.ok(tookOver, 'the takeover landed inside the post-fence window');
    assert.equal(stalePass.projected, 0, 'a stale worker never projects');
    assert.match(errors.at(-1)?.message ?? '', /the recovery lease was lost/);
    assert.deepEqual(
      await storedRecipients(),
      successorRows,
      'the stale freeze is a strict no-op: the successor recipients are untouched'
    );

    // Hand the claim back and confirm the notification still delivers once.
    await pool.query(
      `UPDATE adcp_reporting_notification_activity
          SET lease_owner = NULL, lease_expires_at = NULL, next_attempt_at = clock_timestamp()
        WHERE namespace = $1 AND transition_id = $2`,
      [recovery.namespace, transition.transitionId]
    );
    const settled = await recovery.activity.recoverOnce({ ownerToken: 'takeover-finish', limit: 1 });
    assert.equal(settled.projected, 1);
    assert.equal(fetchCalls.filter(value => value.body.notification_id === transition.transitionId).length, 1);
  });

  test('blocks a lease takeover while a leaseholder recipient mutation is in flight', async () => {
    // The lease predicate used to read the parent activity row without locking
    // it, which only proved the lease was live when the statement's snapshot
    // was taken. A statement that then blocked on a recipient lock could resume
    // long after a successor had claimed, still see its own lease in that
    // cached snapshot, and delete the successor's recipients. Locking the
    // parent makes lease authority and recipient mutation one serialized act:
    // a takeover cannot complete while a leaseholder's statement is in flight.
    const scope = {
      kind: 'account',
      tenantId: 'tenant-a',
      principalId: 'principal-inflight',
      accountId: 'account-inflight',
    };
    const recovery = isolatedActivity('inflight-takeover');
    await installSubscription(scope.tenantId, scope.principalId, scope.accountId, 'https://buyer.example/inflight');
    const obligation = await putObligation('inflight-takeover', scope.accountId, recovery.store);
    const transition = await ledger.reconcileReportingStatusLifecycleV1({
      store: recovery.store,
      reporting_obligation_id: obligation.reporting_obligation_id,
      ledgerAsOf: '2026-09-02T01:30:00.000Z',
    });
    assert.ok(transition);

    // Freeze a recipient so there is a row for the mutation to block on.
    const freezeOnly = ledger.createPostgresReportingNotificationActivityRuntime({
      db: pool,
      namespace: recovery.namespace,
      tenantScopeForAccount: () => 'tenant-a',
      notifications: {
        hasDeliveryAttemptCheckpoint: true,
        emit: event =>
          notifications.emit({
            ...event,
            freezeRecipients: async candidates => {
              await event.freezeRecipients(candidates);
              throw new Error('stop before any attempt');
            },
          }),
      },
    });
    await freezeOnly.recoverOnce({ ownerToken: 'inflight-freeze', limit: 1, retryAfterMs: 1 });
    assert.equal((await readIntent(transition.transitionId, recovery.namespace)).recipients.length, 1);

    // Hold a row lock on that recipient so the next freeze blocks mid-statement,
    // after its lease predicate has already been evaluated.
    const blocker = await pool.connect();
    let takeover;
    let settled;
    try {
      await blocker.query('BEGIN');
      await blocker.query(
        `SELECT 1 FROM adcp_reporting_notification_activity_recipients
          WHERE namespace = $1 AND transition_id = $2 FOR UPDATE`,
        [recovery.namespace, transition.transitionId]
      );

      // An ordinary delivering pass. Its freeze sits on the recipient lock with
      // its lease predicate already evaluated — precisely the window in which a
      // takeover used to be able to slip past.
      await makeClaimEligible(recovery.namespace, transition.transitionId);
      const inFlight = recovery.activity.recoverOnce({ ownerToken: 'inflight-holder', limit: 1 });
      await new Promise(resolve => setTimeout(resolve, 250));

      // A takeover attempted while that statement is in flight must not win.
      const thief = await pool.connect();
      try {
        await thief.query("SET lock_timeout = '750ms'");
        takeover = await thief
          .query(
            `UPDATE adcp_reporting_notification_activity
                SET lease_owner = 'inflight-thief',
                    lease_version = lease_version + 1,
                    lease_expires_at = clock_timestamp() + INTERVAL '1 hour'
              WHERE namespace = $1 AND transition_id = $2`,
            [recovery.namespace, transition.transitionId]
          )
          .then(() => 'applied')
          .catch(error =>
            /lock timeout|canceling statement/i.test(error.message) ? 'blocked' : `failed: ${error.message}`
          );
      } finally {
        thief.release();
      }
      await blocker.query('COMMIT');
      settled = await inFlight;
    } finally {
      blocker.release();
    }
    assert.equal(
      takeover,
      'blocked',
      'the takeover waits on the parent row the in-flight mutation holds, instead of racing past it'
    );
    // The leaseholder that held the row keeps its authority and completes.
    assert.equal(settled.projected, 1);
    assert.equal(
      (await readIntent(transition.transitionId, recovery.namespace)).recipients.length,
      1,
      'its recipient was never reaped by a racing takeover'
    );
    assert.equal(fetchCalls.filter(value => value.body.notification_id === transition.transitionId).length, 1);
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
        hasDeliveryAttemptCheckpoint: true,
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
        hasDeliveryAttemptCheckpoint: true,
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
        hasDeliveryAttemptCheckpoint: true,
        async emit(event) {
          emissions += 1;
          await event.freezeRecipients([]);
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
    checkpointNamespaces.add(isolatedNamespace);
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
      `SELECT state, delivery_intent_at FROM adcp_reporting_notification_activity
        WHERE namespace = $1 AND transition_id = $2`,
      [intentNamespace, transitionId]
    );
    const recipients = await pool.query(
      `SELECT recipient, attempt_at, settled_at, disposition
         FROM adcp_reporting_notification_activity_recipients
        WHERE namespace = $1 AND transition_id = $2
        ORDER BY recipient_fingerprint`,
      [intentNamespace, transitionId]
    );
    return {
      ...parent.rows[0],
      rows: recipients.rows,
      recipients: recipients.rows.map(row => row.recipient),
      attempted: recipients.rows.filter(row => row.attempt_at !== null).length,
      unsettled: recipients.rows.filter(row => row.settled_at === null).length,
    };
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
