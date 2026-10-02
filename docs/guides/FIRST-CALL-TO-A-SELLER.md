# First call to a seller

An account reference selects a provisioned account at that seller. Discovery
does not provision it. Until setup is complete, send a top-level `brand` on
tools that support public discovery, and omit `account`.

```ts
import { AgentClient, createProductCache } from '@adcp/sdk';

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

// Choose billing terms before accepting them. This returns seller status and handle.
const setup = await client.accounts.ensure(account, {
  billing: 'operator',
  paymentTerms: 'net_30',
});
if (setup.status === 'active') {
  const pricedCatalog = await client.getProducts({ account, brand, brief: 'Display inventory' });
  if (!pricedCatalog.success) console.error(pricedCatalog.adcpError);
}
```

For agent-billed provisioning, pass `billingEntity` with the seller's required
business identity. `paymentTerms` and `billingEntity` are also accepted by
`resolveAccount()`. That helper keeps its existing pending-approval exception;
`accounts.ensure()` returns the status so callers can present the setup flow.
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
select an active account returned by `list_accounts`. An account ID echoed by
`sync_accounts` is a seller handle; implicit sellers still require the natural
key on subsequent calls. Do not replace it with `{ account_id }` automatically.

`accountPolicy` defaults to `'off'` to preserve existing requests. Opt-in
`'auto'` omits unknown accounts on public discovery tools that support `brand`;
it refuses required-account discovery, async discovery, and mutations until
the registry knows the key. `'strict'` refuses every unknown account-carrying
request. Both policies require an active account before spend commitments.
Explicit account filters on `list_accounts` remain filters.
Call `listAccounts` first when adopting these policies with existing opaque
account IDs so the registry knows those seller handles.

Provisioning is remembered per seller and caller. `syncAccounts()` and
`listAccounts()` update the registry on completed results; failed rows and dry
runs do not establish accounts. After verifying an `account.status_changed`
notification, call `client.accounts.applyStatusChange({ account_id })` to repair
from authoritative `list_accounts`. The notification's status is not trusted as
a snapshot, which avoids reordered deliveries overwriting current state.

The registry is in memory by default. Set `accountStorage` to an adapter with
`get(key)` and `set(key, entry)` for persistence. Keys partition by seller URI,
protocol, and caller scope. Client-credentials OAuth uses the stable client ID, token endpoint, scopes, and resource. Authorization-code OAuth pins this client's initial grant fingerprint, keeping distinct user grants apart while automatic refreshes preserve its partition. Create a new client when switching users. Other credential modes fingerprint credentials;
for continuity across token rotations, supply `accountRegistryScope` from a
trusted stable principal identifier. Never share that scope between tenants.
Registry memory is bounded by `accountRegistryMaxEntries` (default 10,000); durable adapters allow eviction and reload. Stored entries contain account references, seller handles, status, optional pending task IDs, and hashes of explicitly chosen setup terms;
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
