/**
 * PostgreSQL integration tests for the BigQuery warehouse sink, using an
 * in-memory BigQuery double that enforces job-ID uniqueness the way BigQuery does.
 *
 * REPORTING_LEDGER_PG_URL=postgres://localhost/test node --test test/lib/reporting-bigquery-sink-pg.test.js
 */
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { after, before, describe, test } = require('node:test');

const { createRowStorageFixture } = require('../helpers/reporting-row-storage-fixture.js');

const DATABASE_URL = process.env.REPORTING_LEDGER_PG_URL;

function fakeBigQuery() {
  const tables = new Map();
  const jobs = new Map();
  const failures = [];
  return {
    tables,
    jobs,
    failNext(tableId, how) {
      failures.push({ tableId, how });
    },
    dataset(datasetId) {
      return {
        table(tableId) {
          return {
            async load(file, metadata) {
              if (jobs.has(metadata.jobId)) {
                const error = new Error('Already Exists: Job');
                error.code = 409;
                throw error;
              }
              const failure = failures.findIndex(entry => entry.tableId === tableId);
              if (failure >= 0) {
                const [{ how }] = failures.splice(failure, 1);
                if (how === 'network') throw new Error('socket hang up');
                jobs.set(metadata.jobId, { status: { state: 'DONE', errorResult: { reason: 'invalid' } } });
                throw new Error('Job failed');
              }
              const lines = readFileSync(file, 'utf8')
                .split('\n')
                .filter(Boolean)
                .map(line => JSON.parse(line));
              const key = `${datasetId}.${tableId}`;
              tables.set(key, [...(tables.get(key) ?? []), ...lines]);
              jobs.set(metadata.jobId, { status: { state: 'DONE' }, table: key, metadata });
              return [{ id: metadata.jobId }];
            },
          };
        },
      };
    },
    job(jobId) {
      return { getMetadata: async () => [jobs.get(jobId)] };
    },
    async query() {
      return [[]];
    },
  };
}

