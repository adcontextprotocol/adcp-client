---
'@adcp/reporting-storage': patch
---

BigQuery warehouse sink (experimental): the per-revision metadata load and the `current_rows` dependency on it are now part of the documented sink contract, and `revisionsTableId` is checked to be a string (#3285).

The sink loads the rows table, then the revisions table, and `current_rows` picks each obligation's current revision from the revisions table. The TSDoc on `createBigQueryReportingWarehouseSinkV1`, `revisionsTableId`, `defaultTablesSql`, `currentRowsViewSql` and `reportingWarehouseCurrentRowsViewSqlV1`, and the BigQuery section of `docs/guides/REPORTING-LEDGER.md` and `docs/guides/REPORTING-OPERATIONS.md`, now state the load order, that the revisions table is required and must accept every column of the reference DDL, that rows can be visible before their revision metadata while `current_rows` shows only revisions whose metadata has loaded, what to query for what, and how a failed revisions load recovers (the plan is retained, the rows job is found by ID and not repeated, only the revisions job is retried, so rows are never duplicated). Tests pin the reference DDL to the metadata the sink actually loads, and assert the visibility and no-duplicate retry through the in-memory BigQuery.

One defect fixed: the identifier check was a regular expression alone, which accepts `undefined`, so an untyped caller that omitted `revisionsTableId` was sent to a table literally named `undefined` instead of failing at construction. It now throws `BigQuery revisionsTableId is invalid`. Typed callers cannot hit this, and no valid configuration changes.
