# Durable account sync

`sync_accounts` upserts by account identity, independently of the request's
`idempotency_key`. Re-syncing the same account days later must preserve its
`account_id` and report `updated` or `unchanged`. An account must accept
explicitly requested billing and `payment_terms` exactly or reject the entry; pending accounts may omit commercial fields while approval is incomplete.

## Guarding your existing store

For explicit and implicit stores, the framework performs principal-scoped,
lookup-only `accounts.resolve` calls (your resolver must enforce caller scope) for natural-key entries before dispatch, with at most eight concurrent lookups.
The complete key includes brand, operator, sandbox, and any brand subdivisions,
operator unit, fixed currency, or buyer-selected timezone. `accounts.upsert`
continues to receive the entire accepted batch once. Its optional
`AccountUpsertContext.existing[i]` holds an existing-account snapshot or `null`,
aligned with `refs[i]` after commercial policy filtering. Snapshots are deep copies of identity and commercial state; `authInfo` and `ctx_metadata` are excluded. References keyed by
account ID and derived stores have `null` snapshots. Return `null` or throw
`AccountNotFoundError` on a lookup miss; other errors emit `ACCOUNT_LOOKUP_FAILED` in compatibility mode and stop the write in strict mode.

The framework emits typed `AccountStoreDiagnostic` values through
`accounts.onDiagnostic`, and logs fixed messages through the framework logger
outside production. Diagnostic codes are `ACCOUNT_IDEMPOTENCY_VIOLATION`,
`PAYMENT_TERMS_MISMATCH`, `BILLING_MISMATCH`, `ACCOUNT_SYNC_ROW_UNMATCHED`, `ACCOUNT_BILLING_INCOMPLETE`, and `ACCOUNT_LOOKUP_FAILED`; fields contain the tool
name and original row index, without request content or credentials. Hook
failures do not change dispatch.

Set `accounts.strictIdempotency: true` to convert identity violations into
per-row `SYNC_FAILED` errors and explicit payment-term mismatches into
`PAYMENT_TERMS_NOT_SUPPORTED` errors; billing-model remaps become `BILLING_NOT_SUPPORTED`. Failed rows preserve the returned account ID, status, and commercial fields because an adopter write may already have committed. Missing terms alone produce diagnostics, rather than a claim that the seller rejected the requested terms. Compatibility mode leaves the returned
status and action intact. Missing billing and agent payment terms are completed
from a fresh post-write lookup only when the returned ID identifies that same account. The pre-write snapshot is never evidence of commercial acceptance. Your resolver must bypass stale caches for `toolName: sync_accounts` lookups; framework checks cannot verify an independently stale resolver.
Responses with ambiguous partial identity echoes produce a diagnostic and are not checked against another entry’s commercial terms. Echo the complete identity or an existing ID to allow verification.
Dry-run previews skip framework natural-key lookups and are never completed from persisted state; their `existing` snapshots are null.
The framework also diagnoses agent-billed `list_accounts` rows missing terms.

These are response checks: they cannot roll back your store's writes or serialize
concurrent calls. Use a database uniqueness constraint/transaction on the
principal and complete natural key. Do not treat `ctx.existing` as a lock.

## Upgrade existing resolvers

The default diagnostic guard intentionally calls natural-key resolvers during real syncs, as well as during ordinary account-routed tools. Before upgrading, ensure `resolve(ref, { provisioning: false, ...ctx })` only reads caller-scoped state, returns `null` for a missing natural key, and never calls a provisioning API. Move account creation to `upsert`. The existing SDK implicit, roster, tenant and OAuth resolver helpers do not themselves provision in `resolve`; your injected lookup and mapping callbacks must follow the same rule. Account-ID-only resolvers may return `null` for natural keys.

For a 100-entry sync, the framework uses at most eight concurrent reads and may read again to complete omitted commercial fields. Return accepted billing and payment terms directly from your write transaction to avoid those extra reads and to provide the strongest operation-specific evidence. The keyed store coalesces framework reads into one backend read per phase. A later stored-state read can observe another concurrent sync; framework checks describe the visible response and cannot prove which transaction established that state.

An `active` row with `action: failed` reports a contract violation after a custom store write; it does not revoke that account. Enforce requested billing and terms inside your own transaction, or use the reference store, for transactional guarantees. Review such failures before using the account for a buy.

## Using the reference store

`createKeyedAccountStore` provides an additive implicit store without a TTL.
It scopes records to the stable authenticated identity supplied by your required `principalKey` callback,
generates deterministic IDs, and serializes account writes through its backend.
Your callback constructs an account from your real seller records, chooses the trusted account `mode`, and explicitly
accepts or rejects billing terms; the helper provides no fallback account data.

