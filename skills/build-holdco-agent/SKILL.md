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
  accounts: AccountStore<TenantMeta> = { resolve, upsert };
  campaignGovernance = defineCampaignGovernancePlatform({ /* ... */ });
  propertyLists = definePropertyListsPlatform({ /* ... */ });
  brandRights = defineBrandRightsPlatform({ /* ... */ });

  private async enforceGovernance(tenant, ctx, offering, req): Promise<AcquireRightsRejected | null> {
    /* cross-specialism dispatch — see below */
  }
}
```

Each specialism interface is the same shape it would have in a single-specialism agent (reuse `skills/build-governance-agent/`, `skills/build-brand-rights-agent/` for per-handler details). The hub-specific work is everything around them: tenancy, isolation, cross-specialism dispatch.

## The two account-resolution paths

The framework calls `accounts.resolve(ref, ctx)` once per request. Hub adapters need both branches:

```ts
accounts.resolve = async (ref, ctx) => {
  // Path 2: no account on the wire (`get_brand_identity`, `get_rights`).
  // Derive tenant from the resolved buyer agent's home tenant.
  if (ref == null) return resolveFromBuyer(ctx);

  // Path 1: account-with-operator on the wire (governance, property-lists,
  // sync_accounts, sync_governance). Look up tenant by operator.
  const operator = (ref as { operator?: string }).operator;
  const brandDomain = (ref as { brand?: { domain?: string } }).brand?.domain;
  if (!operator) return null;
  const tenantId = OPERATOR_TO_TENANT.get(operator);
  if (!tenantId) return null;
  return makeAccount(tenantId, TENANTS.get(tenantId)!, operator, brandDomain);
};
```

`resolveFromBuyer` reads `ctx.agent.agent_url` and looks up the buyer's home tenant via a side map. Without this seam, no-account tools would fall through to a global view and leak data across tenants.

## Tenant-isolation gates (FAIL-CLOSED)

Every mutating handler that takes a wire-supplied `operator` must verify the operator maps to the buyer's authenticated home tenant. Fail-closed shape:

```ts
const homeTenantId = ctx?.agent ? BUYER_HOME_TENANT.get(ctx.agent.agent_url) : undefined;
if (!homeTenantId || tenantId !== homeTenantId) {
  return {
    /* PERMISSION_DENIED row */
  };
}
```

NOT this:

```ts
// FAIL-OPEN: if homeTenantId is undefined, the check skips and any
// operator is accepted. Adopters who add a credential without populating
// BUYER_HOME_TENANT silently disable tenant isolation.
if (homeTenantId && tenantId !== homeTenantId) {
  /* ... */
}
```

This applies to **`accounts.upsert`** (sync_accounts) and to any v5-escape-hatch handler that takes per-entry account refs (`accounts.syncGovernance`, etc.).

## Cross-specialism dispatch

When one specialism's handler needs another's logic, extract a private helper instead of calling sibling specialism methods directly:

```ts
brandRights = defineBrandRightsPlatform({
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
```

The helper:

- Makes the data flow visible at the call site (no inline 30-line block)
- Gives single-specialism adopters a clean copy target
- Forces a place to document the **same-tenant invariant**: `getTenant(ctx)` resolves once per request; both specialisms share it. If a future split lets brand-rights and governance live in different tenants, this in-process call no longer applies.

**⚠️ Always document the "DO NOT copy this short-circuit into a single-specialism agent" warning on the helper's JSDoc.** Single-specialism adopters who don't have a co-resident governance handler need to dial out via the @adcp/sdk client to the registered governance agent's URL — supplying credentials that this hello pattern (intentionally) drops.

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
