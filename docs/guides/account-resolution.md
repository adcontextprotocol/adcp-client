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

**Do NOT return `AUTH_REQUIRED`.** That error signals missing or rejected
credentials — not a missing pre-sync. Buyers receiving `AUTH_REQUIRED` will
retry with a fresh token, not call `sync_accounts`, and loop indefinitely.

```ts
// ✓ Correct
resolve: async (_ref, ctx) => {
  const account = await db.findByPrincipal(extractKey(ctx?.authInfo));
  return account ?? null;  // null → ACCOUNT_NOT_FOUND
},

// ✗ Wrong — misleads buyers about how to recover
resolve: async (_ref, ctx) => {
  const account = await db.findByPrincipal(extractKey(ctx?.authInfo));
  if (!account) throw new AdcpError('AUTH_REQUIRED', { message: 'call sync_accounts first' });
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
mid-request when your platform method throws `AUTH_REQUIRED`. The two are
orthogonal.

**Postgres schema reference** — see `docs/guides/POSTGRES.md` for the
canonical `adcp_sync_linkages` DDL pattern. The cleanup query there
(`DELETE FROM ... WHERE synced_at < NOW() - INTERVAL '24 hours'`) is the
recommended sweep pattern.

---

## Reference adapter: `InMemoryImplicitAccountStore`

For tests and getting-started scenarios, import the built-in reference
implementation:

```ts
import { InMemoryImplicitAccountStore } from '@adcp/sdk/server';
import { createAdcpServer } from '@adcp/sdk/server';

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

createAdcpServer({
  accounts: accountStore,
  // ... other platform config
});
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

Return a fixed singleton regardless of `ref`:

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

No `upsert` needed. The framework returns `UNSUPPORTED_FEATURE` to any
buyer that calls `sync_accounts`.

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
