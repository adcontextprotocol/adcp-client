/**
 * Row-storage tables for reporting revisions (shared SDK persistence spec,
 * `reporting-row-storage` v1, adcontextprotocol/adcp#7996 §3.2).
 *
 * Apply after {@link REPORTING_LEDGER_MIGRATION}. PostgreSQL 13 or later
 * (`gen_random_uuid()`, `sha256()`). Idempotent; reapplying preserves the
 * installation identity and every recorded location.
 *
 * Stored values use AdCP's names and bounds (`reporting-file-manifest.json`,
 * `reporting-file-entry.json`): `object_ref` and `native_version_ref` are 1 to
 * 1024 characters, `size_bytes` is the stored object's size, and the row-set
 * `format` / `algorithm` are `jsonl` / `adcp_jcs_rows_v1`. A database created by
 * an earlier 15.x release (`object_key`, `native_version`, `byte_count`,
 * `physical_byte_count`, `canonical_byte_count`, `encoding`) is renamed in place
 * by the first block below; the migration also rewrites any open write
 * intent's `created_objects`. Recorded object keys are not rewritten. Adopters
 * who have not activated row storage should re-sync instead.
 *
 * - `adcp_persistence_installation` holds one installation UUID per isolated
 *   schema. A restore of the same authority keeps it; an independently
 *   writable clone must mint a new one before it writes or sweeps.
 * - `adcp_reporting_row_bindings` holds immutable, non-secret descriptions of
 *   where row bytes live. Only `state`, `operational_config` and `retired_at`
 *   may change.
 * - `adcp_reporting_row_sets` records where a revision's (or adjustment's)
 *   rows live and binds the chunk manifest digest. A revision without a row
 *   set still carries its rows inline in its ledger document.
 * - `adcp_reporting_row_chunks` is the per-chunk manifest; only location
 *   columns may change, through a guarded move.
 * - `adcp_reporting_chunk_bodies` holds `postgres`-kind chunk bytes,
 *   content-addressed within one obligation so revisions that repeat their
 *   predecessor's rows share bodies.
 * - `adcp_reporting_row_write_intents` fences external uploads so a sweep
 *   never deletes bytes a committing writer still needs.
 *
 * @experimental Reliable Reporting storage surface: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export const REPORTING_ROW_STORAGE_MIGRATION = `
-- Serialize concurrent appliers (several instances may run migrations at startup) so the guarded
-- renames below cannot race each other. Released at the end of this implicit transaction.
SELECT pg_advisory_xact_lock(hashtextextended('adcp-reporting-row-storage-migration', 0));

-- In-place upgrade from the pre-AdCP-alignment column names. Every step is guarded, so a fresh
-- install (no tables yet) and a reapplied migration are both no-ops here.
DO $align$
DECLARE
  renames TEXT[][] := ARRAY[
    ARRAY['adcp_reporting_row_chunks', 'object_key', 'object_ref'],
    ARRAY['adcp_reporting_row_chunks', 'native_version', 'native_version_ref'],
    ARRAY['adcp_reporting_row_chunks', 'byte_count', 'canonical_size_bytes'],
    ARRAY['adcp_reporting_row_chunks', 'physical_byte_count', 'size_bytes'],
    ARRAY['adcp_reporting_row_sets', 'canonical_byte_count', 'content_size_bytes']
  ];
  item TEXT[];
BEGIN
  FOREACH item SLICE 1 IN ARRAY renames LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = item[1] AND column_name = item[2]
    ) AND NOT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = item[1] AND column_name = item[3]
    ) THEN
      EXECUTE format('ALTER TABLE %I RENAME COLUMN %I TO %I', item[1], item[2], item[3]);
    END IF;
  END LOOP;
  -- encoding = 'adcp_canonical_jsonl_v1' becomes AdCP's format = 'jsonl' plus
  -- algorithm = 'adcp_jcs_rows_v1'. The old CHECK admitted one value, so the defaults backfill
  -- every row without an UPDATE (the immutability trigger forbids one).
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = 'adcp_reporting_row_sets' AND column_name = 'encoding'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = 'adcp_reporting_row_sets' AND column_name = 'format'
  ) THEN
    ALTER TABLE adcp_reporting_row_sets
      ADD COLUMN format TEXT NOT NULL DEFAULT 'jsonl' CHECK (format = 'jsonl'),
      ADD COLUMN algorithm TEXT NOT NULL DEFAULT 'adcp_jcs_rows_v1' CHECK (algorithm = 'adcp_jcs_rows_v1');
    ALTER TABLE adcp_reporting_row_sets ALTER COLUMN format DROP DEFAULT, ALTER COLUMN algorithm DROP DEFAULT;
    ALTER TABLE adcp_reporting_row_sets DROP COLUMN encoding;
  END IF;
END
$align$;

CREATE TABLE IF NOT EXISTS adcp_persistence_installation (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  installation_id UUID NOT NULL DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO adcp_persistence_installation (singleton) VALUES (TRUE) ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS adcp_reporting_row_bindings (
  row_binding_id TEXT COLLATE "C" PRIMARY KEY CHECK (row_binding_id ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  kind TEXT NOT NULL CHECK (kind IN ('postgres', 'object')),
  provider TEXT NOT NULL CHECK (provider ~ '^[a-z][a-z0-9_]{0,63}$'),
  identity_config JSONB NOT NULL CHECK (jsonb_typeof(identity_config) = 'object'),
  identity_sha256 TEXT COLLATE "C" NOT NULL CHECK (identity_sha256 ~ '^[0-9a-f]{64}$'),
  operational_config JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(operational_config) = 'object'),
  namespace_key TEXT COLLATE "C" NOT NULL CHECK (namespace_key ~ '^[0-9a-f]{64}$'),
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'read_only', 'retired')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  retired_at TIMESTAMPTZ,
  CHECK ((state = 'retired') = (retired_at IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS adcp_reporting_row_sets (
  row_set_id TEXT COLLATE "C" PRIMARY KEY,
  row_set_kind TEXT NOT NULL CHECK (row_set_kind IN ('revision', 'adjustment')),
  account_id TEXT COLLATE "C" NOT NULL,
  obligation_id TEXT COLLATE "C" NOT NULL REFERENCES adcp_reporting_obligations(obligation_id),
  format TEXT NOT NULL CHECK (format = 'jsonl'),
  algorithm TEXT NOT NULL CHECK (algorithm = 'adcp_jcs_rows_v1'),
  digest_profile TEXT NOT NULL CHECK (digest_profile IN ('revision_envelope_v1', 'rows_v1')),
  content_sha256 TEXT COLLATE "C" NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  content_size_bytes BIGINT NOT NULL CHECK (content_size_bytes > 0),
  row_count BIGINT NOT NULL CHECK (row_count >= 0),
  row_manifest_sha256 TEXT COLLATE "C" NOT NULL CHECK (row_manifest_sha256 ~ '^[0-9a-f]{64}$'),
  chunk_count INTEGER NOT NULL CHECK (chunk_count >= 0),
  rows_shared_from_row_set_id TEXT COLLATE "C",
  row_binding_id TEXT COLLATE "C" NOT NULL REFERENCES adcp_reporting_row_bindings(row_binding_id),
  row_location_version INTEGER NOT NULL DEFAULT 1 CHECK (row_location_version > 0),
  rows_state TEXT NOT NULL DEFAULT 'live' CHECK (rows_state IN ('live', 'pruning', 'pruned', 'unavailable')),
  rows_state_changed_at TIMESTAMPTZ,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK ((row_count = 0) = (chunk_count = 0)),
  CHECK (rows_shared_from_row_set_id IS NULL OR rows_shared_from_row_set_id <> row_set_id),
  -- Tenant columns are the composite key children reference, so a chunk or a
  -- shared row set can never name another account's or obligation's rows.
  UNIQUE (row_set_id, account_id, obligation_id),
  FOREIGN KEY (rows_shared_from_row_set_id, account_id, obligation_id)
    REFERENCES adcp_reporting_row_sets (row_set_id, account_id, obligation_id)
);
CREATE INDEX IF NOT EXISTS adcp_reporting_row_sets_obligation
  ON adcp_reporting_row_sets (obligation_id, recorded_at, row_set_id);
CREATE INDEX IF NOT EXISTS adcp_reporting_row_sets_state
  ON adcp_reporting_row_sets (account_id, rows_state, recorded_at)
  WHERE rows_state <> 'pruned';
CREATE INDEX IF NOT EXISTS adcp_reporting_row_sets_shared
  ON adcp_reporting_row_sets (rows_shared_from_row_set_id)
  WHERE rows_shared_from_row_set_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS adcp_reporting_row_chunks (
  row_set_id TEXT COLLATE "C" NOT NULL,
  chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
  account_id TEXT COLLATE "C" NOT NULL,
  obligation_id TEXT COLLATE "C" NOT NULL,
  first_ordinal BIGINT NOT NULL CHECK (first_ordinal >= 0),
  row_count INTEGER NOT NULL CHECK (row_count > 0),
  canonical_size_bytes BIGINT NOT NULL CHECK (canonical_size_bytes > 0),
  sha256 TEXT COLLATE "C" NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  segments JSONB NOT NULL CHECK (jsonb_typeof(segments) = 'array'),
  object_ref TEXT COLLATE "C" CONSTRAINT adcp_reporting_row_chunks_object_ref_bounds
    CHECK (object_ref IS NULL OR char_length(object_ref) BETWEEN 1 AND 1024),
  native_version_ref TEXT CONSTRAINT adcp_reporting_row_chunks_native_version_ref_bounds
    CHECK (native_version_ref IS NULL OR char_length(native_version_ref) BETWEEN 1 AND 1024),
  compression TEXT NOT NULL DEFAULT 'none' CHECK (compression IN ('none', 'gzip')),
  physical_sha256 TEXT COLLATE "C" CHECK (physical_sha256 IS NULL OR physical_sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes BIGINT CHECK (size_bytes IS NULL OR size_bytes > 0),
  PRIMARY KEY (row_set_id, chunk_index),
  FOREIGN KEY (row_set_id, account_id, obligation_id)
    REFERENCES adcp_reporting_row_sets (row_set_id, account_id, obligation_id),
  CHECK ((object_ref IS NULL) = (native_version_ref IS NULL)),
  CHECK ((object_ref IS NULL) = (physical_sha256 IS NULL)),
  CHECK ((object_ref IS NULL) = (size_bytes IS NULL))
);
CREATE INDEX IF NOT EXISTS adcp_reporting_row_chunks_object
  ON adcp_reporting_row_chunks (object_ref, native_version_ref)
  WHERE object_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS adcp_reporting_row_chunks_body
  ON adcp_reporting_row_chunks (account_id, obligation_id, sha256)
  WHERE object_ref IS NULL;

CREATE TABLE IF NOT EXISTS adcp_reporting_chunk_bodies (
  account_id TEXT COLLATE "C" NOT NULL,
  obligation_id TEXT COLLATE "C" NOT NULL,
  sha256 TEXT COLLATE "C" NOT NULL,
  body BYTEA NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (account_id, obligation_id, sha256),
  CHECK (sha256 = encode(sha256(body), 'hex'))
);

CREATE TABLE IF NOT EXISTS adcp_reporting_row_write_intents (
  row_binding_id TEXT COLLATE "C" NOT NULL REFERENCES adcp_reporting_row_bindings(row_binding_id),
  account_id TEXT COLLATE "C" NOT NULL,
  row_set_id TEXT COLLATE "C" NOT NULL,
  content_sha256 TEXT COLLATE "C" NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'sweeping')),
  owner_token TEXT COLLATE "C" NOT NULL,
  created_objects JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(created_objects) = 'array'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (row_binding_id, row_set_id, content_sha256)
);
CREATE INDEX IF NOT EXISTS adcp_reporting_row_write_intents_expiry
  ON adcp_reporting_row_write_intents (expires_at, account_id)
  WHERE state = 'open';
-- Sweep retry state. An intent whose sweep fails backs off instead of holding
-- the head of every pass. Guarded on the catalog because ADD COLUMN IF NOT EXISTS
-- takes ACCESS EXCLUSIVE even when the column exists, which would block a rerun
-- behind every upload.
DO $intent_retry$
DECLARE
  intents regclass := to_regclass('adcp_reporting_row_write_intents');
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = intents AND attname = 'sweep_attempts' AND NOT attisdropped) THEN
    ALTER TABLE adcp_reporting_row_write_intents ADD COLUMN sweep_attempts INTEGER NOT NULL DEFAULT 0;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = intents AND attname = 'next_sweep_at' AND NOT attisdropped) THEN
    ALTER TABLE adcp_reporting_row_write_intents ADD COLUMN next_sweep_at TIMESTAMPTZ;
  END IF;
END
$intent_retry$;

CREATE OR REPLACE FUNCTION adcp_reporting_row_storage_immutable() RETURNS trigger
LANGUAGE plpgsql AS $immutable$
BEGIN
  IF TG_TABLE_NAME = 'adcp_reporting_row_bindings' THEN
    IF (NEW.row_binding_id, NEW.kind, NEW.provider, NEW.identity_config, NEW.identity_sha256, NEW.namespace_key)
       IS DISTINCT FROM
       (OLD.row_binding_id, OLD.kind, OLD.provider, OLD.identity_config, OLD.identity_sha256, OLD.namespace_key) THEN
      RAISE EXCEPTION 'reporting row binding identity is immutable' USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'adcp_reporting_row_sets' THEN
    IF (NEW.row_set_id, NEW.row_set_kind, NEW.account_id, NEW.obligation_id, NEW.format, NEW.algorithm,
        NEW.digest_profile, NEW.content_sha256, NEW.content_size_bytes, NEW.row_count, NEW.row_manifest_sha256, NEW.chunk_count,
        NEW.rows_shared_from_row_set_id, NEW.recorded_at)
       IS DISTINCT FROM
       (OLD.row_set_id, OLD.row_set_kind, OLD.account_id, OLD.obligation_id, OLD.format, OLD.algorithm,
        OLD.digest_profile, OLD.content_sha256, OLD.content_size_bytes, OLD.row_count, OLD.row_manifest_sha256, OLD.chunk_count,
        OLD.rows_shared_from_row_set_id, OLD.recorded_at) THEN
      RAISE EXCEPTION 'reporting row set content is immutable' USING ERRCODE = '23514';
    END IF;
    IF NEW.row_binding_id IS DISTINCT FROM OLD.row_binding_id
       AND NEW.row_location_version <> OLD.row_location_version + 1 THEN
      RAISE EXCEPTION 'reporting row set moves must advance row_location_version' USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'adcp_reporting_row_chunks' THEN
    IF (NEW.row_set_id, NEW.chunk_index, NEW.account_id, NEW.obligation_id, NEW.first_ordinal, NEW.row_count,
        NEW.canonical_size_bytes, NEW.sha256, NEW.segments)
       IS DISTINCT FROM
       (OLD.row_set_id, OLD.chunk_index, OLD.account_id, OLD.obligation_id, OLD.first_ordinal, OLD.row_count,
        OLD.canonical_size_bytes, OLD.sha256, OLD.segments) THEN
      RAISE EXCEPTION 'reporting row chunk content is immutable' USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'adcp_reporting_chunk_bodies' THEN
    RAISE EXCEPTION 'reporting chunk bodies are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$immutable$;

DO $triggers$
DECLARE
  target TEXT;
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'adcp_reporting_row_bindings',
    'adcp_reporting_row_sets',
    'adcp_reporting_row_chunks',
    'adcp_reporting_chunk_bodies'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger
       WHERE tgname = target || '_immutable'
         AND tgrelid = to_regclass(quote_ident(current_schema()) || '.' || quote_ident(target))
    ) THEN
      EXECUTE format(
        'CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION adcp_reporting_row_storage_immutable()',
        target || '_immutable',
        target
      );
    END IF;
  END LOOP;
END
$triggers$;

-- AdCP bounds on installs created before they existed (a fresh install has them inline).
DO $bounds$
DECLARE
  offending BIGINT;
BEGIN
  SELECT count(*) INTO offending FROM adcp_reporting_row_chunks
   WHERE object_ref IS NOT NULL
     AND (char_length(object_ref) NOT BETWEEN 1 AND 1024 OR char_length(native_version_ref) NOT BETWEEN 1 AND 1024);
  IF offending > 0 THEN
    RAISE EXCEPTION 'reporting row storage: % chunk(s) hold an object_ref or native_version_ref outside AdCP 1 to 1024 characters; re-sync them before applying this migration', offending
      USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'adcp_reporting_row_chunks_object_ref_bounds'
       AND conrelid = to_regclass(quote_ident(current_schema()) || '.adcp_reporting_row_chunks')
  ) THEN
    ALTER TABLE adcp_reporting_row_chunks ADD CONSTRAINT adcp_reporting_row_chunks_object_ref_bounds
      CHECK (object_ref IS NULL OR char_length(object_ref) BETWEEN 1 AND 1024);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'adcp_reporting_row_chunks_native_version_ref_bounds'
       AND conrelid = to_regclass(quote_ident(current_schema()) || '.adcp_reporting_row_chunks')
  ) THEN
    ALTER TABLE adcp_reporting_row_chunks ADD CONSTRAINT adcp_reporting_row_chunks_native_version_ref_bounds
      CHECK (native_version_ref IS NULL OR char_length(native_version_ref) BETWEEN 1 AND 1024);
  END IF;
END
$bounds$;

-- Open write intents written before the rename name objects objectKey / nativeVersion.
UPDATE adcp_reporting_row_write_intents
   SET created_objects = (
     SELECT COALESCE(jsonb_agg(
       CASE WHEN jsonb_typeof(created) = 'object' AND created ? 'objectKey'
         THEN jsonb_build_object('object_ref', created -> 'objectKey', 'native_version_ref', created -> 'nativeVersion')
         ELSE created END
       ORDER BY ordinality
     ), '[]'::jsonb)
       FROM jsonb_array_elements(created_objects) WITH ORDINALITY AS element(created, ordinality)
   )
 WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(created_objects) AS element(created) WHERE jsonb_typeof(created) = 'object' AND created ? 'objectKey');
`.trim();

/**
 * Tables {@link REPORTING_ROW_STORAGE_MIGRATION} creates, in dependency order.
 *
 * @experimental Reliable Reporting storage surface: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export const REPORTING_ROW_STORAGE_TABLES = Object.freeze([
  'adcp_persistence_installation',
  'adcp_reporting_row_bindings',
  'adcp_reporting_row_sets',
  'adcp_reporting_row_chunks',
  'adcp_reporting_chunk_bodies',
  'adcp_reporting_row_write_intents',
] as const);

/** Columns added or renamed by the AdCP field alignment; a database missing any needs the migration re-applied. */
const REPORTING_ROW_STORAGE_REQUIRED_COLUMNS = Object.freeze([
  'adcp_reporting_row_sets.format',
  'adcp_reporting_row_sets.algorithm',
  'adcp_reporting_row_sets.content_size_bytes',
  'adcp_reporting_row_chunks.canonical_size_bytes',
  'adcp_reporting_row_chunks.object_ref',
  'adcp_reporting_row_chunks.native_version_ref',
  'adcp_reporting_row_chunks.size_bytes',
] as const);

