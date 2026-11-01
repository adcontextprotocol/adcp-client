---
'@adcp/sdk': patch
---

Reporting subscriptions (experimental, AdCP 3.3): fixes found by the cross-SDK differential harness.

- `owedSubscriptionPeriodsV1` owes the billing cutover stub when the incoming schedule's first boundary at or after `authorized_at` falls after the cutover's E (#3572). The authorization start bound now compares the period start with `authorized_at`, which is the same test for calendar periods and also admits a stub that starts at E.
- An `account.timezone` that no schedule reads is no longer refused as `invalid_timezone` (#3573). It is validated where an `account_timezone` schedule reads it.
- The managed engine's `unauthorized` `gaps[]` entries always name their `offering_id` (#3577). An entry without one applies to every offering on the account, so a later version resolving offerings with other boundaries made buyers drop periods the seller owed.
