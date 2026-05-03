---
name: build-holdco-agent
description: Use when building an AdCP agency / holdco hub — one server hosting multiple specialism agents (governance + brand-rights + property-lists, etc.) with per-tenant data isolation. Distinct from `skills/build-seller-agent/` (single-specialism) and `decisioning-platform-multi-tenant.ts` (host-routed tenancy).
---

# Build an Agency / Holdco Hub Agent

## What you're building

One AdCP server, multiple specialism interfaces, multiple tenants whose data never crosses. The agency holdco shape: a parent company hosts governance, brand-rights, property-lists, and sometimes signals, all on one endpoint, with per-operator tenant routing so each operating company sees only its own data.

Distinct from two adjacent patterns — pick by deployment shape:

| Pattern                                             | Surface                                                            | When                                                                |
| --------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------- |
| **Single-specialism, single-tenant**                | `skills/build-seller-agent/`, `skills/build-signals-agent/`, etc.  | One agent, one role, one tenant                                     |
| **Multi-specialism, single-tenant**                 | This skill                                                         | One process, multiple specialism interfaces, no tenant partitioning |
| **Single-specialism, multi-tenant (host-routed)**   | `examples/decisioning-platform-multi-tenant.ts` + `TenantRegistry` | One specialism, vhost-per-tenant (different agentUrls)              |
| **Multi-specialism, multi-tenant (account-routed)** | This skill (full pattern)                                          | Holdco hub: one URL, account.operator routes to tenant              |

The reference adapter is `examples/hello_seller_adapter_multi_tenant.ts` — fork it.

## When to use

- User wants one server hosting governance + brand-rights together (or any combination of specialisms)
- User describes an "agency hub", "holdco", "shared services platform", or "agency operating multiple brands"
- User mentions "tenant isolation" + "shared catalog" / "shared codebase" / "single deployment"

**Not this skill:**

- One specialism, multi-tenant via vhosts → `examples/decisioning-platform-multi-tenant.ts`
- Multiple specialisms but no tenant partitioning (single-tenant SaaS) → drop the tenant routing and follow the per-specialism skill for each interface
- One agent acting on behalf of multiple brands without specialism overlap → that's a multi-account single-specialism agent; use the per-specialism skill

## The shape: one DecisioningPlatform, three specialism interfaces

```ts
class HoldcoAdapter implements DecisioningPlatform<Config, TenantMeta> {
  capabilities = {
    specialisms: ['governance-spend-authority', 'property-lists', 'brand-rights'] as const,
    config: {},
    brand: { /* RequiredCapabilitiesFor<'brand-rights'> */ },
  };

  agentRegistry = /* BuyerAgentRegistry */;
  accounts: AccountStore<TenantMeta> = createTenantStore({ /* see below */ });
  campaignGovernance = defineCampaignGovernancePlatform({ /* ... */ });
  propertyLists = definePropertyListsPlatform({ /* ... */ });
  brandRights = defineBrandRightsPlatform({ /* ... */ });

  private async enforceGovernance(tenant, ctx, offering, req): Promise<AcquireRightsRejected | null> {
    /* cross-specialism dispatch — see below */
  }
}
```

Each specialism interface is the same shape it would have in a single-specialism agent (reuse `skills/build-governance-agent/`, `skills/build-brand-rights-agent/` for per-handler details). The hub-specific work is everything around them: tenancy, isolation, cross-specialism dispatch.

## Account resolution + tenant-isolation gate (use `createTenantStore`)

The framework calls `accounts.resolve(ref, ctx)` once per request, and hub adapters historically had to hand-write three pieces:

1. **Path 1** — operator-routed resolution for tools that carry `account` on the wire (`sync_accounts`, `sync_governance`, governance, property-lists)
2. **Path 2** — auth-derived resolution for no-account tools (`get_brand_identity`, `get_rights`)
3. **Per-entry tenant-isolation gate** on `sync_accounts` / `sync_governance` — verify each entry's `operator` maps to the buyer's authenticated home tenant before persisting, fail-closed when the auth principal isn't registered

