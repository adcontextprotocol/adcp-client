---
'@adcp/sdk': minor
---

`createReliableReportingService({ reportingSubscriptions })` now writes the subscription engine's obligations into the reporting ledger and executes them (experimental `media_buy.reporting_subscriptions`, #3504).

- Every `runCycle` plans each listed principal's frozen owed sets from `engine.frozenOwedSets` before it plans account configurations. It uses the same trusted path as `installConfiguration`: the subscription version gives identity, feed purpose and required finality, the resolved offering gives report definition and schedule, and `resolveSource`, `resolveCurrency` and `resolveCoverage` give route, currency and authorized constituents. Each obligation freezes the constituents of exactly the media buys it owes.
- New required options when subscriptions are advertised: `listSubscriptionPrincipals()` (for example `engine.listPrincipals(tenantId)` across your tenants) and `resolveSubscriptionConfiguration(...)` (requested metrics and dimensions, source settings, and the finality policy or canonicalization a subscription needs). New optional ones: `resolveSubscriptionAccount(accountId)` and `onPlanningError(error, context)`. A subscription that cannot be planned never stops another one or the account's own configurations. Without `onPlanningError`, `runCycle` rejects with an `AggregateError` after the rest of the cycle has run.
- The service scopes `get_reporting_status`, `get_media_buy_delivery` and `sync_reporting_status` with `resolvePrincipal`. A principal sees the account's configurations plus only its own subscription generations.
- The engine gains `frozenOwedSets(principal, { accountId? })` and `listPrincipals(tenantId)`.
- Without `reportingSubscriptions` the service is byte-for-byte unchanged. A golden transcript captured from the service before this change covers it.
