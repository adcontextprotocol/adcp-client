/**
 * PostgreSQL-backed `TaskRegistry` for the v6.0 decisioning runtime.
 *
 * The default `createInMemoryTaskRegistry()` loses task state on process
 * restart and doesn't share state across instances behind a load balancer —
 * fine for tests and local dev, broken for production HITL paths
 * (`createMediaBuyTask`, `syncCreativesTask`, etc.). Wire this in via
 * `createAdcpServerFromPlatform({ taskRegistry: createPostgresTaskRegistry({ pool, namespace }) })`
 * to persist task lifecycle across requests, processes, and crashes.
 *
 * @example
 * ```typescript
 * import { Pool } from 'pg';
 * import {
 *   createAdcpServerFromPlatform,
 *   createPostgresTaskRegistry,
 *   getDecisioningTaskRegistryBootstrap,
 * } from '@adcp/sdk/server';
 *
 * const pool = new Pool({ connectionString: process.env.DATABASE_URL });
 *
 * const taskRegistryNamespace = 'tenant:my-agent';
 * // Bootstrap only: safe for a new/empty database. Upgrade populated legacy
 * // tables with getDecisioningTaskRegistryScopeV1Upgrade during deployment.
 * await pool.query(getDecisioningTaskRegistryBootstrap({ namespace: taskRegistryNamespace }));
 *
 * const server = createAdcpServerFromPlatform(platform, {
 *   name: 'My Ad Network',
 *   version: '1.0.0',
 *   taskRegistry: createPostgresTaskRegistry({
 *     pool,
 *     namespace: taskRegistryNamespace,
 *     storageId: 'prod-eu1:primary-db',
 *   }),
 * });
 * ```
 *
 * **Background-completion lifecycle.** `_registerBackground` / `awaitTask`
 * are PROCESS-LOCAL — promises don't serialize. When a HITL `*Task` method
 * is invoked, the returned promise lives on the originating process; if
 * that process restarts before the method completes, the task record stays
 * in `submitted` state in Postgres but no `awaitTask` resolution is
 * possible from a different instance. Production HITL flows that span
 * process boundaries may use `completeScopedTask()` / `failScopedTask()` for
 * polling-only tasks after persisting the full issued reference. Registry-only
 * settlement rejects buyer push-notification tasks because it cannot durably
 * deliver their terminal webhook; those must finish through the live handoff.
 * The MCP `tasks/get` wire path reads via `getTask` and is cross-instance.
 *
 * Status: Preview / 6.0.
 *
 * @public
 */

import { randomUUID } from 'node:crypto';
import type { AdcpStructuredError, TaskHandoffProgress } from '../async-outcome';
import type {
  ScopedTaskRef,
  TaskMutationOutcome,
  TaskRecord,
  TaskRegistry,
  TaskRegistryScope,
  TaskStatus,
} from './task-registry';
import { sanitizeTaskProgressForStorage } from './task-registry';

/**
 * Minimal subset of the `pg.Pool` interface used by the registry.
 * Mirrors `PgQueryable` in `postgres-task-store.ts` so callers can pass
 * pools, transaction wrappers, or any pg-compatible query executor.
 */
export interface PgQueryable {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
}

export interface CreatePostgresTaskRegistryOptions {
  /** A `pg.Pool` instance (or any `PgQueryable`). */
  pool: PgQueryable;
  /** Trusted deployment/tenant namespace. Use a distinct value per hosted tenant. */
  namespace: string;
  /**
   * Stable, non-secret identity for this physical registry deployment (for
   * example `prod-eu1:buyer-tasks`). Required only for strict out-of-process
   * worker helpers; omit it to preserve ordinary beta.13 registry usage, in
   * which case issued refs cannot be used by those helpers.
   */
  storageId?: string;
  /**
   * Table name. Defaults to `'adcp_decisioning_tasks'` (vendor-prefixed to
   * avoid collisions with the MCP-level `adcp_mcp_tasks` table from
   * `PostgresTaskStore` and any consumer tables).
   *
   * Must match `^[a-z_][a-z0-9_]*$` — schema-qualified names are not
   * supported by this validator. Set search_path on the pool if you need
   * a non-default schema.
   */
  tableName?: string;
}

/** Default table name — vendor-prefixed to avoid collisions. */
const DEFAULT_TABLE = 'adcp_decisioning_tasks';

