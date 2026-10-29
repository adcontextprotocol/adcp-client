---
'@adcp/sdk': minor
---

Serve AdCP 3.3 principal-level reporting subscriptions (experimental `media_buy.reporting_subscriptions`, #3504), opt-in. Without the new options every response is byte-for-byte unchanged.

**Principal runtime.** `createPrincipalLifecycle({ reportingSubscriptions: { listDeliveryConfigIds, replaceAccountConfigs?, maxSubscriptions?, accountConfigurations? } })` accepts the `sync_principal` `reporting_subscriptions` section. It validates the cross-field rules of `core/reporting-subscription.json`:

- scope shape and `exclude_account_ids`
- single-account `period_timezone`
- billing requiring official finality and `consumer_receipt`, and `consumer_receipt` requiring a destination
- a destination that exists after the same request, with `path_template` placeholders and `{account_id}` rules for multi-account and shared destinations
- duplicate ids, the `delivery_config_id` namespace clash, and same-level overlap

Versioning follows the spec: a version changes only for semantic changes; each version records `accepted_at`, and earlier versions stay readable in `prior_versions`; `active` and `replace_account_configs` change in place. Omission or `active: false` deactivates as a cutover, and a reactivation is recorded. `replace_account_configs` is applied once per version through the host hook. `dry_run` and `expected_configuration_version` behave as for the other sections. The readback is `core/reporting-subscription-state.json`, including `action_required` when the destination needs action. `principal.changed` gains reason `reporting_subscription_changed`. The runtime exposes `capabilities` (the `adcp.principal` block), `listReportingSubscriptions`, `reportingSubscriptionIds` (for the reverse namespace check in `sync_accounts`) and `recordReportingSubscriptionCoverage`.

**Coverage engine.** `createReportingSubscriptionEngineV1` (from `@adcp/sdk/reporting/service`) takes host hooks `listAuthorizedAccounts`, `listAccountBuys`, `resolveRevocationInstant`, `isPeriodDelivered` and, optionally, `listAccountDeliveryConfigs`, over a store sharded into one CAS document per principal and per account. From them it maintains:

- grants and revocations
- `max_accounts` slots, kept in a deterministic order (served accounts keep their slots, then byte order)
- precedence: the caller's own account-level configuration, then its own `account_ids` subscription
- `offering_unsupported` (buy- and package-level), `excluded_by_buyer`, `capacity`, `overridden` and `action_required` exceptions opened and closed at cutover instants
- timezone cutovers, and re-grant gaps unless `backfill_on_regrant`

It publishes `accounts_with_exceptions` and `accounts_unauthorized`, with `last_owed_period_end` and `withheld_period_count`. It serves `subscription_coverage[]`, `owedPeriods`/`owedObligations` (computed with the same `expectedSubscriptionPeriods` rule buyers run), the receipt roster, and the post-loss receipt window (`acceptsReceipt`).

**Service and capabilities.** `createReliableReportingService({ reportingSubscriptions: { engine, resolvePrincipal } })` advertises `configuration_tasks` and the `subscriptions` block and adds `subscription_coverage[]` to summary and periods views. `createAdcpServerFromPlatform` passes `capabilities.principal` through as `adcp.principal`, adds `protocol.principal` and `media_buy.reporting_subscriptions` to `experimental_features`, and refuses to construct when subscriptions are advertised without the `reporting_subscriptions` section. Callers pinned below 3.3 see neither the 3.3 registration fields nor that section. `createAdcpServer` accepts `capabilities.principal`.

Conforms to adcontextprotocol/adcp#8585:

- The readback lists `inactive_intervals`.
- The engine publishes per-offering `gaps[]` and `timezone_cutovers[]`, with `previous_timezone`, when offerings' boundaries differ.
- A host's `authorized_at` is the start of the authorization chain, so a re-grant inside retention is stamped when authority is observed again.
- `createReliableReportingService({ reportingSubscriptions })` requires `standard_dimensions` on every offering.

Elapsed history is immutable:

- Owed periods are frozen as they elapse and never recomputed. Pruning retained exceptions and obligations past `status_retention_days` never re-owes or drops an elapsed period.
- A product or package edit, or a withdrawn offering, applies from the E of its observation; periods of that buy starting earlier keep resolving from the buy as it was.
- Change instants come from source data: `granted_at` on a re-grant, `timezone_changed_at` on a zone change, `resolveRevocationInstant` for a revocation, and the overriding configuration's `active_until`. Reconcile time is used only where the change itself is first observed.

Also in this release:

- The runtime requires `listDeliveryConfigIds`, the namespace clash check. Pass `accountConfigurations: false` to opt out.
- It applies `replace_account_configs` only after the section commits, and retries the hook on the next sync if it failed.
- It rejects a destination transport change without a version change.
- It rejects more than 64 inactive intervals rather than truncating.
- It rejects shared `path_template`s that can expand to the same path.
- `prior_versions[]` carries each version's `configuration` (adcp#8588).
- `recordReportingSubscriptionCoverage` rejects lists over the readback's 1000-entry limit and does not bump `configuration_version`. `engine.reconcile` isolates a subscription that exceeds the limit: that subscription keeps its last published lists, the others still update, and the pass reports it in `readback_overflow` and through `onReadbackOverflow`.
- The receipt roster is scoped by tenant.

Responses served at 3.3.0-beta.1 omit the fields that release's closed schemas don't define (`standard_dimensions`, `unmapped_dimensions`, `inactive_intervals`, `previous_timezone`, per-offering `offering_id`). Each field is emitted only when the schema bundle the caller is served defines it, so a bundle that lacks it, or an unknown served version, never emits it.
