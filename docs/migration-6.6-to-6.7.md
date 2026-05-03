# Migrating from `@adcp/sdk` 6.6 to 6.7

> **Status: GA in 6.7.** Most changes are additive — adopters running on
> 6.6 today see no behavior change on `npm update @adcp/sdk` unless they
> opt in. **Three exceptions** require attention before bumping:
>
> - **`accounts.resolution: 'implicit'` adopters**: the framework now
>   actually refuses inline `{account_id}` references (the docstring
>   was aspirational pre-6.7). If your platform declared `'implicit'`
>   but accepted inline ids, those calls now reject with
>   `INVALID_REQUEST`. See recipe **#10** below.
> - **Adopters with `: SalesPlatform<Meta>` field annotations claiming
>   `sales-guaranteed` / `sales-non-guaranteed` / `sales-broadcast-tv` /
>   `sales-catalog-driven`**: `SalesPlatform` is now structurally
>   `SalesCorePlatform & SalesIngestionPlatform` with all methods
>   individually optional. The widened annotation will fail
>   `RequiredPlatformsFor<S>` enforcement. See recipe **#11**.
> - **Adopters with `customTools["update_rights"]`**: `update_rights` is
>   now framework-registered. `createAdcpServer` will throw at build time
>   with `customTools["update_rights"] collides with a framework-registered
>   tool`. The throw is server-side and surfaces as HTTP 500 on every
>   client probe — including discovery — masquerading as a transport bug.
>   See recipe **#16**.

## Audit first — the three breaking recipes

Before bumping, read recipes **#10**, **#11**, and **#16**. Everything
else is additive and can be applied incrementally.

- **#10 — `accounts.resolution: 'implicit'` enforces inline-`account_id`
  refusal** (runtime). Inline `{account_id}` references against an
  `'implicit'`-resolution platform now reject with `INVALID_REQUEST`.
  Pre-6.7 this was aspirational — the docstring claimed the framework
  would refuse, but nothing checked it.
- **#11 — `SalesPlatform` split into `SalesCorePlatform &
  SalesIngestionPlatform`** (TS-only, self-announcing under
  `tsc --noEmit`). Adopters with `: SalesPlatform<Meta>` field
  annotations claiming sales-non-guaranteed / -guaranteed /
  -broadcast-tv / -catalog-driven need to migrate the annotation.
  Walled-garden ingestion adopters (Meta CAPI, Snap CAPI, TikTok
  Events) get to drop their stub-throw boilerplate.
- **#16 — `customTools["update_rights"]` collides with the new
  framework-registered `update_rights`** (runtime). Brand-rights
  adopters who previously registered `update_rights` as a customTool
  will see `createAdcpServer` throw at server-build time. Because the
  throw fires inside the request handler (lazy tenant build), every
  MCP probe — including discovery — gets an HTTP 500 with an HTML
  error body, which clients report as `discovery_failed`. Audit with
  `grep -rn 'customTools.*update_rights'` before bumping.

## tl;dr — sixteen recipes to apply

| #  | If you had 6.6 …                                                                         | Do this in 6.7                                                                                                            | Mechanical?                  |
|----|------------------------------------------------------------------------------------------|---------------------------------------------------------------------------------------------------------------------------|------------------------------|
| 1  | Object-literal platform with `req: unknown` casts on handler bodies                      | Wrap with `definePlatform` (or `defineSalesPlatform` / `defineSignalsPlatform` / etc.) — drop every `as unknown as` cast. | mechanical (codemod-able)    |
| 2  | `'account_id' in ref ? ref.account_id : fallback` open-coded everywhere                  | `refAccountId(ref)` from `@adcp/sdk/server`.                                                                              | mechanical                   |
| 3  | Hand-rolled `before` / `after` wrappers around handler methods                           | `composeMethod(inner, { before, after })` from `@adcp/sdk/server`.                                                        | mechanical                   |
| 4  | Hand-rolled "is this principal authorized for this account?" check after `accounts.resolve` | `composeMethod(resolve, requireAccountMatch / requireAdvertiserMatch / requireOrgScope)`.                              | mechanical (security-relevant) |
| 5  | `accounts.upsert(refs)` / `accounts.list(filter)` with no auth scoping; `sync_governance` via v5 escape hatch | Add `(refs, ctx)` / `(filter, ctx)`; promote `sync_governance` to typed `AccountStore.syncGovernance`.                  | judgment (security-relevant) |
| 6  | `throw new AdcpError('PERMISSION_DENIED', ...)` / `'AUTH_REQUIRED', ...`                 | `throw new PermissionDeniedError('action', opts)` / `throw new AuthRequiredError(opts)`.                                  | mechanical                   |
| 7  | LLM clients hitting the same shape gotcha 3× before recovering                           | Nothing — `issues[].hint` rides every `VALIDATION_ERROR` envelope automatically; oneOf near-miss diagnostics improved.    | client-side only             |
| 8  | Buyer-agent identity not modeled / `ctx.authInfo.token` checked everywhere               | Wire `BuyerAgentRegistry` per [`docs/migration-buyer-agent-registry.md`](./migration-buyer-agent-registry.md).            | judgment                     |
| 9  | One process, multi-tenant — fan out by tenant in your route layer                        | `createTenantRegistry({ ... })` from `@adcp/sdk/server` — one server per tenant, tenant-id keyed lookup.                  | judgment (architectural)     |
| 10 | `resolution: 'implicit'` declared but inline `{account_id}` requests still working       | The framework now refuses them. Either remove the `'implicit'` declaration or stop emitting inline `account_id`.          | **breaking**                 |
| 11 | `: SalesPlatform<Meta>` annotation + claim sales-non-guaranteed / -guaranteed / etc.     | Switch to `: SalesCorePlatform<Meta> & SalesIngestionPlatform<Meta>` (or `defineSalesCorePlatform` + `defineSalesIngestionPlatform` spread). | **breaking** (TS-only)       |
| 12 | Adapter wrapping a vendor OAuth + `/me/adaccounts` upstream — Shape B copy-pasted        | `createOAuthPassthroughResolver({ httpClient, listEndpoint, idField, toAccount })`.                                       | mechanical                   |
| 13 | Hand-rolled `accounts.resolve` + per-entry tenant-isolation gate on `upsert` / `syncGovernance` for a multi-tenant adapter | `createTenantStore({...})` — built-in security gate, fail-closed when auth principal can't be resolved.        | mechanical (security-relevant) |
| 14 | Local copy of the media-buy / creative status-transition graph                           | Import `MEDIA_BUY_TRANSITIONS` / `assertMediaBuyTransition` (and the creative pair) from `@adcp/sdk/server`.              | mechanical                   |
| 15 | Sellers claiming `property-lists` / `collection-lists` echoing `targeting_overlay` by hand | `mediaBuyStore: createMediaBuyStore({ store })` opt-in framework wiring.                                                | mechanical (narrow)          |
| 16 | Brand-rights adopter with `customTools: { update_rights: ... }`                          | Drop the customTools entry and wire `BrandRightsPlatform.updateRights` instead. The framework now owns the tool name.   | **breaking**                 |

`refAccountId` already shipped in 6.6 (recipe #2); it's listed because
the eight-item list in #1344 included it as a "stop reinventing this"
pointer for adopters bumping straight from earlier minors.

## Recipes

### 1. Drop `req: unknown` casts with `definePlatform` / `defineSalesPlatform`

**Why this exists.** `createAdcpServerFromPlatform<P extends DecisioningPlatform<any,any>>(platform: P)`
infers `P` from the argument, which defeats TypeScript's contextual
typing for nested method parameters. Inline platforms in 6.6 had to
either annotate every handler by hand or accept `req: unknown` and
cast inside the body.

**Before (6.6):**

```ts
createAdcpServerFromPlatform({
  capabilities: { specialisms: ['sales-social'], /* ... */ },
  accounts: { resolve: async (ref) => ... },
  sales: {
    syncEventSources: async (req, ctx) => {
      const sources = ((req as { event_sources?: unknown[] }).event_sources ?? [])
        .map((s) => s as { id: string });
      // ... 16 more casts across the handler body
    },
  },
}, opts);
```

**After (6.7):**

```ts
import {
  createAdcpServerFromPlatform,
  defineSalesIngestionPlatform,
  definePlatform,
} from '@adcp/sdk/server';

interface SocialMeta { advertiserId: string; pixelId: string }

