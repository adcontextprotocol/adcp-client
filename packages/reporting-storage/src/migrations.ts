/**
 * Versioned migrations for reporting storage (experimental, AdCP 3.3).
 *
 * Each migration has a four-digit version and a name, is applied in order and is recorded in
 * `adcp_schema_migrations` (the same table the Python SDK's `python -m adcp migrate` uses). A migration's
 * statements are the package's existing idempotent DDL, so each statement lives in exactly one place
 * and a schema that was set up by applying the old migration constants by hand migrates cleanly: the
 * statements re-run as no-ops and the versions are recorded.
 *
 * Run them with `npx adcp-reporting-storage migrate` (`--status` lists what is applied and pending,
 * `--dry-run` prints the plan) or `migrate(pool)`. `postgresStorage({ pool })` refuses to start on a
 * schema that is behind, naming the command and the pending versions.
 *
 * Every migration runs in its own transaction under the reporting schema lock, so concurrent runners
 * serialize and a failure commits nothing of that migration.
 *
 * @experimental Reliable Reporting storage surface: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
import { ADCP_STATE_MIGRATION } from '@adcp/sdk/server';
import { REPORTING_CONSUMER_POSTGRES_MIGRATION } from '@adcp/sdk/reporting/consumer';
import { REPORTING_LEDGER_CHANGES_MIGRATION } from './change-feed';
import { REPORTING_OBJECT_WRITE_AUTHORITY_MIGRATION, REPORTING_OBJECT_WRITE_MIGRATION } from './object-writes';
import {
  REPORTING_LEDGER_FINALITY_WRITER_FENCE_MIGRATION,
  REPORTING_LEDGER_MIGRATION,
  type ReportingPgPool,
} from './postgres';
import { REPORTING_ROW_STORAGE_MIGRATION } from './row-storage-migration';
import { REPORTING_MANAGED_DELIVERY_MIGRATION } from './managed/postgres';

/**
 * The command that applies pending migrations.
 *
 * @experimental Reliable Reporting storage surface: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export const MIGRATE_COMMAND = 'npx adcp-reporting-storage migrate';

/**
 * One versioned migration.
 *
 * @experimental Reliable Reporting storage surface: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export interface Migration {
  /** Four digits, applied in ascending order. */
  readonly version: string;
  readonly name: string;
  readonly description: string;
  /**
   * An upgrade that workers of earlier releases cannot run beside: stop every reporting worker first.
   * Shown by `migrate --status` and in `REPORTING_SCHEMA_BEHIND`.
   */
  readonly stoppedWorker: boolean;
  /** The SQL this migration runs, in order. */
  statements(): readonly string[];
}

/**
 * A shipped migration and whether, and when, it was applied.
 *
 * @experimental Reliable Reporting storage surface: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export interface MigrationStatus {
  readonly migration: Migration;
  /** `null` while pending. */
  readonly appliedAt: Date | null;
  readonly pending: boolean;
}

function migration(
  version: string,
  name: string,
  description: string,
  sql: readonly string[],
  stoppedWorker = false
): Migration {
  return Object.freeze({ version, name, description, stoppedWorker, statements: () => [...sql] });
}

const MIGRATIONS: readonly Migration[] = Object.freeze([
  migration(
    '0001',
    'adcp_state',
    'The SDK state table: sync_principal principal records and reporting-subscription engine state (grant journal, exceptions, frozen owed periods). Online-safe.',
    [ADCP_STATE_MIGRATION]
  ),
  migration(
    '0002',
    'reporting_ledger',
    'The Reliable Reporting ledger: configurations, obligations, revisions, adjustments, statuses, transitions and snapshots. Online-safe.',
    [REPORTING_LEDGER_MIGRATION]
  ),
  migration(
    '0003',
    'reporting_ledger_finality_fence',
    'Fences pre-SDK-14 writers out of the transition log. Stop every reporting worker older than SDK 14 first.',
    [REPORTING_LEDGER_FINALITY_WRITER_FENCE_MIGRATION],
    true
  ),
  migration(
    '0004',
    'reporting_row_storage',
    'Verified chunked row storage for revision and adjustment rows (PostgreSQL 13+). Additive; used when rowStorage is on.',
    [REPORTING_ROW_STORAGE_MIGRATION]
  ),
  migration(
    '0005',
    'reporting_ledger_changes',
    'The host change feed (PostgreSQL 13+). Additive; written when changeFeed is on.',
    [REPORTING_LEDGER_CHANGES_MIGRATION]
  ),
  migration(
    '0006',
    'reporting_managed_delivery',
    'Managed delivery: destination authorizations, bindings, materializations and receipts. Online-safe.',
    [REPORTING_MANAGED_DELIVERY_MIGRATION]
  ),
  migration('0007', 'reporting_object_writes', 'Managed object-write bindings, plans and authority. Additive.', [
    REPORTING_OBJECT_WRITE_MIGRATION,
    REPORTING_OBJECT_WRITE_AUTHORITY_MIGRATION,
  ]),
  migration(
    '0008',
    'reporting_consumer',
    "The buyer consumer's checkpoints, pending statuses, change cursors, leases and processed notifications. Online-safe.",
    [REPORTING_CONSUMER_POSTGRES_MIGRATION]
  ),
]);

