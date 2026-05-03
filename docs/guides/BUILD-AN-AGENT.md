# Build an AdCP Agent

## Overview

This guide walks through building an AdCP agent (server) using `@adcp/sdk`. While most documentation covers the client side — calling existing agents — this guide covers the server side: implementing an agent that other clients can discover and call.

We'll build a **signals agent** that serves audience segments via the `get_signals` tool. The same patterns apply to any AdCP tool (`get_products`, `create_media_buy`, etc.) — for mutating tools, see the `create_media_buy` example in the Calling Tools section below.

## Prerequisites

- Node.js 18+
- `@adcp/sdk` installed (`npm install @adcp/sdk`)
- `@modelcontextprotocol/sdk` (installed as a dependency of `@adcp/sdk`)

## Two paths

`@adcp/sdk` exposes two server entry points. Pick based on the agent
shape:

- **`createAdcpServerFromPlatform`** — **recommended for new agents.**
  You declare a typed `DecisioningPlatform` (per-specialism interfaces:
  `SalesCorePlatform` + `SalesIngestionPlatform`, `CreativeBuilderPlatform`,
  `AudiencePlatform`, `SignalsPlatform`, `CampaignGovernancePlatform`,
  `BrandRightsPlatform`, etc.) and the framework wires capability
  projection, idempotency, RFC 9421 signing, async tasks, status
  normalization, lifecycle state, multi-tenant routing, and webhook
  auto-emit on sync mutations. Compile-time enforcement via
  `RequiredPlatformsFor<S>` catches missing methods before runtime.
  6.7 `definePlatform` / `defineSalesCorePlatform` / etc. helpers let
  you write inline platform literals without `req: unknown` casts.
- **`createAdcpServer`** — the lower-level handler-bag API. Still
  fully supported (it's the substrate `createAdcpServerFromPlatform`
  calls into) but lives at `@adcp/sdk/server/legacy/v5` in 6.x.
  Reach for it only when mid-migration from a v5 codebase, when you
  need a custom-shaped tool the platform interface doesn't yet model,
  or when you've decided to own the whole handler bag yourself. The
  appendix at the bottom of this guide covers it.

For multi-specialism production agents (sales + creative + governance +
brand-rights), see `docs/migration-5.x-to-6.x.md` and
`docs/migration-6.6-to-6.7.md`. The `examples/hello_*` family is the
copy-paste starting point for each specialism.

## Quick Start

A minimal signals agent using `createAdcpServerFromPlatform` + the v6
`definePlatform` / `defineSignalsPlatform` identity helpers:

```typescript
import { serve } from '@adcp/sdk';
import {
  createAdcpServerFromPlatform,
  definePlatform,
  defineSignalsPlatform,
} from '@adcp/sdk/server';

const platform = definePlatform({
  capabilities: {
    specialisms: ['signal-marketplace'] as const,
    pricingModels: ['cpm'] as const,
  },
  accounts: {
    resolve: async () => ({ id: 'acc_1', ctx_metadata: {} }),
  },
  signals: defineSignalsPlatform({
    getSignals: async (req, ctx) => ({
      signals: [
        {
          signal_agent_segment_id: 'demo_segment',
          signal_id: { source: 'catalog', data_provider_domain: 'example.com', id: 'demo_segment' },
          name: 'Demo Segment',
          description: 'A demo audience segment.',
          value_type: 'binary',
          signal_type: 'owned',
          data_provider: 'My Agent',
          coverage_percentage: 10,
          deployments: [],
          pricing_options: [
            { pricing_option_id: 'po_demo', model: 'cpm', currency: 'USD', cpm: 5 },
          ],
        },
      ],
      sandbox: true,
    }),
    activateSignal: async (req, ctx) => ({
      /* ... */
    }),
  }),
});

serve(() => createAdcpServerFromPlatform(platform, { name: 'My Signals Agent', version: '1.0.0' }));
// listening on http://localhost:3001/mcp
```

Start it and test immediately:

```bash
npx tsx agent.ts
npx @adcp/sdk@latest http://localhost:3001/mcp                    # discover tools
npx @adcp/sdk@latest http://localhost:3001/mcp get_signals '{}'   # call get_signals
```

`definePlatform` / `defineSignalsPlatform` (and the sibling
`defineSalesCorePlatform` / `defineSalesIngestionPlatform` / etc.) are
pure identity helpers from `@adcp/sdk/server`. They force a concrete
platform interface as the parameter type so TypeScript flows
`req` / `ctx` typing into nested handler bodies — adopters who skipped
them on inline platforms historically saw `req: unknown` and had to
cast in every handler. Class-pattern adopters with explicit property
annotations don't need them.

## Key Concepts

### `createAdcpServerFromPlatform` (recommended)

The declarative path. You declare a typed `DecisioningPlatform` per specialism and the framework handles schema validation, response formatting, account resolution, capabilities generation, idempotency, signing, async tasks, lifecycle state, and error catching.

