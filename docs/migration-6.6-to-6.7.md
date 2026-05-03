# Migrating from `@adcp/sdk` 6.6 to 6.7

> **Status: GA in 6.7.** Most changes are additive — adopters running on
> 6.6 today see no behavior change on `npm update @adcp/sdk` unless they
> opt in. **Two exceptions** require attention before bumping:
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

## tl;dr — twelve recipes to apply

| #  | If you had 6.6 …                                                                         | Do this in 6.7                                                                                                            | Mechanical?                  |
|----|------------------------------------------------------------------------------------------|---------------------------------------------------------------------------------------------------------------------------|------------------------------|
| 1  | Object-literal platform with `req: unknown` casts on handler bodies                      | Wrap with `definePlatform` (or `defineSalesPlatform` / `defineSignalsPlatform` / etc.) — drop every `as unknown as` cast. | mechanical (codemod-able)    |
| 2  | `'account_id' in ref ? ref.account_id : fallback` open-coded everywhere                  | `refAccountId(ref)` from `@adcp/sdk/server`.                                                                              | mechanical                   |
| 3  | Hand-rolled `before` / `after` wrappers around handler methods                           | `composeMethod(inner, { before, after })` from `@adcp/sdk/server`.                                                        | mechanical                   |
| 4  | Hand-rolled "is this principal authorized for this account?" check after `accounts.resolve` | `composeMethod(resolve, requireAccountMatch / requireAdvertiserMatch / requireOrgScope)`.                              | mechanical (security-relevant) |
| 5  | `accounts.upsert(refs)` and `accounts.list(filter)` with no auth scoping                 | Add `(refs, ctx)` / `(filter, ctx)` and gate / scope on `ctx.agent` or `ctx.authInfo`.                                   | judgment (security-relevant) |
| 6  | `throw new AdcpError('PERMISSION_DENIED', ...)` / `'AUTH_REQUIRED', ...`                 | `throw new PermissionDeniedError('action', opts)` / `throw new AuthRequiredError(opts)`.                                  | mechanical                   |
| 7  | LLM clients hitting the same shape gotcha 3× before recovering                           | Nothing — `issues[].hint` rides every `VALIDATION_ERROR` envelope automatically; oneOf near-miss diagnostics improved.    | client-side only             |
| 8  | Buyer-agent identity not modeled / `ctx.authInfo.token` checked everywhere               | Wire `BuyerAgentRegistry` per [`docs/migration-buyer-agent-registry.md`](./migration-buyer-agent-registry.md).            | judgment                     |
| 9  | One process, multi-tenant — fan out by tenant in your route layer                        | `createTenantRegistry({ ... })` from `@adcp/sdk/server` — one server per tenant, tenant-id keyed lookup.                  | judgment (architectural)     |
| 10 | `resolution: 'implicit'` declared but inline `{account_id}` requests still working       | The framework now refuses them. Either remove the `'implicit'` declaration or stop emitting inline `account_id`.          | **breaking**                 |
| 11 | `: SalesPlatform<Meta>` annotation + claim sales-non-guaranteed / -guaranteed / etc.     | Switch to `: SalesCorePlatform<Meta> & SalesIngestionPlatform<Meta>` (or `defineSalesCorePlatform` + `defineSalesIngestionPlatform` spread). | **breaking** (TS-only)       |
| 12 | Adapter wrapping a vendor OAuth + `/me/adaccounts` upstream — Shape B copy-pasted        | `createOAuthPassthroughResolver({ httpClient, listEndpoint, idField, toAccount })`.                                       | mechanical                   |

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
`agentRegistry` is configured).

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
// Before
if (!ctx.authInfo) throw new AdcpError('AUTH_REQUIRED', { recovery: 'terminal', message: 'Authentication required.' });
if (!agentCanRead(ctx.agent, accountId)) {
  throw new AdcpError('PERMISSION_DENIED', {
    recovery: 'terminal',
    message: `Permission denied for read_account.`,
    details: { action: 'read_account' },
  });
}

