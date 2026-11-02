# Error reference

Every SDK error carries `code` and `recovery` (`transient`, `correctable` or `terminal`). Its message ends with the fix. The codes are the spec's frozen `error-codes.json` (`static/compliance/source/test-vectors/reporting-subscriptions/`); the Python SDK's guide has the same title and table.

**`dispatched`.** `dispatched: false` means no bytes of the task left the process, so the operation certainly had no effect on the seller. Check it with `isPreDispatchError(error)`. The property is absent when the call may have reached the seller, and on local computations and configuration checks.

| Code | Class | `dispatched` | `recovery` | Fix |
|---|---|---|---|---|
| `SUBSCRIPTION_WOULD_DEACTIVATE` | `ReportingSubscriptionError` | `false` | correctable | use `unsubscribe()`, or pass `allowDeactivation: true` |
| `DESTINATION_WOULD_REVOKE` | `ReportingSubscriptionError` | `false` | correctable | pass `allowRevocation: true` |
| `SUBSCRIPTION_ID_CLASH` | `ReportingSubscriptionError` | `false` | correctable | rename; the message names the clashing `delivery_config_id` |
| `SUBSCRIPTION_OPERATOR_SCOPE_REQUIRED` | `ReportingSubscriptionError` | `false` | correctable | add `operator_domains`, or pass `acknowledgeCrossOperator: true` |
| `SUBSCRIPTION_SELECTOR_UNMATCHED` | `ReportingSubscriptionError` | `false` | correctable | adjust the selector; `nearest` names the closest offerings |
| `SUBSCRIPTION_CONFLICT_EXHAUSTED` | `ReportingSubscriptionError` | absent | transient | retry later |
| `SUBSCRIPTION_READBACK_MISMATCH` | `ReportingSubscriptionError` | absent | terminal | contact the seller; `readback` is attached |
| `REPORTING_EVENTS_CONFLICT` | `ReportingEventConflictError` (a `ReportingSubscriptionError`) | absent | transient | another worker acknowledged first; poll again |
| `COVERAGE_INPUT_INCOMPLETE`, `COVERAGE_INPUT_INVALID` | `CoverageInputError` | n/a | correctable | supply the named input (`detail` names it) |
| `COVERAGE_BUDGET_EXCEEDED` | `CoverageInputError` | n/a | correctable | narrow the input, or raise `max_periods` |
| `REPORTING_STORAGE_NOT_DURABLE` | `PlatformConfigError` | n/a | correctable | `storage: postgresStorage({ pool })`, or `NODE_ENV=development` |
| `REPORTING_SCHEMA_BEHIND` | `PlatformConfigError` | n/a | correctable | run `npx adcp-reporting-storage migrate` |
| `SUBSCRIPTIONS_REQUIRE_STANDARD_DIMENSIONS` | `PlatformConfigError` | n/a | correctable | publish `standard_dimensions` on the named offering |
| `SUBSCRIPTION_ROSTER_UNAVAILABLE` | `PlatformConfigError` | n/a | correctable | serve `accounts.list`, or supply `subscriptions.accounts` |

`reconcile()` and `explain()` are reads. A failed read of one account marks it `failed` in `report.accounts` and the report `definitive: false`; it never throws for one account. A failed `get_principal` throws `ReportingSubscriptionError` with `recovery: 'transient'`.

Account outcomes (`pending`, `ambiguous`, `rejected`) from `client.accounts.ensure` are values. Only a failure to process the call throws, with the wire code.