```typescript
import { serve } from '@adcp/sdk';
import {
  createAdcpServerFromPlatform,
  definePlatform,
  defineSalesCorePlatform,
  refAccountId,
  AccountNotFoundError,
} from '@adcp/sdk/server';

const platform = definePlatform({
  capabilities: {
    specialisms: ['sales-non-guaranteed'] as const,
    channels: ['display'] as const,
    pricingModels: ['cpm'] as const,
  },
  accounts: {
    resolve: async (ref, ctx) => {
      const id = refAccountId(ref);
      if (!id) return null; // → ACCOUNT_NOT_FOUND
      const acct = await db.findAccount(id);
      if (!acct) throw new AccountNotFoundError({ message: `account ${id} not found` });
      return acct;
    },
    upsert: async (refs, ctx) => refs.map(r => upsertOne(r, ctx)),
    list: async (filter, ctx) => db.listAccounts(filter, { agentUrl: ctx?.agent?.agent_url }),
  },
  sales: defineSalesCorePlatform({
    getProducts: async (req, ctx) => ({ products: catalog.search(req) }), // req typed ✓
    createMediaBuy: async (req, ctx) => ({
      media_buy_id: `mb_${Date.now()}`,
      status: 'pending_creatives',
      confirmed_at: new Date().toISOString(),
      packages: [],
    }),
    updateMediaBuy: async (id, patch, ctx) => ({ media_buy_id: id, status: 'active' }),
    getMediaBuyDelivery: async (req, ctx) => ({ media_buys: [] }),
    getMediaBuys: async (req, ctx) => ({ media_buys: [] }),
  }),
});

serve(() => createAdcpServerFromPlatform(platform, { name: 'My Publisher', version: '1.0.0' }));
```

**What the framework does for you:**

- **Compile-time specialism enforcement** via `RequiredPlatformsFor<S>` — claim `'sales-non-guaranteed'` and the typechecker requires `SalesCorePlatform & SalesIngestionPlatform` on `sales` (`SalesPlatform` was split in 6.7 with all methods individually optional; per-specialism enforcement moves up to the type-level).
- **Auto-generates `get_adcp_capabilities`** from registered platform methods — no manual capability declaration.
- **Auto-applies response builders** — return raw data, the framework wraps them in MCP `CallToolResult` with `structuredContent`.
- **Resolves accounts** — `accounts.resolve(ref, ctx)` runs before your platform method, the resolved account lands at `ctx.account`. Returns `ACCOUNT_NOT_FOUND` envelope if resolution returns null. `accounts.resolution: 'implicit'` enforces inline-`{account_id}` refusal at the framework boundary (post-6.7 — pre-6.7 the docstring was aspirational).
- **Idempotency, signing, async tasks, status normalization, lifecycle state** are framework-owned. Adopters write the business decisions.
- **Catches handler errors** — unhandled exceptions return `SERVICE_UNAVAILABLE` instead of crashing. Throw a typed error class (see § "Returning errors from handlers") to surface a structured envelope.

### Identity, multi-tenant, and lifecycle helpers (6.7)

Six helper families adopters reach for. Pick what your agent shape needs:

| Helper                                                                 | Use when                                                                                                                   |
|------------------------------------------------------------------------|----------------------------------------------------------------------------------------------------------------------------|
| `definePlatform` / `defineSalesCorePlatform` / sibling `define<X>Platform` | Inline platform literal — drops `req: unknown` casts on handler bodies. Class-pattern adopters with explicit property annotations don't need them. |
| `composeMethod(inner, { before, after })`                              | Wrap any platform method with typed before/after hooks (caching, enrichment under `ext.*`, typed-error guards).            |
| `requireAccountMatch` / `requireAdvertiserMatch` / `requireOrgScope`   | Pre-built `accounts.resolve` post-resolve guards. Default deny is `null` (avoids principal enumeration); `onDeny: 'throw'` for `PermissionDeniedError`. |
| `InMemoryImplicitAccountStore` (Shape A) / `createOAuthPassthroughResolver` (Shape B) / `createRosterAccountStore` (Shape C) | Reference `AccountStore` shapes. Shape A: `'implicit'` buyer-driven onboarding. Shape B: vendor OAuth + `/me/adaccounts`. Shape C: publisher-curated roster. |
| `createTenantRegistry` (host-routed) / `createTenantStore` (account-routed) | Multi-tenant. Host-routed = one server per tenant + tenant-id keyed lookup. Account-routed = one server with built-in fail-closed tenant-isolation gate on `upsert` / `syncGovernance`. |
| `BuyerAgentRegistry.signingOnly` / `bearerOnly` / `mixed` (+ `cached`) | Durable buyer-agent identity. Resolved `BuyerAgent` flows through `ctx.agent` to every `AccountStore` method and `tasks_get` polling. `BuyerAgent.status === 'suspended' \| 'blocked'` triggers framework-level `PERMISSION_DENIED`. See [`docs/migration-buyer-agent-registry.md`](../migration-buyer-agent-registry.md). |
| `MEDIA_BUY_TRANSITIONS` / `assertMediaBuyTransition` (+ creative pair) | Canonical lifecycle graph the storyboard runner uses. `assertMediaBuyTransition(from, to)` throws `AdcpError` with the spec-correct code (`NOT_CANCELLABLE` / `INVALID_STATE`). Replaces local copies of the status graph. |
| `createMediaBuyStore({ store })`                                       | Opt-in `targeting_overlay` echo on `get_media_buys`. Sellers claiming `property-lists` / `collection-lists` MUST echo the persisted list reference. |

