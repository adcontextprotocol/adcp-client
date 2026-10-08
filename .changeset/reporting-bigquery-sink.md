---
'@adcp/sdk': minor
---

Add `@adcp/sdk/reporting/bigquery`: `createBigQueryReportingWarehouseSinkV1` loads committed reporting revisions into adopter-defined BigQuery tables. It follows the ledger's host change feed, reads rows through the verified row reader, applies an adopter `mapRow` plus standard revision columns, and loads rows then revision metadata with deterministic job IDs. Batches are planned durably (`REPORTING_WAREHOUSE_SINK_MIGRATION`) so a crash replays the same job IDs instead of duplicating rows, and failed jobs retry per table under new attempts. Ships default partitioned table DDL and a `current_rows` view that keeps each obligation's current revision. Works with any client exposing the official `@google-cloud/bigquery` surface; no new dependency.
