# Migrating from account-level `reporting_delivery_configs`

A buyer that registered reporting per account through `sync_accounts` `reporting_delivery_configs` can move to one principal-level subscription through `client.reporting.subscribe`. The Python SDK's guide has the same title and sections.

## Precedence

A caller's own active `sync_accounts` `reporting_delivery_configs` entry for a `feed_purpose` takes precedence over its subscriptions on that account. The subscription records an `overridden` exception (`excluded:overridden` in `explain`), and the two never owe the same period. On the managed seller path, supply `subscriptions.accountDeliveryConfigs(principal, accountId)` so the engine sees those configurations.

## Overrides

Give each account configuration its `active_from`, so the exception opens at that instant. A `subscription_id` never equals a `delivery_config_id` the caller uses: they share one namespace, and `subscribe` refuses a clash before sending (`SUBSCRIPTION_ID_CLASH`).

## `replace_account_configs`

A subscription with `replace_account_configs: true` ends the caller's own account-level configurations with the same `feed_purpose` on in-scope accounts where it resolves an offering. It applies once per `subscription_version`, or when the flag changes to true. Sellers supply `subscriptions.endAccountConfigs(principal, accountId, ids, { at })` together with `accountDeliveryConfigs`; without them the flag is refused with `UNSUPPORTED_FEATURE`.

The migration a buyer runs:

```ts
await client.reporting.subscribe({ ...analyticsDaily, replace_account_configs: true });
const report = await client.reporting.reconcile({ includeNotOwed: true });
// Periods the old configurations still own read excluded:overridden until they end.
```