```ts
import { Pool } from 'pg';
import {
  createKeyedAccountStore,
  getKeyedAccountMigration,
  keyedAccountPgBackend,
} from '@adcp/sdk/server';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
// Apply once in your deployment migration, before serving requests.
await pool.query(getKeyedAccountMigration());

const accounts = createKeyedAccountStore({
  backend: keyedAccountPgBackend(pool),
  namespace: 'my-seller',
  principalKey: ctx => ctx.agent?.agent_url, // This example uses a BuyerAgentRegistry.
  async createAccount(ref, id, ctx) {
    const commercial = await loadAcceptedSellerTerms(ref, ctx);
    // Throw AdcpError('PAYMENT_TERMS_NOT_SUPPORTED', ...) for unsupported terms.
    return {
      brand: ref.brand,
      operator: ref.operator,
      operator_unit: ref.operator_unit,
      currency: ref.currency,
      timezone: ref.timezone,
      sandbox: ref.sandbox,
      id,
      name: commercial.name,
      status: 'active',
      mode: commercial.mode,
      billing: { invoicedTo: commercial.billing },
      payment_terms: commercial.payment_terms,
      ctx_metadata: { upstreamAccountId: commercial.upstreamAccountId },
    };
  },
});
```

Use `keyedAccountMemoryBackend()` for one-process tests. Use
`keyedAccountKvBackend(client)` for durable KV stores providing atomic
`compareAndSwap(key, expected, value)` and `get(key)`, with no expiry. Ordinary
GET followed by SET is insufficient. Alternatively implement
`KeyedAccountBackend` with a native transaction that serializes each scope across
replicas and rolls back on callback rejection or `commit: false`.

Callbacks must construct records without external writes or other side effects.
KV conflicts may rerun them; PostgreSQL holds the principal row lock until they
complete. PostgreSQL queues same-principal writes before acquiring connections and bounds lock waits to two seconds and individual statements to 30 seconds by default (`lockTimeoutMs` and `statementTimeoutMs`). Bound callback I/O durations in your service. Read-only seller lookups are allowed from a separate pool or service. Use a dedicated pool and avoid nested queries needing another connection from that same pool. Persist only JSON-serializable, non-secret account metadata and omit
`authInfo`. The `principalKey` callback may be asynchronous and must produce a nonempty string; missing or invalid principal values deny access. Supply `principalKey(ctx)` from a trusted buyer-agent registry or authenticated tenant identity that remains stable across credential rotations; never trust a buyer-supplied field for this scope. Use a
required, distinct namespace for each logical seller sharing a database. Preserve the same `principalKey` derivation across migrations and key rotations; a transport key ID is not a durable tenant identity. Limits default to 1000 accounts and 8 MiB per principal; configure `maxAccountsPerPrincipal` and `maxBytesPerPrincipal` for your substrate. Sync batches default to at most 100 entries (`maxSyncEntries`), and records to 64 KiB (`maxAccountBytes`). The helper caches framework lookup reads per request and invalidates them after upsert; storage size is tracked incrementally per transaction.

Repeated entries are unchanged unless `updateAccount(account, entry, ctx)` is
provided. Updates must preserve identity; an active terms mismatch is rejected
before committing that row. Batch processing is additive. Natural-key settings
updates require an existing account. Account-ID updates, identity reconciliation/revisions, and `delete_missing` are
unsupported, as are notification and reporting delivery declarations; unsupported settings produce a per-row refusal. An entry without a natural key rejects the batch because no natural-key result row can be built. Dry runs compute a preview from backend reads without acquiring a write transaction. `list` supports
exact account/status/sandbox filters and cursor pagination; omitted-reference
resolution selects an account only when exactly one is visible.

## Compliance

The default storyboard invariant `accounts.sync_contract` verifies natural-key
re-syncs across distinct request keys and rejects explicitly remapped billing models and payment terms. Billing and payment terms are optional in the response schemas; the opt-in certification invariant `accounts.agent_billing_complete` requires both on active agent-billed sync/list rows. The packaged example enables both. Same-key request replay may retain `created`, but
must retain the original ID. Dry runs do not establish an identity. The invariant
can identify missing billing on a list row when a preceding sync established
that the account is agent-billed.

Run `examples/account-sync-contract.yaml` against a sandbox seller using payment terms it supports to exercise
these checks with two successful active syncs and a matching subsequent list. A refusal or empty response cannot certify natural-key idempotency. Default invariants continue to allow legitimate rejections. Published protocol
storyboards remain upstream-owned; these assertions also run when those
storyboards exercise the same tools.

The normative upsert and accept-or-reject terms rules are documented in the [sync_accounts request schema](https://adcontextprotocol.org/schemas/3.2.4/account/sync-accounts-request.json). Caller isolation in the assertions follows storyboard step auth directives; a custom principal-switching mechanism must expose equivalent directives. Controller account resets and declarative deletion invalidate earlier storyboard identity proofs.

Natural-key domains must be lowercase and country sets must contain unique uppercase ISO codes, as required by the published schemas. Invalid variants are rejected instead of minting alternate accounts.
