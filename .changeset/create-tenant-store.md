---
"@adcp/sdk": minor
---

`createTenantStore<TTenant, TCtxMeta>` — opinionated `AccountStore` builder for multi-tenant adapters. Closes the last library-side item tracked in #1387.

Canonicalizes the two-path resolution shape every multi-tenant adapter writes by hand (operator-routed for tools that carry `account` on the wire; auth-derived for no-account tools like `get_brand_identity` / `get_rights`) AND bakes in the per-entry tenant-isolation gate that adopters historically had to write — and silently fail to write — on `accounts.upsert` / `accounts.syncGovernance`.

```ts
const accounts = createTenantStore<TenantState, TenantMeta>({
  resolveByRef(ref)                       => TenantState | null,  // wire ref → tenant
  resolveFromAuth(ctx)                    => TenantState | null,  // auth principal → tenant
  tenantId(tenant)                        => string,              // stable id for equality
  tenantToAccount(tenant, ref, ctx)       => Account<TenantMeta>, // sandbox lives here
  upsertRow?(tenant, ref, ctx)            => SyncAccountsResultRow,
  syncGovernanceRow?(tenant, entry, ctx)  => SyncGovernanceResponseRow,
});
```

The helper produces a regular `AccountStore<TCtxMeta>`. `accounts.list` / `accounts.reportUsage` / `accounts.getAccountFinancials` are NOT generated — those tools have shapes (cursor pagination; per-row account refs spanning multiple tenants) that don't fit the per-entry-then-row pattern. Adopters who claim those capabilities wire them on top of the returned store.

**Security: the per-entry gate is built in, not opt-in.** On `upsert` / `syncGovernance`, the helper resolves the auth principal's tenant once via `resolveFromAuth(ctx)`, then for each entry resolves the entry's tenant via `resolveByRef(ref)`. Entries whose tenant differs (or whose tenant ref is unknown) are emitted as `'failed'` rows with `code: 'PERMISSION_DENIED'` (cross-tenant) or `code: 'ACCOUNT_NOT_FOUND'` (unknown ref) BEFORE invoking the adopter's `upsertRow` / `syncGovernanceRow` callbacks. **Cross-tenant entries never reach adopter code.** Fail-closed when `resolveFromAuth` returns null: every entry fails `PERMISSION_DENIED` regardless of operator. The original B1 finding from the multi-tenant adapter's security review (where adopters routing by wire-supplied operator without cross-checking the auth principal could write across tenants) is now mitigated by the SDK, not by adopter discipline.

**Sandbox routing lives in `tenantToAccount`.** `AccountReference.sandbox?: boolean` flows through to the projector, where adopters either (a) flag the resolved Account so per-handler code routes reads/writes to a sandbox backend, or (b) resolve to a separate sandbox tenant via `resolveByRef(ref)` reading `ref.sandbox`. No new `sandbox?` parameter on the helper API — the projector subsumes both patterns.

**Gate methods are non-writable.** `accounts.upsert` and `accounts.syncGovernance` on the returned store are defined with `writable: false` so an adopter who writes `accounts.upsert = customHandler` after construction gets a `TypeError` in strict mode instead of silently bypassing the tenant gate. To extend the store with `list` / `reportUsage` / `getAccountFinancials`, use `Object.assign(createTenantStore({...}), { list: ... })` rather than direct mutation. (Adopters who genuinely need a custom `upsert` should write a plain `AccountStore` and own the security surface — the helper's invariant is "use it or don't.")

**Per-entry callbacks run sequentially**, not via `Promise.all`. Adopter `upsertRow` / `syncGovernanceRow` callbacks commonly mutate shared tenant state (`tenant.accounts.set(...)`); the helper preserves the prior code's accidental sequential semantics rather than introducing concurrent invocations against the same tenant. Adopters who want parallel writes can fan out inside their callback against an upstream that tolerates it.

**Behavioral drift vs the prior inlined adapter:** `INVALID_REQUEST` is no longer surfaced for malformed refs (operator/brand missing) — wire schema validation upstream catches this before the adopter sees the request. The helper emits `ACCOUNT_NOT_FOUND` for unknown refs that survive validation and `PERMISSION_DENIED` for cross-tenant entries.

`examples/hello_seller_adapter_multi_tenant.ts` migrated to use the helper. The 200+ lines of inlined `accounts.resolve` / `upsert` / `syncGovernance` collapsed to a single `createTenantStore({...})` call. Cross-tenant attack still rejected with `PERMISSION_DENIED`; credentials still stripped from `sync_governance` echo (5.13's `toWireSyncGovernanceRow`). `skills/build-holdco-agent/SKILL.md` updated to lead with `createTenantStore`; the prior inlined-gate documentation is superseded.