All three live in `createTenantStore<TTenant, TCtxMeta>` (`@adcp/sdk/server`). Callbacks the adopter provides; gating logic the SDK owns:

```ts
accounts: AccountStore<TenantMeta> = createTenantStore<TenantState, TenantMeta>({
  resolveByRef: ref => {  // Path 1 — operator (or account_id) on the wire
    const tenantId = OPERATOR_TO_TENANT.get((ref as { operator?: string }).operator ?? '');
    return tenantId ? TENANTS.get(tenantId) ?? null : null;
  },
  resolveFromAuth: ctx => {  // Path 2 — derive from authenticated buyer agent
    const tenantId = ctx?.agent ? BUYER_HOME_TENANT.get(ctx.agent.agent_url) : undefined;
    return tenantId ? TENANTS.get(tenantId) ?? null : null;
  },
  tenantId: tenant => tenant.id,  // stable equality for the gate (NOT reference)
  tenantToAccount: (tenant, ref, ctx) => ({  // project tenant + ref → Account
    id: tenant.id,
    name: `${tenant.display_name} (${(ref as any)?.operator ?? ctx?.agent?.agent_url})`,
    status: 'active',
    operator: (ref as any)?.operator ?? ctx?.agent?.agent_url ?? 'derived',
    ctx_metadata: { tenant_id: tenant.id, display_name: tenant.display_name },
    sandbox: (ref as any)?.sandbox ?? false,  // SWAP: route to your sandbox backend
  }),
  upsertRow: (tenant, ref, ctx) => {  // sync_accounts — only in-tenant entries reach here
    /* row-level upsert under tenant transaction; gate already filtered */
    return { /* SyncAccountsResultRow */ };
  },
  syncGovernanceRow: (tenant, entry, ctx) => {  // sync_governance — same gating
    /* persist entry.governance_agents on tenant; helper strips credentials on echo */
    return { /* SyncGovernanceResponseRow */ };
  },
});
```

**What the helper guarantees:**

- **Cross-tenant entries never reach `upsertRow` / `syncGovernanceRow`.** The helper resolves `authTenant = resolveFromAuth(ctx)` once per request, then for each entry resolves `entryTenant = resolveByRef(ref)` and emits a `'failed'` row with `code: 'PERMISSION_DENIED'` when `tenantId(authTenant) !== tenantId(entryTenant)`. Adopter callbacks see only in-tenant entries.
- **Fail-closed when `resolveFromAuth` returns null** (unknown principal, no `agentRegistry`, agent_url not in your home-tenant map): every entry fails `PERMISSION_DENIED`. Don't fork around this — the prior fail-OPEN shape (`if (homeTenantId && entryTenant !== homeTenantId)`) silently disabled isolation for credentials lacking a home-tenant binding.
- **`accounts.upsert` and `accounts.syncGovernance` are non-writable** on the returned store. An adopter who writes `accounts.upsert = customHandler` after construction gets a `TypeError` (in strict mode) instead of silently bypassing the gate. To extend with `list` / `reportUsage` / `getAccountFinancials`, use `Object.assign`:

  ```ts
  accounts = Object.assign(
    createTenantStore<TenantState, TenantMeta>({...}),
    { list: async (filter, ctx) => ... }
  );
  ```

**Sandbox lives in `tenantToAccount`.** `AccountReference.sandbox?: boolean` flows through the projector. Two patterns: (1) flag the resolved Account so per-handler code routes reads/writes to a sandbox backend; (2) resolve to a separate sandbox tenant via `resolveByRef` reading `ref.sandbox`. Both are adopter-side decisions — the helper API doesn't take a `sandbox` parameter.

The pre-helper version of this skill documented the inlined gate pattern (with the fail-OPEN anti-pattern flagged in `examples/CONTRIBUTING.md`). That pattern is now superseded — adopters who genuinely need a custom gate write a plain `AccountStore` and own the security surface; everyone else uses `createTenantStore`.

