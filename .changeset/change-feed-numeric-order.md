---
'@adcp/sdk': patch
---

Fix reporting change-feed pages skipping changes when sequence numbers crossed a power of ten. The Postgres ledger sorted each page of `changesAfter` as text instead of numerically, so a page that spanned a boundary such as 99 to 100 returned the longer numbers first and the cursor then jumped past the shorter ones, which were never delivered. Both the account feed and the deployment-wide feed are fixed, and pages now sort on the native sequence and transaction-id columns so they also use the existing indexes.

Consumers that paged across such a boundary (host `changesAfter` reads and the BigQuery warehouse sink) may have missed changes. After upgrading, reconcile them, for example by resyncing the warehouse sink from current revisions.

Thanks to @aleksUIX for finding this (#3196, #3197).
