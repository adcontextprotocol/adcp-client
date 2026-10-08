/**
 * PostgreSQL integration tests for the reporting row-storage migration.
 *
 * REPORTING_LEDGER_PG_URL=postgres://localhost/test node --test test/lib/reporting-row-storage-migration-pg.test.js
 */
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
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
    ledger = require('../../dist/lib/reporting/ledger/index.js');
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
         (row_set_id, row_set_kind, account_id, obligation_id, encoding, digest_profile, content_sha256,
          canonical_byte_count, row_count, row_manifest_sha256, chunk_count, row_binding_id)
       VALUES ('rrev_rows', 'revision', 'acct_rows', 'robl_rows', 'adcp_canonical_jsonl_v1', 'revision_envelope_v1',
               $1, 80, 1, $2, 1, 'postgres')`,
      ['d'.repeat(64), 'e'.repeat(64)]
    );
    await pool.query(
      `INSERT INTO adcp_reporting_row_chunks
         (row_set_id, chunk_index, account_id, obligation_id, first_ordinal, row_count, byte_count, sha256, segments)
       VALUES ('rrev_rows', 0, 'acct_rows', 'robl_rows', 0, 1, $1, $2, '[]'::jsonb)`,
      [body.byteLength, hex(body)]
    );
    await assert.rejects(
      () =>
        pool.query(
          `INSERT INTO adcp_reporting_row_chunks
             (row_set_id, chunk_index, account_id, obligation_id, first_ordinal, row_count, byte_count, sha256, segments)
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
             (row_set_id, row_set_kind, account_id, obligation_id, encoding, digest_profile, content_sha256,
              canonical_byte_count, row_count, row_manifest_sha256, chunk_count, row_binding_id,
              rows_shared_from_row_set_id)
           VALUES ('rrev_foreign_share', 'revision', 'acct_other', 'robl_rows', 'adcp_canonical_jsonl_v1',
                   'revision_envelope_v1', $1, 80, 1, $2, 1, 'postgres', 'rrev_rows')`,
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
          `UPDATE adcp_reporting_row_chunks SET object_key = 'k', native_version = '1', physical_sha256 = $1`,
          ['f'.repeat(64)]
        ),
      /check constraint/,
      'object locations are all-or-nothing'
    );
    await assert.rejects(
      () =>
        pool.query(
          `INSERT INTO adcp_reporting_row_sets
             (row_set_id, row_set_kind, account_id, obligation_id, encoding, digest_profile, content_sha256,
              canonical_byte_count, row_count, row_manifest_sha256, chunk_count, row_binding_id)
           VALUES ('rrev_empty', 'revision', 'acct_rows', 'robl_rows', 'adcp_canonical_jsonl_v1',
                   'revision_envelope_v1', $1, 80, 0, $2, 1, 'postgres')`,
          ['d'.repeat(64), 'e'.repeat(64)]
        ),
      /check constraint/,
      'an empty row set has no chunks'
    );
  });
});
