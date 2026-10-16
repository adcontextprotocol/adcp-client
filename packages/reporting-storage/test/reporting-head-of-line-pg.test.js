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

const { createRowStorageFixture } = require('./helpers/reporting-row-storage-fixture.js');

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
    ledger = require('./helpers/ledger.js');
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
  let ledger;

  const insert = (client, recordId, accountId = account) =>
    client.query(
      `INSERT INTO adcp_reporting_changes (account_id, record_kind, record_id, obligation_id)
       VALUES ($1, 'revision', $2, 'robl_hol_feed')`,
      [accountId, recordId]
    );
  // A committed change with a chosen (historical, so always below the snapshot's xmin) transaction
  // id, and optionally an old recorded_at, for ordering and pruning cases that need exact values.
  const insertAt = (accountId, recordId, xid, { ageDays = 0 } = {}) =>
    pool.query(
      `INSERT INTO adcp_reporting_changes (xid, account_id, record_kind, record_id, obligation_id, recorded_at)
       VALUES ($1::text::xid8, $2, 'revision', $3, 'robl_hol_feed', clock_timestamp() - ($4::integer * INTERVAL '1 day'))`,
      [String(xid), accountId, recordId, ageDays]
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
    ledger = require('./helpers/ledger.js');
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

  test('a change with a lower xid and a higher seq is returned first, and the held-back one after it', async () => {
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
      // `blocker` is the oldest transaction in flight, so rrev_first (a later xid) is held back
      // while rrev_second sits below it. The feed orders by (xid, seq), so rrev_second comes
      // first and the cursor stops at it, before rrev_first.
      const during = await until(
        () => store.changesAfter({ account_id: account, cursor: start.cursor }),
        ['rrev_second']
      );
      assert.deepEqual(ids(during), ['rrev_second']);
      assert.notEqual(during.cursor, start.cursor);
      await blocker.query('COMMIT');
      const rest = await until(
        () => store.changesAfter({ account_id: account, cursor: during.cursor }),
        ['rrev_first']
      );
      assert.deepEqual(ids(rest), ['rrev_first'], 'the held-back change is delivered once, after the cursor');
    } finally {
      await early.query('ROLLBACK').catch(() => undefined);
      await blocker.query('ROLLBACK').catch(() => undefined);
      early.release();
      blocker.release();
    }
    const all = await until(
      () => store.changesAfter({ account_id: account, cursor: start.cursor }),
      ['rrev_second', 'rrev_first']
    );
    assert.deepEqual(ids(all), ['rrev_second', 'rrev_first'], 'a fresh reader sees the same (xid, seq) order');
  });

  test('a lower seq with a higher xid that commits late is delivered after the cursor, never skipped', async () => {
    // No account lock is taken anywhere here: two writers under different lock keys.
    const start = await store.changesAfter({ account_id: account });
    const quick = await pool.connect();
    const slow = await pool.connect();
    try {
      await quick.query('BEGIN');
      await quick.query('SELECT pg_current_xact_id()'); // xid Q
      await slow.query('BEGIN');
      await slow.query('SELECT pg_current_xact_id()'); // xid S > Q
      await insert(slow, 'rrev_late'); // lower seq, higher xid
      await insert(quick, 'rrev_quick'); // higher seq, lower xid
      await quick.query('COMMIT');
      const during = await until(
        () => store.changesAfter({ account_id: account, cursor: start.cursor }),
        ['rrev_quick']
      );
      assert.deepEqual(ids(during), ['rrev_quick'], 'the late transaction is still open, so only the lower xid');
      await slow.query('COMMIT');
      const rest = await until(() => store.changesAfter({ account_id: account, cursor: during.cursor }), ['rrev_late']);
      assert.deepEqual(ids(rest), ['rrev_late']);
      assert.deepEqual(
        ids(await store.changesAfter({ account_id: account, cursor: rest.cursor })),
        [],
        'and nothing is delivered twice'
      );
    } finally {
      await quick.query('ROLLBACK').catch(() => undefined);
      await slow.query('ROLLBACK').catch(() => undefined);
      quick.release();
      slow.release();
    }
  });

  test('an open transaction on another account holds a later change back, and releases it when it ends', async () => {
    const other = 'acct_hol_feed_other';
    const start = await store.changesAfter({ account_id: account });
    const open = await pool.connect();
    try {
      await open.query('BEGIN');
      await insert(open, 'rrev_other_inflight', other); // another account's transaction, in flight
      await insert(pool, 'rrev_after_other');
      // xmin is cluster-wide, so a later xid is held back whichever account the open one wrote.
      assert.deepEqual(ids(await store.changesAfter({ account_id: account, cursor: start.cursor })), []);
      await open.query('COMMIT');
    } finally {
      await open.query('ROLLBACK').catch(() => undefined);
      open.release();
    }
    const after = await until(
      () => store.changesAfter({ account_id: account, cursor: start.cursor }),
      ['rrev_after_other']
    );
    assert.deepEqual(ids(after), ['rrev_after_other']);
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
      assert.deepEqual(ids(during), ['rrev_prefix_a'], 'c is not handed out past b');
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

  test('the account feed cursor carries the xid of the last change and is bound to its account', async () => {
    const scoped = 'acct_hol_feed_cursor';
    await insertAt(scoped, 'rrev_cursor_a', 20);
    const page = await store.changesAfter({ account_id: scoped });
    const decoded = ledger.decodeReportingChangeCursorV1(page.cursor, scoped);
    assert.equal(decoded.xid, '20');
    assert.equal(ledger.isLegacyAccountChangeCursor(decoded), false);
    assert.throws(() => ledger.decodeReportingChangeCursorV1(page.cursor, 'acct_hol_feed_elsewhere'));
    await assert.rejects(() => store.changesAfter({ cursor: page.cursor }), /does not belong to this feed/);
  });

  describe('account cursors issued before the (xid, seq) order', () => {
    const legacyCursor = (accountId, seq) => ledger.encodeReportingChangeCursorV1({ v: 1, account: accountId, seq });
    const seqOf = async recordId =>
      (await pool.query('SELECT seq::text AS seq FROM adcp_reporting_changes WHERE record_id = $1', [recordId])).rows[0]
        .seq;

    test('maps to a position that skips nothing, redelivers at most what a lower seq already delivered, and upgrades the cursor', async () => {
      const scoped = 'acct_hol_legacy_map';
      // r2 took a higher seq but a lower xid than r1: the late commit the old order could skip.
      await insertAt(scoped, 'r0', 5); // read long ago, in a transaction older than any unread change
      await insertAt(scoped, 'r1', 20);
      await insertAt(scoped, 'r2', 10);
      await insertAt(scoped, 'r3', 30);
      const page = await store.changesAfter({ account_id: scoped, cursor: legacyCursor(scoped, await seqOf('r1')) });
      assert.deepEqual(
        ids(page),
        ['r2', 'r1', 'r3'],
        'r2 is delivered; r1 is redelivered because its xid is above r2; r0 is not, so the position is not simply xid 0'
      );
      const upgraded = ledger.decodeReportingChangeCursorV1(page.cursor, scoped);
      assert.equal(upgraded.xid, '30');
      assert.deepEqual(ids(await store.changesAfter({ account_id: scoped, cursor: page.cursor })), []);

      // A legacy cursor at the end of the feed has nothing unread, so it maps to the snapshot's xmin.
      const end = await store.changesAfter({ account_id: scoped, cursor: legacyCursor(scoped, await seqOf('r3')) });
      assert.deepEqual(ids(end), []);
      const mappedEnd = ledger.decodeReportingChangeCursorV1(end.cursor, scoped);
      assert.equal(mappedEnd.seq, await seqOf('r3'));
      assert.ok(BigInt(mappedEnd.xid) > 30n, 'an empty page still upgrades the cursor, to the snapshot xmin');
    });

    test('a caught-up legacy cursor does not skip a change from a transaction that was in flight', async () => {
      const scoped = 'acct_hol_legacy_inflight';
      await insertAt(scoped, 'caught_up', 10);
      const head = await seqOf('caught_up');
      const open = await pool.connect();
      try {
        await open.query('BEGIN');
        await insert(open, 'inflight', scoped); // xid at or above the snapshot's xmin
        const during = await store.changesAfter({ account_id: scoped, cursor: legacyCursor(scoped, head) });
        assert.deepEqual(ids(during), []);
        await open.query('COMMIT');
        const rest = await until(() => store.changesAfter({ account_id: scoped, cursor: during.cursor }), ['inflight']);
        assert.deepEqual(ids(rest), ['inflight'], 'the mapped position is below the open transaction');
      } finally {
        await open.query('ROLLBACK').catch(() => undefined);
        open.release();
      }
    });

    test('fails with CURSOR_EXPIRED when any change with a higher seq has been pruned', async () => {
      const scoped = 'acct_hol_legacy_pruned';
      // Pruned: (xid 20, seq s1) and (xid 10, seq s2). The highest (xid, seq) is s1's, but s2 > s1.
      await insertAt(scoped, 'p1', 20, { ageDays: 40 });
      await insertAt(scoped, 'p2', 10, { ageDays: 40 });
      await insertAt(scoped, 'p3', 30);
      const [s1, s2] = [await seqOf('p1'), await seqOf('p2')];
      assert.equal((await store.pruneChanges({ changeRetentionDays: 30 })).deleted >= 2, true);
      const expired = async cursor => {
        try {
          await store.changesAfter({ account_id: scoped, cursor });
          return false;
        } catch (error) {
          assert.equal(error.code, 'CURSOR_EXPIRED');
          return true;
        }
      };
      assert.equal(
        await expired(legacyCursor(scoped, s1)),
        true,
        'p2 was pruned after seq s1: a tuple compare would miss it'
      );
      assert.equal(await expired(legacyCursor(scoped, '0')), true);
      assert.equal(await expired(legacyCursor(scoped, s2)), false);
      assert.equal(
        await expired(ledger.encodeReportingChangeCursorV1({ v: 1, account: scoped, seq: s1, xid: '20' })),
        false,
        'a cursor at the horizon has passed everything pruned'
      );
      assert.equal(
        await expired(ledger.encodeReportingChangeCursorV1({ v: 1, account: scoped, seq: s2, xid: '10' })),
        true,
        'a cursor below the horizon in (xid, seq) order may have missed a pruned change'
      );
      assert.deepEqual(
        ids(await store.changesAfter({ account_id: scoped })),
        ['p3'],
        'no cursor starts at the horizon'
      );
    });

    test('a legacy consumer registration holds its changes by seq until it saves a new cursor', async () => {
      const scoped = 'acct_hol_legacy_consumer';
      await insertAt(scoped, 'c1', 10, { ageDays: 40 });
      await insertAt(scoped, 'c2', 20, { ageDays: 40 });
      await insertAt(scoped, 'c3', 30, { ageDays: 40 });
      const s1 = await seqOf('c1');
      const consumers = () =>
        pool.query(
          `SELECT cursor_xid::text AS xid, cursor_seq::text AS seq FROM adcp_reporting_feed_consumers WHERE consumer_name = 'legacy-sink'`
        );
      await pool.query(
        `INSERT INTO adcp_reporting_feed_consumers (consumer_name, account_id, cursor_xid, cursor_seq)
         VALUES ('legacy-sink', $1, NULL, $2::bigint)`,
        [scoped, s1]
      );
      try {
        await store.pruneChanges({ changeRetentionDays: 30 });
        assert.deepEqual(
          (
            await pool.query(`SELECT record_id FROM adcp_reporting_changes WHERE account_id = $1 ORDER BY seq`, [
              scoped,
            ])
          ).rows.map(row => row.record_id),
          ['c2', 'c3'],
          'c1 was passed and pruned; c2 and c3 are held'
        );
        // Saving a legacy cursor registers a mapped position, below every unread change.
        assert.equal(await store.saveFeedConsumerCursor('legacy-sink', legacyCursor(scoped, s1)), true);
        const mapped = (await consumers()).rows[0];
        assert.equal(mapped.xid, '20', 'the oldest unread change is c2, at xid 20');
        // A cursor in the new format replaces it, forward only.
        const page = await store.changesAfter({ account_id: scoped, cursor: legacyCursor(scoped, s1) });
        assert.deepEqual(ids(page), ['c2', 'c3']);
        assert.equal(await store.saveFeedConsumerCursor('legacy-sink', page.cursor), true);
        assert.deepEqual((await consumers()).rows[0], { xid: '30', seq: await seqOf('c3') });
      } finally {
        await store.removeFeedConsumer('legacy-sink');
      }
    });

    test('a NULL-xid consumer row is replaced by a new-format cursor unless its seq is behind', async () => {
      const scoped = 'acct_hol_legacy_replace';
      await pool.query(
        `INSERT INTO adcp_reporting_feed_consumers (consumer_name, account_id, cursor_xid, cursor_seq)
         VALUES ('legacy-replace', $1, NULL, 9000)`,
        [scoped]
      );
      try {
        const read = async () =>
          (
            await pool.query(
              `SELECT cursor_xid::text AS xid, cursor_seq::text AS seq FROM adcp_reporting_feed_consumers WHERE consumer_name = 'legacy-replace'`
            )
          ).rows[0];
        const at = (seq, xid) => ledger.encodeReportingChangeCursorV1({ v: 1, account: scoped, seq, xid });
        assert.equal(await store.saveFeedConsumerCursor('legacy-replace', at('5', '7')), false, 'behind the seq hold');
        assert.deepEqual(await read(), { xid: null, seq: '9000' });
        assert.equal(await store.saveFeedConsumerCursor('legacy-replace', at('9000', '7')), true);
        assert.deepEqual(await read(), { xid: '7', seq: '9000' });
        // Rewinding is explicit.
        assert.equal(await store.saveFeedConsumerCursor('legacy-replace', at('5', '7')), false);
        assert.equal(await store.saveFeedConsumerCursor('legacy-replace', at('5', '7'), { rewind: true }), true);
      } finally {
        await store.removeFeedConsumer('legacy-replace');
      }
    });
  });

  describe('legacy cursors and registrations through saveFeedConsumerCursor', () => {
    const seqOf = async recordId =>
      (await pool.query('SELECT seq::text AS seq FROM adcp_reporting_changes WHERE record_id = $1', [recordId])).rows[0]
        .seq;

    test('a mapped legacy cursor is forward-only against a new-format registration', async () => {
      const scoped = 'acct_hol_legacy_save';
      await insertAt(scoped, 's1', 20);
      await insertAt(scoped, 's2', 30);
      const [s1, s2] = [await seqOf('s1'), await seqOf('s2')];
      const ahead = ledger.encodeReportingChangeCursorV1({ v: 1, account: scoped, seq: s2, xid: '30' });
      const legacy = ledger.encodeReportingChangeCursorV1({ v: 1, account: scoped, seq: s1 });
      try {
        await store.saveFeedConsumerCursor('legacy-save', ahead);
        assert.equal(await store.saveFeedConsumerCursor('legacy-save', legacy), false, 'maps behind the saved cursor');
        await store.removeFeedConsumer('legacy-save');
        assert.equal(await store.saveFeedConsumerCursor('legacy-save', legacy), true, 'first save registers it');
      } finally {
        await store.removeFeedConsumer('legacy-save');
      }
    });
  });

  test('cursor values the database would reject fail as INVALID_INPUT, not as a raw database error', async () => {
    const encode = body => Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
    const bad = [
      { v: 1, account: 'a', seq: '9223372036854775808' },
      { v: 1, account: 'a', seq: '1', xid: '18446744073709551616' },
      { v: 1, account: null, seq: '1', xid: '99999999999999999999' },
      { v: 1, account: null, seq: '1' },
      { v: 1, account: 'a', seq: '' },
      { v: 1, account: 'a', seq: '1', xid: 'x' },
    ];
    for (const body of bad) {
      await assert.rejects(
        () => store.changesAfter({ ...(body.account ? { account_id: body.account } : {}), cursor: encode(body) }),
        error => error.code === 'INVALID_INPUT',
        JSON.stringify(body)
      );
    }
    assert.doesNotThrow(() =>
      ledger.decodeReportingChangeCursorV1(
        encode({ v: 1, account: 'a', seq: '9223372036854775807', xid: '18446744073709551615' }),
        'a'
      )
    );
  });

  describe('pruning in (xid, seq) order', () => {
    const remaining = async accountId =>
      (
        await pool.query(`SELECT record_id FROM adcp_reporting_changes WHERE account_id = $1 ORDER BY seq`, [accountId])
      ).rows.map(row => row.record_id);
    const seqOf = async recordId =>
      (await pool.query('SELECT seq::text AS seq FROM adcp_reporting_changes WHERE record_id = $1', [recordId])).rows[0]
        .seq;

    test('an account consumer holds every change after its cursor in (xid, seq) order, not seq order', async () => {
      const scoped = 'acct_hol_prune_order';
      await insertAt(scoped, 'o1', 10, { ageDays: 40 });
      await insertAt(scoped, 'o2', 30, { ageDays: 40 });
      await insertAt(scoped, 'o3', 20, { ageDays: 40 }); // higher seq than o2, lower xid
      const [o1, o3] = [await seqOf('o1'), await seqOf('o3')];
      const cursor = ledger.encodeReportingChangeCursorV1({ v: 1, account: scoped, seq: o3, xid: '20' });
      await store.saveFeedConsumerCursor('prune-order', cursor);
      try {
        await store.pruneChanges({ changeRetentionDays: 30 });
        assert.deepEqual(await remaining(scoped), ['o2'], 'o2 follows the cursor in xid order though its seq is lower');
        const horizon = (
          await pool.query(
            `SELECT pruned_through_xid::text AS xid, pruned_through_xid_seq::text AS xid_seq, pruned_through_seq::text AS seq
               FROM adcp_reporting_change_account_horizon WHERE account_id = $1`,
            [scoped]
          )
        ).rows[0];
        assert.deepEqual(horizon, { xid: '20', xid_seq: o3, seq: o3 });
        // The consumer reads on from where it was and is not told it missed anything.
        assert.deepEqual(ids(await store.changesAfter({ account_id: scoped, cursor })), ['o2']);
        // A consumer that had only passed o1 has missed o3 (pruned): expired.
        const behind = ledger.encodeReportingChangeCursorV1({
          v: 1,
          account: scoped,
          seq: o1,
          xid: '10',
        });
        await assert.rejects(
          () => store.changesAfter({ account_id: scoped, cursor: behind }),
          error => error.code === 'CURSOR_EXPIRED'
        );
      } finally {
        await store.removeFeedConsumer('prune-order');
      }
    });

    test('the horizon only moves forward, and an unrelated consumer for another account holds nothing', async () => {
      const scoped = 'acct_hol_prune_forward';
      await insertAt(scoped, 'f1', 50, { ageDays: 40 });
      await store.saveFeedConsumerCursor(
        'prune-elsewhere',
        ledger.encodeReportingChangeCursorV1({ v: 1, account: 'acct_hol_prune_elsewhere', seq: '1', xid: '1' })
      );
      try {
        await store.pruneChanges({ changeRetentionDays: 30 });
        assert.deepEqual(await remaining(scoped), []);
        const read = async () =>
          (
            await pool.query(
              `SELECT pruned_through_xid::text AS xid FROM adcp_reporting_change_account_horizon WHERE account_id = $1`,
              [scoped]
            )
          ).rows[0].xid;
        assert.equal(await read(), '50');
        await insertAt(scoped, 'f2', 40, { ageDays: 40 }); // lower xid than the horizon
        await store.pruneChanges({ changeRetentionDays: 30 });
        assert.equal(await read(), '50', 'a lower (xid, seq) never lowers the horizon');
      } finally {
        await store.removeFeedConsumer('prune-elsewhere');
      }
    });
  });

  test('a pruning batch cut by its limit leaves nothing retained below the account horizon', async () => {
    const scoped = 'acct_hol_prune_batch';
    await insertAt(scoped, 'a', 20, { ageDays: 40 });
    await insertAt(scoped, 'b', 30, { ageDays: 40 });
    await insertAt(scoped, 'c', 10, { ageDays: 40 }); // the highest seq, the lowest xid
    await store.pruneChanges({ changeRetentionDays: 30, limit: 2 });
    const remaining = (
      await pool.query(`SELECT record_id FROM adcp_reporting_changes WHERE account_id = $1 ORDER BY seq`, [scoped])
    ).rows.map(row => row.record_id);
    assert.deepEqual(remaining, ['b'], 'victims are taken in (xid, seq) order: c then a');
    assert.deepEqual(ids(await store.changesAfter({ account_id: scoped })), remaining, 'a cold start loses nothing');
  });

  test('concurrent appliers of the changes migration all succeed', async () => {
    const { Pool } = require('pg');
    const concurrentSchema = `${schema}_concurrent`;
    await bootstrapPool.query(`CREATE SCHEMA "${concurrentSchema}"`);
    const concurrentPool = new Pool({
      connectionString: DATABASE_URL,
      options: `-c search_path="${concurrentSchema}"`,
      max: 8,
    });
    try {
      const results = await Promise.allSettled(
        Array.from({ length: 8 }, () => concurrentPool.query(ledger.REPORTING_LEDGER_CHANGES_MIGRATION))
      );
      assert.deepEqual(
        results.filter(result => result.status === 'rejected').map(result => result.reason.message),
        []
      );
    } finally {
      await concurrentPool.end();
      await bootstrapPool.query(`DROP SCHEMA IF EXISTS "${concurrentSchema}" CASCADE`);
    }
  });

  test('re-applying the changes migration upgrades an older install in place and is idempotent', async () => {
    const { Pool } = require('pg');
    const upgradeSchema = `${schema}_upgrade`;
    await bootstrapPool.query(`CREATE SCHEMA "${upgradeSchema}"`);
    const upgradePool = new Pool({ connectionString: DATABASE_URL, options: `-c search_path="${upgradeSchema}"` });
    try {
      // The tables as the previous migration created them.
      await upgradePool.query(`
        CREATE TABLE adcp_reporting_changes (
          seq BIGSERIAL PRIMARY KEY, xid xid8 NOT NULL DEFAULT pg_current_xact_id(), account_id TEXT NOT NULL,
          record_kind TEXT NOT NULL CHECK (record_kind IN ('obligation', 'revision', 'adjustment', 'retirement')),
          record_id TEXT NOT NULL, obligation_id TEXT NOT NULL, recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp());
        CREATE INDEX adcp_reporting_changes_account ON adcp_reporting_changes (account_id, seq);
        CREATE TABLE adcp_reporting_change_account_horizon (account_id TEXT PRIMARY KEY, pruned_through_seq BIGINT NOT NULL);
        INSERT INTO adcp_reporting_change_account_horizon VALUES ('acct_upgrade', 77);
        CREATE TABLE adcp_reporting_feed_consumers (
          consumer_name TEXT PRIMARY KEY CHECK (consumer_name ~ '^[A-Za-z0-9_.:-]{1,128}$'),
          account_id TEXT, cursor_xid xid8, cursor_seq BIGINT NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
          CHECK ((account_id IS NULL) = (cursor_xid IS NOT NULL)));
        INSERT INTO adcp_reporting_feed_consumers (consumer_name, account_id, cursor_xid, cursor_seq)
          VALUES ('old-account-sink', 'acct_upgrade', NULL, 5);
      `);
      await upgradePool
        .query(
          `INSERT INTO adcp_reporting_feed_consumers (consumer_name, account_id, cursor_xid, cursor_seq)
         VALUES ('old-deployment-sink', NULL, NULL, 5)`
        )
        .then(
          () => assert.fail('the old constraint rejected a deployment consumer without an xid'),
          error => assert.equal(error.code, '23514')
        );
      await upgradePool.query(ledger.REPORTING_LEDGER_CHANGES_MIGRATION);
      await upgradePool.query(ledger.REPORTING_LEDGER_CHANGES_MIGRATION);

      const horizon = (await upgradePool.query('SELECT * FROM adcp_reporting_change_account_horizon')).rows;
      assert.equal(horizon.length, 1);
      assert.equal(horizon[0].pruned_through_seq, '77', 'the existing seq horizon is kept');
      assert.equal(horizon[0].pruned_through_xid, '0');
      assert.equal(horizon[0].pruned_through_xid_seq, '0');
      const consumer = (await upgradePool.query(`SELECT cursor_xid, cursor_seq FROM adcp_reporting_feed_consumers`))
        .rows;
      assert.deepEqual(consumer, [{ cursor_xid: null, cursor_seq: '5' }], 'a legacy account consumer is kept');
      // The deployment feed still needs an xid; the account feed no longer can be NULL going forward.
      await assert.rejects(
        () =>
          upgradePool.query(
            `INSERT INTO adcp_reporting_feed_consumers (consumer_name, account_id, cursor_xid, cursor_seq)
             VALUES ('bad-deployment', NULL, NULL, 1)`
          ),
        error => error.code === '23514'
      );
      const checks = (
        await upgradePool.query(
          `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
            WHERE conrelid = 'adcp_reporting_feed_consumers'::regclass AND contype = 'c' ORDER BY conname`
        )
      ).rows;
      assert.equal(checks.filter(row => /account_id IS NULL\) = /.test(row.def)).length, 0, 'the old check is gone');
      assert.equal(checks.filter(row => row.conname === 'adcp_reporting_feed_consumers_cursor_scope').length, 1);
      const indexes = (
        await upgradePool.query(
          `SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND tablename = 'adcp_reporting_changes'`,
          [upgradeSchema]
        )
      ).rows.map(row => row.indexname);
      assert.ok(indexes.includes('adcp_reporting_changes_account_xid'));
      assert.ok(indexes.includes('adcp_reporting_changes_account'), 're-applying never drops an index');
    } finally {
      await upgradePool.end();
      await bootstrapPool.query(`DROP SCHEMA IF EXISTS "${upgradeSchema}" CASCADE`);
    }
  });

  test('the account feed query the store runs is served by the (account_id, xid, seq) index, in order', async () => {
    await pool.query(
      `INSERT INTO adcp_reporting_changes (account_id, record_kind, record_id, obligation_id)
       SELECT 'acct_filler_' || (n % 2000), 'revision', 'rrev_filler_' || n, 'robl_filler' FROM generate_series(1, 100000) n`
    );
    // Enough history for the account that a page of 500 is a small slice of it.
    await pool.query(
      `INSERT INTO adcp_reporting_changes (account_id, record_kind, record_id, obligation_id)
       SELECT $1, 'revision', 'rrev_history_' || n, 'robl_history' FROM generate_series(1, 3000) n`,
      [account]
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
    const spied = new ledger.PostgresReportingLedgerStore(spy, { acknowledgeIsolatedDatabase: true, changeFeed: true });
    await spied.changesAfter({ account_id: account });
    const page = executed.find(call => /FROM adcp_reporting_changes\s+WHERE account_id/.test(call.sql));
    assert.ok(page, 'the account feed page query ran');
    const plan = (await pool.query(`EXPLAIN ${page.sql}`, page.values)).rows.map(row => row['QUERY PLAN']).join('\n');
    assert.match(plan, /adcp_reporting_changes_account_xid/);
    assert.doesNotMatch(plan, /Sort/, 'the index already yields (xid, seq) order');
  });
});