The full migration recipe walking adopters through each is at [`docs/migration-6.6-to-6.7.md`](../migration-6.6-to-6.7.md). The `examples/hello_*` family demonstrates each helper in a runnable adapter.

### Exposing your agent over A2A (preview)

MCP is the default transport. To additionally expose the same `AdcpServer` over A2A JSON-RPC — so A2A-native buyers can discover and call your agent — mount `createA2AAdapter`:

```typescript
import express from 'express';
import { serve } from '@adcp/sdk';
import { createAdcpServerFromPlatform, createA2AAdapter } from '@adcp/sdk/server';

const adcp = createAdcpServerFromPlatform(platform, { name: 'Acme SSP', version: '1.0.0' });

// MCP (as today)
serve(() => adcp);

// A2A (new, preview)
const a2a = createA2AAdapter({
  server: adcp,
  agentCard: {
    name: 'Acme SSP',
    description: 'Guaranteed + non-guaranteed display inventory',
    url: 'https://ssp.acme.com/a2a',
    version: '1.0.0',
    provider: { organization: 'Acme', url: 'https://acme.com' },
    securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
  },
  async authenticate(req) {
    const token = req.headers.authorization?.replace(/^Bearer\s+/, '');
    return token ? { token, clientId: 'buyer_123', scopes: [] } : null;
  },
});

const app = express();
app.use(express.json());
// mount() wires: JSON-RPC at the `agentCard.url` pathname (`/a2a` here),
// the agent card at both `{basePath}/.well-known/agent-card.json` (A2A
// SDK discovery derives this) AND `/.well-known/agent-card.json` (origin-
// root probes). The `jsonRpcHandler` and `agentCardHandler` properties
// stay exposed for deployments that need custom mounting.
a2a.mount(app);
app.listen(3000);
```

Both transports share the same `AdcpServer` — handlers, idempotency store, state store, and `resolveAccount` all run the same pipeline regardless of which transport received the request. Changes to handlers are picked up by both at once.

**Skill addressing.** A2A clients send a `Message` with a single `DataPart`: `{ kind: 'data', data: { skill: 'get_products', input: { brief: '...' } } }`. `skill` matches an AdCP tool name; `input` is the tool arguments. The legacy key `parameters` (shipped by `src/lib/protocols/a2a.ts` before the adapter landed) is accepted as an alias for `input` so same-SDK clients and servers talk cleanly.

**Two lifecycles, one response.** A2A's `Task.state` tracks the *transport call* (did the HTTP request complete?). AdCP's `status` inside the artifact tracks the *work* (submitted / completed / failed). Don't conflate them — a `completed` A2A task can carry a `submitted` AdCP response, meaning the call returned but the ad-tech operation is still queued.

**Handler return → A2A `Task.state` + artifact:**

| Handler returned… | A2A `Task.state` | Artifact payload |
|---|---|---|
| Success arm | `completed` | DataPart with the typed AdCP response |
| Submitted arm (`status:'submitted'`) | `completed` | DataPart with the AdCP response; `adcp_task_id` on `artifact.metadata` |
| Error arm (`errors: [...]`) | `failed` | DataPart with the Error arm payload |
| `adcpError('CODE', ...)` | `failed` | DataPart with `adcp_error` |

**A2A `Task.id` vs AdCP `task_id`.** A2A owns its `Task.id` (SDK-generated per `message/send`). The AdCP-level `task_id` — present when the handler returned a Submitted arm — rides on `artifact.metadata.adcp_task_id`, off the DataPart's payload so the `data` still validates cleanly against the AdCP response schema. Buyers resuming the A2A side poll via `tasks/get` using the A2A `Task.id`; buyers reaching for AdCP-side async state use `adcp_task_id`.

**v0 scope.** `message/send`, `tasks/get`, `tasks/cancel`, `GET /.well-known/agent-card.json`. Streaming (`message/stream`), push notifications, and `input-required` mid-flight interrupts are explicit "not yet" — tracked for v1. Pin a minor version while the surface stabilises.

### Reading tool results (client side)

The framework emits responses with typed data in `structuredContent` (MCP L3) and a human-readable summary in `content[0].text` (L2). When calling an AdCP agent from client code, prefer `structuredContent`; only fall back to parsing the text block for pre-`structuredContent` servers. The SDK ships two helpers with different failure modes:

```typescript
import { extractResult, unwrapProtocolResponse } from '@adcp/sdk';

const res = await mcpClient.callTool({ name: 'get_products', arguments: { brief: '...' } });

// Happy-path: returns structuredContent (or JSON-parsed text); undefined if neither yields data.
const payload = extractResult<GetProductsResponse>(res);

// Validated read: narrows against the tool schema, throws on missing / drifted payloads.
const validated = unwrapProtocolResponse(res, 'get_products', 'mcp');
```

Pick based on the caller: `extractResult` when you just want the payload and can handle `undefined`; `unwrapProtocolResponse` when you want a schema-narrowed AdCP response or an explicit throw.

### Returning errors from handlers

Three shapes round-trip as errors:

