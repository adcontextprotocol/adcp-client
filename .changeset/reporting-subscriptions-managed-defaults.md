---
'@adcp/sdk': minor
---

Reporting subscriptions (experimental, AdCP 3.3): the managed seller path derives more and reconciles less.

- The framework `Account` has a `timezone` field (`UTC` or IANA), served on `list_accounts`. The derived roster reads it, so `account_timezone` offerings no longer need an untyped `timezone` on the `accounts.list` items.
- `subscriptions.configure` is optional. Without it each subscription generation is derived from its source offering by `defaultSubscriptionConfiguration` (exported from `@adcp/sdk/reporting/service`): every exactly supported metric and dimension, the first attribution model and window, and a contractual cutoff at the offering's `delivery_sla` for `official` feeds. Billing feeds still need `configure`.
- `isPeriodDelivered` defaults to the service's own ledger, so `withheld_period_count` counts only periods whose obligation has no revision. It used to count every withheld period.
- The `runCycle` boundary sweep reconciles a principal only when it is due: a period of one of its schedules ended since its last reconcile, its last reconcile failed, a grant change was pushed, or `subscriptions.maxSweepIntervalMilliseconds` (one hour by default) elapsed. It used to reconcile every subscribed principal on every cycle.
