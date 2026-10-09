/**
 * PostgreSQL integration tests for ledger maintenance on the general (Core-only)
 * Reliable Reporting service: retention, change-feed pruning, abandoned-upload
 * and snapshot sweeps, driven by `runMaintenance()` and by `start()`.
 *
 * REPORTING_LEDGER_PG_URL=postgres://localhost/test node --test test/lib/reliable-reporting-core-maintenance-pg.test.js
 */
const assert = require('node:assert/strict');
const { existsSync, mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { after, before, describe, test } = require('node:test');

const { createRowStorageFixture } = require('../helpers/reporting-row-storage-fixture.js');

process.env.NODE_ENV = 'test';
const DATABASE_URL = process.env.REPORTING_LEDGER_PG_URL;

function adapter() {
  const source = require('../../dist/lib/reporting/source/index.js');
  const sourceOffering = structuredClone(source.redactedReportingSourceOfferingV1);
  sourceOffering.cadence = {
    ...sourceOffering.cadence,
    expectedAvailabilityLag: 'PT0S',
    worstCaseAvailabilityLag: 'PT0S',
  };
  const deliveryOffering = {
    offering_id: sourceOffering.offeringId,
    feed_purpose: 'analytics',
    report_definition_id: sourceOffering.contract.report_definition_id,
    report_definition_uri: sourceOffering.contract.reportDefinitionUri,
    report_definition_sha256: sourceOffering.contract.reportDefinitionSha256,
    reporting_profile: {
      id: sourceOffering.contract.reportingProfile,
      version: sourceOffering.contract.schemaVersion,
      schema_uri: sourceOffering.contract.schemaUri,
      schema_sha256: sourceOffering.contract.schemaSha256,
      schema_dialect: sourceOffering.contract.schemaDialect,
      schema_ref_policy: sourceOffering.contract.schemaRefPolicy,
      grain: sourceOffering.grain,
      primary_keys: ['media_buy_id'],
    },
    schedule: {
      period_duration: 'P1D',
      alignment: 'source_timezone',
      period_timezone_policy: 'fixed',
      period_timezone: 'UTC',
      delivery_sla: 'PT0S',
    },
    supported_finality: ['snapshot'],
    reconciliation_mode: 'delivery_only',
  };
  return {
    sourceOffering,
    deliveryOffering,
    fetchSlice: request => ({
      reporting_period: { start: request.start_date, end: request.end_date },
      currency: 'USD',
      reporting_rows: [],
    }),
  };
}

describe('Reliable Reporting Core maintenance', { skip: !DATABASE_URL && 'PostgreSQL URL not set' }, () => {
  const schema = `adcp_reporting_core_maintenance_${process.pid}`;
  const rows = Array.from({ length: 30 }, (_, index) => ({ ordinal: index, value: index }));
  let bootstrap;
  let pool;
  let ledger;
  let reporting;
  let root;
  let store;

  const count = async (sql, values = []) => Number((await pool.query(sql, values)).rows[0].n);
  const periodExists = async obligationId =>
    (await count(`SELECT count(*) AS n FROM adcp_reporting_obligations WHERE obligation_id = $1`, [obligationId])) ===
    1;

  async function expire(obligationId, days = 40) {
    await pool.query(
      `UPDATE adcp_reporting_obligations
          SET period_start = period_start - ($2::integer * INTERVAL '1 day'),
              period_end = period_end - ($2::integer * INTERVAL '1 day'),
              created_at = created_at - ($2::integer * INTERVAL '1 day'),
              lease_expires_at = clock_timestamp() - INTERVAL '1 second'
        WHERE obligation_id = $1`,
      [obligationId, days]
    );
    await pool.query(
      `UPDATE adcp_reporting_revisions SET recorded_at = recorded_at - ($2::integer * INTERVAL '1 day')
        WHERE obligation_id = $1`,
      [obligationId, days]
    );
  }

  /** Cursor at the end of the account's feed: a consumer saved here has read every change so far. */
  async function head(accountId) {
    let cursor;
    for (;;) {
      const page = await store.changesAfter({ account_id: accountId, ...(cursor ? { cursor } : {}) });
      cursor = page.cursor;
      if (page.records.length === 0) return cursor;
    }
  }

  function createService(maintenance, overrides = {}) {
    return reporting.createReliableReportingService({
      store,
      adapters: { fixture: adapter() },
      contact: { name: 'Reporting operations', email: 'reporting@example.com' },
      automatedRecoveryWindowSeconds: 86_400,
      statusRetentionDays: 30,
      resolveSource: account => ({
        adapterId: 'fixture',
        sourceScope: { network_id: `network-${account.id}` },
        sourceTimezone: 'UTC',
      }),
      resolveCurrency: () => 'USD',
      resolveCoverage: () => ({ constituents: [] }),
      ...(maintenance ? { maintenance } : {}),
      ...overrides,
    });
  }

  before(async () => {
    const { Pool } = require('pg');
    ledger = require('../../dist/lib/reporting/ledger/index.js');
    reporting = require('../../dist/lib/reporting/service/index.js');
    root = mkdtempSync(path.join(tmpdir(), 'adcp-core-maintenance-'));
    bootstrap = new Pool({ connectionString: DATABASE_URL });
    await bootstrap.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ connectionString: DATABASE_URL, options: `-c search_path="${schema}"` });
    await pool.query(ledger.REPORTING_LEDGER_MIGRATION);
    await pool.query(ledger.REPORTING_ROW_STORAGE_MIGRATION);
    await pool.query(ledger.REPORTING_LEDGER_CHANGES_MIGRATION);
    const rowStorage = {
      bindings: {
        objects: { kind: 'object', provider: 'filesystem', location: { root: 'rows' }, prefix: 'maintained' },
      },
      providers: { filesystem: ledger.createFilesystemReportingRowObjectProviderV1({ roots: { rows: root } }) },
    };
    // The Core-only shape an adopter builds: row storage and a change feed on
    // the store, no production service.
    store = new ledger.PostgresReportingLedgerStore(pool, {
      acknowledgeIsolatedDatabase: true,
      rowStorage,
      changeFeed: true,
    });
    await store.readyRowStorage();
  });

  after(async () => {
    if (pool) await pool.end();
    if (bootstrap) {
      await bootstrap.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await bootstrap.end();
    }
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test('runMaintenance returns one result per task in a stable order', async () => {
    const service = createService({ retention: { enabled: true }, changeFeed: true });
    const results = await service.runMaintenance();
    assert.deepEqual(
      results.map(result => [result.task, result.status]),
      [
        ['snapshot sweep', 'completed'],
        ['row upload sweep', 'completed'],
        ['change-feed pruning', 'completed'],
        ['retention', 'completed'],
      ]
    );
    const byTask = Object.fromEntries(results.map(result => [result.task, result.result]));
    assert.deepEqual(Object.keys(byTask['snapshot sweep']).sort(), ['checkpointsDeleted', 'snapshotsDeleted']);
    assert.deepEqual(Object.keys(byTask['row upload sweep']).sort(), ['failed', 'objectsDeleted', 'swept']);
    assert.deepEqual(Object.keys(byTask['change-feed pruning']), ['deleted']);
    assert.deepEqual(Object.keys(byTask.retention).sort(), ['failed', 'failures', 'retired']);

    // Only the tasks that were asked for run: sweeps are always on.
    const minimal = await createService({}).runMaintenance();
    assert.deepEqual(
      minimal.map(result => result.task),
      ['snapshot sweep', 'row upload sweep']
    );
  });

  test('retires an expired period through the general service, using the advertised status retention', async () => {
    const fixture = await createRowStorageFixture({ store, suffix: 'core_retired' });
    await store.commitRevision(fixture.revision('rrev_core_retired_1', 1, rows), fixture.lease);
    const obligationId = fixture.obligation.reporting_obligation_id;
    const objectKeys = (
      await pool.query(`SELECT object_key FROM adcp_reporting_row_chunks WHERE obligation_id = $1`, [obligationId])
    ).rows.map(row => path.join(root, row.object_key));
    assert.ok(objectKeys.length > 0 && objectKeys.every(existsSync));

    const service = createService({ retention: { enabled: true } });
    const retentionOf = results => results.find(result => result.task === 'retention');
    // Inside the 30-day window nothing is eligible.
    assert.equal(retentionOf(await service.runMaintenance()).result.retired, 0);
    await expire(obligationId, 40);
    // A service that advertises a longer commitment keeps the period.
    const longer = createService({ retention: { enabled: true } }, { statusRetentionDays: 90 });
    assert.equal(retentionOf(await longer.runMaintenance()).result.retired, 0);
    assert.ok(await periodExists(obligationId));

    const retired = retentionOf(await service.runMaintenance());
    assert.equal(retired.status, 'completed');
    assert.equal(retired.result.retired, 1);
    assert.equal(await periodExists(obligationId), false);
    assert.ok(
      objectKeys.every(key => !existsSync(key)),
      'row objects are deleted with the period'
    );
  });

  test('a registered feed consumer holds an expired period until it has read it', async () => {
    const fixture = await createRowStorageFixture({ store, suffix: 'core_hold' });
    const accountId = fixture.request.account.account_id;
    const obligationId = fixture.obligation.reporting_obligation_id;
    await pool.query('DELETE FROM adcp_reporting_feed_consumers');
    await store.saveFeedConsumerCursor('sink', await head(accountId));
    await store.commitRevision(fixture.revision('rrev_core_hold_1', 1, rows), fixture.lease);
    await expire(obligationId);

    const service = createService({ retention: { enabled: true }, changeFeed: true });
    const retention = async () => (await service.runMaintenance()).find(result => result.task === 'retention');
    assert.equal((await retention()).result.retired, 0);
    assert.ok(await periodExists(obligationId), 'an unread period is held, not retired');

    // Consumer stale for 10 days: the default 7-day hold lets go, a 30-day hold does not.
    await pool.query(`UPDATE adcp_reporting_feed_consumers SET updated_at = clock_timestamp() - INTERVAL '10 days'`);
    const patient = createService({
      retention: { enabled: true },
      changeFeed: { maxFeedHoldDays: 30 },
    });
    assert.equal(
      (await patient.runMaintenance()).find(result => result.task === 'retention').result.retired,
      0,
      'maxFeedHoldDays reaches retention, not only pruning'
    );
    assert.ok(await periodExists(obligationId));
    assert.equal((await retention()).result.retired, 1);
    assert.equal(await periodExists(obligationId), false);
    await pool.query('DELETE FROM adcp_reporting_feed_consumers');
  });

  test('prunes change-feed rows past changeRetentionDays', async () => {
    const fixture = await createRowStorageFixture({ store, suffix: 'core_prune' });
    await pool.query('DELETE FROM adcp_reporting_feed_consumers');
    await store.commitRevision(fixture.revision('rrev_core_prune_1', 1, rows), fixture.lease);
    await pool.query(
      `UPDATE adcp_reporting_changes SET recorded_at = recorded_at - INTERVAL '40 days'
        WHERE obligation_id = $1`,
      [fixture.obligation.reporting_obligation_id]
    );
    const service = createService({ changeFeed: { changeRetentionDays: 30 } });
    const pruned = (await service.runMaintenance()).find(result => result.task === 'change-feed pruning');
    assert.ok(pruned.result.deleted >= 1);
    assert.equal(
      await count(`SELECT count(*) AS n FROM adcp_reporting_changes WHERE obligation_id = $1`, [
        fixture.obligation.reporting_obligation_id,
      ]),
      0
    );
  });

  test('sweeps expired cursor snapshots', async () => {
    await pool.query(
      `INSERT INTO adcp_reporting_snapshots (snapshot_id, account_id, query_fingerprint, data, byte_count, expires_at)
       VALUES (gen_random_uuid(), 'account-x', 'fingerprint', '{}'::jsonb, 2, clock_timestamp() - INTERVAL '1 hour')`
    );
    assert.equal(await count(`SELECT count(*) AS n FROM adcp_reporting_snapshots WHERE expires_at <= now()`), 1);
    const swept = (await createService({}).runMaintenance()).find(result => result.task === 'snapshot sweep');
    assert.equal(swept.status, 'completed');
    assert.equal(swept.result.snapshotsDeleted, 1);
    assert.equal(await count(`SELECT count(*) AS n FROM adcp_reporting_snapshots WHERE expires_at <= now()`), 0);
  });

  test('reports a failed task without stopping the others, and a pre-aborted signal throws', async () => {
    const failing = Object.create(store);
    failing.pruneChanges = async () => {
      throw new Error('prune exploded');
    };
    const service = createService({ changeFeed: true, retention: { enabled: true } }, { store: failing });
    const results = await service.runMaintenance();
    const failed = results.find(result => result.task === 'change-feed pruning');
    assert.equal(failed.status, 'failed');
    assert.match(failed.error.message, /prune exploded/);
    assert.equal(results.find(result => result.task === 'retention').status, 'completed');

    const controller = new AbortController();
    controller.abort();
    await assert.rejects(() => service.runMaintenance({ signal: controller.signal }));
  });

  test('surfaces a partially failed task on the result', async () => {
    const partial = Object.create(store);
    partial.retireExpiredPeriods = async () => ({
      retired: 0,
      failed: ['robl_stuck'],
      failures: [{ reporting_obligation_id: 'robl_stuck', cause: 'object_delete_failed' }],
    });
    const service = createService({ retention: { enabled: true } }, { store: partial });
    const retention = (await service.runMaintenance()).find(result => result.task === 'retention');
    assert.equal(retention.status, 'completed');
    assert.ok(retention.partialFailure instanceof reporting.ReportingMaintenancePartialFailureError);
    assert.match(retention.partialFailure.message, /robl_stuck \(object_delete_failed\)/);
  });

  describe('scheduler', () => {
    const settle = async (predicate, ms = 5_000) => {
      const deadline = Date.now() + ms;
      while (!predicate()) {
        if (Date.now() > deadline) return false;
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      return true;
    };

    test('runs maintenance on the first pass and then not on every cycle', async t => {
      const calls = [];
      const spied = Object.create(store);
      spied.sweepRowWriteIntents = async input => {
        calls.push(input);
        return { swept: 0, objectsDeleted: 0, failed: 0 };
      };
      let cycles = 0;
      const service = createService({ intervalMilliseconds: 60_000 }, { store: spied });
      service.runCycle = async () => {
        cycles += 1;
        return { planned: 0, claimed: 0, revisionsCommitted: 0, notReady: 0, failed: 0 };
      };
      t.after(() => service.stop());
      service.start({ intervalMilliseconds: 10, accountIds: ['account-a'] });
      assert.equal(await settle(() => cycles >= 5), true, 'the producer cycle keeps its own cadence');
      await service.stop();
      assert.equal(calls.length, 1, 'maintenance is paced by its own interval, not by the cycle');
    });

    test('runs again once its interval elapses', async t => {
      let calls = 0;
      const spied = Object.create(store);
      spied.sweepRowWriteIntents = async () => {
        calls += 1;
        return { swept: 0, objectsDeleted: 0, failed: 0 };
      };
      const service = createService({ intervalMilliseconds: 20 }, { store: spied });
      t.after(() => service.stop());
      service.start({ intervalMilliseconds: 5, accountIds: [] });
      assert.equal(await settle(() => calls >= 3), true);
      await service.stop();
    });

    test('routes maintenance failures and partial failures to onError, and the loop survives', async t => {
      const errors = [];
      const broken = Object.create(store);
      broken.pruneChanges = async () => {
        throw new Error('prune exploded');
      };
      broken.retireExpiredPeriods = async () => ({
        retired: 0,
        failed: ['robl_stuck'],
        failures: [{ reporting_obligation_id: 'robl_stuck', cause: 'object_delete_failed' }],
      });
      let cycles = 0;
      const service = createService(
        { changeFeed: true, retention: { enabled: true }, intervalMilliseconds: 20 },
        {
          store: broken,
        }
      );
      service.runCycle = async () => {
        cycles += 1;
        return { planned: 0, claimed: 0, revisionsCommitted: 0, notReady: 0, failed: 0 };
      };
      t.after(() => service.stop());
      service.start({ intervalMilliseconds: 5, accountIds: ['account-a'], onError: error => errors.push(error) });
      assert.equal(await settle(() => errors.length >= 4), true, 'two failures per pass, across two passes');
      await service.stop();
      assert.ok(cycles >= 2, 'a failing maintenance pass does not stop the producer loop');
      assert.match(errors[0].message, /prune exploded/);
      assert.ok(errors[1] instanceof reporting.ReportingMaintenancePartialFailureError);
      assert.equal(errors[1].task, 'retention');
      assert.deepEqual(errors[1].failedIds, ['robl_stuck (object_delete_failed)']);
    });

    test('warns when no onError is configured, and when maintenance itself throws synchronously', async t => {
      const warnings = [];
      const broken = Object.create(store);
      broken.sweepRowWriteIntents = () => {
        throw new Error('sweep could not start');
      };
      const service = createService({ intervalMilliseconds: 60_000 }, { store: broken });
      t.after(() => service.stop());
      service.start({
        intervalMilliseconds: 60_000,
        accountIds: [],
        logger: { warn: message => warnings.push(message) },
      });
      assert.equal(await settle(() => warnings.length >= 1), true);
      await service.stop();
      assert.match(warnings[0], /^\[adcp\/reporting\] scheduler ledger maintenance failed; the scheduler continues/);
      assert.match(warnings[0], /sweep could not start/);
    });
  });
});
