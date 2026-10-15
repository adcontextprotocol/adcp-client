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

  test('consumer checkpoints advance in their own feed order and equal positions refresh liveness', async () => {
    const name = 'ordered-checkpoint';
    const checkpoint = (account, seq, xid = '100') => ledger.encodeReportingChangeCursorV1({ v: 1, account, seq, xid });
    const read = async () =>
      (await pool.query('SELECT * FROM adcp_reporting_feed_consumers WHERE consumer_name = $1', [name])).rows[0];
    await store.saveFeedConsumerCursor(name, checkpoint('acct_checkpoint', '20'), { refreshUnchanged: false });
    await store.saveFeedConsumerCursor(name, checkpoint('acct_checkpoint', '10'));
    assert.equal((await read()).cursor_seq, '20');
    await pool.query(
      "UPDATE adcp_reporting_feed_consumers SET updated_at = clock_timestamp() - INTERVAL '1 day' WHERE consumer_name = $1",
      [name]
    );
    const old = (await read()).updated_at;
    await store.saveFeedConsumerCursor(name, checkpoint('acct_checkpoint', '20'), { refreshUnchanged: false });
    assert.equal((await read()).updated_at.getTime(), old.getTime());
    await store.saveFeedConsumerCursor(name, checkpoint('acct_checkpoint', '20'));
    assert.ok((await read()).updated_at > old);
    await store.saveFeedConsumerCursor(name, checkpoint('acct_checkpoint', '21'), { refreshUnchanged: false });
    assert.equal((await read()).cursor_seq, '21');
    // Reassigning a name to another feed preserves the existing API behavior.
    await store.saveFeedConsumerCursor(name, checkpoint(null, '200', '100'));
    await store.saveFeedConsumerCursor(name, checkpoint(null, '1', '101'));
    await store.saveFeedConsumerCursor(name, checkpoint(null, '300', '100'));
    assert.equal((await read()).cursor_xid, '101');
    assert.equal((await read()).cursor_seq, '1');
    await store.saveFeedConsumerCursor(name, checkpoint(null, '2', '101'));
    await store.saveFeedConsumerCursor(name, checkpoint(null, '1', '101'));
    assert.equal((await read()).cursor_seq, '2');
    const unchanged = await read();
    await store.saveFeedConsumerCursor(name, checkpoint(null, '2', '101'), { refreshUnchanged: false });
    assert.deepEqual(await read(), unchanged);
    await store.saveFeedConsumerCursor(name, checkpoint(null, '0', '102'), { refreshUnchanged: false });
    assert.equal((await read()).cursor_xid, '102');
    assert.equal((await read()).cursor_seq, '0');
    await store.saveFeedConsumerCursor(name, checkpoint('acct_other_checkpoint', '1'));
    assert.equal((await read()).account_id, 'acct_other_checkpoint');
    assert.equal((await read()).cursor_seq, '1');
  });

  test('saveFeedConsumerCursor reports whether it applied, and rewinds only on request', async () => {
    const name = 'rewind-checkpoint';
    const read = async () =>
      (await pool.query('SELECT * FROM adcp_reporting_feed_consumers WHERE consumer_name = $1', [name])).rows[0];
    const account = seq => ledger.encodeReportingChangeCursorV1({ v: 1, account: 'acct_rewind', seq, xid: '100' });
    const deployment = (xid, seq) => ledger.encodeReportingChangeCursorV1({ v: 1, account: null, seq, xid });

    assert.equal(await store.saveFeedConsumerCursor(name, account('20')), true, 'first save registers the consumer');
    assert.equal(await store.saveFeedConsumerCursor(name, account('30')), true, 'forward moves apply');
    assert.equal(await store.saveFeedConsumerCursor(name, account('10')), false, 'a backward write is ignored');
    assert.equal((await read()).cursor_seq, '30');
    assert.equal(await store.saveFeedConsumerCursor(name, account('30')), true, 'an equal write renews the hold');
    assert.equal(
      await store.saveFeedConsumerCursor(name, account('30'), { refreshUnchanged: false }),
      false,
      'an equal write that must not renew the hold is not applied'
    );
    assert.equal(await store.saveFeedConsumerCursor(name, account('10'), { rewind: false }), false);

    // An explicit rewind moves the saved position and the retention hold back.
    await pool.query(
      "UPDATE adcp_reporting_feed_consumers SET updated_at = clock_timestamp() - INTERVAL '1 day' WHERE consumer_name = $1",
      [name]
    );
    const stale = (await read()).updated_at;
    assert.equal(await store.saveFeedConsumerCursor(name, account('10'), { rewind: true }), true);
    assert.equal((await read()).cursor_seq, '10');
    assert.ok((await read()).updated_at > stale, 'a rewind renews the retention hold');

    // Moving to another account replaces the position even at a lower sequence.
    const otherAccount = ledger.encodeReportingChangeCursorV1({ v: 1, account: 'acct_rewind_b', seq: '1', xid: '100' });
    assert.equal(await store.saveFeedConsumerCursor(name, otherAccount), true);
    assert.equal((await read()).account_id, 'acct_rewind_b');
    assert.equal((await read()).cursor_seq, '1');
    assert.equal(await store.saveFeedConsumerCursor(name, account('10'), { rewind: true }), true);

    // The same holds for the deployment feed's (xid, seq) order.
    assert.equal(await store.saveFeedConsumerCursor(name, deployment('200', '5')), true, 'a scope switch replaces');
    assert.equal(await store.saveFeedConsumerCursor(name, deployment('199', '9')), false);
    assert.equal(await store.saveFeedConsumerCursor(name, deployment('200', '4')), false);
    assert.equal(await store.saveFeedConsumerCursor(name, deployment('199', '9'), { rewind: true }), true);
    assert.equal((await read()).cursor_xid, '199');
    assert.equal((await read()).cursor_seq, '9');

    assert.equal(await store.removeFeedConsumer(name), true);
    assert.equal(await read(), undefined);
    assert.equal(await store.removeFeedConsumer(name), false, 'removing an unknown consumer reports false');
    assert.equal(await store.saveFeedConsumerCursor(name, account('1')), true, 'a removed consumer can register again');
    await store.removeFeedConsumer(name);
  });

  for (const { scope, axis } of [
    { scope: 'account', axis: 'sequence' },
    { scope: 'account', axis: 'transaction' },
    { scope: 'deployment', axis: 'sequence' },
    { scope: 'deployment', axis: 'transaction' },
  ]) {
    test(`${scope} feed pages use numeric ${axis} order across decimal digit boundaries`, async t => {
      const { Pool } = require('pg');
      const suffix = `${scope}_${axis}`;
      const isolatedSchema = `${schema}_numeric_${suffix}`;
      await bootstrapPool.query(`CREATE SCHEMA "${isolatedSchema}"`);
      const isolatedPool = new Pool({ connectionString: DATABASE_URL, options: `-c search_path="${isolatedSchema}"` });
      t.after(async () => {
        await isolatedPool.end();
        await bootstrapPool.query(`DROP SCHEMA IF EXISTS "${isolatedSchema}" CASCADE`);
      });
      await isolatedPool.query(ledger.REPORTING_LEDGER_MIGRATION);
      await isolatedPool.query(ledger.REPORTING_LEDGER_CHANGES_MIGRATION);
      const isolatedStore = new ledger.PostgresReportingLedgerStore(isolatedPool, {
        acknowledgeIsolatedDatabase: true,
        changeFeed: true,
      });
      if (axis === 'sequence') await isolatedPool.query("SELECT setval('adcp_reporting_changes_seq_seq', 8)");
      const account = `acct_numeric_${suffix}`;
      const first = await createRowStorageFixture({
        store: isolatedStore,
        suffix: `first_${suffix}`,
        accountId: account,
      });
      const second = await createRowStorageFixture({
        store: isolatedStore,
        suffix: `second_${suffix}`,
        accountId: account,
      });
      // Historical XIDs keep these changes visible despite concurrent suites' older
      // transactions. Both feeds order by (xid, seq): the sequence case shares one XID so
      // `seq` decides, and the transaction case crosses a decimal digit boundary in `xid`.
      await isolatedPool.query(
        `UPDATE adcp_reporting_changes SET xid = CASE WHEN record_id = $1 THEN '9'::xid8 ELSE $2::text::xid8 END`,
        [first.obligation.reporting_obligation_id, axis === 'sequence' ? '9' : '10']
      );
      const position = scope === 'account' ? { account_id: account } : {};
      const firstPage = await isolatedStore.changesAfter({ ...position, limit: 1 });
      assert.deepEqual(
        firstPage.records.map(record => record.record_id),
        [first.obligation.reporting_obligation_id]
      );
      const secondPage = await isolatedStore.changesAfter({ ...position, cursor: firstPage.cursor, limit: 1 });
      assert.deepEqual(
        secondPage.records.map(record => record.record_id),
        [second.obligation.reporting_obligation_id]
      );
      assert.deepEqual(
        (await isolatedStore.changesAfter({ ...position, cursor: secondPage.cursor, limit: 1 })).records,
        []
      );
    });
  }

  for (const scope of ['account', 'deployment']) {
    for (const coldStart of [false, true]) {
      test(`${scope === 'account' ? 'an' : 'a'} ${scope} feed rejects a prune between its horizon and page reads (${coldStart ? 'initial horizon' : 'saved cursor'})`, async () => {
        const { Pool } = require('pg');
        const suffix = `${scope}_${coldStart ? 'cold' : 'warm'}`;
        const isolatedSchema = `${schema}_${suffix}`;
        await bootstrapPool.query(`CREATE SCHEMA "${isolatedSchema}"`);
        const isolatedPool = new Pool({
          connectionString: DATABASE_URL,
          options: `-c search_path="${isolatedSchema}"`,
        });
        try {
          await isolatedPool.query(ledger.REPORTING_LEDGER_MIGRATION);
          await isolatedPool.query(ledger.REPORTING_LEDGER_CHANGES_MIGRATION);
          const realStore = new ledger.PostgresReportingLedgerStore(isolatedPool, {
            acknowledgeIsolatedDatabase: true,
            changeFeed: true,
          });
          const account = `acct_horizon_${suffix}`;
          const position = scope === 'account' ? { account_id: account } : {};
          const savedCursor = (await realStore.changesAfter(position)).cursor;
          const old = await createRowStorageFixture({ store: realStore, suffix: `old_${suffix}`, accountId: account });
          const revisionId = `rrev_horizon_${suffix}`;
          await realStore.commitRevision(old.revision(revisionId, 1, rows), old.lease);
          await isolatedPool.query(
            "UPDATE adcp_reporting_changes SET recorded_at = clock_timestamp() - INTERVAL '40 days' WHERE obligation_id = $1",
            [old.obligation.reporting_obligation_id]
          );
          const fresh = await createRowStorageFixture({
            store: realStore,
            suffix: `fresh_${suffix}`,
            accountId: account,
          });
          let intercepted = false;
          let deleted;
          const observedStore = new ledger.PostgresReportingLedgerStore(
            {
              connect: isolatedPool.connect.bind(isolatedPool),
              async query(sql, values) {
                const result = await isolatedPool.query(sql, values);
                if (!intercepted && sql.includes('SELECT pruned_through')) {
                  intercepted = true;
                  deleted = (await realStore.pruneChanges({ changeRetentionDays: 30 })).deleted;
                }
                return result;
              },
            },
            { acknowledgeIsolatedDatabase: true, changeFeed: true }
          );
          let expired;
          await assert.rejects(
            observedStore.changesAfter({ ...position, ...(coldStart ? {} : { cursor: savedCursor }) }),
            error => {
              assert.ok(error instanceof ledger.ReportingChangeCursorExpiredError);
              expired = error;
              return true;
            }
          );
          assert.equal(ledger.decodeReportingChangeCursorV1(expired.cursor, position.account_id ?? null).seq, '0');
          assert.ok(intercepted, 'retention ran after the initial horizon result and before the page query');
          assert.equal(deleted, 2, 'retention removed the old obligation and revision changes');
          assert.ok(
            await realStore.getRevisionMetadata(revisionId, account),
            'the missed revision is still recoverable'
          );
          // Other suites share the cluster; an unrelated open transaction can briefly hold the page back.
          let survivors = [];
          for (let attempt = 0; attempt < 100 && survivors.length === 0; attempt += 1) {
            survivors = (await realStore.changesAfter({ account_id: account })).records.map(record => record.record_id);
            if (survivors.length === 0) await new Promise(resolve => setTimeout(resolve, 100));
          }
          assert.deepEqual(
            survivors,
            [fresh.obligation.reporting_obligation_id],
            'a fresh read starts after the new horizon and sees the surviving change'
          );
        } finally {
          await isolatedPool.end();
          await bootstrapPool.query(`DROP SCHEMA IF EXISTS "${isolatedSchema}" CASCADE`);
        }
      });
    }
  }

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

  // The deployment-wide feed stops below the oldest transaction still open in
  // the whole database, which suites running concurrently may hold briefly. It
  // delays records and never loses them, so these reads poll until the records
  // under test appear, and assertions look only at those records.
  async function readDeployment(cursor, done, { limit } = {}) {
    const records = [];
    let next = cursor;
    const deadline = Date.now() + 30_000;
    for (;;) {
      const page = await store.changesAfter({ ...(next ? { cursor: next } : {}), ...(limit ? { limit } : {}) });
      records.push(...page.records);
      next = page.cursor;
      if (done(records)) return { records, cursor: next };
      if (page.records.length === 0) {
        if (Date.now() > deadline) throw new Error('deployment feed did not deliver the expected records');
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
  }
  const ids = (records, wanted) => records.map(record => record.record_id).filter(id => wanted.includes(id));

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
      const whileSlowOpen = await store.changesAfter({ cursor: start.cursor, limit: 10_000 });
      assert.deepEqual(
        ids(whileSlowOpen.records, ['rrev_slow', 'rrev_fast']),
        [],
        'a later commit waits for the earlier transaction'
      );
      await slow.query('COMMIT');
    } finally {
      slow.release();
    }
    const afterCommit = await readDeployment(start.cursor, records =>
      ['rrev_slow', 'rrev_fast'].every(id => records.some(record => record.record_id === id))
    );
    assert.deepEqual(ids(afterCommit.records, ['rrev_slow', 'rrev_fast']), ['rrev_slow', 'rrev_fast']);
  });

  test('pruning honours registered consumers and expires older cursors', async () => {
    const accountId = first.request.account.account_id;
    const firstPage = await store.changesAfter({ account_id: accountId, limit: 1 });
    await pool.query(`UPDATE adcp_reporting_changes SET recorded_at = recorded_at - INTERVAL '40 days'`);
    await store.saveFeedConsumerCursor('warehouse-sink', firstPage.cursor);
    await store.pruneChanges({ changeRetentionDays: 30 });
    const remaining = await pool.query(
      `SELECT account_id, count(*)::int AS n FROM adcp_reporting_changes GROUP BY account_id`
    );
    assert.deepEqual(
      remaining.rows,
      [{ account_id: accountId, n: 4 }],
      'an account consumer holds only the unread changes of its own account'
    );
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

  test('a deployment consumer holds an unread change whose seq precedes its cursor', async () => {
    await pool.query('DELETE FROM adcp_reporting_feed_consumers');
    const start = await store.changesAfter({ limit: 10_000 });
    // Change A gets the older transaction but the later sequence value; B the
    // reverse. The deployment feed returns A before B.
    const older = await pool.connect();
    try {
      await older.query('BEGIN');
      await older.query('SELECT pg_current_xact_id()');
      await pool.query(
        `INSERT INTO adcp_reporting_changes (account_id, record_kind, record_id, obligation_id)
         VALUES ('acct_b', 'revision', 'rrev_b', 'robl_b')`
      );
      await older.query(
        `INSERT INTO adcp_reporting_changes (account_id, record_kind, record_id, obligation_id)
         VALUES ('acct_a', 'revision', 'rrev_a', 'robl_a')`
      );
      await older.query('COMMIT');
    } finally {
      older.release();
    }
    const firstRead = await readDeployment(
      start.cursor,
      records => records.some(record => record.record_id === 'rrev_a'),
      { limit: 1 }
    );
    assert.deepEqual(ids(firstRead.records, ['rrev_a', 'rrev_b']), ['rrev_a'], 'A is delivered before B');
    await store.saveFeedConsumerCursor('deployment-sink', firstRead.cursor);
    await pool.query(`UPDATE adcp_reporting_changes SET recorded_at = recorded_at - INTERVAL '40 days'`);
    await store.pruneChanges({ changeRetentionDays: 30 });
    const resumed = await readDeployment(firstRead.cursor, records =>
      records.some(record => record.record_id === 'rrev_b')
    );
    assert.deepEqual(
      ids(resumed.records, ['rrev_a', 'rrev_b']),
      ['rrev_b'],
      'the unread lower-sequence change survives pruning'
    );

    await store.saveFeedConsumerCursor('deployment-sink', resumed.cursor);
    await store.pruneChanges({ changeRetentionDays: 30 });
    await assert.rejects(
      () => store.changesAfter({ cursor: start.cursor }),
      ledger.ReportingChangeCursorExpiredError,
      'a deployment cursor that missed a pruned change fails closed'
    );
    assert.deepEqual(ids((await store.changesAfter({ cursor: resumed.cursor })).records, ['rrev_a', 'rrev_b']), []);
  });
});

