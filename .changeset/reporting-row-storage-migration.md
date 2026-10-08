---
'@adcp/sdk': minor
---

Add `REPORTING_ROW_STORAGE_MIGRATION` and `probeReportingRowStorageSchemaV1` to `@adcp/sdk/reporting/ledger`. The migration (PostgreSQL 13+, idempotent, applied after `REPORTING_LEDGER_MIGRATION`) creates the shared row-storage tables: a persistent installation identity, immutable row-storage bindings, row sets binding each revision's or adjustment's chunk manifest digest and location, per-chunk manifests, content-addressed PostgreSQL chunk bodies with a database-enforced SHA-256 check, and fenced write intents for external uploads. Triggers keep content columns immutable while allowing guarded location and state changes. No store reads or writes these tables yet.
