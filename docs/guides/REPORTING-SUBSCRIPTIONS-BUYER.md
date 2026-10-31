# Subscribing to reports (buyer)

`client.reporting` registers AdCP 3.3 reporting subscriptions (experimental) safely. Every write is patch-shaped over the replace-shaped wire: other subscriptions are kept byte for byte, versions are chosen for you, and nothing is deactivated by omission. `client.reporting` is on `AgentClient` and `SingleAgentClient`; the Python SDK's guide has the same title and sections.

## Subscribe

```ts
const result = await client.reporting.subscribe(
  {
    subscription_id: 'analytics-daily',
    scope: { all_authorized_accounts: true },
    operator_domains: ['wppmedia.fr'],
    selector: { feed_purpose: 'analytics', period_duration: 'P1D', required_finality: 'official', dimensions: ['package'] },
    reconciliation_mode: 'delivery_only',
    destination: { destination_id: 'reporting-archive', path_template: 'analytics/{account_id}/{period_start}' },
  },
  { registerDestination: archiveDestination }
);
result.action; // 'created' | 'updated' | 'unchanged' | 'reactivated'
result.subscriptionVersion;
```

- **Versioning.** The version is bumped only when the selector, the scope kind, the destination (including `destination_overrides`), `reconciliation_mode` or `operator_domains` change. `active`, `replace_account_configs` and membership (adding or removing `account_ids`, changing `exclude_account_ids`; adcp#8619) change in place: the seller records each membership edit per account as an `excluded_by_buyer` interval. A supplied `subscription_version` is validated.
- **Pre-dispatch checks.** These throw `ReportingSubscriptionError` with `dispatched: false`, so nothing reached the seller:
  - the scope must be explicit;
  - the destination must exist and be active;
  - a multi-account path needs `{account_id}`;
  - the id must not clash with a `delivery_config_id` (`SUBSCRIPTION_ID_CLASH`);
  - the operator scope must be safe (`SUBSCRIPTION_OPERATOR_SCOPE_REQUIRED`);
  - the selector must match an offering (`SUBSCRIPTION_SELECTOR_UNMATCHED`, with `nearest`).
- **Conflicts.** A conflicting write is re-read, re-merged and retried with a fresh key (3 attempts), then throws `SUBSCRIPTION_CONFLICT_EXHAUSTED`. The readback is verified; a mismatch throws `SUBSCRIPTION_READBACK_MISMATCH`.
- **Preview.** `client.reporting.preview(subscription)` runs the seller's dry run and returns `{ wouldBe, subscriptionVersion, offeringIds }`. `listSubscriptions()` returns the current states.

## Unsubscribe

`await client.reporting.unsubscribe('analytics-daily')` is the only way to deactivate. Subscribing again reactivates the subscription at the same version.

## Why replace needs a flag

`replaceSubscriptions(list, { deactivateOmitted: true })` is the expert complete-set write. Sending `[]` needs `deactivateAll: true`. A raw `client.syncPrincipal(...)` carrying `reporting_subscriptions` or `reporting_destinations` is checked before dispatch. It is refused with `SUBSCRIPTION_WOULD_DEACTIVATE` or `DESTINATION_WOULD_REVOKE` unless you pass `{ allowDeactivation: true }` or `{ allowRevocation: true }` as its options.

## Operator domains for agencies

An `all_authorized_accounts` subscription follows every grant, including accounts another operator grants later. When the principal spans operators, `subscribe` refuses an all-accounts scope without `operator_domains` (`SUBSCRIPTION_OPERATOR_SCOPE_REQUIRED`). Pass `{ acknowledgeCrossOperator: true }` to proceed anyway.

## Destinations

`registerDestination` upserts the named destination in the same write. Omitting a destination from a raw `syncPrincipal` revokes it for every account.

## Reconcile

`client.reporting.reconcile()` and `explain()` arrive in a later beta. Until then, `owedSubscriptionPeriodsV1` from `@adcp/sdk/reporting/advanced` computes owed periods from `get_principal`, `list_accounts` and `get_media_buys`, and `createReliableReportingConsumerV1({ storage })` from `@adcp/sdk/reporting/consumer` runs the durable buyer loop over the same storage object sellers use (`memoryStorage()`, or `postgresStorage({ pool })` from `@adcp/reporting-storage`). Never compute periods yourself.

## Events

`client.reporting.poll()`, `events()` and `handleWebhook()` arrive in a later beta. Until then, the consumer's `onPrincipalChanged` hook hears each authenticated `principal.changed` doorbell before the scope's accounts are reconciled.

## Receipts for billing feeds

The receipts policy arrives in a later beta. Submit receipts with `sync_reporting_receipts` after your warehouse commits the data, never on read.

## Accounts

`client.accounts.ensure(key, options)` resolves to an `AccountOutcome` (`ready | pending | ambiguous | rejected`); `pending` is a value, not an exception. Switch on `nextStep(outcome)`, render `outcome.action` with `formatPendingAction`, and never fetch `action.url`: show it to a person. `client.accounts.refresh()` reports what moved. See [First call to a seller](FIRST-CALL-TO-A-SELLER.md).
