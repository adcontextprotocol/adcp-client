/**
 * `postgresStorage({ pool })`: every reporting store over one PostgreSQL pool (experimental, AdCP 3.3).
 *
 * The durable half of `@adcp/sdk/storage`. One object holds the reporting ledger, `sync_principal`
 * principal records, the reporting-subscription engine state (grant journal, exceptions, frozen owed
 * periods) and the buyer consumer's checkpoints and leases; managed delivery's tables live in the same
 * schema and migrate with it.
 *
 * ```ts
 * import { createReliableReportingService } from '@adcp/sdk/reporting/service';
 * // postgresStorage is exported by this package, @adcp/reporting-storage.
 *
 * const storage = postgresStorage({ pool, acknowledgeIsolatedDatabase: true });
 * await storage.checkSchema(); // refuses a schema that is behind: run `npx adcp-reporting-storage migrate`
 * const reporting = createReliableReportingService({ storage, ... });
 * ```
 *
 * Startup never changes the schema: run `npx adcp-reporting-storage migrate` before starting. Durability
 * is a property of the storage, never a flag.
 *
 * @experimental Reliable Reporting storage surface: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
import { PlatformConfigError, PostgresStateStore, createPrincipalStateStore, type PgQueryable } from '@adcp/sdk/server';
import { createReportingSubscriptionEngineStateStoreV1 } from '@adcp/sdk/reporting/advanced';
import { createPostgresReportingConsumerRuntimeV1 } from '@adcp/sdk/reporting/consumer';
import type { ReportingStorage } from '@adcp/sdk/storage';
import { MIGRATE_COMMAND, migrations, pendingMigrations, type Migration } from './migrations';
import {
  PostgresReportingLedgerStore,
  type PostgresReportingLedgerStoreOptions,
  type ReportingPgPool,
} from './postgres';

/**
 * Options for {@link postgresStorage}.
 *
 * @experimental Reliable Reporting storage surface: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export interface PostgresStorageOptions {
  /** A borrowed `pg` pool whose `search_path` selects the schema. It stays open on `close()`. */
  pool: ReportingPgPool;
  /**
   * Assert that the pool's database or schema is isolated to this deployment, which the reporting
   * ledger requires outside `NODE_ENV=test|development`.
   */
  acknowledgeIsolatedDatabase?: boolean;
  /** Further ledger options (`rowStorage`, `changeFeed`, `consumerMismatchEscalation`, ...). */
  ledger?: PostgresReportingLedgerStoreOptions;
  /**
   * The buyer consumer's stable deployment namespace, when several buyer deployments share one
   * database. Never a credential or connection string. Defaults to `"default"`.
   */
  namespace?: string;
}

/**
 * The durable {@link ReportingStorage} built by {@link postgresStorage}.
 *
 * @experimental Reliable Reporting storage surface: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export interface PostgresReportingStorage extends ReportingStorage {
  readonly durability: 'durable';
  readonly ledger: PostgresReportingLedgerStore;
  /** The borrowed pool, for compositions that build further stores over the same schema. */
  readonly pool: ReportingPgPool;
  /** The migrations this release requires, in order. */
  readonly migrations: readonly Migration[];
}

/**
 * Durable reporting storage over PostgreSQL. Run `npx adcp-reporting-storage migrate` first;
 * `checkSchema()` (which the reporting service runs before its first cycle) refuses a schema that is
 * behind with `REPORTING_SCHEMA_BEHIND`, naming the command and the pending versions.
 *
 * @experimental Reliable Reporting storage surface: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export function postgresStorage(options: PostgresStorageOptions): PostgresReportingStorage {
  const pool = options?.pool;
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
    throw new PlatformConfigError('postgresStorage requires pool: a pg Pool whose search_path selects the schema.', {
      configField: 'pool',
    });
  }
  const state = new PostgresStateStore(pool as unknown as PgQueryable);
  const consumer = createPostgresReportingConsumerRuntimeV1({ db: pool, namespace: options.namespace ?? 'default' });
  const ledger = new PostgresReportingLedgerStore(pool, {
    ...options.ledger,
    ...(options.acknowledgeIsolatedDatabase !== undefined
      ? { acknowledgeIsolatedDatabase: options.acknowledgeIsolatedDatabase }
      : {}),
  });

  return Object.freeze({
    durability: 'durable' as const,
    ledger,
    principals: createPrincipalStateStore({ store: state }),
    subscriptions: createReportingSubscriptionEngineStateStoreV1({ store: state }),
    consumer: {
      checkpointStore: consumer.checkpointStore,
      pendingConsumerStatusStore: consumer.pendingConsumerStatusStore,
      changesCheckpointStore: consumer.changesCheckpointStore,
      workLeases: consumer.workLeases,
      notifications: consumer.notifications,
    },
    pool,
    migrations: migrations(),
    async checkSchema() {
      const pending = await pendingMigrations(pool);
      if (pending.length === 0) return;
      const versions = pending.map(item => item.version).join(', ');
      const stopped = pending.filter(item => item.stoppedWorker).map(item => item.version);
      const note =
        stopped.length > 0
          ? `; ${stopped.join(', ')} ${stopped.length === 1 ? 'is a stopped-worker upgrade' : 'are stopped-worker upgrades'}, so stop every reporting worker first`
          : '';
      throw new PlatformConfigError(
        `The reporting schema is behind this release (pending: ${versions}). Run "${MIGRATE_COMMAND}" against this database${note}.`,
        { code: 'REPORTING_SCHEMA_BEHIND', configField: MIGRATE_COMMAND }
      );
    },
    async close() {
      // The pool is borrowed: its owner ends it.
    },
  });
}