createAdcpServerFromPlatform(
  definePlatform<{ networkId: string }, SocialMeta>({
    capabilities: { specialisms: ['sales-social'], /* ... */ },
    accounts: { resolve: async (ref, ctx) => ... },
    sales: defineSalesIngestionPlatform<SocialMeta>({
      syncEventSources: async (req, ctx) => {
        const sources = req.event_sources ?? [];        // typed ✓
        // ctx.account.ctx_metadata: SocialMeta ✓
      },
    }),
  }),
  opts
);
```

The full helper set lives in `src/lib/server/decisioning/platform-helpers.ts`:

| Helper                              | Wraps                                                          |
|-------------------------------------|----------------------------------------------------------------|
| `definePlatform`                    | Whole `DecisioningPlatform<TConfig, TCtxMeta>` literal         |
| `definePlatformWithCompliance`      | Same, but compile-time-requires `capabilities.compliance_testing` *and* `complyTest` in opts |
| `defineSalesPlatform`               | `sales:` (full `SalesPlatform` — convenience for adopters spanning core + ingestion). See **recipe #11**: post-#1341 the return type is all-optional. |
| `defineSalesCorePlatform`           | `sales:` core media-buy lifecycle (`getProducts`, `createMediaBuy`, `updateMediaBuy`, `getMediaBuyDelivery`, `getMediaBuys` — all required) |
| `defineSalesIngestionPlatform`      | `sales:` ingestion surface (`syncCreatives`, `syncCatalogs`, `syncEventSources`, `logEvent`, etc. — all optional individually) |
| `defineAudiencePlatform`            | `audiences:` field                                             |
| `defineSignalsPlatform`             | `signals:` field                                               |
| `defineCreativeBuilderPlatform`     | `creative:` (template + generative variants)                   |
| `defineCreativeAdServerPlatform`    | `creative:` (ad-server variant)                                |
| `defineCampaignGovernancePlatform`  | `campaignGovernance:` field                                    |
| `defineContentStandardsPlatform`    | `contentStandards:` field                                      |
| `definePropertyListsPlatform`       | `propertyLists:` field                                         |
| `defineCollectionListsPlatform`     | `collectionLists:` field                                       |
| `defineBrandRightsPlatform`         | `brandRights:` field                                           |

**Class-pattern adopters.** If you implement `DecisioningPlatform`
with a class and explicit property-type annotations
(`sales: SalesCorePlatform<Meta> & SalesIngestionPlatform<Meta> = { ... }`),
do nothing — TypeScript contextual-types handler params from the
property annotation. The helpers are an object-literal escape hatch.

### 2. `refAccountId(ref)` instead of open-coded `'account_id' in ref` checks

`AccountReference` is a discriminated union (`{account_id}` /
`{brand, operator}` / sandbox variants). 6.6-era resolvers paper over
that with an inline narrowing check on every call site:

**Before:**

```ts
resolve: async (ref) => {
  const id = ref && 'account_id' in ref ? ref.account_id : 'fallback';
  return db.findById(id);
}
```

**After:**

```ts
import { refAccountId } from '@adcp/sdk/server';

resolve: async (ref, ctx) => {
  const id = refAccountId(ref);
  if (id) return db.findById(id);
  return db.findByOAuthClient(ctx?.authInfo?.credential?.client_id ?? '');
}
```

`refAccountId` returns `string | undefined` — undefined for missing
refs, `{brand, operator}` arms, or sandbox arms. Branch on the
undefined case explicitly; don't rely on a falsy fallback.

### 3. Replace hand-rolled wrappers with `composeMethod`

`composeMethod` wraps a single handler with optional `before` /
`after` hooks. Same `(params, ctx) => Promise<TResult>` signature in
and out, so the wrapped method slots into a typed `DecisioningPlatform`
shape without `as` casts.

**Before (typical 6.6 pattern):**

```ts
const innerGetMediaBuyDelivery = basePlatform.sales.getMediaBuyDelivery;
basePlatform.sales.getMediaBuyDelivery = async (req, ctx) => {
  if (req.optimization === 'price' && cachedPriceOpt) return cachedPriceOpt;
  const result = await innerGetMediaBuyDelivery(req, ctx);
  return { ...result, ext: { ...result.ext, carbon_grams_per_impression: await score(result) } };
};
```

**After:**

```ts
import { composeMethod } from '@adcp/sdk/server';

const wrapped = {
  ...basePlatform,
  sales: {
    ...basePlatform.sales,
    getMediaBuyDelivery: composeMethod(basePlatform.sales.getMediaBuyDelivery, {
      before: async (params) =>
        params.optimization === 'price' && cachedPriceOpt
          ? { shortCircuit: cachedPriceOpt }
          : undefined,
      after: async (result) => ({
        ...result,
        ext: { ...result.ext, carbon_grams_per_impression: await score(result) },
      }),
    }),
  },
};
```

Semantics worth knowing:

- `before` returning `undefined` falls through. Returning
  `{ shortCircuit: value }` skips the inner call.
- `after` runs whether the result came from the inner method or a
  short-circuit, so a 100% cache-hit path still gets enrichment
  applied.
- `after` runs **before** response-schema validation. Decorations have
  to satisfy the wire schema — vendor-specific fields belong under
  `ext`.
- `composeMethod` validates `inner` is a function at wrap time.
  Referencing an optional method that wasn't implemented on the
  platform throws at module load, not at first traffic.

### 4. `accounts.resolve` security presets

`accounts.resolve` answers "what's the tenant for this reference?";
the question that follows is "is the calling principal *authorized*
for that tenant?" Pre-6.7 every multi-tenant adopter rolled this
post-resolve check by hand. 6.7 adds three composable presets that
plug into `composeMethod` over `accounts.resolve`:

- `requireAccountMatch(predicate, opts)` — general post-resolve
  guard. Predicate runs against the resolved account + ctx;
  `false` denies.
- `requireAdvertiserMatch(getRoster, opts)` — gate on
  `account.advertiser ∈ roster` returned by `getRoster(ctx)`.
- `requireOrgScope(getAccountOrg, getCtxOrg, opts)` — gate on
  `account-side org === ctx-side org`.

**Default deny** returns `null` (indistinguishable from
"account-not-found"; guards against principal enumeration). Opt in to
`onDeny: 'throw'` only when the principal is already known to know
the account exists — it surfaces `PermissionDeniedError`.

**Before:**

```ts
const innerResolve = async (ref, ctx) => db.findById(refAccountId(ref) ?? '');

accounts: {
  resolve: async (ref, ctx) => {
    const account = await innerResolve(ref, ctx);
    if (!account) return null;
    const roster = tenantRoster.for(ctx?.agent);
    if (!account.advertiser || !roster.has(account.advertiser)) return null;
    return account;
  },
}
```

**After:**

```ts
import { composeMethod, requireAdvertiserMatch } from '@adcp/sdk/server';

accounts: {
  resolve: composeMethod(
    innerResolve,
    requireAdvertiserMatch(async (ctx) => tenantRoster.for(ctx?.agent))
  ),
}
```

For one-off rules use `requireAccountMatch`; for org-scoping use
`requireOrgScope`. The presets compose cleanly with the OAuth
passthrough resolver (recipe #12) — wrap `createOAuthPassthroughResolver(...)`'s
return value with `composeMethod(..., requireAdvertiserMatch(...))`
to get listing-derived resolution + roster gating on one line.

### 5. `accounts.upsert(refs, ctx)` / `accounts.list(filter, ctx)` — principal-keyed gating

In 6.6, `AccountStore.upsert(refs)` and `list(filter)` had no `ctx`
argument, so adopters had no way to authorize on the calling
principal without re-deriving identity from the request. 6.7 makes
both methods accept an optional `ResolveContext` (`ctx`) carrying
the same shape already threaded to `resolve` / `reportUsage` /
`getAccountFinancials`: `authInfo`, `toolName`, and `agent` (when an
`agentRegistry` is configured). 6.7 also promotes
`AccountStore.syncGovernance` to a typed v6 method — adopters who
claimed `governance-aware-seller` no longer have to drop into the v5
escape-hatch (`opts.accounts.syncGovernance`) with `as any` casts.
The framework strips `governance_agents[i].authentication.credentials`
on the wire-emit boundary so write-only credentials don't echo back
in the response or get cached for idempotency replay.

**Security-relevant migration note.** Pre-6.7, multi-tenant adopters
either returned all accounts from `list` (over-disclosure) or
rejected the operation entirely. Post-6.7 you can scope per-principal
— **but it is opt-in, not automatic.** If you don't update `list`,
every authenticated caller still sees every account.

**Before (6.6):**

```ts
accounts: {
  resolve: async (ref) => /* ... */,
  upsert: async (refs) => refs.map((r) => upsertOne(r)),
  list: async (filter) => ({ accounts: db.allAccounts(filter), pagination: ... }),
}
```

**After (6.7):**

```ts
import { PermissionDeniedError } from '@adcp/sdk/server';

