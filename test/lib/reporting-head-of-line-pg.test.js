/**
 * PostgreSQL integration tests: retention, upload sweeps and the account change
 * feed must not let one stuck item hold back the rest.
 *
 * REPORTING_LEDGER_PG_URL=postgres://localhost/test node --test test/lib/reporting-head-of-line-pg.test.js
 */
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { after, afterEach, before, beforeEach, describe, test } = require('node:test');

const { createRowStorageFixture } = require('../helpers/reporting-row-storage-fixture.js');

const DATABASE_URL = process.env.REPORTING_LEDGER_PG_URL;
const skip = !DATABASE_URL && 'PostgreSQL URL not set';

describe('reporting retention and sweep head-of-line blocking', { skip }, () => {
  const schema = `adcp_reporting_hol_${process.pid}`;
  let bootstrapPool;
  let pool;
  let ledger;
  let root;
  let store;
  let namespaceKey;
  const failingKeys = new Set();
  let onFailingDelete;
  const rows = Array.from({ length: 5 }, (_, index) => ({ ordinal: index, value: index }));

  async function expire(obligationId, days) {
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

  /**
   * A period with one revision; with `failing` its external object cannot be deleted. Create every
   * period before expiring any: an expired lease would let the next fixture claim the earlier one.
   */
  async function createPeriod(suffix, { failing = false } = {}) {
    const fixture = await createRowStorageFixture({ store, suffix });
    await store.commitRevision(fixture.revision(`rrev_${suffix}_1`, 1, rows), fixture.lease);
    const obligationId = fixture.obligation.reporting_obligation_id;
    if (failing) {
      const keys = await pool.query(
        `SELECT object_ref FROM adcp_reporting_row_chunks WHERE obligation_id = $1 AND object_ref IS NOT NULL`,
        [obligationId]
      );
      for (const row of keys.rows) failingKeys.add(row.object_ref);
    }
    return obligationId;
  }

  const periodExists = async obligationId =>
    (await pool.query(`SELECT 1 FROM adcp_reporting_obligations WHERE obligation_id = $1`, [obligationId])).rows
      .length === 1;
  const tombstone = async obligationId =>
    (await pool.query(`SELECT * FROM adcp_reporting_obligation_tombstones WHERE obligation_id = $1`, [obligationId]))
      .rows[0];
  const backoffSeconds = async obligationId =>
    Number(
      (
        await pool.query(
          `SELECT EXTRACT(EPOCH FROM next_attempt_at - clock_timestamp()) AS s
             FROM adcp_reporting_obligation_tombstones WHERE obligation_id = $1`,
          [obligationId]
        )
      ).rows[0].s
    );
  const clearBackoff = () => pool.query(`UPDATE adcp_reporting_obligation_tombstones SET next_attempt_at = NULL`);

  before(async () => {
    const { Pool } = require('pg');
    ledger = require('../../dist/lib/reporting/ledger/index.js');
    root = mkdtempSync(path.join(tmpdir(), 'adcp-hol-'));
    bootstrapPool = new Pool({ connectionString: DATABASE_URL });
    await bootstrapPool.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ connectionString: DATABASE_URL, options: `-c search_path="${schema}"` });
    await pool.query(ledger.REPORTING_LEDGER_MIGRATION);
    await pool.query(ledger.REPORTING_ROW_STORAGE_MIGRATION);
    const filesystem = ledger.createFilesystemReportingRowObjectProviderV1({ roots: { rows: root } });
    // Deletes of the keys in `failingKeys` fail, as a permanent provider error would.
    const provider = new Proxy(filesystem, {
      get(target, property) {
        if (property === 'delete') {
          return async (location, context) => {
            if (failingKeys.has(location.objectRef)) {
              onFailingDelete?.();
              throw new Error('provider unavailable');
            }
            return target.delete(location, context);
          };
        }
        const value = target[property];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const binding = { kind: 'object', provider: 'filesystem', location: { root: 'rows' }, prefix: 'retained' };
    const rowStorage = { bindings: { objects: binding }, providers: { filesystem: provider } };
    store = new ledger.PostgresReportingLedgerStore(pool, { acknowledgeIsolatedDatabase: true, rowStorage });
    await store.readyRowStorage();
    // Another host configured a binding this one does not.
    const other = new ledger.PostgresReportingLedgerStore(pool, {
      acknowledgeIsolatedDatabase: true,
      rowStorage: {
        bindings: { objects: binding, ghost: { ...binding, prefix: 'ghost' } },
        providers: { filesystem: provider },
      },
    });
    await other.readyRowStorage();
    const engine = new ledger.ReportingRowStorageV1(pool, rowStorage);
    await engine.ready();
    namespaceKey = engine.installationIdentity.namespaceKey;
  });

  beforeEach(async () => {
    failingKeys.clear();
    onFailingDelete = undefined;
    await pool.query('DELETE FROM adcp_reporting_row_write_intents');
  });

  after(async () => {
    if (pool) await pool.end();
    if (bootstrapPool) {
      await bootstrapPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await bootstrapPool.end();
    }
    if (root) rmSync(root, { recursive: true, force: true });
  });

  describe('retirement', () => {
    // Leave no expired period behind: the next fixture would claim its lapsed lease.
    afterEach(async () => {
      failingKeys.clear();
      await clearBackoff();
      await store.retireExpiredPeriods({ statusRetentionDays: 30, limit: 1000 });
    });

    test('with limit=1 a permanently failing period does not block an eligible one', async () => {
      const stuck = await createPeriod('retire_stuck', { failing: true });
      const healthy = await createPeriod('retire_ok');
      await expire(stuck, 50);
      await expire(healthy, 40);

      // The oldest period is tried first and fails.
      const first = await store.retireExpiredPeriods({ statusRetentionDays: 30, limit: 1 });
      assert.deepEqual(first.failed, [stuck]);
      assert.equal(first.retired, 0);
      assert.equal(first.failures[0].cause, 'PROVIDER_UNAVAILABLE');
      assert.equal(await periodExists(healthy), true);
      const afterFailure = await tombstone(stuck);
      assert.equal(afterFailure.state, 'retiring');
      assert.equal(afterFailure.attempts, 1);
      assert.equal(afterFailure.last_failure, 'PROVIDER_UNAVAILABLE');
      const wait = await backoffSeconds(stuck);
      assert.ok(wait > 30 && wait <= 60, `first backoff is about a minute, got ${wait}s`);

      // It backs off, so the next pass reaches the eligible period.
      const second = await store.retireExpiredPeriods({ statusRetentionDays: 30, limit: 1 });
      assert.equal(second.retired, 1);
      assert.deepEqual(second.failed, []);
      assert.equal(second.deferred, 1);
      assert.equal(await periodExists(healthy), false);
      assert.equal(await periodExists(stuck), true);

      // Nothing else is left, and the stuck period is not retried before its backoff elapses.
      const third = await store.retireExpiredPeriods({ statusRetentionDays: 30, limit: 1 });
      assert.deepEqual(third, { retired: 0, failed: [], failures: [], deferred: 1, stuck: [] });

      // Once the provider recovers and the backoff elapses, it retires.
      failingKeys.clear();
      await clearBackoff();
      assert.equal((await store.retireExpiredPeriods({ statusRetentionDays: 30, limit: 1 })).retired, 1);
      assert.equal((await tombstone(stuck)).state, 'retired');
    });

    test('backoff doubles per failure up to six hours, and a persistent failure is reported', async () => {
      const stuck = await createPeriod('retire_backoff', { failing: true });
      await expire(stuck, 40);
      let result;
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        result = await store.retireExpiredPeriods({ statusRetentionDays: 30 });
        assert.deepEqual(result.failed, [stuck]);
        const seconds = await backoffSeconds(stuck);
        const expected = 60 * 2 ** (attempt - 1);
        assert.ok(
          seconds > expected - 30 && seconds <= expected,
          `attempt ${attempt} waits ${expected}s, got ${seconds}`
        );
        // Four failures are not yet persistent.
        assert.equal(result.stuck.length, attempt >= 5 ? 1 : 0);
        await clearBackoff();
      }
      assert.deepEqual(result.stuck, [{ reporting_obligation_id: stuck, attempts: 5, cause: 'PROVIDER_UNAVAILABLE' }]);

      // The cap.
      await pool.query(`UPDATE adcp_reporting_obligation_tombstones SET attempts = 40 WHERE obligation_id = $1`, [
        stuck,
      ]);
      await store.retireExpiredPeriods({ statusRetentionDays: 30 });
      assert.equal((await tombstone(stuck)).attempts, 41);
      const capped = await backoffSeconds(stuck);
      assert.ok(capped > 6 * 3600 - 30 && capped <= 6 * 3600, `capped at six hours, got ${capped}s`);
    });

    test('an abort during a delete is shutdown, not a failure: no attempt is recorded', async () => {
      const stuck = await createPeriod('retire_abort', { failing: true });
      await expire(stuck, 40);
      const abort = new AbortController();
      onFailingDelete = () => abort.abort();
      const result = await store.retireExpiredPeriods({ statusRetentionDays: 30, signal: abort.signal });
      assert.deepEqual(result.failed, [stuck]);
      const row = await tombstone(stuck);
      assert.equal(row.attempts, 0);
      assert.equal(row.next_attempt_at, null);
    });

    test('with only retries ready, the cap does not slow the drain', async () => {
      const periods = [
        await createPeriod('retire_drain_a', { failing: true }),
        await createPeriod('retire_drain_b', { failing: true }),
        await createPeriod('retire_drain_c', { failing: true }),
      ];
      await Promise.all(periods.map((id, index) => expire(id, 60 - index)));
      const failed = await store.retireExpiredPeriods({ statusRetentionDays: 30, limit: 3 });
      assert.equal(failed.failed.length, 3);
      failingKeys.clear();
      await clearBackoff();
      // Three retries are ready and nothing else is eligible: both slots go to retries.
      const pass = await store.retireExpiredPeriods({ statusRetentionDays: 30, limit: 2 });
      assert.equal(pass.retired, 2);
      assert.deepEqual(pass.failed, []);
    });

    test('fresh periods keep a share of the pass when failing periods are ready to retry', async () => {
      const first = await createPeriod('retire_share_a', { failing: true });
      const second = await createPeriod('retire_share_b', { failing: true });
      const fresh = await createPeriod('retire_share_fresh');
      await expire(first, 60);
      await expire(second, 55);
      const failed = await store.retireExpiredPeriods({ statusRetentionDays: 30, limit: 2 });
      assert.deepEqual([...failed.failed].sort(), [first, second].sort());
      await clearBackoff();
      await expire(fresh, 40);

      // Two failing resumes are ready, but they may take only half the pass.
      const pass = await store.retireExpiredPeriods({ statusRetentionDays: 30, limit: 2 });
      assert.deepEqual(pass.failed, [first], 'one resume: the oldest period with the fewest attempts');
      assert.equal(pass.retired, 1);
      assert.equal(await periodExists(fresh), false, 'the fresh period was retired in the same pass');
    });
  });

  describe('upload sweep', () => {
    const accountId = 'acct_hol_sweep';
    const objectKey = name => `retained/${namespaceKey}/hol/${name}.jsonl`;
    const addIntent = (
      rowSetId,
      { binding = 'objects', objects = [], expires = `INTERVAL '1 hour'`, state = 'open' } = {}
    ) =>
      pool.query(
        `INSERT INTO adcp_reporting_row_write_intents
           (row_binding_id, account_id, row_set_id, content_sha256, state, owner_token, created_objects, expires_at)
         VALUES ($1, $2, $3, $4, $5, 'owner', $6::jsonb, clock_timestamp() - ${expires})`,
        [
          binding,
          accountId,
          rowSetId,
          'd'.repeat(64),
          state,
          JSON.stringify(objects.map(name => ({ object_ref: objectKey(name), native_version_ref: 'v1' }))),
        ]
      );
    const intentRow = async rowSetId =>
      (await pool.query(`SELECT * FROM adcp_reporting_row_write_intents WHERE row_set_id = $1`, [rowSetId])).rows[0];
    const counts = overrides => ({
      swept: 0,
      objectsDeleted: 0,
      failed: 0,
      skippedUnconfigured: 0,
      deferred: 0,
      overdue: 0,
      ...overrides,
    });

    test('with limit=1 a permanently failing intent does not block an eligible one', async () => {
      failingKeys.add(objectKey('failing'));
      await addIntent('rrev_failing', { objects: ['failing'], expires: `INTERVAL '3 hours'` });
      await addIntent('rrev_healthy', { objects: ['healthy'], expires: `INTERVAL '1 hour'` });

      const first = await store.sweepRowWriteIntents({ limit: 1 });
      // The oldest intent is tried first and fails.
      assert.deepEqual(first, counts({ failed: 1, deferred: 1 }));
      const failing = await intentRow('rrev_failing');
      assert.equal(failing.sweep_attempts, 1);
      assert.ok(new Date(failing.next_sweep_at) > new Date());

      // It backs off, so the healthy one is swept.
      const second = await store.sweepRowWriteIntents({ limit: 1 });
      assert.deepEqual(second, counts({ swept: 1, objectsDeleted: 1, deferred: 1 }));
      assert.equal(await intentRow('rrev_healthy'), undefined);

      // Not retried before its backoff elapses; once the provider recovers it is swept.
      assert.deepEqual(await store.sweepRowWriteIntents({ limit: 1 }), counts({ deferred: 1 }));
      failingKeys.clear();
      await pool.query('UPDATE adcp_reporting_row_write_intents SET next_sweep_at = NULL');
      assert.deepEqual(await store.sweepRowWriteIntents({ limit: 1 }), counts({ swept: 1, objectsDeleted: 1 }));
      assert.equal(await intentRow('rrev_failing'), undefined);
    });

    test('a retry never takes the slot of a fresh intent', async () => {
      failingKeys.add(objectKey('retry_first'));
      await addIntent('rrev_retry_first', { objects: ['retry_first'], expires: `INTERVAL '5 hours'` });
      await store.sweepRowWriteIntents({ limit: 1 });
      await pool.query('UPDATE adcp_reporting_row_write_intents SET next_sweep_at = NULL');
      await addIntent('rrev_fresh_after', { objects: ['fresh_after'], expires: `INTERVAL '1 hour'` });
      // The failed intent is ready again and older, but the fresh one goes first.
      const pass = await store.sweepRowWriteIntents({ limit: 1 });
      assert.equal(pass.swept, 1);
      assert.equal(await intentRow('rrev_fresh_after'), undefined);
      assert.ok(await intentRow('rrev_retry_first'));
    });

    test('skips and counts intents for a binding this host does not configure', async () => {
      await addIntent('rrev_ghost', { binding: 'ghost', objects: ['ghost_object'], expires: `INTERVAL '3 days'` });
      // Nothing to delete means no binding is needed.
      await addIntent('rrev_ghost_empty', { binding: 'ghost', expires: `INTERVAL '2 hours'` });
      await addIntent('rrev_local', { objects: ['local'], expires: `INTERVAL '1 hour'` });

      const result = await store.sweepRowWriteIntents({ limit: 10 });
      assert.deepEqual(result, counts({ swept: 2, objectsDeleted: 1, skippedUnconfigured: 1, overdue: 1 }));
      const skipped = await intentRow('rrev_ghost');
      assert.equal(skipped.state, 'open', 'left untouched for a host that configures the binding');
      assert.equal(skipped.sweep_attempts, 0);
      assert.equal(skipped.next_sweep_at, null);
    });

    test('an unconfigured binding at the head of the queue does not take the slot', async () => {
      await addIntent('rrev_ghost_head', { binding: 'ghost', objects: ['ghost_head'], expires: `INTERVAL '3 days'` });
      await addIntent('rrev_local_next', { objects: ['local_next'], expires: `INTERVAL '1 hour'` });
      const result = await store.sweepRowWriteIntents({ limit: 1 });
      assert.equal(result.swept, 1);
      assert.equal(result.skippedUnconfigured, 1);
      assert.equal(await intentRow('rrev_local_next'), undefined);
    });

    test('an abort during a delete is shutdown, not a failure: no attempt is recorded', async () => {
      failingKeys.add(objectKey('abort_me'));
      await addIntent('rrev_abort', { objects: ['abort_me'], expires: `INTERVAL '2 hours'` });
      const abort = new AbortController();
      onFailingDelete = () => abort.abort();
      const result = await store.sweepRowWriteIntents({ signal: abort.signal });
      assert.equal(result.failed, 1);
      const row = await intentRow('rrev_abort');
      assert.equal(row.sweep_attempts, 0);
      assert.equal(row.next_sweep_at, null);
    });

    test('a sweeping intent backs off like an open one', async () => {
      failingKeys.add(objectKey('sweeping'));
      await addIntent('rrev_sweeping', { objects: ['sweeping'], expires: `INTERVAL '2 hours'`, state: 'sweeping' });
      await addIntent('rrev_after_sweeping', { objects: ['after'], expires: `INTERVAL '1 hour'` });
      assert.equal((await store.sweepRowWriteIntents({ limit: 1 })).failed, 1);
      assert.equal((await store.sweepRowWriteIntents({ limit: 1 })).swept, 1);
      assert.equal(await intentRow('rrev_after_sweeping'), undefined);
    });

    test('overdue also counts a configured intent that keeps failing, alongside deferred', async () => {
      failingKeys.add(objectKey('provider_down'));
      await addIntent('rrev_provider_down', { objects: ['provider_down'], expires: `INTERVAL '2 days'` });
      assert.equal((await store.sweepRowWriteIntents()).failed, 1);
      // Backing off, still unswept after the threshold: counted as deferred and overdue, not as
      // skipped, because this host configures the binding and the provider is the fault.
      assert.deepEqual(await store.sweepRowWriteIntents(), counts({ deferred: 1, overdue: 1 }));
    });

    test('flags intents expired far longer than the sweep interval, and the threshold is adjustable', async () => {
      await addIntent('rrev_recent', { binding: 'ghost', objects: ['recent'], expires: `INTERVAL '2 hours'` });
      assert.equal((await store.sweepRowWriteIntents()).overdue, 0);
      assert.equal((await store.sweepRowWriteIntents({ overdueAfterSeconds: 3600 })).overdue, 1);
      await assert.rejects(() => store.sweepRowWriteIntents({ overdueAfterSeconds: 0 }), RangeError);
    });
  });
});

describe('account change feed ordering', { skip }, () => {
  const schema = `adcp_reporting_hol_feed_${process.pid}`;
  const account = 'acct_hol_feed';
  let bootstrapPool;
  let pool;
  let store;

  const insert = (client, recordId) =>
    client.query(
      `INSERT INTO adcp_reporting_changes (account_id, record_kind, record_id, obligation_id)
       VALUES ($1, 'revision', $2, 'robl_hol_feed')`,
      [account, recordId]
    );
  const ids = page => page.records.map(record => record.record_id);
  // Other test files share the cluster, and an unrelated older transaction can briefly hold a
  // page back, so positive reads poll. The assertions that a page is held back do not need it.
  async function until(read, expected) {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const page = await read();
      if (JSON.stringify(ids(page)) === JSON.stringify(expected) || Date.now() > deadline) return page;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }

  before(async () => {
    const { Pool } = require('pg');
    const ledger = require('../../dist/lib/reporting/ledger/index.js');
    bootstrapPool = new Pool({ connectionString: DATABASE_URL });
    await bootstrapPool.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ connectionString: DATABASE_URL, options: `-c search_path="${schema}"` });
    await pool.query(ledger.REPORTING_LEDGER_MIGRATION);
    await pool.query(ledger.REPORTING_LEDGER_CHANGES_MIGRATION);
    store = new ledger.PostgresReportingLedgerStore(pool, { acknowledgeIsolatedDatabase: true, changeFeed: true });
  });

  after(async () => {
    if (pool) await pool.end();
    if (bootstrapPool) {
      await bootstrapPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await bootstrapPool.end();
    }
  });

  test('a lower seq that commits after a higher one is never passed over', async () => {
    const start = await store.changesAfter({ account_id: account });
    const slow = await pool.connect();
    try {
      await slow.query('BEGIN');
      await insert(slow, 'rrev_low'); // takes the lower seq, commits last
      await insert(pool, 'rrev_high'); // higher seq, committed already
      const during = await store.changesAfter({ account_id: account, cursor: start.cursor });
      assert.deepEqual(ids(during), [], 'the page stops before the unfinished transaction');
      assert.equal(during.cursor, start.cursor, 'the cursor does not move past it');
      await slow.query('COMMIT');
    } finally {
      await slow.query('ROLLBACK').catch(() => undefined);
      slow.release();
    }
    const after = await until(
      () => store.changesAfter({ account_id: account, cursor: start.cursor }),
      ['rrev_low', 'rrev_high']
    );
    assert.deepEqual(ids(after), ['rrev_low', 'rrev_high']);
  });

  test('a held-back change is never skipped when a later change passes the transaction guard', async () => {
    const start = await store.changesAfter({ account_id: account });
    const early = await pool.connect();
    const blocker = await pool.connect();
    try {
      // xid order: early < blocker < the change inserted next.
      await early.query('BEGIN');
      await early.query('SELECT pg_current_xact_id()');
      await blocker.query('BEGIN');
      await blocker.query('SELECT pg_current_xact_id()');
      await insert(pool, 'rrev_first'); // lower seq, but a transaction after `blocker`
      await insert(early, 'rrev_second'); // higher seq, but a transaction before `blocker`
      await early.query('COMMIT');
      // `blocker` is the oldest transaction in flight, so rrev_first is held back while
      // rrev_second sits below it. Filtering on xid alone would return rrev_second and a
      // cursor past rrev_first, which would then never be seen.
      const during = await store.changesAfter({ account_id: account, cursor: start.cursor });
      assert.deepEqual(ids(during), []);
      assert.equal(during.cursor, start.cursor, 'the cursor does not move past the held-back change');
      await blocker.query('COMMIT');
    } finally {
      await early.query('ROLLBACK').catch(() => undefined);
      await blocker.query('ROLLBACK').catch(() => undefined);
      early.release();
      blocker.release();
    }
    const after = await until(
      () => store.changesAfter({ account_id: account, cursor: start.cursor }),
      ['rrev_first', 'rrev_second']
    );
    assert.deepEqual(ids(after), ['rrev_first', 'rrev_second']);
  });

  test('a committed prefix is returned and the cursor stops before the first in-flight change', async () => {
    const start = await store.changesAfter({ account_id: account });
    await insert(pool, 'rrev_prefix_a');
    const open = await pool.connect();
    try {
      await open.query('BEGIN');
      await insert(open, 'rrev_prefix_b'); // in flight
      await insert(pool, 'rrev_prefix_c'); // committed after it
      const during = await until(
        () => store.changesAfter({ account_id: account, cursor: start.cursor }),
        ['rrev_prefix_a']
      );
      assert.deepEqual(ids(during), ['rrev_prefix_a'], 'truncated, not filtered: c is not handed out past b');
      await open.query('COMMIT');
      const rest = await until(
        () => store.changesAfter({ account_id: account, cursor: during.cursor }),
        ['rrev_prefix_b', 'rrev_prefix_c']
      );
      assert.deepEqual(ids(rest), ['rrev_prefix_b', 'rrev_prefix_c']);
    } finally {
      await open.query('ROLLBACK').catch(() => undefined);
      open.release();
    }
  });

  test('the account feed query the store runs is served by the (account_id, seq) index', async () => {
    await pool.query(
      `INSERT INTO adcp_reporting_changes (account_id, record_kind, record_id, obligation_id)
       SELECT 'acct_filler_' || n, 'revision', 'rrev_filler_' || n, 'robl_filler' FROM generate_series(1, 2000) n`
    );
    await pool.query('ANALYZE adcp_reporting_changes');
    const executed = [];
    const spy = {
      connect: pool.connect.bind(pool),
      query: (sql, values) => {
        executed.push({ sql, values });
        return pool.query(sql, values);
      },
    };
    const ledger = require('../../dist/lib/reporting/ledger/index.js');
    const spied = new ledger.PostgresReportingLedgerStore(spy, { acknowledgeIsolatedDatabase: true, changeFeed: true });
    await spied.changesAfter({ account_id: account });
    const page = executed.find(call => /FROM adcp_reporting_changes\s+WHERE account_id/.test(call.sql));
    assert.ok(page, 'the account feed page query ran');
    const plan = await pool.query(`EXPLAIN ${page.sql}`, page.values);
    assert.match(plan.rows.map(row => row['QUERY PLAN']).join('\n'), /adcp_reporting_changes_account/);
  });
});
