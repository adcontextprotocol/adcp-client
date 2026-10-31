---
'@adcp/sdk': minor
---

Reporting subscriptions (experimental `media_buy.reporting_subscriptions`, AdCP 3.3): the grant journal is the one source of `authorized_at`.

- **Served value.** With the managed `subscriptions` block, the service serves the journal's `authorization.authorized_at` on `list_accounts` and `sync_accounts` to callers holding subscriptions. The derived roster reads the same value, so buyers read what coverage uses.
- **Journal rules.** A host value is adopted the first time a chain is observed, and an omitted one is stamped. A value that moves an open chain earlier is refused and logged as `authorized_at_regressed`. A re-grant inside `status_retention_days` continues the chain; a later one starts a new chain.
- **`service.grants.changed({ principal, accountId, at, authorized, allowedTasks?, timezone?, operator? })`** pushes a grant change for an exact instant.
- **Engine.** `engine.observeGrants(principal, observations)` exposes the journal (`@adcp/sdk/reporting/advanced`). `authorizationChanged` applies the chain rule to pushed re-grants. `resolveRevocationInstant` is optional: without it, a revocation is dated when it was observed.
