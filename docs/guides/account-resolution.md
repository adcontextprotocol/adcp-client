# Account Resolution Guide

How sellers implement the three `AccountStore.resolution` modes — `'explicit'`,
`'implicit'`, and `'derived'` — with a deep dive on `'implicit'` (the
`sync_accounts`-first pattern).

---

## Quick reference

| Mode | Buyer sends | Seller resolves via |
|---|---|---|
| `'explicit'` (default) | `ext.account_ref` on every request | `ref.account_id` or `ref.brand`/`ref.operator` |
| `'implicit'` | Nothing (no `ext.account_ref`) — but must call `sync_accounts` first | `ctx.authInfo` credential key |
| `'derived'` | Nothing | Single-tenant singleton; no per-request resolution needed |

Declare the mode on `AccountStore`:

```ts
accounts: {
  resolution: 'implicit',      // or 'explicit' (default) or 'derived'
  resolve: async (ref, ctx) => { ... },
  upsert: async (refs, ctx) => { ... }, // required for 'implicit'
}
```

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

Return `null` from `resolve()`. The framework emits `ACCOUNT_NOT_FOUND` to
the buyer with `recovery: 'terminal'`.

**Do NOT return `AUTH_REQUIRED`, `AUTH_MISSING`, or `AUTH_INVALID`.** Those
errors signal missing or rejected credentials — not a missing pre-sync. Buyers
receiving auth errors will refresh credentials or escalate, not call
`sync_accounts`, and can loop indefinitely.

```ts
// ✓ Correct
resolve: async (_ref, ctx) => {
  const account = await db.findByPrincipal(extractKey(ctx?.authInfo));
  return account ?? null;  // null → ACCOUNT_NOT_FOUND
},

// ✗ Wrong — misleads buyers about how to recover
resolve: async (_ref, ctx) => {
  const account = await db.findByPrincipal(extractKey(ctx?.authInfo));
  if (!account) throw new AdcpError('AUTH_MISSING', { message: 'call sync_accounts first' });
  return account;
},
```

You MAY add a `details.hint` on the `ACCOUNT_NOT_FOUND` error in your error
normalizer (SDK extension point) if your platform's documentation mentions
it, but the error code itself must remain `ACCOUNT_NOT_FOUND`.

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

## `'derived'` (single-tenant)

Return a fixed singleton regardless of `ref`. For the canonical Shape D
pattern (auth principal IS the tenant — audiostack, flashtalking,
single-namespace retail-media), use `createDerivedAccountStore`:

```ts
import { createDerivedAccountStore } from '@adcp/sdk/server';

const accounts = createDerivedAccountStore<MyMeta>({
  toAccount: ctx => ({
    id: 'tenant_singleton',
    name: 'My Platform',
    status: 'active',
    ctx_metadata: {},
  }),
});
```

The factory sets `resolution: 'derived'`, still throws legacy-compatible
`AdcpError('AUTH_REQUIRED')` when `ctx.authInfo.credential` is absent
(skip with `skipAuthCheck: true` for genuinely unauthenticated agents),
and ignores any buyer-supplied `account_id` (single-tenant by definition).
New hand-rolled stores can throw `AuthMissingError` when they intentionally
emit the AdCP 3.1 missing-request-credential code. Hand-rolled equivalent:

```ts
accounts: {
  resolution: 'derived',
  resolve: async () => ({
    id: 'tenant_singleton',
    name: 'My Platform',
    status: 'active',
    ctx_metadata: {},
  }),
}
```

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
lifecycle. If the provider credential can see multiple upstream accounts, use
an explicit account roster pattern such as `createOAuthPassthroughResolver`
instead of `'derived'`.

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

No `upsert` needed. The framework returns `UNSUPPORTED_FEATURE` to any
buyer that calls `sync_accounts`.

**Inline `account_id` refusal.** Since adcp-client#1468, the framework
refuses inline `{ account_id }` references for `'derived'` platforms with
`AdcpError('INVALID_REQUEST', { field: 'account.account_id' })` *before*
reaching `accounts.resolve` — same shape as `'implicit'`'s refusal (#1364),
with a single-tenant message instead of the `sync_accounts`-first guidance.
Hand-rolled `'derived'` stores get this for free; the
`createDerivedAccountStore` factory's defensive ignore is a belt + braces
fallback. The brand+operator union arm is still permitted (route through
your resolver verbatim).

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
