/**
 * PostgreSQL integration tests for the BigQuery warehouse sink, using an
 * in-memory BigQuery double that enforces job-ID uniqueness the way BigQuery does.
 *
 * REPORTING_LEDGER_PG_URL=postgres://localhost/test node --test test/lib/reporting-bigquery-sink-pg.test.js
 */
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { after, before, describe, test } = require('node:test');

const { createFakeBigQuery } = require('../helpers/fake-bigquery.js');
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
    removeFeedConsumer: store.removeFeedConsumer.bind(store),
    ...overrides,
  };
}

// Models the real client and service for local-file loads: every option lands in
// configuration.load, and BigQuery drops the two fields it defines on
// configuration.* only (labels, jobTimeoutMs), which the client cannot set.
function fakeBigQuery() {
  const tables = new Map();
  const jobs = new Map();
  const failures = [];
  const loadOptions = [];
  const dropped = [];
  return {
    tables,
    jobs,
    loadOptions,
    dropped,
    failNext(tableId, how) {
      failures.push({ tableId, how });
    },
    dataset(datasetId, datasetOptions = {}) {
      return {
        table(tableId) {
          return {
            async load(file, metadata) {
              loadOptions.push({ tableId, options: structuredClone(metadata) });
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
              const { jobId, ...load } = metadata;
              const lost = ['labels', 'jobTimeoutMs'].filter(field => field in load);
              for (const field of lost) delete load[field];
              if (lost.length) dropped.push({ jobId, fields: lost });
              jobs.set(jobId, {
                status: { state: 'DONE' },
                table: key,
                lines,
                jobReference: { jobId, projectId: datasetOptions.projectId, location: datasetOptions.location },
                configuration: { load },
              });
              tables.set(key, [...(tables.get(key) ?? []), ...lines]);
              return [{ id: jobId }];
            },
          };
        },
      };
    },
    job(jobId, options = {}) {
      return {
        getMetadata: async () => {
          const job = jobs.get(jobId);
          if (!job) throw Object.assign(new Error(`Not found: Job ${jobId}`), { code: 404 });
          return [job];
        },
      };
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

  test("period_date is the period start's calendar date in its source_timezone, not the UTC date", async () => {
    const cases = [
      // Local midnight in Los Angeles (PDT): the same date as UTC, but it rules out a fixed UTC-8 offset.
      { suffix: 'pd_la', zone: 'America/Los_Angeles', start: '2026-10-02T07:00:00.000Z', date: '2026-10-02' },
      // 23:00 the evening before in Los Angeles, though the UTC date is already the 2nd.
      { suffix: 'pd_la_eve', zone: 'America/Los_Angeles', start: '2026-10-02T06:00:00.000Z', date: '2026-10-01' },
      // Midnight of the 2nd in Tokyo, a day ahead of the UTC date.
      { suffix: 'pd_tokyo', zone: 'Asia/Tokyo', start: '2026-10-01T15:00:00.000Z', date: '2026-10-02' },
      // The same Tokyo instant expressed with an offset still dates by the instant.
      { suffix: 'pd_tokyo_offset', zone: 'Asia/Tokyo', start: '2026-10-02T00:00:00+09:00', date: '2026-10-02' },
      // A half-hour zone: 19:00Z is 00:30 on the 2nd in Kolkata.
      { suffix: 'pd_kolkata', zone: 'Asia/Kolkata', start: '2026-10-01T19:00:00.000Z', date: '2026-10-02' },
      // Daylight saving: after spring forward the offset is -7 (a fixed -8 would say 03-08 at 23:00),
      // and after fall back the offset is -8 (a fixed -7 would say 11-02 at 00:30).
      { suffix: 'pd_spring', zone: 'America/Los_Angeles', start: '2026-03-09T07:00:00.000Z', date: '2026-03-09' },
      { suffix: 'pd_fall', zone: 'America/Los_Angeles', start: '2026-11-02T07:30:00.000Z', date: '2026-11-01' },
      { suffix: 'pd_utc', zone: 'UTC', start: '2026-10-01T15:00:00.000Z', date: '2026-10-01' },
    ];
    const differsFromUtc = new Set(['pd_la_eve', 'pd_tokyo', 'pd_tokyo_offset', 'pd_kolkata', 'pd_fall']);
    for (const { suffix, zone, start, date } of cases) {
      assert.equal(
        new Date(start).toISOString().slice(0, 10) !== date,
        differsFromUtc.has(suffix),
        `${suffix}: the case is meant ${differsFromUtc.has(suffix) ? 'to' : 'not to'} differ from the UTC date`
      );
      const local = await createRowStorageFixture({
        store,
        suffix,
        accountId: `acct_${suffix}`,
        sourceTimezone: zone,
        periodStart: start,
        periodEnd: new Date(Date.parse(start) + 86_400_000).toISOString(),
      });
      await store.commitRevision(local.revision(`rrev_${suffix}`, 1, rows.slice(0, 3)), local.lease);
      const bigquery = fakeBigQuery();
      const sink = newSink(bigquery, { name: `period_${suffix}`, account_id: `acct_${suffix}` });
      assert.deepEqual(await sink.runOnce(), { idle: false, revisions: 1, rows: 3, missing: [] });
      assert.deepEqual(
        [...new Set(bigquery.tables.get('reporting.revision_rows').map(row => row.period_date))],
        [date],
        `${zone} period starting ${start} loads its rows as ${date}`
      );
      const [revision] = bigquery.tables.get('reporting.revisions');
      assert.equal(revision.period_date, date, 'the revisions table carries the same date');
      assert.equal(revision.source_timezone, zone);
      assert.equal(Date.parse(revision.period_start), Date.parse(start), 'beside the unchanged period start');
    }
  });

  describe('a revision whose period or timezone cannot give a date', () => {
    const good = { start: '2026-10-02T07:00:00Z', end: '2026-10-03T07:00:00Z', source_timezone: 'America/Los_Angeles' };
    const damaged = [
      ['an unknown timezone', { ...good, source_timezone: 'Mars/Base' }, RangeError],
      ['an offset instead of a zone', { ...good, source_timezone: '+05:30' }, TypeError],
      ['a missing timezone', { ...good, source_timezone: undefined }, TypeError],
      ['an empty timezone', { ...good, source_timezone: '' }, TypeError],
      ['an unusable start', { ...good, start: 'yesterday' }, TypeError],
      ['a missing start', { ...good, start: undefined }, TypeError],
      ['a start that Date.parse would roll forward', { ...good, start: '2026-02-30T08:00:00Z' }, TypeError],
      ['no period', undefined, TypeError],
    ];

    const damagedStore = (damagedId, period) =>
      wrapStore(store, {
        async getRevisionMetadata(id, accountId) {
          const metadata = await store.getRevisionMetadata(id, accountId);
          return id === damagedId ? { ...metadata, wireRevision: { ...metadata.wireRevision, period } } : metadata;
        },
      });
    const sinkState = async name =>
      (await pool.query('SELECT * FROM adcp_reporting_warehouse_sinks WHERE sink_name = $1', [name])).rows[0];

    for (const [label, period, errorClass] of damaged) {
      test(`${label} fails the batch before anything loads, and the plan recovers once the data is right`, async () => {
        const slug = label.replace(/\W+/g, '_');
        const account = `acct_pd_bad_${slug}`;
        const fixtureBad = await createRowStorageFixture({ store, suffix: `pd_bad_${slug}`, accountId: account });
        // A good revision ahead of the damaged one in the same batch must not load either.
        await store.commitRevision(fixtureBad.revision(`rrev_pd_good_${slug}`, 1, rows.slice(0, 3)), fixtureBad.lease);
        await store.commitRevision(
          fixtureBad.revision(`rrev_pd_bad_${slug}`, 2, rows.slice(0, 2), {
            supersedes_reporting_revision_id: `rrev_pd_good_${slug}`,
          }),
          fixtureBad.lease
        );
        const name = `period_bad_${slug}`;
        const bigquery = fakeBigQuery();
        const broken = newSink(bigquery, {
          name,
          account_id: account,
          store: damagedStore(`rrev_pd_bad_${slug}`, period),
        });
        const expectFailure = error => {
          assert.match(error.message, new RegExp(`Cannot compute period_date for revision rrev_pd_bad_${slug}`));
          assert.match(error.message, /stays retained/);
          assert.ok(error.cause instanceof errorClass, `${label}: cause is a ${errorClass.name}`);
          return true;
        };
        await assert.rejects(() => broken.runOnce(), expectFailure);
        assert.equal(bigquery.tables.size, 0, 'no table received a row');
        assert.equal(bigquery.jobs.size, 0, 'no load job was submitted');
        assert.equal(bigquery.loadOptions.length, 0);
        const retained = await sinkState(name);
        assert.equal(retained.committed_cursor, null, 'the cursor did not move');
        assert.notEqual(retained.planned_to_cursor, null, 'the batch stays retained');
        assert.equal(retained.planned_rows_attempt, 0, 'a dating failure does not burn a load attempt');
        assert.equal(retained.planned_revisions_attempt, 0);
        assert.equal(
          Number(
            (
              await pool.query('SELECT count(*) AS n FROM adcp_reporting_feed_consumers WHERE consumer_name = $1', [
                name,
              ])
            ).rows[0].n
          ),
          0,
          'nothing was acknowledged'
        );
        // The poison persists across runs: it is deterministic, not transient.
        await assert.rejects(() => broken.runOnce(), expectFailure);

        // Once the revision can be dated, the same retained plan completes under its original job IDs.
        const repaired = newSink(bigquery, { name, account_id: account });
        assert.deepEqual(await repaired.runOnce(), { idle: false, revisions: 2, rows: 5, missing: [] });
        assert.deepEqual(
          [...new Set(bigquery.tables.get('reporting.revision_rows').map(row => row.period_date))],
          [fixtureBad.obligation.period.start.slice(0, 10)],
          'the repaired revisions load under their real (UTC fixture) date'
        );
        const completed = await sinkState(name);
        assert.equal(completed.planned_to_cursor, null, 'the plan completed');
        assert.notEqual(completed.committed_cursor, null);
      });
    }
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

  for (const location of [undefined, 'asia-northeast1']) {
    test(`a cross-project replay after a lost response looks up the upload project${location ? ' and location' : ''}`, async () => {
      const suffix = location ? 'project_region' : 'project_default_region';
      const isolated = await createRowStorageFixture({ store, suffix, accountId: `acct_${suffix}` });
      await store.commitRevision(isolated.revision(`rrev_${suffix}`, 1, rows.slice(0, 1)), isolated.lease);
      const bigquery = fakeBigQuery();
      const dataset = bigquery.dataset.bind(bigquery);
      const job = bigquery.job.bind(bigquery);
      const lookups = [];
      let loseResponse = true;
      bigquery.dataset = (datasetId, options) => {
        assert.equal(options.projectId, 'warehouse-project');
        assert.equal(options.location, location);
        const target = dataset(datasetId);
        return {
          table(tableId) {
            const table = target.table(tableId);
            return {
              async load(file, metadata) {
                const result = await table.load(file, metadata);
                if (loseResponse && tableId === 'revision_rows') {
                  loseResponse = false;
                  throw new Error('lost upload response');
                }
                return result;
              },
            };
          },
        };
      };
      bigquery.job = (jobId, options) => ({
        async getMetadata() {
          lookups.push(options);
          // The official client's default project differs from the dataset
          // override. A GET without the override cannot find the upload.
          if (options?.projectId !== 'warehouse-project') {
            const error = new Error('Job not found in default-project');
            error.code = 404;
            throw error;
          }
          assert.equal(options.location, location);
          return job(jobId).getMetadata();
        },
      });
      const sink = newSink(bigquery, {
        name: suffix,
        account_id: isolated.request.account.account_id,
        projectId: 'warehouse-project',
        ...(location ? { location } : {}),
      });
      await assert.rejects(() => sink.runOnce(), /lost upload response/);
      assert.deepEqual(await sink.runOnce(), { idle: false, revisions: 1, rows: 1, missing: [] });
      assert.ok(lookups.length >= 2, 'every submission is preceded by a lookup, and the replay finds the upload');
      for (const lookup of lookups) {
        assert.deepEqual(lookup, { projectId: 'warehouse-project', ...(location ? { location } : {}) });
      }
      assert.equal(bigquery.tables.get('reporting.revision_rows').length, 1, 'the accepted upload is not repeated');
      assert.equal(bigquery.jobs.size, 2, 'both tables finish with their original job IDs');
      const state = (await pool.query('SELECT * FROM adcp_reporting_warehouse_sinks WHERE sink_name = $1', [suffix]))
        .rows[0];
      assert.ok(state.committed_cursor);
      assert.equal(state.planned_to_cursor, null);
      assert.equal(state.planned_rows_attempt, 0);
      assert.equal(state.planned_revisions_attempt, 0);
    });
  }

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

  test('a response that never arrives times out, and the retry finds the finished job instead of loading twice', async () => {
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
    await assert.rejects(() => first.runOnce(), /exceeded this run's 1000 ms deadline/);
    assert.deepEqual(await first.runOnce(), { idle: false, revisions: 1, rows: 2, missing: [] });
    assert.equal(bigquery.tables.get('reporting.revision_rows').length, rowsBefore + 2, 'rows landed exactly once');
    assert.deepEqual(bigquery.dropped, [], 'no job-level field is sent where BigQuery would drop it');
    assert.throws(() => newSink(bigquery, { loadTimeoutMilliseconds: 10 }), /loadTimeoutMilliseconds/);
  });

  test('labels are ignored with a warning, and no job-level field is sent where BigQuery would drop it', async t => {
    const { pool, store: realStore } = await isolatedWarehouseStore(t, 'labels_ignored');
    const account = 'acct_labels_ignored';
    const isolated = await createRowStorageFixture({ store: realStore, suffix: 'labels_ignored', accountId: account });
    await realStore.commitRevision(isolated.revision('rrev_labels_ignored', 1, rows.slice(0, 1)), isolated.lease);
    const bigquery = fakeBigQuery();
    const warnings = [];
    const onWarning = warning => warnings.push(warning);
    const base = { account_id: account, db: pool, store: realStore, loadTimeoutMilliseconds: 30_000 };
    process.on('warning', onWarning);
    let sink;
    try {
      // No labels, or an empty set, is not worth a warning.
      newSink(bigquery, { ...base, name: 'labels_none' });
      newSink(bigquery, { ...base, name: 'labels_empty', labels: {} });
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(
        warnings.filter(warning => warning.code === 'ADCP_BIGQUERY_SINK_LABELS_IGNORED'),
        []
      );
      sink = newSink(bigquery, { ...base, name: 'labels_ignored', labels: { team: 'ads' } });
      await new Promise(resolve => setImmediate(resolve));
    } finally {
      process.off('warning', onWarning);
    }
    const warning = warnings.find(entry => entry.code === 'ADCP_BIGQUERY_SINK_LABELS_IGNORED');
    assert.ok(warning, 'setting labels warns that they have no effect');
    assert.equal(warning.name, 'DeprecationWarning');
    await sink.runOnce();
    assert.ok(bigquery.loadOptions.length >= 1, 'the sink submitted loads');
    for (const { options } of bigquery.loadOptions) {
      assert.ok(!('labels' in options), 'labels are not sent inside configuration.load');
      assert.ok(!('jobTimeoutMs' in options), 'jobTimeoutMs is not sent inside configuration.load');
    }
    assert.deepEqual(bigquery.dropped, [], 'BigQuery would have dropped nothing the sink sent');
    for (const job of bigquery.jobs.values()) {
      assert.equal(job.configuration.labels, undefined);
      assert.equal(job.configuration.jobTimeoutMs, undefined);
    }
  });

  // Convergence of a load that outlasts its deadline (#3234). BigQuery does not stop a load the client gives up
  // on, and it refuses a resubmitted job ID only after the whole file is uploaded again, so the sink looks the
  // deterministic job up before every submission instead.
  async function convergenceHarness(
    t,
    suffix,
    { fake = {}, sink: sinkOptions = {}, tables = true, rowCount = 3 } = {}
  ) {
    const { pool, store: realStore } = await isolatedWarehouseStore(t, suffix);
    const account = `acct_${suffix}`;
    const isolated = await createRowStorageFixture({ store: realStore, suffix, accountId: account });
    await realStore.commitRevision(isolated.revision(`rrev_${suffix}`, 1, rows.slice(0, rowCount)), isolated.lease);
    const bigquery = createFakeBigQuery({ clientProject: 'client-project', ...fake });
    // Everything the sink sends, in order, so a test can see that a lookup came before an upload.
    const events = [];
    // hangUploads: the next N uploads never settle (a hung client call).
    const settings = { hangLookups: false, hangUploads: 0 };
    const instrumented = {
      dataset(datasetId, options) {
        const dataset = bigquery.dataset(datasetId, options);
        return {
          table: tableId => ({
            load(file, metadata) {
              events.push(`upload ${tableId} ${metadata.jobId}`);
              if (settings.hangUploads > 0) {
                settings.hangUploads -= 1;
                return new Promise(() => {});
              }
              return dataset.table(tableId).load(file, metadata);
            },
          }),
        };
      },
      job(jobId, options) {
        const job = bigquery.job(jobId, options);
        return {
          getMetadata: () => {
            events.push(`lookup ${jobId}`);
            return settings.hangLookups ? new Promise(() => {}) : job.getMetadata();
          },
          cancel: () => {
            events.push(`cancel ${jobId}`);
            return job.cancel();
          },
        };
      },
      query: (...args) => bigquery.query(...args),
    };
    const makeSink = (extra = {}) =>
      newSink(instrumented, {
        name: suffix,
        account_id: account,
        db: pool,
        store: realStore,
        location: 'US',
        loadTimeoutMilliseconds: 1_000,
        ...sinkOptions,
        ...extra,
      });
    const sink = makeSink();
    await bigquery.dataset('reporting', { projectId: 'adcp-reporting', location: 'US' }).create();
    const createTables = () => bigquery.query({ query: sink.defaultTablesSql });
    if (tables) await createTables();
    const harness = {
      pool,
      bigquery,
      events,
      settings,
      sink,
      makeSink,
      createTables,
      state: async () =>
        (await pool.query('SELECT * FROM adcp_reporting_warehouse_sinks WHERE sink_name = $1', [suffix])).rows[0],
      rowsLoaded: () => bigquery.state.tables.get('adcp-reporting.reporting.revision_rows')?.length ?? 0,
      uploads: tableId => bigquery.state.loadOptions.filter(entry => entry.tableId === tableId).length,
      jobIds: () => [...bigquery.state.jobs.keys()].map(key => key.split('/')[1]),
      // The retained plan's job ID, after a run that planned the batch but could not load it (no tables yet).
      async retainPlan() {
        await assert.rejects(sink.runOnce(), /Not found: Table/);
        const state = await harness.state();
        assert.ok(state.planned_to_cursor, 'the batch is planned and retained');
        const baseJobId = sinkModule.reportingWarehouseJobIdV1(
          suffix,
          state.planned_from_cursor,
          state.planned_to_cursor,
          state.reset_generation
        );
        await createTables();
        events.length = 0;
        return baseJobId;
      },
      seedJob(jobId, status) {
        const resource = { jobReference: { projectId: 'adcp-reporting', jobId, location: 'US' }, status };
        bigquery.state.jobs.set(`adcp-reporting/${jobId}`, resource);
        return resource;
      },
    };
    return harness;
  }

  const waitFor = async (condition, description) => {
    for (let waited = 0; waited < 10_000; waited += 25) {
      if (condition()) return;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.fail(`timed out waiting for ${description}`);
  };

  test('an upload slower than the deadline converges: rows load once and the job is found, not uploaded again (#3234)', async t => {
    const h = await convergenceHarness(t, 'slow_upload', {
      fake: { uploadMs: tableId => (tableId === 'revision_rows' ? 1_600 : 0) },
    });
    await assert.rejects(h.sink.runOnce(), /exceeded this run's 1000 ms deadline/);
    let state = await h.state();
    assert.ok(state.planned_to_cursor, 'the plan is retained');
    assert.equal(state.planned_rows_attempt, 0, 'a timeout never changes the job ID');
    assert.equal(state.planned_rows_timeouts, 1, 'the table remembers the timeout');
    assert.equal(state.planned_revisions_timeouts, 0);
    // The abandoned upload still reaches BigQuery and creates the job in the background.
    await waitFor(() => h.jobIds().some(id => id.endsWith('_rows')), 'the background upload to create the job');
    assert.deepEqual(await h.sink.runOnce(), { idle: false, revisions: 1, rows: 3, missing: [] });
    assert.equal(h.uploads('revision_rows'), 1, 'the rerun found the job and did not upload the file again');
    assert.equal(h.rowsLoaded(), 3, 'rows landed exactly once');
    assert.deepEqual(
      h
        .jobIds()
        .map(id => id.replace(/^adcp_rr_[0-9a-f]+/, ''))
        .sort(),
      ['_revs', '_rows']
    );
    state = await h.state();
    assert.equal(state.planned_to_cursor, null);
    assert.equal(state.planned_rows_timeouts, 0, 'the committed batch clears the table deadline growth');
    assert.deepEqual(h.bigquery.state.cancels, [], 'the sink never cancels a load');
    assert.deepEqual(await h.sink.runOnce(), { idle: true, revisions: 0, rows: 0, missing: [] });
  });

  test('a job that is not there yet is looked up first, and a 404 means upload', async t => {
    const h = await convergenceHarness(t, 'missing_job');
    assert.deepEqual(await h.sink.runOnce(), { idle: false, revisions: 1, rows: 3, missing: [] });
    assert.deepEqual(
      h.events.map(event => event.replace(/adcp_rr_[0-9a-f]+/, '')),
      ['lookup _rows', 'upload revision_rows _rows', 'lookup _revs', 'upload revisions _revs'],
      'a 404 on the lookup means upload'
    );
    assert.equal(h.rowsLoaded(), 3);
  });

  test('a job still running on the rerun is waited for, not uploaded again', async t => {
    const h = await convergenceHarness(t, 'running_job', { tables: false });
    const baseJobId = await h.retainPlan();
    const running = h.seedJob(`${baseJobId}_rows`, { state: 'RUNNING' });
    setTimeout(() => {
      running.status = { state: 'DONE' };
    }, 500);
    assert.deepEqual(await h.sink.runOnce(), { idle: false, revisions: 1, rows: 3, missing: [] });
    assert.equal(h.uploads('revision_rows'), 0, 'the running job was awaited, never uploaded again');
    assert.equal(h.uploads('revisions'), 1, 'the other table, with no job yet, was uploaded');
    assert.ok(h.events.filter(event => event === `lookup ${baseJobId}_rows`).length >= 2, 'the job was polled');
    assert.deepEqual(h.bigquery.state.cancels, []);
    assert.equal((await h.state()).planned_to_cursor, null);
  });

  test('a job still running when the deadline ends the run leaves the plan unchanged for the next run to check', async t => {
    const h = await convergenceHarness(t, 'running_past_deadline', { tables: false });
    const baseJobId = await h.retainPlan();
    const running = h.seedJob(`${baseJobId}_rows`, { state: 'PENDING' });
    const before = await h.state();
    await assert.rejects(
      h.sink.runOnce(),
      /Waiting for the running load job exceeded this run's 1000 ms deadline for the rows table "revision_rows" \(timeout count 0\)/
    );
    const after = await h.state();
    for (const column of [
      'committed_cursor',
      'planned_from_cursor',
      'planned_to_cursor',
      'planned_rows_attempt',
      'planned_revisions_attempt',
    ]) {
      assert.equal(after[column], before[column], `${column} did not advance`);
    }
    assert.equal(after.planned_rows_timeouts, 1, 'only the deadline grew');
    assert.equal(h.uploads('revision_rows'), 0);
    assert.equal(h.uploads('revisions'), 0, 'the batch stops at the table whose job is still running');
    assert.deepEqual(h.bigquery.state.cancels, [], 'the running job is not cancelled');
    // The next run checks the same job again, and finishes once it has finished.
    running.status = { state: 'DONE' };
    assert.deepEqual(await h.sink.runOnce(), { idle: false, revisions: 1, rows: 3, missing: [] });
    assert.equal(h.uploads('revision_rows'), 0);
  });

  test('a job that finished with an error is found without uploading, and only then does the attempt advance', async t => {
    const h = await convergenceHarness(t, 'failed_job', { tables: false });
    const baseJobId = await h.retainPlan();
    h.seedJob(`${baseJobId}_rows`, { state: 'DONE', errorResult: { reason: 'invalid', message: 'bad row' } });
    await assert.rejects(h.sink.runOnce(), /will be retried as a new attempt/);
    const state = await h.state();
    assert.equal(state.planned_rows_attempt, 1, 'that table advanced to the next job ID');
    assert.equal(state.planned_revisions_attempt, 0);
    assert.equal(state.planned_rows_timeouts, 0, 'a failure is not a timeout');
    assert.equal(
      h.uploads('revision_rows'),
      0,
      'the failed job was identified by its ID, not by uploading the file again'
    );
    assert.deepEqual(await h.sink.runOnce(), { idle: false, revisions: 1, rows: 3, missing: [] });
    assert.ok(h.jobIds().includes(`${baseJobId}_rows_a1`), 'the retry used the new job ID');
    assert.equal(h.rowsLoaded(), 3);
  });

  test('the deadline grows with each timeout, persists across runs and sink instances, and grows once under overlapping runs', async t => {
    const h = await convergenceHarness(t, 'deadline_growth', { tables: false });
    const baseJobId = await h.retainPlan();
    const running = h.seedJob(`${baseJobId}_rows`, { state: 'RUNNING' });
    await assert.rejects(h.sink.runOnce(), /exceeded this run's 1000 ms deadline/);
    assert.equal((await h.state()).planned_rows_timeouts, 1);
    // A different sink instance (a restarted process) reads the grown deadline from the plan.
    const restarted = h.makeSink();
    await assert.rejects(restarted.runOnce(), /exceeded this run's 2000 ms deadline/);
    const state = await h.state();
    assert.equal(state.planned_rows_timeouts, 2);
    assert.equal(state.planned_rows_attempt, 0, 'the job ID never changed');
    assert.deepEqual(h.jobIds(), [`${baseJobId}_rows`]);
    running.status = { state: 'DONE' };
    assert.deepEqual(await restarted.runOnce(), { idle: false, revisions: 1, rows: 3, missing: [] });

    // Two runs that time out together on the same observed value grow it once.
    const other = await convergenceHarness(t, 'deadline_growth_overlap', { tables: false });
    const otherBase = await other.retainPlan();
    other.seedJob(`${otherBase}_rows`, { state: 'RUNNING' });
    const results = await Promise.allSettled([other.sink.runOnce(), other.makeSink().runOnce()]);
    assert.ok(
      results.every(result => result.status === 'rejected' && /exceeded this run's/.test(result.reason.message)),
      results.map(result => result.reason?.message ?? result.status).join('; ')
    );
    assert.equal((await other.state()).planned_rows_timeouts, 1);
  });

  test('a rerun in the same process waits for the upload its previous run abandoned instead of uploading again', async t => {
    const h = await convergenceHarness(t, 'inflight_upload', {
      fake: { uploadMs: tableId => (tableId === 'revision_rows' ? 2_200 : 0) },
    });
    await assert.rejects(h.sink.runOnce(), /Uploading the load exceeded this run's 1000 ms deadline/);
    assert.equal(h.jobIds().length, 0, 'the job does not exist yet: the upload is still in flight');
    // The lookup finds nothing, but the abandoned upload is still running here: wait for it.
    assert.deepEqual(await h.sink.runOnce(), { idle: false, revisions: 1, rows: 3, missing: [] });
    assert.equal(h.uploads('revision_rows'), 1, 'one upload of the file served both runs');
    assert.equal(h.rowsLoaded(), 3);
    assert.equal((await h.state()).planned_to_cursor, null);
  });

  const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

  test('a gap between runs longer than the deadline still reuses the pending upload instead of starting a second', async t => {
    const h = await convergenceHarness(t, 'gap_reuse', {
      fake: { uploadMs: tableId => (tableId === 'revision_rows' ? 4_000 : 0) },
    });
    await assert.rejects(h.sink.runOnce(), /Uploading the load exceeded this run's 1000 ms deadline/);
    // The second run's deadline is 2 s; by the time it starts the upload is 3.5 s old, older than that
    // deadline, but it is still pending, so it is waited for rather than replaced.
    await pause(2_500);
    assert.deepEqual(await h.sink.runOnce(), { idle: false, revisions: 1, rows: 3, missing: [] });
    const rowUploads = h.events.filter(event => event.startsWith('upload revision_rows '));
    assert.equal(rowUploads.length, 1, `one upload started, saw: ${rowUploads.join('; ')}`);
    assert.equal(h.uploads('revision_rows'), 1, 'exactly one upload recorded by BigQuery');
    assert.equal(h.rowsLoaded(), 3);
    assert.equal((await h.state()).planned_to_cursor, null);
  });

  test('a run whose deadline expires while waiting on a reused upload counts as a timeout and the deadline grows', async t => {
    const h = await convergenceHarness(t, 'reuse_timeout_growth', {
      fake: { uploadMs: tableId => (tableId === 'revision_rows' ? 5_000 : 0) },
    });
    await assert.rejects(h.sink.runOnce(), /exceeded this run's 1000 ms deadline for the rows table "revision_rows"/);
    assert.equal((await h.state()).planned_rows_timeouts, 1);
    // The second run reuses the pending upload and runs out of its 2 s deadline waiting on it.
    await assert.rejects(
      h.sink.runOnce(),
      /Uploading the load exceeded this run's 2000 ms deadline for the rows table "revision_rows" \(timeout count 1\)/
    );
    const state = await h.state();
    assert.equal(state.planned_rows_timeouts, 2, 'a timeout waiting on a reused upload counts like a fresh one');
    assert.equal(state.planned_rows_attempt, 0);
    // The third run's 4 s deadline is enough for what remains of the one upload.
    assert.deepEqual(await h.sink.runOnce(), { idle: false, revisions: 1, rows: 3, missing: [] });
    assert.equal(h.events.filter(event => event.startsWith('upload revision_rows ')).length, 1);
    assert.equal(h.rowsLoaded(), 3);
  });

  test('an upload that never settles is reused until the largest deadline has passed, then replaced', async t => {
    const h = await convergenceHarness(t, 'hung_upload');
    const MAX_LOAD_TIMEOUT = 6 * 3_600_000;
    const rowUploads = () => h.events.filter(event => event.startsWith('upload revision_rows ')).length;
    t.mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_000 });
    h.settings.hangUploads = 1;
    await assert.rejects(h.sink.runOnce(), /exceeded this run's 1000 ms deadline for the rows table/);
    assert.equal(rowUploads(), 1);
    // Just under the ceiling the hung upload is still reused, not replaced.
    t.mock.timers.tick(MAX_LOAD_TIMEOUT - 5_000);
    await assert.rejects(h.sink.runOnce(), /exceeded this run's 2000 ms deadline for the rows table/);
    assert.equal(rowUploads(), 1, 'the hung upload was waited on, not replaced');
    // Past the ceiling it is abandoned and the replacement loads the batch.
    t.mock.timers.tick(10_000);
    assert.deepEqual(await h.sink.runOnce(), { idle: false, revisions: 1, rows: 3, missing: [] });
    assert.equal(rowUploads(), 2, 'one replacement upload after the ceiling');
    assert.equal(h.rowsLoaded(), 3, 'rows landed exactly once');
    assert.equal((await h.state()).planned_to_cursor, null);
  });

  test('timeout errors name the table, its ID, the deadline and that table own timeout count, and never a path', async t => {
    const h = await convergenceHarness(t, 'names_table', {
      fake: { uploadMs: tableId => (tableId === 'revisions' ? 1_600 : 0) },
    });
    // The rows table is fine; the revisions table times out. Its own counter starts at zero.
    const first = await h.sink.runOnce().then(
      () => assert.fail('expected a timeout'),
      error => error
    );
    assert.match(
      first.message,
      /exceeded this run's 1000 ms deadline for the revisions table "revisions" \(timeout count 0\)/
    );
    assert.equal((await h.state()).planned_revisions_timeouts, 1);
    assert.equal((await h.state()).planned_rows_timeouts, 0);
    assert.doesNotMatch(first.message, /adcp-warehouse-|ndjson|\/tmp|credential/i);
    // A lookup that exceeds its bound is named too.
    h.settings.hangLookups = true;
    const lookup = await h.sink.runOnce().then(
      () => assert.fail('expected a lookup timeout'),
      error => error
    );
    assert.match(lookup.message, /BigQuery call exceeded its deadline of 1000 ms for the rows table "revision_rows"/);
    assert.doesNotMatch(lookup.message, /adcp-warehouse-|ndjson|\/tmp|credential/i);
  });

  test('an upload refused with 409 because another process created the job moves on to that job', async t => {
    const h = await convergenceHarness(t, 'duplicate_upload', {
      fake: { uploadMs: tableId => (tableId === 'revision_rows' ? 1_600 : 0) },
    });
    await assert.rejects(h.sink.runOnce(), /exceeded this run's 1000 ms deadline/);
    // A second sink instance has no knowledge of the first one's upload (another process): the lookup still
    // finds no job, its own upload is refused after the background upload created it, and it then finds the job.
    const other = h.makeSink();
    assert.deepEqual(await other.runOnce(), { idle: false, revisions: 1, rows: 3, missing: [] });
    assert.equal(h.uploads('revision_rows'), 2, 'the second process uploaded and was refused');
    assert.equal(h.rowsLoaded(), 3, 'rows landed exactly once');
    assert.equal(h.jobIds().filter(id => /_rows/.test(id)).length, 1);
  });

  test('a refused job ID that cannot be found says which settings to check', async t => {
    const h = await convergenceHarness(t, 'unfindable_job', { tables: false, fake: { jobProject: 'client' } });
    const baseJobId = await h.retainPlan();
    // The job exists, but under another project than the sink looks in.
    h.bigquery.state.jobs.set(`client-project/${baseJobId}_rows`, { status: { state: 'DONE' } });
    await assert.rejects(h.sink.runOnce(), /already existing, but the job cannot be found.*projectId and location/);
    assert.equal(h.uploads('revision_rows'), 1);
  });

  test('the revisions table keeps its own deadline growth and finds its own job', async t => {
    const h = await convergenceHarness(t, 'revisions_job', { tables: false });
    const baseJobId = await h.retainPlan();
    h.seedJob(`${baseJobId}_rows`, { state: 'DONE' });
    const running = h.seedJob(`${baseJobId}_revs`, { state: 'RUNNING' });
    await assert.rejects(h.sink.runOnce(), /Waiting for the running load job exceeded this run's 1000 ms deadline/);
    const state = await h.state();
    assert.equal(state.planned_revisions_timeouts, 1);
    assert.equal(state.planned_rows_timeouts, 0);
    assert.equal(h.uploads('revision_rows') + h.uploads('revisions'), 0, 'both tables found their jobs');
    running.status = { state: 'DONE' };
    assert.deepEqual(await h.sink.runOnce(), { idle: false, revisions: 1, rows: 3, missing: [] });
    assert.equal(h.uploads('revision_rows') + h.uploads('revisions'), 0);
  });

  test('an abort ends the wait for a running job without growing the deadline or advancing anything', async t => {
    const h = await convergenceHarness(t, 'abort_wait', { tables: false });
    const baseJobId = await h.retainPlan();
    h.seedJob(`${baseJobId}_rows`, { state: 'RUNNING' });
    const controller = new AbortController();
    const running = h.sink.runOnce({ signal: controller.signal });
    await waitFor(() => h.events.filter(event => event === `lookup ${baseJobId}_rows`).length >= 2, 'a poll');
    controller.abort(new Error('shutting down'));
    await assert.rejects(running, /shutting down/);
    const state = await h.state();
    assert.equal(state.planned_rows_timeouts, 0);
    assert.equal(state.planned_rows_attempt, 0);
    assert.ok(state.planned_to_cursor, 'the plan is retained');
    assert.deepEqual(h.bigquery.state.cancels, []);
  });

  test('a job that disappears while it is awaited fails the run without being treated as a timeout', async t => {
    const h = await convergenceHarness(t, 'vanishing_job', { tables: false });
    const baseJobId = await h.retainPlan();
    h.seedJob(`${baseJobId}_rows`, { state: 'RUNNING' });
    setTimeout(() => h.bigquery.state.jobs.delete(`adcp-reporting/${baseJobId}_rows`), 300);
    await assert.rejects(h.sink.runOnce(), /disappeared while it was awaited/);
    assert.equal((await h.state()).planned_rows_timeouts, 0);
  });

  test('a status check that hangs is bounded by the base deadline and does not grow the load deadline', async t => {
    const h = await convergenceHarness(t, 'hung_lookup', { tables: false });
    const baseJobId = await h.retainPlan();
    h.seedJob(`${baseJobId}_rows`, { state: 'RUNNING' });
    h.settings.hangLookups = true;
    await assert.rejects(h.sink.runOnce(), /BigQuery call exceeded its deadline/);
    h.settings.hangLookups = false;
    const state = await h.state();
    assert.equal(state.planned_rows_timeouts, 0, 'a lookup that never answered says nothing about the load');
    assert.ok(state.planned_to_cursor);
  });

  test('reset() clears the deadline growth together with the plan', async t => {
    const h = await convergenceHarness(t, 'reset_growth', { tables: false });
    const baseJobId = await h.retainPlan();
    h.seedJob(`${baseJobId}_rows`, { state: 'RUNNING' });
    await assert.rejects(h.sink.runOnce(), /exceeded this run's 1000 ms deadline/);
    assert.equal((await h.state()).planned_rows_timeouts, 1);
    await h.sink.reset({ discardRetainedPlan: true });
    const state = await h.state();
    assert.equal(state.planned_rows_timeouts, 0);
    assert.equal(state.planned_revisions_timeouts, 0);
    assert.equal(state.planned_to_cursor, null);
  });

  test('the load deadline doubles per timeout and is capped at 6 hours', () => {
    const deadline = sinkModule.reportingWarehouseLoadDeadlineV1;
    assert.equal(deadline(1_000, 0), 1_000);
    assert.equal(deadline(1_000, 1), 2_000);
    assert.equal(deadline(1_000, 3), 8_000);
    assert.equal(deadline(600_000, 5), 19_200_000);
    assert.equal(deadline(600_000, 6), 21_600_000, 'capped at 6 hours');
    assert.equal(deadline(1_000, 1_000_000), 21_600_000);
    assert.equal(deadline(21_600_000, 0), 21_600_000);
    assert.equal(deadline(1_000, -3), 1_000);
  });

  test('a sink table from before the deadline columns asks for the idempotent migration', async t => {
    const { pool, store: realStore } = await isolatedWarehouseStore(t, 'no_timeout_columns');
    await pool.query('ALTER TABLE adcp_reporting_warehouse_sinks DROP COLUMN planned_rows_timeouts');
    const sink = newSink(fakeBigQuery(), {
      name: 'no_timeout_columns',
      account_id: 'acct_no_timeout_columns',
      db: pool,
      store: realStore,
    });
    await assert.rejects(sink.runOnce(), /apply REPORTING_WAREHOUSE_SINK_MIGRATION again/);
    await pool.query(sinkModule.REPORTING_WAREHOUSE_SINK_MIGRATION);
    assert.deepEqual(await sink.runOnce(), { idle: true, revisions: 0, rows: 0, missing: [] });
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

  async function expireAccount(account, db = pool) {
    await db.query(
      `UPDATE adcp_reporting_obligations
          SET period_start = period_start - INTERVAL '40 days', period_end = period_end - INTERVAL '40 days',
              created_at = created_at - INTERVAL '40 days', lease_expires_at = clock_timestamp() - INTERVAL '1 second'
        WHERE account_id = $1`,
      [account]
    );
    await db.query(
      `UPDATE adcp_reporting_revisions SET recorded_at = recorded_at - INTERVAL '40 days'
        WHERE obligation_id IN (
          SELECT obligation_id FROM adcp_reporting_obligations WHERE account_id = $1
        )`,
      [account]
    );
    await db.query(
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
      { retired: 1, failed: [], failures: [], deferred: 0, stuck: [] }
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
      { retired: 1, failed: [], failures: [], deferred: 0, stuck: [] }
    );
  });

  async function isolatedWarehouseStore(t, suffix) {
    const { Pool } = require('pg');
    const isolatedSchema = `${schema}_${suffix}`;
    await bootstrapPool.query(`CREATE SCHEMA "${isolatedSchema}"`);
    const pool = new Pool({ connectionString: DATABASE_URL, options: `-c search_path="${isolatedSchema}"` });
    t.after(async () => {
      await pool.end();
      await bootstrapPool.query(`DROP SCHEMA IF EXISTS "${isolatedSchema}" CASCADE`);
    });
    await pool.query(ledger.REPORTING_LEDGER_MIGRATION);
    await pool.query(ledger.REPORTING_ROW_STORAGE_MIGRATION);
    await pool.query(ledger.REPORTING_LEDGER_CHANGES_MIGRATION);
    await pool.query(sinkModule.REPORTING_WAREHOUSE_SINK_MIGRATION);
    const store = new ledger.PostgresReportingLedgerStore(pool, {
      acknowledgeIsolatedDatabase: true,
      rowStorage: true,
      changeFeed: true,
    });
    await store.readyRowStorage();
    return { pool, store };
  }

  test('an xmin-blocked deployment backlog does not renew an idle retention hold', async t => {
    const { pool, store } = await isolatedWarehouseStore(t, 'blocked_retention');
    const account = 'acct_blocked_retention';
    const bigquery = fakeBigQuery();
    const sink = newSink(bigquery, { name: 'blocked_retention', account_id: undefined, store, db: pool });
    await sink.runOnce();
    const jobsBefore = bigquery.jobs.size;
    assert.equal(jobsBefore, 0);
    const blocker = await pool.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT pg_current_xact_id()');
      const isolated = await createRowStorageFixture({ store, suffix: 'blocked_retention', accountId: account });
      await store.commitRevision(isolated.revision('rrev_blocked_retention_1', 1, rows.slice(0, 1)), isolated.lease);
      await expireAccount(account, pool);
      const committed = (
        await pool.query('SELECT committed_cursor FROM adcp_reporting_warehouse_sinks WHERE sink_name = $1', [
          'blocked_retention',
        ])
      ).rows[0].committed_cursor;
      // The change row exists, and the account feed holds it back while the blocker is in flight.
      assert.deepEqual((await store.changesAfter({ account_id: account })).records, []);
      assert.equal(
        (
          await pool.query(`SELECT 1 FROM adcp_reporting_changes WHERE account_id = $1 AND record_kind = 'revision'`, [
            account,
          ])
        ).rows.length,
        1
      );
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
        { retired: 1, failed: [], failures: [], deferred: 0, stuck: [] }
      );
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
    }
  });

  test('the non-revision fallback cannot silently advance past a concurrently pruned revision', async t => {
    const { pool, store: realStore } = await isolatedWarehouseStore(t, 'horizon_race');
    const bigquery = fakeBigQuery();
    let blocker;
    let blockerOpen = false;
    let armed = false;
    let fallback = false;
    let intercepted = false;
    let deleted;
    const observedStore = new ledger.PostgresReportingLedgerStore(
      {
        connect: pool.connect.bind(pool),
        async query(sql, values) {
          const result = await pool.query(sql, values);
          if (armed && fallback && !intercepted && sql.includes('SELECT pruned_through')) {
            intercepted = true;
            await blocker.query('COMMIT');
            blockerOpen = false;
            deleted = (await realStore.pruneChanges({ changeRetentionDays: 30, maxFeedHoldDays: 7 })).deleted;
          }
          return result;
        },
      },
      { acknowledgeIsolatedDatabase: true, rowStorage: true, changeFeed: true }
    );
    const sink = newSink(bigquery, {
      name: 'horizon_race',
      account_id: undefined,
      db: pool,
      store: wrapStore(observedStore, {
        async changesAfter(input) {
          fallback = !input.kinds;
          return observedStore.changesAfter(input);
        },
      }),
    });
    try {
      await sink.runOnce();
      const before = (await pool.query('SELECT * FROM adcp_reporting_warehouse_sinks')).rows[0];
      blocker = await pool.connect();
      await blocker.query('BEGIN');
      blockerOpen = true;
      await blocker.query('SELECT pg_current_xact_id()');
      const account = 'acct_horizon_old';
      const isolated = await createRowStorageFixture({ store: realStore, suffix: 'horizon_old', accountId: account });
      const revisionId = 'rrev_horizon_old';
      await realStore.commitRevision(isolated.revision(revisionId, 1, rows.slice(0, 1)), isolated.lease);
      await pool.query(
        `UPDATE adcp_reporting_changes SET recorded_at = clock_timestamp() - INTERVAL '40 days'
          WHERE obligation_id = $1`,
        [isolated.obligation.reporting_obligation_id]
      );
      await createRowStorageFixture({ store: realStore, suffix: 'horizon_fresh', accountId: 'acct_horizon_fresh' });
      await pool.query(`UPDATE adcp_reporting_feed_consumers SET updated_at = clock_timestamp() - INTERVAL '8 days'`);
      assert.deepEqual((await realStore.changesAfter({ cursor: before.committed_cursor })).records, []);
      // The change row exists, and the account feed holds it back while the blocker is in flight.
      assert.deepEqual((await realStore.changesAfter({ account_id: account })).records, []);
      assert.equal(
        (
          await pool.query(`SELECT 1 FROM adcp_reporting_changes WHERE account_id = $1 AND record_kind = 'revision'`, [
            account,
          ])
        ).rows.length,
        1
      );
      armed = true;
      await assert.rejects(sink.runOnce(), ledger.ReportingChangeCursorExpiredError);
      assert.equal(intercepted, true);
      assert.equal(deleted, 2);
      assert.ok(await realStore.getRevisionMetadata(revisionId, account));
      assert.deepEqual((await pool.query('SELECT * FROM adcp_reporting_warehouse_sinks')).rows[0], before);
      assert.equal(bigquery.jobs.size, 0);
      await assert.rejects(sink.runOnce(), ledger.ReportingChangeCursorExpiredError);
    } finally {
      if (blockerOpen) await blocker.query('ROLLBACK');
      blocker?.release();
    }
  });

  test('a cold-start fallback preserves the completed revision page cursor across pruning', async t => {
    const { pool, store } = await isolatedWarehouseStore(t, 'cold_horizon_race');
    const bigquery = fakeBigQuery();
    let blocker;
    let blockerOpen = false;
    let intercepted = false;
    let deleted;
    try {
      blocker = await pool.connect();
      await blocker.query('BEGIN');
      blockerOpen = true;
      await blocker.query('SELECT pg_current_xact_id()');
      const account = 'acct_cold_horizon_old';
      const isolated = await createRowStorageFixture({ store, suffix: 'cold_horizon_old', accountId: account });
      const revisionId = 'rrev_cold_horizon_old';
      await store.commitRevision(isolated.revision(revisionId, 1, rows.slice(0, 1)), isolated.lease);
      await pool.query(
        `UPDATE adcp_reporting_changes SET recorded_at = clock_timestamp() - INTERVAL '40 days'
          WHERE obligation_id = $1`,
        [isolated.obligation.reporting_obligation_id]
      );
      await createRowStorageFixture({ store, suffix: 'cold_horizon_fresh', accountId: 'acct_cold_horizon_fresh' });
      // The change row exists, and the account feed holds it back while the blocker is in flight.
      assert.deepEqual((await store.changesAfter({ account_id: account })).records, []);
      assert.equal(
        (
          await pool.query(`SELECT 1 FROM adcp_reporting_changes WHERE account_id = $1 AND record_kind = 'revision'`, [
            account,
          ])
        ).rows.length,
        1
      );
      const sink = newSink(bigquery, {
        name: 'cold_horizon_race',
        account_id: undefined,
        db: pool,
        store: wrapStore(store, {
          async changesAfter(input) {
            let page;
            try {
              page = await store.changesAfter(input);
            } catch (error) {
              if (intercepted && !input.kinds && error instanceof ledger.ReportingChangeCursorExpiredError) {
                // An older compatible store does not attach a starting cursor.
                throw new ledger.ReportingChangeCursorExpiredError();
              }
              throw error;
            }
            if (!intercepted && input.kinds?.includes('revision')) {
              intercepted = true;
              assert.equal(input.cursor, undefined, 'the sink has no committed starting cursor');
              assert.deepEqual(page.records, [], 'the open transaction hides the committed revision');
              await blocker.query('COMMIT');
              blockerOpen = false;
              deleted = (await store.pruneChanges({ changeRetentionDays: 30 })).deleted;
            }
            return page;
          },
        }),
      });
      await assert.rejects(sink.runOnce(), ledger.ReportingChangeCursorExpiredError);
      const retry = newSink(bigquery, {
        name: 'cold_horizon_race',
        account_id: undefined,
        db: pool,
        store,
      });
      await assert.rejects(retry.runOnce(), ledger.ReportingChangeCursorExpiredError);
      await assert.rejects(retry.runOnce(), ledger.ReportingChangeCursorExpiredError);
      assert.equal(intercepted, true);
      assert.equal(deleted, 2);
      assert.ok(await store.getRevisionMetadata(revisionId, account));
      const state = (await pool.query('SELECT * FROM adcp_reporting_warehouse_sinks')).rows[0];
      assert.equal(ledger.decodeReportingChangeCursorV1(state.committed_cursor, null).seq, '0');
      assert.equal(state.planned_to_cursor, null);
      assert.equal(bigquery.jobs.size, 0);
      assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM adcp_reporting_feed_consumers')).rows[0].n, 0);
    } finally {
      if (blockerOpen) await blocker.query('ROLLBACK');
      blocker?.release();
    }
  });

  for (const scope of ['account', 'deployment']) {
    test(`a cold-start ${scope} feed keeps an in-read expiry fenced across retries`, async t => {
      const { pool, store: realStore } = await isolatedWarehouseStore(t, `initial_expiry_${scope}`);
      const account = `acct_initial_expiry_${scope}`;
      const bigquery = fakeBigQuery();
      let blocker;
      let blockerOpen = false;
      let intercepted = false;
      let deleted;
      try {
        if (scope === 'deployment') {
          blocker = await pool.connect();
          await blocker.query('BEGIN');
          blockerOpen = true;
          await blocker.query('SELECT pg_current_xact_id()');
        }
        const isolated = await createRowStorageFixture({
          store: realStore,
          suffix: `initial_expiry_${scope}`,
          accountId: account,
        });
        const revisionId = `rrev_initial_expiry_${scope}`;
        await realStore.commitRevision(isolated.revision(revisionId, 1, rows.slice(0, 1)), isolated.lease);
        await pool.query(
          `UPDATE adcp_reporting_changes SET recorded_at = clock_timestamp() - INTERVAL '40 days'
            WHERE obligation_id = $1`,
          [isolated.obligation.reporting_obligation_id]
        );
        await createRowStorageFixture({
          store: realStore,
          suffix: `initial_expiry_fresh_${scope}`,
          accountId: account,
        });
        const observedStore = new ledger.PostgresReportingLedgerStore(
          {
            connect: pool.connect.bind(pool),
            async query(sql, values) {
              const result = await pool.query(sql, values);
              if (!intercepted && sql.includes('SELECT pruned_through')) {
                intercepted = true;
                if (blockerOpen) {
                  await blocker.query('COMMIT');
                  blockerOpen = false;
                }
                deleted = (await realStore.pruneChanges({ changeRetentionDays: 30 })).deleted;
              }
              return result;
            },
          },
          { acknowledgeIsolatedDatabase: true, rowStorage: true, changeFeed: true }
        );
        const options = {
          name: `initial_expiry_${scope}`,
          account_id: scope === 'account' ? account : undefined,
          db: pool,
          store: observedStore,
        };
        await assert.rejects(newSink(bigquery, options).runOnce(), ledger.ReportingChangeCursorExpiredError);
        const before = (await pool.query('SELECT * FROM adcp_reporting_warehouse_sinks')).rows[0];
        const retry = newSink(bigquery, options);
        await assert.rejects(retry.runOnce(), ledger.ReportingChangeCursorExpiredError);
        await assert.rejects(retry.runOnce(), ledger.ReportingChangeCursorExpiredError);
        assert.ok(intercepted, 'pruning happened inside the first cursorless read');
        assert.equal(deleted, 2);
        assert.equal(
          ledger.decodeReportingChangeCursorV1(before.committed_cursor, options.account_id ?? null).seq,
          '0'
        );
        assert.deepEqual((await pool.query('SELECT * FROM adcp_reporting_warehouse_sinks')).rows[0], before);
        assert.ok(await realStore.getRevisionMetadata(revisionId, account));
        assert.equal(bigquery.jobs.size, 0);
        assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM adcp_reporting_feed_consumers')).rows[0].n, 0);
      } finally {
        if (blockerOpen) await blocker.query('ROLLBACK');
        blocker?.release();
      }
    });
  }

  test('a startup prune race is recognised by error code, not by error class', async t => {
    const { pool, store: realStore } = await isolatedWarehouseStore(t, 'expired_by_code');
    const account = 'acct_expired_by_code';
    const bigquery = fakeBigQuery();
    const startCursor = ledger.encodeReportingChangeCursorV1({ v: 1, account, seq: '0' });
    const lookalike = Object.assign(new Error('expired in another module instance'), {
      code: 'CURSOR_EXPIRED',
      cursor: startCursor,
    });
    assert.ok(!(lookalike instanceof ledger.ReportingChangeCursorExpiredError));
    const options = {
      name: 'expired_by_code',
      account_id: account,
      db: pool,
      store: wrapStore(realStore, {
        async changesAfter() {
          throw lookalike;
        },
      }),
    };
    await assert.rejects(newSink(bigquery, options).runOnce(), error => error === lookalike);
    assert.equal(
      (await pool.query('SELECT committed_cursor FROM adcp_reporting_warehouse_sinks')).rows[0].committed_cursor,
      startCursor,
      'the start position is saved so the gap keeps being reported'
    );
    // A look-alike without the code is an ordinary failure and saves nothing.
    await pool.query('DELETE FROM adcp_reporting_warehouse_sinks');
    const ordinary = Object.assign(new Error('other'), { cursor: startCursor });
    await assert.rejects(
      newSink(bigquery, {
        ...options,
        store: wrapStore(realStore, {
          async changesAfter() {
            throw ordinary;
          },
        }),
      }).runOnce(),
      error => error === ordinary
    );
    assert.equal(
      (await pool.query('SELECT committed_cursor FROM adcp_reporting_warehouse_sinks')).rows[0].committed_cursor,
      null
    );
  });

  test('reset() clears a new sink that wedged on a startup prune race, and unregisters its consumer', async t => {
    const { pool, store: realStore } = await isolatedWarehouseStore(t, 'reset_wedge');
    const account = 'acct_reset_wedge';
    const bigquery = fakeBigQuery();
    const old = await createRowStorageFixture({ store: realStore, suffix: 'reset_wedge_old', accountId: account });
    await realStore.commitRevision(old.revision('rrev_reset_wedge_old', 1, rows.slice(0, 1)), old.lease);
    await pool.query(
      `UPDATE adcp_reporting_changes SET recorded_at = clock_timestamp() - INTERVAL '40 days'
        WHERE obligation_id = $1`,
      [old.obligation.reporting_obligation_id]
    );
    await createRowStorageFixture({ store: realStore, suffix: 'reset_wedge_fresh', accountId: account });
    let intercepted = false;
    const racingStore = new ledger.PostgresReportingLedgerStore(
      {
        connect: pool.connect.bind(pool),
        async query(sql, values) {
          const result = await pool.query(sql, values);
          if (!intercepted && sql.includes('SELECT pruned_through')) {
            intercepted = true;
            await realStore.pruneChanges({ changeRetentionDays: 30 });
          }
          return result;
        },
      },
      { acknowledgeIsolatedDatabase: true, rowStorage: true, changeFeed: true }
    );
    const options = { name: 'reset_wedge', account_id: account, db: pool, store: racingStore };
    await assert.rejects(newSink(bigquery, options).runOnce(), { code: 'CURSOR_EXPIRED' });
    const wedged = newSink(bigquery, { ...options, store: realStore });
    await assert.rejects(wedged.runOnce(), { code: 'CURSOR_EXPIRED' });
    await realStore.saveFeedConsumerCursor(
      'reset_wedge',
      ledger.encodeReportingChangeCursorV1({ v: 1, account, seq: '0' })
    );
    const consumers = async () =>
      (
        await pool.query('SELECT COUNT(*)::int AS n FROM adcp_reporting_feed_consumers WHERE consumer_name = $1', [
          'reset_wedge',
        ])
      ).rows[0].n;
    assert.equal(await consumers(), 1);

    assert.deepEqual(await wedged.reset(), { cleared: true });
    const state = (await pool.query('SELECT * FROM adcp_reporting_warehouse_sinks')).rows[0];
    assert.equal(state.committed_cursor, null);
    assert.equal(state.planned_to_cursor, null);
    assert.equal(await consumers(), 0, 'the old checkpoint no longer holds retention');

    assert.deepEqual(await wedged.runOnce(), { idle: true, revisions: 0, rows: 0, missing: [] });
    const next = await createRowStorageFixture({ store: realStore, suffix: 'reset_wedge_next', accountId: account });
    await realStore.commitRevision(next.revision('rrev_reset_wedge_next', 1, rows.slice(0, 2)), next.lease);
    assert.deepEqual(await wedged.runOnce(), { idle: false, revisions: 1, rows: 2, missing: [] });
    assert.equal(await consumers(), 1, 'the next committed batch registers a fresh consumer');
  });

  test('reset() refuses to drop a retained plan unless told to, and is a no-op for an unknown sink', async t => {
    const { pool, store: realStore } = await isolatedWarehouseStore(t, 'reset_plan');
    const account = 'acct_reset_plan';
    const bigquery = fakeBigQuery();
    const sink = newSink(bigquery, { name: 'reset_plan', account_id: account, db: pool, store: realStore });
    assert.deepEqual(await sink.reset(), { cleared: false }, 'nothing saved yet');
    const isolated = await createRowStorageFixture({ store: realStore, suffix: 'reset_plan', accountId: account });
    await realStore.commitRevision(isolated.revision('rrev_reset_plan', 1, rows.slice(0, 1)), isolated.lease);
    await realStore.saveFeedConsumerCursor(
      'reset_plan',
      ledger.encodeReportingChangeCursorV1({ v: 1, account, seq: '0' })
    );
    bigquery.failNext('revision_rows', 'job');
    await assert.rejects(sink.runOnce(), /Job failed/);
    await assert.rejects(sink.runOnce(), /will be retried as a new attempt/);
    const retained = (await pool.query('SELECT * FROM adcp_reporting_warehouse_sinks')).rows[0];
    assert.notEqual(retained.planned_to_cursor, null);
    assert.equal(retained.planned_rows_attempt, 1, 'the retained plan carries a retry attempt');
    await assert.rejects(sink.reset(), /retained batch plan/);
    assert.deepEqual((await pool.query('SELECT * FROM adcp_reporting_warehouse_sinks')).rows[0], retained);
    assert.equal(
      (
        await pool.query('SELECT COUNT(*)::int AS n FROM adcp_reporting_feed_consumers WHERE consumer_name = $1', [
          'reset_plan',
        ])
      ).rows[0].n,
      1,
      'a refused reset leaves the consumer registered'
    );
    assert.deepEqual(await sink.reset({ discardRetainedPlan: true }), { cleared: true });
    const cleared = (await pool.query('SELECT * FROM adcp_reporting_warehouse_sinks')).rows[0];
    assert.equal(cleared.committed_cursor, null);
    assert.equal(cleared.planned_to_cursor, null);
    assert.equal(cleared.planned_rows_attempt, 0, 'the retry attempt is cleared with the plan');
  });

  test('after reset() the same batches load again under a new job ID generation', async t => {
    const { pool, store: realStore } = await isolatedWarehouseStore(t, 'reset_generation');
    const account = 'acct_reset_generation';
    const bigquery = fakeBigQuery();
    const isolated = await createRowStorageFixture({
      store: realStore,
      suffix: 'reset_generation',
      accountId: account,
    });
    await realStore.commitRevision(isolated.revision('rrev_reset_generation', 1, rows.slice(0, 3)), isolated.lease);
    const sink = newSink(bigquery, { name: 'reset_generation', account_id: account, db: pool, store: realStore });
    assert.deepEqual(await sink.runOnce(), { idle: false, revisions: 1, rows: 3, missing: [] });
    const firstJobs = [...bigquery.jobs.keys()];
    assert.equal(firstJobs.length, 2);

    // The operator empties the warehouse tables and resets the sink to rebuild them.
    bigquery.tables.clear();
    assert.deepEqual(await sink.reset(), { cleared: true });
    assert.deepEqual(await sink.runOnce(), { idle: false, revisions: 1, rows: 3, missing: [] });
    assert.equal(
      bigquery.tables.get('reporting.revision_rows')?.length,
      3,
      'the emptied table was reloaded, not skipped as an already-finished job'
    );
    const allJobs = [...bigquery.jobs.keys()];
    assert.equal(allJobs.length, 4, 'the rebuild submitted its own jobs');
    assert.ok(firstJobs.every(id => allJobs.includes(id)));
    assert.equal(
      (await pool.query('SELECT reset_generation FROM adcp_reporting_warehouse_sinks')).rows[0].reset_generation,
      1
    );
    // Generation 0 keeps its historical job IDs, so plans in flight survive the upgrade.
    assert.equal(
      sinkModule.reportingWarehouseJobIdV1('s', null, 'c'),
      sinkModule.reportingWarehouseJobIdV1('s', null, 'c', 0)
    );
    assert.notEqual(
      sinkModule.reportingWarehouseJobIdV1('s', null, 'c'),
      sinkModule.reportingWarehouseJobIdV1('s', null, 'c', 1)
    );
  });

  test('reset() needs a store that can unregister consumers, and a failed unregister says to retry', async t => {
    const { pool, store: realStore } = await isolatedWarehouseStore(t, 'reset_store');
    const account = 'acct_reset_store';
    const bigquery = fakeBigQuery();
    const withoutRemoval = newSink(bigquery, {
      name: 'reset_store',
      account_id: account,
      db: pool,
      store: wrapStore(realStore, { removeFeedConsumer: undefined }),
    });
    await assert.rejects(withoutRemoval.reset(), TypeError);
    const failing = newSink(bigquery, {
      name: 'reset_store',
      account_id: account,
      db: pool,
      store: wrapStore(realStore, {
        async removeFeedConsumer() {
          throw new Error('connection lost');
        },
      }),
    });
    await assert.rejects(
      failing.reset(),
      error => /call reset\(\) again/.test(error.message) && error.cause instanceof Error
    );
    const retry = newSink(bigquery, { name: 'reset_store', account_id: account, db: pool, store: realStore });
    assert.deepEqual(await retry.reset(), { cleared: false });
  });

  test('a sink scoped to one account refuses a retained plan for another account', async t => {
    const { pool, store: realStore } = await isolatedWarehouseStore(t, 'plan_scope');
    const bigquery = fakeBigQuery();
    const sink = newSink(bigquery, { name: 'plan_scope', account_id: 'acct_plan_scope', db: pool, store: realStore });
    await sink.runOnce();
    const cursor = ledger.encodeReportingChangeCursorV1({ v: 1, account: 'acct_plan_scope', seq: '0' });
    await pool.query(
      `UPDATE adcp_reporting_warehouse_sinks
          SET planned_from_cursor = committed_cursor, planned_to_cursor = $1, planned_revisions = $2::jsonb`,
      [cursor, JSON.stringify([{ id: 'rrev_elsewhere', account_id: 'acct_other' }])]
    );
    await assert.rejects(sink.runOnce(), /another account/);
    assert.equal(bigquery.jobs.size, 0);
  });

  test('a stale run cannot overwrite a competing plan that is claimed but not yet committed', async t => {
    const { pool, store: realStore } = await isolatedWarehouseStore(t, 'pending_claim');
    const account = 'acct_pending_claim';
    const isolated = await createRowStorageFixture({ store: realStore, suffix: 'pending_claim', accountId: account });
    const bigquery = fakeBigQuery();
    await realStore.commitRevision(isolated.revision('rrev_pending_claim_1', 1, rows.slice(0, 1)), isolated.lease);
    const read = latch();
    const resumeStale = latch();
    let pause = true;
    const stale = newSink(bigquery, {
      name: 'pending_claim',
      account_id: account,
      db: pool,
      store: wrapStore(realStore, {
        async changesAfter(input) {
          const page = await realStore.changesAfter(input);
          if (pause) {
            pause = false;
            read.resolve();
            await resumeStale.promise;
          }
          return page;
        },
      }),
    });
    const pendingStale = stale.runOnce();
    pendingStale.catch(() => {});
    await read.promise;
    // Another revision lands, so the next run plans a different, larger batch.
    await realStore.commitRevision(
      isolated.revision('rrev_pending_claim_2', 2, rows.slice(0, 1), {
        supersedes_reporting_revision_id: 'rrev_pending_claim_1',
      }),
      isolated.lease
    );
    const claimed = latch();
    const resumeWinner = latch();
    const winner = newSink(bigquery, {
      name: 'pending_claim',
      account_id: account,
      db: pool,
      store: wrapStore(realStore, {
        async getRevisionMetadata(...args) {
          // The plan is claimed before revisions are read, so the claim is pending here.
          claimed.resolve();
          await resumeWinner.promise;
          return realStore.getRevisionMetadata(...args);
        },
      }),
    });
    const pendingWinner = winner.runOnce();
    pendingWinner.catch(() => {});
    await claimed.promise;
    resumeStale.resolve();
    await assert.rejects(pendingStale, /plan changed/);
    resumeWinner.resolve();
    assert.deepEqual(await pendingWinner, { idle: false, revisions: 2, rows: 2, missing: [] });
    const ids = (bigquery.tables.get('reporting.revision_rows') ?? []).map(row => row.reporting_revision_id);
    assert.deepEqual([...new Set(ids)], ids, 'no revision loaded twice');
    assert.equal(ids.length, 2);
  });

  test('a cold-start expiry pin cannot rewind a cursor a competing run already committed', async t => {
    const { pool, store: realStore } = await isolatedWarehouseStore(t, 'pin_committed');
    const account = 'acct_pin_committed';
    const isolated = await createRowStorageFixture({ store: realStore, suffix: 'pin_committed', accountId: account });
    await realStore.commitRevision(isolated.revision('rrev_pin_committed', 1, rows.slice(0, 1)), isolated.lease);
    await pool.query(`UPDATE adcp_reporting_changes SET recorded_at = clock_timestamp() - INTERVAL '40 days'`);
    const horizonRead = latch();
    const resumeRead = latch();
    let intercepted = false;
    const observedStore = new ledger.PostgresReportingLedgerStore(
      {
        connect: pool.connect.bind(pool),
        async query(sql, values) {
          const result = await pool.query(sql, values);
          if (!intercepted && sql.includes('SELECT pruned_through')) {
            intercepted = true;
            horizonRead.resolve();
            await resumeRead.promise;
          }
          return result;
        },
      },
      { acknowledgeIsolatedDatabase: true, rowStorage: true, changeFeed: true }
    );
    const bigquery = fakeBigQuery();
    const options = { name: 'pin_committed', account_id: account, db: pool };
    const losing = newSink(bigquery, { ...options, store: observedStore }).runOnce();
    losing.catch(() => {});
    await horizonRead.promise;
    // A competing run completes the batch while the first run is mid-read.
    assert.equal((await newSink(bigquery, { ...options, store: realStore }).runOnce()).revisions, 1);
    const committed = (await pool.query('SELECT committed_cursor FROM adcp_reporting_warehouse_sinks')).rows[0]
      .committed_cursor;
    assert.equal((await realStore.pruneChanges({ changeRetentionDays: 30 })).deleted, 2);
    resumeRead.resolve();
    await assert.rejects(losing, { code: 'CURSOR_EXPIRED' });
    assert.equal(
      (await pool.query('SELECT committed_cursor FROM adcp_reporting_warehouse_sinks')).rows[0].committed_cursor,
      committed,
      'the expiry pin did not rewind the winner’s committed cursor'
    );
  });

  test('a sink table from before reset_generation asks for the idempotent migration', async t => {
    const { pool, store: realStore } = await isolatedWarehouseStore(t, 'old_table');
    const bigquery = fakeBigQuery();
    await pool.query('ALTER TABLE adcp_reporting_warehouse_sinks DROP COLUMN reset_generation');
    const sink = newSink(bigquery, { name: 'old_table', account_id: 'acct_old_table', db: pool, store: realStore });
    await assert.rejects(sink.runOnce(), /apply REPORTING_WAREHOUSE_SINK_MIGRATION again/);
    await assert.rejects(sink.reset(), /apply REPORTING_WAREHOUSE_SINK_MIGRATION again/);
    await pool.query(sinkModule.REPORTING_WAREHOUSE_SINK_MIGRATION);
    assert.deepEqual(await sink.runOnce(), { idle: true, revisions: 0, rows: 0, missing: [] });
  });

  test('a run planned before reset() cannot commit over the identical plan claimed after it', async t => {
    const { pool, store: realStore } = await isolatedWarehouseStore(t, 'gen_commit');
    const account = 'acct_gen_commit';
    const isolated = await createRowStorageFixture({ store: realStore, suffix: 'gen_commit', accountId: account });
    await realStore.commitRevision(isolated.revision('rrev_gen_commit', 1, rows.slice(0, 1)), isolated.lease);
    const bigquery = fakeBigQuery();
    const staleClaimed = latch();
    const resumeStale = latch();
    const winnerClaimed = latch();
    const resumeWinner = latch();
    const gated = (claimed, resume) => {
      let first = true;
      return wrapStore(realStore, {
        async getRevisionMetadata(...args) {
          if (first) {
            first = false;
            claimed.resolve();
            await resume.promise;
          }
          return realStore.getRevisionMetadata(...args);
        },
      });
    };
    const options = { name: 'gen_commit', account_id: account, db: pool };
    const stale = newSink(bigquery, { ...options, store: gated(staleClaimed, resumeStale) }).runOnce();
    stale.catch(() => {});
    await staleClaimed.promise;
    // The operator discards that plan and resets; the next run claims an identical plan (same range, same revisions).
    await newSink(bigquery, options).reset({ discardRetainedPlan: true });
    const winner = newSink(bigquery, { ...options, store: gated(winnerClaimed, resumeWinner) }).runOnce();
    winner.catch(() => {});
    await winnerClaimed.promise;
    resumeStale.resolve();
    await assert.rejects(stale, /plan changed/);
    const mid = (await pool.query('SELECT * FROM adcp_reporting_warehouse_sinks')).rows[0];
    assert.equal(mid.committed_cursor, null, 'the stale run did not commit the new generation’s plan');
    assert.equal(mid.planned_rows_attempt, 0);
    assert.equal(mid.reset_generation, 1);
    resumeWinner.resolve();
    assert.equal((await winner).revisions, 1);
    assert.notEqual(
      (await pool.query('SELECT committed_cursor FROM adcp_reporting_warehouse_sinks')).rows[0].committed_cursor,
      null
    );
  });

  test('a run that read its state before reset() cannot claim a plan after it', async t => {
    const { pool, store: realStore } = await isolatedWarehouseStore(t, 'gen_claim');
    const account = 'acct_gen_claim';
    const isolated = await createRowStorageFixture({ store: realStore, suffix: 'gen_claim', accountId: account });
    await realStore.commitRevision(isolated.revision('rrev_gen_claim', 1, rows.slice(0, 1)), isolated.lease);
    const bigquery = fakeBigQuery();
    const read = latch();
    const resume = latch();
    let paused = false;
    const options = { name: 'gen_claim', account_id: account, db: pool };
    const stale = newSink(bigquery, {
      ...options,
      store: wrapStore(realStore, {
        async changesAfter(input) {
          const page = await realStore.changesAfter(input);
          if (!paused) {
            paused = true;
            read.resolve();
            await resume.promise;
          }
          return page;
        },
      }),
    }).runOnce();
    stale.catch(() => {});
    await read.promise;
    await newSink(bigquery, options).reset();
    resume.resolve();
    await assert.rejects(stale, /plan changed/);
    assert.equal(bigquery.jobs.size, 0, 'the stale run submitted nothing');
    assert.equal(
      (await pool.query('SELECT planned_to_cursor FROM adcp_reporting_warehouse_sinks')).rows[0].planned_to_cursor,
      null
    );
  });

  test('a cold-start expiry pin from before reset() is not written after it', async t => {
    const { pool, store: realStore } = await isolatedWarehouseStore(t, 'gen_pin');
    const account = 'acct_gen_pin';
    const isolated = await createRowStorageFixture({ store: realStore, suffix: 'gen_pin', accountId: account });
    await realStore.commitRevision(isolated.revision('rrev_gen_pin', 1, rows.slice(0, 1)), isolated.lease);
    await pool.query(`UPDATE adcp_reporting_changes SET recorded_at = clock_timestamp() - INTERVAL '40 days'`);
    const horizonRead = latch();
    const resumeRead = latch();
    let intercepted = false;
    const observedStore = new ledger.PostgresReportingLedgerStore(
      {
        connect: pool.connect.bind(pool),
        async query(sql, values) {
          const result = await pool.query(sql, values);
          if (!intercepted && sql.includes('SELECT pruned_through')) {
            intercepted = true;
            horizonRead.resolve();
            await resumeRead.promise;
          }
          return result;
        },
      },
      { acknowledgeIsolatedDatabase: true, rowStorage: true, changeFeed: true }
    );
    const bigquery = fakeBigQuery();
    const options = { name: 'gen_pin', account_id: account, db: pool };
    const losing = newSink(bigquery, { ...options, store: observedStore }).runOnce();
    losing.catch(() => {});
    await horizonRead.promise;
    await newSink(bigquery, { ...options, store: realStore }).reset();
    assert.equal((await realStore.pruneChanges({ changeRetentionDays: 30 })).deleted, 2);
    resumeRead.resolve();
    await assert.rejects(losing, { code: 'CURSOR_EXPIRED' });
    assert.equal(
      (await pool.query('SELECT committed_cursor FROM adcp_reporting_warehouse_sinks')).rows[0].committed_cursor,
      null,
      'a pin read before the reset must not wedge the reset sink again'
    );
  });

  test('a cold-start expiry pin cannot replace a competing pending plan', async t => {
    const { pool, store: realStore } = await isolatedWarehouseStore(t, 'expiry_claim');
    const account = 'acct_expiry_claim';
    const isolated = await createRowStorageFixture({ store: realStore, suffix: 'expiry_claim', accountId: account });
    await realStore.commitRevision(isolated.revision('rrev_expiry_claim', 1, rows.slice(0, 1)), isolated.lease);
    await pool.query(`UPDATE adcp_reporting_changes SET recorded_at = clock_timestamp() - INTERVAL '40 days'`);
    const horizonRead = latch();
    const resumeRead = latch();
    const winnerClaimed = latch();
    const resumeWinner = latch();
    let intercepted = false;
    const observedStore = new ledger.PostgresReportingLedgerStore(
      {
        connect: pool.connect.bind(pool),
        async query(sql, values) {
          const result = await pool.query(sql, values);
          if (!intercepted && sql.includes('SELECT pruned_through')) {
            intercepted = true;
            horizonRead.resolve();
            await resumeRead.promise;
          }
          return result;
        },
      },
      { acknowledgeIsolatedDatabase: true, rowStorage: true, changeFeed: true }
    );
    const bigquery = fakeBigQuery();
    const options = { name: 'expiry_claim', account_id: account, db: pool };
    const losing = newSink(bigquery, { ...options, store: observedStore }).runOnce();
    losing.catch(() => {});
    let winning;
    try {
      await horizonRead.promise;
      winning = newSink(bigquery, {
        ...options,
        store: wrapStore(realStore, {
          async getRevisionMetadata(...args) {
            const revision = await realStore.getRevisionMetadata(...args);
            winnerClaimed.resolve();
            await resumeWinner.promise;
            return revision;
          },
        }),
      }).runOnce();
      winning.catch(() => {});
      await winnerClaimed.promise;
      const plan = (await pool.query('SELECT * FROM adcp_reporting_warehouse_sinks')).rows[0];
      assert.equal(plan.committed_cursor, null);
      assert.ok(plan.planned_to_cursor);
      assert.equal((await realStore.pruneChanges({ changeRetentionDays: 30 })).deleted, 2);
      resumeRead.resolve();
      await assert.rejects(losing, ledger.ReportingChangeCursorExpiredError);
      assert.deepEqual((await pool.query('SELECT * FROM adcp_reporting_warehouse_sinks')).rows[0], plan);
      assert.equal(bigquery.jobs.size, 0);
    } finally {
      resumeRead.resolve();
      resumeWinner.resolve();
      await Promise.allSettled([losing, ...(winning ? [winning] : [])]);
    }
    assert.equal((await winning).revisions, 1);
    assert.equal(bigquery.tables.get('reporting.revisions').length, 1);
    assert.equal(bigquery.tables.get('reporting.revision_rows').length, 1);
  });

  test('a cold-start expiry pin refuses a recovery cursor from another feed scope', async t => {
    const { pool, store } = await isolatedWarehouseStore(t, 'expiry_scope');
    const cursor = ledger.encodeReportingChangeCursorV1({ v: 1, account: 'acct_elsewhere', seq: '0' });
    const expired = new ledger.ReportingChangeCursorExpiredError(cursor);
    const bigquery = fakeBigQuery();
    const sink = newSink(bigquery, {
      name: 'expiry_scope',
      account_id: 'acct_expiry_scope',
      db: pool,
      store: wrapStore(store, {
        async changesAfter() {
          throw expired;
        },
      }),
    });
    await assert.rejects(sink.runOnce(), error => error === expired);
    const state = (await pool.query('SELECT * FROM adcp_reporting_warehouse_sinks')).rows[0];
    assert.equal(state.committed_cursor, null);
    assert.equal(state.planned_to_cursor, null);
    assert.equal(bigquery.jobs.size, 0);
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
