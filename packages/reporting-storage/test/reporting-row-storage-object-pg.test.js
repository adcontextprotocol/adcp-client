/**
 * PostgreSQL integration tests for object-storage revision rows, using the
 * filesystem provider.
 *
 * REPORTING_LEDGER_PG_URL=postgres://localhost/test npm test --workspace=@adcp/reporting-storage -- test/reporting-row-storage-object-pg.test.js
 */
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync, readdirSync, statSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { after, before, describe, test } = require('node:test');

const { createRowStorageFixture } = require('./helpers/reporting-row-storage-fixture.js');

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
    ledger = require('./helpers/ledger.js');
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
      'list',
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
    const { canonicalize } = require('@adcp/sdk');
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
          keyTemplate: '{prefix}/{namespace_key}/{account_key}/{revision_key}/{content_sha256}/{chunk_index}',
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

  test('the conformance runner rejects a list that breaks the contract the orphan collector relies on', async () => {
    const location = { location: { root: 'reports' }, prefix: 'adcp-rows' };
    const real = (input, context) => provider.list(input, context);
    const cases = [
      [
        'a list that ignores the prefix',
        (input, context) => real({ ...input, prefix: 'adcp-rows/' }, context),
        /exactly the objects/,
      ],
      [
        'a list that repeats an object across pages',
        async (input, context) => {
          const page = await real(input, context);
          return { ...page, objects: page.objects.length > 1 ? [page.objects[0], page.objects[0]] : page.objects };
        },
        /twice/,
      ],
      [
        'a list that reports another version',
        async (input, context) => {
          const page = await real(input, context);
          return { ...page, objects: page.objects.map(item => ({ ...item, nativeVersionRef: 'other' })) };
        },
        /native version/,
      ],
      [
        'a list that reports a wrong size',
        async (input, context) => {
          const page = await real(input, context);
          return { ...page, objects: page.objects.map(item => ({ ...item, sizeBytes: item.sizeBytes + 1 })) };
        },
        /wrong size/,
      ],
      [
        'a list that reports no write time',
        async (input, context) => {
          const page = await real(input, context);
          return { ...page, objects: page.objects.map(item => ({ ...item, createdAt: '1970-01-01T00:00:00.000Z' })) };
        },
        /written/,
      ],
      [
        'a list with a sloppy write time',
        async (input, context) => {
          const page = await real(input, context);
          return { ...page, objects: page.objects.map(item => ({ ...item, createdAt: String(Date.now()) })) };
        },
        /written/,
      ],
      [
        'a list that returns more than the page size',
        async (input, context) => {
          const page = await real({ ...input, pageSize: 100 }, context);
          return { objects: page.objects };
        },
        /more objects than pageSize/,
      ],
      [
        'a list that never ends',
        async (input, context) => ({ ...(await real(input, context)), nextPageToken: 'same' }),
        /repeated token|did not finish/,
      ],
      [
        'a list that drops the last object',
        async (input, context) => {
          const page = await real(input, context);
          return { ...page, objects: page.objects.slice(0, -1) };
        },
        /exactly the objects|lost a live one/,
      ],
    ];
    for (const [label, list, expected] of cases) {
      await assert.rejects(
        () => ledger.runReportingRowObjectProviderConformanceV1({ ...provider, list }, location),
        expected,
        label
      );
    }
    const withoutList = { ...provider };
    delete withoutList.list;
    const passed = await ledger.runReportingRowObjectProviderConformanceV1(withoutList, location);
    assert.ok(!passed.includes('list'), 'a provider without list skips the optional check');
  });

  test('every writable binding must include {revision_key}, so no two row sets share an object key', () => {
    for (const keyTemplate of [
      '{prefix}/{namespace_key}/{content_sha256}/{chunk_index}',
      '{prefix}/{namespace_key}/{account_key}/{period_date}/{content_sha256}/{chunk_index}',
    ]) {
      assert.throws(
        () => newStore({ bindings: { objects: objectBinding({ keyTemplate }) } }),
        error =>
          isCode('INVALID_INPUT')(error) && /row binding objects:.*\{revision_key\}.*readOnly/.test(error.message)
      );
    }
    // The default template, and an explicit one with {revision_key}, are accepted.
    newStore();
    newStore({
      bindings: {
        objects: objectBinding({
          keyTemplate: '{prefix}/{namespace_key}/{revision_key}/{content_sha256}/{chunk_index}',
        }),
      },
    });
    assert.ok(ledger.REPORTING_ROW_DEFAULT_KEY_TEMPLATE.includes('{revision_key}'));
    assert.throws(
      () => ledger.assertReportingRowKeyTemplateV1('{prefix}/{namespace_key}/{content_sha256}/{chunk_index}'),
      isCode('INVALID_INPUT')
    );
    ledger.assertReportingRowKeyTemplateV1('{prefix}/{namespace_key}/{content_sha256}/{chunk_index}', {
      requireRevisionKey: false,
    });
  });

  test('rows written under an older template stay readable at their recorded object_ref, through a read-only binding', async () => {
    const legacyTemplate = '{prefix}/{namespace_key}/{content_sha256}/{chunk_index}';
    const writer = newStore();
    await writer.readyRowStorage();
    const fixture = await createRowStorageFixture({ store: writer, suffix: 'legacy_tpl' });
    await writer.commitRevision(fixture.revision('rrev_legacy_tpl', 1, rows.slice(0, 40)), fixture.lease);
    const recorded = (
      await pool.query(
        `SELECT object_ref, native_version_ref FROM adcp_reporting_row_chunks WHERE row_set_id = 'rrev_legacy_tpl'`
      )
    ).rows[0];
    // Model an object written under the older template: a different key layout, same bytes and version
    // (a rename keeps the inode, birth time, mtime and size the filesystem version is made of).
    const legacyRef = recorded.object_ref.replace(/\/[^/]+\/[^/]+\/[^/]+\/([^/]+)\/([^/]+)$/, '/legacy-layout/$1-$2');
    assert.notEqual(legacyRef, recorded.object_ref);
    require('node:fs').mkdirSync(path.dirname(path.join(root, legacyRef)), { recursive: true });
    require('node:fs').renameSync(path.join(root, recorded.object_ref), path.join(root, legacyRef));
    await pool.query(`UPDATE adcp_reporting_row_chunks SET object_ref = $2 WHERE row_set_id = $1`, [
      'rrev_legacy_tpl',
      legacyRef,
    ]);

    // The old template is not accepted for writing, even under a new binding ID.
    assert.throws(
      () =>
        newStore({ bindings: { objects: objectBinding(), legacy: objectBinding({ keyTemplate: legacyTemplate }) } }),
      isCode('INVALID_INPUT')
    );
    // Kept as a read-only binding, it is accepted, registered and never used for new writes.
    const readOnlyBindings = {
      objects: objectBinding(),
      legacy: objectBinding({ keyTemplate: legacyTemplate, readOnly: true }),
    };
    const reader = newStore({ bindings: readOnlyBindings });
    await reader.readyRowStorage();
    await pool.query(
      `UPDATE adcp_reporting_row_sets SET row_binding_id = 'legacy', row_location_version = row_location_version + 1
        WHERE row_set_id = 'rrev_legacy_tpl'`
    );
    const read = await reader.getRevision('rrev_legacy_tpl', fixture.request.account.account_id);
    assert.deepEqual(read.rows, rows.slice(0, 40), 'the recorded object_ref is read, not a re-rendered key');
    assert.deepEqual(
      await reader.readRevisionRows({
        reporting_revision_id: 'rrev_legacy_tpl',
        account_id: fixture.request.account.account_id,
        offset: 10,
        limit: 5,
      }),
      { rows: rows.slice(10, 15), total: 40 }
    );

    const next = await createRowStorageFixture({ store: reader, suffix: 'legacy_tpl_next' });
    await reader.commitRevision(next.revision('rrev_legacy_tpl_next', 1, rows.slice(0, 3)), next.lease);
    const bindingOf = async id =>
      (await pool.query(`SELECT row_binding_id FROM adcp_reporting_row_sets WHERE row_set_id = $1`, [id])).rows[0]
        .row_binding_id;
    assert.equal(await bindingOf('rrev_legacy_tpl_next'), 'objects', 'new row sets go to the writable binding');

    // A write forced onto the read-only binding fails closed, before any intent or object exists, with a code
    // that cannot be mistaken for bad rows.
    const forced = newStore({ bindings: readOnlyBindings, selectRowBinding: () => 'legacy' });
    const again = await createRowStorageFixture({ store: forced, suffix: 'legacy_tpl_forced' });
    const objectsBefore = listFiles(root).length;
    await assert.rejects(
      () => forced.commitRevision(again.revision('rrev_legacy_tpl_forced', 1, rows.slice(0, 3)), again.lease),
      error => isCode('UNSAFE_BINDING')(error) && /read-only/.test(error.message)
    );
    assert.equal(listFiles(root).length, objectsBefore, 'nothing was uploaded');
    assert.equal(
      Number(
        (
          await pool.query(
            `SELECT count(*) AS n FROM adcp_reporting_row_write_intents WHERE row_set_id = 'rrev_legacy_tpl_forced'`
          )
        ).rows[0].n
      ),
      0
    );

    // Retirement still reaches the old object through the read-only binding, by its recorded key.
    await pool.query(
      `UPDATE adcp_reporting_obligations
          SET period_start = period_start - INTERVAL '40 days', period_end = period_end - INTERVAL '40 days',
              created_at = created_at - INTERVAL '40 days', lease_expires_at = clock_timestamp() - INTERVAL '1 second'
        WHERE obligation_id = $1`,
      [fixture.obligation.reporting_obligation_id]
    );
    await pool.query(
      `UPDATE adcp_reporting_revisions SET recorded_at = recorded_at - INTERVAL '40 days' WHERE obligation_id = $1`,
      [fixture.obligation.reporting_obligation_id]
    );
    assert.equal(require('node:fs').existsSync(path.join(root, legacyRef)), true);
    const retired = await reader.retireExpiredPeriods({ statusRetentionDays: 30 });
    assert.ok(retired.retired >= 1, 'the period written under the older template is retired');
    assert.equal(require('node:fs').existsSync(path.join(root, legacyRef)), false, 'its object is deleted');
  });

  test('a read-only binding still has to be a valid template, and nothing else about it is relaxed', () => {
    for (const keyTemplate of [
      '{prefix}/{namespace_key}/{chunk_index}',
      '{prefix}/{namespace_key}/{content_sha256}',
      '{prefix}/{namespace_key}/{content_sha256}/{chunk_index}/{unknown}',
      '{prefix}/{account_key}/{content_sha256}/{chunk_index}',
      '{prefix}/{namespace_key}/../{content_sha256}/{chunk_index}',
    ]) {
      assert.throws(
        () => newStore({ bindings: { legacy: objectBinding({ keyTemplate, readOnly: true }) } }),
        isCode('INVALID_INPUT'),
        keyTemplate
      );
    }
  });

  test('a template cannot be changed under a registered binding ID, and readOnly is not part of the identity', async () => {
    const id = 'identity_check';
    const original = '{prefix}/{namespace_key}/{revision_key}/{content_sha256}/{chunk_index}';
    await newStore({ bindings: { [id]: objectBinding({ keyTemplate: original }) } }).readyRowStorage();
    // Editing the template in place changes the identity digest, so the registered binding refuses it.
    await assert.rejects(
      () =>
        newStore({
          bindings: {
            [id]: objectBinding({
              keyTemplate: '{prefix}/{namespace_key}/{revision_key}/{chunk_index}/{content_sha256}',
            }),
          },
        }).readyRowStorage(),
      isCode('UNSAFE_BINDING')
    );
    // Marking the same definition read-only does not change its identity.
    await newStore({
      bindings: { [id]: objectBinding({ keyTemplate: original, readOnly: true }), other: objectBinding() },
    }).readyRowStorage();
  });

  test('with only read-only object bindings configured, a write names the real problem', async () => {
    const readOnlyOnly = newStore({
      bindings: {
        legacy: objectBinding({
          keyTemplate: '{prefix}/{namespace_key}/{content_sha256}/{chunk_index}',
          readOnly: true,
        }),
      },
    });
    await readOnlyOnly.readyRowStorage();
    const fixture = await createRowStorageFixture({ store: readOnlyOnly, suffix: 'all_read_only' });
    await assert.rejects(
      () => readOnlyOnly.commitRevision(fixture.revision('rrev_all_read_only', 1, rows.slice(0, 3)), fixture.lease),
      error => isCode('UNSAFE_BINDING')(error) && /every binding is readOnly/.test(error.message)
    );
  });

  test('migrateInlineRows into a read-only binding fails instead of quarantining every row', async () => {
    const migrating = newStore({
      bindings: {
        objects: objectBinding(),
        legacy: objectBinding({
          keyTemplate: '{prefix}/{namespace_key}/{content_sha256}/{chunk_index}',
          readOnly: true,
        }),
      },
    });
    await migrating.readyRowStorage();
    // An inline row set to migrate.
    const inline = new ledger.PostgresReportingLedgerStore(pool, { acknowledgeIsolatedDatabase: true });
    const fixture = await createRowStorageFixture({ store: inline, suffix: 'inline_to_read_only' });
    await inline.commitRevision(fixture.revision('rrev_inline_ro', 1, rows.slice(0, 3)), fixture.lease);
    await assert.rejects(
      () => migrating.migrateInlineRows({ bindingId: 'legacy', account_id: fixture.request.account.account_id }),
      error => isCode('UNSAFE_BINDING')(error)
    );
  });

  test('a binding object a host mutates after configuring the store cannot change its template', async () => {
    const mutable = objectBinding();
    const store = newStore({ bindings: { objects: mutable } });
    mutable.keyTemplate = '{prefix}/{namespace_key}/{content_sha256}/{chunk_index}';
    mutable.readOnly = false;
    await store.readyRowStorage();
    const fixture = await createRowStorageFixture({ store, suffix: 'mutated_binding' });
    await store.commitRevision(fixture.revision('rrev_mutated', 1, rows.slice(0, 3)), fixture.lease);
    const { object_ref: ref } = (
      await pool.query(`SELECT object_ref FROM adcp_reporting_row_chunks WHERE row_set_id = 'rrev_mutated'`)
    ).rows[0];
    assert.ok(ref.split('/').length > 5, `the validated default template, with its revision segment, was used: ${ref}`);
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