- **Typed error class — preferred for v6.** `throw new AuthRequiredError()`, `throw new PermissionDeniedError('action')`, `throw new RateLimitedError(retryAfterSeconds)`, `throw new ServiceUnavailableError()`, `throw new IdempotencyConflictError()`, `throw new BudgetTooLowError()`, plus the not-found family (`AccountNotFoundError`, `MediaBuyNotFoundError`, `PackageNotFoundError`, `ProductNotFoundError`, `CreativeNotFoundError`) and the governance family (`GovernanceDeniedError`, `PolicyViolationError`, `ComplianceUnsatisfiedError`). Each maps to its wire error code with `recovery` baked in. Throw from any platform method or `accounts.resolve`. Imports come from `@adcp/sdk/server`.
- **Spec-defined tool failure** — return the tool's `*Error` arm directly: `return { errors: [{ code: 'PRODUCT_NOT_FOUND', message: 'no such product' }] }`. The dispatcher detects the Error arm by shape, sets `isError: true`, and preserves the `errors[]` / `context` / `ext` fields on `structuredContent`. Use this when the AdCP spec defines a per-tool error variant for the condition you're surfacing.
- **`AdcpError(code, opts)` raw escape hatch** — for codes without a typed wrapper, or for codes you want to inject custom `details` into. The typed classes are sugar over this.

```typescript
// Typed (preferred)
import { AuthRequiredError, PermissionDeniedError, RateLimitedError } from '@adcp/sdk/server';

createMediaBuy: async (req, ctx) => {
  if (!ctx.account.authInfo) throw new AuthRequiredError();
  if (!agentCanCreate(ctx.agent, ctx.account.id)) throw new PermissionDeniedError('create_media_buy');
  if (rateLimitHit(ctx.account.id)) throw new RateLimitedError(60);
  /* ... */
}

// Raw escape hatch
import { AdcpError } from '@adcp/sdk/server';
throw new AdcpError('CUSTOM_CODE', { recovery: 'terminal', message: '...', details: { foo: 'bar' } });
```

All surface as `isError: true` on the wire and skip response-schema validation. The lower-level `adcpError(code, ...)` *return value* form is a v5-substrate pattern; in 6.x, prefer throwing the typed class.

**7 domain groups:**

| Group | Handler keys |
|-------|-------------|
| `mediaBuy` | `getProducts`, `createMediaBuy`, `updateMediaBuy`, `getMediaBuys`, `getMediaBuyDelivery`, `providePerformanceFeedback`, `listCreativeFormats`, `syncCreatives`, `listCreatives` |
| `signals` | `getSignals`, `activateSignal` |
| `creative` | `listCreativeFormats`, `buildCreative`, `listCreatives`, `syncCreatives`, `getCreativeDelivery` |
| `governance` | `createPropertyList`, `updatePropertyList`, `getPropertyList`, `listPropertyLists`, `deletePropertyList`, `listContentStandards`, `getContentStandards`, `createContentStandards`, `updateContentStandards`, `calibrateContent`, `validateContentDelivery`, `getMediaBuyArtifacts`, `getCreativeFeatures`, `syncPlans`, `checkGovernance`, `reportPlanOutcome`, `getPlanAuditLogs` |
| `accounts` | `listAccounts`, `syncAccounts`, `syncGovernance`, `getAccountFinancials`, `reportUsage` |
| `eventTracking` | `syncEventSources`, `logEvent`, `syncAudiences`, `syncCatalogs` |
| `sponsoredIntelligence` | `getOffering`, `initiateSession`, `sendMessage`, `terminateSession` |

### State Persistence (ctx.store)

Every handler receives `ctx.store` — a key-value store for persisting domain objects across requests. Operations: `get`, `put`, `patch`, `delete`, `list`, each scoped by collection and ID.

```typescript
mediaBuy: {
  createMediaBuy: async (params, ctx) => {
    const mediaBuy = { media_buy_id: `mb_${Date.now()}`, status: 'pending', packages: [] };
    await ctx.store.put('media_buys', mediaBuy.media_buy_id, mediaBuy);
    return mediaBuy;
  },
  getMediaBuys: async (params, ctx) => {
    if (params.media_buy_ids?.length) {
      const buys = await Promise.all(
        params.media_buy_ids.map(id => ctx.store.get('media_buys', id))
      );
      return { media_buys: buys.filter(Boolean) };
    }
    const all = await ctx.store.list('media_buys');
    return { media_buys: all };
  },
},
```

`InMemoryStateStore` is the default (good for development and testing). Use `PostgresStateStore` for production deployments where state must survive restarts.

### Account Resolution

`AccountStore.resolve(ref, ctx)` runs before every platform method. The resolved account lands at `ctx.account`. If `resolve` returns `null`, the framework responds with `ACCOUNT_NOT_FOUND` and your method never runs.

```typescript
import { definePlatform, refAccountId, AccountNotFoundError } from '@adcp/sdk/server';

const platform = definePlatform({
  capabilities: { specialisms: ['sales-non-guaranteed'] as const, /* ... */ },
  accounts: {
    // 'explicit' (default), 'implicit' (sync_accounts-first), or 'derived' (single-tenant).
    // 'implicit' adopters: framework refuses inline {account_id} references with INVALID_REQUEST
    // *before* reaching your resolver (post-6.7).
    resolution: 'explicit',
    resolve: async (ref, ctx) => {
      const id = refAccountId(ref);
      if (id) return db.findAccount(id);
      // ref undefined: tool without `account` field on wire — auth-derived path
      if (ctx?.authInfo?.credential?.client_id) {
        return db.findByClient(ctx.authInfo.credential.client_id);
      }
      return null; // → ACCOUNT_NOT_FOUND
    },
  },
  sales: defineSalesCorePlatform({
    getProducts: async (req, ctx) => {
      // ctx.account is the resolved account
      const products = await catalog.search(req, ctx.account.id);
      return { products };
    },
    /* ... */
  }),
});
```