accounts: {
  resolve: async (ref, ctx) => /* ... */,
  upsert: async (refs, ctx) => {
    if (!agentMayBillVia(ctx?.agent, refs[0]?.billing)) {
      throw new PermissionDeniedError('sync_accounts', {
        message: 'Buyer agent not permitted to bill via this account',
      });
    }
    return refs.map((r) => upsertOne(r));
  },
  list: async (filter, ctx) => {
    // Scope to the calling agent's accounts. Without this, every
    // authenticated caller sees every account.
    return db.listAccounts(filter, { agentUrl: ctx?.agent?.agent_url });
  },
}
```

Backwards-compatible at the type level: `ctx` is optional, so
existing impls that don't accept the second arg keep compiling. The
behavior change you have to make consciously is the listing-scope
one.

### 6. Typed errors from `@adcp/sdk/server` instead of `new AdcpError(code, ...)`

The typed-error barrel
(`src/lib/server/decisioning/errors-typed.ts`) existed in 6.x for
the not-found family (`MediaBuyNotFoundError`, `PackageNotFoundError`,
etc.). 6.7 fills out the auth / permission / availability / governance
families that 6.6 adopters were instantiating with raw `AdcpError`:

| Throw …                        | Instead of `new AdcpError(...)` with                                 |
|--------------------------------|----------------------------------------------------------------------|
| `AuthRequiredError`            | `'AUTH_REQUIRED'`                                                    |
| `PermissionDeniedError(action)`| `'PERMISSION_DENIED'` + `details.action`                             |
| `RateLimitedError(retryAfter)` | `'RATE_LIMITED'` + `retry_after`                                     |
| `ServiceUnavailableError`      | `'SERVICE_UNAVAILABLE'`                                              |
| `UnsupportedFeatureError(feature)` | `'UNSUPPORTED_FEATURE'` + `details.feature`                      |
| `ComplianceUnsatisfiedError(reason)` | `'COMPLIANCE_UNSATISFIED'`                                     |
| `GovernanceDeniedError`        | `'GOVERNANCE_DENIED'`                                                |
| `PolicyViolationError`         | `'POLICY_VIOLATION'`                                                 |
| `ProductUnavailableError`      | `'PRODUCT_UNAVAILABLE'`                                              |
| `CreativeRejectedError`        | `'CREATIVE_REJECTED'`                                                |
| `BudgetTooLowError`            | `'BUDGET_TOO_LOW'`                                                   |
| `BudgetExhaustedError`         | `'BUDGET_EXHAUSTED'`                                                 |
| `IdempotencyConflictError`     | `'IDEMPOTENCY_CONFLICT'`                                             |
| `InvalidRequestError`          | `'INVALID_REQUEST'`                                                  |
| `InvalidStateError`            | `'INVALID_STATE'`                                                    |
| `BackwardsTimeRangeError`      | `'INVALID_REQUEST'` + `field: 'start_time'`                          |

Each typed class auto-maps to its wire error code with `recovery`
baked in (`'terminal'` for not-found / permission, `'retryable'` for
rate / availability, etc.) and applies a sensible default `message`
that you can override via `opts.message`.

```ts
// Before — inside a SalesPlatform method
createMediaBuy: async (req, ctx) => {
  if (!ctx.account.authInfo) {
    throw new AdcpError('AUTH_REQUIRED', { recovery: 'terminal', message: 'Authentication required.' });
  }
  if (!agentCanRead(ctx.agent, ctx.account.id)) {
    throw new AdcpError('PERMISSION_DENIED', {
      recovery: 'terminal',
      message: `Permission denied for create_media_buy.`,
      details: { action: 'create_media_buy' },
    });
  }
  // ...
}

// After
import { AuthRequiredError, PermissionDeniedError } from '@adcp/sdk/server';

createMediaBuy: async (req, ctx) => {
  if (!ctx.account.authInfo) throw new AuthRequiredError();
  if (!agentCanRead(ctx.agent, ctx.account.id)) throw new PermissionDeniedError('create_media_buy');
  // ...
}
```

> The principal lives at `ctx.account.authInfo` inside specialism
> methods (`SalesPlatform` / `AudiencePlatform` / etc.) and at
> `ctx.authInfo` inside `accounts.resolve(ref, ctx)` (`ResolveContext`).
> Distinct shapes; same field, different paths — see the 5.x → 6.x
> migration doc § "Common gotchas" for the full callout.

### 7. Surface `issues[].hint` in your LLM client, plus oneOf near-miss

`ValidationIssue` (the structured error riding every
`VALIDATION_ERROR` envelope) carries an optional `hint?: string`
field. The hint is a one-sentence curated recipe sourced from
`src/lib/validation/hints.ts` for shape gotchas the matrix runs and
adopter feedback have flagged repeatedly:

- `activation_key` / `signal_id` discriminator nesting
- `account` discriminator merging (picking `{account_id}` *or*
  `{brand, operator}`, not both)
- `budget` as object instead of number
- `brand.brand_id` vs `brand.domain`
- `format_id` as string vs `{agent_url, id}` object
- `signal_ids[]` as bare strings vs provenance objects
- VAST/DAAST `delivery_type` missing its paired payload
- `idempotency_key` missing on mutating tools
- log_event / CAPI projection gotchas (SHAPE-GOTCHAS §6 — `event_name`
  vs `event_type`, ISO 8601 vs UNIX seconds, hashed-identifier
  requirement on `user_data`)

You don't need to do anything server-side to emit these — the
framework attaches them automatically when a recognized pattern fires.
Update your buyer-side client to read `hint` first when recovering
from `VALIDATION_ERROR`.

**Plus, oneOf near-miss diagnostics improved.** When your response
populates the Success arm of a Success-vs-Error oneOf but is missing
required fields, the validator now points at the Success variant's
residuals (`#/oneOf/0/required: missing currency`) instead of the
unactionable "must NOT be valid" plus stale Error-variant residuals.
Adopters whose `get_account_financials` / similar response oneOf
payloads were hitting this no longer have to mentally project the
fix — the diagnostic is direct.

```
Recovery order:
  1. issues[i].hint       — when present, the validated fix path
  2. issues[i].discriminator — names which union branch was inferred
  3. issues[i].variants   — full list when no branch was inferred
  4. issues[i].pointer + keyword + message — leaf-level fix
```

`skills/call-adcp-agent/SKILL.md` has the full envelope walkthrough
if your client follows the SKILL.

### 8. Wire `BuyerAgentRegistry` for durable buyer identity

`BuyerAgentRegistry` is a separate, larger migration with its own
guide. **If you want the registry, follow that guide.** The 6.7
release surfaces it as the canonical way to thread buyer-agent
identity through `ctx.agent` to every `AccountStore` method
(`resolve`, `upsert`, `list`, `reportUsage`, `getAccountFinancials`)
and now, post-#1323, to the `tasks_get` polling path as well.

→ [`docs/migration-buyer-agent-registry.md`](./migration-buyer-agent-registry.md)

What 6.7 added on top of the original Phase 1 stages:

- **`tasks_get` threading** — registry consulted on poll;
  `ctx.agent` flows to your `accounts.resolve` from `tasks_get`
  the same as every other tool.