interface QueryablePoolV1 {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[]
  ): Promise<{ rows: Row[] }>;
}

/**
 * Fail closed unless every row-storage table exists in the current schema.
 * Returns the installation identity.
 *
 * @experimental Reliable Reporting storage surface: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export async function probeReportingRowStorageSchemaV1(pool: QueryablePoolV1): Promise<{ installationId: string }> {
  const present = await pool.query<{ name: string }>(
    `SELECT table_name AS name FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_name = ANY($1::text[])`,
    [[...REPORTING_ROW_STORAGE_TABLES]]
  );
  const names = new Set(present.rows.map(row => row.name));
  const missing = REPORTING_ROW_STORAGE_TABLES.filter(name => !names.has(name));
  if (missing.length > 0) {
    throw new Error(
      `Reporting row storage requires REPORTING_ROW_STORAGE_MIGRATION; missing tables: ${missing.join(', ')}`
    );
  }
  const columns = await pool.query<{ name: string }>(
    `SELECT table_name || '.' || column_name AS name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = ANY($1::text[])`,
    [['adcp_reporting_row_chunks', 'adcp_reporting_row_sets']]
  );
  const columnNames = new Set(columns.rows.map(row => row.name));
  const absent = REPORTING_ROW_STORAGE_REQUIRED_COLUMNS.filter(name => !columnNames.has(name));
  if (absent.length > 0) {
    throw new Error(
      `Reporting row storage requires the current REPORTING_ROW_STORAGE_MIGRATION; missing columns: ${absent.join(', ')}`
    );
  }
  const installation = await pool.query<{ installation_id: string }>(
    'SELECT installation_id::text AS installation_id FROM adcp_persistence_installation WHERE singleton'
  );
  const installationId = installation.rows[0]?.installation_id;
  if (!installationId) throw new Error('Reporting row storage installation identity is missing');
  return { installationId };
}