Three resolution modes:

- **`'explicit'`** (default) — buyer passes `{account_id}` inline on every request. Snap, Meta, GAM-style sellers. The framework calls `resolve(ref, ctx)` with the inline ref.
- **`'implicit'`** — buyer must call `sync_accounts` first; subsequent requests resolve from the auth-principal linkage your `upsert` populated. LinkedIn-shaped sellers. The framework refuses inline `{account_id}` references with `INVALID_REQUEST` (post-6.7 — pre-6.7 the docstring claimed this but nothing checked it). Use [`InMemoryImplicitAccountStore`](../../src/lib/adapters/implicit-account-store.ts) for the reference shape.
- **`'derived'`** — single-tenant agents where the auth principal alone identifies the tenant. Self-hosted broadcasters, retail-media operators in proxy mode. `resolve(undefined, ctx)` returns the singleton.

**Three reference shapes** for adopters who don't want to write the resolver from scratch:

- `InMemoryImplicitAccountStore` — Shape A, buyer-driven `sync_accounts` populates the auth-principal → accounts map.
- `createOAuthPassthroughResolver` — Shape B, returns just the `resolve` function for adapters fronting an upstream OAuth listing endpoint (Snap, Meta, TikTok, LinkedIn — `extract bearer → GET /me/adaccounts → match by id`).
- `createRosterAccountStore` — Shape C, returns a complete `AccountStore` for adopters who own the roster (storefront table, admin-UI-managed JSON).

For multi-tenant adapters, use `createTenantStore({...})` (account-routed) or `createTenantRegistry({...})` (host-routed). `createTenantStore` ships with a built-in fail-closed tenant-isolation gate on `upsert` / `syncGovernance` — cross-tenant entries are rejected with `PERMISSION_DENIED` *before* your callbacks run. See `examples/hello_seller_adapter_multi_tenant.ts`.

Composable post-resolve guards: `requireAccountMatch(predicate)`, `requireAdvertiserMatch(getRoster)`, `requireOrgScope(getAccountOrg, getCtxOrg)`. Wrap with `composeMethod`:

```typescript
import { composeMethod, requireAdvertiserMatch } from '@adcp/sdk/server';

accounts: {
  resolve: composeMethod(
    innerResolve,
    requireAdvertiserMatch(async (ctx) => tenantRoster.for(ctx?.agent))
  ),
}
```

**Don't put credentials in `ctx_metadata`.** The wire-strip protects buyer responses but not server-side log lines, error envelopes, heap dumps, or adopter-generated strings. Re-derive bearers per request from `ctx.authInfo` + your token cache; embed only non-secret upstream IDs. See [`CTX-METADATA-SAFETY.md`](./CTX-METADATA-SAFETY.md).

### Idempotency (mutating tools)

AdCP v3 requires `idempotency_key` on every mutating request and requires sellers to declare a replay window. `@adcp/sdk/server` ships `createIdempotencyStore` which handles validation, JCS canonicalization, replay, and capability declaration:

```typescript
import { serve } from '@adcp/sdk';
import {
  createAdcpServerFromPlatform,
  createIdempotencyStore,
  memoryBackend,
  pgBackend,
} from '@adcp/sdk/server';

// Development — in-process store, resets on restart:
const idempotency = createIdempotencyStore({
  backend: memoryBackend(),
  ttlSeconds: 86400, // 1h–7d, clamped to spec bounds
});

serve(() =>
  createAdcpServerFromPlatform(platform, {
    name: 'My Publisher',
    version: '1.0.0',
    idempotency,
    resolveSessionKey: ctx => ctx.account?.id, // doubles as idempotency principal
  })
);
```

**Production (pgBackend).** `pg.Pool` is lazy — a bad `DATABASE_URL` lets the server boot, advertise `IdempotencySupported`, then silently fail every mutating call. Wire `readinessCheck` so the server never accepts traffic with a broken pool:

```typescript
import { serve } from '@adcp/sdk';
import { createAdcpServerFromPlatform, createIdempotencyStore, pgBackend, getIdempotencyMigration } from '@adcp/sdk/server';
import { Pool } from 'pg';

// Run getIdempotencyMigration() once before first boot to create the table —
// readinessCheck below queries it to catch missing migrations, not just connectivity.

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
pool.on('error', err => console.error('pg pool error', err)); // prevent crash on idle-client errors
const idempotency = createIdempotencyStore({ backend: pgBackend(pool), ttlSeconds: 86400 });

serve(() => createAdcpServerFromPlatform(platform, { name: 'My Publisher', version: '1.0.0', idempotency }), {
  readinessCheck: () => idempotency.probe(), // throws with a descriptive error if pool/table is broken
});
```

The framework auto-handles:
- `INVALID_REQUEST` when the key is missing on mutating tools
- `IDEMPOTENCY_CONFLICT` on same-key-different-payload (no payload leak in the error body)
- `IDEMPOTENCY_EXPIRED` past the TTL, with ±60s clock-skew tolerance
- `replayed: true` injection on the envelope when replaying a cached response
- `adcp.idempotency.replay_ttl_seconds` declared on `get_adcp_capabilities`

