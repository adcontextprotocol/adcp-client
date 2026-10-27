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

| Import                                  | What it holds                                                                                                    |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `@adcp/reporting-storage`               | `PostgresReportingLedgerStore` and its migrations, row storage, object writes, the host change feed, maintenance |
| `@adcp/reporting-storage/managed`       | managed-delivery runtime, `PostgresReportingManagedDeliveryStore`, the adapter contract and router               |
| `@adcp/reporting-storage/notifications` | notification activity stores, checkpoints and runtime                                                            |
| `@adcp/reporting-storage/service`       | `createPostgresReliableReportingProductionService`                                                               |
| `@adcp/reporting-storage/gcs`           | GCS fence, reader, managed-delivery adapter and row-object provider                                              |
| `@adcp/reporting-storage/s3`            | S3 row-object provider                                                                                           |
| `@adcp/reporting-storage/azure`         | Azure Blob row-object provider                                                                                   |
| `@adcp/reporting-storage/bigquery`      | BigQuery warehouse sink                                                                                          |

The protocol layer stays in `@adcp/sdk`: the `ReportingLedgerStore` interface, the protocol handlers, the producer,
`createReliableReportingService`, row encoding and digests, `@adcp/sdk/reporting/consumer` and `@adcp/sdk/reporting/source`.

## Apply migrations in this order

Migrations are idempotent SQL strings. Apply them to the ledger database with your migration tool, in this order, and
only the ones whose feature you turn on.

| Order | Constant                                                                         | Import                                  | Needed for                                |
| ----- | -------------------------------------------------------------------------------- | --------------------------------------- | ----------------------------------------- |
| 1     | `REPORTING_LEDGER_MIGRATION`                                                     | `@adcp/reporting-storage`               | always                                    |
| 2     | `REPORTING_LEDGER_FINALITY_WRITER_FENCE_MIGRATION`                               | `@adcp/reporting-storage`               | the finality writer fence                 |
| 3     | `REPORTING_ROW_STORAGE_MIGRATION`                                                | `@adcp/reporting-storage`               | `rowStorage` (PostgreSQL 13+)             |
| 4     | `REPORTING_LEDGER_CHANGES_MIGRATION`                                             | `@adcp/reporting-storage`               | `changeFeed: true` (PostgreSQL 13+)       |
| 5     | `REPORTING_MANAGED_DELIVERY_MIGRATION`                                           | `@adcp/reporting-storage/managed`       | managed delivery                          |
| 6     | `REPORTING_OBJECT_WRITE_MIGRATION`, `REPORTING_OBJECT_WRITE_AUTHORITY_MIGRATION` | `@adcp/reporting-storage`               | the GCS write fence                       |
| 7     | `REPORTING_NOTIFICATION_ACTIVITY_MIGRATION`                                      | `@adcp/reporting-storage/notifications` | notification activity                     |
| 8     | `REPORTING_WAREHOUSE_SINK_MIGRATION`                                             | `@adcp/reporting-storage/bigquery`      | the BigQuery sink (after the change feed) |

`createPostgresReliableReportingProductionService` returns the ordered list it needs as `service.setup.migrations`, and
`applyMigrations` bridges it into your runner.

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
import {
  PostgresReportingLedgerStore,
  REPORTING_LEDGER_MIGRATION,
  reportingLedgerMaintenance,
} from '@adcp/reporting-storage';

const pool = new Pool({ connectionString: process.env.REPORTING_LEDGER_URL });
await pool.query(REPORTING_LEDGER_MIGRATION);

const store = new PostgresReportingLedgerStore(pool, { acknowledgeIsolatedDatabase: true });
const reporting = createReliableReportingService({
  store,
  // ...adapters, contact, retention commitments, resolvers
  maintenance: reportingLedgerMaintenance({ retention: { enabled: true } }),
});
```

For the full chain (managed delivery, notifications, one scheduler) use `createPostgresReliableReportingProductionService`
from `@adcp/reporting-storage/service`.

- [Seller reporting ledger](https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-LEDGER.md)
- [Production operations](https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-OPERATIONS.md)
- [Migrating from `@adcp/sdk/reporting/*`](https://github.com/adcontextprotocol/adcp-client/blob/main/docs/migration-reporting-storage-package.md)
