# First call to a seller

An account reference selects a provisioned account at that seller. Discovery
does not provision it. Until setup is complete, send a top-level `brand` on
tools that support public discovery, and omit `account`, when your account policy permits it.

```ts
import { AgentClient, createProductCache, formatPendingAction, nextStep } from '@adcp/sdk';

const client = new AgentClient(sellerConfig, {
  accountPolicy: 'auto',
  productCache: createProductCache({ publicTtl: 60_000, accountTtl: 30_000 }),
});
const capabilities = await client.getCapabilities();
const brand = { domain: 'advertiser.example' };
const account = { brand, operator: 'agency.example' };

// Only use public discovery when the seller permits it.
if (!capabilities.account?.requiredForProducts) {
  const publicCatalog = await client.getProducts({ brand, brief: 'Display inventory' });
  if (!publicCatalog.success) console.error(publicCatalog.adcpError);
}

// Choose billing terms before accepting them. ensure() returns an AccountOutcome:
// ready | pending | ambiguous | rejected. Pending is a value, not an exception.
const outcome = await client.accounts.ensure(account, {
  billing: 'operator',
  paymentTerms: 'net_30',
});
switch (outcome.kind) {
  case 'ready': {
    const pricedCatalog = await client.getProducts({ account, brand, brief: 'Display inventory' });
    if (!pricedCatalog.success) console.error(pricedCatalog.adcpError);
    break;
  }
  case 'pending':
    // Show it to a person; never fetch outcome.action.url.
    if (nextStep(outcome) === 'send_human_to_url') console.log(formatPendingAction(outcome.action));
    break;
  case 'ambiguous':
    await outcome.choose(outcome.candidates[0].account_id);
    break;
  case 'rejected':
    console.error(outcome.errors);
    break;
}
// Later, from a cron job or an account_request.changed webhook:
for (const moved of await client.accounts.refresh()) console.log(moved.kind, moved.account_id);
```

`ensure()` routes by capability: when the seller advertises `account.requests`
it calls `request_account` (and a repeat call returns the open request's state,
never a duplicate); otherwise it calls `sync_accounts`. Agents should switch on
`nextStep(outcome)` (`'wait_for_seller' | 'send_human_to_url' | 'pick_candidate' |
'contact_seller' | 'none'`), not on `action.kind`, which is extensible.
`accounts.pending()` lists what is still waiting without a network call.
Before SDK 17 `ensure()` resolved to the registry record; that call is now
`accounts.provision()`, with the same arguments.

For agent-billed provisioning, pass `billingEntity` with the seller's required
business identity. `paymentTerms` and `billingEntity` are also accepted by
`resolveAccount()`. That helper keeps its existing pending-approval exception;
`accounts.ensure()` returns a `pending` outcome so callers can present the setup flow.
Non-active entries refresh through `list_accounts` when a seller handle is known.
An existing registry entry prevents repeated provisioning and silent acceptance
of new terms. To change terms, explicitly call `syncAccounts()`.
An explicit `ensure` with conflicting known setup terms refuses the change.
If the seller no longer lists an account, explicitly reestablish it with
`syncAccounts` after choosing terms; status repair never silently re-provisions it.
Caller cancellation stops waiting for setup; the single seller operation continues
so another caller cannot accidentally accept different terms concurrently.
Terminal setup failures permit an explicit retry. For interrupted async setup,
read `accounts.get(key).pendingTaskId`, reconcile that seller task, and pass its
completed rows to `accounts.observeSync([key], rows)` (or let the original
`syncAccounts` completion handle update the registry). Do not resubmit unresolved tasks.

For a seller that requires operator authentication, use `resolveAccount()` to
select an active account returned by `list_accounts`.