/** Validates a SQL identifier to prevent injection via table names. */
const VALID_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
const VALID_NAMESPACE = /^[A-Za-z0-9_.:-]{1,255}$/;

function assertValidIdentifier(name: string): void {
  if (!VALID_IDENTIFIER.test(name) || Buffer.byteLength(name, 'utf8') > 40) {
    throw new Error(
      `Invalid table name "${name}": must be lowercase letters, digits, ` +
        `or underscores, starting with a letter or underscore, and at most 40 bytes.`
    );
  }
}

function assertValidNamespace(namespace: unknown): asserts namespace is string {
  if (typeof namespace !== 'string' || !VALID_NAMESPACE.test(namespace)) {
    throw new Error(
      'Invalid registry namespace: namespace is required and must be 1-255 ASCII letters, digits, dots, underscores, colons, or hyphens.'
    );
  }
}

function assertValidStorageId(storageId: unknown): asserts storageId is string {
  if (typeof storageId !== 'string' || !VALID_NAMESPACE.test(storageId)) {
    throw new Error(
      'Invalid task registry storageId: use 1-255 ASCII letters, digits, dots, underscores, colons, or hyphens.'
    );
  }
}

/**
 * Cap on `result` / `error` JSONB column size. Adopter `*Task` returns are
 * written verbatim — a buggy or malicious adopter handing back a 1GB
 * result would OOM the Node process before pg complains. 4MB matches the
 * default Postgres `toast` row threshold and gives plenty of headroom for
 * legitimate task payloads.
 *
 * **This cap protects the DB write path only.** Adopter code that
 * serializes `result` / `error` for logs, metrics, or downstream services
 * MUST impose its own size cap — `JSON.stringify(result)` in a logger
 * call is unbounded.
 */
const MAX_RESULT_BYTES = 4 * 1024 * 1024;

function assertResultSize(json: string, taskId: string): void {
  // `Buffer.byteLength` is utf-8 byte length, which is what Postgres stores.
  if (Buffer.byteLength(json, 'utf8') > MAX_RESULT_BYTES) {
    throw new Error(
      `Task ${taskId}: result/error JSON exceeds ${MAX_RESULT_BYTES} bytes ` +
        `(adopter *Task method returned an oversized payload — investigate ` +
        `whether the body should be persisted via blob storage and referenced).`
    );
  }
}

/**
 * Wrap `JSON.stringify` with a clearer error when the adopter `*Task`
 * return contains circular references. Default `TypeError: Converting
 * circular structure to JSON` doesn't surface the task id; this version
 * bubbles a registry-write error pointing at the adopter return shape.
 */
