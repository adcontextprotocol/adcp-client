---
'@adcp/sdk': minor
---

Reporting subscriptions (experimental `media_buy.reporting_subscriptions`, AdCP 3.3): the coverage function now runs the canonical spec vectors (adcp#8616), and two bugs they exposed are fixed.

- An `excluded[]` entry with `offering_id` removes only that offering's periods. It used to be applied to every offering, so a per-offering capacity exclusion dropped periods it didn't cover. The coverage input type gains `ReportingSubscriptionExclusionEntryV1` (`offering_id?`), and the engine's `ReportingSubscriptionExclusionV1` carries it.
- A selector `period_duration` the schedule pattern refuses, such as `P1W`, now throws `CoverageInputError` (`COVERAGE_INPUT_INVALID`, `invalid_period_duration`). It used to compute an empty owed set.
