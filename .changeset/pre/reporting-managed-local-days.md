---
'@adcp/sdk': patch
---

Reliable Reporting (experimental, AdCP 3.3): the managed service now serves local-day offerings that it used to refuse (#3574).

- `account_timezone` offerings are served on the subscription path. Each account owes the periods of its own `accounts.list` `timezone`, the same periods the buyer's `reconcile` computes. The source offering must not pin `sourceTimezone.ianaTimezone`, and `resolveSource` must return the account's timezone. Without a `subscriptions` block, creating the service still refuses the offering, and an account-level `installConfiguration` refuses it. Both errors now name the subscription path. The managed path does not yet follow an account timezone change on an `account_timezone` subscription.
- `source_timezone` `P1D` offerings are served in zones whose DST change skips local midnight (America/Santiago, America/Havana, Africa/Cairo). Such a day starts at the instant its skipped midnight advances to, per `core/reporting-schedule.json` `period_generation`, and the source is asked for that one local date. The inline executor and source request conformance accept these 23- and 25-hour local days.
- `offerings.dailyAnalytics({ alignment: 'account_timezone' })` in `@adcp/sdk/testing/reporting`. The kit's reference seller reports that offering in each account's timezone and routes each offering to its own adapter.
