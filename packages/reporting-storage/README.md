# @adcp/reporting-storage

Storage for AdCP Reliable Reporting. It holds the implementations that sit behind the protocol layer in
[`@adcp/sdk`](https://www.npmjs.com/package/@adcp/sdk): the PostgreSQL ledger store, revision row storage with GCS, S3
and Azure Blob providers, managed delivery, notification activity, the BigQuery warehouse sink, and the production
composition that wires them together.

This package is **pre-1.0 and every export is `@experimental`**: breaking changes ship in minor releases, announced in
the changelog with a migration note. Pin it with `~` (for example `~0.1.0`). See the
[stability policy](https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md).

## Install

```bash
npm install @adcp/sdk @adcp/reporting-storage pg
```

`@adcp/sdk` is a **peer dependency** (`^16.0.0-beta.0`). The store, its errors and the protocol handlers share types and
symbol-keyed guards, so the host must have exactly one copy of it. The cloud SDKs are optional peers: install only the
ones you use.

| You use                    | Also install                    |
| -------------------------- | ------------------------------- |
| `@adcp/reporting-storage/gcs`    | `@google-cloud/storage` (`^7.22.0 \|\| ^8.2.0`) |
| `@adcp/reporting-storage/s3`     | `@aws-sdk/client-s3` (`^3.700.0`) |
| `@adcp/reporting-storage/azure`  | `@azure/storage-blob` (`^12.23.0`) |
| `@adcp/reporting-storage/bigquery` | `@google-cloud/bigquery` (you pass the client in) |

## Subpaths

| Import                                | What it holds                                                                                                  |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `@adcp/reporting-storage`             | `PostgresReportingLedgerStore` and its migrations, row storage, object writes, the host change feed, maintenance |
| `@adcp/reporting-storage/managed`     | managed-delivery runtime, `PostgresReportingManagedDeliveryStore`, the adapter contract and router             |
| `@adcp/reporting-storage/notifications` | notification activity stores, checkpoints and runtime                                                        |
| `@adcp/reporting-storage/service`     | `createPostgresReliableReportingProductionService`                                                             |
| `@adcp/reporting-storage/gcs`         | GCS fence, reader, managed-delivery adapter and row-object provider                                            |
| `@adcp/reporting-storage/s3`          | S3 row-object provider                                                                                         |
| `@adcp/reporting-storage/azure`       | Azure Blob row-object provider                                                                                 |
| `@adcp/reporting-storage/bigquery`    | BigQuery warehouse sink                                                                                        |

The protocol layer stays in `@adcp/sdk`: the `ReportingLedgerStore` interface, the protocol handlers, the producer,
`createReliableReportingService`, row encoding and digests, `@adcp/sdk/reporting/consumer` and `@adcp/sdk/reporting/source`.

## Use

```ts
import { Pool } from 'pg';
import { createReliableReportingService } from '@adcp/sdk/reporting/service';
import { PostgresReportingLedgerStore, REPORTING_LEDGER_MIGRATION, reportingLedgerMaintenance } from '@adcp/reporting-storage';

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
