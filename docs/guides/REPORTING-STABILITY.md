# Reliable Reporting stability policy

The Reliable Reporting storage surface is **experimental**. It is new, it has not yet run in production at an adopter, and its shape is still being settled by real use. Marking it experimental lets breaking changes there ship in minor releases, with notice, instead of forcing a major release of the whole SDK.

This follows how the AdCP protocol treats experimental surfaces (`x-status: experimental` in the schemas, with advance notice of breaking changes).

## What is experimental

An export is experimental when its TSDoc carries an `@experimental` tag that links to this page. Editors show the tag on hover, and some mark the symbol as unstable.

| Subpath                        | Status                                                                      |
| ------------------------------ | --------------------------------------------------------------------------- |
| `@adcp/sdk/reporting/gcs`      | Experimental (every export)                                                 |
| `@adcp/sdk/reporting/s3`       | Experimental (every export)                                                 |
| `@adcp/sdk/reporting/azure`    | Experimental (every export)                                                 |
| `@adcp/sdk/reporting/bigquery` | Experimental (every export)                                                 |
| `@adcp/sdk/reporting/ledger`   | Partly experimental (see below)                                             |
| `@adcp/sdk/reporting/service`  | Partly experimental: retention, compaction and change-feed maintenance only |

Within `@adcp/sdk/reporting/ledger`, the experimental exports are:

- the PostgreSQL ledger store (`PostgresReportingLedgerStore`), its migrations and errors, and `sweepExpiredReportingLedgerState`;
- row storage (`ReportingRowStorageV1`, row bindings, row encoding, the row-storage migration and probe, and row-store errors) and object writes;
- the host change feed (`REPORTING_LEDGER_CHANGES_MIGRATION`, change records and cursors);
- managed delivery (the runtime, the store, the adapter contract, the adapter router and the PostgreSQL store);
- notification activity stores and checkpoints;
- the store, transaction, lease and row-read interfaces in `ledger/types`.

Within `@adcp/sdk/reporting/service`, the experimental exports are `ReportingRetentionOptionsV1`, `ReportingCompactionOptionsV1`, `ReportingChangeFeedMaintenanceOptionsV1`, `runReportingLedgerMaintenance` and the related maintenance types and error.

### Not experimental

These follow normal semver. A breaking change to them ships in a major release.

- The protocol-facing handlers: `createReportingDeliveryHandler`, `createReportingStatusHandler`, `createSyncReportingStatusHandler`, `createSyncReportingReceiptsHandler`, and the status-ingest request and response schemas.
- `createReportingProducer`, `assertSupportedReportingAuthoritativeParty` and `UnsupportedReportingFeatureError`.
- The health, coverage, lifecycle, schedule and consumer-status-identity helpers in `@adcp/sdk/reporting/ledger`.
- `createReliableReportingService`, `createPostgresReliableReportingProductionService` and the service conformance runner in `@adcp/sdk/reporting/service`.
- `@adcp/sdk/reporting/consumer` (buyer reconciliation and worker) and `@adcp/sdk/reporting/source` (source contract and executor). They are separate subpaths with their own `V1` contract suffixes and are not covered by this policy.

If you are unsure about a symbol, read its TSDoc. An `@experimental` tag means it is covered. No tag means it is not.

## What "experimental" means

- **Breaking changes may ship in minor releases.** That covers signatures, option names, stored field and column names, migrations, and defaults in the experimental exports.
- **Every such change is announced.** The changeset describes the break and includes a migration note, and the release notes carry it. Larger changes also get a `docs/migration-*.md` walkthrough.
- **The wire protocol is not affected.** Buyer-visible behavior these exports implement (reporting delivery, `revision_content_sha256`, status, receipts and so on) follows AdCP's own versioning, not this policy. A change to the SDK's storage layout does not change what a buyer sees.
- **Security and correctness fixes are not held back.** If a fix needs a breaking change, it ships in a minor.

## How to pin

Adopters of the experimental subpaths should not use a caret range, which accepts every future minor.

```json
{
  "dependencies": {
    "@adcp/sdk": "~16.0.0"
  }
}
```

- `~16.0.0` takes patches only (recommended).
- An exact version (`"16.0.0"`) is stricter still.
- Read the changelog before widening to a new minor, and apply any migration it names.

If you use only the stable surfaces, a caret range is fine as usual.

## Migrations

Database migrations exported from experimental subpaths (`REPORTING_LEDGER_MIGRATION`, `REPORTING_ROW_STORAGE_MIGRATION` and the others) stay idempotent where practical, and a changeset says when you must re-apply one. See [Reliable Reporting production operations](REPORTING-OPERATIONS.md) and the [ledger guide](REPORTING-LEDGER.md).

## When this will change

The surface is expected to stabilize after the first production adopter runs on SDK 16 stable. At that point the `@experimental` tags are removed in a minor release with a changelog note, and breaking changes need a major release from then on.

Related: [Seller reporting ledger](REPORTING-LEDGER.md), [Reliable Reporting production operations](REPORTING-OPERATIONS.md).
