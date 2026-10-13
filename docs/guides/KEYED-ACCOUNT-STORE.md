# Durable account sync

`sync_accounts` upserts by account identity, independently of the request's
`idempotency_key`. Re-syncing the same account days later must preserve its
`account_id` and report `updated` or `unchanged`. An active account must accept
the requested `payment_terms` exactly or reject the entry.

## Guarding your existing store

For explicit and implicit stores, the framework performs principal-scoped,
lookup-only `accounts.resolve` calls (your resolver must enforce caller scope) for natural-key entries before dispatch, with at most eight concurrent lookups.
The complete key includes brand, operator, sandbox, and any brand subdivisions,
operator unit, fixed currency, or buyer-selected timezone. `accounts.upsert`
continues to receive the entire accepted batch once. Its optional
`AccountUpsertContext.existing[i]` holds an existing-account snapshot or `null`,
aligned with `refs[i]` after commercial policy filtering. Snapshots are deep copies. References keyed by
account ID and derived stores have `null` snapshots. Return `null` or throw
`AccountNotFoundError` on a lookup miss; other errors emit `ACCOUNT_LOOKUP_FAILED` in compatibility mode and stop the write in strict mode.

The framework emits typed `AccountStoreDiagnostic` values through
`accounts.onDiagnostic`, and logs fixed messages through the framework logger
outside production. Diagnostic codes are `ACCOUNT_IDEMPOTENCY_VIOLATION`,
`PAYMENT_TERMS_MISMATCH`, `ACCOUNT_BILLING_INCOMPLETE`, and `ACCOUNT_LOOKUP_FAILED`; fields contain the tool
name and original row index, without request content or credentials. Hook
failures do not change dispatch.

Set `accounts.strictIdempotency: true` to convert identity violations into
per-row `SYNC_FAILED` errors and active payment-term mismatches into
`PAYMENT_TERMS_NOT_SUPPORTED` errors. Compatibility mode leaves the returned
status and action intact. Missing billing and agent payment terms are completed
from a fresh post-write lookup only when the returned ID identifies that same account. The pre-write snapshot is never evidence of commercial acceptance.
Dry-run previews are never completed from persisted state.
The framework also diagnoses agent-billed `list_accounts` rows missing terms.

These are response checks: they cannot roll back your store's writes or serialize
concurrent calls. Use a database uniqueness constraint/transaction on the
principal and complete natural key. Do not treat `ctx.existing` as a lock.

## Using the reference store

`createKeyedAccountStore` provides an additive implicit store without a TTL.
It scopes records to the authenticated credential identity,
generates deterministic IDs, and serializes account writes through its backend.
Your callback constructs an account from your real seller records and explicitly
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
complete. Use a dedicated pool and avoid nested queries needing another connection from that same pool. Persist only JSON-serializable, non-secret account metadata and omit
`authInfo`. Supply `principalKey(ctx)` if your authenticated tenant identity needs
a different derivation; never trust a buyer-supplied field for this scope. Use a
required, distinct namespace for each logical seller sharing a database. To scope by registry-resolved buyer-agent identity, supply a stable `principalKey` explicitly and preserve it across migrations. Limits default to 1000 accounts and 8 MiB per principal; configure `maxAccountsPerPrincipal` and `maxBytesPerPrincipal` for your substrate. Sync batches default to at most 100 entries (`maxSyncEntries`), and records to 64 KiB (`maxAccountBytes`). The helper caches framework lookup reads per request and invalidates them after upsert; storage size is tracked incrementally per transaction.

Repeated entries are unchanged unless `updateAccount(account, entry, ctx)` is
provided. Updates must preserve identity; an active terms mismatch is rejected
before committing that row. Batch processing is additive. Natural-key settings
updates require an existing account. Account-ID updates, identity reconciliation/revisions, and `delete_missing` are
unsupported; an entry without a natural key rejects the batch because no natural-key result row can be built. Dry runs return a preview without committing records. `list` supports
exact account/status/sandbox filters and cursor pagination; omitted-reference
resolution selects an account only when exactly one is visible.

## Compliance

The default storyboard invariant `accounts.sync_contract` verifies natural-key
re-syncs across distinct request keys and rejects explicitly remapped active payment terms. Billing and payment terms are optional in the response schemas; the opt-in certification invariant `accounts.agent_billing_complete` requires both on active agent-billed sync/list rows. The packaged example enables both. Same-key request replay may retain `created`, but
must retain the original ID. Dry runs do not establish an identity. The invariant
can identify missing billing on a list row when a preceding sync established
that the account is agent-billed.

Run `examples/account-sync-contract.yaml` against a sandbox seller to exercise
these checks with two distinct requests and a subsequent list. Published protocol
storyboards remain upstream-owned; these assertions also run when those
storyboards exercise the same tools.
