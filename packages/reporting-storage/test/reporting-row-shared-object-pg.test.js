/**
 * PostgreSQL integration tests for external row objects shared between row sets, and for the absence of a
 * per-object advisory lock on the delete and adopt paths (adcp-client#3281).
 *
 * Object keys are unique per row set (every writable binding's key template includes `{revision_key}`),
 * but header-only revisions share chunks within an obligation (covered by the compaction tests below
 * and the object-storage suite) and chunk rows written under an older template can name one object
 * from several row sets. These tests re-point chunk rows at a shared object to model the latter. Every delete path must leave an object another row set still references,
 * and must not leak it once the last reference is gone.
 *
 * The delete paths (retirement, compaction, the intent sweep) take no lock and hold no connection across the
 * provider delete: safety comes from the reference check, the row-state and intent-state fences and unique keys.
 * Two paths keep the lock because nothing but the lock orders them: a commit that adopts an object its own
 * intent did not record, and the orphan collector's delete. The tests below pin each side of that contract.
 *
 * REPORTING_LEDGER_PG_URL=postgres://localhost/test npm test --workspace=@adcp/reporting-storage -- test/reporting-row-shared-object-pg.test.js
 */
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { after, afterEach, before, describe, test } = require('node:test');

const { createRowStorageFixture } = require('./helpers/reporting-row-storage-fixture.js');

process.env.NODE_ENV = 'test';
const DATABASE_URL = process.env.REPORTING_LEDGER_PG_URL;

const rows = Array.from({ length: 30 }, (_, index) => ({ ordinal: index, value: index }));
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

