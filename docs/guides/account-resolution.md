# Account Resolution Guide

How sellers implement the three `AccountStore.resolution` modes — `'explicit'`,
`'implicit'`, and `'derived'` — with a deep dive on `'implicit'` (the
`sync_accounts`-first pattern).

---

## Quick reference

| Mode | Roster owner | Onboarding / discovery | Durable wire reference |
|---|---|---|---|
| `'explicit'` (default) | You (the seller) | ids issued out-of-band, or an optional `list_accounts` | `{ account_id }` or the `{ brand, operator }` natural key |
| `'implicit'` | Buyer-declared | `sync_accounts` (required) | `{ brand, operator }` — inline `account_id` is refused |
| `'derived'` | An upstream platform you front, or the credential itself | `list_accounts` (**required**) | `{ account_id }` — the `{ brand, operator }` arm is refused |

Declare the mode on `AccountStore`:

```ts
accounts: {
  resolution: 'implicit',      // or 'explicit' (default) or 'derived'
  resolve: async (ref, ctx) => { ... },
  upsert: async (refs, ctx) => { ... }, // required for 'implicit'
}
```

**Each mode has exactly one spelling.** `'derived'` keeps its name even
though [adcp#5062](https://github.com/adcontextprotocol/adcp/pull/5062)
calls the shape an *upstream-managed account-id namespace*: `resolution` is
SDK-local configuration, never a wire value, so a second spelling would buy
nothing on the wire while silently defeating adopter code written as
`resolution === 'derived'` and inviting divergence from the Python SDK.
`'account-id-namespace'` is rejected for the extra reason that it doesn't
discriminate — under #5062 both `'explicit'` and `'derived'` are account-id
namespaces. An unrecognized value is a `PlatformConfigError` at
construction, not a silent fallback.

> **Breaking change in SDK 14 (adcp-client#1647).** `'derived'` used to mean
> "single-tenant; no `account_id` on the wire", and the framework refused
> inline `account_id` for it. That was inverted — see
> [`'derived'` (upstream-managed account-id namespace)](#derived-upstream-managed-account-id-namespace)
> and the [13 → 14 migration guide](../migration-13-to-14.md#derived-account-resolution-is-now-an-upstream-managed-account-id-namespace).

---

## `'implicit'` deep dive

### 1 · How it works

1. Buyer calls `sync_accounts` with `AccountReference[]`.
2. Framework calls your `accounts.upsert()` — you create/find accounts and
   store the `authPrincipal → accounts` mapping.
3. Buyer calls any tool (e.g. `create_media_buy`) without `ext.account_ref`.
4. Framework calls `accounts.resolve(undefined, ctx)` — you look up the
   account by `ctx.authInfo`.

### 2 · Key derivation

Extract the principal key from `ctx.authInfo.credential`:

```ts
resolve: async (_ref, ctx) => {
  const cred = ctx?.authInfo?.credential;
  const key = cred?.kind === 'oauth'    ? `oauth:${cred.client_id}`
            : cred?.kind === 'api_key'  ? `api_key:${cred.key_id}`
            : cred?.kind === 'http_sig' ? `http_sig:${cred.agent_url}`
            : undefined;
  if (!key) return null;
  return await db.findAccountByPrincipalKey(key);
},
```

**Why `credential.client_id`, not `authInfo.sub`?**

`credential.client_id` is the OAuth *client* identity — stable across token
rotations and independent of which user (if any) triggered the grant.
`sub` is grant-specific: a buyer rotating credentials or switching from
`client_credentials` to `authorization_code` will get a different `sub`
and lose their synced accounts. Use `sub` only when your platform
intentionally scopes accounts to individual users, and document that choice.

`credential.key_id` for API-key credentialing and `credential.agent_url` for
HTTP Signatures follow the same stability principle: they identify the buyer
entity, not the ephemeral token.

> ⚠️ `authInfo.clientId` (top-level field) is deprecated. Use
> `authInfo.credential.client_id` instead. The deprecated field is removed
> in N+2 of the deprecation cycle.

### 3 · When no sync has happened

Return `null` from `resolve()`. When the request omitted `account`, the
framework emits `ACCOUNT_REQUIRED` with `recovery: 'correctable'` and guidance
to call `sync_accounts`. A buyer-supplied reference that does not resolve still
emits `ACCOUNT_NOT_FOUND` with `recovery: 'terminal'`.

**Do NOT return `AUTH_REQUIRED`, `AUTH_MISSING`, or `AUTH_INVALID`.** Those
errors signal missing or rejected credentials — not a missing pre-sync. Buyers
receiving auth errors will refresh credentials or escalate, not call
`sync_accounts`, and can loop indefinitely.

```ts
// ✓ Correct
resolve: async (_ref, ctx) => {
  const account = await db.findByPrincipal(extractKey(ctx?.authInfo));
  return account ?? null;  // omitted account → ACCOUNT_REQUIRED
},

// ✗ Wrong — misleads buyers about how to recover
resolve: async (_ref, ctx) => {
  const account = await db.findByPrincipal(extractKey(ctx?.authInfo));
  if (!account) throw new AdcpError('AUTH_MISSING', { message: 'call sync_accounts first' });
  return account;
},
```

Do not replace the omitted-account result with an auth error. The framework's
`ACCOUNT_REQUIRED` suggestion tells the buyer to establish the implicit
linkage. For buyer-supplied unknown, unauthorized, or mismatched references,
the error code must remain `ACCOUNT_NOT_FOUND` to preserve enumeration
resistance.

### 4 · TTL and sync-linkage staleness

The framework has no built-in TTL for sync linkages — TTL is a seller-side
policy. Guidance:

- **In-memory stores (tests):** default to 24 hours. Use
  `InMemoryImplicitAccountStore`'s `ttlMs` option.
- **Durable stores (Postgres / Redis):** add a `synced_at` column and evict
  rows older than your session or token lifetime.
- **Align with token lifetime:** if your OAuth AS issues 1-hour access
  tokens, a 24-hour sync TTL means a buyer's linkage outlives their token.
  That's fine — buyers do not need to hold an active token to have their
  accounts remain linked.
- **Invalidation on credential rotation:** if a buyer's `client_id` changes
  (rare — the AS should issue a new client for the new credential), the old
  sync-linkage row becomes orphaned. Your `upsert()` should UPSERT (not
  INSERT) on `(principal_key, account_id)` so re-syncing is idempotent.

This TTL governs the *sync-linkage lifetime*, which is separate from
`AccountStore.refreshToken` — that hook refreshes an upstream OAuth token
mid-request when your seller-to-upstream platform method throws legacy
`AUTH_REQUIRED` or the 3.1-native `AUTH_MISSING`. It is not a buyer inbound
auth recovery path. The two are orthogonal.

**Postgres schema reference** — see `docs/guides/POSTGRES.md` for the
canonical `adcp_sync_linkages` DDL pattern. The cleanup query there
(`DELETE FROM ... WHERE synced_at < NOW() - INTERVAL '24 hours'`) is the
recommended sweep pattern.

---

## Reference adapter: `InMemoryImplicitAccountStore`

For tests and getting-started scenarios, import the built-in reference
implementation:

```ts
import {
  createAdcpServerFromPlatform,
  definePlatform,
  InMemoryImplicitAccountStore,
} from '@adcp/sdk/server';

const accountStore = new InMemoryImplicitAccountStore({
  // Convert a buyer's AccountReference to your platform's Account shape.
  // Default: synthesizes a minimal Account from the ref fields.
  buildAccount: async (ref, ctx) => {
    const upstream = await myPlatform.findOrCreate(ref, ctx?.authInfo);
    return {
      id: upstream.id,
      name: upstream.name,
      status: 'active',
      ctx_metadata: { upstreamId: upstream.id },
    };
  },
  // Optional: override the key-extraction logic.
  // Default: credential.client_id / credential.key_id / credential.agent_url.
  // keyFn: authInfo => authInfo.extra?.tenant_id as string,
  ttlMs: 86_400_000, // 24h
});

const platform = definePlatform({
  capabilities: { specialisms: ['sales-non-guaranteed'] as const, pricingModels: ['cpm'] as const },
  accounts: accountStore,
  // ... other platform fields
});

createAdcpServerFromPlatform(platform, { name: 'My Agent', version: '1.0.0' });
```

For a runnable example see `examples/decisioning-platform-implicit-accounts.ts`.

### Test helper methods

```ts
accountStore.clear();                           // reset all stored linkages
accountStore.authKey(authInfo);                 // what key would be stored?
accountStore.size;                              // number of stored linkages
```

---

## `'derived'` (upstream-managed account-id namespace)

Pick `'derived'` when the account roster is **not yours to provision**: you
front an upstream platform that owns it (Meta / Snap business accounts,
AudioStack workspaces, a retail-media proxy), or the buyer's credential is
bound to exactly one account on your side. Roster size is an operational
property of the upstream — N=1 and N=many share one wire contract.

The contract:

1. The buyer calls **`list_accounts`** to discover what its credential can
   reach. This is required for the mode, not optional polish —
   `createAdcpServerFromPlatform` throws `PlatformConfigError` when neither
   `accounts.list` nor `opts.accounts.listAccounts` is wired. A credential
   bound to one account returns one row, so buyer SDKs can auto-select it.
2. The buyer sends **`account: { account_id }`** on every account-scoped
   call. The framework refuses the `{ brand, operator }` arm for this mode
   with `AdcpError('INVALID_REQUEST', { field: 'account.brand' })` and a
   `list_accounts` suggestion — a natural key is not a durable reference into
   someone else's roster.
3. Your `resolve` **verifies** that id against what the *caller's credential*
   can reach. A buyer-supplied miss returns `null` (framework → terminal
   `ACCOUNT_NOT_FOUND`). On ref-less operations, zero or multiple reachable
   accounts return `null`; account-required operations then emit correctable
   `ACCOUNT_REQUIRED` with `list_accounts` guidance.
   `createDerivedAccountStore` does this for you. As a backstop the framework
   also refuses a resolved account whose `id` isn't the one the buyer named —
   that catches a resolver that ignores `ref`, but it can't tell whether your
   lookup was credential-scoped, so it is not a substitute for step 3.

```ts
import { createDerivedAccountStore } from '@adcp/sdk/server';

// One account per credential (AudioStack, flashtalking, single-namespace
// retail-media). The factory publishes the one-row list_accounts, verifies
// buyer-supplied ids against it, and auto-selects it on ref-less tools.
const accounts = createDerivedAccountStore<MyMeta>({
  toAccount: async ctx => ({
    id: await upstream.workspaceId(ctx?.authInfo), // the id buyers send back
    name: 'My Platform',
    status: 'active',
    ctx_metadata: {},
  }),
});
```

```ts
// Many accounts per credential (Meta / Snap shaped). `listAccounts` is the
// tenant-isolation boundary: scope it by the caller's credential.
const accounts = createDerivedAccountStore<{ upstreamId: string }>({
  listAccounts: async ctx => {
    const rows = await meta.adAccountsFor(ctx?.authInfo);
    return rows.map(r => ({
      id: r.account_id,
      name: r.name,
      status: 'active',
      ctx_metadata: { upstreamId: r.id },
    }));
  },
  // Optional point lookup for large rosters — MUST filter by the caller too.
  lookupAccount: (id, ctx) => meta.adAccountForCaller(id, ctx?.authInfo),
});
```

For a runnable example see `examples/decisioning-platform-derived-accounts.ts`.

The factory also throws legacy-compatible `AdcpError('AUTH_REQUIRED')` when
`ctx.authInfo` carries no credential (skip with `skipAuthCheck: true` for
genuinely unauthenticated agents). New hand-rolled stores can throw
`AuthMissingError` when they intentionally emit the AdCP 3.1
missing-request-credential code.

Hand-rolled equivalent — you own both obligations, the `list` and the check:

```ts
import { refAccountId } from '@adcp/sdk/server';

accounts: {
  resolution: 'derived',
  resolve: async (ref, ctx) => {
    const reachable = await upstream.accountsFor(ctx?.authInfo); // credential-scoped
    const id = refAccountId(ref);
    // Fail closed. Never "we only have one account, so serve it anyway".
    // (The framework also refuses a resolved account whose id isn't the one
    // the buyer named — but own the check; it's your tenant boundary.)
    if (id !== undefined) return reachable.find(a => a.id === id) ?? null;
    // Ref-less tools: auto-select only when there is exactly one. An
    // account-required operation maps any other roster size to ACCOUNT_REQUIRED.
    return reachable.length === 1 ? reachable[0] : null;
  },
  // The framework does not filter or page for you: honor req.account /
  // req.status / req.sandbox and req.pagination in your own query.
  list: async (req, ctx) => ({ items: await upstream.accountsFor(ctx?.authInfo) }),
}
```

### Ignoring `ref` is a tenant-isolation bug

A resolver that returns a fixed account regardless of `ref` was the
pre-SDK-14 Shape D pattern. Keep writing it and the first time your
deployment serves two accounts, caller A's `{ account_id: 'B' }` request runs
against account A's data — no error, no log. Verify the ref, or let
`createDerivedAccountStore` verify it.

### Writes are verified too

`sync_accounts` and `sync_governance` carry their account reference *inside*
the batch, so they never went through `accounts.resolve`. For `'derived'`
platforms the framework now resolves every entry's `account_id` against what
the caller's credential can reach before any write runs — an unreachable id
fails the `sync_accounts` operation with `ACCOUNT_NOT_FOUND` (the response
row schema requires `brand` + `operator`, which we don't have for an account
we refused to resolve) and fails the individual `sync_governance` row.

### `sync_accounts` in derived mode

Not forbidden, but narrowed to what [adcp#5062](https://github.com/adcontextprotocol/adcp/pull/5062)
allows:

- **Natural-key provisioning entries** (`{ brand, operator, billing }` at the
  entry root, or a settings-update entry keyed by the natural key) are failed
  per-row by the framework with `UNSUPPORTED_PROVISIONING` before reaching
  `accounts.upsert`. There is nothing to provision in a namespace you don't
  own.
- **Settings-update entries** keyed by `account: { account_id }` pass
  through, after the reachability check above. Wire `accounts.upsert` if your
  upstream exposes account-settings writes; leave it unimplemented and buyers
  calling `sync_accounts` get the framework's unimplemented-tool path, as
  before.
- A natural-key *reference* (`account: { brand, operator }`) is refused
  per-row with `INVALID_REQUEST` — the ref shape is wrong for the namespace,
  which is a different fault from the provisioning mode being unsupported.
- An entry carrying **two** references (root `account_id` plus a nested
  `account`, or an `account` mixing `account_id` with `brand`/`operator`) is
  refused with `INVALID_REQUEST`, never disambiguated by precedence. The
  schema's per-entry `oneOf` forbids those shapes, but validation is
  relaxable and accepting on one reference while writing against another is
  a bypass.
- **Response rows still require `brand` + `operator`** per
  `sync-accounts-response.json`, so a settings-update row echoes them from
  your own account record. If your upstream accounts have no brand/operator
  you can express, don't wire `upsert` — see
  [adcontextprotocol/adcp#7517](https://github.com/adcontextprotocol/adcp/issues/7517).

### Capability projection

A declared `resolution: 'derived'` projects `account.require_operator_auth:
true` on `get_adcp_capabilities` — the capability bit for account-id
namespaces, same as declared `'explicit'`. Conformance runners read it and
grade `sync_accounts` storyboard steps as `not_applicable` rather than
`missing_tool`. Override with `capabilities.requireOperatorAuth` if your
deployment's auth model differs.

Emitting the account block also emits `account.supported_billing`, which
defaults to `['agent']`. Declare `capabilities.supportedBillings` explicitly
— an upstream-managed namespace usually bills the operator, and the default
will route buyers into agent-billed flows.

### If you have no namespace to discover

An agent that hands out account ids out-of-band and has nothing to enumerate
is a **seller-defined** account-id namespace: declare `'explicit'`. That mode
accepts `{ account_id }` (and the natural key) with no discovery obligation.

### Stateless BYOK provider auth

For single-account API-key or bearer-token BYOK adapters, the provider
credential can be the AdCP request credential for that endpoint. A caller
presents the current provider key or OAuth access token as normal bearer
request auth:

```http
Authorization: Bearer <provider_api_key_or_access_token>
```

This is the single-plane pattern for a seller agent that wraps one upstream
provider account per credential: the seller agent authenticates the request
with the caller-presented provider credential, derives the singleton account
from that request auth, and uses the same request-local token for upstream API
calls. No SDK-managed OAuth flow, refresh-token store, provider-token store,
or callback route is required when the caller owns the provider credential
lifecycle. If the provider credential can see multiple upstream accounts,
stay in `'derived'` but supply `listAccounts` instead of `toAccount` so the
buyer can discover and name one — or use `createOAuthPassthroughResolver`
under `'explicit'` if you also own the id namespace.

Handlers with a resolved account should read the active token from
`ctx.account.authInfo?.token`; refresh hooks update `account.authInfo`.
Handlers without a resolved account can read the request token from
`ctx.authInfo.token`. Use a stable non-secret identity for cache and
idempotency scoping, such as `ctx.authInfo.credential.key_id` for API keys,
`ctx.authInfo.credential.client_id` for OAuth, or an adopter-supplied
`principal`. Do not store the raw token in `ctx_metadata`; keep it on request
auth and re-read it per request.

Treat both token paths as request-local. Do not copy provider tokens into
persisted Account rows, `ctx_metadata`, `ctx.authInfo.extra`, request `ext` /
body fields, or log lines. In dual-auth proxy deployments, keep the second
credential request-local too; log only non-secret identifiers such as
`key_id`, `client_id`, or `principal`.

Only introduce a separate provider-auth channel when one request truly needs
two credentials: one credential to authorize the caller to the AdCP agent and
another credential to authorize the upstream provider tenant. That dual-auth
proxy shape is optional; it is not the baseline BYOK model.

No `upsert` needed — see [`sync_accounts` in derived mode](#sync_accounts-in-derived-mode)
for what the framework does with each entry shape when you do wire one.

---

## `'explicit'` (default)

Resolve from `ref.account_id` or `ref.brand`/`ref.operator`:

```ts
import { refAccountId } from '@adcp/sdk/server';

accounts: {
  resolution: 'explicit',  // or omit — 'explicit' is the default
  resolve: async (ref, ctx) => {
    const id = refAccountId(ref);
    if (id) return db.findById(id);
    if (ref?.brand && ref?.operator) return db.findByBrandOperator(ref.brand, ref.operator);
    return null;
  },
}
```

`upsert` is optional for explicit-mode platforms. Implement it if your buyers
need to pre-register accounts before use (e.g., credit-check gates).

For the Shape C publisher-curated pattern, prefer `createRosterAccountStore`
over a hand-rolled store — it handles the id-arm dispatch and `list_accounts`
plumbing, and exposes `resolveWithoutRef` for the ref-less case (see
[Ref-less resolution](#ref-less-resolution-list_creative_formats-preview_creative-provide_performance_feedback) below).

---

## Ref-less resolution (`list_creative_formats`, `preview_creative`, `provide_performance_feedback`)

These tools send no `account` field on the wire, so the framework calls
`accounts.resolve(undefined, ctx)`. Publisher-curated (`resolution: 'explicit'`)
platforms using `createRosterAccountStore` get `null` by default —
`ctx.account` is `undefined` in those handlers.

Use `resolveWithoutRef` when your platform needs a synthetic publisher-wide
account for these tools:

```ts
import { createRosterAccountStore } from '@adcp/sdk/server';

const accounts = createRosterAccountStore({
  lookup: async (id, ctx) => db.findById(id),
  toAccount: row => ({
    id: row.id,
    name: row.name,
    status: 'active',
    ctx_metadata: { tenantId: row.tenant_id },
  }),
  // Called when tools resolve with no account_id on the wire.
  // The returned entry flows through toAccount like any lookup hit.
  resolveWithoutRef: (_ref, ctx) => ({
    id: '__publisher__',
    name: 'Publisher',
    // tenant_id is a custom TRosterEntry field — toAccount maps it to ctx_metadata
    tenant_id: ctx?.authInfo?.credential?.client_id ?? 'default',
  }),
});
```

When `resolveWithoutRef` returns `undefined`, the helper falls back to `null`
(same as omitting the option).

**Auth-derived singleton.** If the publisher singleton must be looked up from
your roster by a principal-derived id (rather than synthesized inline), use the
spread-override pattern so the lookup goes through `lookup` + `toAccount`:

```ts
const base = createRosterAccountStore({ lookup, toAccount });
const accounts = {
  ...base,
  resolve: async (ref, ctx) => {
    if (ref === undefined) {
      const id = deriveAccountIdFromAuth(ctx?.authInfo);
      return id ? base.resolve({ account_id: id }, ctx) : null;
    }
    return base.resolve(ref, ctx);
  },
};
```

**Hand-rolled stores.** For stores that don't use `createRosterAccountStore`,
handle `resolve(undefined, ctx)` in your own `resolve` implementation by
checking `ref === undefined` before the id-arm branch.