// After
import { AuthRequiredError, PermissionDeniedError } from '@adcp/sdk/server';
if (!ctx.authInfo) throw new AuthRequiredError();
if (!agentCanRead(ctx.agent, accountId)) throw new PermissionDeniedError('read_account');
```

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

### 11. **breaking** (TS-only) — `SalesPlatform` split into core + ingestion

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
`SalesPlatform<Meta>` annotation no longer satisfies
`Required<Pick<SalesPlatform<any>, 'getProducts' | ...>>`.

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
previewCreative: async (req, ctx) => {
  if (ctx.account == null) {
    throw new AdcpError('ACCOUNT_NOT_FOUND', { recovery: 'correctable', message: '...' });
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
  createUpstreamHttpClient,
  createOAuthPassthroughResolver,
  defineSalesCorePlatform,
} from '@adcp/sdk/server';

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

## Worked diff — `examples/decisioning-platform-mock-seller.ts`

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

- [`examples/hello_seller_adapter_signal_marketplace.ts`](../examples/hello_seller_adapter_signal_marketplace.ts) — signals + BuyerAgentRegistry + upstream-recorder.
- [`examples/hello_seller_adapter_guaranteed.ts`](../examples/hello_seller_adapter_guaranteed.ts) — `sales-guaranteed` Pattern A annotation.
- [`examples/hello_seller_adapter_social.ts`](../examples/hello_seller_adapter_social.ts) — `sales-social` (ingestion-only) + OAuth passthrough.
- [`examples/hello_creative_adapter_template.ts`](../examples/hello_creative_adapter_template.ts) — `creative-template` + `NoAccountCtx` narrows.
- [`examples/hello_signals_adapter_marketplace.ts`](../examples/hello_signals_adapter_marketplace.ts) — `signal-marketplace`.
- [`examples/hello-cluster.ts`](../examples/hello-cluster.ts) — orchestrator that boots every per-specialism hello adapter on its declared port; emits the YAML routing manifest the storyboard runner consumes via `runStoryboard({ agents })`.

## Self-grade checklist

Walk this before declaring 6.6 → 6.7 done:

- [ ] `grep -rn 'as unknown as' src/` returns zero hits inside platform
      handlers. Use `definePlatform` / `defineSalesCorePlatform` /
      `defineSalesIngestionPlatform` etc. (recipe 1).
- [ ] `grep -rnE "'account_id' in ref" src/` returns zero hits. Use
      `refAccountId(ref)` (recipe 2).
- [ ] `grep -rn 'new AdcpError' src/` reviewed. Auth / permission /
      availability / governance throws use the typed-error classes
      from `@adcp/sdk/server` (recipe 6). `AdcpError` is fine for
      codes without a typed wrapper.
- [ ] If you implement `accounts.upsert` or `accounts.list`, the
      method body reads `ctx?.agent` or `ctx?.authInfo` for
      principal-keyed scoping. Multi-tenant adopters: `list` returns
      only the calling principal's accounts (recipe 5 — security-
      relevant).
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
- [ ] CI runs `npm run check:adopter-types` (or equivalent
      `tsc --noEmit` against the published `.d.ts`).

Items 1, 2, 3, 4, 6, 7, 9, 12 are mechanical / codemod-able. Items 5,
8 are judgment calls — the type system won't tell you whether your
listing scope or your registry posture matches your security model.
Items 10 and 11 are breaking and require auditing before bumping.

## What else changed (no recipe required)

These ride along in 6.7 and don't need any adopter action:

- **`Account.authInfo` is now optional.** Adopters who don't persist
  a principal can omit the field and pass strict typecheck. Adopters
  who do already populate it keep working.
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
  v5 `opts.creative.listCreativeFormats` escape hatch. Dispatcher
  precedence: when both `sales` and `creative` wire it, the
  sales-side handler wins (mediaBuy domain registers first).
- **`update_rights` first-class tool + `creative_approval` webhook
  builders.** Brand-rights adopters wire
  `BrandRightsPlatform.updateRights` instead of the v5 raw-handler
  bag. Per-arm builders for `creativeApproved` /
  `creativeApprovalRejected` / `creativeApprovalRevoked`.
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

## Need help?

- The [BuyerAgentRegistry migration guide](./migration-buyer-agent-registry.md)
  for the registry surface end-to-end.
- The [account-resolution guide](./guides/account-resolution.md)
  for `'explicit'` vs `'implicit'` vs `'derived'` mode selection,
  the `ACCOUNT_NOT_FOUND` vs `AUTH_REQUIRED` error contract, and
  durable-store patterns.
- The [5.x → 6.x migration guide](./migration-5.x-to-6.x.md) if you're
  bumping multiple minors at once.
- The [`call-adcp-agent` SKILL](../skills/call-adcp-agent/SKILL.md)
  for the buyer-side `VALIDATION_ERROR` envelope walkthrough
  (recipe 7 surfaces).
- Worked reference adapters in the `examples/hello_*` family — pick
  the one whose specialism matches yours.