describe('reporting shared row objects', { skip: !DATABASE_URL && 'PostgreSQL URL not set' }, () => {
  const schema = `adcp_reporting_shared_objects_${process.pid}`;
  let bootstrapPool;
  let pool;
  let ledger;
  let canonicalize;
  let root;
  let store;
  let sequence = 0;
  // Distinct per test, so one test never shares objects with another test's obligations.
  let current = rows;
  let afterAdoptedRead;
  let beforeDelete;
  // Pooled connections the store held checked out whenever the provider was asked to delete.
  let heldAtDelete = [];
  let providerCalls = { get: 0, stat: 0 };
  let binding;
  let provider;
  let baseProvider;

  const count = async (sql, values = []) => Number((await pool.query(sql, values)).rows[0].n);
  const accountId = target => target.fixture.request.account.account_id;
  const chunksOf = async rowSetId =>
    (
      await pool.query(
        `SELECT object_ref, native_version_ref FROM adcp_reporting_row_chunks WHERE row_set_id = $1 ORDER BY chunk_index`,
        [rowSetId]
      )
    ).rows;
  const fileOf = row => path.join(root, row.object_ref);
  const adjustmentRows = async target =>
    (await store.listAdjustments(target.fixture.obligation.reporting_obligation_id))[0]?.rows;

  async function expire(target, days = 40) {
    const obligationId = target.fixture.obligation.reporting_obligation_id;
    await pool.query(
      `UPDATE adcp_reporting_obligations
          SET period_start = period_start - ($2::integer * INTERVAL '1 day'),
              period_end = period_end - ($2::integer * INTERVAL '1 day'),
              created_at = created_at - ($2::integer * INTERVAL '1 day'),
              lease_expires_at = clock_timestamp() - INTERVAL '1 second'
        WHERE obligation_id = $1`,
      [obligationId, days]
    );
    for (const table of ['adcp_reporting_revisions', 'adcp_reporting_adjustments']) {
      await pool.query(
        `UPDATE ${table} SET recorded_at = recorded_at - ($2::integer * INTERVAL '1 day') WHERE obligation_id = $1`,
        [obligationId, days]
      );
    }
  }

  const retire = () => store.retireExpiredPeriods({ statusRetentionDays: 30 });

  /**
   * A leased obligation with an official revision and no adjustment yet. A revision's row set is
   * digested with its own ID, so revisions never collide; an adjustment is digested over its rows
   * alone.
   */
  async function officialObligation(suffix, accountId) {
    const fixture = await createRowStorageFixture({ store, suffix, ...(accountId ? { accountId } : {}) });
    const official = fixture.revision(`rrev_${suffix}`, 1, rows.slice(0, 5), {
      finality: 'official',
      kind: 'official',
    });
    await store.commitRevision(official, fixture.lease);
    return { fixture, official, adjustmentId: `radj_${suffix}` };
  }

  function adjustmentFor({ fixture, official, adjustmentId }) {
    const bytes = Buffer.from(canonicalize(current));
    const now = Date.now();
    return {
      reporting_adjustment_id: adjustmentId,
      reporting_obligation_id: fixture.obligation.reporting_obligation_id,
      adjusts_reporting_revision_id: official.reporting_revision_id,
      adjustmentNumber: 1,
      manifest: { level: 'basic', objectRef: 'manifest', sha256: 'b'.repeat(64), byteCount: 1 },
      sourcePublicationId: `publication-${adjustmentId}`,
      binding: {
        algorithm: 'rfc8785_jcs_v1',
        sha256: createHash('sha256').update(bytes).digest('hex'),
        byteCount: bytes.byteLength,
        rowCount: current.length,
      },
      rows: current,
      observedAt: new Date(now + 10).toISOString(),
      dataThrough: new Date(now - 1_000).toISOString(),
      sourceReadCutoffAt: new Date(now + 10).toISOString(),
      createdAt: new Date(now).toISOString(),
      wireAdjustment: { reporting_adjustment_id: adjustmentId, control_total_deltas: [] },
    };
  }

  /** Two obligations, each with an adjustment of identical rows, whose chunk rows name one object (as rows written under an older template could). */
  async function sharedPair({ separateAccounts = false } = {}) {
    sequence += 1;
    current = rows.map(row => ({ ...row, value: row.value + sequence * 100 }));
    const first = await officialObligation(`shared_a${sequence}`, separateAccounts ? `acct_a${sequence}` : undefined);
    const second = await officialObligation(`shared_b${sequence}`, separateAccounts ? `acct_b${sequence}` : undefined);
    await store.commitAdjustment(adjustmentFor(first), first.fixture.lease);
    await store.commitAdjustment(adjustmentFor(second), second.fixture.lease);
    const [chunkA] = await chunksOf(first.adjustmentId);
    const [ownB] = await chunksOf(second.adjustmentId);
    assert.notEqual(ownB.object_ref, chunkA.object_ref, 'identical rows still get a unique key per row set');
    // Point the second row set's chunk at the first's object (location columns are mutable) and drop its own.
    await pool.query(
      `UPDATE adcp_reporting_row_chunks SET object_ref = $2, native_version_ref = $3 WHERE row_set_id = $1`,
      [second.adjustmentId, chunkA.object_ref, chunkA.native_version_ref]
    );
    rmSync(fileOf(ownB));
    const [chunkB] = await chunksOf(second.adjustmentId);
    return { first, second, chunkA, chunkB };
  }

  before(async () => {
    const { Pool } = require('pg');
    ledger = require('./helpers/ledger.js');
    ({ canonicalize } = require('@adcp/sdk'));
    root = mkdtempSync(path.join(tmpdir(), 'adcp-shared-objects-'));
    bootstrapPool = new Pool({ connectionString: DATABASE_URL });
    await bootstrapPool.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ connectionString: DATABASE_URL, options: `-c search_path="${schema}"` });
    await pool.query(ledger.REPORTING_LEDGER_MIGRATION);
    await pool.query(ledger.REPORTING_ROW_STORAGE_MIGRATION);
    await pool.query(ledger.REPORTING_ORPHAN_FENCE_MIGRATION);
    const base = ledger.createFilesystemReportingRowObjectProviderV1({ roots: { rows: root } });
    baseProvider = base;
    // After an adopting writer reads the existing object, run a hook (once): the window between
    // adoption and the writer's ledger commit.
    provider = {
      ...base,
      async stat(input, context) {
        providerCalls.stat += 1;
        return base.stat(input, context);
      },
      async delete(input, context) {
        heldAtDelete.push(pool.totalCount - pool.idleCount);
        const hook = beforeDelete;
        // Cleared first: a delete the hook itself provokes must not re-enter it. `keep` re-arms it for the next delete.
        beforeDelete = undefined;
        if (hook && (await hook(input)) === 'keep') beforeDelete = hook;
        return base.delete(input, context);
      },
      async get(input, context) {
        providerCalls.get += 1;
        const bytes = await base.get(input, context);
        const hook = afterAdoptedRead;
        afterAdoptedRead = undefined;
        if (hook) await hook();
        return bytes;
      },
    };
    binding = {
      kind: 'object',
      provider: 'filesystem',
      location: { root: 'rows' },
      prefix: 'shared',
    };
    store = new ledger.PostgresReportingLedgerStore(pool, {
      acknowledgeIsolatedDatabase: true,
      rowStorage: {
        bindings: {
          objects: binding,
          // An older definition kept for the rows it wrote: no {revision_key}, never selected for new writes.
          legacy: {
            ...binding,
            readOnly: true,
            keyTemplate: '{prefix}/{namespace_key}/{account_key}/{content_sha256}/{chunk_index}',
          },
        },
        providers: { filesystem: provider },
      },
    });
    await store.readyRowStorage();
  });

  afterEach(() => {
    // A failed test must not leave a hook armed for the next one.
    afterAdoptedRead = undefined;
    beforeDelete = undefined;
  });

  after(async () => {
    if (pool) await pool.end();
    if (bootstrapPool) {
      await bootstrapPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await bootstrapPool.end();
    }
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test('chunk rows re-pointed at one object (as older-template rows can be) both read it', async () => {
    const { first, second, chunkA, chunkB } = await sharedPair();
    assert.deepEqual(chunkB, chunkA);
    assert.ok(existsSync(fileOf(chunkA)));
    assert.deepEqual(await adjustmentRows(first), current);
    assert.deepEqual(await adjustmentRows(second), current);
  });

  test('retiring one period leaves the object for the other, and retiring both removes it', async () => {
    const { first, second, chunkA } = await sharedPair();
    await expire(first);
    assert.deepEqual(await retire(), { retired: 1, failed: [], failures: [], deferred: 0, stuck: [] });
    assert.equal(
      await count(`SELECT count(*) AS n FROM adcp_reporting_row_sets WHERE obligation_id = $1`, [
        first.fixture.obligation.reporting_obligation_id,
      ]),
      0
    );
    assert.ok(existsSync(fileOf(chunkA)), 'the object another obligation references survives');
    assert.deepEqual(await adjustmentRows(second), current);

    await expire(second);
    assert.deepEqual(await retire(), { retired: 1, failed: [], failures: [], deferred: 0, stuck: [] });
    assert.equal(existsSync(fileOf(chunkA)), false, 'the last referencing period deletes the object');
  });

  test('retiring both periods in one pass removes the object', async () => {
    const { first, second, chunkA } = await sharedPair();
    await expire(first);
    await expire(second);
    assert.deepEqual(await retire(), { retired: 2, failed: [], failures: [], deferred: 0, stuck: [] });
    assert.equal(existsSync(fileOf(chunkA)), false);
  });

  /**
   * Resolves once a session is blocked on a lock `holder` holds. Bound to the holder's backend, not to any waiter
   * in the cluster: a parallel file's advisory-lock waiter must not satisfy this.
   */
  async function lockWaiter(holder) {
    const {
      rows: [{ pid }],
    } = await holder.query('SELECT pg_backend_pid() AS pid');
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const waiting = await count('SELECT count(*) AS n FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))', [
        pid,
      ]);
      if (waiting > 0) return;
      await sleep(25);
    }
    assert.fail('no session ever waited on the object lock');
  }

  const objectLockKey = objectRef => `adcp-reporting-object:objects:${objectRef}`;
  const timedOut = Symbol('timed out');
  const within = (promise, milliseconds = 5_000) => Promise.race([promise, sleep(milliseconds).then(() => timedOut)]);

  /** Hold the per-object advisory lock on a session outside the store's pool, until `release` is called. */
  async function holdObjectLock(objectRef) {
    const holder = await bootstrapPool.connect();
    let released = false;
    await holder.query('BEGIN');
    await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [objectLockKey(objectRef)]);
    return {
      async release() {
        if (released) return;
        released = true;
        await holder.query('ROLLBACK').catch(() => undefined);
        holder.release();
      },
    };
  }

  /** Sessions waiting for exactly this advisory lock key, so another file's waiters cannot satisfy it. */
  const waitersOn = lockText =>
    count(
      `SELECT count(*) AS n FROM pg_locks
        WHERE locktype = 'advisory' AND NOT granted
          AND ((classid::bigint << 32) | objid::bigint) = hashtextextended($1, 0)`,
      [lockText]
    );

  async function untilWaiting(lockText) {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      if ((await waitersOn(lockText)) > 0) return;
      await sleep(25);
    }
    assert.fail(`no session ever waited on ${lockText}`);
  }

  test('retirement takes no object lock and holds no connection while the provider deletes', async () => {
    const { first, second, chunkA } = await sharedPair();
    await expire(first);
    await expire(second);
    const held = await holdObjectLock(chunkA.object_ref);
    const retiring = retire();
    try {
      heldAtDelete = [];
      const result = await within(retiring);
      assert.notEqual(result, timedOut, 'retirement does not wait on the object lock');
      assert.equal(result.retired, 2);
    } finally {
      await held.release();
    }
    await retiring;
    assert.equal(existsSync(fileOf(chunkA)), false);
    assert.ok(heldAtDelete.length > 0, 'the provider was asked to delete');
    assert.ok(
      heldAtDelete.every(held => held === 0),
      'no pooled connection is checked out across a delete'
    );
  });

  test('the intent sweep takes no object lock and holds no connection while the provider deletes', async () => {
    const { target, objectRef, nativeVersionRef, file } = await preUploaded('sweeplock');
    await pool.query(
      `INSERT INTO adcp_reporting_row_write_intents
         (row_binding_id, account_id, row_set_id, content_sha256, state, owner_token, created_objects, expires_at)
       VALUES ('objects', $1, 'radj_sweep_no_lock', $2, 'open', 'owner', $3::jsonb,
               clock_timestamp() - INTERVAL '1 minute')`,
      [
        accountId(target),
        'a'.repeat(64),
        JSON.stringify([{ object_ref: objectRef, native_version_ref: nativeVersionRef }]),
      ]
    );
    const held = await holdObjectLock(objectRef);
    heldAtDelete = [];
    const sweeping = store.sweepRowWriteIntents();
    try {
      const result = await within(sweeping);
      assert.notEqual(result, timedOut, 'the sweep does not wait on the object lock');
      assert.equal(result.objectsDeleted, 1);
    } finally {
      await held.release();
    }
    await sweeping;
    assert.equal(existsSync(file), false);
    assert.deepEqual(heldAtDelete, [0]);
  });

  /** A leased obligation and a fresh adjustment for it, with no object uploaded yet. */
  async function freshTarget(suffix) {
    sequence += 1;
    current = rows.map(row => ({ ...row, value: row.value + sequence * 100 }));
    return officialObligation(`${suffix}${sequence}`);
  }

  /**
   * An attempt that uploads and records its objects, then fails before its ledger commit lands: the intent
   * stays open and names the created objects, as a writer that crashed or lost its connection leaves it.
   */
  async function abandonedAttempt(target) {
    const original = store.rowStorage.writeInTransaction;
    store.rowStorage.writeInTransaction = async () => {
      throw new Error('connection reset');
    };
    try {
      await assert.rejects(() => store.commitAdjustment(adjustmentFor(target), target.fixture.lease));
    } finally {
      store.rowStorage.writeInTransaction = original;
    }
    const intent = (
      await pool.query(`SELECT state, created_objects FROM adcp_reporting_row_write_intents WHERE row_set_id = $1`, [
        target.adjustmentId,
      ])
    ).rows;
    assert.equal(intent.length, 1, 'the failed attempt leaves its intent');
    assert.equal(intent[0].state, 'open');
    assert.equal(intent[0].created_objects.length, 1, 'and the intent names the object it created');
    return intent[0].created_objects[0];
  }

  const expireIntent = target =>
    pool.query(
      `UPDATE adcp_reporting_row_write_intents SET expires_at = clock_timestamp() - INTERVAL '1 minute'
        WHERE row_set_id = $1`,
      [target.adjustmentId]
    );

  /** Run `hook` after the real upload of the next commit returns, before its ledger transaction opens. */
  function afterUpload(hook) {
    const original = store.rowStorage.upload;
    store.rowStorage.upload = async function (...args) {
      const locators = await original.apply(this, args);
      await hook(locators);
      return locators;
    };
    return () => {
      store.rowStorage.upload = original;
    };
  }

  test('a retry adopts the object its own earlier attempt recorded without taking the object lock', async () => {
    const target = await freshTarget('selfretry');
    const recorded = await abandonedAttempt(target);
    await expireIntent(target);
    const held = await holdObjectLock(recorded.object_ref);
    providerCalls = { get: 0, stat: 0 };
    const committing = store.commitAdjustment(adjustmentFor(target), target.fixture.lease);
    try {
      const result = await within(committing);
      assert.notEqual(result, timedOut, 'adopting an object the writer recorded does not wait on the object lock');
      assert.equal(result.inserted, true);
    } finally {
      await held.release();
    }
    await committing;
    assert.equal(providerCalls.stat, 1, 'the adopted object is still proven with a version-pinned stat');
    assert.deepEqual(
      (await chunksOf(target.adjustmentId)).map(chunk => chunk.object_ref),
      [recorded.object_ref],
      'the chunk row names the adopted object'
    );
    assert.equal(
      await count(`SELECT count(*) AS n FROM adcp_reporting_row_write_intents WHERE row_set_id = $1`, [
        target.adjustmentId,
      ]),
      0
    );
    assert.deepEqual(await adjustmentRows(target), current);
  });

  test('a retry whose intent was written by an older writer (pre-alignment keys) also adopts without the lock', async () => {
    const target = await freshTarget('legacykeys');
    const recorded = await abandonedAttempt(target);
    await pool.query(`UPDATE adcp_reporting_row_write_intents SET created_objects = $2::jsonb WHERE row_set_id = $1`, [
      target.adjustmentId,
      JSON.stringify([{ objectKey: recorded.object_ref, nativeVersion: recorded.native_version_ref }]),
    ]);
    await expireIntent(target);
    const held = await holdObjectLock(recorded.object_ref);
    const committing = store.commitAdjustment(adjustmentFor(target), target.fixture.lease);
    try {
      const result = await within(committing);
      assert.notEqual(result, timedOut, 'the pre-alignment record is read like the current one');
      assert.equal(result.inserted, true);
    } finally {
      await held.release();
    }
    await committing;
    assert.deepEqual(await adjustmentRows(target), current);
  });

  test('a retry takes the object lock when its intent names the key at a different native version', async () => {
    const target = await freshTarget('otherversion');
    const recorded = await abandonedAttempt(target);
    await pool.query(`UPDATE adcp_reporting_row_write_intents SET created_objects = $2::jsonb WHERE row_set_id = $1`, [
      target.adjustmentId,
      JSON.stringify([{ object_ref: recorded.object_ref, native_version_ref: 'some-other-version' }]),
    ]);
    await expireIntent(target);
    const held = await holdObjectLock(recorded.object_ref);
    let committed = false;
    const committing = store.commitAdjustment(adjustmentFor(target), target.fixture.lease).then(result => {
      committed = true;
      return result;
    });
    try {
      await untilWaiting(objectLockKey(recorded.object_ref));
      assert.equal(committed, false, 'a record of another version does not vouch for the adopted one');
    } finally {
      await held.release();
    }
    assert.equal((await committing).inserted, true);
  });

  test('a retry still takes the object lock for an adopted object its intent does not name', async () => {
    const target = await freshTarget('unrecorded');
    const recorded = await abandonedAttempt(target);
    // The earlier attempt's PUT landed before the intent recorded it (or its record failed after a takeover).
    await pool.query(
      `UPDATE adcp_reporting_row_write_intents SET created_objects = '[]'::jsonb WHERE row_set_id = $1`,
      [target.adjustmentId]
    );
    await expireIntent(target);
    const held = await holdObjectLock(recorded.object_ref);
    let committed = false;
    try {
      const committing = store.commitAdjustment(adjustmentFor(target), target.fixture.lease).then(result => {
        committed = true;
        return result;
      });
      await untilWaiting(objectLockKey(recorded.object_ref));
      assert.equal(committed, false, 'an unrecorded adoption waits for the object lock');
      await held.release();
      assert.equal((await committing).inserted, true);
    } finally {
      await held.release();
    }
    assert.deepEqual(await adjustmentRows(target), current);
  });

  test('a writer whose intent expired before its commit cannot commit the objects the sweep deleted', async () => {
    const target = await freshTarget('pastlease');
    let sweep;
    // The intent lapses while the writer is between its upload and its commit (a stalled or partitioned writer).
    const restore = afterUpload(async () => {
      await expireIntent(target);
      sweep = await store.sweepRowWriteIntents();
    });
    try {
      await assert.rejects(
        () => store.commitAdjustment(adjustmentFor(target), target.fixture.lease),
        isStateUnavailable
      );
    } finally {
      restore();
    }
    assert.equal(sweep.swept, 1);
    assert.equal(sweep.objectsDeleted, 1, 'the sweep deleted what the intent created');
    for (const table of ['adcp_reporting_row_chunks', 'adcp_reporting_row_sets', 'adcp_reporting_row_write_intents']) {
      assert.equal(
        await count(`SELECT count(*) AS n FROM ${table} WHERE row_set_id = $1`, [target.adjustmentId]),
        0,
        table
      );
    }
    assert.equal((await store.listAdjustments(target.fixture.obligation.reporting_obligation_id)).length, 0);
    // Nothing references a deleted object, and the writer's next attempt re-creates it.
    await store.commitAdjustment(adjustmentFor(target), target.fixture.lease);
    assert.deepEqual(await adjustmentRows(target), current);
  });

  test('a takeover renews the intent, so a sweep cannot claim the objects its retry is about to commit', async () => {
    const target = await freshTarget('takeover');
    const recorded = await abandonedAttempt(target);
    await expireIntent(target);
    let sweep;
    const restore = afterUpload(async () => {
      sweep = await store.sweepRowWriteIntents();
    });
    try {
      assert.equal((await store.commitAdjustment(adjustmentFor(target), target.fixture.lease)).inserted, true);
    } finally {
      restore();
    }
    assert.equal(sweep.swept, 0, 'the retry took the expired intent over, so it is no longer expired');
    assert.equal(sweep.objectsDeleted, 0);
    assert.deepEqual(
      (await chunksOf(target.adjustmentId)).map(chunk => chunk.object_ref),
      [recorded.object_ref]
    );
    assert.deepEqual(await adjustmentRows(target), current);
  });

  test('a retry cannot take over an intent the sweep has claimed, and commits nothing', async () => {
    const target = await freshTarget('sweepfirst');
    await abandonedAttempt(target);
    await expireIntent(target);
    // The sweep has claimed the intent (`sweeping`) and is about to delete: a retry must not take it over.
    let retried;
    beforeDelete = async () => {
      retried = await store.commitAdjustment(adjustmentFor(target), target.fixture.lease).then(
        () => 'committed',
        error => error
      );
    };
    const swept = await store.sweepRowWriteIntents();
    assert.equal(swept.objectsDeleted, 1);
    assert.ok(isStateUnavailable(retried), 'a retry cannot take over an intent that is being swept');
    assert.equal(
      await count(`SELECT count(*) AS n FROM adcp_reporting_row_sets WHERE row_set_id = $1`, [target.adjustmentId]),
      0
    );
  });

  test('an orphan delete in flight blocks an adopter of the unrecorded object, which then fails cleanly', async () => {
    const { target, objectRef, file } = await preUploaded('collector');
    const later = new Date(Date.now() + 8 * 24 * 3_600_000);
    let committing;
    // The collector holds the object lock and has passed its reference check; an adopter arrives now.
    beforeDelete = async input => {
      if (input.objectRef !== objectRef) return 'keep';
      committing = store.commitAdjustment(adjustmentFor(target), target.fixture.lease).then(
        () => 'committed',
        error => error
      );
      await untilWaiting(objectLockKey(objectRef));
    };
    const result = await store.collectOrphanedRowObjects({
      now: later,
      acknowledgeExclusiveNamespace: true,
      bindings: ['objects'],
    });
    assert.ok(result.deleted >= 1);
    assert.equal(existsSync(file), false, 'the collector deleted the unrecorded object');
    const outcome = await committing;
    assert.ok(
      isStateUnavailable(outcome),
      `the adopter fails cleanly instead of committing a missing object: ${outcome}`
    );
    assert.equal(
      await count(`SELECT count(*) AS n FROM adcp_reporting_row_chunks WHERE row_set_id = $1`, [target.adjustmentId]),
      0
    );
  });

  test('retirements of legacy row sets in a readOnly binding sharing one object always free it', async () => {
    // Old-template rows live only in a readOnly binding, which never takes a commit, so nothing adopts through
    // it. Each retirement counts only live row sets outside itself, so however two interleave, the last frees it.
    for (let round = 0; round < 4; round += 1) {
      const { first, second, chunkA } = await sharedPair({ separateAccounts: true });
      await pool.query(
        `UPDATE adcp_reporting_row_sets SET row_binding_id = 'legacy', row_location_version = row_location_version + 1
          WHERE row_set_id = ANY($1)`,
        [[first.adjustmentId, second.adjustmentId]]
      );
      await expire(first);
      await expire(second);
      // Hold both retirements at the shared object's reference check until both have committed `pruning` (phase
      // 1 precedes the check): the interleaving in which a check that counted `pruning` row sets would make both skip.
      const original = store.isRowObjectReferenced;
      let arrived = 0;
      let open;
      const gate = new Promise(resolve => {
        open = resolve;
      });
      const timer = setTimeout(() => open(), 3_000);
      store.isRowObjectReferenced = async function (queryable, bindingId, object, scope) {
        if (object.objectRef === chunkA.object_ref) {
          arrived += 1;
          if (arrived === 2) open();
          await gate;
        }
        return original.call(this, queryable, bindingId, object, scope);
      };
      let a;
      let b;
      try {
        [a, b] = await Promise.all([
          store.retireExpiredPeriods({ statusRetentionDays: 30, account_id: accountId(first) }),
          store.retireExpiredPeriods({ statusRetentionDays: 30, account_id: accountId(second) }),
        ]);
      } finally {
        clearTimeout(timer);
        store.isRowObjectReferenced = original;
      }
      assert.equal(arrived, 2, 'both retirements reached the shared object together');
      assert.deepEqual([a.retired, b.retired], [1, 1]);
      assert.equal(a.failed.length + b.failed.length, 0);
      assert.equal(existsSync(fileOf(chunkA)), false, `round ${round}: the last retirement deletes the object`);
      assert.equal(
        await count(`SELECT count(*) AS n FROM adcp_reporting_row_sets WHERE row_set_id = ANY($1)`, [
          [first.adjustmentId, second.adjustmentId],
        ]),
        0
      );
    }
  });

  test('an adopting commit takes the object lock before it proves the object', async () => {
    const { target, objectRef, file } = await preUploaded('adoptlock');
    const lock = `adcp-reporting-object:objects:${objectRef}`;
    const client = await pool.connect();
    let committed = false;
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [lock]);
      providerCalls = { get: 0, stat: 0 };
      const committing = store.commitAdjustment(adjustmentFor(target), target.fixture.lease).then(result => {
        committed = true;
        return result;
      });
      await lockWaiter(client);
      assert.equal(committed, false, 'the adopter waits for the object lock');
      assert.equal(providerCalls.stat, 0, 'it has not proven the object yet');
      await client.query('COMMIT');
      assert.equal((await committing).inserted, true);
    } finally {
      client.release();
    }
    assert.equal(providerCalls.stat, 1);
    assert.ok(existsSync(file));
    assert.deepEqual(await adjustmentRows(target), current);
  });

  test('the intent sweep leaves an object a committed row set references, and retirement then frees it', async () => {
    const { first, second, chunkA } = await sharedPair();
    // An abandoned upload that created the object, which a committed row set later adopted.
    await pool.query(
      `INSERT INTO adcp_reporting_row_write_intents
         (row_binding_id, account_id, row_set_id, content_sha256, state, owner_token, created_objects, expires_at)
       VALUES ('objects', $1, 'radj_abandoned_creator', $2, 'open', 'owner', $3::jsonb,
               clock_timestamp() - INTERVAL '1 minute')`,
      [
        accountId(first),
        'c'.repeat(64),
        JSON.stringify([{ object_ref: chunkA.object_ref, native_version_ref: chunkA.native_version_ref }]),
      ]
    );
    assert.deepEqual(await store.sweepRowWriteIntents(), {
      swept: 1,
      objectsDeleted: 0,
      failed: 0,
      skippedUnconfigured: 0,
      deferred: 0,
      overdue: 0,
    });
    assert.ok(existsSync(fileOf(chunkA)), 'a committed reference keeps the swept object');
    assert.deepEqual(await adjustmentRows(first), current);

    await expire(first);
    await expire(second);
    assert.equal((await retire()).retired, 2);
    assert.equal(existsSync(fileOf(chunkA)), false);
  });

  test('an open upload that created the object keeps it through retirement, and its sweep then frees it', async () => {
    const { first, second, chunkA } = await sharedPair();
    await pool.query(
      `INSERT INTO adcp_reporting_row_write_intents
         (row_binding_id, account_id, row_set_id, content_sha256, state, owner_token, created_objects, expires_at)
       VALUES ('objects', $1, 'radj_inflight_creator', $2, 'open', 'owner', $3::jsonb,
               clock_timestamp() + INTERVAL '1 hour')`,
      [
        accountId(first),
        'd'.repeat(64),
        JSON.stringify([{ object_ref: chunkA.object_ref, native_version_ref: chunkA.native_version_ref }]),
      ]
    );
    await expire(first);
    await expire(second);
    assert.equal((await retire()).retired, 2);
    assert.ok(existsSync(fileOf(chunkA)), 'a live upload that created the object may still commit it');

    await pool.query(
      `UPDATE adcp_reporting_row_write_intents SET expires_at = clock_timestamp() - INTERVAL '1 minute'
        WHERE row_set_id = 'radj_inflight_creator'`
    );
    assert.deepEqual(await store.sweepRowWriteIntents(), {
      swept: 1,
      objectsDeleted: 1,
      failed: 0,
      skippedUnconfigured: 0,
      deferred: 0,
      overdue: 0,
    });
    assert.equal(existsSync(fileOf(chunkA)), false, 'nothing references it any more');
  });

  test('an open upload from an older writer, recorded under the pre-alignment keys, still protects its object', async () => {
    const { first, second, chunkA } = await sharedPair();
    await pool.query(
      `INSERT INTO adcp_reporting_row_write_intents
         (row_binding_id, account_id, row_set_id, content_sha256, state, owner_token, created_objects, expires_at)
       VALUES ('objects', $1, 'radj_old_writer', $2, 'open', 'owner', $3::jsonb,
               clock_timestamp() + INTERVAL '1 hour')`,
      [
        accountId(first),
        'e'.repeat(64),
        JSON.stringify([{ objectKey: chunkA.object_ref, nativeVersion: chunkA.native_version_ref }]),
      ]
    );
    await expire(first);
    await expire(second);
    assert.equal((await retire()).retired, 2);
    assert.ok(existsSync(fileOf(chunkA)), 'the old writer may still commit the object it created');

    await pool.query(
      `UPDATE adcp_reporting_row_write_intents SET expires_at = clock_timestamp() - INTERVAL '1 minute'
        WHERE row_set_id = 'radj_old_writer'`
    );
    assert.deepEqual(await store.sweepRowWriteIntents(), {
      swept: 1,
      objectsDeleted: 1,
      failed: 0,
      skippedUnconfigured: 0,
      deferred: 0,
      overdue: 0,
    });
    assert.equal(existsSync(fileOf(chunkA)), false, 'the sweep reads the old keys too');
  });

  /**
   * An obligation whose next adjustment's object already sits at its planned key, as an abandoned upload
   * of the same row set leaves it, so the commit adopts it. Keys are unique per row set, so adoption only
   * ever happens for a retry of the same row set.
   */
  async function preUploaded(suffix) {
    sequence += 1;
    current = rows.map(row => ({ ...row, value: row.value + sequence * 100 }));
    const target = await officialObligation(`${suffix}${sequence}`);
    const adjustment = adjustmentFor(target);
    const engine = new ledger.ReportingRowStorageV1(pool, {
      bindings: { objects: binding },
      providers: { filesystem: provider },
    });
    const prepared = await engine.prepare({
      rowSetId: adjustment.reporting_adjustment_id,
      rowSetKind: 'adjustment',
      accountId: accountId(target),
      obligationId: target.fixture.obligation.reporting_obligation_id,
      rows: adjustment.rows,
      periodStart: target.fixture.obligation.period.start,
      sourceTimezone: target.fixture.obligation.period.sourceTimezone,
      binding: adjustment.binding,
    });
    const [planned] = prepared.objects;
    const created = await baseProvider.putIfAbsent(
      {
        location: { root: 'rows' },
        objectRef: planned.objectRef,
        bytes: planned.physicalBytes,
        contentType: 'application/gzip',
        metadata: {},
      },
      { signal: AbortSignal.timeout(5_000) }
    );
    return {
      target,
      objectRef: planned.objectRef,
      nativeVersionRef: created.nativeVersionRef,
      file: path.join(root, planned.objectRef),
    };
  }

  const isStateUnavailable = error => ledger.isReportingRowStoreError(error) && error.code === 'STATE_UNAVAILABLE';

  test('a commit whose adopted object was deleted after adoption fails cleanly and retries', async () => {
    const { target, objectRef, nativeVersionRef, file } = await preUploaded('race');
    // After the adopter has verified the object, an abandoned upload recorded as its creator is swept.
    // (Keys are unique per row set, so the only other writer that can have created this object is an
    // earlier attempt at the same row set; the intent below stands in for it.)
    let hookRan = false;
    afterAdoptedRead = async () => {
      hookRan = true;
      await pool.query(
        `INSERT INTO adcp_reporting_row_write_intents
           (row_binding_id, account_id, row_set_id, content_sha256, state, owner_token, created_objects, expires_at)
         VALUES ('objects', $1, 'radj_other_creator', $2, 'open', 'owner', $3::jsonb,
                 clock_timestamp() - INTERVAL '1 minute')`,
        [
          accountId(target),
          'f'.repeat(64),
          JSON.stringify([{ object_ref: objectRef, native_version_ref: nativeVersionRef }]),
        ]
      );
      assert.equal((await store.sweepRowWriteIntents()).objectsDeleted, 1);
    };
    await assert.rejects(() => store.commitAdjustment(adjustmentFor(target), target.fixture.lease), isStateUnavailable);
    assert.equal(hookRan, true, 'the object was swept between adoption and commit');
    assert.equal(existsSync(file), false);
    assert.equal(
      await count(`SELECT count(*) AS n FROM adcp_reporting_row_chunks WHERE row_set_id = $1`, [target.adjustmentId]),
      0
    );
    assert.equal((await store.listAdjustments(target.fixture.obligation.reporting_obligation_id)).length, 0);

    // The writer's intent is still open; once it lapses the upload re-creates the object.
    await pool.query(
      `UPDATE adcp_reporting_row_write_intents SET expires_at = clock_timestamp() - INTERVAL '1 minute'
        WHERE row_set_id = $1`,
      [target.adjustmentId]
    );
    await store.commitAdjustment(adjustmentFor(target), target.fixture.lease);
    assert.deepEqual(await adjustmentRows(target), current);
    assert.ok(existsSync(file));
  });

  test('the commit proves an adopted object with a version-pinned stat instead of downloading it again', async () => {
    const { target, file } = await preUploaded('stat');
    providerCalls = { get: 0, stat: 0 };
    await store.commitAdjustment(adjustmentFor(target), target.fixture.lease);
    // One read verifies the adopted bytes before the transaction; the commit itself only stats.
    assert.deepEqual(providerCalls, { get: 1, stat: 1 });
    assert.deepEqual(await adjustmentRows(target), current);
    const size = (
      await pool.query(`SELECT size_bytes FROM adcp_reporting_row_chunks WHERE row_set_id = $1`, [target.adjustmentId])
    ).rows[0].size_bytes;
    assert.equal(Number(size), readFileSync(file).byteLength, 'size_bytes is the stored object size');
  });

  test('a commit whose adopted object was replaced at the same key with identical bytes fails the stat', async () => {
    const { target, file } = await preUploaded('swap');
    // After the adopter verified the object, someone deletes it and re-creates identical bytes.
    // The native version differs, so the version-pinned stat finds nothing at the recorded version.
    afterAdoptedRead = async () => {
      const bytes = readFileSync(file);
      const before = statSync(file);
      rmSync(file);
      writeFileSync(file, bytes);
      // Coarse kernel timestamps and inode reuse could otherwise reproduce the old version by chance.
      const later = before.mtimeMs / 1000 + 2;
      utimesSync(file, later, later);
    };
    providerCalls = { get: 0, stat: 0 };
    await assert.rejects(() => store.commitAdjustment(adjustmentFor(target), target.fixture.lease), isStateUnavailable);
    assert.equal(providerCalls.stat, 1, 'the stat, not another check, rejected the commit');
    assert.equal(
      await count(`SELECT count(*) AS n FROM adcp_reporting_row_chunks WHERE row_set_id = $1`, [target.adjustmentId]),
      0
    );
    assert.equal(
      await count(`SELECT count(*) AS n FROM adcp_reporting_row_sets WHERE row_set_id = $1`, [target.adjustmentId]),
      0
    );
    assert.equal((await store.listAdjustments(target.fixture.obligation.reporting_obligation_id)).length, 0);
    assert.ok(existsSync(file), 'the replacement object is left alone');
  });

  test('an adopter rejects a stat that cannot vouch for the exact recorded version', async () => {
    const variants = [
      [
        'reports a different size',
        async (input, context) => ({ ...(await provider.stat(input, context)), sizeBytes: 1 }),
        'STATE_UNAVAILABLE',
      ],
      ['finds nothing', async () => null, 'STATE_UNAVAILABLE'],
      [
        'answers for a different version',
        async (input, context) => ({ ...(await provider.stat(input, context)), nativeVersionRef: 'someone-else' }),
        'STATE_UNAVAILABLE',
      ],
      [
        'reports a non-integer size',
        async () => ({ nativeVersionRef: undefined, sizeBytes: Number.NaN }),
        'STATE_UNAVAILABLE',
      ],
      [
        'fails',
        async () => {
          throw new Error('storage unavailable token=secret');
        },
        'PROVIDER_UNAVAILABLE',
      ],
    ];
    for (const [label, stat, code] of variants) {
      const { target } = await preUploaded('vouch');
      const strict = new ledger.PostgresReportingLedgerStore(pool, {
        acknowledgeIsolatedDatabase: true,
        rowStorage: { bindings: { objects: binding }, providers: { filesystem: { ...provider, stat } } },
      });
      await strict.readyRowStorage();
      await assert.rejects(
        () => strict.commitAdjustment(adjustmentFor(target), target.fixture.lease),
        error => ledger.isReportingRowStoreError(error) && error.code === code && !/secret/.test(error.message),
        label
      );
      assert.equal(
        await count(`SELECT count(*) AS n FROM adcp_reporting_row_sets WHERE row_set_id = $1`, [target.adjustmentId]),
        0,
        `${label}: no row set is recorded`
      );
    }
  });

  test('a custom provider without stat falls back to reading the whole object under the lock', async () => {
    const { target } = await preUploaded('nostat');
    const { stat: _stat, ...withoutStat } = provider;
    const fallback = new ledger.PostgresReportingLedgerStore(pool, {
      acknowledgeIsolatedDatabase: true,
      rowStorage: { bindings: { objects: binding }, providers: { filesystem: withoutStat } },
    });
    await fallback.readyRowStorage();
    providerCalls = { get: 0, stat: 0 };
    await fallback.commitAdjustment(adjustmentFor(target), target.fixture.lease);
    assert.deepEqual(providerCalls, { get: 2, stat: 0 }, 'adoption read plus the full read under the lock');
    assert.deepEqual(await adjustmentRows(target), current);

    // And it still fails closed when the object is deleted after adoption.
    const other = await preUploaded('nostat_gone');
    afterAdoptedRead = async () => rmSync(other.file);
    await assert.rejects(
      () => fallback.commitAdjustment(adjustmentFor(other.target), other.target.fixture.lease),
      isStateUnavailable
    );
  });

  test('without stat the full read under the lock still refuses bytes that differ from the recorded digest', async () => {
    const { target } = await preUploaded('lying');
    const { stat: _stat, ...withoutStat } = provider;
    let reads = 0;
    const lying = new ledger.PostgresReportingLedgerStore(pool, {
      acknowledgeIsolatedDatabase: true,
      rowStorage: {
        bindings: { objects: binding },
        providers: {
          filesystem: {
            ...withoutStat,
            async get(input, context) {
              const bytes = await withoutStat.get(input, context);
              reads += 1;
              // The adoption read (first) is honest; the read under the commit lock (second) is tampered.
              return reads === 1 || !bytes ? bytes : Buffer.concat([Buffer.from(bytes), Buffer.from('x')]);
            },
          },
        },
      },
    });
    await lying.readyRowStorage();
    await assert.rejects(() => lying.commitAdjustment(adjustmentFor(target), target.fixture.lease), isStateUnavailable);
    assert.equal(reads, 2);
  });
});