Scoping is per-principal — `resolveSessionKey` doubles as the idempotency principal, so two buyers with different session keys won't share cache entries. Override with `resolveIdempotencyPrincipal` if you need a different scope (e.g., `operator_id`).

**Only successful responses are cached.** Handler errors re-execute on retry rather than replaying — so a transient 5xx doesn't lock a failure into the cache.

### Schema-Driven Validation (opt-in)

`createAdcpServerFromPlatform` can validate every inbound request and handler response against the bundled AdCP JSON schemas for the SDK's declared version. Catches field-name drift (e.g. a handler emits `targeting_overlay` where the spec expects `targeting`) before the response leaves your agent.

```typescript
createAdcpServerFromPlatform(platform, {
  name: 'my-seller',
  version: '1.0.0',
  validation: {
    requests: 'strict', // reject malformed requests with VALIDATION_ERROR
    responses: 'warn', // log handler drift, return response unchanged
  },
});
```

Modes per side: `'strict' | 'warn' | 'off'`. Default is `'off'` — enable explicitly. `VALIDATION_ERROR` envelopes carry the full issue list (pointer, message, keyword, schema path) at the top level `adcp_error.issues` (and mirrored at `details.issues` for spec-convention compatibility) so buyers can surface each offending field without drilling into nested metadata.

