---
'@adcp/sdk': minor
'@adcp/reporting-storage': minor
---

Reporting subscriptions (experimental `media_buy.reporting_subscriptions`, AdCP 3.3): the low-level building blocks move to a new `@adcp/sdk/reporting/advanced` subpath, tagged `@experimental`.

- `@adcp/sdk/reporting/advanced` exports the coverage engine (`createReportingSubscriptionEngineV1`) and its stores (`createInMemoryReportingSubscriptionEngineStoreV1`, `createReportingSubscriptionEngineStateStoreV1`), the coverage function (`expectedSubscriptionPeriods`, `groupExpectedSubscriptionPeriodsV1`, `reportingSubscriptionCoverageGrantedV1`), the period calendar, offering selection, the capability builder (`reportingConfigurationCapabilitiesV1`), the consumer bridge (`reportingSubscriptionVersionRecordsV1`, `subscriptionExpectedReportingPeriodsV1`), and the service's subscription hooks (`ReliableReportingSubscriptionsOptionsV1` and its input types, `withReportingSubscriptionCoverageV1`).
- `@adcp/sdk/reporting/service`, `/consumer` and `/ledger` no longer re-export them. Change the import path; the symbols are unchanged. The `reportingSubscriptions` option on `createReliableReportingService` is unchanged.
- `@adcp/reporting-storage` imports `withReportingSubscriptionCoverageV1` and `ReliableReportingSubscriptionBindingInputV1` from the new subpath, so it needs an `@adcp/sdk` that has it.
