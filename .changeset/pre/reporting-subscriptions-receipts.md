---
'@adcp/sdk': minor
---

Reporting subscriptions (experimental, AdCP 3.3): the buyer receipts policy.

- `client.reporting.reconcile({ receipts: { mode: 'verified', commit, resourceReader | inspect } })` receipts `consumer_receipt` (billing) revisions only after the SDK verified the materialization itself and your `commit` returned `{ commitRef }`. `'defer'` sends nothing, and `{ reject: codes }` sends a rejected receipt. A mismatch the SDK finds is rejected without calling `commit`, and a revision it can't verify is listed in `report.receipts.failed`. Receipt ids are stable per (obligation, revision, materialization), so a materialization is never receipted twice.
- The policy is off by default. Delivered billing periods then read `receipt: { status: 'owed_by_buyer' }` with `responsible_party: 'buyer'`, and the client warns once.
- Adjustments are offered to `adjustments(adjustment)` and always deferred: billing never auto-accepts.
- `client.reporting.submitReceipts(accountId, { receipts, adjustmentReceipts })` is the typed manual wrapper over `sync_reporting_receipts`.
- `scripts/package-size-budget.json`: the SDK file ceiling rises from 8,450 to 8,500 for the stacked reporting-subscription slices.