Account provisioning with `operator_unit`, `currency`, `timezone`, or
`brand.countries` requires AdCP 3.2 on both the client and seller. The same applies
to natural keys under `accounts[i].account` in settings updates. `syncAccounts()`
and `executeTask('sync_accounts', ...)` reject these fields before dispatch when
either client pin (`adcpVersion` or the effective `wireAdcpVersion`, including a
per-call override) is below 3.2, or discovery does not establish seller support.
The error names the field and confirms that
no request was sent, even when request validation is disabled. To deliberately
use legacy identity, remove these fields from the provisioning entries yourself;
distinct 3.2 keys may then resolve to the same seller account. Fields set to
`undefined` are omitted on the wire and do not trigger this guard.

For implicit sellers, the default `accountReferenceMode: 'auto'` selects
`{ account_id }` after provisioning only when the seller declares
`account.stable_account_id: true` (normalized as `capabilities.account.stableAccountId`),
or both the effective wire version and seller contract require IDs under AdCP 4+.
For these sellers, `resolveAccount()` returns the ID reference, and requests
using a provisioned natural key are rewritten to the same ID across discovery,
creative sync, media buys, and other account-scoped tasks. `sync_accounts`
provisioning and explicit `list_accounts` filters keep their authored references.
An ID returned by a legacy implicit seller alone does not establish that IDs
are accepted; those sellers still receive the natural key. Set
`accountReferenceMode: 'natural-key'` to retain natural-key selection on implicit
sellers. Explicitly supplied ID references are preserved in either mode.

`resolveAccount()` still returns a wire reference by default, so existing code
can pass the result directly as `account`. To retain the seller's handle even
on a legacy implicit seller, request the detailed result:

```ts
const resolved = await client.resolveAccount({
  ...account,
  includeDetails: true,
});
// reference follows the seller's contract; account_id is the returned seller ID.
const catalog = await client.getProducts({
  account: resolved.reference,
  buying_mode: 'brief',
  brief: 'Display inventory',
});
console.log(resolved.account_id, resolved.naturalKey);
```

`naturalKey` is present for implicit provisioning; `account_id` is omitted if
a legacy seller did not return one. A seller declaring stable IDs must return
an ID; otherwise reference selection refuses the request with `AccountSetupRequiredError`.

`accountPolicy` defaults to `'off'` to disable provisioning gates. ID selection
still applies to known registry entries, including entries created by `accounts.ensure()`.
Opt-in
`'auto'` omits unknown accounts on public discovery tools that support `brand`;
it refuses required-account discovery, async discovery, and mutations until
the registry knows the key. `'strict'` refuses every unknown account-carrying
request. On stable-ID sellers, `'strict'` also refuses `get_products` and
`list_products` without an account reference, even when public discovery is
available; provision an account and supply its reference. Both policies require
an active account before spend commitments. `sync_creatives` accepts `active`
and `payment_required` accounts; it refuses `pending_approval`, `suspended`,
`rejected`, and `closed` accounts. `payment_required` blocks new spend, while
allowing creative sync and management of existing buys.
The natural-key override changes reference selection, not strict provisioning
requirements. `AccountNotProvisionedError.account` is `undefined` when the
request omitted its account; check for presence before inspecting the reference.
Explicit account filters on `list_accounts` remain filters.
For durable retries, persist the selected wire reference with the request and
reuse it with the same idempotency key. Switching from a natural key to an ID
between attempts changes the request body and can cause `IDEMPOTENCY_CONFLICT`;
the natural-key override can preserve requests authored before ID routing was enabled.
Call `listAccounts` first when adopting these policies with existing opaque
account IDs so the registry knows those seller handles.

