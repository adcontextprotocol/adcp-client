---
"@adcp/sdk": minor
---

Three follow-ups to `createTenantStore` (#1387 post-DX review):

- **Export `narrowAccountRef(ref)`** from `@adcp/sdk/server`. The framework already used this internally to read `AccountReference` fields without per-arm narrowing (the wire type is a discriminated union `{account_id} | {brand, operator}` plus optional `sandbox`); adopters writing `tenantToAccount` were cargo-culting `(ref as { operator?: string })` casts at four call sites in the worked example. Single typed accessor consolidates the pattern.

  ```ts
  tenantToAccount: (tenant, ref, ctx) => {
    const r = narrowAccountRef(ref);
    return {
      id: tenant.id,
      operator: r?.operator ?? ctx?.agent?.agent_url ?? 'derived',
      ...(r?.brand?.domain && { brand: { domain: r.brand.domain } }),
      sandbox: r?.sandbox ?? false,
      // ...
    };
  };
  ```

  Returns `undefined` on `undefined` input (the no-account-tool path), so adopters can use the same accessor in `tenantToAccount` and in `resolveByRef` without branching.

- **Default sandbox to `false` in the multi-tenant adapter example.** The post-DX review caught an inconsistency: the adapter set `sandbox: ref?.sandbox ?? true` while the skill snippet used `?? false`. Production adopters route reads/writes to a sandbox backend on this flag — defaulting to `true` would silently land buyer requests in sandbox when they didn't ask. Aligned both to `?? false` with an explicit SWAP comment that frames it as an adopter decision.

- **Warn on overwritten governance bindings** in the multi-tenant adapter. The hello-adapter shortcut keys `governanceBindings` by `(tenant, brand_domain)` because `acquire_rights` doesn't carry an operator on the wire (tracked upstream as adcontextprotocol/adcp#3918). Two operators in the same tenant hitting the same brand share one binding — silently. The example now logs a `console.warn` on overwrite that names the symptom and links the upstream issue, so adopters notice the limitation before it bites in production.

Plus a SKILL cross-link in `tenant-store.ts` JSDoc so the helper's IDE hover surfaces the holdco walkthrough.
