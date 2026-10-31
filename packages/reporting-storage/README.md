# @adcp/reporting-storage

Storage for AdCP Reliable Reporting. It holds the implementations that sit behind the protocol layer in
[`@adcp/sdk`](https://www.npmjs.com/package/@adcp/sdk): the PostgreSQL ledger store, revision row storage with GCS, S3
and Azure Blob providers, managed delivery, notification activity, the BigQuery warehouse sink, and the production
composition that wires them together.

This package is **pre-1.0 and every export is `@experimental`**: breaking changes ship in minor releases, announced in
the changelog with a migration note. Pin exact versions during the SDK 17 preview; for stable storage use a patch range such as `~0.2.0`. See the
[stability policy](https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md).

## Install

```bash
# SDK 17 preview: install the matching beta train and lock the exact versions.
npm install --save-exact @adcp/sdk@beta @adcp/reporting-storage@beta pg
```

`@adcp/sdk` is a **peer dependency**. Stable storage `0.2.0` pairs with SDK `^16.5.0` (including SDK 16.6).
The next beta pair is storage `0.3.0-beta.1` with SDK `^17.0.0-beta.2`; the earlier
`0.2.1-beta.0` storage release paired with SDK `^17.0.0-beta.0`. See the
[SDK 17 migration guide](https://github.com/adcontextprotocol/adcp-client/blob/main/docs/migration-16-to-17.md#companion-packages)
for the release pairing. The store, its errors and the protocol handlers share types and
symbol-keyed guards, so the host must have exactly one copy of it. Install the pair that was published together: each
release raises the peer floor to the SDK it was built against. The cloud SDKs are optional peers: install only the
ones you use.

| You use                            | Also install                                      |
| ---------------------------------- | ------------------------------------------------- |
| `@adcp/reporting-storage/gcs`      | `@google-cloud/storage` (`^7.22.0 \|\| ^8.2.0`)   |
| `@adcp/reporting-storage/s3`       | `@aws-sdk/client-s3` (`^3.700.0`)                 |
| `@adcp/reporting-storage/azure`    | `@azure/storage-blob` (`^12.23.0`)                |
| `@adcp/reporting-storage/bigquery` | `@google-cloud/bigquery` (you pass the client in) |

## Subpaths

| Import                                  | What it holds                                                                                                                              |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `@adcp/reporting-storage`               | `postgresStorage`, the versioned migrations, `PostgresReportingLedgerStore`, row storage, object writes, the host change feed, maintenance |
| `@adcp/reporting-storage/managed`       | managed-delivery runtime, `PostgresReportingManagedDeliveryStore`, the adapter contract and router                                         |
| `@adcp/reporting-storage/notifications` | notification activity stores, checkpoints and runtime                                                                                      |
| `@adcp/reporting-storage/service`       | `createPostgresReliableReportingProductionService`                                                                                         |
| `@adcp/reporting-storage/gcs`           | GCS fence, reader, managed-delivery adapter and row-object provider                                                                        |
| `@adcp/reporting-storage/s3`            | S3 row-object provider                                                                                                                     |
| `@adcp/reporting-storage/azure`         | Azure Blob row-object provider                                                                                                             |
| `@adcp/reporting-storage/bigquery`      | BigQuery warehouse sink                                                                                                                    |

The protocol layer stays in `@adcp/sdk`: the `ReportingLedgerStore` interface, the protocol handlers, the producer,
`createReliableReportingService`, row encoding and digests, `@adcp/sdk/reporting/consumer` and `@adcp/sdk/reporting/source`.

## One storage decision: `postgresStorage({ pool })`

`postgresStorage` is the durable half of `@adcp/sdk/storage` (whose `memoryStorage()` is for development). One object
holds the reporting ledger, `sync_principal` principal records, the reporting-subscription engine state (grant journal,
exceptions, frozen owed periods) and the buyer consumer's checkpoints and leases; managed delivery's tables live in the
same schema. Durability is a property of the storage, never a flag.

```ts
import { Pool } from 'pg';
import { postgresStorage } from '@adcp/reporting-storage';
import { createReliableReportingService } from '@adcp/sdk/reporting/service';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const storage = postgresStorage({ pool, acknowledgeIsolatedDatabase: true });
await storage.checkSchema(); // refuses a schema that is behind: REPORTING_SCHEMA_BEHIND
const reporting = createReliableReportingService({ storage /* , adapters, contact, resolvers ... */ });
```

`createPostgresReliableReportingProductionService({ storage })` takes the same object instead of `db`, and
`createReliableReportingConsumerV1({ storage })` uses its `consumer` stores on the buyer side.

## Apply migrations: `npx adcp-reporting-storage migrate`

```bash
npx adcp-reporting-storage migrate --database-url "$DATABASE_URL" [--schema NAME]   # apply pending versions
npx adcp-reporting-storage migrate --status                                         # applied and pending
npx adcp-reporting-storage migrate --dry-run                                        # print the plan
```

The URL defaults to `$ADCP_DATABASE_URL`, then `$DATABASE_URL`; the command needs the `pg` driver. Each version
commits on its own under the reporting schema lock and is recorded in `adcp_schema_migrations` (the table the Python
SDK's `python -m adcp migrate` uses), so concurrent runners serialize. `migrate(pool)`, `migrationStatus(pool)`,
`pendingMigrations(pool)` and `migrations()` are the same operations in code. Startup never changes the schema:
`storage.checkSchema()` names the pending versions and this command.

| Version | Name                              | Contents (the deprecated constant that holds the same SQL)                                                 |
| ------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 0001    | `adcp_state`                      | principal records and reporting-subscription engine state (`ADCP_STATE_MIGRATION` from `@adcp/sdk/server`) |
| 0002    | `reporting_ledger`                | the ledger (`REPORTING_LEDGER_MIGRATION`)                                                                  |
| 0003    | `reporting_ledger_finality_fence` | **stopped-worker:** fences pre-SDK-14 writers (`REPORTING_LEDGER_FINALITY_WRITER_FENCE_MIGRATION`)         |
| 0004    | `reporting_row_storage`           | row storage, PostgreSQL 13+ (`REPORTING_ROW_STORAGE_MIGRATION`)                                            |
| 0005    | `reporting_ledger_changes`        | the host change feed, PostgreSQL 13+ (`REPORTING_LEDGER_CHANGES_MIGRATION`)                                |
| 0006    | `reporting_managed_delivery`      | managed delivery (`REPORTING_MANAGED_DELIVERY_MIGRATION`)                                                  |
| 0007    | `reporting_object_writes`         | the GCS write fence (`REPORTING_OBJECT_WRITE_MIGRATION`, `REPORTING_OBJECT_WRITE_AUTHORITY_MIGRATION`)     |
| 0008    | `reporting_consumer`              | the buyer consumer (`REPORTING_CONSUMER_POSTGRES_MIGRATION` from `@adcp/sdk/reporting/consumer`)           |

A schema set up by applying those constants by hand migrates cleanly: the statements are idempotent, re-run as no-ops,
and the versions are recorded. The constants stay exported as deprecated re-exports for one beta.

Two migrations are configured per deployment and stay outside the versioned set: `REPORTING_NOTIFICATION_ACTIVITY_MIGRATION`
(`@adcp/reporting-storage/notifications`, table names are configurable) and `REPORTING_WAREHOUSE_SINK_MIGRATION`
(`@adcp/reporting-storage/bigquery`, after the change feed). `createPostgresReliableReportingProductionService` returns
the notification outbox and activity SQL it needs as `service.setup.migrations`, and `applyMigrations` bridges it into
your runner.

## Which import?

| You want                                                                                  | Import from                       |
| ----------------------------------------------------------------------------------------- | --------------------------------- |
| The Core service (`createReliableReportingService`)                                       | `@adcp/sdk/reporting/service`     |
| The whole seller chain on PostgreSQL (`createPostgresReliableReportingProductionService`) | `@adcp/reporting-storage/service` |
| The protocol handlers, producer and the `ReportingLedgerStore` interface                  | `@adcp/sdk/reporting/ledger`      |
| The PostgreSQL ledger store and the `maintenance` factory                                 | `@adcp/reporting-storage`         |

## Use

```ts
import { Pool } from 'pg';
import { createReliableReportingService } from '@adcp/sdk/reporting/service';
import { postgresStorage, reportingLedgerMaintenance } from '@adcp/reporting-storage';

// After `npx adcp-reporting-storage migrate`:
const pool = new Pool({ connectionString: process.env.REPORTING_LEDGER_URL });
const reporting = createReliableReportingService({
  storage: postgresStorage({ pool, acknowledgeIsolatedDatabase: true }),
  // ...adapters, contact, retention commitments, resolvers
  maintenance: reportingLedgerMaintenance({ retention: { enabled: true } }),
});
```

For the full chain (managed delivery, notifications, one scheduler) use `createPostgresReliableReportingProductionService`
from `@adcp/reporting-storage/service`.

- [Seller reporting ledger](https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-LEDGER.md)
- [Production operations](https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-OPERATIONS.md)
- [Migrating from `@adcp/sdk/reporting/*`](https://github.com/adcontextprotocol/adcp-client/blob/main/docs/migration-reporting-storage-package.md)
