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

function latch() {
  let resolve;
  const promise = new Promise(done => {
    resolve = done;
  });
  return { promise, resolve };
}

function wrapStore(store, overrides) {
  return {
    changesAfter: store.changesAfter.bind(store),
    getRevisionMetadata: store.getRevisionMetadata.bind(store),
    readRevisionRows: store.readRevisionRows.bind(store),
    saveFeedConsumerCursor: store.saveFeedConsumerCursor.bind(store),
    ...overrides,
  };
}

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

  for (const sharedInstance of [true, false]) {
    test(`competing plans cannot duplicate rows or rewind the cursor (${sharedInstance ? 'one instance' : 'two instances'})`, async () => {
      const suffix = sharedInstance ? 'overlap_same' : 'overlap_other';
      const isolated = await createRowStorageFixture({ store, suffix, accountId: `acct_${suffix}` });
      const account = isolated.request.account.account_id;
      const ids = [1, 2].map(n => `rrev_${suffix}_${n}`);
      const bigquery = fakeBigQuery();
      await store.commitRevision(isolated.revision(ids[0], 1, rows.slice(0, 1)), isolated.lease);
      const read = latch();
      const resume = latch();
      let pause = true;
      const delayed = wrapStore(store, {
        async changesAfter(input) {
          const page = await store.changesAfter(input);
          if (pause) {
            pause = false;
            read.resolve();
            await resume.promise;
          }
          return page;
        },
      });
      const first = newSink(bigquery, { name: suffix, account_id: account, store: delayed });
      const second = sharedInstance ? first : newSink(bigquery, { name: suffix, account_id: account });
      const pending = first.runOnce();
      pending.catch(() => {});
      await read.promise;
      try {
        await store.commitRevision(
          isolated.revision(ids[1], 2, rows.slice(0, 1), { supersedes_reporting_revision_id: ids[0] }),
          isolated.lease
        );
        assert.equal((await second.runOnce()).revisions, 2);
      } finally {
        resume.resolve();
      }
      await assert.rejects(pending, /plan changed.*retry runOnce/);
      assert.deepEqual(
        bigquery.tables.get('reporting.revision_rows').map(row => row.reporting_revision_id),
        ids
      );
      assert.equal(bigquery.jobs.size, 2, 'the losing plan submitted no load jobs');
      const committed = (await store.changesAfter({ account_id: account, kinds: ['revision'] })).cursor;
      assert.equal(
        (await pool.query('SELECT committed_cursor FROM adcp_reporting_warehouse_sinks WHERE sink_name = $1', [suffix]))
          .rows[0].committed_cursor,
        committed
      );
      assert.equal((await first.runOnce()).idle, true);
      assert.equal(bigquery.tables.get('reporting.revision_rows').length, 2);
    });
  }

  test('an empty revision plan cannot erase a concurrently completed plan', async () => {
    const isolated = await createRowStorageFixture({ store, suffix: 'overlap_empty', accountId: 'acct_overlap_empty' });
    const account = isolated.request.account.account_id;
    const read = latch();
    const resume = latch();
    const bigquery = fakeBigQuery();
    const first = newSink(bigquery, {
      name: 'overlap_empty',
      account_id: account,
      store: wrapStore(store, {
        async changesAfter(input) {
          const page = await store.changesAfter(input);
          assert.ok(page.records.every(record => record.kind !== 'revision'));
          if (!input.kinds) {
            read.resolve();
            await resume.promise;
          }
          return page;
        },
      }),
    });
    const second = newSink(bigquery, { name: 'overlap_empty', account_id: account });
    const pending = first.runOnce();
    pending.catch(() => {});
    await read.promise;
    try {
      await store.commitRevision(isolated.revision('rrev_overlap_empty_1', 1, rows.slice(0, 1)), isolated.lease);
      assert.equal((await second.runOnce()).revisions, 1);
    } finally {
      resume.resolve();
    }
    await assert.rejects(pending, /plan changed/);
    assert.equal((await second.runOnce()).idle, true);
    assert.equal(bigquery.tables.get('reporting.revision_rows').length, 1);
  });

  test('the unfiltered fallback loads a revision committed between feed reads', async () => {
    const account = 'acct_fallback_revision';
    const isolated = await createRowStorageFixture({ store, suffix: 'fallback_revision', accountId: account });
    const bigquery = fakeBigQuery();
    let injected = false;
    const sink = newSink(bigquery, {
      name: 'fallback_revision',
      account_id: account,
      store: wrapStore(store, {
        async changesAfter(input) {
          const page = await store.changesAfter(input);
          if (!injected && input.kinds) {
            assert.equal(page.records.length, 0);
            injected = true;
            await store.commitRevision(
              isolated.revision('rrev_fallback_revision_1', 1, rows.slice(0, 1)),
              isolated.lease
            );
          }
          return page;
        },
      }),
    });
    assert.deepEqual(await sink.runOnce(), { idle: false, revisions: 1, rows: 1, missing: [] });
    assert.deepEqual(
      bigquery.tables.get('reporting.revision_rows').map(row => row.reporting_revision_id),
      ['rrev_fallback_revision_1']
    );
    assert.deepEqual(await sink.runOnce(), { idle: true, revisions: 0, rows: 0, missing: [] });
    assert.equal(bigquery.jobs.size, 2);
  });

  test('a stale replay cannot commit over a newer batch', async () => {
    const isolated = await createRowStorageFixture({
      store,
      suffix: 'overlap_replay',
      accountId: 'acct_overlap_replay',
    });
    const account = isolated.request.account.account_id;
    const bigquery = fakeBigQuery();
    const read = latch();
    const resume = latch();
    await store.commitRevision(isolated.revision('rrev_overlap_replay_1', 1, rows.slice(0, 1)), isolated.lease);
    const first = newSink(bigquery, {
      name: 'overlap_replay',
      account_id: account,
      store: wrapStore(store, {
        async getRevisionMetadata(...args) {
          const value = await store.getRevisionMetadata(...args);
          read.resolve();
          await resume.promise;
          return value;
        },
      }),
    });
    const second = newSink(bigquery, { name: 'overlap_replay', account_id: account });
    const pending = first.runOnce();
    pending.catch(() => {});
    await read.promise;
    let cursor;
    try {
      assert.equal((await second.runOnce()).revisions, 1);
      await store.commitRevision(
        isolated.revision('rrev_overlap_replay_2', 2, rows.slice(0, 1), {
          supersedes_reporting_revision_id: 'rrev_overlap_replay_1',
        }),
        isolated.lease
      );
      assert.equal((await second.runOnce()).revisions, 1);
      cursor = (
        await pool.query('SELECT committed_cursor FROM adcp_reporting_warehouse_sinks WHERE sink_name = $1', [
          'overlap_replay',
        ])
      ).rows[0].committed_cursor;
    } finally {
      resume.resolve();
    }
    await assert.rejects(pending, /plan changed/);
    assert.equal(
      (
        await pool.query('SELECT committed_cursor FROM adcp_reporting_warehouse_sinks WHERE sink_name = $1', [
          'overlap_replay',
        ])
      ).rows[0].committed_cursor,
      cursor
    );
    assert.equal(bigquery.tables.get('reporting.revision_rows').length, 2);
    assert.equal(bigquery.tables.get('reporting.revisions').length, 2);
    assert.equal(bigquery.jobs.size, 4, 'replays reused the first batch job IDs');
  });

  test('concurrent failed-job observers advance an attempt only once', async () => {
    const isolated = await createRowStorageFixture({ store, suffix: 'overlap_retry', accountId: 'acct_overlap_retry' });
    const account = isolated.request.account.account_id;
    const bigquery = fakeBigQuery();
    const first = newSink(bigquery, { name: 'overlap_retry', account_id: account });
    const second = newSink(bigquery, { name: 'overlap_retry', account_id: account });
    await store.commitRevision(isolated.revision('rrev_overlap_retry_1', 1, rows.slice(0, 1)), isolated.lease);
    bigquery.failNext('revision_rows', 'job');
    await assert.rejects(first.runOnce(), /Job failed/);
    const bothRead = latch();
    const resume = latch();
    let reads = 0;
    const job = bigquery.job.bind(bigquery);
    bigquery.job = id => ({
      async getMetadata() {
        const metadata = await job(id).getMetadata();
        if (++reads === 2) bothRead.resolve();
        await resume.promise;
        return metadata;
      },
    });
    const pending = Promise.allSettled([first.runOnce(), second.runOnce()]);
    await bothRead.promise;
    resume.resolve();
    const outcomes = await pending;
    assert.ok(outcomes.every(outcome => outcome.status === 'rejected'));
    assert.equal(
      (
        await pool.query('SELECT planned_rows_attempt FROM adcp_reporting_warehouse_sinks WHERE sink_name = $1', [
          'overlap_retry',
        ])
      ).rows[0].planned_rows_attempt,
      1
    );
    assert.equal((await first.runOnce()).rows, 1);
    assert.equal(bigquery.tables.get('reporting.revision_rows').length, 1);
    assert.ok([...bigquery.jobs.keys()].some(id => id.endsWith('_rows_a1')));
    assert.ok(![...bigquery.jobs.keys()].some(id => id.endsWith('_rows_a2')));
  });

  test('a stale failure callback cannot increment a replacement plan', async () => {
    const isolated = await createRowStorageFixture({
      store,
      suffix: 'overlap_stale_failure',
      accountId: 'acct_overlap_stale_failure',
    });
    const account = isolated.request.account.account_id;
    const bigquery = fakeBigQuery();
    const first = newSink(bigquery, { name: 'overlap_stale_failure', account_id: account });
    const second = newSink(bigquery, { name: 'overlap_stale_failure', account_id: account });
    await store.commitRevision(isolated.revision('rrev_overlap_stale_failure_1', 1, rows.slice(0, 1)), isolated.lease);
    bigquery.failNext('revision_rows', 'job');
    await assert.rejects(first.runOnce(), /Job failed/);
    const read = latch();
    const resume = latch();
    const job = bigquery.job.bind(bigquery);
    let pause = true;
    bigquery.job = id => ({
      async getMetadata() {
        const metadata = await job(id).getMetadata();
        if (pause) {
          pause = false;
          read.resolve();
          await resume.promise;
        }
        return metadata;
      },
    });
    const pending = first.runOnce();
    pending.catch(() => {});
    await read.promise;
    let replacement;
    const state = async () =>
      (
        await pool.query(
          'SELECT planned_to_cursor, planned_revisions, planned_rows_attempt, planned_revisions_attempt FROM adcp_reporting_warehouse_sinks WHERE sink_name = $1',
          ['overlap_stale_failure']
        )
      ).rows[0];
    try {
      await assert.rejects(second.runOnce(), /will be retried as a new attempt/);
      await second.runOnce();
      await store.commitRevision(
        isolated.revision('rrev_overlap_stale_failure_2', 2, rows.slice(0, 1), {
          supersedes_reporting_revision_id: 'rrev_overlap_stale_failure_1',
        }),
        isolated.lease
      );
      bigquery.failNext('revisions', 'network');
      await assert.rejects(second.runOnce(), /socket hang up/);
      replacement = await state();
      assert.equal(replacement.planned_rows_attempt, 0);
    } finally {
      resume.resolve();
    }
    await assert.rejects(pending, /will be retried as a new attempt/);
    assert.deepEqual(await state(), replacement);
    await second.runOnce();
    assert.equal(bigquery.tables.get('reporting.revision_rows').length, 2);
    assert.equal(bigquery.tables.get('reporting.revisions').length, 2);
  });

  test('an inconsistent legacy plan requires reconciliation before loading', async () => {
    const bigquery = fakeBigQuery();
    const sink = newSink(bigquery, { name: 'legacy_overlap' });
    await pool.query(
      `INSERT INTO adcp_reporting_warehouse_sinks
         (sink_name, committed_cursor, planned_from_cursor, planned_to_cursor, planned_revisions)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [
        'legacy_overlap',
        'newer_cursor',
        'older_cursor',
        'pending_cursor',
        JSON.stringify([{ id: 'rrev_legacy', account_id: fixture.request.account.account_id }]),
      ]
    );
    const before = (
      await pool.query('SELECT * FROM adcp_reporting_warehouse_sinks WHERE sink_name = $1', ['legacy_overlap'])
    ).rows[0];
    await assert.rejects(sink.runOnce(), /inconsistent retained plan; reconcile/);
    assert.equal(bigquery.jobs.size, 0);
    assert.deepEqual(
      (await pool.query('SELECT * FROM adcp_reporting_warehouse_sinks WHERE sink_name = $1', ['legacy_overlap']))
        .rows[0],
      before
    );
  });

  async function expireAccount(account) {
    await pool.query(
      `UPDATE adcp_reporting_obligations
          SET period_start = period_start - INTERVAL '40 days', period_end = period_end - INTERVAL '40 days',
              created_at = created_at - INTERVAL '40 days', lease_expires_at = clock_timestamp() - INTERVAL '1 second'
        WHERE account_id = $1`,
      [account]
    );
    await pool.query(
      `UPDATE adcp_reporting_revisions SET recorded_at = recorded_at - INTERVAL '40 days'
        WHERE obligation_id IN (
          SELECT obligation_id FROM adcp_reporting_obligations WHERE account_id = $1
        )`,
      [account]
    );
    await pool.query(
      `UPDATE adcp_reporting_changes SET recorded_at = recorded_at - INTERVAL '40 days' WHERE account_id = $1`,
      [account]
    );
  }

  test('idle ticks drain non-revision changes without blocking retention', async () => {
    const account = 'acct_idle_retention';
    const bigquery = fakeBigQuery();
    const sink = newSink(bigquery, { name: 'idle_retention', account_id: account, maxRevisionsPerBatch: 1 });
    await sink.runOnce();
    await createRowStorageFixture({ store, suffix: 'idle_retention', accountId: account });
    await expireAccount(account);
    const tail = (
      await pool.query('SELECT MAX(seq)::text AS seq FROM adcp_reporting_changes WHERE account_id = $1', [account])
    ).rows[0].seq;
    assert.ok(tail);
    for (let tick = 0; tick < 3; tick++) {
      assert.deepEqual(await sink.runOnce(), { idle: true, revisions: 0, rows: 0, missing: [] });
    }
    const checkpoint = (
      await pool.query('SELECT cursor_seq FROM adcp_reporting_feed_consumers WHERE consumer_name = $1', [
        'idle_retention',
      ])
    ).rows[0].cursor_seq;
    assert.equal(checkpoint, tail);
    assert.equal(bigquery.jobs.size, 0);
    await store.pruneChanges({ changeRetentionDays: 30, maxFeedHoldDays: 7 });
    assert.equal(
      (await pool.query('SELECT COUNT(*)::int AS n FROM adcp_reporting_changes WHERE account_id = $1', [account]))
        .rows[0].n,
      0
    );
    assert.deepEqual(
      await store.retireExpiredPeriods({ statusRetentionDays: 30, maxFeedHoldDays: 7, account_id: account }),
      { retired: 1, failed: [], failures: [] }
    );
  });

  test("failed retries do not renew a stalled consumer's retention hold", async () => {
    const account = 'acct_failed_retention';
    const isolated = await createRowStorageFixture({ store, suffix: 'failed_retention', accountId: account });
    const bigquery = fakeBigQuery();
    const sink = newSink(bigquery, { name: 'failed_retention', account_id: account });
    await store.commitRevision(isolated.revision('rrev_failed_retention_1', 1, rows.slice(0, 1)), isolated.lease);
    await sink.runOnce();
    await store.commitRevision(
      isolated.revision('rrev_failed_retention_2', 2, rows.slice(0, 1), {
        supersedes_reporting_revision_id: 'rrev_failed_retention_1',
      }),
      isolated.lease
    );
    await expireAccount(account);
    const checkpoint = (
      await pool.query(
        `UPDATE adcp_reporting_feed_consumers SET updated_at = clock_timestamp() - INTERVAL '8 days'
          WHERE consumer_name = $1 RETURNING cursor_seq, updated_at`,
        ['failed_retention']
      )
    ).rows[0];
    for (let tick = 0; tick < 3; tick++) {
      bigquery.failNext('revision_rows', 'network');
      await assert.rejects(sink.runOnce(), /socket hang up/);
    }
    assert.deepEqual(
      (
        await pool.query('SELECT cursor_seq, updated_at FROM adcp_reporting_feed_consumers WHERE consumer_name = $1', [
          'failed_retention',
        ])
      ).rows[0],
      checkpoint
    );
    await store.pruneChanges({ changeRetentionDays: 30, maxFeedHoldDays: 7 });
    assert.equal(
      (await pool.query('SELECT COUNT(*)::int AS n FROM adcp_reporting_changes WHERE account_id = $1', [account]))
        .rows[0].n,
      0
    );
    assert.deepEqual(
      await store.retireExpiredPeriods({ statusRetentionDays: 30, maxFeedHoldDays: 7, account_id: account }),
      { retired: 1, failed: [], failures: [] }
    );
  });

  test('an xmin-blocked deployment backlog does not renew an idle retention hold', async () => {
    const account = 'acct_blocked_retention';
    const bigquery = fakeBigQuery();
    const sink = newSink(bigquery, { name: 'blocked_retention', account_id: undefined });
    await sink.runOnce();
    await sink.runOnce();
    const jobsBefore = bigquery.jobs.size;
    const blocker = await pool.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT pg_current_xact_id()');
      const isolated = await createRowStorageFixture({ store, suffix: 'blocked_retention', accountId: account });
      await store.commitRevision(isolated.revision('rrev_blocked_retention_1', 1, rows.slice(0, 1)), isolated.lease);
      await expireAccount(account);
      const committed = (
        await pool.query('SELECT committed_cursor FROM adcp_reporting_warehouse_sinks WHERE sink_name = $1', [
          'blocked_retention',
        ])
      ).rows[0].committed_cursor;
      assert.ok((await store.changesAfter({ account_id: account })).records.some(record => record.kind === 'revision'));
      assert.deepEqual((await store.changesAfter({ cursor: committed })).records, []);
      const checkpoint = (
        await pool.query(
          `UPDATE adcp_reporting_feed_consumers SET updated_at = clock_timestamp() - INTERVAL '8 days'
            WHERE consumer_name = $1 RETURNING cursor_xid, cursor_seq, updated_at`,
          ['blocked_retention']
        )
      ).rows[0];
      for (let tick = 0; tick < 3; tick++) {
        assert.deepEqual(await sink.runOnce(), { idle: true, revisions: 0, rows: 0, missing: [] });
      }
      assert.deepEqual(
        (
          await pool.query(
            'SELECT cursor_xid, cursor_seq, updated_at FROM adcp_reporting_feed_consumers WHERE consumer_name = $1',
            ['blocked_retention']
          )
        ).rows[0],
        checkpoint
      );
      assert.equal(bigquery.jobs.size, jobsBefore);
      await store.pruneChanges({ changeRetentionDays: 30, maxFeedHoldDays: 7 });
      assert.equal(
        (await pool.query('SELECT COUNT(*)::int AS n FROM adcp_reporting_changes WHERE account_id = $1', [account]))
          .rows[0].n,
        0
      );
      assert.deepEqual(
        await store.retireExpiredPeriods({ statusRetentionDays: 30, maxFeedHoldDays: 7, account_id: account }),
        { retired: 1, failed: [], failures: [] }
      );
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
    }
  });

  test('a failed feed acknowledgment is recovered by an idle tick', async () => {
    const isolated = await createRowStorageFixture({
      store,
      suffix: 'overlap_ack_failure',
      accountId: 'acct_overlap_ack_failure',
    });
    const account = isolated.request.account.account_id;
    const bigquery = fakeBigQuery();
    let fail = true;
    const sink = newSink(bigquery, {
      name: 'overlap_ack_failure',
      account_id: account,
      store: wrapStore(store, {
        async saveFeedConsumerCursor(...args) {
          if (fail) {
            fail = false;
            throw new Error('checkpoint unavailable');
          }
          return store.saveFeedConsumerCursor(...args);
        },
      }),
    });
    await store.commitRevision(isolated.revision('rrev_overlap_ack_failure_1', 1, rows.slice(0, 1)), isolated.lease);
    await assert.rejects(sink.runOnce(), /checkpoint unavailable/);
    assert.equal((await sink.runOnce()).idle, true);
    const cursor = (await store.changesAfter({ account_id: account, kinds: ['revision'] })).cursor;
    const expected = ledger.decodeReportingChangeCursorV1(cursor, account).seq;
    assert.equal(
      (
        await pool.query('SELECT cursor_seq FROM adcp_reporting_feed_consumers WHERE consumer_name = $1', [
          'overlap_ack_failure',
        ])
      ).rows[0].cursor_seq,
      expected
    );
    assert.equal(bigquery.jobs.size, 2, 'recovering the checkpoint submitted no new jobs');
  });

  test('delayed feed acknowledgment cannot rewind a newer committed checkpoint', async () => {
    const isolated = await createRowStorageFixture({ store, suffix: 'overlap_ack', accountId: 'acct_overlap_ack' });
    const account = isolated.request.account.account_id;
    const bigquery = fakeBigQuery();
    const read = latch();
    const resume = latch();
    await store.commitRevision(isolated.revision('rrev_overlap_ack_1', 1, rows.slice(0, 1)), isolated.lease);
    const first = newSink(bigquery, {
      name: 'overlap_ack',
      account_id: account,
      store: wrapStore(store, {
        async saveFeedConsumerCursor(...args) {
          read.resolve();
          await resume.promise;
          return store.saveFeedConsumerCursor(...args);
        },
      }),
    });
    const second = newSink(bigquery, { name: 'overlap_ack', account_id: account });
    const pending = first.runOnce();
    await read.promise;
    let checkpoint;
    try {
      await store.commitRevision(
        isolated.revision('rrev_overlap_ack_2', 2, rows.slice(0, 1), {
          supersedes_reporting_revision_id: 'rrev_overlap_ack_1',
        }),
        isolated.lease
      );
      await second.runOnce();
      checkpoint = (
        await pool.query('SELECT cursor_seq FROM adcp_reporting_feed_consumers WHERE consumer_name = $1', [
          'overlap_ack',
        ])
      ).rows[0].cursor_seq;
    } finally {
      resume.resolve();
    }
    await pending;
    assert.equal(
      (
        await pool.query('SELECT cursor_seq FROM adcp_reporting_feed_consumers WHERE consumer_name = $1', [
          'overlap_ack',
        ])
      ).rows[0].cursor_seq,
      checkpoint
    );
    assert.equal(bigquery.tables.get('reporting.revision_rows').length, 2);
  });
});
