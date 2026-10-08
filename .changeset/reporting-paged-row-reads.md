---
'@adcp/sdk': minor
---

Reporting exact reads now page rows instead of loading whole revisions. `ReportingLedgerStore` gains optional `getRevisionMetadata` and `readRevisionRows({reporting_revision_id, account_id, offset, limit})`; `PostgresReportingLedgerStore` slices rows inside PostgreSQL. `createReportingDeliveryHandler` reads only the requested page and takes `total_count` from the revision binding. The `get_reporting_status` `revision` view returns `reporting_rows` inline only for revisions up to `REPORTING_STATUS_REVISION_VIEW_MAX_ROWS` (10,000) rows; larger revisions omit the field and are paged through `get_media_buy_delivery`. Custom stores without the new methods keep working through `getRevision`.
