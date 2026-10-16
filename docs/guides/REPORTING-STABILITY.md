# Reliable Reporting stability policy

The Reliable Reporting storage surface is **experimental**. It is new, it has not yet run in production at an adopter, and its shape is still being settled by real use. It ships as its own package, `@adcp/reporting-storage`, on its own version line, so a breaking change there is a minor release of that package and never forces a major release of `@adcp/sdk`.

This follows how the AdCP protocol treats experimental surfaces (`x-status: experimental` in the schemas, with advance notice of breaking changes), and how other SDKs ship storage (Auth.js `@auth/pg-adapter`, LangGraph's checkpoint packages, OpenTelemetry exporters). The Python SDK is making the same split (adcp-client-python#1510).

## What is experimental

**Everything exported by `@adcp/reporting-storage`.** The package is pre-1.0 (`0.x`), and each export carries an `@experimental` TSDoc tag that links to this page. Editors show the tag on hover, and some mark the symbol as unstable.

| Subpath                                 | Holds                                                                                                              |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `@adcp/reporting-storage`               | the PostgreSQL ledger store (`PostgresReportingLedgerStore`), its migrations and errors, `sweepExpiredReportingLedgerState`, row storage (`ReportingRowStorageV1`, row bindings, the provider contract and conformance suite, the filesystem provider, the row-storage migration and probe), object writes, the host change feed (`REPORTING_LEDGER_CHANGES_MIGRATION`, change records and cursors), and ledger maintenance (retention, compaction, orphan collection, change-feed pruning, `reportingLedgerMaintenance`) |
| `@adcp/reporting-storage/managed`       | the managed-delivery runtime, `PostgresReportingManagedDeliveryStore`, the adapter contract and the adapter router |
| `@adcp/reporting-storage/notifications` | notification activity stores, checkpoints and runtime                                                              |
| `@adcp/reporting-storage/service`       | `createPostgresReliableReportingProductionService`                                                                 |
| `@adcp/reporting-storage/gcs`           | the GCS write fence, reader, managed-delivery adapter and row-object provider                                      |
| `@adcp/reporting-storage/s3`            | the S3 row-object provider                                                                                         |
| `@adcp/reporting-storage/azure`         | the Azure Blob row-object provider                                                                                 |
| `@adcp/reporting-storage/bigquery`      | the BigQuery warehouse sink                                                                                        |

**The storage interfaces in `@adcp/sdk`.** The contract the package implements stays in the SDK, and it changes together with the package, so it is experimental too: the store, transaction, lease, row-read and revision-metadata interfaces in `@adcp/sdk/reporting/ledger` (`ReportingLedgerStore` and the types it uses), `ReportingReceiptSyncStoreV1`, and the row-storage error types. Their TSDoc carries the `@experimental` tag.

### Not experimental

These follow normal semver. A breaking change to them ships in a major release of `@adcp/sdk`.

- The protocol-facing handlers: `createReportingDeliveryHandler`, `createReportingStatusHandler`, `createSyncReportingStatusHandler`, `createSyncReportingReceiptsHandler`, and the status-ingest request and response schemas.
- `createReportingProducer`, `assertSupportedReportingAuthoritativeParty` and `UnsupportedReportingFeatureError`.
- The health, coverage, lifecycle, schedule and consumer-status-identity helpers in `@adcp/sdk/reporting/ledger`, and the canonical row encoding and digests (`row-encoding`) with their golden fixtures.
- `createReliableReportingService`, its `maintenance` hook and the service conformance runner in `@adcp/sdk/reporting/service`.
- `@adcp/sdk/reporting/consumer` (buyer reconciliation and worker) and `@adcp/sdk/reporting/source` (source contract and executor). They are separate subpaths with their own `V1` contract suffixes and are not covered by this policy.

If you are unsure about a symbol, read its TSDoc. An `@experimental` tag means it is covered. No tag means it is not.

## What "experimental" means

- **Breaking changes may ship in minor releases of `@adcp/reporting-storage`.** That covers signatures, option names, stored field and column names, migrations, and defaults. While the package is `0.x`, a minor bump (`0.1` to `0.2`) is the one that may break.
- **Every such change is announced.** The changeset describes the break and includes a migration note, and the release notes carry it. Larger changes also get a `docs/migration-*.md` walkthrough.
- **The wire protocol is not affected.** Buyer-visible behavior the package implements (reporting delivery, `revision_content_sha256`, status, receipts and so on) follows AdCP's own versioning, not this policy. A change to the storage layout does not change what a buyer sees.
- **Security and correctness fixes are not held back.** If a fix needs a breaking change, it ships in a minor.

## How the two packages line up

`@adcp/reporting-storage` declares `@adcp/sdk` as a **peer dependency** (`^16.0.0-beta.0` while SDK 16 is in beta), not a dependency. The store, its errors and the handlers share types and symbol-keyed guards, so the host must hold one copy of `@adcp/sdk`. A change to a storage interface in the SDK ships with a matching storage release; the changeset for each says which pair to install. The cloud SDKs (`@aws-sdk/client-s3`, `@azure/storage-blob`, `@google-cloud/storage`) are optional peers of the storage package. `@adcp/sdk` does not import `@adcp/reporting-storage`, and a test and a lint rule keep it that way.

## How to pin

Pin the storage package with a tilde range. A caret range on a `0.x` version already stops at the next minor, but `~` states the intent and survives the move to `1.0`.

```json
{
  "dependencies": {
    "@adcp/sdk": "^16.0.0",
    "@adcp/reporting-storage": "~0.1.0"
  }
}
```

- `~0.1.0` takes patches only (recommended).
- An exact version (`"0.1.0"`) is stricter still.
- Read the changelog before widening to a new minor, and apply any migration it names.

`@adcp/sdk` itself can use a caret range as usual, because the SDK's own surface follows semver. While SDK 16 is in beta, install both packages with the `beta` dist-tag (`npm install @adcp/sdk@beta @adcp/reporting-storage@beta`) until stable releases exist.

## Migrations

Database migrations exported by `@adcp/reporting-storage` (`REPORTING_LEDGER_MIGRATION`, `REPORTING_ROW_STORAGE_MIGRATION` and the others) stay idempotent where practical, and a changeset says when you must re-apply one. See [Reliable Reporting production operations](REPORTING-OPERATIONS.md) and the [ledger guide](REPORTING-LEDGER.md).

Coming from the single-package layout (`@adcp/sdk/reporting/ledger`, `/gcs`, `/s3`, `/azure`, `/bigquery`)? See [Reliable Reporting storage moved to `@adcp/reporting-storage`](../migration-reporting-storage-package.md).

## When this will change

The surface is expected to stabilize after the first production adopter runs on SDK 16 stable. At that point `@adcp/reporting-storage` moves to `1.0.0` and the `@experimental` tags are removed in that release with a changelog note. Breaking changes need a major release from then on.

Related: [Seller reporting ledger](REPORTING-LEDGER.md), [Reliable Reporting production operations](REPORTING-OPERATIONS.md).