- **Tenant-registry credential redaction tightening** — wire-
  projected `TenantStatus.reason` runs through the credential
  redactor (closes #1330). No adopter-visible API change; just an
  exposure-surface fix you get for free.
- **`BuyerAgent.sandbox_only`** — defense-in-depth field. Set on
  test agents; framework rejects requests against non-sandbox
  accounts with `PERMISSION_DENIED`.

### 9. `createTenantRegistry` for multi-tenant hosts

Surface unchanged in 6.7 from 6.x; called out here because adopters
bumping from earlier minors keep open-coding tenant fan-out. The
registry gives you tenant-id-keyed lookup, async health gates, and
JWKS validation per tenant:

```ts
import { createTenantRegistry, createSelfSignedTenantKey } from '@adcp/sdk/server';

const registry = createTenantRegistry({
  defaultServerOptions: { name: 'shared-host', version: '1.0.0' },
});

registry.register('tenant-a', {
  agentUrl: 'https://shared.example.com/api/tenant-a',
  signingKey: await createSelfSignedTenantKey({ keyId: 'tenant-a-key' }),
  platform: tenantAPlatform,
});

// In your route layer:
const resolved = registry.get(tenantId); // { tenantId, config, server } | null
if (resolved) await resolved.server.handleRequest(req, res);
```

When your route layer already binds `tenantId` (path-routed
multi-tenant), use `registry.get(tenantId)` rather than
`resolveByRequest(canonicalHost, ...)` URL-parsing tricks. Same
`pending` / `disabled` health gate either way. The end-to-end pattern
for DB-seeded startup, runtime register / unregister, and concurrent
recheck is now in
[`examples/decisioning-platform-multi-tenant-db.ts`](../examples/decisioning-platform-multi-tenant-db.ts).

**Make construction errors observable.**
`createTenantRegistry.register()` calls `createAdcpServerFromPlatform()`
synchronously — config errors (collision throws like recipe #16,
missing required handlers, invalid `signingKey` shape) fire inside
`register()`. The cleanest path is to register eagerly at process
boot: in a single-region server, that's the `app.listen` callback or
a top-level `await` for ESM. DB-seeded tenants load the seed list at
boot, register each row, then start serving.

Lazy registration is legitimate — autoscaling replicas where eager
register-all would JWKS-storm cold start, multi-tenant SaaS hosts
where the tenant table mutates faster than redeploys, serverless
warm-start where boot *is* first request — but watch what happens
when `register()` throws inside a request handler. By default the
host framework returns HTTP 500 with an HTML error body, MCP clients
classify the HTML as a non-MCP response, and the failure surfaces as
`discovery_failed` on every probe. If you defer construction, catch
the throw at the registration site and route it through your error
pipeline (logs, metrics, alerts) so a config bug fails loudly instead
of as a buyer-visible 500. Runtime admin-API `register` for tenant
onboarding is fine — just keep buyer-path requests off the
registration call site.

### 10. **breaking** — `accounts.resolution: 'implicit'` enforces inline-`account_id` refusal

The `AccountStore.resolution` docstring has long claimed the framework
refuses inline `{account_id}` references on `'implicit'`-resolution
platforms. Pre-6.7 the docstring was aspirational; nothing in the
runtime checked it. 6.7 wires the refusal: implicit-resolution
platforms now reject inline `{account_id}` references with
`AdcpError('INVALID_REQUEST', { field: 'account.account_id' })`
*before* the request reaches your `accounts.resolve`. The
`{brand, operator}` arm is still permitted (it's used during the
initial `sync_accounts` flow).

**Action required.** Audit `accounts.resolution`:

| Your pre-6.7 setup                                                                       | What to do                                                                                                                                       |
|------------------------------------------------------------------------------------------|--------------------------------------------------------------------------------------------------------------------------------------------------|
| `resolution: 'implicit'` declared, all buyers used `sync_accounts` first                 | Nothing — calls flow as before; you no longer need to reimplement the `if (ref?.account_id) return null` branch in your resolver.                |
| `resolution: 'implicit'` declared but adopters' callers passed inline `account_id`       | **Behavior change.** Either drop to `'explicit'` (callers continue passing inline) or fix callers to use `sync_accounts` first.                  |
| Wanted "derive account from auth principal, ignore inline ids entirely"                  | Switch to `resolution: 'derived'` — single-tenant agents and adapters that always identify the tenant from the auth principal alone (LinkedIn-shaped sellers, some retail-media operators). |
| `resolution: 'explicit'` (default) declared / not declared                               | Nothing — the refusal only applies to declared `'implicit'` platforms.                                                                           |
| Hand-rolled implicit store                                                               | Consider switching to `InMemoryImplicitAccountStore` or the Postgres pattern in [`docs/guides/account-resolution.md`](./guides/account-resolution.md). |

**Companion: `InMemoryImplicitAccountStore` reference adapter.** 6.7
ships an `InMemoryImplicitAccountStore<TCtxMeta>` that implements
`upsert()` (record `authKey → accounts[]` from the buyer's
`sync_accounts` call) and `resolve()` (look up by `authKey` on
subsequent tools) with a configurable `keyFn` (defaults to
`credential.client_id` / `credential.key_id` / `credential.agent_url`)
and `ttlMs` (default 24 h). Copy-and-adapt for Postgres / Redis-backed
stores; see `examples/decisioning-platform-implicit-accounts.ts` for
the runnable wiring.

```ts
import { InMemoryImplicitAccountStore } from '@adcp/sdk/server';

const accountStore = new InMemoryImplicitAccountStore({
  buildAccount: async (ref, ctx) => {
    const upstream = await myPlatform.findOrCreate(ref, ctx?.authInfo);
    return { id: upstream.id, name: upstream.name, status: 'active', ctx_metadata: { upstreamId: upstream.id } };
  },
});
```

**Companion: `createRosterAccountStore` for publisher-curated rosters
(Shape C).** Adopters who own the roster (storefront table,
admin-UI-managed JSON, in-memory map) — `resolution: 'explicit'` —
get a complete `AccountStore` from a `lookup(id, ctx)` callback plus
a `toAccount(row, ctx)` projector. Replaces ~150 LOC of
extract-id-then-project boilerplate with ~50.

```ts
import { createRosterAccountStore } from '@adcp/sdk/server';

const accounts = createRosterAccountStore({
  lookup: async (id, ctx) => {
    const tenantId = deriveTenant(ctx?.authInfo);
    return await db.oneOrNone(
      'SELECT * FROM storefront_accounts WHERE id = $1 AND tenant = $2',
      [id, tenantId]
    );
  },
  toAccount: row => ({
    id: row.id,
    name: row.name,
    status: row.status,
    ctx_metadata: { tenant: row.tenant, upstreamRef: row.upstream_ref },
  }),
  list: async (filter, ctx) => /* opt-in cursor pagination */,
});
```

Point-lookup by design — adopters with thousands of accounts per
tenant in Postgres run `SELECT WHERE id = $1` rather than
materializing the roster on every request. `list` is opt-in (omit
and the framework emits `UNSUPPORTED_FEATURE`); no `upsert` /
`reportUsage` because publisher-curated rosters don't have buyer-
driven writes. Compose a spread for adopters who need both:
`{ ...createRosterAccountStore(...), refreshToken: ... }`.

**Ref-less tools (`list_creative_formats`, `preview_creative`,
`provide_performance_feedback`).** These tools send no `account`
field on the wire. By default `createRosterAccountStore` returns
`null` for ref-less calls (`ctx.account` is `undefined` in the
handler). Use the `resolveWithoutRef` option to return a synthetic
publisher-wide account instead — the returned entry flows through
`toAccount` like any `lookup` hit. See
[Ref-less resolution](./guides/account-resolution.md#ref-less-resolution-list_creative_formats-preview_creative-provide_performance_feedback)
in `docs/guides/account-resolution.md`.

The three-shape map adopters now reach for:

| Shape  | Resolution  | Helper                              | Use when                                                                         |
|--------|-------------|-------------------------------------|----------------------------------------------------------------------------------|
| **A**  | `'implicit'`  | `InMemoryImplicitAccountStore`        | Buyer drives onboarding via `sync_accounts`; framework owns the linkage map.    |
| **B**  | `'explicit'`  | `createOAuthPassthroughResolver`      | Adapter fronts a vendor OAuth + `/me/adaccounts` listing endpoint (Snap, Meta). |
| **C**  | `'explicit'`  | `createRosterAccountStore`            | Publisher owns the roster (storefront table, admin UI). Adopter brings `lookup`. |

### 11. **breaking** (TS-only) — `SalesPlatform` split into core + ingestion

**Headline for walled-garden CAPI adopters: you no longer write
stub-throws for `getProducts` / `createMediaBuy` / `updateMediaBuy` /
`getMediaBuyDelivery` / `getMediaBuys`.** Meta CAPI, Snap CAPI, TikTok
Events, and other ingestion-only specialisms shed roughly 40 LOC of
"throw `UNSUPPORTED_FEATURE`" boilerplate by claiming `sales-social`
and only implementing the ingestion methods their storyboard
exercises.

`SalesPlatform` methods are now individually optional. Per-specialism
enforcement of the core media-buy lifecycle moves up to
`RequiredPlatformsFor<S>`. Two named subset types:

- **`SalesCorePlatform<TCtxMeta>`** — `getProducts`, `createMediaBuy`,
  `updateMediaBuy`, `getMediaBuyDelivery`, `getMediaBuys` (all
  required). Mapped to `sales-non-guaranteed` / `sales-guaranteed` /
  `sales-broadcast-tv` / `sales-catalog-driven`.
- **`SalesIngestionPlatform<TCtxMeta>`** — `syncCreatives`,
  `syncCatalogs`, `syncEventSources`, `logEvent`, `listCreativeFormats`,
  `listCreatives`, `providePerformanceFeedback` (all optional
  individually). Mapped to `sales-social` and other walled-garden
  ingestion specialisms.

`SalesPlatform = SalesCorePlatform & SalesIngestionPlatform` is
preserved as a structural-compat alias.

**Why it broke.** Adopters who explicitly typed the field annotation —
`sales: SalesPlatform<Meta> = defineSalesPlatform<Meta>({ ... })` — and
who claim a specialism whose `RequiredPlatformsFor<S>` requires the
core methods now hit a TS error: the widened all-optional
`SalesPlatform<Meta>` annotation no longer satisfies what
`RequiredPlatformsFor<'sales-guaranteed'>` (et al.) demands. The
literal compiler error reads roughly:

```
Property 'getProducts' is optional in type 'SalesPlatform<Meta>' but
  required in type 'Required<Pick<SalesCorePlatform<Meta>, 'getProducts'
  | 'createMediaBuy' | 'updateMediaBuy' | 'getMediaBuyDelivery'
  | 'getMediaBuys'>>'
```

`tsc --noEmit` (or `npm run check:adopter-types`) surfaces this on
upgrade — the breaking change is self-announcing for adopters with a
typecheck step in CI.

**Two clean migrations:**

```ts
// Pattern A — explicit field annotation (recommended; shortest)
class MySeller implements DecisioningPlatform<Config, Meta> {
  capabilities = { specialisms: ['sales-guaranteed' as const], /* ... */ };
  accounts = makeAccounts();
  sales: SalesCorePlatform<Meta> & SalesIngestionPlatform<Meta> = {
    getProducts: async (req, ctx) => { /* ... */ },
    createMediaBuy: async (req, ctx) => { /* ... */ },
    updateMediaBuy: async (id, patch, ctx) => { /* ... */ },
    getMediaBuyDelivery: async (filter, ctx) => { /* ... */ },
    getMediaBuys: async (req, ctx) => { /* ... */ },
    syncCreatives: async (creatives, ctx) => { /* optional */ },
  };
}

// Pattern B — spread the new sub-helpers
const sales = {
  ...defineSalesCorePlatform<Meta>({
    getProducts, createMediaBuy, updateMediaBuy, getMediaBuyDelivery, getMediaBuys,
  }),
  ...defineSalesIngestionPlatform<Meta>({ syncCreatives, syncCatalogs, logEvent }),
};
```

**Stays the same:**

- `defineSalesPlatform<Meta>({...})` is preserved for source compat
  and is still right for `sales-social` and other ingestion-only
  adopters whose `RequiredPlatformsFor<S>` doesn't enforce core-method
  presence. The post-#1341 caveat is documented inline on the helper.
- Runtime: dispatcher in `from-platform.ts` conditionally registers
  core handlers based on method presence; omitting `getProducts` from
  a `sales-social` platform doesn't crash. Buyers receive
  `METHOD_NOT_FOUND` for unsupported tools, or the v5 merge-seam fills
  in via `opts.mediaBuy.X`.
- The runtime `validateSpecialismRequiredTools` check still warns (or
  throws under `strictSpecialismValidation: true`) when a claimed
  specialism's required tools aren't implemented anywhere on the
  platform.

`examples/hello_seller_adapter_guaranteed.ts` shows Pattern A wired
end-to-end against the published `sales-guaranteed` mock-server.

**Companion: `NoAccountCtx<TCtxMeta>` for no-account tools.** Tools
whose wire request doesn't carry an `account` field —
`preview_creative`, `list_creative_formats`,
`provide_performance_feedback` — now use a `NoAccountCtx<TCtxMeta>`
request-context type whose `account: Account<TCtxMeta> | undefined`.
Adopters who dereference `ctx.account` unconditionally on these tools
will hit a TS error. Three patterns:

```ts
// 1. Singleton fallback — accounts.resolve(undefined) returns a non-null Account.
//    ctx.account is always defined; no narrow needed.

// 2. Auth-derived lookup — accounts.resolve(undefined, ctx) reads ctx.authInfo.
//    Same as #1.

// 3. Defensive narrow inside the handler:
import { AccountNotFoundError } from '@adcp/sdk/server';

previewCreative: async (req, ctx) => {
  if (ctx.account == null) {
    throw new AccountNotFoundError({ message: 'Workspace required for preview.' });
  }
  const ws = ctx.account.ctx_metadata.workspace_id;
  // ...
}
```

### 12. `createOAuthPassthroughResolver` — Shape B canonical resolver

Adapters wrapping a vendor OAuth + ad-account API (Snap, Meta, TikTok,
LinkedIn, Reddit, Pinterest, …) all repeat the same pattern: extract
the bearer from `ctx.authInfo`, call `GET /me/adaccounts`, match the
upstream row by `account_id`, return a tenant with `ctx_metadata`
populated. Pre-6.7 every adapter wrote ~30 lines of boilerplate. 6.7
ships a factory:

```ts
import {
  createOAuthPassthroughResolver,
  createUpstreamHttpClient,
  definePlatform,
  defineSalesCorePlatform,
} from '@adcp/sdk/server';
// or `@adcp/sdk/adapters` / `@adcp/sdk` root — all three re-export it

const snap = createUpstreamHttpClient({
  baseUrl: 'https://adsapi.snapchat.com',
  auth: {
    kind: 'dynamic_bearer',
    getToken: async (ctx) => ctx?.authInfo?.credential?.token,
  },
});

const resolve = createOAuthPassthroughResolver({
  httpClient: snap,
  listEndpoint: '/v1/me/adaccounts',
  idField: 'id',
  rowsPath: 'adaccounts',
  toAccount: (row, ctx) => ({
    id: row.id,
    name: row.name,
    status: 'active',
    advertiser: row.advertiser_url,
    ctx_metadata: { upstreamId: row.id },
  }),
  cache: { ttlMs: 60_000 },
});

const platform: DecisioningPlatform<Cfg, Meta> = definePlatform({
  capabilities: { specialisms: ['sales-non-guaranteed'], /* ... */ },
  accounts: { resolve, /* upsert can be a no-op for Shape B */ },
  sales: { /* ... */ },
});
```

Configurable `idField`, `rowsPath`, `getAuthContext`, and opt-in TTL
cache (auth-context-keyed so different buyers don't share entries).
Composes naturally with the `accounts.resolve` security presets from
recipe #4 — wrap the resolver with
`composeMethod(resolve, requireAdvertiserMatch(...))` for
listing-derived resolution + roster gating in one statement.

**What the factory doesn't handle (yet):**

- **Pagination.** `rowsPath` reads a single response shape; vendors
  paginate differently — Snap returns `paging.next_page`, Meta
  returns `paging.cursors`, LinkedIn uses `start` + `count`. If your
  buyer fleet hits accounts beyond the first page, wrap the resolver
  in your own loop or use `createUpstreamHttpClient` directly to walk
  pages before handing rows to a custom resolver.
- **Per-account capability filtering.** Meta's `/me/adaccounts` returns
  `tasks: ['MANAGE', 'ADVERTISE', ...]` per row; Snap returns
  `roles[]`; LinkedIn returns `role`. Filter inside `toAccount` (return
  a row that the calling principal lacks the capability for as a row
  with `status: 'inactive'` or `null`) — the factory itself just
  matches on `idField`.
- **Vendor rate limits on `/me/adaccounts`.** Each vendor rate-limits
  the listing endpoint per access token (Meta's app-level cap is the
  tightest in practice). The TTL cache helps, but for high-QPS buyer
  fleets default `ttlMs: 60_000` may still exceed the cap — tune up
  or add backoff in the inner `httpClient`.

### 13. `createTenantStore` — multi-tenant `AccountStore` with built-in security gate

Holdco / multi-tenant adapters all write the same two-path resolution
shape (operator-routed for tools that carry `account` on the wire;
auth-derived for no-account tools like `get_brand_identity` /
`get_rights`) AND the same per-entry tenant-isolation gate on
`accounts.upsert` / `accounts.syncGovernance`. The gate is the
load-bearing security check — adopters historically had to write it
**and silently fail to write it** in every adapter. 6.7 ships
`createTenantStore` so the SDK owns the gate.

```ts
import { createTenantStore } from '@adcp/sdk/server';

const accounts = createTenantStore<TenantState, TenantMeta>({
  resolveByRef:        (ref)         => /* wire ref → tenant or null */,
  resolveFromAuth:     (ctx)         => /* auth principal → tenant or null */,
  tenantId:            (tenant)      => tenant.id,
  tenantToAccount:     (tenant, ref, ctx) => /* Account<TenantMeta> */,
  upsertRow:           (tenant, ref, ctx) => /* SyncAccountsResultRow */,
  syncGovernanceRow:   (tenant, entry, ctx) => /* row */,
});
```

What the gate does (built in, not opt-in):

- On `upsert` / `syncGovernance`, resolves the auth principal's
  tenant once via `resolveFromAuth(ctx)`, then for each entry
  resolves the entry's tenant via `resolveByRef(ref)`.
- Entries whose tenant differs are emitted as `'failed'` rows with
  `code: 'PERMISSION_DENIED'` BEFORE invoking `upsertRow` /
  `syncGovernanceRow`. **Cross-tenant entries never reach adopter
  code.**
- Fail-closed when `resolveFromAuth` returns null: every entry
  fails `PERMISSION_DENIED` regardless of operator.
- `accounts.upsert` and `accounts.syncGovernance` on the returned
  store are non-writable — `accounts.upsert = customHandler` after
  construction throws `TypeError` in strict mode.

What's NOT generated: `list` / `reportUsage` / `getAccountFinancials`.
Those don't fit the per-entry-then-row pattern (cursor pagination;
per-row account refs spanning tenants). Adopters wire those on top:
`Object.assign(createTenantStore({...}), { list: ... })` (mutation
after construction is refused for the gate methods, but
`Object.assign` adds list cleanly).

`examples/hello_seller_adapter_multi_tenant.ts` is the worked
end-to-end. The 200+ lines of hand-rolled `accounts.resolve` /
`upsert` / `syncGovernance` + tenant gate collapsed to a single
`createTenantStore({...})` call. The original B1 finding from the
holdco-adapter security review (where adopters routing by
wire-supplied operator without cross-checking the auth principal
could write across tenants) is now mitigated by the SDK, not by
adopter discipline.

### 14. State-machine helpers — `MEDIA_BUY_TRANSITIONS` and friends

Sellers enforcing media-buy / creative status transitions previously
copy-pasted the lifecycle graph into their own code (three example
files were doing this). Spec-version bumps to the lifecycle would
silently desync the copies. 6.7 exports the canonical graphs from
`@adcp/sdk/server` — same source the storyboard runner's
`status.monotonic` invariant uses, so production sellers that
enforce transitions with these helpers cannot drift from conformance
enforcement.

```ts
import {
  MEDIA_BUY_TRANSITIONS,
  CREATIVE_ASSET_TRANSITIONS,
  isLegalMediaBuyTransition,
  assertMediaBuyTransition,
  assertCreativeTransition,
} from '@adcp/sdk/server';

updateMediaBuy: async (id, patch, ctx) => {
  const current = await db.findStatus(id);
  if (patch.status) {
    // Throws AdcpError with the spec-correct code:
    //   NOT_CANCELLABLE for the cancel-idempotency path,
    //   INVALID_STATE everywhere else.
    assertMediaBuyTransition(current, patch.status);
  }
  // ...
}
```

If you'd rather branch than throw, use the boolean predicate:

```ts
if (patch.status && !isLegalMediaBuyTransition(current, patch.status)) {
  return planAlternativeAction(current, patch.status);
}
```

Replace any local `STATUS_TRANSITIONS` constant in your codebase
with the SDK export.

### 15. `createMediaBuyStore` — `targeting_overlay` echo on `get_media_buys`

Sellers claiming `property-lists` or `collection-lists` MUST include
the persisted `PropertyListReference` / `CollectionListReference`
inside the echoed `targeting_overlay` on `get_media_buys` per
schemas/cache/3.0.5 (every other seller SHOULD echo). Pre-6.7,
satisfying the contract meant every adapter persisted + merged +
echoed by hand. 6.7 ships `createMediaBuyStore` as an opt-in
framework wiring:

```ts
import {
  createAdcpServerFromPlatform,
  createMediaBuyStore,
  InMemoryStateStore,
} from '@adcp/sdk/server';

const stateStore = new InMemoryStateStore();

createAdcpServerFromPlatform(myPlatform, {
  mediaBuyStore: createMediaBuyStore({ store: stateStore }),
});
```

Adopters who already persist + echo `targeting_overlay` themselves
keep doing so — the framework prefers the seller's response when both
paths produce a value. The store fills the gap for adopters who
hadn't wired echo yet (the canonical silent-storyboard-failure for
`media_buy_seller/inventory_list_targeting/get_after_create`).

### 16. **breaking** — drop `customTools["update_rights"]`; wire `BrandRightsPlatform.updateRights`

`update_rights` is now a framework-registered first-class tool (PR
#1349). The `customTools` collision check at server build time will
throw with:

```
createAdcpServer: customTools["update_rights"] collides with a
framework-registered tool.
```

The throw is server-side and fires inside `createAdcpServer()` at
construction. `createTenantRegistry.register()` builds eagerly, so
adopters who register every tenant at process boot will see this fail
visibly during deploy. Adopters who wrap `createTenantRegistry()` in a
per-request lazy-init factory defer construction until first traffic —
the throw still fires, but inside the request handler, where the host
framework's default error handler renders it as HTTP 500 HTML to every
MCP probe. Clients (correctly) classify the HTML as a non-MCP response
and report `discovery_failed`, which makes the regression look like a
client-side transport bug. It isn't — see recipe #9 for the
registration patterns that surface this kind of config error during
deploy.

**Audit:**

```bash
grep -rn 'customTools.*update_rights' src/
```

**Before (6.6):**

```ts
createAdcpServerFromPlatform(brandPlatform, {
  customTools: {
    update_rights: customToolFor(
      'update_rights',
      'Update an existing rights grant — extend dates, adjust caps, pause/resume.',
      UPDATE_RIGHTS_SCHEMA,
      handleUpdateRights,
    ),
    creative_approval: customToolFor(/* ... */),
  },
});
```

**After (6.7):**

```ts
import { defineBrandRightsPlatform } from '@adcp/sdk/server';

const brandPlatform = defineBrandRightsPlatform<MyMeta>({
  // ... existing brand-rights handlers ...
  updateRights: handleUpdateRights, // <- promoted from customTool
});

createAdcpServerFromPlatform(brandPlatform, {
  customTools: {
    creative_approval: customToolFor(/* ... */), // unchanged
  },
});
```

`creative_approval` is still customTool territory in 6.7 — only
`update_rights` was promoted. Future SDK releases may promote
additional tools the same way. The collision-check error always names
the framework-handler equivalent (`BrandRightsPlatform.updateRights`
here), so when the next promotion-induced collision lands, follow the
message: drop the customTools entry, wire the named platform handler.
The pattern travels even if the migration recipe lags.

## Worked diff — `examples/decisioning-platform-mock-seller.ts`

> **Illustrative — not a verbatim diff against the file.** The
> snippets below show the recipes layered onto a mock-seller-shaped
> adapter; the field-level shape is faithful but identifiers like
> `db.listAccounts` and `MockSellerConfig` are placeholders. Apply
> the recipes against your own adapter; for a real, runnable
> end-to-end example see the `hello_*` family below.

The reference adapter's `accounts.resolve` reads cleaner with the
6.7 primitives applied. Same observable behavior; fewer casts and
fewer hand-rolled checks.

```diff
- import {
-   createAdcpServerFromPlatform,
-   AdcpError,
- } from '@adcp/sdk/server';
+ import {
+   createAdcpServerFromPlatform,
+   definePlatform,
+   defineSalesCorePlatform,
+   refAccountId,
+   AuthRequiredError,
+   PermissionDeniedError,
+ } from '@adcp/sdk/server';

- function makeAccounts(): AccountStore<MockSellerMeta> {
-   return {
-     resolution: 'explicit',
-     resolve: async (ref: AccountReference) => {
-       const id = 'account_id' in ref ? ref.account_id : 'mock_acc_1';
-       return { id, name: 'Mock Account', /* ... */ };
-     },
-   };
- }
+ function makeAccounts(): AccountStore<MockSellerMeta> {
+   return {
+     resolution: 'explicit',
+     resolve: async (ref, ctx) => {
+       const id = refAccountId(ref) ?? 'mock_acc_1';
+       return { id, name: 'Mock Account', /* ... */ };
+     },
+     list: async (filter, ctx) => {
+       // Scope listing to the calling agent. Without this, every
+       // authenticated caller sees every account.
+       return db.listAccounts(filter, { agentUrl: ctx?.agent?.agent_url });
+     },
+   };
+ }

- const platform: DecisioningPlatform<MockSellerConfig, MockSellerMeta> = {
-   capabilities: { specialisms: ['sales-non-guaranteed'], /* ... */ },
-   accounts: makeAccounts(),
-   sales: {
-     getProducts: async (req, ctx) => { /* req: unknown without annotation */ },
-     createMediaBuy: async (req, ctx) => {
-       if (!ctx.account.authInfo) {
-         throw new AdcpError('AUTH_REQUIRED', { recovery: 'terminal' });
-       }
-       /* ... */
-     },
-   },
- };
+ const platform = definePlatform<MockSellerConfig, MockSellerMeta>({
+   capabilities: { specialisms: ['sales-non-guaranteed'], /* ... */ },
+   accounts: makeAccounts(),
+   sales: defineSalesCorePlatform<MockSellerMeta>({
+     getProducts: async (req, ctx) => { /* req: GetProductsRequest ✓ */ },
+     createMediaBuy: async (req, ctx) => {
+       if (!ctx.account.authInfo) throw new AuthRequiredError();
+       /* ... */
+     },
+     updateMediaBuy: async (id, patch, ctx) => { /* ... */ },
+     getMediaBuyDelivery: async (filter, ctx) => { /* ... */ },
+     getMediaBuys: async (req, ctx) => { /* ... */ },
+   }),
+ });
```

The `hello_*` adapter family is the copy-paste starting point:

- [`examples/hello_signals_adapter_marketplace.ts`](../examples/hello_signals_adapter_marketplace.ts) — `signal-marketplace` + BuyerAgentRegistry + upstream-recorder.
- [`examples/hello_seller_adapter_guaranteed.ts`](../examples/hello_seller_adapter_guaranteed.ts) — `sales-guaranteed` Pattern A annotation.
- [`examples/hello_seller_adapter_social.ts`](../examples/hello_seller_adapter_social.ts) — `sales-social` (ingestion-only) + OAuth passthrough.
- [`examples/hello_creative_adapter_template.ts`](../examples/hello_creative_adapter_template.ts) — `creative-template` + `NoAccountCtx` narrows.
- [`examples/hello_seller_adapter_multi_tenant.ts`](../examples/hello_seller_adapter_multi_tenant.ts) — multi-specialism + multi-tenant + AdCP 3.0.5 pin.
- [`examples/hello-cluster.ts`](../examples/hello-cluster.ts) — orchestrator that boots every per-specialism hello adapter on its declared port; emits the YAML routing manifest the storyboard runner consumes via `runStoryboard({ agents })`.

## Self-grade checklist

Walk this before declaring 6.6 → 6.7 done:

- [ ] `grep -rn --include='*.ts' 'as unknown as' src/` reviewed by
      hand. Zero hits inside platform handler bodies — verify per-hit,
      since legitimate non-handler casts will match. Use `definePlatform`
      / `defineSalesCorePlatform` / `defineSalesIngestionPlatform`
      etc. (recipe 1).
- [ ] `grep -rnE --include='*.ts' "'account_id' in ref" src/` returns
      zero hits. Use `refAccountId(ref)` (recipe 2).
- [ ] `grep -rn --include='*.ts' 'new AdcpError' src/` reviewed. Auth
      / permission / availability / governance throws use the typed-
      error classes from `@adcp/sdk/server` (recipe 6). `AdcpError` is
      fine for codes without a typed wrapper.
- [ ] If you implement `accounts.upsert` or `accounts.list`, the
      method body **reads and acts on** `ctx?.agent` or `ctx?.authInfo`
      — not just destructures it. Multi-tenant adopters: confirm by
      sending a test request from a second principal and asserting
      `list_accounts` returns a smaller / different set than principal
      A would see (recipe 5 — security-relevant).
- [ ] Multi-tenant `accounts.resolve` adopters: post-resolve "is this
      principal authorized for this account?" check uses
      `requireAccountMatch` / `requireAdvertiserMatch` /
      `requireOrgScope` rather than open-coded predicates (recipe 4).
- [ ] Hand-rolled `before` / `after` wrappers around platform methods
      replaced with `composeMethod` (recipe 3). Optional, but you'll
      pick up wrap-time function-validity check for free.
- [ ] Buyer-side LLM clients read `issues[].hint` before walking
      `discriminator` / `variants` / leaf-level fixes (recipe 7).
- [ ] Decided on `BuyerAgentRegistry` — either wired (recipe 8) or
      explicitly deferred. The registry is opt-in; not adopting it is
      a valid choice as long as you've made it consciously.
- [ ] Multi-tenant hosts use `createTenantRegistry`'s `get(tenantId)`
      rather than open-coded tenant fan-out (recipe 9).
- [ ] **`accounts.resolution: 'implicit'` adopters audited.** Either
      callers were already using `sync_accounts` first, or the
      declaration is dropped to `'explicit'`, or callers fixed
      (recipe 10). Inline `{account_id}` on `'implicit'` platforms
      now rejects with `INVALID_REQUEST`.
- [ ] **Sales-* adopters typecheck.** Either drop the explicit
      `: SalesPlatform<Meta>` annotation, or change it to
      `: SalesCorePlatform<Meta> & SalesIngestionPlatform<Meta>`,
      or use `defineSalesCorePlatform` + `defineSalesIngestionPlatform`
      spread (recipe 11). `tsc --noEmit` is green under
      `RequiredPlatformsFor<S>` enforcement.
- [ ] **No-account tool handlers narrow `ctx.account`.**
      `previewCreative` / `listCreativeFormats` /
      `providePerformanceFeedback` either guarantee a singleton
      account from `accounts.resolve(undefined)` or guard with
      `if (ctx.account == null) ...` (recipe 11 companion).
- [ ] Adapters wrapping vendor OAuth + `/me/adaccounts` use
      `createOAuthPassthroughResolver` rather than hand-rolling
      Shape B (recipe 12).
- [ ] **Multi-tenant adopters use `createTenantStore`** (recipe 13)
      rather than open-coded `accounts.resolve` + per-entry tenant
      gate. The SDK now owns the gate — adopters who keep their
      hand-rolled gate must verify cross-tenant entries are rejected
      with `PERMISSION_DENIED` *before* their `upsert` / `syncGovernance`
      callbacks run.
- [ ] **Status-transition checks use `MEDIA_BUY_TRANSITIONS` /
      `assertMediaBuyTransition`** (recipe 14) rather than a local
      copy of the lifecycle graph. Spec-version bumps to the lifecycle
      now travel through the SDK export.
- [ ] **`property-lists` / `collection-lists` adopters wire
      `createMediaBuyStore`** (recipe 15) OR confirm their existing
      `targeting_overlay` echo on `get_media_buys` returns the
      persisted list reference inside the overlay. Storyboard step
      `media_buy_seller/inventory_list_targeting/get_after_create`
      passes.
- [ ] **`Account` v3 wire fields are populated** for billing /
      lifecycle adopters. `billing_entity` (with `bank` stripped on
      emit), `setup` (`pending_approval` → `active` lifecycle),
      `payment_terms`, `credit_limit`, `account_scope`,
      `governance_agents`, `reporting_bucket` flow through `toWireAccount`
      and `toWireSyncAccountRow` projections.
- [ ] CI runs `npm run check:adopter-types` (or equivalent
      `tsc --noEmit` against the published `.d.ts`).

Items 1, 2, 3, 4, 6, 7, 9, 12, 14 are mechanical / codemod-able. Items
5, 8, 13, 15 are judgment / architectural — the type system won't tell
you whether your listing scope, registry posture, tenant gate, or echo
contract matches your security model and storyboard. Items 10 and 11
are breaking and require auditing before bumping.

## What else changed (no recipe required)

These ride along in 6.7 and don't need any adopter action:

- **`Account.authInfo` is now optional.** Adopters who don't persist
  a principal can omit the field and pass strict typecheck. Adopters
  who do already populate it keep working. **Footgun**: code that
  used a non-null assertion (`ctx.account.authInfo!.token`) compiles
  fine but throws at runtime if you rebuild your `Account` fixture
  shape from the new optional type and drop the field. Narrow with
  `if (!ctx.account.authInfo) throw new AuthRequiredError();` instead.
- **`AccountStore.reportUsage` and `getAccountFinancials` get
  `ctx.agent`.** Same threading as `resolve` / `upsert` / `list`;
  read-only addition for adopters that already wired
  `BuyerAgentRegistry`.
- **`DecisioningPlatform.instructions` accepts a function form.**
  `(ctx: SessionContext) => string | undefined` fires per session
  under `serve({ reuseAgent: false })` (the default) — useful for
  per-tenant prose without a `Map` shim outside the SDK. Static
  string still works. Async returns and `reuseAgent: true` are
  refused at construction (kept loud rather than silently
  degrading).
- **`DecisioningCapabilities.creative_agents` / `channels` /
  `pricingModels` are optional.** Signals-only platforms drop the
  empty-array boilerplate. `validatePlatform` enforces the fields
  for `sales-*` specialisms.
- **`listCreativeFormats?` on `CreativeBuilderPlatform` and
  `CreativeAdServerPlatform`.** Creative-agent adopters that own a
  format catalog wire it as a typed platform method instead of the
  v5 `opts.creative.listCreativeFormats` escape hatch. **Footgun**:
  when both `sales` and `creative` wire `listCreativeFormats`, the
  sales-side handler wins (mediaBuy domain registers first) and the
  creative-side handler is silently dropped. Wire it on exactly one
  surface — pick the one whose specialism actually owns the format
  catalog.
- **`update_rights` first-class tool + `creative_approval` webhook
  builders.** Brand-rights adopters wire
  `BrandRightsPlatform.updateRights` instead of the v5 raw-handler
  bag. Per-arm builders for `creativeApproved` /
  `creativeApprovalRejected` / `creativeApprovalRevoked`. **Breaking
  for adopters who previously registered `update_rights` as a
  `customTools` entry — see recipe #16.**
- **Auto-hydration is now spec-driven.** Hydration call sites read
  `x-entity` annotations from the manifest instead of hand-rolled
  `(field_name, ResourceKind)` literals. Future spec field renames
  travel through codegen automatically. No adopter-visible change.
- **`mintEphemeralEd25519Key()`** at `@adcp/sdk/signing/testing` —
  test/dev keypair generator that returns a fully-shaped
  `AdcpJsonWebKey`.
- **`createTranslationMap` and `createUpstreamHttpClient`** at
  `@adcp/sdk/server` — adapter-translation helpers for upstream
  platform integration. Replace per-adapter `httpJson` boilerplate.
- **`@adcp/sdk/upstream-recorder`** — producer-side middleware that
  populates the `query_upstream_traffic` buffer the runner-output-
  contract v2's `upstream_traffic` storyboard check reads. Sandbox-
  only by default; multi-tenant factory pattern documented in the
  SKILL.
- **`@adcp/sdk/mock-server`** is a public sub-export. Adopters can
  `import { bootMockServer }` for in-process integration tests
  instead of spawning the CLI.
- **`runStoryboard({ agents })`** — per-specialism storyboard
  routing. Storyboards spanning multiple specialisms route each
  step to the tenant that owns its tool, matching the prod
  test-agent topology (`/sales`, `/signals`, `/governance`,
  `/creative`, `/brand`). Conflicts fail-fast at storyboard-build
  time with named conflicting agents.
- **Specialism required-tools validation** — construction-time
  warning (or throw under `strictSpecialismValidation: true`) when
  a claimed specialism's required-tool isn't implemented anywhere
  on the platform. Currently a no-op against AdCP 3.0.4 (the spec's
  authoritative `required_tools` arrays are empty); activates on
  next manifest sync once the spec populates them.
- **Manifest-derived error codes.** `STANDARD_ERROR_CODES` is now
  generated from `schemas/cache/<v>/manifest.json` rather than
  hand-curated. Public API unchanged; drift is now impossible.
- **`media_buy_ids[]` fan-out semantics — pass-through.** When buyers
  call `get_media_buy_delivery` / `get_creative_delivery` with
  multiple `media_buy_ids`, the framework hands the array to your
  platform method as-is rather than synthesizing a per-buy fan-out.
  `aggregated_totals` (cross-buy `reach`, `new_to_brand_rate`,
  `frequency`) depends on dedup capability that's platform-domain
  knowledge — populate the cross-buy fields when you can compute
  them, omit them otherwise. JSDoc on `SalesPlatform.getMediaBuyDelivery`
  and `CreativeAdServerPlatform.getCreativeDelivery` documents the
  contract. Paired dev-mode warning (suppressible via
  `ADCP_SUPPRESS_MULTI_ID_WARN=1`) fires when your handler returns
  fewer rows than the buyer requested — catches the canonical
  `media_buy_ids[0]`-truncation bug class at adapter-development
  time. Quiet in production where legitimate misses are routine.
- **`Account<TCtxMeta>` v3 wire alignment.** `Account` gained
  `billing_entity`, `rate_card`, `payment_terms`, `credit_limit`,
  `setup`, `account_scope`, `governance_agents`, and
  `reporting_bucket` — all optional. Adopters returning these from
  `accounts.resolve` / `accounts.list` see them projected onto the
  wire. **Security**: `billing_entity.bank` is stripped on emit
  (write-only per spec); adopters who load and return a full DB row
  don't leak bank coordinates. `governance_agents[i]` is projected
  to `{ url, categories }` only — auth credentials don't echo. The
  `setup` payload (`url`, `message`, `expires_at`) drives the
  `pending_approval` → `active` lifecycle; previously silently
  dropped on emit.
- **Cross-specialism dispatch on `DecisioningPlatform`.** No
  `ctx.platform.<specialism>` accessor — when a method on one
  specialism needs to call another (e.g., `sales.getProducts`
  reading from `creative.listCreativeFormats`), use class instance
  + `this` (`hello_seller_adapter_multi_tenant.ts` shows the
  pattern) or closure capture across `define<X>Platform` factories.
  Both forward the same `RequestContext` so the resolved account /
  agent / authInfo carry through, and both bypass wire-side
  validation + idempotency dedup (correct for in-process calls but
  worth knowing).
- **`composeMethod` testing recipes** at
  [`docs/recipes/composeMethod-testing.md`](./recipes/composeMethod-testing.md).
  Six test patterns with matching running tests so the patterns
  can't rot independently of the implementation. Covers mocking the
  base method, short-circuit assertion (including the
  `{ shortCircuit: undefined }` gotcha), layering two `composeMethod`
  calls, `after`-hook enrichment, typed-error propagation, and
  `requireAdvertiserMatch` with `composeMethod`.
- **Sales-social planning surface in the mock-server.** `delivery_estimate`,
  `audience_reach_estimate`, and `lookalike` endpoints on the
  `sales-social` mock so adapters can wire `Product.forecast` from
  real walled-garden Marketing APIs (Meta / TikTok / Snap /
  LinkedIn) instead of returning `forecast: undefined`. CPM bands
  are calibrated to 2024-2026 walled-garden benchmarks; budgets clamp
  to platform learning-phase floors with `min_budget_warning`. The
  `sales-guaranteed` mock similarly grew `POST /v1/forecast` and
  `POST /v1/availability` (GAM-shaped). The seller-skill specialism
  docs (`sales-social.md`, `sales-guaranteed.md`) show worked
  `getProducts` snippets.
- **`narrowAccountRef`** at `@adcp/sdk/server` — discriminated-union
  narrowing helper for `AccountReference`, returns the typed arm or
  `null` instead of branching by `'account_id' in ref` / `'brand' in ref`.
  Pairs with `refAccountId(ref)` (recipe #2) when you also need
  brand+operator handling.
- **Storyboard runner — `task_completion.<key>` context_outputs +
  webhook-receiver fallback.** Storyboard authors can capture
  task-completion fields via `task_completion.<key>` in
  `context_outputs`, with webhook-receiver fallback when the agent
  doesn't reach completion synchronously. Adopter-relevant only if
  you author storyboards; existing storyboards keep working.

## What didn't change in 6.7

A few things adopters always look for in a minor bump — explicit "no
change" callouts so you don't go hunting:

- **Delivery reporting (`getMediaBuyDelivery`)** — wire shape and
  semantics unchanged. Same `media_buys[].metrics` shape, same
  filter semantics. Move on.
- **Idempotency** — `idempotency_key` is still required on every
  mutating tool per the AdCP 3.0 GA contract (CLAUDE.md § Protocol-
  Wide Requirements). The 6.7 release adds `IdempotencyConflictError`
  to the typed-error barrel (recipe #6) but the wire-level replay
  semantics are unchanged.
- **Webhook signing** — RFC 9421 surface unchanged. `signed-requests`
  is still preview; verifier behavior is identical. `TenantConfig.signingKey`
  is still optional in 3.x (becomes required in 4.0 per the
  `migration-5.x-to-6.x.md` callout — no shift in 6.7).

## Need help?

- The [BuyerAgentRegistry migration guide](./migration-buyer-agent-registry.md)
  for the registry surface end-to-end.
- The [account-resolution guide](./guides/account-resolution.md)
  for `'explicit'` vs `'implicit'` vs `'derived'` mode selection,
  the `ACCOUNT_NOT_FOUND` vs `AUTH_REQUIRED` error contract, and
  durable-store patterns.
- The [ctx_metadata safety guide](./guides/CTX-METADATA-SAFETY.md)
  if you persist anything sensitive on `Account.ctx_metadata` —
  the wire-strip protects buyer responses but not server-side log
  lines, error envelopes, heap dumps, or adopter-generated strings.
  Re-derive bearers per request from `ctx.authInfo`; embed only
  non-secret upstream IDs in `ctx_metadata`.
- The [5.x → 6.x migration guide](./migration-5.x-to-6.x.md) if you're
  bumping multiple minors at once.
- The [`call-adcp-agent` SKILL](../skills/call-adcp-agent/SKILL.md)
  for the buyer-side `VALIDATION_ERROR` envelope walkthrough
  (recipe 7 surfaces).
- Worked reference adapters in the `examples/hello_*` family — pick
  the one whose specialism matches yours.
