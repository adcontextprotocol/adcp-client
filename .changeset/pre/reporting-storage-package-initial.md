---
'@adcp/reporting-storage': minor
---

Initial release of `@adcp/reporting-storage`: the Reliable Reporting storage implementations, split out of `@adcp/sdk` (adcp-client#3286) so they release on their own version line.

It holds `PostgresReportingLedgerStore` and its migrations, row storage (PostgreSQL and object kinds, the provider contract, the conformance suite and the filesystem provider), object writes, the host change feed and ledger maintenance (`@adcp/reporting-storage`); the managed-delivery runtime, store and adapter router (`/managed`); notification activity (`/notifications`); `createPostgresReliableReportingProductionService` (`/service`); the GCS, S3 and Azure providers (`/gcs`, `/s3`, `/azure`); and the BigQuery warehouse sink (`/bigquery`). `reportingLedgerMaintenance` builds the `maintenance` option of `createReliableReportingService` for a PostgreSQL ledger.

`@adcp/sdk` (`^16.0.0-beta.0`) is a peer dependency, so the host holds one copy of the protocol layer. `@aws-sdk/client-s3`, `@azure/storage-blob` and `@google-cloud/storage` are optional peers. The package ships CommonJS and ESM builds with declarations for both.

The package starts at `0.0.0` so this changeset sets its first version: under pre-release mode it publishes as `0.1.0-beta.0` on the `beta` dist-tag. It is pre-1.0 on purpose: every export is `@experimental`, breaking changes ship in minor releases with a migration note, and the first stable release is `1.0.0` once the surface has run at a production adopter (`docs/guides/REPORTING-STABILITY.md`). Pin it with `~`.

Moving from `@adcp/sdk/reporting/*`? See `docs/migration-reporting-storage-package.md` for the import mapping.
