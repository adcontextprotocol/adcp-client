---
'@adcp/sdk': minor
'@adcp/reporting-storage': minor
---

Owner-scoped receipts and statuses, and grant-aware coverage, for AdCP 3.3 reporting subscriptions (experimental `media_buy.reporting_subscriptions`, #3504).

- **Owner-only receipts and statuses.** A subscription obligation accepts `sync_reporting_receipts` and `sync_reporting_status` only from its owning principal. Account obligations stay open to every consumer of the account. `reportingSubscriptionReceiptAdmissibleV1` is the single rule.
  - `createSyncReportingReceiptsHandler` takes `{ resolveSubscriptionPrincipal }` and passes an `admission` to stores that declare `receiptAdmission`.
  - `PostgresReportingManagedDeliveryStore` enforces it, and a refused receipt reads exactly like an unknown reference.
  - The production service wires it from `reportingSubscriptions.resolvePrincipal`.
- **No post-revocation window.** This follows the owner's decision, ahead of the 3.3.0-beta.3 spec text; beta.2 still describes the old window. Once authority for an account ends, every task treats the account as unknown, receipts and statuses included. A seller that wants a buyer to finish reconciling keeps a reduced grant instead, for example `allowed_tasks` limited to `get_reporting_status`, `sync_reporting_receipts` and `sync_reporting_status`.
- **Coverage follows the grant.** `ReportingSubscriptionAccountFactV1.allowed_tasks` carries the grant's `authorization.allowed_tasks`. The engine covers an account only while that list includes `get_reporting_status`; `reportingSubscriptionCoverageGrantedV1` holds the rule, and a grant with no task restriction counts as all tasks. Dropping `get_reporting_status` from the grant is a loss of authority for coverage at that instant, with an `accounts_unauthorized` entry. The same applies to an `authorizationChanged` push.
- **Subscriptions off.** Nothing changes.