**Note on MCP `tools/list` introspection**: `@adcp/sdk` agents register framework tools with a passthrough input schema so the framework AJV validator is authoritative on both MCP and A2A (see [#909](https://github.com/adcontextprotocol/adcp-client/issues/909)). One visible consequence: MCP `tools/list` publishes `{ type: 'object', properties: {}, additionalProperties: {} }` for every framework tool — not the per-tool parameter schema. Generic MCP discovery clients that lean on `tools/list` inputSchema for field-level introspection will see an untyped surface. AdCP-native discovery via `get_adcp_capabilities` is unaffected; upstream [adcp#3057](https://github.com/adcontextprotocol/adcp/issues/3057) proposes a `get_schema` capability tool for per-tool shape discovery across transports.

The same validator runs on the `AdcpClient` side — storyboards and third-party clients configure it via `validation: { requests, responses }` on the client config. Request default is `warn` (so existing callers that send partial payloads still work); response default is `strict` in dev/test, `warn` in production. Set either side to `'off'` for zero overhead.

### Request Signing

If your agent receives signed requests from buyers, verify them using `requireAuthenticatedOrSigned()` — one call that bundles signature verification with credential fallback and `requiredFor` enforcement:

```typescript
import { serve } from '@adcp/sdk';
import {
  createAdcpServerFromPlatform,
  verifySignatureAsAuthenticator,
  verifyApiKey,
  requireAuthenticatedOrSigned,
  mcpToolNameResolver,
} from '@adcp/sdk/server';
import { BrandJsonJwksResolver } from '@adcp/sdk/signing/server';

serve(
  () =>
    createAdcpServerFromPlatform(platform, {
      name: 'My Seller',
      version: '1.0.0',
      capabilities: {
        overrides: {
          request_signing: {
            supported: true,
            required_for: ['create_media_buy', 'update_media_buy'],
            covers_content_digest: 'either',
          },
        },
      },
    }),
  {
    authenticate: requireAuthenticatedOrSigned({
      signature: verifySignatureAsAuthenticator({
        capability: { supported: true, required_for: ['create_media_buy', 'update_media_buy'], covers_content_digest: 'either' },
        jwks: new BrandJsonJwksResolver(),
        resolveOperation: mcpToolNameResolver,
      }),
      fallback: verifyApiKey({ keys: { sk_live_abc: { principal: 'acct_42' } } }),
      requiredFor: ['create_media_buy', 'update_media_buy'],
      resolveOperation: mcpToolNameResolver,
    }),
  }
);
```

When signature headers are present, only signature auth runs (no fallback to bearer — that prevents bypass attacks). When absent, the credential authenticator runs as normal. `requiredFor` enforces the spec's `request_signature_required` 401 on operations that arrive unsigned without other credentials — start narrow and widen as your counterparties roll out signing. `replayStore` and `revocationStore` default to in-memory implementations — pass shared (e.g. Redis-backed) stores for horizontally scaled fleets. The capability key is `request_signing`; `signed_requests` is silently dropped (the `AdcpCapabilitiesOverrides` shape is what `get_adcp_capabilities` advertises).

For outbound webhook signing, pass a `signerKey` on the server options:

```typescript
createAdcpServerFromPlatform(platform, {
  name: 'My Seller',
  version: '1.0.0',
  webhooks: {
    signerKey: {
      keyid: 'my-webhook-key-2026',
      alg: 'ed25519',
      privateKey: webhookPrivateJwk,
    },
  },
});
```

**Production key storage.** For outbound *request* signing (calling other agents' tools), prefer a KMS-backed `SigningProvider` over in-process JWKs — `request_signing` accepts `{ kind: 'provider', provider, agent_url }` for any KMS / HSM / Vault backend. See [SIGNING-GUIDE.md § Production Key Storage](./SIGNING-GUIDE.md#step-35-production-key-storage--kms--hsm--vault) for the full walkthrough including a reference GCP KMS adapter. Server-side `webhooks.signerKey` currently accepts only an in-process `SignerKey`; KMS-backed webhook signing on the server is a follow-up.

See [SIGNING-GUIDE.md](./SIGNING-GUIDE.md) for the full walkthrough: key generation, JWKS publication, brand.json, conformance testing, and KMS-backed production deployment.

### createTaskCapableServer (Low-Level)

For advanced cases where you need direct control over MCP tool registration, schema wiring, and response formatting. `createAdcpServer` uses this internally.

```typescript
import { createTaskCapableServer, taskToolResponse, GetSignalsRequestSchema } from '@adcp/sdk';

function createAgent({ taskStore }) {
  const server = createTaskCapableServer('Agent Name', '1.0.0', { taskStore });

  server.tool('get_signals', 'Discover segments.', GetSignalsRequestSchema.shape, async (args) => {
    return taskToolResponse({ signals: [...], sandbox: true }, 'Found segments');
  });

  return server;
}
```

When using `createTaskCapableServer` directly, you are responsible for:
- Wiring Zod schemas via `.shape`
- Wrapping responses with `taskToolResponse()` or domain-specific builders
- Implementing `get_adcp_capabilities` manually
- Error handling in each tool handler

#### Envelope fields — `wrapEnvelope`

Attach `replayed`, `context`, and `operation_id` onto your inner response without reimplementing the per-error-code allowlist (IDEMPOTENCY_CONFLICT drops `replayed`, keeps `context`):

```typescript
import { wrapEnvelope } from '@adcp/sdk/server';

const inner = await createMediaBuy(request.params);
return wrapEnvelope(inner, { replayed: false, context: request.context });
```

On error, pass the AdCP error envelope as `inner` — the helper reads `adcp_error.code` and applies the allowlist:

```typescript
return wrapEnvelope(
  { adcp_error: { code: 'IDEMPOTENCY_CONFLICT', message, recovery: 'terminal' } },
  { context: request.context }
);
```

### Response Builders

With `createAdcpServer`, response builders are applied automatically — return raw data and the framework wraps it. If you need manual control (e.g., with `createTaskCapableServer`), builders are available:

```typescript
import { productsResponse, mediaBuyResponse, deliveryResponse, adcpError, taskToolResponse } from '@adcp/sdk';
```

### Task Statuses (Server-Side Contract)

When your agent receives a tool call, it returns one of these statuses. The buyer client handles each differently:

| Status | When to use | What the buyer client does |
|--------|------------|---------------------------|
| `completed` | Request fulfilled synchronously | Reads `result.data` and proceeds |
| `working` | Processing started, not done yet | Polls `tasks/get` until status changes |
| `submitted` | Will notify via webhook when done | Waits for webhook delivery at `push_notification_config.url` |
| `input_required` | Need clarification from buyer | Fires buyer's `InputHandler` callback with the question |
| `deferred` | Requires human decision | Returns a token; human resumes later via `result.deferred.resume()` |

With `createAdcpServer`, synchronous handlers return raw data and the framework sets `completed` automatically. With `createTaskCapableServer`, use `taskToolResponse()` explicitly.

For async tools that need background processing, use `registerAdcpTaskTool()`:

```typescript
import { registerAdcpTaskTool, InMemoryTaskStore } from '@adcp/sdk';

const taskStore = new InMemoryTaskStore();

registerAdcpTaskTool(server, taskStore, {
  name: 'create_media_buy',
  description: 'Create a media buy.',
  schema: CreateMediaBuyRequestSchema.shape,
  createTask: async (args) => {
    // Start processing, return a task ID
    const taskId = crypto.randomUUID();
    processInBackground(taskId, args); // your async logic
    return { taskId, status: 'submitted' };
  },
  getTask: async (taskId) => taskStore.get(taskId),
  getTaskResult: async (taskId) => taskStore.getResult(taskId),
});
```

**Error responses**: throw the typed error class for the spec code. The buyer agent uses the `recovery` classification baked into the class to decide retry behavior:

```typescript
import {
  BudgetTooLowError,
  ServiceUnavailableError,
  PermissionDeniedError,
} from '@adcp/sdk/server';

// correctable — buyer should fix params and retry
throw new BudgetTooLowError({ message: 'Minimum budget is $1,000' });

// transient — buyer should retry after delay
throw new ServiceUnavailableError({ retryAfterSeconds: 30 });

// terminal — buyer should stop
throw new PermissionDeniedError('account_access', { message: 'Contact support' });
```

For codes without a typed wrapper, `throw new AdcpError('CUSTOM_CODE', { recovery, message })` is the raw escape hatch. v5 adopters who used `return adcpError('CODE', '...')` (the return-value form) keep working under the legacy substrate, but v6 adopters should throw.

> **Heads-up for buyer-agent authors**: four codes are spec-`correctable` but operator-semantically human-escalate — don't auto-mutate-and-retry on `POLICY_VIOLATION`, `COMPLIANCE_UNSATISFIED`, `GOVERNANCE_DENIED`, or `AUTH_REQUIRED`. Surface to the user. (`AUTH_REQUIRED` conflates missing-creds with revoked-creds; until [adcontextprotocol/adcp#3730](https://github.com/adcontextprotocol/adcp/issues/3730) splits these, treat as escalate.) See `skills/call-adcp-agent/SKILL.md` for the full callout.

See `docs/llms.txt` for the full error code table with recovery classifications.

### Storyboards

The `storyboards/` directory contains YAML files that define exactly what tool call sequences a buyer agent will make against your server. Each storyboard includes phases, steps, sample requests/responses, and validation rules.

Key storyboards for server-side builders:
- `media_buy_non_guaranteed.yaml` — auction-based buying flow
- `media_buy_guaranteed_approval.yaml` — guaranteed buying with IO approval
- `media_buy_proposal_mode.yaml` — proposal-based buying
- `creative_sales_agent.yaml` — push creative assets to your platform
- `signal_marketplace.yaml` / `signal_owned.yaml` — signals agent flows
- `si_session.yaml` — sponsored intelligence sessions
- `media_buy_governance_escalation.yaml` — governance with human escalation

### HTTP Transport

The `serve()` helper handles HTTP transport setup. Pass it a factory function that returns a configured `AdcpServer`:

```typescript
import { serve } from '@adcp/sdk';
import { createAdcpServerFromPlatform } from '@adcp/sdk/server';

serve(() => createAdcpServerFromPlatform(platform, { name: 'My Agent', version: '1.0.0' }));
serve(() => createAdcpServerFromPlatform(platform, { /* ... */ }), { port: 8080 }); // custom port
serve(() => createAdcpServerFromPlatform(platform, { /* ... */ }), { path: '/v1/mcp' }); // custom path
```

`serve()` returns the underlying `http.Server` for lifecycle control (e.g., graceful shutdown).

When using `createTaskCapableServer` directly, `serve()` passes a `{ taskStore }` to your factory so MCP Tasks work correctly across stateless HTTP requests.

For custom routing or middleware, you can wire the transport manually:

```typescript
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from 'http';

const httpServer = createServer(async (req, res) => {
  if (req.url === '/mcp' || req.url === '/mcp/') {
    const agentServer = createMyAgent();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    try {
      await agentServer.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      console.error('Server error:', err);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal server error' }));
      }
    } finally {
      await agentServer.close();
    }
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});
```

## Testing Your Agent

### Tool Discovery

```bash
npx @adcp/sdk@latest http://localhost:3001/mcp
```

This lists all tools your agent exposes, their descriptions, and parameters. If `get_signals` appears with the correct schema, your agent is wired up correctly.

### Calling Tools

```bash
# All segments
npx @adcp/sdk@latest http://localhost:3001/mcp get_signals '{"signal_spec":"audience segments"}'

# Filtered by text
npx @adcp/sdk@latest http://localhost:3001/mcp get_signals '{"signal_spec":"shoppers"}'

# Filtered by catalog type
npx @adcp/sdk@latest http://localhost:3001/mcp get_signals '{"filters":{"catalog_types":["marketplace"]}}'

# JSON output for scripting
npx @adcp/sdk@latest http://localhost:3001/mcp get_signals '{}' --json
```

```bash
# Create a media buy (mutating tool — requires idempotency_key)
# Schema traps: idempotency_key must be 16-255 chars (UUID v4 recommended);
# package-level budget is a plain number (not {amount,currency}); brand uses {domain} (not {brand_id});
# packages require product_id, budget, and pricing_option_id
npx @adcp/sdk@latest http://localhost:3001/mcp create_media_buy '{
  "idempotency_key": "550e8400-e29b-41d4-a716-446655440000",
  "account": { "account_id": "acct_123" },
  "brand": { "domain": "acme.example" },
  "start_time": "2026-05-01T00:00:00Z",
  "end_time": "2026-05-31T23:59:59Z",
  "packages": [
    { "product_id": "p_sports_ctv", "budget": 10000, "pricing_option_id": "po_cpm_35" }
  ]
}'
```

### Compliance Check

```bash
npx @adcp/sdk@latest storyboard run http://localhost:3001/mcp
```

This runs a standard validation suite against your agent to check AdCP compliance. For the full validation picture — storyboard runner, property-based fuzzing (`adcp fuzz`), multi-instance testing, webhook conformance, request-signing, schema-driven validation, and the skill→agent→grader dogfood harness — see [**VALIDATE-YOUR-AGENT.md**](./VALIDATE-YOUR-AGENT.md).

## Complete Example

See [`examples/signals-agent.ts`](../../examples/signals-agent.ts) for a complete, runnable signals agent with:

- Three audience segments (owned, custom, marketplace)
- Text search via `signal_spec`
- Filtering by `signal_ids` and `catalog_types`
- Result limiting via `max_results`
- Proper HTTP transport setup

See [`examples/error-compliant-server.ts`](../../examples/error-compliant-server.ts) for a media buy agent demonstrating:

- Multiple tools (`get_products`, `create_media_buy`, `get_media_buy_delivery`)
- Structured error handling with `adcpError()`
- Rate limiting
- Business logic validation

## Related

- [`registerAdcpTaskTool()`](../../src/lib/server/tasks.ts) — for async tools that need background processing
- [`examples/error-compliant-server.ts`](../../examples/error-compliant-server.ts) — media buy agent with multiple tools and error handling
- [AdCP specification](https://adcontextprotocol.org) — full protocol reference
