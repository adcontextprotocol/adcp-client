---
'@adcp/sdk': minor
'@adcp/reporting-storage': minor
---

Reporting subscriptions (experimental `media_buy.reporting_subscriptions`): the coverage function, engine, principal runtime, ledger and managed delivery follow the AdCP 3.3.0-beta.3 rules. All 120 canonical coverage vectors pass.

- **Flights and cancellation (adcp#8617, #8618).** A buy's stop time uses `cancellation_effective_at`, the delivery stop under a cancellation, when present. Flight values at each period's end come from the buy's wire `flight_history`. **Breaking:** the non-wire `prior_flights` coverage input and `ReportingSubscriptionPriorFlightV1` are removed. Pass `flight_history` (`ReportingSubscriptionFlightHistoryEntryV1`) from `get_media_buys` instead.
- **Billing stubs (adcp#8617).** A cutover onto a billing feed whose schedule has no boundary at E owes `[E, first boundary)` as one stub period. Owed rows, grouped obligations, ledger obligations and the wire `reporting_obligation` carry `stub: true`.
- **Re-grants (adcp#8618).** The grant journal serves `authorization.regranted_at` on `list_accounts` and `sync_accounts` for a chain that continued past a loss of authority. **Breaking:**
  - `engine.observeGrants` now returns `{ authorized_at, regranted_at? }` per account.
  - The host account fact's `granted_at` is renamed `regranted_at`, the wire name.
- **Sticky resolution (adcp#8619).** Each package resolves once per (buy, version), at the later of `accepted_at` and `confirmed_at`, among the offerings available then. It keeps that resolution until the offering is withdrawn. New: `resolveReportingSubscriptionPackageV1`. The managed path reads each package's `reporting_delivery_offering_ids` snapshot from `get_media_buys`.
- **Admission (adcp#8619).** Under `max_accounts`, admission is sticky and ordered by `authorized_at`, then `account_id`. Accounts with another open exception keep their place. A deactivation releases its slots.
- **Membership in place (adcp#8619).** Adding or removing `account_ids`, or changing `exclude_account_ids`, keeps the version. The engine records each edit per account as an `excluded_by_buyer` interval. Changing the scope kind or `operator_domains` still needs a new version, and `client.reporting.subscribe` auto-versions accordingly.
- **Several feeds per purpose (adcp#8619).**
  - Pacing and analytics allow several subscriptions per account and purpose. Where two resolve one offering for a package, the lower `subscription_id` owes it, and the other records a package-level `overridden` exception.
  - Billing stays one per account at a scope level, and must use `match: exact` with `dimensions`.
- **`destination_overrides` (adcp#8619).**
  - Each override is validated.
  - The readback carries `destination_override_refs`.
  - Managed delivery binds each account to its routed destination and template. New: `reportingSubscriptionDestinationForAccount`, plus `ReliableReportingSubscriptionBindingInputV1.destination`.
- **Paged readback (adcp#8619).**
  - Lists of any length are kept.
  - The response lists 1,000 accounts inline, each list with its total.
  - `get_principal` `reporting_subscription_page` pages `accounts_with_exceptions`, `accounts_unauthorized` and `prior_versions`.
  - `onReadbackOverflow` and `readback_overflow` are deprecated and never report.
- **Partial grants (adcp#8619).** With subscriptions, `sync_reporting_status` (SDK service) and `sync_reporting_receipts` (`@adcp/reporting-storage` service) refuse a task that the account's `authorization.allowed_tasks` leaves out with `SCOPE_INSUFFICIENT`. New: `assertReportingTaskGrantedV1`.
- **Delivered rows (adcp#8619).** Creating a service with subscriptions refuses a managed-delivery offering whose `reporting_profile.primary_keys` omit `account_id`.
- **Period arithmetic (adcp#8622).**
  - Each local date's first instant is always a boundary of a sub-daily local schedule, so `PT24H` equals `P1D` where midnight doesn't exist.
  - Reactivation resumes at the later of the reactivation instant and the end of the last period owed before the deactivation.
- **Account requests (adcp#8620).** `accounts.ensure` outcomes carry the request's `resolution`, `effective_at` and `not_carried_over`. The account's money terms are on `account`.
