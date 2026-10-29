---
'@adcp/sdk': minor
---

Buyer runtime and durable storage for AdCP 3.3 principal-level reporting subscriptions (experimental `media_buy.reporting_subscriptions`, #3504).

- `syncReportingSubscriptionsV1(client, subscriptions, options)` writes the complete `reporting_subscriptions` set through the guarded `sync_principal` lifecycle.
  - It refuses, before writing, to deactivate an active subscription by omission unless `allowDeactivation: true`. Sending `active: false` is always allowed.
  - It checks that every submitted subscription reads back at its version and activation state, and that every submitted configuration field is stored unchanged.
- `reportingSubscriptionVersionRecordsV1({ state, configurations? })` rebuilds the coverage function's version records from the readback (`accepted_at`, `prior_versions`, `deactivated_at`). Each version's configuration comes from the buyer's own records, or else from the readback: the current `configuration`, and `prior_versions[].configuration` from sellers on 3.3.0-beta.2 (adcp#8588). Pass the readback's `inactive_intervals` to `expectedSubscriptionPeriods` unchanged.
- `subscriptionExpectedReportingPeriodsV1(obligations, template)` turns owed obligations into the consumer runtime's `ExpectedReportingPeriod`s. The template must supply `coverage`; no default could match an obligation that reports packages or partial coverage.
- The reliable reporting consumer runtime accepts a per-account `subscriptionExpectations` hook. It reads the summary view's `subscription_coverage[]` before each reconciliation and reconciles the returned periods alongside configuration-derived ones.
  - The hook's `now` is the summary's `ledger_as_of` minus `subscriptionExpectationGraceMs`, never the wall clock.
  - Use it only against a seller that materializes subscription obligations in its ledger.
- `handleAuthenticatedPrincipalChanged` calls `onPrincipalChanged` (for example to re-read `get_principal` and `accounts_unauthorized` and replace the roster) and then reconciles every account of the consumer scope.
  - It drops a redelivery with an already seen `idempotency_key`.
  - Notifications that arrive during a run share one trailing run.
- `createReportingSubscriptionEngineStateStoreV1({ store })` persists the engine's sharded state on any `AdcpStateStore`: one CAS document per principal and one per (principal, account), listed per tenant. With `PostgresStateStore` it is durable and needs no migration beyond `ADCP_STATE_MIGRATION`. Subscription version history stays in the principal row and is never pruned, so `prior_versions` remain answerable for retained obligations.