describe('reporting compaction with a shared object', { skip: !DATABASE_URL && 'PostgreSQL URL not set' }, () => {
  const schema = `adcp_reporting_shared_compaction_${process.pid}`;
  let bootstrapPool;
  let pool;
  let ledger;
  let root;
  let store;
  const rowsFor = index => (index === 0 ? rows : rows.map(row => ({ ...row, value: row.value + 1000 + index })));

  before(async () => {
    const { Pool } = require('pg');
    ledger = require('./helpers/ledger.js');
    root = mkdtempSync(path.join(tmpdir(), 'adcp-shared-compaction-'));
    bootstrapPool = new Pool({ connectionString: DATABASE_URL });
    await bootstrapPool.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ connectionString: DATABASE_URL, options: `-c search_path="${schema}"` });
    await pool.query(ledger.REPORTING_LEDGER_MIGRATION);
    await pool.query(ledger.REPORTING_ROW_STORAGE_MIGRATION);
    store = new ledger.PostgresReportingLedgerStore(pool, {
      acknowledgeIsolatedDatabase: true,
      rowStorage: {
        bindings: {
          objects: { kind: 'object', provider: 'filesystem', location: { root: 'rows' }, prefix: 'compacted' },
        },
        providers: { filesystem: ledger.createFilesystemReportingRowObjectProviderV1({ roots: { rows: root } }) },
      },
    });
    await store.readyRowStorage();
  });

  after(async () => {
    if (pool) await pool.end();
    if (bootstrapPool) {
      await bootstrapPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await bootstrapPool.end();
    }
    if (root) rmSync(root, { recursive: true, force: true });
  });

  async function chain(suffix) {
    const fixture = await createRowStorageFixture({ store, suffix });
    const ids = [1, 2, 3].map(number => `rrev_${suffix}_${number}`);
    for (const [index, id] of ids.entries()) {
      await store.commitRevision(
        fixture.revision(id, index + 1, rowsFor(index), {
          ...(index > 0 ? { supersedes_reporting_revision_id: ids[index - 1] } : {}),
        }),
        fixture.lease
      );
    }
    await pool.query(
      `UPDATE adcp_reporting_revisions SET created_at = clock_timestamp() - INTERVAL '3 hours'
        WHERE revision_id = $1`,
      [ids[1]]
    );
    await pool.query(
      `UPDATE adcp_reporting_obligations SET state = 'terminal', lease_expires_at = clock_timestamp() - INTERVAL '1 second'
        WHERE obligation_id = $1`,
      [fixture.obligation.reporting_obligation_id]
    );
    return { fixture, ids };
  }

  test('compacting one revision leaves an object another live revision references', async () => {
    const a = await chain('cmp_a');
    const b = await chain('cmp_b');
    // Re-point b's first revision at a's first object, as a minimal key template would have.
    await pool.query(
      `UPDATE adcp_reporting_row_chunks target SET object_ref = source.object_ref, native_version_ref = source.native_version_ref
         FROM adcp_reporting_row_chunks source
        WHERE target.row_set_id = $1 AND source.row_set_id = $2 AND target.chunk_index = source.chunk_index`,
      [b.ids[0], a.ids[0]]
    );
    const shared = (
      await pool.query(`SELECT object_ref FROM adcp_reporting_row_chunks WHERE row_set_id = $1`, [a.ids[0]])
    ).rows[0].object_ref;
    const file = path.join(root, shared);
    assert.ok(existsSync(file));
    const compact = limit =>
      store.compactSupersededSnapshots({ statusRetentionDays: 30, automatedRecoveryWindowSeconds: 300, limit });
    assert.equal((await compact(1)).compacted, 1);
    const states = async () =>
      (
        await pool.query(
          `SELECT row_set_id, rows_state FROM adcp_reporting_row_sets WHERE row_set_id = ANY($1) ORDER BY row_set_id`,
          [[a.ids[0], b.ids[0]]]
        )
      ).rows.map(row => row.rows_state);
    assert.deepEqual(await states(), ['pruned', 'live']);
    assert.ok(existsSync(file), 'the object b still references survives a compaction');
    assert.deepEqual((await store.getRevision(b.ids[0], b.fixture.request.account.account_id)).rows, rows);

    assert.ok((await compact(10)).compacted >= 1);
    assert.deepEqual(await states(), ['pruned', 'pruned']);
    assert.equal(existsSync(file), false, 'the last referencing revision deletes the object');
  });

  const compactAll = () =>
    store.compactSupersededSnapshots({ statusRetentionDays: 30, automatedRecoveryWindowSeconds: 300 });
  const rowSetStates = async ids =>
    (
      await pool.query(`SELECT row_set_id, rows_state FROM adcp_reporting_row_sets WHERE row_set_id = ANY($1)`, [ids])
    ).rows.reduce((byId, row) => ({ ...byId, [row.row_set_id]: row.rows_state }), {});
  const chunkRefs = async rowSetId =>
    (
      await pool.query(`SELECT object_ref FROM adcp_reporting_row_chunks WHERE row_set_id = $1 ORDER BY chunk_index`, [
        rowSetId,
      ])
    ).rows.map(row => row.object_ref);

  test('compaction takes no object lock and holds no connection while the provider deletes', async () => {
    const a = await chain('cmp_nolock');
    const [objectRef] = await chunkRefs(a.ids[0]);
    const holder = await bootstrapPool.connect();
    const held = [];
    const original = store.rowStorage.deleteObjects;
    store.rowStorage.deleteObjects = function (...args) {
      held.push(pool.totalCount - pool.idleCount);
      return original.apply(this, args);
    };
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `adcp-reporting-object:objects:${objectRef}`,
      ]);
      const result = await Promise.race([compactAll(), sleep(5_000).then(() => 'blocked')]);
      assert.notEqual(result, 'blocked', 'compaction does not wait on the object lock');
      assert.ok(result.compacted >= 1);
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
      store.rowStorage.deleteObjects = original;
    }
    assert.equal(existsSync(path.join(root, objectRef)), false);
    assert.ok(held.length > 0 && held.every(connections => connections === 0), `held: ${held}`);
  });

  test('a header-only revision whose predecessor is compacted before its commit fails cleanly and then re-uploads', async () => {
    const a = await chain('cmp_hdr');
    const [r1, , r3] = a.ids;
    const obligationId = a.fixture.obligation.reporting_obligation_id;
    const [sharedObject] = await chunkRefs(r1);
    // The writer holds a live lease while it prepares; compaction runs only once the lease has lapsed.
    const setLease = (state, interval) =>
      pool.query(
        `UPDATE adcp_reporting_obligations SET state = $2, lease_expires_at = clock_timestamp() + $3::interval
          WHERE obligation_id = $1`,
        [obligationId, state, interval]
      );
    await setLease('pending', '10 minutes');
    const pulse = a.fixture.revision('rrev_cmp_hdr_4', 4, rowsFor(0), { supersedes_reporting_revision_id: r3 });

    const original = store.rowStorage.findShareable;
    let compacted = 0;
    store.rowStorage.findShareable = async function (...args) {
      const found = await original.apply(this, args);
      if (found && compacted === 0) {
        // The writer has decided to share r1's chunks. Its lease lapses, compaction deletes r1 and its
        // object, and the lease is held again by the time the commit transaction runs.
        await setLease('terminal', '-1 second');
        compacted = (await compactAll()).compacted;
        await setLease('pending', '10 minutes');
      }
      return found;
    };
    try {
      await assert.rejects(
        () => store.commitRevision(pulse, a.fixture.lease),
        error =>
          ledger.isReportingRowStoreError(error) &&
          error.code === 'STATE_UNAVAILABLE' &&
          /no longer live/.test(error.message)
      );
    } finally {
      store.rowStorage.findShareable = original;
    }
    assert.ok(compacted >= 1, 'compaction ran between the sharing decision and the commit');
    assert.equal((await rowSetStates([r1, 'rrev_cmp_hdr_4']))[r1], 'pruned');
    assert.equal(existsSync(path.join(root, sharedObject)), false, 'the predecessor object was deleted');
    assert.equal((await rowSetStates(['rrev_cmp_hdr_4']))['rrev_cmp_hdr_4'], undefined, 'no row set was committed');
    assert.deepEqual(await chunkRefs('rrev_cmp_hdr_4'), [], 'no chunk row names the deleted object');

    // A retry no longer finds a live predecessor to share, so it uploads its own object and commits.
    assert.equal((await store.commitRevision(pulse, a.fixture.lease)).inserted, true);
    const [ownObject] = await chunkRefs('rrev_cmp_hdr_4');
    assert.ok(existsSync(path.join(root, ownObject)), 'the retry uploaded its own object');
    assert.equal(existsSync(path.join(root, sharedObject)), false, 'the deleted predecessor object stays deleted');
    assert.deepEqual((await store.getRevision('rrev_cmp_hdr_4', a.fixture.request.account.account_id)).rows, rows);
  });
});
