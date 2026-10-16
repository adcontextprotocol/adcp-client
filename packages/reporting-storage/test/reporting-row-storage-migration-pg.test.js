/**
 * PostgreSQL integration tests for the reporting row-storage migration.
 *
 * REPORTING_LEDGER_PG_URL=postgres://localhost/test npm test --workspace=@adcp/reporting-storage -- test/reporting-row-storage-migration-pg.test.js
 */
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { after, before, describe, test } = require('node:test');

const DATABASE_URL = process.env.REPORTING_LEDGER_PG_URL;

describe('REPORTING_ROW_STORAGE_MIGRATION', { skip: !DATABASE_URL && 'PostgreSQL URL not set' }, () => {
  const schema = `adcp_reporting_row_storage_test_${process.pid}`;
  let bootstrapPool;
  let pool;
  let ledger;

  const hex = value => createHash('sha256').update(value).digest('hex');

  before(async () => {
    const { Pool } = require('pg');
    ledger = require('./helpers/ledger.js');
    bootstrapPool = new Pool({ connectionString: DATABASE_URL });
    await bootstrapPool.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ connectionString: DATABASE_URL, options: `-c search_path="${schema}"` });
    await pool.query(ledger.REPORTING_LEDGER_MIGRATION);
  });

  after(async () => {
    if (pool) await pool.end();
    if (bootstrapPool) {
      await bootstrapPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await bootstrapPool.end();
    }
  });

  test('probe fails closed before the migration and is idempotent after it', async () => {
    await assert.rejects(() => ledger.probeReportingRowStorageSchemaV1(pool), /REPORTING_ROW_STORAGE_MIGRATION/);
    await pool.query(ledger.REPORTING_ROW_STORAGE_MIGRATION);
    const first = await ledger.probeReportingRowStorageSchemaV1(pool);
    await pool.query(ledger.REPORTING_ROW_STORAGE_MIGRATION);
    const second = await ledger.probeReportingRowStorageSchemaV1(pool);
    assert.match(first.installationId, /^[0-9a-f-]{36}$/);
    assert.equal(second.installationId, first.installationId, 'reapplying preserves the installation identity');
  });

  test('enforces immutability and digest checks', async () => {
    await pool.query(
      `INSERT INTO adcp_reporting_configurations
         (configuration_id, account_id, delivery_config_id, delivery_config_version, semantic_fingerprint, data, created_at)
       VALUES ('cfg_rows', 'acct_rows', 'dc_rows', 1, 'f', '{}'::jsonb, clock_timestamp())`
    );
    await pool.query(
      `INSERT INTO adcp_reporting_obligations
         (obligation_id, configuration_id, account_id, period_ordinal, period_start, period_end, next_attempt_at,
          state, semantic_fingerprint, data, created_at)
       VALUES ('robl_rows', 'cfg_rows', 'acct_rows', 0, '2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z',
               clock_timestamp(), 'pending', 'f', '{}'::jsonb, clock_timestamp())`
    );
    await pool.query(
      `INSERT INTO adcp_reporting_row_bindings
         (row_binding_id, kind, provider, identity_config, identity_sha256, namespace_key)
       VALUES ('postgres', 'postgres', 'postgres', '{}'::jsonb, $1, $2)`,
      ['a'.repeat(64), 'b'.repeat(64)]
    );
    await assert.rejects(
      () => pool.query(`UPDATE adcp_reporting_row_bindings SET provider = 'gcs' WHERE row_binding_id = 'postgres'`),
      /binding identity is immutable/
    );
    await pool.query(`UPDATE adcp_reporting_row_bindings SET state = 'read_only' WHERE row_binding_id = 'postgres'`);

    const body = Buffer.from('{"a":1}\n');
    await assert.rejects(
      () =>
        pool.query(
          `INSERT INTO adcp_reporting_chunk_bodies (account_id, obligation_id, sha256, body) VALUES ('acct_rows', 'robl_rows', $1, $2)`,
          ['c'.repeat(64), body]
        ),
      /check constraint/
    );
    await pool.query(
      `INSERT INTO adcp_reporting_chunk_bodies (account_id, obligation_id, sha256, body) VALUES ('acct_rows', 'robl_rows', $1, $2)`,
      [hex(body), body]
    );
    await assert.rejects(
      () => pool.query(`UPDATE adcp_reporting_chunk_bodies SET body = body`),
      /chunk bodies are immutable/
    );

    await pool.query(
      `INSERT INTO adcp_reporting_row_sets
         (row_set_id, row_set_kind, account_id, obligation_id, format, algorithm, digest_profile, content_sha256,
          content_size_bytes, row_count, row_manifest_sha256, chunk_count, row_binding_id)
       VALUES ('rrev_rows', 'revision', 'acct_rows', 'robl_rows', 'jsonl', 'adcp_jcs_rows_v1', 'revision_envelope_v1',
               $1, 80, 1, $2, 1, 'postgres')`,
      ['d'.repeat(64), 'e'.repeat(64)]
    );
    await pool.query(
      `INSERT INTO adcp_reporting_row_chunks
         (row_set_id, chunk_index, account_id, obligation_id, first_ordinal, row_count, canonical_size_bytes, sha256, segments)
       VALUES ('rrev_rows', 0, 'acct_rows', 'robl_rows', 0, 1, $1, $2, '[]'::jsonb)`,
      [body.byteLength, hex(body)]
    );
    await assert.rejects(
      () =>
        pool.query(
          `INSERT INTO adcp_reporting_row_chunks
             (row_set_id, chunk_index, account_id, obligation_id, first_ordinal, row_count, canonical_size_bytes, sha256, segments)
           VALUES ('rrev_rows', 1, 'acct_other', 'robl_rows', 1, 1, $1, $2, '[]'::jsonb)`,
          [body.byteLength, hex(body)]
        ),
      /foreign key/,
      'a chunk can never name another account than its row set'
    );
    await assert.rejects(
      () =>
        pool.query(
          `INSERT INTO adcp_reporting_row_sets
             (row_set_id, row_set_kind, account_id, obligation_id, format, algorithm, digest_profile, content_sha256,
              content_size_bytes, row_count, row_manifest_sha256, chunk_count, row_binding_id,
              rows_shared_from_row_set_id)
           VALUES ('rrev_foreign_share', 'revision', 'acct_other', 'robl_rows', 'jsonl',
                   'adcp_jcs_rows_v1', 'revision_envelope_v1', $1, 80, 1, $2, 1, 'postgres', 'rrev_rows')`,
          ['d'.repeat(64), 'e'.repeat(64)]
        ),
      /foreign key/,
      'a header-only revision can only share rows within its own account and obligation'
    );
    await assert.rejects(
      () => pool.query(`UPDATE adcp_reporting_row_sets SET row_count = 2`),
      /row set content is immutable/
    );
    await assert.rejects(
      () => pool.query(`UPDATE adcp_reporting_row_chunks SET sha256 = $1`, ['f'.repeat(64)]),
      /row chunk content is immutable/
    );
    await pool.query(
      `UPDATE adcp_reporting_row_sets SET rows_state = 'pruning', rows_state_changed_at = clock_timestamp()`
    );
    await assert.rejects(
      () =>
        pool.query(
          `UPDATE adcp_reporting_row_chunks SET object_ref = 'k', native_version_ref = '1', physical_sha256 = $1`,
          ['f'.repeat(64)]
        ),
      /check constraint/,
      'object locations are all-or-nothing'
    );
    await assert.rejects(
      () =>
        pool.query(
          `INSERT INTO adcp_reporting_row_sets
             (row_set_id, row_set_kind, account_id, obligation_id, format, algorithm, digest_profile, content_sha256,
              content_size_bytes, row_count, row_manifest_sha256, chunk_count, row_binding_id)
           VALUES ('rrev_empty', 'revision', 'acct_rows', 'robl_rows', 'jsonl',
                   'adcp_jcs_rows_v1', 'revision_envelope_v1', $1, 80, 0, $2, 1, 'postgres')`,
          ['d'.repeat(64), 'e'.repeat(64)]
        ),
      /check constraint/,
      'an empty row set has no chunks'
    );
  });

  const seedObligation = async queryable => {
    await queryable.query(
      `INSERT INTO adcp_reporting_configurations
         (configuration_id, account_id, delivery_config_id, delivery_config_version, semantic_fingerprint, data, created_at)
       VALUES ('cfg_rows', 'acct_rows', 'dc_rows', 1, 'f', '{}'::jsonb, clock_timestamp())`
    );
    await queryable.query(
      `INSERT INTO adcp_reporting_obligations
         (obligation_id, configuration_id, account_id, period_ordinal, period_start, period_end, next_attempt_at,
          state, semantic_fingerprint, data, created_at)
       VALUES ('robl_rows', 'cfg_rows', 'acct_rows', 0, '2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z',
               clock_timestamp(), 'pending', 'f', '{}'::jsonb, clock_timestamp())`
    );
  };

  test('row sets pin the AdCP format and algorithm', async () => {
    const insert = (id, format, algorithm) =>
      pool.query(
        `INSERT INTO adcp_reporting_row_sets
           (row_set_id, row_set_kind, account_id, obligation_id, format, algorithm, digest_profile, content_sha256,
            content_size_bytes, row_count, row_manifest_sha256, chunk_count, row_binding_id)
         VALUES ($1, 'revision', 'acct_rows', 'robl_rows', $2, $3, 'revision_envelope_v1', $4, 80, 1, $5, 1, 'postgres')`,
        [id, format, algorithm, 'd'.repeat(64), 'e'.repeat(64)]
      );
    await assert.rejects(
      () => insert('rrev_old_token', 'adcp_canonical_jsonl_v1', 'adcp_jcs_rows_v1'),
      /check constraint/
    );
    await assert.rejects(() => insert('rrev_csv', 'csv', 'adcp_jcs_rows_v1'), /check constraint/);
    await assert.rejects(() => insert('rrev_algorithm', 'jsonl', 'adcp_canonical_jsonl_v1'), /check constraint/);
    await insert('rrev_adcp_tokens', 'jsonl', 'adcp_jcs_rows_v1');
  });

  test('object_ref, native_version_ref and size_bytes follow the AdCP bounds', async () => {
    const insert = (index, objectRef, nativeVersionRef, sizeBytes = 10) =>
      pool.query(
        `INSERT INTO adcp_reporting_row_chunks
           (row_set_id, chunk_index, account_id, obligation_id, first_ordinal, row_count, canonical_size_bytes, sha256,
            segments, object_ref, native_version_ref, compression, physical_sha256, size_bytes)
         VALUES ('rrev_rows', $1::integer, 'acct_rows', 'robl_rows', $1::bigint, 1, 10, $2, '[]'::jsonb, $3, $4, 'none', $2, $5)`,
        [index, 'a'.repeat(64), objectRef, nativeVersionRef, sizeBytes]
      );
    await insert(10, 'k'.repeat(1024), 'v'.repeat(1024));
    await assert.rejects(() => insert(11, 'k'.repeat(1025), '1'), /adcp_reporting_row_chunks_object_ref_bounds/);
    await assert.rejects(() => insert(12, '', '1'), /adcp_reporting_row_chunks_object_ref_bounds/);
    await assert.rejects(
      () => insert(13, 'k', 'v'.repeat(1025)),
      /adcp_reporting_row_chunks_native_version_ref_bounds/
    );
    await assert.rejects(() => insert(14, 'k', ''), /adcp_reporting_row_chunks_native_version_ref_bounds/);
    await assert.rejects(() => insert(15, 'k', '1', 0), /check constraint/);
    // Characters, not bytes, when the database stores UTF-8: 1024 multi-byte characters fit AdCP's maxLength.
    // (A SQL_ASCII database counts bytes, which is stricter; rendered keys are ASCII either way.)
    if ((await pool.query('SHOW server_encoding')).rows[0].server_encoding === 'UTF8') {
      await insert(16, 'é'.repeat(1024), '1');
    }
  });

  describe('upgrading a database installed before AdCP field alignment', () => {
    const legacySchema = `adcp_reporting_row_storage_legacy_${process.pid}`;
    let legacy;

    before(async () => {
      await bootstrapPool.query(`CREATE SCHEMA "${legacySchema}"`);
      legacy = new (require('pg').Pool)({
        connectionString: DATABASE_URL,
        options: `-c search_path="${legacySchema}"`,
      });
      await legacy.query(ledger.REPORTING_LEDGER_MIGRATION);
      const sql = readFileSync(path.join(__dirname, 'fixtures', 'reporting-row-storage-migration-15.8.sql'), 'utf8');
      await legacy.query(sql);
      await seedObligation(legacy);
      await legacy.query(
        `INSERT INTO adcp_reporting_row_bindings
           (row_binding_id, kind, provider, identity_config, identity_sha256, namespace_key)
         VALUES ('objects', 'object', 'gcs', '{}'::jsonb, $1, $2)`,
        ['a'.repeat(64), 'b'.repeat(64)]
      );
      await legacy.query(
        `INSERT INTO adcp_reporting_row_sets
           (row_set_id, row_set_kind, account_id, obligation_id, encoding, digest_profile, content_sha256,
            canonical_byte_count, row_count, row_manifest_sha256, chunk_count, row_binding_id)
         VALUES ('rrev_legacy', 'revision', 'acct_rows', 'robl_rows', 'adcp_canonical_jsonl_v1',
                 'revision_envelope_v1', $1, 80, 1, $2, 1, 'objects')`,
        ['d'.repeat(64), 'e'.repeat(64)]
      );
      await legacy.query(
        `INSERT INTO adcp_reporting_row_chunks
           (row_set_id, chunk_index, account_id, obligation_id, first_ordinal, row_count, byte_count, sha256, segments,
            object_key, native_version, compression, physical_sha256, physical_byte_count)
         VALUES ('rrev_legacy', 0, 'acct_rows', 'robl_rows', 0, 1, 80, $1, '[]'::jsonb, 'rows/2026/10/01/chunk.jsonl.gz',
                 '1717', 'gzip', $2, 61)`,
        ['c'.repeat(64), 'f'.repeat(64)]
      );
      await legacy.query(
        `INSERT INTO adcp_reporting_row_chunks
           (row_set_id, chunk_index, account_id, obligation_id, first_ordinal, row_count, byte_count, sha256, segments)
         VALUES ('rrev_legacy', 1, 'acct_rows', 'robl_rows', 1, 1, 40, $1, '[]'::jsonb)`,
        ['9'.repeat(64)]
      );
      await legacy.query(
        `INSERT INTO adcp_reporting_row_write_intents
           (row_binding_id, account_id, row_set_id, content_sha256, state, owner_token, created_objects, expires_at)
         VALUES ('objects', 'acct_rows', 'rrev_sweeping', $1, 'sweeping', 'owner',
                 '[{"objectKey":"rows/c","nativeVersion":"3"},{"object_ref":"rows/d","native_version_ref":"4"}]'::jsonb,
                 clock_timestamp() - INTERVAL '1 hour'),
                ('objects', 'acct_rows', 'rrev_empty_intent', $1, 'open', 'owner', '[]'::jsonb,
                 clock_timestamp() + INTERVAL '1 hour')`,
        ['b'.repeat(64)]
      );
      await legacy.query(
        `INSERT INTO adcp_reporting_row_write_intents
           (row_binding_id, account_id, row_set_id, content_sha256, owner_token, created_objects, expires_at)
         VALUES ('objects', 'acct_rows', 'rrev_pending', $1, 'owner',
                 '[{"objectKey":"rows/a","nativeVersion":"1"},{"objectKey":"rows/b","nativeVersion":"2"}]'::jsonb,
                 clock_timestamp() + INTERVAL '1 hour')`,
        ['c'.repeat(64)]
      );
    });

    after(async () => {
      if (legacy) await legacy.end();
      await bootstrapPool.query(`DROP SCHEMA IF EXISTS "${legacySchema}" CASCADE`);
    });

    test('renames in place, keeps every recorded location and is idempotent', async () => {
      await legacy.query(ledger.REPORTING_ROW_STORAGE_MIGRATION);
      await legacy.query(ledger.REPORTING_ROW_STORAGE_MIGRATION);
      const columns = new Set(
        (
          await legacy.query(
            `SELECT table_name || '.' || column_name AS name FROM information_schema.columns
              WHERE table_schema = current_schema() AND table_name LIKE 'adcp_reporting_row_%'`
          )
        ).rows.map(row => row.name)
      );
      for (const present of [
        'adcp_reporting_row_chunks.object_ref',
        'adcp_reporting_row_chunks.native_version_ref',
        'adcp_reporting_row_chunks.canonical_size_bytes',
        'adcp_reporting_row_chunks.size_bytes',
        'adcp_reporting_row_sets.content_size_bytes',
        'adcp_reporting_row_sets.format',
        'adcp_reporting_row_sets.algorithm',
      ]) {
        assert.ok(columns.has(present), `${present} exists`);
      }
      for (const absent of [
        'adcp_reporting_row_chunks.object_key',
        'adcp_reporting_row_chunks.native_version',
        'adcp_reporting_row_chunks.byte_count',
        'adcp_reporting_row_chunks.physical_byte_count',
        'adcp_reporting_row_sets.canonical_byte_count',
        'adcp_reporting_row_sets.encoding',
      ]) {
        assert.ok(!columns.has(absent), `${absent} is gone`);
      }
      const chunk = (await legacy.query(`SELECT * FROM adcp_reporting_row_chunks WHERE row_set_id = 'rrev_legacy'`))
        .rows[0];
      assert.equal(chunk.object_ref, 'rows/2026/10/01/chunk.jsonl.gz', 'recorded object keys are not rewritten');
      assert.equal(chunk.native_version_ref, '1717');
      assert.equal(Number(chunk.canonical_size_bytes), 80);
      assert.equal(Number(chunk.size_bytes), 61, 'size_bytes is the stored (compressed) object size');
      const rowSet = (await legacy.query(`SELECT * FROM adcp_reporting_row_sets WHERE row_set_id = 'rrev_legacy'`))
        .rows[0];
      assert.equal(rowSet.format, 'jsonl');
      assert.equal(rowSet.algorithm, 'adcp_jcs_rows_v1');
      assert.equal(Number(rowSet.content_size_bytes), 80);
      const intents = Object.fromEntries(
        (
          await legacy.query('SELECT row_set_id, state, created_objects FROM adcp_reporting_row_write_intents')
        ).rows.map(row => [row.row_set_id, row])
      );
      assert.deepEqual(intents.rrev_pending.created_objects, [
        { object_ref: 'rows/a', native_version_ref: '1' },
        { object_ref: 'rows/b', native_version_ref: '2' },
      ]);
      assert.equal(intents.rrev_sweeping.state, 'sweeping', 'the rewrite keeps the intent state');
      assert.deepEqual(
        intents.rrev_sweeping.created_objects,
        [
          { object_ref: 'rows/c', native_version_ref: '3' },
          { object_ref: 'rows/d', native_version_ref: '4' },
        ],
        'old and already-new elements mix'
      );
      assert.deepEqual(intents.rrev_empty_intent.created_objects, []);
      const bodyChunk = (
        await legacy.query(
          `SELECT * FROM adcp_reporting_row_chunks WHERE row_set_id = 'rrev_legacy' AND chunk_index = 1`
        )
      ).rows[0];
      assert.equal(bodyChunk.object_ref, null, 'a chunk without an object stays without one');
      assert.equal(bodyChunk.native_version_ref, null);
      assert.equal(bodyChunk.size_bytes, null);
      assert.equal(Number(bodyChunk.canonical_size_bytes), 40);
      // A third application changes nothing.
      const snapshot = async () =>
        JSON.stringify([
          (await legacy.query('SELECT * FROM adcp_reporting_row_chunks ORDER BY row_set_id, chunk_index')).rows,
          (await legacy.query('SELECT * FROM adcp_reporting_row_write_intents ORDER BY row_set_id')).rows,
        ]);
      const before = await snapshot();
      await legacy.query(ledger.REPORTING_ROW_STORAGE_MIGRATION);
      assert.equal(await snapshot(), before);
    });

    test('keeps the immutability triggers and adds the AdCP checks', async () => {
      await assert.rejects(
        () => legacy.query(`UPDATE adcp_reporting_row_sets SET row_count = 2`),
        /row set content is immutable/
      );
      await assert.rejects(
        () => legacy.query(`UPDATE adcp_reporting_row_chunks SET canonical_size_bytes = 81`),
        /row chunk content is immutable/
      );
      await assert.rejects(
        () =>
          legacy.query(
            `INSERT INTO adcp_reporting_row_chunks
               (row_set_id, chunk_index, account_id, obligation_id, first_ordinal, row_count, canonical_size_bytes,
                sha256, segments, object_ref, native_version_ref, compression, physical_sha256, size_bytes)
             VALUES ('rrev_legacy', 1, 'acct_rows', 'robl_rows', 1, 1, 80, $1, '[]'::jsonb, $2, '1', 'none', $1, 80)`,
            ['c'.repeat(64), 'k'.repeat(1025)]
          ),
        /adcp_reporting_row_chunks_object_ref_bounds/
      );
    });

    test('a fresh install and an upgraded install end with the same chunk and row-set columns', async () => {
      const shape = async queryable =>
        (
          await queryable.query(
            `SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns
              WHERE table_schema = current_schema()
                AND table_name IN ('adcp_reporting_row_sets', 'adcp_reporting_row_chunks')
              ORDER BY table_name, column_name`
          )
        ).rows;
      assert.deepEqual(await shape(legacy), await shape(pool));
      const structure = async queryable => ({
        indexes: (
          await queryable.query(
            `SELECT indexname, regexp_replace(indexdef, ' ON [^ ]+\\.', ' ON ', 'g') AS indexdef FROM pg_indexes
              WHERE schemaname = current_schema() AND tablename LIKE 'adcp_reporting_row_%' ORDER BY indexname`
          )
        ).rows,
        triggers: (
          await queryable.query(
            `SELECT tgname FROM pg_trigger WHERE tgrelid::regclass::text LIKE '%adcp_reporting_row_%'
                AND NOT tgisinternal ORDER BY tgname`
          )
        ).rows,
        bounds: (
          await queryable.query(
            `SELECT conname FROM pg_constraint WHERE conname LIKE 'adcp_reporting_row_chunks_%_bounds' ORDER BY conname`
          )
        ).rows,
      });
      assert.deepEqual(await structure(legacy), await structure(pool));
    });
  });

  describe('a database the migration cannot upgrade safely', () => {
    const unsafeSchema = `adcp_reporting_row_storage_unsafe_${process.pid}`;
    let unsafe;

    before(async () => {
      await bootstrapPool.query(`DROP SCHEMA IF EXISTS "${unsafeSchema}" CASCADE`);
      await bootstrapPool.query(`CREATE SCHEMA "${unsafeSchema}"`);
      unsafe = new (require('pg').Pool)({
        connectionString: DATABASE_URL,
        options: `-c search_path="${unsafeSchema}"`,
      });
      await unsafe.query(ledger.REPORTING_LEDGER_MIGRATION);
      await unsafe.query(
        readFileSync(path.join(__dirname, 'fixtures', 'reporting-row-storage-migration-15.8.sql'), 'utf8')
      );
      await seedObligation(unsafe);
      await unsafe.query(
        `INSERT INTO adcp_reporting_row_bindings
           (row_binding_id, kind, provider, identity_config, identity_sha256, namespace_key)
         VALUES ('objects', 'object', 'gcs', '{}'::jsonb, $1, $2)`,
        ['a'.repeat(64), 'b'.repeat(64)]
      );
      await unsafe.query(
        `INSERT INTO adcp_reporting_row_sets
           (row_set_id, row_set_kind, account_id, obligation_id, encoding, digest_profile, content_sha256,
            canonical_byte_count, row_count, row_manifest_sha256, chunk_count, row_binding_id)
         VALUES ('rrev_long', 'revision', 'acct_rows', 'robl_rows', 'adcp_canonical_jsonl_v1',
                 'revision_envelope_v1', $1, 80, 1, $2, 1, 'objects')`,
        ['d'.repeat(64), 'e'.repeat(64)]
      );
      await unsafe.query(
        `INSERT INTO adcp_reporting_row_chunks
           (row_set_id, chunk_index, account_id, obligation_id, first_ordinal, row_count, byte_count, sha256, segments,
            object_key, native_version, compression, physical_sha256, physical_byte_count)
         VALUES ('rrev_long', 0, 'acct_rows', 'robl_rows', 0, 1, 80, $1, '[]'::jsonb, $2, '1', 'gzip', $3, 61)`,
        ['c'.repeat(64), 'k'.repeat(1025), 'f'.repeat(64)]
      );
    });

    after(async () => {
      if (unsafe) await unsafe.end();
      await bootstrapPool.query(`DROP SCHEMA IF EXISTS "${unsafeSchema}" CASCADE`);
    });

    test('the probe names the columns a binary needs, so an un-migrated database fails closed', async () => {
      await assert.rejects(
        () => ledger.probeReportingRowStorageSchemaV1(unsafe),
        /requires the current REPORTING_ROW_STORAGE_MIGRATION; missing columns: .*format.*object_ref/
      );
    });

    test('refuses to add the AdCP bounds over a key that violates them and rolls everything back', async () => {
      await assert.rejects(
        () => unsafe.query(ledger.REPORTING_ROW_STORAGE_MIGRATION),
        /1 chunk\(s\) hold an object_ref/
      );
      const columns = (
        await unsafe.query(
          `SELECT column_name FROM information_schema.columns
            WHERE table_schema = current_schema() AND table_name = 'adcp_reporting_row_chunks'`
        )
      ).rows.map(row => row.column_name);
      assert.ok(columns.includes('object_key') && !columns.includes('object_ref'), 'no half-renamed table');
      const rowSetColumns = (
        await unsafe.query(
          `SELECT column_name FROM information_schema.columns
            WHERE table_schema = current_schema() AND table_name = 'adcp_reporting_row_sets'`
        )
      ).rows.map(row => row.column_name);
      assert.ok(rowSetColumns.includes('encoding') && !rowSetColumns.includes('format'));
    });

    test('applies once the operator repairs the key, and the probe then passes', async () => {
      await unsafe.query(`UPDATE adcp_reporting_row_chunks SET object_key = 'rows/short.jsonl.gz'`);
      await unsafe.query(ledger.REPORTING_ROW_STORAGE_MIGRATION);
      assert.match((await ledger.probeReportingRowStorageSchemaV1(unsafe)).installationId, /^[0-9a-f-]{36}$/);
    });
  });
});