// A bare `ORDER BY seq` in the page query once bound to the `seq::text AS seq`
// output column and sorted pages as text, so a page that crossed a power of ten
// returned 100-104 before 95-99 and the cursor then skipped 95-99 for good.
// This suite forces both the sequence and the transaction id across that
// boundary and pages with a small limit.
describe(
  'reporting change feed ordering across decimal boundaries',
  { skip: !DATABASE_URL && 'PostgreSQL URL not set' },
  () => {
    const schema = `adcp_reporting_feed_numeric_${process.pid}`;
    let bootstrapPool;
    let pool;
    let store;
    const expected = Array.from({ length: 10 }, (_, index) => 95 + index);

    before(async () => {
      const { Pool } = require('pg');
      const ledger = require('../../dist/lib/reporting/ledger/index.js');
      bootstrapPool = new Pool({ connectionString: DATABASE_URL });
      await bootstrapPool.query(`CREATE SCHEMA "${schema}"`);
      pool = new Pool({ connectionString: DATABASE_URL, options: `-c search_path="${schema}"` });
      await pool.query(ledger.REPORTING_LEDGER_MIGRATION);
      await pool.query(ledger.REPORTING_LEDGER_CHANGES_MIGRATION);
      store = new ledger.PostgresReportingLedgerStore(pool, { acknowledgeIsolatedDatabase: true, changeFeed: true });
      // Next seq is 95; the rows span 95..104, crossing 99 -> 100. Explicit low
      // xids (also 95..104) are far below the cluster's oldest running
      // transaction, so the deployment feed releases them immediately.
      await pool.query(`SELECT setval(pg_get_serial_sequence('adcp_reporting_changes', 'seq'), 94)`);
      for (const n of expected) {
        await pool.query(
          `INSERT INTO adcp_reporting_changes (xid, account_id, record_kind, record_id, obligation_id)
         VALUES ($1::text::xid8, 'acct_numeric', 'revision', $2, 'robl_numeric')`,
          [String(n), `rrev_numeric_${n}`]
        );
      }
    });

    after(async () => {
      if (pool) await pool.end();
      if (bootstrapPool) {
        await bootstrapPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await bootstrapPool.end();
      }
    });

    async function pageAll(input) {
      const seen = [];
      let cursor;
      for (let guard = 0; guard < 20; guard += 1) {
        const page = await store.changesAfter({ ...input, ...(cursor ? { cursor } : {}), limit: 3 });
        seen.push(...page.records.map(record => record.record_id));
        cursor = page.cursor;
        if (page.records.length === 0) return seen;
      }
      throw new Error('change feed did not drain');
    }

    test('the account feed returns every change once in numeric order across 99 -> 100', async () => {
      assert.deepEqual(
        await pageAll({ account_id: 'acct_numeric' }),
        expected.map(n => `rrev_numeric_${n}`)
      );
    });

    test('the deployment feed returns every change once in numeric order across 99 -> 100', async () => {
      assert.deepEqual(
        await pageAll({}),
        expected.map(n => `rrev_numeric_${n}`)
      );
    });
  }
);
