---
'@adcp/sdk': minor
---

Add `createRosterAccountStore` — Shape C `AccountStore` factory for `resolution: 'explicit'` publisher-curated platforms.

Pairs with the existing reference adapters:

- `InMemoryImplicitAccountStore` — Shape A, `resolution: 'implicit'`, buyer-driven write path via `sync_accounts`. Framework owns persistence.
- `createOAuthPassthroughResolver` — Shape B, `resolution: 'explicit'`, returns just the `resolve` function for adapters fronting an upstream OAuth listing API (Snap, Meta, TikTok). Adopter composes into AccountStore.
- `createRosterAccountStore` (new) — Shape C, `resolution: 'explicit'`, returns a complete AccountStore for adopters who own the roster (storefront table, admin-UI-managed JSON, in-memory map). The adopter keeps the persistence layer; the SDK provides the AccountStore plumbing.

Replaces ~150 LOC of boilerplate per adopter (extract id from `AccountReference`, point-lookup, build `Account<TCtxMeta>`, optional list pagination, ctx threading) with a ~50 LOC factory. No persistence opinion — the adopter brings a `lookup(id, ctx)` function backed by whatever roster source they have (Postgres SELECT, Map, JSON column, file).

```ts
import { createRosterAccountStore } from '@adcp/sdk/server';

const accounts = createRosterAccountStore({
  lookup: async (id, ctx) => {
    const tenantId = deriveTenant(ctx?.authInfo);
    return await db.oneOrNone('SELECT * FROM storefront_accounts WHERE id = $1 AND tenant = $2', [id, tenantId]);
  },
  toAccount: row => ({
    id: row.id,
    name: row.name,
    status: row.status,
    ctx_metadata: { tenant: row.tenant, upstreamRef: row.upstream_ref },
  }),
  list: async (filter, ctx) => {
    const rows = await db.any(buildListQuery(filter, deriveTenant(ctx?.authInfo)));
    return { items: rows, nextCursor: nextCursorFor(rows, filter) };
  },
});
```

Design choices:

- **Point-lookup, not roster getter.** Adopters with thousands of accounts per tenant in Postgres issue `SELECT WHERE id = $1` instead of materializing the full array on every request.
- **`list` is opt-in.** Omit it and the framework emits `UNSUPPORTED_FEATURE` for `list_accounts` calls. Provide it and the adopter pushes filter+page down to whatever index they have — the helper does NOT post-filter.
- **No `upsert` / `reportUsage` / `getAccountFinancials` / `refreshToken`.** Buyer-driven writes don't apply to publisher-curated rosters. Adopters who need those compose with a spread: `{ ...createRosterAccountStore(...), refreshToken: async (a) => { ... } }`.
- **No ref-less hatch.** `accounts.resolve(undefined, ctx)` (called by `provide_performance_feedback`, `list_creative_formats`, `preview_creative`) returns `null` by default. The spec lists three legitimate paths for ref-less calls — singleton fallback, auth-derived lookup, error out — with structurally different return types. Rather than ship a hatch that picks one shape, the helper does id-arm dispatch only. Adopters who want a synth tenant or auth-derived lookup wrap `resolve` (the JSDoc shows both patterns); adopters who want the error-out path keep the default null return and narrow on `ctx.account === undefined`. Same "compose, don't extend" precedent as `createOAuthPassthroughResolver`.
