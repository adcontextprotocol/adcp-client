---
'@adcp/sdk': minor
---

Reporting subscriptions (experimental, AdCP 3.3): reconcile reports name what kept them from being definitive in the Python SDK's shape.

- `ReconcileReport.issues` is a list of `ReconcileIssue` entries (`{ code, message, account_id?, subscription_id? }`). The codes match Python's: `SUBSCRIPTION_ROSTER_UNAVAILABLE`, `SUBSCRIPTION_OFFERINGS_UNAVAILABLE`, `SUBSCRIPTION_ACCOUNT_UNREADABLE`, `SUBSCRIPTION_LEDGER_UNAVAILABLE`, `SUBSCRIPTION_ACCOUNT_NOT_COVERED`, or a coverage input code. As in Python, any issue makes the report `definitive: false`.
- Explicitly requested `accounts` that no subscription covers are now reported (`SUBSCRIPTION_ACCOUNT_NOT_COVERED`) instead of being dropped silently.
- The fleet report (`multiClient.reporting.reconcile()`) renames `failures` to `issues`: an array of `ReconcileIssue & { agent_id }`, with `SUBSCRIPTION_PRINCIPAL_UNAVAILABLE` for a seller that could not be reconciled at all.