Provisioning is remembered per seller and caller. `syncAccounts()` and
`listAccounts()` update the registry on completed results; failed rows and dry
runs do not establish accounts. After verifying an `account.status_changed`
notification, call `client.accounts.applyStatusChange({ account_id })` to repair
from authoritative `list_accounts`. The notification's status is not trusted as
a snapshot, which avoids reordered deliveries overwriting current state.
Use `client.accounts.getByAccountId(account_id)` to look up the ID alias;
it includes `aliases` for the provisioned natural keys and is isolated by
seller and caller scope. The lookup works in memory and after a storage-backed restart.
Default-off stable-ID resolution also remembers recent bindings in a bounded
routing cache while continuing to sync on every resolution. That automatic cache
evicts old entries at capacity, including after read-only ID lookups. Calling
`accounts.ensure()` or opting into registry configuration retains provisioning
state and capacity checks.

The registry is in memory by default. Set `accountStorage` to an adapter with
`get(key)` and `set(key, entry)` for persistence. The registry writes both
natural-key entries and ID aliases. An optional `getByAccountId(accountId, scope)`
storage method can read those aliases through an index; existing get/set adapters
continue to work. For multiple processes, add
revision-checked `compareAndSet` writes and dispatch ledger hooks; see
[buyer storage and scheduling](BUYER-STORAGE.md). Keys partition by seller URI,
protocol, and caller scope. Client-credentials OAuth uses the stable client ID, token endpoint, scopes, and resource. Authorization-code OAuth pins this client's initial grant fingerprint, keeping distinct user grants apart while automatic refreshes preserve its partition. Create a new client when switching users. Other credential modes fingerprint credentials;
for continuity across token rotations, supply `accountRegistryScope` from a
trusted stable principal identifier. Never share that scope between tenants.
Request-signing key identity is also part of the default fingerprint, so distinct
signers stay isolated. Key rotation requires reprovisioning or a trusted stable
`accountRegistryScope` for the same principal.
Registry memory and aliases per handle are bounded by `accountRegistryMaxEntries` (default 10,000); durable adapters allow entry eviction and reload. Without storage, reaching capacity throws a setup error; raise the limit or configure storage for large rosters. `resolveAccount()` uses the memoized registry only when you opt in with `accountPolicy: 'auto' | 'strict'`, `accountStorage`, `accountRegistryScope`, or `accountRegistryMaxEntries`; that internal use does not enable observations of unrelated rosters. Otherwise it keeps the 14.0 behavior: every call sends `sync_accounts` and reflects the seller's current status. Memoized entries require explicit `syncAccounts()` or authoritative status repair when seller linkage expires or is replaced externally. Stored entries contain account references, seller handles, status, optional pending task IDs, and hashes of explicitly chosen setup terms;
billing entities and tokens are not persisted. Manual feed mode recovers through
an explicit `refresh()`; auto-poll mode also retries initial failures.

Typed `AccountNotFoundError`, `AccountSetupRequiredError`, and
`AccountPaymentRequiredError` carry `fault: 'buyer_setup'`. Health trackers
should exclude them from seller-health failure counts. Failed task results still
expose the protocol code in `result.adcpError` and the typed exception in
`result.errorInstance`.

The optional product cache uses TTLs in milliseconds and keeps at most `maxEntries` entries (default 1,000). It keeps public and
account-scoped responses apart and stores the feed version and pricing version
with each snapshot. Missing `cache_scope` prevents caching. Stale entries are
conditionally revalidated using their own tokens; failures remain visible to
the caller and never erase the last valid entry. Caller-authored feed or pricing validators
retain their unchanged-response semantics. Caches are scoped to the client
instance so different local verification policies cannot share filtered results.

`WholesaleFeedSync` similarly keeps its last good product and signal mirrors on
a failed refresh. Its error event includes `adcpError`; a mirror becomes
`degraded` until a successful refresh restores `syncing`. Initial failure sets
`error`. Exhaustive state switches must handle the new `degraded` member.

Manual `WholesaleFeedSync.refresh()` and webhook repairs reject failed catalog reads, including failed task results. A failed webhook repair remains eligible for redelivery; acknowledge it only after repair succeeds. Bootstrap `start()` still reports failed task results through its state and error callback/event, and schedules recovery in auto-poll mode.
