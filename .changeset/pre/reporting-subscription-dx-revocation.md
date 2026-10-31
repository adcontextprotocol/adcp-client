---
'@adcp/sdk': minor
---

Reporting subscriptions (experimental `media_buy.reporting_subscriptions`, AdCP 3.3): wind down instead of revoking (adcp#8607).

- `windDownGrant(current?)` and `REPORTING_WIND_DOWN_TASKS` (`@adcp/sdk/server`). The grant lists only `get_reporting_status`, `sync_reporting_receipts` and `sync_reporting_status`, with `read_only: false`. Passing the current authorization keeps its `authorized_at`, because a reduced grant continues the chain. Revocation now means no access, receipts and statuses included, so set `account.authorization = windDownGrant(account.authorization)` to end a relationship while the buyer finishes reconciling. Coverage continues while the grant lists `get_reporting_status`.
- New shared vectors, `test/fixtures/reporting-subscriptions/grant-cases.json`, cover the coverage grant rule and grant transitions through the engine: wind-down, a reduced grant without `get_reporting_status` (which reads as a revocation), dropping it from a wind-down grant, and restoring it inside retention.
