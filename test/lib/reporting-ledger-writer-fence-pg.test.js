/**
 * PostgreSQL writer-fence tests for the pre-SDK-14 finality cutover.
 *
 * The fence is what makes "at most one redundant finality-only transition per
 * obligation at upgrade" enforceable: without it a pre-SDK-14 writer can keep
 * appending finality-less transitions during a rolling deploy, each of which
 * becomes the latest row and produces another redundant event.
 *
 * NODE_ENV=test REPORTING_LEDGER_PG_URL=postgres://localhost/test \
 *   node --test test/lib/reporting-ledger-writer-fence-pg.test.js
 */
const assert = require('node:assert/strict');
const { after, before, describe, test } = require('node:test');

const DATABASE_URL = process.env.REPORTING_LEDGER_PG_URL;

describe('reporting finality writer fence', { skip: !DATABASE_URL && 'PostgreSQL URL not set' }, () => {
  let bootstrap;
  let ledger;
  // The fence is a table-wide constraint, so each test installs it in its own
  // schema; sharing one would couple the tests to their execution order.
  const deployments = [];

  before(async () => {
    ledger = require('../../dist/lib/reporting/ledger/index.js');
    const { Pool } = require('pg');
    bootstrap = new Pool({ connectionString: DATABASE_URL });
  });

  after(async () => {
    for (const deployment of deployments) {
      await deployment.pool.end();
      await bootstrap.query(`DROP SCHEMA IF EXISTS "${deployment.schema}" CASCADE`);
    }
    if (bootstrap) await bootstrap.end();
  });

  async function createDeployment(suffix) {
    const { Pool } = require('pg');
    const schema = `adcp_reporting_fence_${process.pid}_${suffix}`;
    await bootstrap.query(`CREATE SCHEMA "${schema}"`);
    const pool = new Pool({ connectionString: DATABASE_URL, options: `-c search_path="${schema}"` });
    await pool.query(ledger.REPORTING_LEDGER_MIGRATION);
    const store = new ledger.PostgresReportingLedgerStore(pool, { acknowledgeIsolatedDatabase: true });
    const deployment = { schema, pool, store };
    deployments.push(deployment);
    return deployment;
  }

  test('rejects a legacy-shaped write after cutover while historical rows still reconcile once', async () => {
    const { pool, store } = await createDeployment('cutover');
    const obligation = await seedObligation(pool, store, 'fence');

    // Pre-cutover history: a transition written by a pre-SDK-14 writer, plus a
    // revision, exactly as an upgrading deployment would already have on disk.
    assert.deepEqual(
      await store.appendTransition({
        transitionId: 'rst_fence_historical',
        reporting_obligation_id: obligation.reporting_obligation_id,
        previousHealth: 'waiting',
        health: 'delayed',
        issueIds: [],
        occurredAt: '2026-09-02T01:10:00.000Z',
      }),
      { inserted: true },
      'a legacy-shaped write is accepted before the fence is installed'
    );
    await insertRevision(pool, obligation.reporting_obligation_id, 'rrev_fence_official', 1, 'official');

    // Cutover. Idempotent: running it twice must be a no-op.
    await pool.query(ledger.REPORTING_LEDGER_FINALITY_WRITER_FENCE_MIGRATION);
    await pool.query(ledger.REPORTING_LEDGER_FINALITY_WRITER_FENCE_MIGRATION);
    const installed = await pool.query(
      `SELECT convalidated FROM pg_constraint
        WHERE conrelid = 'adcp_reporting_transitions'::regclass AND conname = $1`,
      [ledger.REPORTING_LEDGER_FINALITY_FENCE_CONSTRAINT]
    );
    assert.equal(installed.rowCount, 1, 'the fence is installed exactly once');
    assert.equal(installed.rows[0].convalidated, false, 'NOT VALID leaves historical rows unvalidated');

    // The historical finality-less row survives the cutover untouched.
    const historical = await store.listTransitions(obligation.reporting_obligation_id);
    assert.equal(historical.length, 1);
    assert.equal(historical[0].finality, undefined, 'the historical row keeps its original shape');

    // A pre-SDK-14 writer that is still running now fails closed.
    await assert.rejects(
      () =>
        store.appendTransition({
          transitionId: 'rst_fence_legacy_writer',
          reporting_obligation_id: obligation.reporting_obligation_id,
          previousHealth: 'delayed',
          health: 'action_required',
          issueIds: [],
          occurredAt: '2026-09-02T01:20:00.000Z',
        }),
      /rejected by the finality writer fence/,
      'a legacy-shaped write after cutover is rejected, not silently accepted'
    );
    assert.equal(
      (await store.listTransitions(obligation.reporting_obligation_id)).length,
      1,
      'the rejected write left no row behind'
    );

    // The historical row still resolves and commits its baseline, and the
    // upgrade produces exactly one redundant finality-only transition.
    const first = await ledger.reconcileReportingStatusLifecycleV1({
      store,
      reporting_obligation_id: obligation.reporting_obligation_id,
      ledgerAsOf: '2026-09-02T02:00:00.000Z',
    });
    assert.ok(first, 'the historical row reconciles under the fence');
    assert.deepEqual(
      [first.previousHealth, first.health, first.previousFinality, first.finality],
      ['delayed', 'complete', 'none', 'official']
    );
    const afterFirst = await store.listTransitions(obligation.reporting_obligation_id);
    assert.deepEqual(
      afterFirst.map(value => value.finality),
      ['none', 'official'],
      'the backfill made the historical row satisfy the fence'
    );

    // Bounded: every later pass is a no-op, so the redundancy is one event.
    for (const ledgerAsOf of ['2026-09-02T02:15:00.000Z', '2026-09-02T02:30:00.000Z']) {
      assert.equal(
        await ledger.reconcileReportingStatusLifecycleV1({
          store,
          reporting_obligation_id: obligation.reporting_obligation_id,
          ledgerAsOf,
        }),
        null
      );
    }
    assert.equal(
      (await store.listTransitions(obligation.reporting_obligation_id)).length,
      2,
      'exactly one redundant finality-only transition, and no more'
    );
  });

  test('without the fence a surviving legacy writer multiplies redundant finality events', async () => {
    // This is the failure the fence exists to make impossible. Nothing here is
    // mocked: the only difference from the cutover test is that the fence
    // migration is never run.
    const { pool, store } = await createDeployment('unfenced');
    const obligation = await seedObligation(pool, store, 'unfenced');
    assert.deepEqual(
      await store.appendTransition({
        transitionId: 'rst_unfenced_historical',
        reporting_obligation_id: obligation.reporting_obligation_id,
        previousHealth: 'waiting',
        health: 'complete',
        issueIds: [],
        occurredAt: '2026-09-02T01:10:00.000Z',
      }),
      { inserted: true }
    );
    await insertRevision(pool, obligation.reporting_obligation_id, 'rrev_unfenced_official', 1, 'official');

    const first = await ledger.reconcileReportingStatusLifecycleV1({
      store,
      reporting_obligation_id: obligation.reporting_obligation_id,
      ledgerAsOf: '2026-09-02T02:00:00.000Z',
    });
    assert.deepEqual(
      [first.previousHealth, first.health, first.previousFinality, first.finality],
      ['complete', 'complete', 'none', 'official'],
      'the first upgrade pass records one redundant finality-only transition'
    );

    // A pre-SDK-14 pod that is still serving appends another finality-less row.
    // Unfenced, the database accepts it and the invariant is gone.
    assert.deepEqual(
      await store.appendTransition({
        transitionId: 'rst_unfenced_rolling_writer',
        reporting_obligation_id: obligation.reporting_obligation_id,
        previousHealth: 'complete',
        health: 'complete',
        issueIds: [],
        occurredAt: '2026-09-02T02:05:00.000Z',
      }),
      { inserted: true },
      'without the fence the legacy-shaped write is accepted'
    );
    const second = await ledger.reconcileReportingStatusLifecycleV1({
      store,
      reporting_obligation_id: obligation.reporting_obligation_id,
      ledgerAsOf: '2026-09-02T02:10:00.000Z',
    });
    assert.ok(second, 'a second redundant finality-only transition appears');
    assert.deepEqual(
      [second.previousFinality, second.finality],
      ['none', 'official'],
      'the redundancy repeats once per surviving legacy write, so it is unbounded'
    );
    assert.equal((await store.listTransitions(obligation.reporting_obligation_id)).length, 4);
  });

  test('keeps legacy notification settlement legal under the fence', async () => {
    const { pool, store } = await createDeployment('notify');
    const obligation = await seedObligation(pool, store, 'notify');
    assert.deepEqual(
      await store.appendTransition({
        transitionId: 'rst_fence_notify_historical',
        reporting_obligation_id: obligation.reporting_obligation_id,
        previousHealth: 'waiting',
        health: 'delayed',
        issueIds: [],
        occurredAt: '2026-09-02T01:10:00.000Z',
      }),
      { inserted: true }
    );
    await pool.query(ledger.REPORTING_LEDGER_FINALITY_WRITER_FENCE_MIGRATION);

    // Settling a pre-fence pending row rewrites its jsonb, so the new row
    // version has to satisfy the fence: the update commits the `none` baseline
    // alongside notifiedAt rather than failing.
    await store.markTransitionNotified('rst_fence_notify_historical', '2026-09-02T01:15:00.000Z');
    const [settled] = await store.listTransitions(obligation.reporting_obligation_id);
    assert.equal(settled.notifiedAt, '2026-09-02T01:15:00.000Z');
    assert.equal(settled.finality, 'none', 'settlement commits the same baseline the resolver would');
    assert.deepEqual(await store.listPendingTransitions(), []);
  });

  async function seedObligation(pool, store, suffix) {
    const configuration = {
      configurationId: `configuration-fence-${suffix}`,
      account: { account_id: `account-fence-${suffix}` },
      sourceScope: { route: `route-fence-${suffix}` },
      delivery_config_id: `delivery-fence-${suffix}`,
      delivery_config_version: 1,
      offeringId: `offering-fence-${suffix}`,
      report_definition_id: `report-fence-${suffix}`,
      feedPurpose: 'analytics',
      requiredFinality: 'snapshot',
      requestedMetrics: ['impressions'],
      requestedDimensions: ['media_buy_id'],
      constituents: [],
      mediaBuyIds: [`media-buy-fence-${suffix}`],
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
      semanticFingerprint: `sha256:fence-${suffix}`,
    };
    await store.putConfiguration(configuration);
    const obligation = {
      reporting_obligation_id: `obligation-fence-${suffix}`,
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
      semanticFingerprint: `sha256:obligation-fence-${suffix}`,
      createdAt: '2026-09-02T00:00:00.000Z',
    };
    await store.putObligation(obligation);
    return obligation;
  }

  async function insertRevision(pool, obligationId, revisionId, revisionNumber, finality) {
    await pool.query(
      `INSERT INTO adcp_reporting_revisions
         (revision_id, obligation_id, revision_number, finality, kind, content_sha256, data, created_at)
       VALUES ($1, $2, $3, $4, $4, $5, $6::jsonb, clock_timestamp())`,
      [
        revisionId,
        obligationId,
        revisionNumber,
        finality,
        `sha256:${revisionId}`,
        JSON.stringify({
          reporting_revision_id: revisionId,
          reporting_obligation_id: obligationId,
          revisionNumber,
          finality,
          kind: finality,
          createdAt: '2026-09-02T01:05:00.000Z',
        }),
      ]
    );
  }
});
