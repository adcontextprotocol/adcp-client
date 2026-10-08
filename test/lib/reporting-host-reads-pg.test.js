/**
 * PostgreSQL integration tests for host reads: current revisions and the
 * gap-free change feed.
 *
 * REPORTING_LEDGER_PG_URL=postgres://localhost/test node --test test/lib/reporting-host-reads-pg.test.js
 */
const assert = require('node:assert/strict');
const { after, before, describe, test } = require('node:test');

const { createRowStorageFixture } = require('../helpers/reporting-row-storage-fixture.js');

const DATABASE_URL = process.env.REPORTING_LEDGER_PG_URL;

describe('reporting host reads', { skip: !DATABASE_URL && 'PostgreSQL URL not set' }, () => {
  const schema = `adcp_reporting_host_reads_${process.pid}`;
  let bootstrapPool;
  let pool;
  let ledger;
  let store;
  let first;
  let second;
  const rows = [{ ordinal: 0, value: 1 }];

  before(async () => {
    const { Pool } = require('pg');
    ledger = require('../../dist/lib/reporting/ledger/index.js');
    bootstrapPool = new Pool({ connectionString: DATABASE_URL });
    await bootstrapPool.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ connectionString: DATABASE_URL, options: `-c search_path="${schema}"` });
    await pool.query(ledger.REPORTING_LEDGER_MIGRATION);
    await pool.query(ledger.REPORTING_LEDGER_CHANGES_MIGRATION);
    await pool.query(ledger.REPORTING_LEDGER_CHANGES_MIGRATION);
    store = new ledger.PostgresReportingLedgerStore(pool, { acknowledgeIsolatedDatabase: true, changeFeed: true });
    first = await createRowStorageFixture({ store, suffix: 'host_a' });
    await store.commitRevision(first.revision('rrev_host_a1', 1, rows), first.lease);
    await store.commitRevision(
      first.revision('rrev_host_a2', 2, rows, { supersedes_reporting_revision_id: 'rrev_host_a1' }),
      first.lease
    );
    second = await createRowStorageFixture({ store, suffix: 'host_b' });
    await store.commitRevision(second.revision('rrev_host_b1', 1, rows), second.lease);
  });

  after(async () => {
    if (pool) await pool.end();
    if (bootstrapPool) {
      await bootstrapPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await bootstrapPool.end();
    }
  });

  test('reads the current revision and pages current revisions by period', async () => {
    const accountId = first.request.account.account_id;
    const current = await store.getCurrentRevision({
      account_id: accountId,
      reporting_obligation_id: first.obligation.reporting_obligation_id,
    });
    assert.equal(current.reporting_revision_id, 'rrev_host_a2');
    assert.equal('rows' in current, false);
    assert.equal(
      await store.getCurrentRevision({
        account_id: 'acct_other',
        reporting_obligation_id: first.obligation.reporting_obligation_id,
      }),
      null
    );

    const range = {
      account_id: accountId,
      period_start_from: new Date(Date.now() - 86_400_000).toISOString(),
      period_start_to: new Date(Date.now() + 86_400_000).toISOString(),
    };
    const page1 = await store.listCurrentRevisions({ ...range, limit: 1 });
    assert.equal(page1.revisions.length, 1);
    assert.ok(page1.cursor);
    const page2 = await store.listCurrentRevisions({ ...range, limit: 1, cursor: page1.cursor });
    assert.equal(page2.cursor, undefined);
    assert.deepEqual([...page1.revisions, ...page2.revisions].map(value => value.reporting_revision_id).sort(), [
      'rrev_host_a2',
      'rrev_host_b1',
    ]);
  });

  test('account feeds return committed changes in commit order and resume from a cursor', async () => {
    const accountId = first.request.account.account_id;
    const all = await store.changesAfter({ account_id: accountId });
    assert.deepEqual(
      all.records.map(record => [record.kind, record.record_id]),
      [
        ['obligation', 'robl_host_a'],
        ['revision', 'rrev_host_a1'],
        ['revision', 'rrev_host_a2'],
        ['obligation', 'robl_host_b'],
        ['revision', 'rrev_host_b1'],
      ]
    );
    const revisionsOnly = await store.changesAfter({ account_id: accountId, kinds: ['revision'], limit: 2 });
    assert.deepEqual(
      revisionsOnly.records.map(record => record.record_id),
      ['rrev_host_a1', 'rrev_host_a2']
    );
    const rest = await store.changesAfter({ account_id: accountId, kinds: ['revision'], cursor: revisionsOnly.cursor });
    assert.deepEqual(
      rest.records.map(record => record.record_id),
      ['rrev_host_b1']
    );
    const idle = await store.changesAfter({ account_id: accountId, kinds: ['revision'], cursor: rest.cursor });
    assert.deepEqual(idle.records, []);
    assert.equal(idle.cursor, rest.cursor);
    await assert.rejects(() => store.changesAfter({ cursor: rest.cursor }), /does not belong to this feed/);
  });

  test('the deployment-wide feed never skips a slower lower-sequence commit', async () => {
    const start = await store.changesAfter({ limit: 10_000 });
    const slow = await pool.connect();
    try {
      await slow.query('BEGIN');
      await slow.query(
        `INSERT INTO adcp_reporting_changes (account_id, record_kind, record_id, obligation_id)
         VALUES ('acct_slow', 'revision', 'rrev_slow', 'robl_slow')`
      );
      await pool.query(
        `INSERT INTO adcp_reporting_changes (account_id, record_kind, record_id, obligation_id)
         VALUES ('acct_fast', 'revision', 'rrev_fast', 'robl_fast')`
      );
      const whileSlowOpen = await store.changesAfter({ cursor: start.cursor });
      assert.deepEqual(whileSlowOpen.records, [], 'a later commit waits for the earlier transaction');
      await slow.query('COMMIT');
    } finally {
      slow.release();
    }
    const afterCommit = await store.changesAfter({ cursor: start.cursor });
    assert.deepEqual(
      afterCommit.records.map(record => record.record_id),
      ['rrev_slow', 'rrev_fast']
    );
  });

  test('pruning honours registered consumers and expires older cursors', async () => {
    const accountId = first.request.account.account_id;
    const firstPage = await store.changesAfter({ account_id: accountId, limit: 1 });
    await pool.query(`UPDATE adcp_reporting_changes SET recorded_at = recorded_at - INTERVAL '40 days'`);
    await store.saveFeedConsumerCursor('warehouse-sink', firstPage.cursor);
    const held = await store.pruneChanges({ changeRetentionDays: 30 });
    assert.equal(held.deleted, 1, 'only changes the registered consumer has passed are pruned');
    assert.equal(
      (await store.changesAfter({ account_id: accountId, cursor: firstPage.cursor })).records.length,
      4,
      'the held cursor still resumes'
    );

    await pool.query(`UPDATE adcp_reporting_feed_consumers SET updated_at = updated_at - INTERVAL '30 days'`);
    const released = await store.pruneChanges({ changeRetentionDays: 30 });
    assert.ok(released.deleted > 0, 'a stale consumer cannot hold retention forever');
    await assert.rejects(
      () => store.changesAfter({ account_id: accountId, cursor: firstPage.cursor }),
      ledger.ReportingChangeCursorExpiredError
    );
    const fresh = await store.changesAfter({ account_id: accountId });
    assert.ok(Array.isArray(fresh.records), 'a consumer without a cursor starts from the oldest retained change');
  });
});