const TABLE = `CREATE TABLE IF NOT EXISTS adcp_schema_migrations (
  version TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
)`;
const LOCK = "SELECT pg_advisory_xact_lock(hashtext('adcp.reporting.schema'), hashtext(current_schema()))";

/**
 * Every migration this release ships, in version order.
 *
 * @experimental Reliable Reporting storage surface: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export function migrations(): readonly Migration[] {
  return MIGRATIONS;
}

type Queryable = Pick<ReportingPgPool, 'query'>;

/**
 * `version` → `applied_at` for every recorded migration (empty before the first migration).
 *
 * @experimental Reliable Reporting storage surface: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export async function appliedMigrations(db: Queryable): Promise<Map<string, Date>> {
  const exists = await db.query<{ present: boolean }>(
    "SELECT to_regclass('adcp_schema_migrations') IS NOT NULL AS present"
  );
  if (!exists.rows[0]?.present) return new Map();
  const result = await db.query<{ version: string; applied_at: Date }>(
    'SELECT version, applied_at FROM adcp_schema_migrations'
  );
  return new Map(result.rows.map(row => [String(row.version), new Date(row.applied_at)]));
}

/**
 * Every shipped migration with its `appliedAt`, or `null` while pending. `db` is a `pg` pool or client
 * whose `search_path` selects the schema.
 *
 * @experimental Reliable Reporting storage surface: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export async function migrationStatus(db: Queryable): Promise<MigrationStatus[]> {
  const applied = await appliedMigrations(db);
  return MIGRATIONS.map(item => {
    const appliedAt = applied.get(item.version) ?? null;
    return { migration: item, appliedAt, pending: appliedAt === null };
  });
}

/**
 * The shipped migrations not yet applied, in order.
 *
 * @experimental Reliable Reporting storage surface: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export async function pendingMigrations(db: Queryable): Promise<Migration[]> {
  return (await migrationStatus(db)).filter(item => item.pending).map(item => item.migration);
}

/**
 * Apply every pending migration in order and return what was (or, with `dryRun`, would be) applied.
 * Each migration commits on its own, so a failure leaves the earlier ones applied and the failed one
 * pending. `pool` is a `pg` pool whose `search_path` selects the schema.
 *
 * @experimental Reliable Reporting storage surface: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export async function migrate(pool: ReportingPgPool, options: { dryRun?: boolean } = {}): Promise<Migration[]> {
  const pending = await pendingMigrations(pool);
  if (options.dryRun || pending.length === 0) return pending;
  const applied: Migration[] = [];
  const client = await pool.connect();
  try {
    for (const item of pending) {
      await client.query('BEGIN');
      try {
        await client.query(LOCK);
        await client.query(TABLE);
        // Another runner may have applied it while this one waited for the lock.
        if ((await appliedMigrations(client)).has(item.version)) {
          await client.query('COMMIT');
          continue;
        }
        for (const statement of item.statements()) await client.query(statement);
        await client.query('INSERT INTO adcp_schema_migrations (version, name) VALUES ($1, $2)', [
          item.version,
          item.name,
        ]);
        await client.query('COMMIT');
        applied.push(item);
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw new Error(
          `reporting storage migration ${item.version} ${item.name} failed: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error }
        );
      }
    }
  } finally {
    client.release();
  }
  return applied;
}

/**
 * Lines describing each migration's state, for `migrate --status`.
 *
 * @experimental Reliable Reporting storage surface: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export function describeMigrations(statuses: readonly MigrationStatus[]): string[] {
  return statuses.map(item => {
    const state = item.appliedAt ? `applied ${item.appliedAt.toISOString()}` : 'pending';
    const note = item.migration.stoppedWorker ? ' (stopped-worker upgrade)' : '';
    return `${item.migration.version} ${item.migration.name}: ${state}${note}`;
  });
}