function safeStringify(value: unknown, taskId: string): string {
  try {
    return JSON.stringify(value);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Task ${taskId}: adopter *Task return is not JSON-serializable: ${msg}. ` +
        `Strip circular refs / non-plain-data before returning from your *Task method.`,
      { cause: err }
    );
  }
}

/**
 * Generate bootstrap DDL for a new decisioning task registry table.
 *
 * This does not upgrade a populated pre-scope registry. `CREATE TABLE IF NOT
 * EXISTS` makes repeated empty-database bootstrap harmless, but it does not
 * make schema replacement safe at application boot. Operators upgrading an
 * existing table must use `getDecisioningTaskRegistryScopeV1Upgrade()`.
 *
 * @example
 * ```typescript
 * import { getDecisioningTaskRegistryBootstrap } from '@adcp/sdk/server';
 * await pool.query(getDecisioningTaskRegistryBootstrap({ namespace: tenantId }));
 * await pool.query(getDecisioningTaskRegistryBootstrap({ tableName: 'my_tasks', namespace: tenantId }));
 * ```
 */
export function getDecisioningTaskRegistryBootstrap(options: { tableName?: string; namespace: string }): string {
  assertValidNamespace(options?.namespace);
  const table = options?.tableName ?? DEFAULT_TABLE;
  assertValidIdentifier(table);
  const namespace = options.namespace;
  return `
CREATE TABLE IF NOT EXISTS ${table} (
  registry_namespace TEXT NOT NULL DEFAULT '${namespace}',
  task_id         TEXT NOT NULL,
  tool            TEXT NOT NULL,
  account_id      TEXT NOT NULL,
  owner_scope     TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'submitted',
  status_message  TEXT,
  result          JSONB,
  error           JSONB,
  progress        JSONB,
  has_webhook     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT ${table}_valid_status CHECK (
    -- Framework-written values: 'submitted' (initial), 'working'
    -- (after first updateProgress() call), 'completed' / 'failed'
    -- (terminal). The other 5 spec-defined states ('input-required',
    -- 'canceled', 'rejected', 'auth-required', 'unknown') are reserved
    -- for adopter-emitted transitions via the v6.1
    -- \`taskRegistry.transition()\` API; the v6.1 migration will widen
    -- this CHECK.
    status IN ('submitted', 'working', 'completed', 'failed')
  ),
  CONSTRAINT ${table}_scope_pkey
    PRIMARY KEY (registry_namespace, account_id, owner_scope, task_id)
);

CREATE INDEX IF NOT EXISTS idx_${table}_account_id
  ON ${table}(account_id);

CREATE INDEX IF NOT EXISTS idx_${table}_status_created
  ON ${table}(status, created_at);

CREATE INDEX IF NOT EXISTS idx_${table}_owner_account
  ON ${table}(owner_scope, account_id);
`.trim();
}

/** @deprecated Choose bootstrap or the phased scope-v1 upgrade explicitly. */
export function getDecisioningTaskRegistryMigration(_options: { tableName?: string; namespace: string }): never {
  throw new Error(
    'getDecisioningTaskRegistryMigration() is unsafe and no longer returns SQL. Use getDecisioningTaskRegistryBootstrap() only for a new/empty database, or getDecisioningTaskRegistryScopeV1Upgrade() for a populated legacy table.'
  );
}

/** Versioned, operator-run upgrade plan for a populated pre-scope registry. */
export interface DecisioningTaskRegistryScopeV1Upgrade {
  readonly version: 1;
  /** Read-only diagnostics. Review every result before running `prepareSql`. */
  readonly preflightSql: string;
  /** Transactional column add/backfill/not-null phase with bounded locks. */
  readonly prepareSql: string;
  /** Run each statement separately: PostgreSQL forbids `CONCURRENTLY` in a transaction. */
  readonly concurrentIndexSql: readonly string[];
  /** Brief ACCESS EXCLUSIVE cutover that replaces the legacy primary key. */
  readonly cutoverSql: string;
  /** Read-only post-cutover checks. */
  readonly verifySql: string;
}

export interface DecisioningTaskRegistryScopeV1UpgradeOptions {
  tableName?: string;
  /** Trusted namespace that owns every legacy row lacking registry_namespace. */
  namespace: string;
  /** Abort rather than wait indefinitely for the required table locks. Default 5000. */
  lockTimeoutMs?: number;
  /** Bound each transactional phase. Default 900000 (15 minutes). */
  statementTimeoutMs?: number;
}

function positiveTimeout(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new Error(`${name} must be a positive safe integer in milliseconds.`);
  }
  return resolved;
}

/**
 * Build the phased scope-v1 upgrade for an existing populated registry.
 *
 * Review `preflightSql`, stop old writers, run `prepareSql`, run each
 * `concurrentIndexSql` statement as its own query, then run `cutoverSql` and
 * `verifySql`. Interrupted phases are retryable with the same namespace.
 * Never run two plans with different legacy namespaces against one table.
 */
export function getDecisioningTaskRegistryScopeV1Upgrade(
  options: DecisioningTaskRegistryScopeV1UpgradeOptions
): DecisioningTaskRegistryScopeV1Upgrade {
  assertValidNamespace(options?.namespace);
  const table = options?.tableName ?? DEFAULT_TABLE;
  assertValidIdentifier(table);
  const namespace = options.namespace;
  const lockTimeoutMs = positiveTimeout(options.lockTimeoutMs, 5_000, 'lockTimeoutMs');
  const statementTimeoutMs = positiveTimeout(options.statementTimeoutMs, 900_000, 'statementTimeoutMs');
  const constraint = `${table}_scope_pkey`;
  const buildIndex = constraint;
  const timeoutSql = `SET LOCAL lock_timeout = '${lockTimeoutMs}ms';\nSET LOCAL statement_timeout = '${statementTimeoutMs}ms';`;

  const preflightSql = `
SELECT
  '${table}' AS table_name,
  '${namespace}' AS proposed_legacy_namespace,
  c.reltuples::bigint AS estimated_rows,
  pg_size_pretty(pg_total_relation_size(c.oid)) AS total_size
FROM pg_class c
WHERE c.oid = '${table}'::regclass;

SELECT
  con.conname AS primary_key_name,
  pg_get_constraintdef(con.oid) AS primary_key_definition
FROM pg_constraint con
WHERE con.conrelid = '${table}'::regclass AND con.contype = 'p';

SELECT
  EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = '${table}'::regclass
      AND attname = 'registry_namespace'
      AND attnum > 0
      AND NOT attisdropped
  ) AS has_registry_namespace,
  EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = '${table}'::regclass
      AND attname = 'owner_scope'
      AND attnum > 0
      AND NOT attisdropped
  ) AS has_owner_scope;

DO $$
DECLARE
  null_namespaces BIGINT := 0;
  null_owner_scopes BIGINT := 0;
  target_duplicates BIGINT := 0;
  has_registry_namespace BOOLEAN := FALSE;
  has_owner_scope BOOLEAN := FALSE;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = '${table}'::regclass
      AND attname = 'registry_namespace'
      AND attnum > 0
      AND NOT attisdropped
  ) INTO has_registry_namespace;
  SELECT EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = '${table}'::regclass
      AND attname = 'owner_scope'
      AND attnum > 0
      AND NOT attisdropped
  ) INTO has_owner_scope;

  IF has_registry_namespace THEN
    EXECUTE 'SELECT count(*) FROM ${table} WHERE registry_namespace IS NULL OR registry_namespace = ''__adcp_legacy_unscoped__'''
      INTO null_namespaces;
  ELSE
    EXECUTE 'SELECT count(*) FROM ${table}' INTO null_namespaces;
  END IF;
  IF has_owner_scope THEN
    EXECUTE 'SELECT count(*) FROM ${table} WHERE owner_scope IS NULL' INTO null_owner_scopes;
  ELSE
    EXECUTE 'SELECT count(*) FROM ${table}' INTO null_owner_scopes;
  END IF;

  IF has_registry_namespace AND has_owner_scope THEN
    EXECUTE 'SELECT count(*) FROM (
      SELECT COALESCE(NULLIF(registry_namespace, ''__adcp_legacy_unscoped__''), ''${namespace}'') AS target_namespace,
             account_id, COALESCE(owner_scope, ''account:'' || account_id) AS target_owner_scope, task_id
      FROM ${table}
      GROUP BY 1, 2, 3, 4 HAVING count(*) > 1
    ) d' INTO target_duplicates;
  ELSIF has_registry_namespace THEN
    EXECUTE 'SELECT count(*) FROM (
      SELECT COALESCE(NULLIF(registry_namespace, ''__adcp_legacy_unscoped__''), ''${namespace}'') AS target_namespace,
             account_id, ''account:'' || account_id AS target_owner_scope, task_id
      FROM ${table}
      GROUP BY 1, 2, 3, 4 HAVING count(*) > 1
    ) d' INTO target_duplicates;
  ELSIF has_owner_scope THEN
    EXECUTE 'SELECT count(*) FROM (
      SELECT ''${namespace}'' AS target_namespace, account_id,
             COALESCE(owner_scope, ''account:'' || account_id) AS target_owner_scope, task_id
      FROM ${table}
      GROUP BY 1, 2, 3, 4 HAVING count(*) > 1
    ) d' INTO target_duplicates;
  ELSE
    EXECUTE 'SELECT count(*) FROM (
      SELECT ''${namespace}'' AS target_namespace, account_id,
             ''account:'' || account_id AS target_owner_scope, task_id
      FROM ${table}
      GROUP BY 1, 2, 3, 4 HAVING count(*) > 1
    ) d' INTO target_duplicates;
  END IF;
  RAISE NOTICE 'legacy rows needing namespace assignment: %', null_namespaces;
  RAISE NOTICE 'rows needing owner-scope assignment: %', null_owner_scopes;
  RAISE NOTICE 'duplicate target composite keys: %', target_duplicates;
  IF target_duplicates > 0 THEN
    RAISE EXCEPTION 'scope-v1 preflight failed: duplicate target keys require operator repair';
  END IF;
  IF null_namespaces > 0 THEN
    RAISE WARNING 'All legacy rows will be assigned to namespace ${namespace}; verify this table was not shared by multiple tenants';
  END IF;
END $$;
`.trim();

  const prepareSql = `
BEGIN;
${timeoutSql}
SELECT pg_advisory_xact_lock(hashtext('adcp-task-registry:${table}:scope-v1'));

ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS registry_namespace TEXT;
ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS owner_scope TEXT;

DO $$
DECLARE
  current_pk TEXT;
  current_pk_is_scope_v1 BOOLEAN := FALSE;
BEGIN
  SELECT con.conname,
         COALESCE((
           SELECT array_agg(att.attname::text ORDER BY key.ordinality)
           FROM unnest(con.conkey) WITH ORDINALITY AS key(attnum, ordinality)
           JOIN pg_attribute att
             ON att.attrelid = con.conrelid AND att.attnum = key.attnum
         ) = ARRAY['registry_namespace', 'account_id', 'owner_scope', 'task_id']::text[], FALSE)
    INTO current_pk, current_pk_is_scope_v1
  FROM pg_constraint con
  WHERE con.conrelid = '${table}'::regclass AND con.contype = 'p';
  IF NOT current_pk_is_scope_v1 AND EXISTS (
    SELECT 1 FROM ${table}
    WHERE registry_namespace IS NOT NULL
      AND registry_namespace <> '__adcp_legacy_unscoped__'
      AND registry_namespace <> '${namespace}'
  ) THEN
    RAISE EXCEPTION 'legacy rows already carry a different registry namespace; do not reassign tenant ownership';
  END IF;
END $$;

UPDATE ${table}
SET registry_namespace = '${namespace}'
WHERE registry_namespace IS NULL OR registry_namespace = '__adcp_legacy_unscoped__';

UPDATE ${table}
SET owner_scope = 'account:' || account_id
WHERE owner_scope IS NULL;

ALTER TABLE ${table} ALTER COLUMN registry_namespace SET DEFAULT '${namespace}';
ALTER TABLE ${table} ALTER COLUMN registry_namespace SET NOT NULL;
ALTER TABLE ${table} ALTER COLUMN owner_scope SET NOT NULL;
COMMIT;
`.trim();

  const concurrentIndexSql = [
    `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS ${buildIndex} ON ${table}(registry_namespace, account_id, owner_scope, task_id)`,
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_${table}_owner_account ON ${table}(owner_scope, account_id)`,
  ] as const;

  const cutoverSql = `
BEGIN;
${timeoutSql}
SELECT pg_advisory_xact_lock(hashtext('adcp-task-registry:${table}:scope-v1'));
DO $$
DECLARE
  current_pk TEXT;
  current_pk_is_scope_v1 BOOLEAN := FALSE;
  build_is_scope_v1 BOOLEAN := FALSE;
BEGIN
  SELECT con.conname,
         COALESCE((
           SELECT array_agg(att.attname::text ORDER BY key.ordinality)
           FROM unnest(con.conkey) WITH ORDINALITY AS key(attnum, ordinality)
           JOIN pg_attribute att
             ON att.attrelid = con.conrelid AND att.attnum = key.attnum
         ) = ARRAY['registry_namespace', 'account_id', 'owner_scope', 'task_id']::text[], FALSE)
    INTO current_pk, current_pk_is_scope_v1
  FROM pg_constraint con
  WHERE con.conrelid = '${table}'::regclass AND con.contype = 'p';
  IF current_pk_is_scope_v1 THEN
    RETURN;
  END IF;
  SELECT i.indisvalid
         AND i.indisready
         AND i.indisunique
         AND i.indpred IS NULL
         AND i.indexprs IS NULL
         AND i.indnkeyatts = 4
         AND COALESCE((
           SELECT array_agg(att.attname::text ORDER BY key.ordinality)
           FROM unnest(i.indkey::smallint[]) WITH ORDINALITY AS key(attnum, ordinality)
           JOIN pg_attribute att
             ON att.attrelid = i.indrelid AND att.attnum = key.attnum
           WHERE key.ordinality <= i.indnkeyatts
         ) = ARRAY['registry_namespace', 'account_id', 'owner_scope', 'task_id']::text[], FALSE)
    INTO build_is_scope_v1
  FROM pg_index i
  JOIN pg_class idx ON idx.oid = i.indexrelid
  JOIN pg_class target ON target.oid = i.indrelid
  WHERE i.indrelid = '${table}'::regclass
    AND idx.relname = '${buildIndex}'
    AND idx.relnamespace = target.relnamespace;
  IF build_is_scope_v1 IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'scope-v1 concurrent unique index is missing, invalid, or has the wrong definition; drop/rebuild it before cutover';
  END IF;
  IF current_pk IS NOT NULL THEN
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', '${table}', current_pk);
  END IF;
  ALTER TABLE ${table}
    ADD CONSTRAINT ${constraint} PRIMARY KEY USING INDEX ${buildIndex};
END $$;
COMMIT;
`.trim();

  const verifySql = `
SELECT count(*) AS null_scope_rows
FROM ${table}
WHERE registry_namespace IS NULL OR owner_scope IS NULL;

SELECT con.conname, pg_get_constraintdef(con.oid) AS definition
FROM pg_constraint con
WHERE con.conrelid = '${table}'::regclass AND con.contype = 'p';

SELECT indexrelid::regclass::text AS index_name, indisvalid, indisunique
FROM pg_index
WHERE indrelid = '${table}'::regclass
ORDER BY indexrelid::regclass::text;
`.trim();

  return { version: 1, preflightSql, prepareSql, concurrentIndexSql, cutoverSql, verifySql };
}

interface DbTaskRow {
  task_id: string;
  tool: string;
  account_id: string;
  owner_scope: string | null;
  status: TaskStatus;
  status_message: string | null;
  result: unknown;
  error: AdcpStructuredError | null;
  progress: TaskHandoffProgress | null;
  has_webhook: boolean;
  created_at: Date;
  updated_at: Date;
}

function mutationOutcome(rows: Record<string, unknown>[]): TaskMutationOutcome {
  if (rows.length === 0) return { outcome: 'not_found_in_scope' };
  const row = rows[0] as { outcome?: unknown; status?: unknown };
  if (row.outcome === 'applied') return { outcome: 'applied' };
  return { outcome: 'already_terminal', status: row.status as TaskStatus };
}

function rowToRecord<TResult>(row: DbTaskRow): TaskRecord<TResult> {
  return {
    taskId: row.task_id,
    tool: row.tool,
    accountId: row.account_id,
    ...(row.owner_scope ? { ownerScope: row.owner_scope } : {}),
    status: row.status,
    ...(row.status_message !== null && { statusMessage: row.status_message }),
    ...(row.result !== null && row.result !== undefined && { result: row.result as TResult }),
    ...(row.error !== null && row.error !== undefined && { error: row.error }),
    ...(row.progress !== null && row.progress !== undefined && { progress: row.progress }),
    ...(row.has_webhook && { hasWebhook: true }),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/**
 * Build a Postgres-backed `TaskRegistry`.
 *
 * Idempotency: `complete()` and `fail()` report `already_terminal` without
 * overwriting already-terminal tasks, matching `createInMemoryTaskRegistry()`.
 * Each lifecycle write locks, classifies, and conditionally updates in one SQL
 * statement so concurrent webhook deliveries cannot race or hide a scoped miss.
 *
 * **Multi-tenant deployments.** `namespace` is a trusted deployment/tenant
 * partition and participates in every query plus the primary key. Construct
 * one registry per tenant with a stable unique namespace; never derive it
 * from buyer request parameters. Tenants may safely share the same table.
 */
export function createPostgresTaskRegistry(opts: CreatePostgresTaskRegistryOptions): TaskRegistry {
  const table = opts.tableName ?? DEFAULT_TABLE;
  assertValidIdentifier(table);
  const pool = opts.pool;
  const namespace = opts.namespace;
  assertValidNamespace(namespace);
  if (opts.storageId !== undefined) assertValidStorageId(opts.storageId);
  const registryId =
    opts.storageId === undefined ? undefined : `postgres:${JSON.stringify([opts.storageId, table, namespace])}`;

  const query = async (operation: string, text: string, values?: unknown[]) => {
    try {
      return await pool.query(text, values);
    } catch (cause) {
      throw new Error(`PostgresTaskRegistry.${operation}: database operation failed`, { cause });
    }
  };

  const classifyAfterInvalidPayload = async (
    operation: string,
    taskId: string,
    scope: TaskRegistryScope,
    payloadError: unknown
  ): Promise<TaskMutationOutcome> => {
    const { rows } = await query(
      `${operation}.classifyInvalidPayload`,
      `SELECT status FROM ${table}
       WHERE task_id = $1 AND registry_namespace = $2 AND account_id = $3 AND owner_scope = $4
       FOR UPDATE`,
      [taskId, namespace, scope.accountId, scope.ownerScope]
    );
    if (rows.length === 0) return { outcome: 'not_found_in_scope' };
    const status = rows[0]?.status as TaskStatus;
    if (['completed', 'failed', 'rejected', 'canceled'].includes(status)) {
      return { outcome: 'already_terminal', status };
    }
    throw payloadError;
  };

  // Process-local background tracking — see file header note. Promises
  // can't be persisted; polling-only cross-instance HITL completion uses the
  // scoped worker helpers, not awaitTask.
  const backgrounds = new Map<string, Promise<void>>();

  return {
    scopeVersion: 1,
    registryId,
    async create(createOpts: {
      tool: string;
      accountId: string;
      ownerScope?: string;
      hasWebhook?: boolean;
      overrideTaskId?: string;
    }): Promise<ScopedTaskRef> {
      const taskId = createOpts.overrideTaskId ?? `task_${randomUUID()}`;
      const ownerScope = createOpts.ownerScope ?? `account:${createOpts.accountId}`;
      const result = await query(
        'create',
        `INSERT INTO ${table} (task_id, tool, account_id, owner_scope, status, has_webhook, registry_namespace) VALUES ($1, $2, $3, $4, 'submitted', $5, $6) ON CONFLICT (registry_namespace, account_id, owner_scope, task_id) DO NOTHING`,
        [taskId, createOpts.tool, createOpts.accountId, ownerScope, createOpts.hasWebhook === true, namespace]
      );
      if ((result.rowCount ?? 0) === 0) {
        throw new Error(`task_id already registered: ${taskId}`);
      }
      return {
        taskId,
        accountId: createOpts.accountId,
        ownerScope,
        ...(registryId !== undefined && { registryId }),
      };
    },

    async getTask<TResult = unknown>(taskId: string, scope: TaskRegistryScope): Promise<TaskRecord<TResult> | null> {
      if (scope.registryId !== undefined && scope.registryId !== registryId) return null;
      const { rows } = await query(
        'getTask',
        `SELECT task_id, tool, account_id, owner_scope, status, status_message, result, error, progress, has_webhook, created_at, updated_at
         FROM ${table} WHERE task_id = $1 AND registry_namespace = $2 AND account_id = $3 AND owner_scope = $4`,
        [taskId, namespace, scope.accountId, scope.ownerScope]
      );
      if (rows.length === 0) return null;
      return rowToRecord<TResult>(rows[0] as unknown as DbTaskRow);
    },

    async list(listOpts: { accountId: string; ownerScope: string }): Promise<{ tasks: TaskRecord[] }> {
      const { rows } = await query(
        'list',
        `SELECT task_id, tool, account_id, owner_scope, status, status_message, result, error, progress, has_webhook, created_at, updated_at
         FROM ${table}
         WHERE registry_namespace = $1 AND account_id = $2 AND owner_scope = $3
         ORDER BY created_at DESC, task_id DESC`,
        [namespace, listOpts.accountId, listOpts.ownerScope]
      );
      return { tasks: rows.map(row => rowToRecord(row as unknown as DbTaskRow)) };
    },

    async complete<TResult>(taskId: string, scope: TaskRegistryScope, result: TResult): Promise<TaskMutationOutcome> {
      if (scope.registryId !== undefined && scope.registryId !== registryId) return { outcome: 'not_found_in_scope' };
      let json: string;
      try {
        json = safeStringify(result, taskId);
        assertResultSize(json, taskId);
      } catch (payloadError) {
        return await classifyAfterInvalidPayload('complete', taskId, scope, payloadError);
      }
      const { rows } = await query(
        'complete',
        `WITH candidate AS MATERIALIZED (
           SELECT status FROM ${table}
           WHERE task_id = $1 AND registry_namespace = $2 AND account_id = $3 AND owner_scope = $4
           FOR UPDATE
         ), updated AS (
           UPDATE ${table}
           SET status = 'completed', result = $5::jsonb, updated_at = NOW()
           WHERE task_id = $1 AND registry_namespace = $2 AND account_id = $3 AND owner_scope = $4
             AND EXISTS (
               SELECT 1 FROM candidate
               WHERE status NOT IN ('completed', 'failed', 'rejected', 'canceled')
             )
           RETURNING 1
         )
         SELECT CASE WHEN EXISTS (SELECT 1 FROM updated) THEN 'applied' ELSE 'already_terminal' END AS outcome,
                candidate.status
         FROM candidate`,
        [taskId, namespace, scope.accountId, scope.ownerScope, json]
      );
      return mutationOutcome(rows);
    },

    async fail(
      taskId: string,
      scope: TaskRegistryScope,
      error: AdcpStructuredError,
      result?: unknown
    ): Promise<TaskMutationOutcome> {
      if (scope.registryId !== undefined && scope.registryId !== registryId) return { outcome: 'not_found_in_scope' };
      let errorJson: string;
      let resultJson: string | undefined;
      try {
        errorJson = safeStringify(error, taskId);
        resultJson = result === undefined ? undefined : safeStringify(result, taskId);
        assertResultSize(errorJson, taskId);
        if (resultJson !== undefined) assertResultSize(resultJson, taskId);
      } catch (payloadError) {
        return await classifyAfterInvalidPayload('fail', taskId, scope, payloadError);
      }
      const { rows } = await query(
        'fail',
        `WITH candidate AS MATERIALIZED (
           SELECT status FROM ${table}
           WHERE task_id = $1 AND registry_namespace = $2 AND account_id = $3 AND owner_scope = $4
           FOR UPDATE
         ), updated AS (
           UPDATE ${table}
           SET status = 'failed', error = $5::jsonb, result = $6::jsonb, status_message = $7, updated_at = NOW()
           WHERE task_id = $1 AND registry_namespace = $2 AND account_id = $3 AND owner_scope = $4
             AND EXISTS (
               SELECT 1 FROM candidate
               WHERE status NOT IN ('completed', 'failed', 'rejected', 'canceled')
             )
           RETURNING 1
         )
         SELECT CASE WHEN EXISTS (SELECT 1 FROM updated) THEN 'applied' ELSE 'already_terminal' END AS outcome,
                candidate.status
         FROM candidate`,
        [taskId, namespace, scope.accountId, scope.ownerScope, errorJson, resultJson ?? null, error.message]
      );
      return mutationOutcome(rows);
    },

    async updateProgress(
      taskId: string,
      scope: TaskRegistryScope,
      progress: TaskHandoffProgress
    ): Promise<TaskMutationOutcome> {
      if (scope.registryId !== undefined && scope.registryId !== registryId) return { outcome: 'not_found_in_scope' };
      let json: string;
      try {
        json = safeStringify(sanitizeTaskProgressForStorage(progress), taskId);
      } catch (payloadError) {
        return await classifyAfterInvalidPayload('updateProgress', taskId, scope, payloadError);
      }
      const { rows } = await query(
        'updateProgress',
        `WITH candidate AS MATERIALIZED (
           SELECT status FROM ${table}
           WHERE task_id = $1 AND registry_namespace = $2 AND account_id = $3 AND owner_scope = $4
           FOR UPDATE
         ), updated AS (
           UPDATE ${table}
           SET progress = $5::jsonb,
               status = CASE WHEN status = 'submitted' THEN 'working' ELSE status END,
               updated_at = NOW()
           WHERE task_id = $1 AND registry_namespace = $2 AND account_id = $3 AND owner_scope = $4
             AND EXISTS (
               SELECT 1 FROM candidate
               WHERE status NOT IN ('completed', 'failed', 'rejected', 'canceled')
             )
           RETURNING 1
         )
         SELECT CASE WHEN EXISTS (SELECT 1 FROM updated) THEN 'applied' ELSE 'already_terminal' END AS outcome,
                candidate.status
         FROM candidate`,
        [taskId, namespace, scope.accountId, scope.ownerScope, json]
      );
      return mutationOutcome(rows);
    },

    _registerBackground(taskId: string, scope: TaskRegistryScope, completion: Promise<void>): void {
      const backgroundKey = JSON.stringify([scope.accountId, scope.ownerScope, taskId]);
      const composed: Promise<void> = completion.then(
        () => {
          if (backgrounds.get(backgroundKey) === composed) backgrounds.delete(backgroundKey);
        },
        () => {
          if (backgrounds.get(backgroundKey) === composed) backgrounds.delete(backgroundKey);
        }
      );
      backgrounds.set(backgroundKey, composed);
    },

    async awaitTask(taskId: string, scope: TaskRegistryScope): Promise<void> {
      if (scope.registryId !== undefined && scope.registryId !== registryId) return;
      const pending = backgrounds.get(JSON.stringify([scope.accountId, scope.ownerScope, taskId]));
      if (pending) await pending;
    },

    async _awaitTaskUnsafe(taskId: string): Promise<void> {
      const pending = Array.from(backgrounds.entries())
        .filter(([key]) => (JSON.parse(key) as [string, string, string])[2] === taskId)
        .map(([, completion]) => completion);
      await Promise.all(pending);
    },
  } satisfies TaskRegistry;
}
