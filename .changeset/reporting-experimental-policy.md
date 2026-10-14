---
'@adcp/sdk': minor
---

The Reliable Reporting storage subpaths are now experimental. Breaking changes to them ship in minor releases, announced in the changeset with a migration note, instead of forcing a major.

Experimental: every export of `@adcp/sdk/reporting/gcs`, `@adcp/sdk/reporting/s3`, `@adcp/sdk/reporting/azure` and `@adcp/sdk/reporting/bigquery`, and the storage exports of `@adcp/sdk/reporting/ledger` (PostgreSQL ledger store, row storage and row encoding, object writes, change feed, managed-delivery runtime, store and adapter router, notification activity, and the store interfaces in the ledger types) and of `@adcp/sdk/reporting/service` (retention, compaction and change-feed maintenance). They now carry an `@experimental` TSDoc tag in the published `.d.ts`, and each subpath has a module note.

Not affected, and still on normal semver: the protocol-facing handlers (`createReportingDeliveryHandler`, the status and receipt handlers), `createReportingProducer`, the health, coverage, lifecycle and schedule helpers, `createReliableReportingService` and its conformance runner, `@adcp/sdk/reporting/consumer` and `@adcp/sdk/reporting/source`. Wire behavior follows AdCP's own versioning. No runtime behavior changes.

Adopters of the experimental subpaths should pin `@adcp/sdk` with `~` or an exact version. The surface is expected to stabilize after the first production adopter runs on SDK 16 stable. See `docs/guides/REPORTING-STABILITY.md`.