## Cross-specialism dispatch

When one specialism's handler needs another's logic (canonical case: `brandRights.acquireRights` consulting `campaignGovernance.checkGovernance` before granting rights), there is no `ctx.platform.<specialism>` accessor — the framework does not thread a separate platform handle on `RequestContext`. Two idiomatic patterns; pick by authoring style:

### Pattern A — class instance + `this` (canonical for holdco hubs)

The reference adapter (`examples/hello_seller_adapter_multi_tenant.ts`) takes this path. Author the adapter as a class implementing `DecisioningPlatform<TConfig, TCtxMeta>`. Each specialism is a class field; cross-specialism calls go via `this`:

```ts
class HoldcoAdapter implements DecisioningPlatform<Config, TenantMeta> {
  campaignGovernance = defineCampaignGovernancePlatform<TenantMeta>({ /* ... */ });
  brandRights = defineBrandRightsPlatform<TenantMeta>({
    acquireRights: async (req, ctx) => {
      /* validation seams up front */
      const denial = await this.enforceGovernance(tenant, ctx, offering, req);
      if (denial) return denial;
      /* rest of acquire flow */
    },
  });

  private async enforceGovernance(tenant, ctx, offering, req) {
    // Reads tenant.governanceBindings (registered via sync_governance).
    // Calls this.campaignGovernance.checkGovernance internally.
    // Returns AcquireRightsRejected on denial, null otherwise.
  }
}
```

Extracting a `private` method (rather than inlining the 30-line block) gives you:

- Visible data flow at the call site
- A clean copy target for single-specialism adopters
- A place to document the **same-tenant invariant**: `getTenant(ctx)` resolves once per request; both specialisms share it. If a future split lets brand-rights and governance live in different tenants, this in-process call no longer applies.

### Pattern B — closure capture (functional authoring)

If you'd rather build specialisms as standalone factory results (no class), capture the sibling in the closure passed to the second factory. No runnable example ships for Pattern B — Pattern A is the canonical hub shape, and the multi-tenant adapter exercises the full surface; if you go functional, this snippet is the contract:

```ts
const campaignGovernance = defineCampaignGovernancePlatform<TenantMeta>({ /* ... */ });

const brandRights = defineBrandRightsPlatform<TenantMeta>({
  acquireRights: async (req, ctx) => {
    const govResp = await campaignGovernance.checkGovernance!(checkReq, ctx);
    /* ... */
  },
});

const platform: DecisioningPlatform<Config, TenantMeta> = {
  capabilities: { /* ... */ },
  accounts: { /* ... */ },
  campaignGovernance,
  brandRights,
};
```

The `!` after `checkGovernance` is needed because the spec marks it optional on the interface; you know it's defined here because you defined it three lines up.

### What both patterns share

- The `ctx` you forward to the sibling is the same `RequestContext` you received. Resolved account, agent, and authInfo carry through, so tenant invariants hold transitively.
- **In-process calls bypass wire-side validation, idempotency dedup, and the framework's mutating-tool annotations.** That's correct — you're inside the seller's code, not handling a buyer request — but it means an in-process `checkGovernance` won't be re-deduped if the originating tool is already idempotency-protected. If you _want_ buyer-side semantics for the call (e.g., the sibling specialism is hosted on a different tenant or a different process), don't reach for `this` — dial out via `@adcp/sdk`'s client to the registered agent URL.
- **⚠️ Always document the "DO NOT copy this short-circuit into a single-specialism agent" warning** on the helper's JSDoc. Single-specialism adopters who don't have a co-resident governance handler need to dial out via the @adcp/sdk client to the registered governance agent's URL — supplying credentials that this hello pattern (intentionally) drops.

## What `sync_governance` ACTUALLY persists

