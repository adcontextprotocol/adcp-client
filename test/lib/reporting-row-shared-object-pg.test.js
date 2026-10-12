/**
 * PostgreSQL integration tests for external row objects shared between row sets.
 * A custom `keyTemplate` need only include `{content_sha256}` and `{chunk_index}`, and an
 * adjustment's `content_sha256` digests its rows alone, so identical corrections in two
 * obligations map to one object. Every delete path must leave an object another row set still
 * references, and must not leak it once the last reference is gone.
 *
 * REPORTING_LEDGER_PG_URL=postgres://localhost/test node --test test/lib/reporting-row-shared-object-pg.test.js
 */
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { after, before, describe, test } = require('node:test');

const { createRowStorageFixture } = require('../helpers/reporting-row-storage-fixture.js');

process.env.NODE_ENV = 'test';
const DATABASE_URL = process.env.REPORTING_LEDGER_PG_URL;

const MINIMAL_TEMPLATE = '{prefix}/{namespace_key}/{content_sha256}/{chunk_index}';
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
  let providerCalls = { get: 0, stat: 0 };
  let binding;
  let provider;

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
  async function officialObligation(suffix) {
    const fixture = await createRowStorageFixture({ store, suffix });
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

  /** Two obligations, each with an adjustment of identical rows, which share one object. */
  async function sharedPair() {
    sequence += 1;
    current = rows.map(row => ({ ...row, value: row.value + sequence * 100 }));
    const first = await officialObligation(`shared_a${sequence}`);
    const second = await officialObligation(`shared_b${sequence}`);
    await store.commitAdjustment(adjustmentFor(first), first.fixture.lease);
    await store.commitAdjustment(adjustmentFor(second), second.fixture.lease);
    const [chunkA] = await chunksOf(first.adjustmentId);
    const [chunkB] = await chunksOf(second.adjustmentId);
    return { first, second, chunkA, chunkB };
  }

  before(async () => {
    const { Pool } = require('pg');
    ledger = require('../../dist/lib/reporting/ledger/index.js');
    ({ canonicalize } = require('../../dist/lib/utils/jcs.js'));
    root = mkdtempSync(path.join(tmpdir(), 'adcp-shared-objects-'));
    bootstrapPool = new Pool({ connectionString: DATABASE_URL });
    await bootstrapPool.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ connectionString: DATABASE_URL, options: `-c search_path="${schema}"` });
    await pool.query(ledger.REPORTING_LEDGER_MIGRATION);
    await pool.query(ledger.REPORTING_ROW_STORAGE_MIGRATION);
    const base = ledger.createFilesystemReportingRowObjectProviderV1({ roots: { rows: root } });
    // After an adopting writer reads the existing object, run a hook (once): the window between
    // adoption and the writer's ledger commit.
    provider = {
      ...base,
      async stat(input, context) {
        providerCalls.stat += 1;
        return base.stat(input, context);
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
      keyTemplate: MINIMAL_TEMPLATE,
    };
    store = new ledger.PostgresReportingLedgerStore(pool, {
      acknowledgeIsolatedDatabase: true,
      rowStorage: { bindings: { objects: binding }, providers: { filesystem: provider } },
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

  test('two obligations with identical adjustment rows share one object under a minimal template', async () => {
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

  test('a delete waits for the object lock a committing adopter holds', async () => {
    const { first, second, chunkA } = await sharedPair();
    await expire(first);
    const lock = `adcp-reporting-object:objects:${chunkA.object_ref}`;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [lock]);
      const retiring = retire();
      await sleep(400);
      assert.ok(existsSync(fileOf(chunkA)));
      await client.query('COMMIT');
      assert.equal((await retiring).retired, 1);
    } finally {
      client.release();
    }
    assert.ok(existsSync(fileOf(chunkA)), 'the other obligation still references the object');
    assert.deepEqual(await adjustmentRows(second), current);
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

  test('a commit whose adopted object was deleted after adoption fails cleanly and retries', async () => {
    sequence += 1;
    current = rows.map(row => ({ ...row, value: row.value + sequence * 100 }));
    const first = await officialObligation(`race_a${sequence}`);
    const second = await officialObligation(`race_b${sequence}`);
    await store.commitAdjustment(adjustmentFor(first), first.fixture.lease);
    const [chunkA] = await chunksOf(first.adjustmentId);
    await expire(first);

    // The adopter has read the shared object; the only other reference is then retired.
    afterAdoptedRead = async () => {
      assert.equal((await retire()).retired, 1);
    };
    await assert.rejects(
      () => store.commitAdjustment(adjustmentFor(second), second.fixture.lease),
      error => ledger.isReportingRowStoreError(error) && error.code === 'STATE_UNAVAILABLE'
    );
    assert.equal(existsSync(fileOf(chunkA)), false);
    assert.equal(
      await count(`SELECT count(*) AS n FROM adcp_reporting_row_chunks WHERE row_set_id = $1`, [second.adjustmentId]),
      0
    );
    assert.equal((await store.listAdjustments(second.fixture.obligation.reporting_obligation_id)).length, 0);

    // The writer's intent is still open; once it lapses the upload re-creates the object.
    await pool.query(
      `UPDATE adcp_reporting_row_write_intents SET expires_at = clock_timestamp() - INTERVAL '1 minute'
        WHERE row_set_id = $1`,
      [second.adjustmentId]
    );
    await store.commitAdjustment(adjustmentFor(second), second.fixture.lease);
    assert.deepEqual(await adjustmentRows(second), current);
    const [chunkB] = await chunksOf(second.adjustmentId);
    assert.ok(existsSync(fileOf(chunkB)));
  });
  test('the commit proves an adopted object with a version-pinned stat instead of downloading it again', async () => {
    sequence += 1;
    current = rows.map(row => ({ ...row, value: row.value + sequence * 100 }));
    const first = await officialObligation(`stat_a${sequence}`);
    const second = await officialObligation(`stat_b${sequence}`);
    await store.commitAdjustment(adjustmentFor(first), first.fixture.lease);
    providerCalls = { get: 0, stat: 0 };
    await store.commitAdjustment(adjustmentFor(second), second.fixture.lease);
    // One read verifies the adopted bytes before the transaction; the commit itself only stats.
    assert.deepEqual(providerCalls, { get: 1, stat: 1 });
    assert.deepEqual(await adjustmentRows(second), current);
    const [chunkA] = await chunksOf(first.adjustmentId);
    const [chunkB] = await chunksOf(second.adjustmentId);
    assert.equal(chunkB.object_ref, chunkA.object_ref);
    const size = (
      await pool.query(`SELECT size_bytes FROM adcp_reporting_row_chunks WHERE row_set_id = $1`, [second.adjustmentId])
    ).rows[0].size_bytes;
    assert.equal(Number(size), readFileSync(fileOf(chunkB)).byteLength, 'size_bytes is the stored object size');
  });

  test('a commit whose adopted object was replaced at the same key with identical bytes fails the stat', async () => {
    sequence += 1;
    current = rows.map(row => ({ ...row, value: row.value + sequence * 100 }));
    const first = await officialObligation(`swap_a${sequence}`);
    const second = await officialObligation(`swap_b${sequence}`);
    await store.commitAdjustment(adjustmentFor(first), first.fixture.lease);
    const [chunkA] = await chunksOf(first.adjustmentId);
    // After the adopter verified the object, someone deletes it and re-creates identical bytes.
    // The native version differs, so the version-pinned stat finds nothing at the recorded version.
    afterAdoptedRead = async () => {
      const bytes = readFileSync(fileOf(chunkA));
      const before = statSync(fileOf(chunkA));
      rmSync(fileOf(chunkA));
      writeFileSync(fileOf(chunkA), bytes);
      // Coarse kernel timestamps and inode reuse could otherwise reproduce the old version by chance.
      const later = before.mtimeMs / 1000 + 2;
      utimesSync(fileOf(chunkA), later, later);
    };
    providerCalls = { get: 0, stat: 0 };
    await assert.rejects(
      () => store.commitAdjustment(adjustmentFor(second), second.fixture.lease),
      error => ledger.isReportingRowStoreError(error) && error.code === 'STATE_UNAVAILABLE'
    );
    assert.equal(providerCalls.stat, 1, 'the stat, not another check, rejected the commit');
    assert.equal(
      await count(`SELECT count(*) AS n FROM adcp_reporting_row_chunks WHERE row_set_id = $1`, [second.adjustmentId]),
      0
    );
    assert.equal(
      await count(`SELECT count(*) AS n FROM adcp_reporting_row_sets WHERE row_set_id = $1`, [second.adjustmentId]),
      0
    );
    assert.equal((await store.listAdjustments(second.fixture.obligation.reporting_obligation_id)).length, 0);
    assert.ok(existsSync(fileOf(chunkA)), 'the replacement object is left alone');
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
      sequence += 1;
      current = rows.map(row => ({ ...row, value: row.value + sequence * 100 }));
      const first = await officialObligation(`vouch_a${sequence}`);
      const second = await officialObligation(`vouch_b${sequence}`);
      await store.commitAdjustment(adjustmentFor(first), first.fixture.lease);
      const strict = new ledger.PostgresReportingLedgerStore(pool, {
        acknowledgeIsolatedDatabase: true,
        rowStorage: { bindings: { objects: binding }, providers: { filesystem: { ...provider, stat } } },
      });
      await strict.readyRowStorage();
      await assert.rejects(
        () => strict.commitAdjustment(adjustmentFor(second), second.fixture.lease),
        error => ledger.isReportingRowStoreError(error) && error.code === code && !/secret/.test(error.message),
        label
      );
      assert.equal(
        await count(`SELECT count(*) AS n FROM adcp_reporting_row_sets WHERE row_set_id = $1`, [second.adjustmentId]),
        0,
        `${label}: no row set is recorded`
      );
    }
  });

  test('a custom provider without stat falls back to reading the whole object under the lock', async () => {
    sequence += 1;
    current = rows.map(row => ({ ...row, value: row.value + sequence * 100 }));
    const first = await officialObligation(`nostat_a${sequence}`);
    const second = await officialObligation(`nostat_b${sequence}`);
    await store.commitAdjustment(adjustmentFor(first), first.fixture.lease);
    const { stat: _stat, ...withoutStat } = provider;
    const fallback = new ledger.PostgresReportingLedgerStore(pool, {
      acknowledgeIsolatedDatabase: true,
      rowStorage: { bindings: { objects: binding }, providers: { filesystem: withoutStat } },
    });
    await fallback.readyRowStorage();
    providerCalls = { get: 0, stat: 0 };
    await fallback.commitAdjustment(adjustmentFor(second), second.fixture.lease);
    assert.deepEqual(providerCalls, { get: 2, stat: 0 }, 'adoption read plus the full read under the lock');
    assert.deepEqual(await adjustmentRows(second), current);

    // And it still fails closed when the object is deleted after adoption.
    const third = await officialObligation(`nostat_c${sequence}`);
    const [chunkA] = await chunksOf(first.adjustmentId);
    afterAdoptedRead = async () => rmSync(fileOf(chunkA));
    await assert.rejects(
      () => fallback.commitAdjustment(adjustmentFor(third), third.fixture.lease),
      error => ledger.isReportingRowStoreError(error) && error.code === 'STATE_UNAVAILABLE'
    );
  });
  test('without stat the full read under the lock still refuses bytes that differ from the recorded digest', async () => {
    sequence += 1;
    current = rows.map(row => ({ ...row, value: row.value + sequence * 100 }));
    const first = await officialObligation(`lying_a${sequence}`);
    const second = await officialObligation(`lying_b${sequence}`);
    await store.commitAdjustment(adjustmentFor(first), first.fixture.lease);
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
    await assert.rejects(
      () => lying.commitAdjustment(adjustmentFor(second), second.fixture.lease),
      error => ledger.isReportingRowStoreError(error) && error.code === 'STATE_UNAVAILABLE'
    );
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
    ledger = require('../../dist/lib/reporting/ledger/index.js');
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
});
