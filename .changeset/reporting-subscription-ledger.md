---
'@adcp/sdk': minor
'@adcp/reporting-storage': minor
---

The reporting ledger now holds subscription obligations for AdCP 3.3 principal-level reporting subscriptions (experimental `media_buy.reporting_subscriptions`, #3504).

- `producer.planSubscriptionObligations({ account_id, principal, subscriptionId, configurations, obligations, owedThrough })` writes one subscription's frozen owed set into the ledger.
  - It installs one generation per (account, owning principal, subscription_id, subscription_version, resolved offering). The generation's `delivery_config_id` is the `subscription_id` and its `delivery_config_version` is the `subscription_version`. A changed generation throws `ReportingConfigurationImmutableError`.
  - Each obligation carries its own period, `media_buy_ids` frozen at its `scope_resolved_at` (the period end) and constituents. Its `periodOrdinal` is the period start in whole seconds. Periods are never grid-filled.
  - It then advances the mutable `owedSet.through` horizon on every generation the subscription owns on the account.
- Subscription generations carry an immutable `subscription` block (`tenantId`, `principalId`, `subscriptionId`, `offeringId`, `ownership: 'owed_set'`) and a mutable `owedSet`. Account generations keep exactly their previous ids and fingerprints.
- Completeness of an owed-set generation is its `owedSet.through` horizon, not ordinal counting. A gap is a period that is not owed, so it never raises a continuity error. A scope whose end is past the horizon reports `scope_closed: false` and keeps `coverage_complete: true`.
- Caller isolation: `get_reporting_status`, `get_media_buy_delivery` and `sync_reporting_status` take `resolveSubscriptionPrincipal`. A caller sees account generations plus only its own subscription generations and obligations, and nothing of another principal's. Without it no subscription generation is visible. Snapshot queries carry `subscription_principal`.
- Subscription obligations emit `offering_id` to callers served AdCP 3.3. `sync_reporting_status` accepts a status without `reporting_obligation_id` against a subscription generation only when it names an existing owed obligation.
- `ReportingLedgerStore` gains optional `recordOwedSetProgress` and `findObligationByOrdinal` methods. A store must implement `recordOwedSetProgress` to hold subscription generations.
- `@adcp/reporting-storage`: `REPORTING_LEDGER_MIGRATION` adds `adcp_reporting_configurations.subscription_key` (empty for account generations). It replaces the three-column generation constraint with a unique index on `(account_id, delivery_config_id, delivery_config_version, subscription_key)`. The migration is additive and idempotent, and existing rows keep their uniqueness. `PostgresReportingLedgerStore` implements the new methods and applies `subscription_principal` to every snapshot.