describe('BigQuery warehouse sink', { skip: !DATABASE_URL && 'PostgreSQL URL not set' }, () => {
  const schema = `adcp_reporting_sink_${process.pid}`;
  let bootstrapPool;
  let pool;
  let ledger;
  let sinkModule;
  let store;
  let fixture;
  const rows = Array.from({ length: 1_200 }, (_, index) => ({ ordinal: index, impressions: index }));

  before(async () => {
    const { Pool } = require('pg');
    ledger = require('../../dist/lib/reporting/ledger/index.js');
    sinkModule = require('../../dist/lib/reporting/bigquery/index.js');
    bootstrapPool = new Pool({ connectionString: DATABASE_URL });
    await bootstrapPool.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ connectionString: DATABASE_URL, options: `-c search_path="${schema}"` });
    await pool.query(ledger.REPORTING_LEDGER_MIGRATION);
    await pool.query(ledger.REPORTING_ROW_STORAGE_MIGRATION);
    await pool.query(ledger.REPORTING_LEDGER_CHANGES_MIGRATION);
    await pool.query(sinkModule.REPORTING_WAREHOUSE_SINK_MIGRATION);
    await pool.query(sinkModule.REPORTING_WAREHOUSE_SINK_MIGRATION);
    store = new ledger.PostgresReportingLedgerStore(pool, {
      acknowledgeIsolatedDatabase: true,
      rowStorage: true,
      changeFeed: true,
    });
    await store.readyRowStorage();
    fixture = await createRowStorageFixture({ store, suffix: 'sink' });
  });

  after(async () => {
    if (pool) await pool.end();
    if (bootstrapPool) {
      await bootstrapPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await bootstrapPool.end();
    }
  });

  const newSink = (bigquery, extra = {}) =>
    sinkModule.createBigQueryReportingWarehouseSinkV1({
      store,
      db: pool,
      bigquery,
      name: 'warehouse',
      projectId: 'adcp-reporting',
      datasetId: 'reporting',
      rowsTableId: 'revision_rows',
      revisionsTableId: 'revisions',
      mapRow: row => ({ impressions: row.impressions }),
      // Account-scoped so concurrent suites' open transactions, which hold
      // back the deployment-wide feed's snapshot horizon, cannot delay it.
      account_id: fixture.request.account.account_id,
      ...extra,
    });

  test('loads committed revisions once, with metadata, and stays idle until more commit', async () => {
    const bigquery = fakeBigQuery();
    const sink = newSink(bigquery);
    assert.deepEqual(await sink.runOnce(), { idle: true, revisions: 0, rows: 0, missing: [] });

    await store.commitRevision(fixture.revision('rrev_sink_1', 1, rows), fixture.lease);
    await store.commitRevision(
      fixture.revision('rrev_sink_2', 2, rows.slice(0, 10), { supersedes_reporting_revision_id: 'rrev_sink_1' }),
      fixture.lease
    );
    assert.deepEqual(await sink.runOnce(), { idle: false, revisions: 2, rows: 1_210, missing: [] });
    const loaded = bigquery.tables.get('reporting.revision_rows');
    assert.equal(loaded.length, 1_210);
    assert.deepEqual(loaded[0], {
      impressions: 0,
      reporting_revision_id: 'rrev_sink_1',
      reporting_obligation_id: fixture.obligation.reporting_obligation_id,
      account_id: fixture.request.account.account_id,
      revision_number: 1,
      finality: 'snapshot',
      period_date: fixture.obligation.period.start.slice(0, 10),
      ordinal: 0,
    });
    const revisions = bigquery.tables.get('reporting.revisions');
    assert.deepEqual(
      revisions.map(value => [value.reporting_revision_id, value.row_count]),
      [
        ['rrev_sink_1', 1_200],
        ['rrev_sink_2', 10],
      ]
    );
    assert.deepEqual(await sink.runOnce(), { idle: true, revisions: 0, rows: 0, missing: [] });
    assert.equal(
      Number(
        (await pool.query(`SELECT count(*) AS n FROM adcp_reporting_feed_consumers WHERE consumer_name = 'warehouse'`))
          .rows[0].n
      ),
      1,
      'the sink holds back change-feed pruning as a registered consumer'
    );
  });

  test('a crash after the rows load never duplicates rows', async () => {
    const bigquery = fakeBigQuery();
    const sink = newSink(bigquery, { name: 'crashy' });
    // Catch up first so only the next revision is in flight.
    await sink.runOnce();
    const before = bigquery.tables.get('reporting.revision_rows').length;
    await store.commitRevision(
      fixture.revision('rrev_sink_3', 3, rows.slice(0, 5), { supersedes_reporting_revision_id: 'rrev_sink_2' }),
      fixture.lease
    );
    bigquery.failNext('revisions', 'network');
    await assert.rejects(() => sink.runOnce(), /socket hang up/);
    assert.equal(bigquery.tables.get('reporting.revision_rows').length, before + 5, 'rows landed once');
    assert.deepEqual(await sink.runOnce(), { idle: false, revisions: 1, rows: 5, missing: [] });
    assert.equal(
      bigquery.tables.get('reporting.revision_rows').length,
      before + 5,
      'the replayed rows job was refused'
    );
    assert.ok(bigquery.tables.get('reporting.revisions').some(value => value.reporting_revision_id === 'rrev_sink_3'));
  });

  test('a failed load job is retried under a new attempt without touching the other table', async () => {
    const bigquery = fakeBigQuery();
    const sink = newSink(bigquery, { name: 'failing' });
    await sink.runOnce();
    const rowsBefore = bigquery.tables.get('reporting.revision_rows').length;
    await store.commitRevision(
      fixture.revision('rrev_sink_4', 4, rows.slice(0, 3), { supersedes_reporting_revision_id: 'rrev_sink_3' }),
      fixture.lease
    );
    bigquery.failNext('revisions', 'job');
    await assert.rejects(() => sink.runOnce(), /Job failed/);
    // The next run learns the job finished with an error and advances only that table's attempt.
    await assert.rejects(() => sink.runOnce(), /will be retried as a new attempt/);
    assert.deepEqual(await sink.runOnce(), { idle: false, revisions: 1, rows: 3, missing: [] });
    assert.equal(bigquery.tables.get('reporting.revision_rows').length, rowsBefore + 3);
    assert.ok([...bigquery.jobs.keys()].some(id => id.endsWith('_revs_a1')));
    assert.ok(![...bigquery.jobs.keys()].some(id => id.endsWith('_rows_a1')));
  });

  test('a hung load times out and the retry waits for the same job instead of loading twice', async () => {
    const bigquery = fakeBigQuery();
    const sink = newSink(bigquery, { name: 'hung', loadTimeoutMilliseconds: 1_000 });
    await sink.runOnce();
    const rowsBefore = bigquery.tables.get('reporting.revision_rows')?.length ?? 0;
    await store.commitRevision(
      fixture.revision('rrev_sink_5', 5, rows.slice(0, 2), { supersedes_reporting_revision_id: 'rrev_sink_4' }),
      fixture.lease
    );
    // The first submission is accepted by BigQuery but its response never arrives.
    const table = bigquery.dataset('reporting').table;
    let hung = true;
    bigquery.dataset = datasetId => {
      const real = { table };
      return {
        table(tableId) {
          const target = real.table(tableId);
          return {
            async load(file, metadata) {
              if (hung && tableId === 'revision_rows') {
                hung = false;
                await target.load(file, metadata);
                return new Promise(() => {});
              }
              return target.load(file, metadata);
            },
          };
        },
      };
    };
    const first = newSink(bigquery, { name: 'hung', loadTimeoutMilliseconds: 1_000 });
    await assert.rejects(() => first.runOnce(), /exceeded its deadline/);
    assert.deepEqual(await first.runOnce(), { idle: false, revisions: 1, rows: 2, missing: [] });
    assert.equal(bigquery.tables.get('reporting.revision_rows').length, rowsBefore + 2, 'rows landed exactly once');
    const sentTimeout = [...bigquery.jobs.values()].find(job => job.metadata?.jobTimeoutMs)?.metadata.jobTimeoutMs;
    assert.equal(sentTimeout, '1000');
    assert.throws(() => newSink(bigquery, { loadTimeoutMilliseconds: 10 }), /loadTimeoutMilliseconds/);
  });

  test('reports revisions retired before the batch ran as missing, and still advances', async () => {
    const bigquery = fakeBigQuery();
    const sink = newSink(bigquery, { name: 'behind' });
    await sink.runOnce();
    const gone = await createRowStorageFixture({ store, suffix: 'sinkgone' });
    await store.commitRevision(gone.revision('rrev_sink_gone_1', 1, rows.slice(0, 4)), gone.lease);
    const obligationId = gone.obligation.reporting_obligation_id;
    await pool.query(
      `UPDATE adcp_reporting_obligations
          SET period_start = period_start - INTERVAL '40 days', period_end = period_end - INTERVAL '40 days',
              created_at = created_at - INTERVAL '40 days', lease_expires_at = clock_timestamp() - INTERVAL '1 second'
        WHERE obligation_id = $1`,
      [obligationId]
    );
    await pool.query(
      `UPDATE adcp_reporting_revisions SET recorded_at = recorded_at - INTERVAL '40 days' WHERE obligation_id = $1`,
      [obligationId]
    );
    // The sink has not read the period's changes yet, so retention waits for it.
    assert.equal((await store.retireExpiredPeriods({ statusRetentionDays: 30 })).retired, 0);
    // Once the sink is dead beyond the hold window, retention proceeds without it.
    await pool.query(`UPDATE adcp_reporting_feed_consumers SET updated_at = clock_timestamp() - INTERVAL '10 days'`);
    assert.equal((await store.retireExpiredPeriods({ statusRetentionDays: 30 })).retired, 1);

    assert.deepEqual(await sink.runOnce(), { idle: false, revisions: 0, rows: 0, missing: ['rrev_sink_gone_1'] });
    for (const table of ['reporting.revisions', 'reporting.revision_rows']) {
      assert.ok(
        !(bigquery.tables.get(table) ?? []).some(value => value.reporting_revision_id === 'rrev_sink_gone_1'),
        'nothing was loaded for the retired revision'
      );
    }
    assert.deepEqual(await sink.runOnce(), { idle: true, revisions: 0, rows: 0, missing: [] }, 'the cursor advanced');
  });

  test('publishes partitioned table DDL and a current-revision view, and validates identifiers', () => {
    const sink = newSink(fakeBigQuery());
    assert.match(sink.defaultTablesSql, /PARTITION BY period_date/);
    assert.match(sink.defaultTablesSql, /`adcp-reporting\.reporting\.revision_rows`/);
    assert.match(sink.currentRowsViewSql, /CREATE OR REPLACE VIEW `adcp-reporting\.reporting\.current_rows`/);
    assert.match(sink.currentRowsViewSql, /ORDER BY revision_number DESC LIMIT 1/);
    assert.throws(() => newSink(fakeBigQuery(), { datasetId: 'reporting`; DROP' }), /datasetId is invalid/);
    assert.throws(() => newSink(fakeBigQuery(), { projectId: 'Bad Project' }), /projectId is invalid/);
    assert.equal(
      sinkModule.reportingWarehouseJobIdV1('warehouse', null, 'cursor'),
      sinkModule.reportingWarehouseJobIdV1('warehouse', null, 'cursor')
    );
  });
});
