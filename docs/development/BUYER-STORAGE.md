# Buyer-owned storage and scheduling

## Wholesale mirrors

`refreshWholesaleFeed` and `applyWholesaleFeedWebhook` from
`@adcp/sdk/wholesale-feed-sync` start no timers. Like `WholesaleFeedSync`, they
use legacy `get_products` / `get_signals` rows; canonical `list_products`
webhooks require their corresponding representation.

```ts
const outcome = await refreshWholesaleFeed({
  client,
  store,
  scope: { agentUrl, accountKey: principalAndAccountKey, entity: 'product' },
  account: { account_id: sellerAccountId },
  conditional: capabilities.wholesaleFeedVersioning,
});
if (outcome.outcome === 'applied') await publishChanges(outcome.diff);
if (outcome.outcome === 'degraded') await recordFailure(outcome.error);
```

Implement `WholesaleFeedMirrorStore` with these transactional boundaries:

- `read(scope)` returns a consistent row/token snapshot and revision (zero when empty).
- `commit(scope, expectedRevision, change)` checks that revision, applies row
  upserts/deletes, writes tokens and metadata, clears errors, and increments the
  revision atomically. Preserve omitted webhook metadata. Persist any
  `webhookReceipt` in that same transaction.
- `recordError` checks/increments the revision without changing rows, tokens, or
  the last successful refresh time.
- `hasWebhookReceipt` recognizes committed deliveries. Retain receipts throughout
  the seller's delivery/retry window.

Writes return `false` on revision conflict. Outcomes are `unchanged`, `applied`
(with diffs), `degraded` (with `AdcpErrorInfo` and a local cause), or `superseded`.
Only publish committed diffs. Failures preserve the last good catalog. Supplied
conditional tokens must match unchanged replies; page tokens must stay consistent
and cursors advance. Versions are opaque.

Partition `accountKey` by trusted principal and account overlay, and `agentUrl`
by seller. Tenant authorization belongs to the caller. Each refresh covers one
entity; coordinate product/signal transactions externally when required.
The in-memory adapter defaults to 10,000 receipts across all scopes and rejects
new deliveries at capacity, preserving existing receipts. Its constructor accepts
a larger limit; durable stores should expire receipts after their retry window.
`WholesaleFeedSync` uses the shared refresh core with its existing timers,
search, events, and snapshot persistence.

Authenticate webhooks first. Supply the read `account` (or
`webhookScope.accountId`) and expected `webhookScope.subscriberId` when routing
subscriptions. Invalid account/entity/subscription overlays fail before writes.
Missing predecessor versions or delta rows, stale UUIDv7 events, bulk changes,
and version mismatches trigger repair. Cache-scope transitions force a full
unconditional refresh. Receipts and watermarks commit atomically after repair.
A repair that still returns the known old version remains retryable, with no receipt. CAS contention retries at most three times; `superseded` or `degraded` means
retry delivery, not acknowledgement.

## Account provisioning

Legacy `BuyerAccountStorage.get/set` adapters retain single-process coalescing.
Multi-process and crash-uncertainty protection require
`compareAndSet(key, expectedRevision, entry)`. An undefined expected revision
means insert only. Store the supplied `(expectedRevision ?? 0) + 1` revision
atomically; return `false` on conflict. Every read must return the durable
positive integer revision. Seed revisions on existing rows transactionally before enabling CAS. CAS adapters bypass local caching.

```ts
const client = new AgentClient(agent, {
  accountStorage,
  accountRegistryScope: trustedPrincipalId,
  accountRegistryOptions: {
    onDispatchStart: async dispatch => ledger.recordDispatch(dispatch),
    onResult: async dispatch => ledger.recordResult(dispatch),
  },
});
await client.accounts.ensure(reference, {
  billing: 'operator',
  idempotencyKey: persistedProvisioningKey,
});
```

Scope storage by trusted principal; keys also include seller/account identity.
The registry claims the row at the built-in client's final protocol boundary,
then awaits `onDispatchStart`, after validation/governance. Hook rejection
prevents dispatch and releases the claim. Caller keys pass unchanged; absent
keys are generated and persisted in CAS claims. Claims never expire automatically.

`onResult` is awaited before account writes for initial and submitted-completion
results. Hook rejection retains the claim even after seller success. Make ledger
writes idempotent and redact unredacted results before logging.
Direct `BuyerAccountRegistry` provision callbacks receive a fourth argument
with `idempotencyKey` and `beforeDispatch`; by default the registry invokes the
hook immediately before that callback. Send the supplied key.

Only non-synthetic terminal/correctable rejections, excluding
idempotency replay errors, release dispatched claims. SDK protocol errors, transport uncertainty (including connection/DNS
failure after entering the boundary), and crashes require caller reconciliation.
Settle the original key or recorded task against the seller, then call
`observeSync([reference], authoritativeRows)` or explicit client `syncAccounts`.
Even a matching key cannot automatically replay an in-doubt claim.

Periodic re-sync uses explicit `syncAccounts`; `ensure` returns known accounts.
On `IDEMPOTENCY_EXPIRED`, the caller may retry once with a fresh persisted key
only after establishing the previous outcome and continued authorization for
that update. The registry never rotates caller keys. Reconcile an ambiguous
fresh-key attempt instead of rotating again.

If authoritative reconciliation establishes that no account exists, release only
that settled claim through storage CAS: check its dispatch key, use its current
revision, write `status: 'failed_provisioning'`, clear `dispatch` and
`pendingTaskId`, and increment the revision. A CAS conflict requires reloading;
never release a newer claim. `observeSync` ignores `action: 'failed'` rows and
cannot substitute for this explicit reconciliation. A dispatch-start ledger
record can lack a result after crashes or credential changes; reconcile it.
