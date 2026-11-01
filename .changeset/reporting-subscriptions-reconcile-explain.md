---
'@adcp/sdk': minor
---

Reporting subscriptions (experimental, AdCP 3.3): buyers can see what a seller owes them and why.

- `client.reporting.reconcile(options)` reads the principal, capabilities, `list_accounts`, `get_media_buys` and `get_reporting_status` and returns a `ReconcileReport`: one `PeriodLine` per owed obligation with `status` (`delivered`, `pending`, `late`, `missing_obligation`, `withheld`), the spec's coverage `reason`, `responsible_party` and a `message`. The roster is `list_accounts` intersected with the subscription scopes on every run. `grace` (default `PT1H`) keeps fresh periods from reading as missing; `includeNotOwed` adds `not_owed` lines with their reasons; `previous` carries a revoked account's undelivered periods as `withheld`. A failed read makes the report `definitive: false`, never smaller.
- `multiClient.reporting.reconcile()` runs every configured seller with bounded concurrency and returns `{ bySeller, failures, definitive, summary }`.
- `client.reporting.explain({ accountId, period, ... })` returns `CoverageTrace`s (`side: 'buyer'`).
- `@adcp/sdk/reporting/advanced` adds `explainSubscriptionCoverageV1`, `classifySubscriptionPeriodsV1`, `diffCoverageTraces`, `coverageTraceForBuyer`, `EXPLAIN_TEMPLATES` and the spec's frozen reason-code vocabulary (`COVERAGE_REASONS`, `COVERAGE_RULE_ORDER`). Traces carry the same steps, sentences and `inputs_digest` as the Python SDK's `explain_subscription_coverage`.
- New guides: coverage, error reference, and migrating from account-level `reporting_delivery_configs`.
- The managed seller path asks `getMediaBuys` for every wire buy status (`pending_creatives`, `pending_start`) as well.
