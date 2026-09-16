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
      authorizeDelivery: async () => ({ authorized: true }),
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

  async function installSubscription(tenantId, principalId, accountId, url) {
    const result = await notifications.replace({ kind: 'account', tenantId, principalId, accountId }, [
      { subscriber_id: `${accountId}-subscriber`, url, event_types: ['reporting.status_changed'] },
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

  async function putObligation(suffix, accountId) {
    const configuration = configurationFixture(suffix, accountId);
    await store.putConfiguration(configuration);
    const obligation = obligationFixture(suffix, configuration);
    await store.putObligation(obligation);
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
