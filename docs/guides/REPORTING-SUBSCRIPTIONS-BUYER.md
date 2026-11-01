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

`client.reporting.reconcile()` answers "what does this seller owe me, and where is it?" from wire reads only. Never compute periods yourself.

```ts
const report = await client.reporting.reconcile({ since: '2026-11-01', grace: 'PT1H' });
report.definitive; // every account's reads completed: roster, buys, ledger
report.summary; // { owed, delivered, pending, late, missing_obligation, withheld, not_owed }
for (const line of report.periods.filter(p => p.responsible_party === 'seller')) {
  console.log(line.account_id, line.period.start, line.status, line.reason, line.message);
}
```

- **The roster follows the subscriptions.** `list_accounts` intersected with each subscription's scope, read on every run; there is no account list to keep. `accounts: ['acc_a']` narrows it.
- **`PeriodLine`.** One line per owed obligation, with wire-style keys: `account_id`, `subscription_id`, `subscription_version`, `offering_id`, `report_definition_id`, `media_buy_ids`, `period` (`start`, `end`, `timezone`), `status`, `reason` (the spec's reason code), `responsible_party` and `message`, plus `expected_at`, `reporting_obligation_id`, `reporting_revision_id` and `finality` when the seller's ledger has them.
- **Status.** `delivered`: a current revision of the required finality exists. `pending`: the seller has not planned it yet but is inside `grace` (default `PT1H`), or planned it and is before `expected_at`. `late`: past `expected_at`. `missing_obligation`: the seller has no obligation for it after the grace. `withheld`: the account's authority ended (see below).
- **`includeNotOwed: true`** adds `not_owed` lines with their reason (`before_confirmation`, `after_stop`, ...) for the audit trail.
- **Revoked accounts** are unknown to every task, so their periods can't be read. They are listed in `report.accounts` as `unauthorized` with the seller's `withheld_period_count`. Pass the previous report as `previous` and its undelivered periods that ended before `unauthorized_at` are carried over as `withheld`.
- **Never smaller, only non-definitive.** A failed read marks the account `failed` and `definitive: false`; it never shrinks the owed set.
- **Fleet.** `multiClient.reporting.reconcile({ concurrency: 4 })` runs every configured seller and returns `{ bySeller, failures, definitive, summary }`.

## Explain

```ts
const traces = await client.reporting.explain({ accountId: 'acc_a', subscriptionId: 'analytics-daily', period: '2026-11-03' });
traces[0].verdict; // 'owed' | 'not_owed'
traces[0].reason; // 'before_confirmation'
traces[0].explanation; // 'Not owed: the period ends 2026-11-04T05:00Z, before mb_1 was confirmed at 2026-11-04T10:00Z.'
```

Each `CoverageTrace` (`side: 'buyer'`) is the JSON the seller's `reporting.explainCoverage` returns, with the same steps, sentences and `inputs_digest`. A `YYYY-MM-DD` period is read in each offering's zone. See [Coverage, explained](REPORTING-SUBSCRIPTIONS-COVERAGE.md#explaining-a-period). `owedSubscriptionPeriodsV1` and `explainSubscriptionCoverageV1` from `@adcp/sdk/reporting/advanced` take the same inputs directly; `createReliableReportingConsumerV1({ storage })` from `@adcp/sdk/reporting/consumer` runs the durable buyer loop.

## Events

Events are derived from state, never from a webhook body. `poll()` runs `reconcile`, reads the subscription readback and each account's `subscription_coverage[]`, and compares that snapshot with the one saved by your last `ack()`. One event per difference.

```ts
// Long-running worker: each batch is acknowledged once the loop body has run for all its events.
for await (const event of client.reporting.events({ pollEvery: 'PT5M', signal })) {
  switch (event.type) {
    case 'revision.available': await ingest(event.data.reporting_revision_id); break;
    case 'period.late': await alertSeller(event.data); break;
    case 'coverage.exception_opened': await notifyOps(event.data.account_id, event.data.reason); break;
    case 'account.unauthorized': await pauseDashboards(event.data.account_id); break;
  }
}

// Serverless: one batch per invocation, with a durable store.
const client = new AgentClient(agent, { reportingEventStore: postgresStorage({ pool }).events });
const batch = await client.reporting.poll();
await handle(batch.events);
await batch.ack();

// Webhook endpoint: the doorbell.
app.post('/adcp/webhooks', async (req, res) => {
  const verified = VerifiedWebhook.fromOutcome(await verifier(req), req.body); // throws unless verified
  const batch = await client.reporting.handleWebhook(verified); // wakes events(), or polls inline
  if (batch) { await handle(batch.events); await batch.ack(); }
  res.sendStatus(204);
});
```

- **At least once, deterministic ids.** Until `ack()` saves the snapshot nothing moves: a crash replays the same events with the same `id` (`rse_` + `sha256(agent, type, natural key, version)`, identical in the Python SDK). Deduplicate on `event.id`. A second worker acking the same snapshot gets `ReportingEventConflictError` (`REPORTING_EVENTS_CONFLICT`) and polls again.
- **Storage.** The default store is process-local. Serverless consumers pass `reportingEventStore` on the client (`postgresStorage({ pool }).events`, or `createReportingEventStore({ store })` over any `AdcpStateStore` with `putIfMatch`), or `new ReportingClient(client, { eventStore })`.
- **Partial reads never fabricate changes.** An account the run could not read keeps its previous state, and a failed roster keeps everything.
- **Cold start.** `poll({ baseline: true })` on a consumer with no snapshot records the present without emitting it.
- **Webhooks.** `handleWebhook` takes only a `VerifiedWebhook`, built by `VerifiedWebhook.fromOutcome` from a successful `verifyWebhookSignature` / `createWebhookVerifier` result or an `ok: true` `verifyWebhookRequest` result. Anything else is refused before any read.

| Event | When | `occurred_at` |
|---|---|---|
| `revision.available` / `revision.adjusted` | A period gained a current revision, or a new one replaced the one you saw (`superseded_reporting_revision_id`) | when observed |
| `period.late` / `period.missing_obligation` / `period.withheld` | A period's status became one of these | `expected_at` + grace / period end + grace / when observed |
| `coverage.exception_opened` / `coverage.exception_closed` | An `excluded[]` entry opened or closed (`reason`, `from`, `until`) | `from` / `until` |
| `account.covered` | An account entered a subscription (each rejoin is a new event) | when observed |
| `account.unauthorized` / `account.regranted` | Authority ended, or came back (`chain`: `continued` or `new`) | `unauthorized_at` / `regranted_at` |
| `subscription.state_changed` | `active`, `inactive` or `action_required` (with `pending_action`) | when observed |
| `timezone.cutover` | A `timezone_cutovers[]` entry appeared | `effective_at` |

`deriveEvents(previous, current, ...)` in `@adcp/sdk/reporting/advanced` is the diff itself, for custom consumers. `escalation` is not emitted yet.

## Receipts for billing feeds

A receipt says you verified and committed the data, so the SDK never sends one on read. The policy is off by default. With it off, delivered `consumer_receipt` (billing) periods carry `receipt: { status: 'owed_by_buyer' }` and `responsible_party: 'buyer'`, and the client warns once.

```ts
const report = await client.reporting.reconcile({
  receipts: {
    mode: 'verified', // 'off' is the default
    resourceReader: createHttpsReportingResourceReader(), referenceAllowedOrigins: ['https://schemas.seller.example'],
    commit: async revision => {
      const load = await warehouse.load(revision.resource); // idempotent on revision.resource
      return { commitRef: load.jobId }; // or 'defer', or { reject: ['ROW_COUNT_MISMATCH'] }
    },
    adjustments: async adjustment => 'defer', // billing never auto-accepts
  },
});
report.receipts?.submitted; report.receipts?.rejected; report.receipts?.deferred; report.receipts?.failed;
```

For each `consumer_receipt` obligation whose current revision is materialized and not yet receipted:

1. **The SDK verifies the materialization itself**, through `resourceReader` (the built-in manifest inspector) or your `inspect(context)` adapter. That gives the observed row count, control totals and digest.
2. **If the verifier can't read it**, or the built-in inspector refuses it, the obligation is listed in `receipts.failed` with the code and nothing is receipted. If your `inspect` adapter returns a mismatched observation, the SDK sends a `rejected` receipt with its own codes (`ROW_COUNT_MISMATCH`, ...) and doesn't call `commit`.
3. **Otherwise your `commit` runs, at least once per revision.** If it throws (listed in `failed` as `COMMIT_FAILED`), or the receipt write after it fails, the next reconcile calls it again.
   - `{ commitRef }` sends an `accepted` receipt with `consumer_commit_ref`.
   - `'defer'` sends nothing.
   - `{ reject }` sends a `rejected` receipt with your codes.

Receipt ids are stable per (obligation, revision, materialization), and a materialization that already has a receipt, accepted or rejected, is never receipted again. Canonical-digest materializations need an `inspect` adapter: the subscription buyer pins no canonicalization of its own.

**Adjustments** are offered to `adjustments(adjustment)` and always deferred, even if your hook answers otherwise. Accepting one needs the raw evidence, so it stays manual.

**`client.reporting.submitReceipts(accountId, { receipts, adjustmentReceipts })`** is the manual path: a typed wrapper over `sync_reporting_receipts`. It returns the seller's item results and throws `ReportingSubscriptionError` when the write fails.

## Accounts

`client.accounts.ensure(key, options)` resolves to an `AccountOutcome` (`ready | pending | ambiguous | rejected`); `pending` is a value, not an exception. Switch on `nextStep(outcome)`, render `outcome.action` with `formatPendingAction`, and never fetch `action.url`: show it to a person. `client.accounts.refresh()` reports what moved. See [First call to a seller](FIRST-CALL-TO-A-SELLER.md).