The wire payload supports up to 10 governance agents per account, with category scoping and write-only `authentication.credentials`. Hello-adapter convention is to record only the first agent's URL + plan binding. Production adopters MUST persist credentials and present them on outbound calls — silently dropping them ships unauthenticated cross-agent requests if real dial-out is added later.

## Spec-correct denial

When governance denies an `acquire_rights`, return `AcquireRightsRejected` (the spec's first-class denial arm), NOT a thrown `GOVERNANCE_DENIED` error code:

```ts
return {
  rights_id: offering.rights_id,
  status: 'rejected',
  brand_id: offering.brand_id,
  reason: `Denied by governance plan ${planId}: ${govResp.explanation}`,
  ...(govResp.findings?.length && {
    suggestions: govResp.findings.map(f => `[${f.severity}] ${f.category_id}: ${f.explanation}`),
  }),
};
```

`GOVERNANCE_DENIED` as a thrown error code is for buy-side flows where the governance agent itself is unreachable or returned a system error — not for adopter-controlled policy decisions.

## Validation seams (request boundary)

Spec-correct validation MUSTs sit at the request boundary, not nested under enforcement helpers. Example for `acquire_rights` under a registered governance binding:

```ts
acquireRights: async (req, ctx) => {
  /* ... pricing + offering validation ... */

  // Validation seam: governance enforcement will project CPM spend, which
  // requires estimated_impressions per spec. Throw INVALID_REQUEST here.
  const hasBinding = tenant.governanceBindings.has(req.buyer.domain);
  if (hasBinding && (req.campaign.estimated_impressions == null || req.campaign.estimated_impressions <= 0)) {
    throw new AdcpError('INVALID_REQUEST', {
      message:
        'campaign.estimated_impressions is required when acquiring CPM-priced rights under a registered governance plan.',
      field: 'campaign.estimated_impressions',
    });
  }

  const denial = await this.enforceGovernance(tenant, ctx, offering, req);
  if (denial) return denial;

  /* rest of flow */
};
```

The spec MUSTs `estimated_impressions` only under intent-phase `governance_context` + CPM. The broader gate above is conservative — when the agent holds a registered binding, projecting spend without impressions silently grants under-priced rights. Production adopters with mixed pricing or `governance_context`-driven flows can tighten.

## Common gotchas

- **`AcquireRightsRequest` has no `account` field on the wire.** Bind by `req.buyer.domain` (a brand reference, not the buyer's account). Track adcontextprotocol/adcp#3918 for the request-shape extension that would let agents bind on (operator, brand) — until it lands, in-tenant collision case is a known limitation.
- **`sync_governance` request has no top-level `account` field.** Framework auth-derives `ctx.account` via `resolveAccountFromAuth`; per-entry tenant gate runs against `entry.account.operator` cross-checked against `ctx.account.ctx_metadata.tenant_id`.
- **`v6` doesn't model `sync_governance` on `AccountStore` yet.** Wire via `opts.accounts.syncGovernance` v5 escape-hatch; promotion tracked at adcontextprotocol/adcp-client#1387.
- **Schema requires `^https://` for `governance_agent_url`.** Local-dev adopters can't register their own server's URL via `sync_governance` without a TLS terminator. Loopback-pattern relaxation tracked at adcontextprotocol/adcp#3918.

## See also

- `examples/hello_seller_adapter_multi_tenant.ts` — the working reference
- `examples/CONTRIBUTING.md` — SWAP-marker convention, fail-closed gate pattern, cross-specialism helper extraction
- `skills/build-governance-agent/`, `skills/build-brand-rights-agent/`, `skills/build-seller-agent/` — per-specialism handler details
- `examples/decisioning-platform-multi-tenant.ts` + `skills/build-decisioning-platform/` — host-routed multi-tenant pattern (different shape; use when each tenant has its own subdomain)
- `skills/triage-storyboard-failure/` — when storyboards fail on your fork
- `skills/run-by-experts/` — convergence-of-reviewers pattern for non-trivial PRs (multi-tenant + auth surfaces are exactly the kind of change this skill calls for)
