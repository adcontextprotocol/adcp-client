---
"@adcp/sdk": minor
---

Add `createDerivedAccountStore` — Shape D factory completing the four-shape AccountStore family.

Shape D covers stateless single-tenant platforms where the auth principal alone identifies the tenant — no account roster, no `sync_accounts` step, no buyer-supplied `account_id`. Closes #1462.

New surface:

- `createDerivedAccountStore(options)` — exported from `@adcp/sdk` and `@adcp/sdk/server`.
- `DerivedAccountStoreOptions<TCtxMeta>` — option bag type; the only required field is `toAccount(authInfo, ctx)`.

Behavior:
- Sets `resolution: 'derived'`.
- Ignores buyer-supplied `AccountReference` (single-tenant by definition).
- Returns `null` (→ `ACCOUNT_NOT_FOUND`) when `ctx.authInfo` is absent — configure `serve({ authenticate })` to gate unauthenticated requests before `resolve()` is called.
- Calls `toAccount(authInfo, ctx)` with `authInfo` guaranteed non-null; the framework auto-attaches `authInfo` to the returned `Account` when the adopter omits it.
- Omits `list` and `upsert`; compose via object spread to add either.

Pure additive: new export only. No existing behavior changed.

Before this factory, five+ adapters in scope3data/agentic-adapters independently wrote ~25–30 LOC of identical boilerplate, all with the same latent bug: `resolution: 'explicit'` (wrong) instead of `resolution: 'derived'` (correct). The factory standardizes the right declaration centrally.
