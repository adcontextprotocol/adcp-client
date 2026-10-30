---
'@adcp/sdk': minor
---

Typed reporting-subscription errors (experimental `media_buy.reporting_subscriptions`, AdCP 3.3), using the shared error vocabulary (`error-codes.json` in the spec repository).

- `ReportingSubscriptionError` (package root) carries `code`, `recovery` and, for a refusal made before sending, `dispatched: false`. Its codes are `SUBSCRIPTION_WOULD_DEACTIVATE`, `DESTINATION_WOULD_REVOKE`, `SUBSCRIPTION_ID_CLASH`, `SUBSCRIPTION_OPERATOR_SCOPE_REQUIRED`, `SUBSCRIPTION_SELECTOR_UNMATCHED`, `SUBSCRIPTION_CONFLICT_EXHAUSTED` and `SUBSCRIPTION_READBACK_MISMATCH`. `syncReportingSubscriptionsV1` throws it for its deactivation guard (with `wouldDeactivate`), for conflict exhaustion and for a readback mismatch (with `readback`), where it used to throw `PrincipalLifecycleError`.
- `PrincipalLifecycleError` is now an `ADCPError`, with `code` (`PRINCIPAL_CONFLICT_EXHAUSTED`, `PRINCIPAL_TRANSPORT_FAILED`, `PRINCIPAL_SETUP_TIMEOUT`, ...), `recovery`, and `dispatched: false` when no `sync_principal` write was sent. `applied` is renamed `appliedResponse` so it can't be read as a boolean next to `dispatched`. `applied` stays as a deprecated alias, and the constructor still accepts it.
- `CoverageInputError` (`COVERAGE_INPUT_INCOMPLETE`, `COVERAGE_INPUT_INVALID`, `COVERAGE_BUDGET_EXCEEDED`, with a `detail` such as `missing_account_timezone` or `invalid_period_duration`) replaces the `TypeError` and `RangeError` the coverage function and the period calendar threw.
- The engine throws `ReportingSubscriptionEngineError` (`SUBSCRIPTION_STATE_CONFLICT`, `SUBSCRIPTION_STATE_CORRUPT`, `SUBSCRIPTION_ROSTER_INCOMPLETE`, `SUBSCRIPTION_HOST_FACT_INVALID`) at run time, and `PlatformConfigError` for configuration mistakes. `PlatformConfigError` gains `code` (`PLATFORM_CONFIG_INVALID` by default; `REPORTING_STORAGE_NOT_DURABLE` and `SUBSCRIPTIONS_REQUIRE_STANDARD_DIMENSIONS` where they apply), `configField` and `recovery: 'correctable'`.
