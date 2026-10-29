---
'@adcp/sdk': minor
---

Buyer runtime and durable storage for AdCP 3.3 principal-level reporting subscriptions (experimental `media_buy.reporting_subscriptions`, #3504).

- `syncReportingSubscriptionsV1(client, subscriptions, options)` writes the complete `reporting_subscriptions` set through the guarded `sync_principal` lifecycle and checks that every submitted subscription reads back at its version and activation state.
- `reportingSubscriptionVersionRecordsV1({ state, configurations })` rebuilds the coverage function's version records from the readback (`accepted_at`, `prior_versions`, `deactivated_at`) and the configurations the buyer kept per version.
- `subscriptionExpectedReportingPeriodsV1(obligations, template)` turns owed obligations into the consumer runtime's `ExpectedReportingPeriod`s.
- The reliable reporting consumer runtime accepts a per-account `subscriptionExpectations` hook. It reads the summary view's `subscription_coverage[]` before each reconciliation and reconciles the returned periods alongside configuration-derived ones. `handleAuthenticatedPrincipalChanged` calls `onPrincipalChanged` (for example to re-read `get_principal` and `accounts_unauthorized` and replace the roster) and then reconciles every account of the consumer scope.
- `createReportingSubscriptionEngineStateStoreV1({ store })` persists engine state as one CAS document per principal on any `AdcpStateStore`. With `PostgresStateStore` it is durable and needs no migration beyond `ADCP_STATE_MIGRATION`. Subscription version history stays in the principal row and is never pruned, so `prior_versions` remain answerable for retained obligations.
