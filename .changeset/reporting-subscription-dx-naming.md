---
'@adcp/sdk': minor
'@adcp/reporting-storage': minor
---

Reporting subscriptions (experimental `media_buy.reporting_subscriptions`, AdCP 3.3): names frozen before beta.3. Every old name stays as a deprecated alias for one beta.

- `PrincipalRef { tenantId, principalId }` (package root, `@adcp/sdk/server`, `/reporting/advanced`, `/reporting/ledger`) is the one principal identity type. `PrincipalStoreScope` and `ReportingLedgerSubscriptionPrincipalV1` are deprecated aliases.
- "Owed" is the one word for what a seller must deliver (`@adcp/sdk/reporting/advanced`):
  - `expectedSubscriptionPeriods` → `owedSubscriptionPeriodsV1`, which also gains the `V1` suffix the module's other low-level symbols carry;
  - `groupExpectedSubscriptionPeriodsV1` → `groupOwedSubscriptionPeriodsV1`;
  - `ExpectedSubscriptionPeriodV1`, `ExpectedSubscriptionObligationV1` and `ExpectedSubscriptionPeriodsInputV1` → `OwedSubscriptionPeriodV1`, `OwedSubscriptionObligationV1` and `OwedSubscriptionPeriodsInputV1`;
  - `subscriptionExpectedReportingPeriodsV1` → `toExpectedReportingPeriodsV1`, which keeps "expected" because it feeds the consumer's `ExpectedReportingPeriod`.
- The principal runtime's `recordReportingSubscriptionCoverage` → `recordSubscriptionReadback`, because it writes readback lists, not `subscription_coverage`. The engine's `listPrincipals` → `listSubscriptionPrincipals`, which matches the service hook it feeds.
- `createReliableReportingService({ subscriptions })` and `createPostgresReliableReportingProductionService({ subscriptions })` replace `reportingSubscriptions`, which stays as a deprecated alias. Passing both is a `PlatformConfigError`.
