/**
 * PostgreSQL integration tests for object-storage revision rows, using the
 * filesystem provider.
 *
 * REPORTING_LEDGER_PG_URL=postgres://localhost/test node --test test/lib/reporting-row-storage-object-pg.test.js
 */
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync, readdirSync, statSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { after, before, describe, test } = require('node:test');

const { createRowStorageFixture } = require('../helpers/reporting-row-storage-fixture.js');

const DATABASE_URL = process.env.REPORTING_LEDGER_PG_URL;

function listFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(full));
    else files.push(full);
  }
  return files;
}

describe('object-storage revision rows', { skip: !DATABASE_URL && 'PostgreSQL URL not set' }, () => {
  const schema = `adcp_reporting_rows_obj_${process.pid}`;
  let bootstrapPool;
  let pool;
  let ledger;
  let root;
  let provider;
  const rows = Array.from({ length: 1_100 }, (_, index) => ({
    ordinal: index,
    label: `row-${index}`,
    value: index * 2,
  }));
  const isCode = code => error => ledger.isReportingRowStoreError(error) && error.code === code;

  const objectBinding = (overrides = {}) => ({
    kind: 'object',
    provider: 'filesystem',
    location: { root: 'reports' },
    prefix: 'adcp-rows',
    ...overrides,
  });

  const newStore = (rowStorage = {}) =>
    new ledger.PostgresReportingLedgerStore(pool, {
      acknowledgeIsolatedDatabase: true,
      rowStorage: {
        bindings: { objects: objectBinding() },
        providers: { filesystem: provider },
        ...rowStorage,
      },
    });

  before(async () => {
    const { Pool } = require('pg');
    ledger = require('../../dist/lib/reporting/ledger/index.js');
    root = mkdtempSync(path.join(tmpdir(), 'adcp-rows-'));
    provider = ledger.createFilesystemReportingRowObjectProviderV1({ roots: { reports: root } });
    bootstrapPool = new Pool({ connectionString: DATABASE_URL });
    await bootstrapPool.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ connectionString: DATABASE_URL, options: `-c search_path="${schema}"` });
    await pool.query(ledger.REPORTING_LEDGER_MIGRATION);
    await pool.query(ledger.REPORTING_ROW_STORAGE_MIGRATION);
  });

  after(async () => {
    if (pool) await pool.end();
    if (bootstrapPool) {
      await bootstrapPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await bootstrapPool.end();
    }
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test('the filesystem provider passes the shared provider conformance', async () => {
    const passed = await ledger.runReportingRowObjectProviderConformanceV1(provider, {
      location: { root: 'reports' },
      prefix: 'conformance',
    });
    assert.deepEqual(passed, [
      'probe',
      'create',
      'create-only',
      'ranged-read',
      'version-pinned-read',
      'version-pinned-stat',
      'exact-version-delete',
      'write-unique-version',
    ]);
  });

  test('uploads create-only gzip objects, closes the intent and serves verified pages', async () => {
    const store = newStore();
    await store.readyRowStorage();
    const fixture = await createRowStorageFixture({ store, suffix: 'objects' });
    const first = fixture.revision('rrev_obj_1', 1, rows);
    const committed = await store.commitRevision(first, fixture.lease);
    assert.equal(committed.inserted, true);
    assert.deepEqual(committed.value.rows, rows);

    const objects = listFiles(root).filter(file => !file.includes(`${path.sep}conformance${path.sep}`));
    assert.equal(objects.length, 1);
    assert.match(objects[0], /\.jsonl\.gz$/);
    assert.ok(!objects[0].includes(fixture.request.account.account_id), 'object keys never carry raw account IDs');
    const chunk = (
      await pool.query(`SELECT object_ref, compression FROM adcp_reporting_row_chunks WHERE row_set_id = 'rrev_obj_1'`)
    ).rows[0];
    assert.equal(chunk.compression, 'gzip');
    assert.ok(chunk.object_ref.startsWith('adcp-rows/'));
    const sizes = (
      await pool.query(
        `SELECT chunk.size_bytes, chunk.canonical_size_bytes, row_set.content_size_bytes
           FROM adcp_reporting_row_chunks chunk JOIN adcp_reporting_row_sets row_set USING (row_set_id)
          WHERE chunk.row_set_id = 'rrev_obj_1'`
      )
    ).rows[0];
    assert.equal(Number(sizes.size_bytes), statSync(objects[0]).size, 'size_bytes is the stored (gzip) object size');
    assert.ok(
      Number(sizes.canonical_size_bytes) > Number(sizes.size_bytes),
      'canonical_size_bytes is the larger uncompressed size'
    );
    assert.ok(Number(sizes.content_size_bytes) > Number(sizes.canonical_size_bytes), 'the binding adds the envelope');
    assert.equal(Number((await pool.query('SELECT count(*) AS n FROM adcp_reporting_row_write_intents')).rows[0].n), 0);
    assert.equal(Number((await pool.query('SELECT count(*) AS n FROM adcp_reporting_chunk_bodies')).rows[0].n), 0);

    const filesBeforeReplay = listFiles(root).length;
    const replay = await store.commitRevision(first, fixture.lease);
    assert.equal(replay.inserted, false);
    assert.equal(listFiles(root).length, filesBeforeReplay, 'a replay never uploads again');

    assert.deepEqual((await store.getRevision('rrev_obj_1', fixture.request.account.account_id)).rows, rows);
    assert.deepEqual(
      await store.readRevisionRows({
        reporting_revision_id: 'rrev_obj_1',
        account_id: fixture.request.account.account_id,
        offset: 480,
        limit: 60,
      }),
      { rows: rows.slice(480, 540), total: rows.length }
    );

    // An unchanged pulse becomes a header-only revision: new identity and
    // binding, the same stored objects, nothing uploaded.
    const filesBeforePulse = listFiles(root).length;
    const pulse = fixture.revision('rrev_obj_2', 2, rows, { supersedes_reporting_revision_id: 'rrev_obj_1' });
    assert.equal((await store.commitRevision(pulse, fixture.lease)).inserted, true);
    assert.equal(listFiles(root).length, filesBeforePulse, 'a header-only revision uploads nothing');
    const sharedRow = (
      await pool.query(
        `SELECT row_set.rows_shared_from_row_set_id AS shared, chunk.object_ref
           FROM adcp_reporting_row_sets row_set
           JOIN adcp_reporting_row_chunks chunk ON chunk.row_set_id = row_set.row_set_id
          WHERE row_set.row_set_id = 'rrev_obj_2'`
      )
    ).rows[0];
    assert.equal(sharedRow.shared, 'rrev_obj_1');
    assert.equal(sharedRow.object_ref, chunk.object_ref);
    assert.deepEqual((await store.getRevision('rrev_obj_2', fixture.request.account.account_id)).rows, rows);
    assert.equal(Number((await pool.query('SELECT count(*) AS n FROM adcp_reporting_row_write_intents')).rows[0].n), 0);

    // Another store instance with the same configuration reads the same objects.
    const reader = newStore();
    assert.deepEqual((await reader.getRevision('rrev_obj_1', fixture.request.account.account_id)).rows, rows);

    // A store without the binding configured cannot be redirected by database state.
    const unconfigured = new ledger.PostgresReportingLedgerStore(pool, { acknowledgeIsolatedDatabase: true });
    await assert.rejects(
      () => unconfigured.getRevision('rrev_obj_1', fixture.request.account.account_id),
      isCode('STATE_UNAVAILABLE')
    );

    // Stored bytes that differ from the recorded physical digest fail
    // integrity; a removed object is unavailable.
    const target = objects[0];
    const recorded = (
      await pool.query(`SELECT physical_sha256 FROM adcp_reporting_row_chunks WHERE row_set_id = 'rrev_obj_1'`)
    ).rows[0].physical_sha256;
    await pool.query(`UPDATE adcp_reporting_row_chunks SET physical_sha256 = $1 WHERE row_set_id = 'rrev_obj_1'`, [
      'f'.repeat(64),
    ]);
    await assert.rejects(
      () => store.getRevision('rrev_obj_1', fixture.request.account.account_id),
      isCode('ROWS_INTEGRITY_FAILED')
    );
    await pool.query(`UPDATE adcp_reporting_row_chunks SET physical_sha256 = $1 WHERE row_set_id = 'rrev_obj_1'`, [
      recorded,
    ]);
    assert.deepEqual((await store.getRevision('rrev_obj_1', fixture.request.account.account_id)).rows, rows);
    rmSync(target);
    await assert.rejects(
      () => store.getRevision('rrev_obj_1', fixture.request.account.account_id),
      isCode('ROWS_UNAVAILABLE')
    );
    await assert.rejects(
      () => store.getRevision('rrev_obj_2', fixture.request.account.account_id),
      isCode('ROWS_UNAVAILABLE'),
      "a header-only revision shares its predecessor's objects"
    );
    const deliver = ledger.createReportingDeliveryHandler(store);
    await assert.rejects(
      () =>
        deliver(
          { account: fixture.request.account, reporting_revision_id: 'rrev_obj_1' },
          { account: { account_id: fixture.request.account.account_id } }
        ),
      error => error.code === 'SERVICE_UNAVAILABLE'
    );
  });

  test('refuses an upload the lease cannot cover', async () => {
    const store = newStore();
    await store.readyRowStorage();
    const fixture = await createRowStorageFixture({ store, suffix: 'short_lease', leaseMilliseconds: 10_000 });
    await assert.rejects(
      () => store.commitRevision(fixture.revision('rrev_short', 1, rows.slice(0, 10)), fixture.lease),
      isCode('DEADLINE_EXCEEDED')
    );
    assert.equal(
      Number(
        (await pool.query(`SELECT count(*) AS n FROM adcp_reporting_revisions WHERE revision_id = 'rrev_short'`))
          .rows[0].n
      ),
      0
    );
  });

  test('adopts identical bytes and refuses different bytes at a planned key', async () => {
    const engine = new ledger.ReportingRowStorageV1(pool, {
      bindings: { objects: objectBinding({ compression: 'none' }) },
      providers: { filesystem: provider },
    });
    const sample = rows.slice(0, 20);
    const { canonicalize } = require('../../dist/lib/utils/jcs.js');
    const { createHash } = require('node:crypto');
    const bytes = Buffer.from(canonicalize(sample));
    const prepared = await engine.prepare({
      rowSetId: 'radj_engine',
      rowSetKind: 'adjustment',
      accountId: 'acct_engine',
      obligationId: 'robl_engine',
      rows: sample,
      binding: {
        sha256: createHash('sha256').update(bytes).digest('hex'),
        byteCount: bytes.byteLength,
        rowCount: sample.length,
      },
    });
    const key = path.join(root, prepared.objects[0].objectRef);
    require('node:fs').mkdirSync(path.dirname(key), { recursive: true });
    writeFileSync(key, prepared.encoded.chunks[0].bytes);
    const created = [];
    const adopted = await engine.upload(prepared, 'intent-adopt', async object => created.push(object));
    assert.deepEqual(created, [], 'adopted objects are never recorded as created');
    assert.equal(adopted[0].created, false);

    rmSync(key);
    writeFileSync(key, Buffer.from('{"different":true}\n'));
    await assert.rejects(() => engine.upload(prepared, 'intent-conflict', async () => {}), isCode('CONTENT_CONFLICT'));
  });

  test('renders {period_date} as the period start in its source timezone, not in UTC', async () => {
    const store = newStore();
    await store.readyRowStorage();
    const objectRefOf = async rowSetId =>
      (await pool.query(`SELECT object_ref FROM adcp_reporting_row_chunks WHERE row_set_id = $1`, [rowSetId])).rows[0]
        .object_ref;
    const cases = [
      // 07:00Z is local midnight in Los Angeles (PDT): the UTC date and the local date agree.
      { suffix: 'tz_la', zone: 'America/Los_Angeles', start: '2026-10-02T07:00:00.000Z', date: '2026-10-02' },
      // One second earlier is still 2026-10-01 in Los Angeles, though the UTC date is already 2026-10-02.
      { suffix: 'tz_la_before', zone: 'America/Los_Angeles', start: '2026-10-02T06:59:59.000Z', date: '2026-10-01' },
      // 15:00Z on 2026-10-01 is already 2026-10-02 00:00 in Tokyo, a day ahead of the UTC date.
      { suffix: 'tz_tokyo', zone: 'Asia/Tokyo', start: '2026-10-01T15:00:00.000Z', date: '2026-10-02' },
      { suffix: 'tz_utc', zone: 'UTC', start: '2026-10-01T15:00:00.000Z', date: '2026-10-01' },
    ];
    for (const { suffix, zone, start, date } of cases) {
      const end = new Date(Date.parse(start) + 86_400_000).toISOString();
      const fixture = await createRowStorageFixture({
        store,
        suffix,
        sourceTimezone: zone,
        periodStart: start,
        periodEnd: end,
      });
      const id = `rrev_${suffix}`;
      await store.commitRevision(fixture.revision(id, 1, rows.slice(0, 3)), fixture.lease);
      const objectRef = await objectRefOf(id);
      assert.ok(
        objectRef.split('/').includes(date),
        `${zone} period starting ${start} is dated ${date} in ${objectRef}`
      );
      assert.ok(!/\/\d{4}\/\d{2}\/\d{2}\//.test(objectRef), 'the date is one YYYY-MM-DD path segment');
    }
  });

  test('refuses to render {period_date} for an unusable source timezone and uploads nothing', async () => {
    const store = newStore();
    await store.readyRowStorage();
    const before = listFiles(root).length;
    const fixture = await createRowStorageFixture({ store, suffix: 'tz_bad', sourceTimezone: 'Mars/Olympus_Mons' });
    await assert.rejects(
      () => store.commitRevision(fixture.revision('rrev_tz_bad', 1, rows.slice(0, 3)), fixture.lease),
      isCode('INVALID_INPUT')
    );
    assert.equal(listFiles(root).length, before, 'no object is written under a guessed date');
    assert.equal(
      Number(
        (await pool.query(`SELECT count(*) AS n FROM adcp_reporting_row_sets WHERE row_set_id = 'rrev_tz_bad'`)).rows[0]
          .n
      ),
      0
    );
  });

  test('a template without {period_date} needs no source timezone', async () => {
    const store = newStore({
      bindings: {
        no_date: objectBinding({
          keyTemplate: '{prefix}/{namespace_key}/{account_key}/{content_sha256}/{chunk_index}',
        }),
      },
    });
    await store.readyRowStorage();
    const fixture = await createRowStorageFixture({ store, suffix: 'tz_unused', sourceTimezone: 'Mars/Olympus_Mons' });
    assert.equal(
      (await store.commitRevision(fixture.revision('rrev_tz_unused', 1, rows.slice(0, 3)), fixture.lease)).inserted,
      true
    );
  });

  test('the conformance runner rejects a stat that cannot prove one exact version', async () => {
    const location = { location: { root: 'reports' }, prefix: 'adcp-rows' };
    const cases = [
      [
        'a stat that ignores the version pin',
        async input => ({ nativeVersionRef: input.nativeVersionRef, sizeBytes: 16 }),
        /version that does not exist/,
      ],
      [
        'a stat that reports the wrong size',
        async (input, context) => {
          const found = await provider.stat(input, context);
          return found && { ...found, sizeBytes: found.sizeBytes + 1 };
        },
        /stored object size/,
      ],
      [
        'a stat that does not echo the version it checked',
        async (input, context) => {
          const found = await provider.stat(input, context);
          return found && { ...found, nativeVersionRef: 'other' };
        },
        /echo/,
      ],
    ];
    for (const [label, stat, expected] of cases) {
      await assert.rejects(
        () => ledger.runReportingRowObjectProviderConformanceV1({ ...provider, stat }, location),
        expected,
        label
      );
    }
    const withoutStat = { ...provider };
    delete withoutStat.stat;
    const passed = await ledger.runReportingRowObjectProviderConformanceV1(withoutStat, location);
    assert.ok(!passed.includes('version-pinned-stat'), 'a provider without stat skips the optional check');
  });

  test('validates bindings before any write', async () => {
    assert.throws(
      () => newStore({ bindings: { objects: objectBinding({ provider: 'missing' }) } }),
      isCode('INVALID_INPUT')
    );
    assert.throws(
      () =>
        newStore({ bindings: { objects: objectBinding({ keyTemplate: '{prefix}/{account_key}/{content_sha256}' }) } }),
      isCode('INVALID_INPUT')
    );
    assert.throws(
      () => newStore({ bindings: { objects: objectBinding({ prefix: '../escape' }) } }),
      isCode('INVALID_INPUT')
    );
    assert.throws(
      () => newStore({ bindings: { objects: objectBinding({ location: { root: 'reports', path: '/etc' } }) } }),
      isCode('INVALID_INPUT')
    );
    const moved = newStore({ bindings: { objects: objectBinding({ prefix: 'elsewhere' }) } });
    await assert.rejects(() => moved.readyRowStorage(), isCode('UNSAFE_BINDING'));
  });
});
