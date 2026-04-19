---
name: build-seller-agent
description: Use when building an AdCP seller agent — a publisher, SSP, or retail media network that sells advertising inventory to buyer agents.
---

# Build a Seller Agent

## Overview

A seller agent receives briefs from buyers, returns products with pricing, accepts media buys, manages creatives, and reports delivery. The business model — what you sell, how you price it, and whether humans approve deals — shapes every implementation decision. Determine that first.

## When to Use

- User wants to build an agent that sells ad inventory
- User mentions publisher, SSP, retail media, or media network in the context of AdCP
- User references `get_products`, `create_media_buy`, or the media buy protocol

**Not this skill:**

- Buying ad inventory → that's a buyer/DSP agent (see `docs/getting-started.md`)
- Serving audience segments → `skills/build-signals-agent/`
- Rendering creatives from briefs → that's a creative agent

## Specialisms This Skill Covers

Your compliance obligations come from the specialisms you claim in `get_adcp_capabilities`. Each specialism has a storyboard bundle at `compliance/cache/latest/specialisms/<id>/` that the AAO compliance runner executes. Pick one or more:

| Specialism | Status | Delta from baseline | See |
|---|---|---|---|
| `sales-guaranteed` | stable | IO approval is **task-layer**, not MediaBuy-layer. Return an A2A task envelope with `status: 'submitted'` + `task_id` + `message`. Do NOT return `media_buy_id` or `packages` yet — those land on the final artifact when the task completes. There is no `pending_approval` MediaBuy status. | [§ sales-guaranteed](#specialism-sales-guaranteed) |
| `sales-non-guaranteed` | stable | Instant `status: 'active'` with `confirmed_at`; accept `bid_price` on packages; expose `update_media_buy` for bid/budget changes | [§ sales-non-guaranteed](#specialism-sales-non-guaranteed) |
| `sales-broadcast-tv` | stable | Top-level `agency_estimate_number`; per-package `measurement_terms.billing_measurement`; Ad-ID `industry_identifiers` on creatives; `measurement_windows` (Live/C3/C7) on delivery | [§ sales-broadcast-tv](#specialism-sales-broadcast-tv) |
| `sales-streaming-tv` | preview | v3.1 placeholder (empty `phases`) — ship the baseline, declare `channels: ['ctv'] as const` on products | Baseline only |
| `sales-social` | stable | Walled-garden: no `get_products`/`create_media_buy`; implement `sync_audiences`, `log_event`, `get_account_financials` instead | [§ sales-social](#specialism-sales-social) |
| `sales-exchange` | preview | v3.1 placeholder — target `sales-non-guaranteed` baseline; PMP / deal IDs / auction transparency pending | Baseline only |
| `sales-catalog-driven` | stable | See `skills/build-retail-media-agent/` — catalog-driven applies to restaurants, travel, and local commerce too | Different skill |
| `sales-retail-media` | preview | See `skills/build-retail-media-agent/` | Different skill |
| `sales-proposal-mode` | stable | `get_products` returns `proposals[]` with `budget_allocations`; handle `buying_mode: 'refine'`; accept via `create_media_buy` with `proposal_id` + `total_budget` and no `packages` | [§ sales-proposal-mode](#specialism-sales-proposal-mode) |
| `audience-sync` | stable | Track: `audiences`. Implement `sync_audiences` (handles discovery, add, and delete) and `list_accounts`. Hashed identifiers (SHA-256 lowercased+trimmed). Match-rate telemetry on response. | [§ audience-sync](#specialism-audience-sync) |
| `signed-requests` | preview | RFC 9421 HTTP Signature verification on mutating requests. Advertise `request_signing.supported: true` in capabilities; graded against conformance vectors — positive vectors must produce non-4xx; negative vectors must return `401` with `WWW-Authenticate: Signature error="<code>"` matching the vector's `expected_outcome.error_code` byte-for-byte. | [§ signed-requests](#specialism-signed-requests) |

Specialism ID (kebab-case) = storyboard directory. The storyboard's `id:` field (snake_case, e.g. `media_buy_broadcast_seller`) is the category name, not the specialism name. One specialism can apply to multiple product lines — a seller with both CTV inventory and broadcast TV inventory can claim `sales-streaming-tv` and `sales-broadcast-tv` simultaneously.

## Protocol-Wide Requirements (AdCP 3.0 GA)

Three requirements apply to **every** production seller, regardless of which specialism you claim. Don't reinvent any of them — the SDK provides helpers for each.

### `idempotency_key` is required on every mutating request

`create_media_buy`, `update_media_buy`, `sync_accounts`, `sync_creatives`, `sync_audiences`, `sync_catalogs`, `sync_event_sources`, `provide_performance_feedback` — every mutating call carries a client-supplied `idempotency_key`. Wire `createIdempotencyStore` into `createAdcpServer({ idempotency })` and the framework handles replay detection, payload-hash conflict (`IDEMPOTENCY_CONFLICT`), expiry (`IDEMPOTENCY_EXPIRED`), and in-flight parallelism. Don't implement this in handler code. See [§ Idempotency](#idempotency) below for the full wire-up.

### Authentication is mandatory

An agent that accepts unauthenticated requests is non-compliant — the universal `security_baseline` storyboard enforces this. Wire `serve({ authenticate })` with `verifyApiKey`, `verifyBearer`, or `anyOf(...)` before you claim any specialism. See [§ Protecting your agent](#protecting-your-agent) below.

### Don't break when RFC 9421 Signature headers arrive

Even if you don't claim `signed-requests`, a buyer may send `Signature-Input` / `Signature` headers. Your MCP transport must pass the request through without rejecting it. If you do claim the specialism, verify per [§ signed-requests](#specialism-signed-requests) below.

<a name="composing-oauth-signing-and-idempotency"></a>
### Composing OAuth, signing, and idempotency

Each concern above is straightforward in isolation. The pitfalls are at their boundaries. A production seller that claims both `sales-guaranteed` and `signed-requests` and sits behind OAuth wires them through `serve()`'s composition hooks — not external Express middleware.

**The pipeline.** `serve({ authenticate, preTransport })` runs steps in this order and buffers the request body into `req.rawBody` so the signature verifier can hash it without racing the MCP transport:

```typescript
import { serve } from '@adcp/client';
// verifyBearer / verifyApiKey / anyOf live on the server subpath, not the root barrel:
import { verifyBearer } from '@adcp/client/server';
// Low-level verifier is preTransport-shaped: use it instead of createExpressVerifier
// (which is Express (req, res, next) middleware and won't type-check against preTransport):
import {
  verifyRequestSignature,
  RequestSignatureError,
  StaticJwksResolver,
  InMemoryReplayStore,
  InMemoryRevocationStore,
  type VerifierCapability,
} from '@adcp/client/signing/server';

const capability: VerifierCapability = {
  supported: true,
  required_for: ['create_media_buy', 'update_media_buy', 'acquire_rights'],
  supported_for: ['sync_creatives', 'sync_audiences', 'sync_accounts'],
  covers_content_digest: 'required',
  agent_url: 'https://seller.example.com/mcp',
};
const jwks = new StaticJwksResolver({ /* ... */ });
const replayStore = new InMemoryReplayStore();
const revocationStore = new InMemoryRevocationStore();

serve(createAgent, {
  publicUrl: 'https://seller.example.com/mcp',

  // 1. authenticate runs first. Bad/missing bearer → 401 Bearer challenge.
  //    serve() populates extra.authInfo, which createAdcpServer surfaces as ctx.authInfo.
  authenticate: verifyBearer({
    jwksUri: 'https://auth.example.com/.well-known/jwks.json',
    issuer: 'https://auth.example.com',
    audience: 'https://seller.example.com/mcp',
    requiredScopes: ['adcp:seller'],
  }),
  protectedResource: { authorization_servers: ['https://auth.example.com'] },

  // 2. preTransport: raw http (req, res) => Promise<boolean>. Verify the
  //    RFC 9421 signature here, using req.rawBody pre-buffered by serve().
  //    Return true only if you wrote the response yourself; return false to
  //    continue into MCP dispatch. Throwing produces a generic 500.
  preTransport: async (req, res) => {
    try {
      await verifyRequestSignature(
        { method: req.method!, url: req.url!, headers: req.headers, body: req.rawBody ?? '' },
        { capability, jwks, replayStore, revocationStore, operation: resolveOperation(req) },
      );
    } catch (err) {
      if (err instanceof RequestSignatureError) {
        res.statusCode = 401;
        res.setHeader('WWW-Authenticate', `Signature error="${err.code}"`);
        res.end();
        return true;  // handled
      }
      throw err;
    }
    return false;  // continue to MCP dispatch
  },

  // 3. MCP transport parses JSON and dispatches to createAdcpServer.
  // 4. Framework applies the idempotency store per handler — you don't mount it.
});
```

**Principal threading.** `resolveSessionKey(ctx)` receives only `{toolName, params, account}` — no auth info. To compose the OAuth subject into the idempotency key you need `resolveIdempotencyPrincipal`, which receives the full `HandlerContext` including `ctx.authInfo` (populated by `verifyBearer` through MCP's `extra.authInfo`):

```typescript
createAdcpServer({
  // ...
  // SessionKeyContext has no authInfo — use this for coarse per-account scoping:
  resolveSessionKey: (ctx) => ctx.account?.id,

  // HandlerContext has authInfo — use this when the idempotency namespace must
  // be scoped to the authenticated principal:
  resolveIdempotencyPrincipal: (ctx) => {
    const clientId = ctx.authInfo?.clientId;
    if (!clientId) throw new Error('unauthenticated request reached idempotency scope — check authenticate is configured');
    // Multi-tenant AS: if the JWT carries a tenant claim, verifyBearer surfaces
    // it in ctx.authInfo.extra. Compose so sub collisions across tenants don't
    // share a replay namespace:
    const tenant = ctx.authInfo?.extra?.tenant_id as string | undefined;
    return tenant ? `${tenant}:${clientId}` : clientId;
  },
});
```

Composing the verified signing `keyid` in is possible but lives outside the handler context: the signing middleware stashes it on `req.verifiedSigner.keyid` (raw HTTP request), which doesn't flow into `HandlerContext` by default. Either accept that the idempotency namespace is OAuth-principal-only (most setups), or write a custom `authenticate` that promotes the verified keyid into `authInfo.extra` so your `resolveIdempotencyPrincipal` can read it uniformly.

**401 disambiguation.** A request can fail both OAuth and signature verification. Per RFC 7235, you can emit multiple `WWW-Authenticate` challenges — but order them so the client's most promising next step is first:

- OAuth failure (no/expired bearer) → `WWW-Authenticate: Bearer error="invalid_token", resource_metadata=...`. **Do this first** — the client can't sign correctly until it has a valid identity. The signed-requests grader does not exercise this combined case.
- OAuth valid, signature failed → `WWW-Authenticate: Signature error="<code>"` per the grader. The `<code>` matches the test-vector's `expected_outcome.error_code` byte-for-byte.
- Both failing on an optional-signature operation → emit only the Bearer challenge; signature is advisory on `supported_for` operations.

**Idempotency semantics for `submitted` responses.** The framework caches **every successful mutation** including async `submitted` envelopes — not only terminal ones. A replay of the same key within the TTL returns the cached `submitted` response with `replayed: true` injected. A second IO is **not** created. Parallel calls with the same key within the 120-second in-flight window get `adcpError('SERVICE_UNAVAILABLE', { retry_after: 1 })` and should retry — buyer SDKs auto-retry on the `transient` class. The framework emits this for you; you don't handle it in handler code.

This means: the `task_id` you return on a `sales-guaranteed` `create_media_buy` is stable under replay. The buyer polls (or gets webhooks on) the same task handle on any retry within the replay window — you don't create a second IO.

**The three idempotency error codes the framework emits:**

| Code | When | Buyer's next step |
|---|---|---|
| `SERVICE_UNAVAILABLE` (`retry_after: 1`) | Parallel call with the same key, still within the 120s in-flight window | Wait the `retry_after` seconds and retry — eventually replays the cached response or hits CONFLICT |
| `IDEMPOTENCY_CONFLICT` | Same key, different payload hash | Don't retry — buyer has a client bug generating the same key for different requests |
| `IDEMPOTENCY_EXPIRED` | Key replayed after the TTL (default 24h, configurable 1h–7d) | Mint a new key and retry |

## Before Writing Code

Determine these five things. Ask the user — don't guess.

### 1. What Kind of Seller?

- **Premium publisher** — guaranteed inventory, fixed pricing, IO approval (ESPN, NYT)
- **SSP / Exchange** — non-guaranteed, auction-based, instant activation
- **Retail media network** — both guaranteed and non-guaranteed, proposals, catalog-driven creative, conversion tracking

### 2. Guaranteed or Non-Guaranteed?

- **Guaranteed** — `delivery_type: "guaranteed"`, may require async approval (`submitted` → `pending_approval` → `confirmed`)
- **Non-guaranteed** — `delivery_type: "non_guaranteed"`, buyer sets `bid_price`, instant activation

Many sellers support both — different products can have different delivery types.

### 3. Products and Pricing

Get specific inventory. Each product needs:

- `product_id`, `name`, `description`
- `publisher_properties` — at least one `{ publisher_domain: 'example.com', selection_type: 'all' }` (discriminated union: `'all'` | `'by_id'` with `property_ids` | `'by_tag'` with `tags`)
- `format_ids` — array of `{ agent_url: string, id: string }` referencing creative formats
- `delivery_type` — `'guaranteed'` or `'non_guaranteed'`
- `pricing_options` — at least one (see below)
- `reporting_capabilities` — `{ available_reporting_frequencies: ['daily'], expected_delay_minutes: 240, timezone: 'UTC', supports_webhooks: false, available_metrics: ['impressions', 'spend', 'clicks'], date_range_support: 'date_range' }`
- Optional: `channels` — use `as const` to avoid `string[]` inference: `channels: ['display', 'olv'] as const`

Pricing models (all require `pricing_option_id` and `currency`):

- `cpm` — `{ pricing_option_id: 'cpm-1', pricing_model: "cpm", fixed_price: 12.00, currency: "USD" }`
- `cpc` — `{ pricing_option_id: 'cpc-1', pricing_model: "cpc", fixed_price: 1.50, currency: "USD" }`
- Auction — `{ pricing_option_id: 'auction-1', pricing_model: "cpm", floor_price: 5.00, currency: "USD" }` (buyer bids above floor)

Each pricing option can set `min_spend_per_package` to enforce minimum budgets.

For all `PricingOption` variants and `Product` required fields, see [`docs/TYPE-SUMMARY.md`](../../docs/TYPE-SUMMARY.md).

### 4. Approval Workflow

For guaranteed buys, choose one:

- **Instant confirmation** — `create_media_buy` returns completed with confirmed status. Simplest.
- **Async approval** — returns `submitted`, buyer polls `get_media_buys`. Use `registerAdcpTaskTool`.
- **Human-in-the-loop** — returns `input-required` with a setup URL for IO signing.

Non-guaranteed buys are always instant confirmation.

### 5. Creative Management

- **Standard** — `list_creative_formats` + `sync_creatives`. Buyer uploads assets, seller validates.
- **Catalog-driven** — buyer syncs product catalog via `sync_catalogs`. Common for retail media.
- **None** — creative handled out-of-band. Omit creative tools.

## Tools and Required Response Shapes

**`get_adcp_capabilities`** — register first, empty `{}` schema

```
capabilitiesResponse({
  adcp: { major_versions: [3] },
  supported_protocols: ['media_buy'],
})
```

**`sync_accounts`** — `SyncAccountsRequestSchema.shape`

```
taskToolResponse({
  accounts: [{
    account_id: string,       // required - your platform's ID
    brand: { domain: string },// required - echo back from request
    operator: string,         // required - echo back from request
    action: 'created' | 'updated',  // required
    status: 'active' | 'pending_approval',  // required
  }]
})
```

**`sync_governance`** — `SyncGovernanceRequestSchema.shape`

```
taskToolResponse({
  accounts: [{
    account: { brand: {...}, operator: string },  // required - echo back
    status: 'synced',         // required
    governance_agents: [{ url: string, categories?: string[] }],  // required
  }]
})
```

**`get_products`** — `GetProductsRequestSchema.shape`

```
productsResponse({
  products: [{
    product_id: 'prod-1',
    name: 'Homepage Display',
    description: 'Premium display ads on homepage',
    publisher_properties: [{ publisher_domain: 'example.com', selection_type: 'all' }],
    format_ids: [{ agent_url: 'https://creative.example.com/mcp', id: 'display-300x250' }],
    delivery_type: 'guaranteed',
    pricing_options: [{
      pricing_option_id: 'cpm-standard',
      pricing_model: 'cpm',
      fixed_price: 12.00,
      currency: 'USD',
    }],
    reporting_capabilities: {
      available_reporting_frequencies: ['daily'],
      expected_delay_minutes: 240,
      timezone: 'UTC',
      supports_webhooks: false,
      available_metrics: ['impressions', 'spend', 'clicks'],
      date_range_support: 'date_range',
    },
  }],
  sandbox: true,        // for mock data
})
```

**`create_media_buy`** — `CreateMediaBuyRequestSchema.shape`

Validate the request before creating the buy. Return an error response (not `adcpError`) when business validation fails:

```
// Success — revision, confirmed_at, and valid_actions are auto-set:
mediaBuyResponse({
  media_buy_id: string,       // required
  status: 'pending_creatives',// triggers valid_actions auto-population
  packages: [{                // required
    package_id: string,
    product_id: string,
    pricing_option_id: string,
    budget: number,
  }],
})

// Validation failure (reversed dates, budget too low, unknown product):
adcpError('INVALID_REQUEST', { message: 'start_time must be before end_time' })
```

**`get_media_buys`** — `GetMediaBuysRequestSchema.shape`

```
getMediaBuysResponse({
  media_buys: [{
    media_buy_id: string,   // required
    status: 'active' | 'pending_start' | ...,  // required
    currency: 'USD',        // required
    confirmed_at: string,   // required for guaranteed approval — ISO timestamp
    packages: [{
      package_id: string,   // required
    }],
  }]
})
```

**`list_creative_formats`** — `ListCreativeFormatsRequestSchema.shape`

```
listCreativeFormatsResponse({
  formats: [{
    format_id: { agent_url: string, id: string },  // required
    name: string,  // required
  }]
})
```

**`sync_creatives`** — `SyncCreativesRequestSchema.shape`

```
syncCreativesResponse({
  creatives: [{
    creative_id: string,          // required - echo from request
    action: 'created' | 'updated',  // required
  }]
})
```

**`get_media_buy_delivery`** — `GetMediaBuyDeliveryRequestSchema.shape`

```
deliveryResponse({
  reporting_period: { start: string, end: string },  // required - ISO timestamps
  media_buy_deliveries: [{
    media_buy_id: string,     // required
    status: 'active',         // required
    totals: { impressions: number, spend: number },  // required
    by_package: [],           // required (can be empty)
  }]
})
```

### Context and Ext Passthrough

Every AdCP request includes an optional `context` field. Buyers use it to carry correlation IDs, orchestration metadata, and workflow state across multi-agent calls. Your agent **must** echo the `context` object back unchanged in every response.

```typescript
// In every tool handler:
const context = args.context; // may be undefined — that's fine

// In every response:
return taskToolResponse({
  // ... your response fields ...
  context, // echo it back unchanged
});
```

Do not modify, inspect, or omit the context — treat it as opaque. If the request has no context, omit it from the response.

Some schemas also define an `ext` field for vendor-namespaced extensions. If your request schema includes `ext`, accept it without error. Tools with explicit `ext` support: `sync_governance`, `provide_performance_feedback`, `sync_event_sources`.

## Compliance Testing (Optional)

Add `registerTestController` so the comply framework can deterministically test your state machines. Without it, compliance testing relies on observational storyboards that can't force state transitions.

```
import { registerTestController } from '@adcp/client';
import type { TestControllerStore } from '@adcp/client';

const store: TestControllerStore = {
  async forceAccountStatus(accountId, status) {
    const prev = accounts.get(accountId);
    if (!prev) throw new TestControllerError('NOT_FOUND', `Account ${accountId} not found`);
    accounts.set(accountId, status);
    return { success: true, previous_state: prev, current_state: status };
  },
  async forceMediaBuyStatus(mediaBuyId, status) {
    const prev = mediaBuys.get(mediaBuyId);
    if (!prev) throw new TestControllerError('NOT_FOUND', `Media buy ${mediaBuyId} not found`);
    const terminal = ['completed', 'rejected', 'canceled'];
    if (terminal.includes(prev))
      throw new TestControllerError('INVALID_TRANSITION', `Cannot transition from ${prev}`, prev);
    mediaBuys.set(mediaBuyId, status);
    return { success: true, previous_state: prev, current_state: status };
  },
  async forceCreativeStatus(creativeId, status, rejectionReason) {
    const prev = creatives.get(creativeId);
    if (!prev) throw new TestControllerError('NOT_FOUND', `Creative ${creativeId} not found`);
    // archived blocks transitions to active states, but archived → rejected is valid (compliance override)
    const activeStatuses = ['processing', 'pending_review', 'approved'];
    if (prev === 'archived' && activeStatuses.includes(status))
      throw new TestControllerError('INVALID_TRANSITION', `Cannot transition from archived to ${status}`, prev);
    creatives.set(creativeId, status);
    return { success: true, previous_state: prev, current_state: status };
  },
  async simulateDelivery(mediaBuyId, params) {
    // params: { impressions?: number, clicks?: number, reported_spend?: { amount, currency }, conversions?: number }
    return { success: true, simulated: { ...params }, cumulative: { ...params } };
  },
  async simulateBudgetSpend(params) {
    return { success: true, simulated: { spend_percentage: params.spend_percentage } };
  },
};

registerTestController(server, store);
```

When using this, declare `compliance_testing` in `supported_protocols`:

```
capabilitiesResponse({
  adcp: { major_versions: [3] },
  supported_protocols: ['media_buy', 'compliance_testing'],
})
```

Only implement the store methods for scenarios your agent supports. Unimplemented methods are excluded from `list_scenarios` automatically.

The storyboard tests state machine correctness:

- `NOT_FOUND` when forcing transitions on unknown entities
- `INVALID_TRANSITION` when transitioning from terminal states (completed, rejected, canceled for media buys; archived blocks active states like processing/pending_review/approved, but archived → rejected is valid)
- Successful transitions between valid states

Throw `TestControllerError` from store methods for typed errors. The SDK validates status enum values before calling your store.

Validate with: `adcp storyboard run <agent> deterministic_testing --json`

### Session-backed stores (factory shape)

**Don't close over module-scoped maps.** If your session state is persisted (Postgres, Redis, JSONB) and rehydrated into a _new_ object per request, a store whose methods close over a module-level `WeakMap<SessionState, …>` or module-scoped cache will silently drop entries between calls — the cached ref was GC'd when the session was serialized out and rebuilt.

Use the factory shape. `scenarios` declares the static capability set — the SDK answers `list_scenarios` from this field and **never invokes `createStore` for capability probes**, so it's safe to throw on missing `session_id`. `createStore` runs per request for every other scenario, returning a store bound to the live session.

```
import {
  registerTestController,
  CONTROLLER_SCENARIOS,
  enforceMapCap,
  TestControllerError,
} from '@adcp/client';

registerTestController(server, {
  scenarios: [
    CONTROLLER_SCENARIOS.FORCE_ACCOUNT_STATUS,
    CONTROLLER_SCENARIOS.FORCE_MEDIA_BUY_STATUS,
    CONTROLLER_SCENARIOS.FORCE_CREATIVE_STATUS,
    CONTROLLER_SCENARIOS.SIMULATE_DELIVERY,
    CONTROLLER_SCENARIOS.SIMULATE_BUDGET_SPEND,
  ],
  async createStore(input) {
    const sessionId = (input.context as { session_id?: string })?.session_id;
    if (!sessionId) throw new TestControllerError('INVALID_PARAMS', 'context.session_id is required');
    const session = await loadSession(sessionId);

    return {
      async forceAccountStatus(accountId, status) {
        // enforceMapCap only rejects NET-NEW keys at the cap; updating an
        // existing accountId always passes, so calling it before every set()
        // is safe.
        enforceMapCap(session.accountStatuses, accountId, 'account statuses');
        const prev = session.accountStatuses.get(accountId) ?? 'active';
        session.accountStatuses.set(accountId, status);
        await saveSession(session);
        return { success: true, previous_state: prev, current_state: status };
      },

      async forceMediaBuyStatus(mediaBuyId, status) {
        const prev = session.mediaBuyStatuses.get(mediaBuyId);
        if (!prev) throw new TestControllerError('NOT_FOUND', `Media buy ${mediaBuyId} not found`);
        const terminal = ['completed', 'rejected', 'canceled'];
        if (terminal.includes(prev)) {
          throw new TestControllerError('INVALID_TRANSITION', `Cannot transition from ${prev}`, prev);
        }
        enforceMapCap(session.mediaBuyStatuses, mediaBuyId, 'media buy states');
        session.mediaBuyStatuses.set(mediaBuyId, status);
        await saveSession(session);
        return { success: true, previous_state: prev, current_state: status };
      },

      // ...implement other scenarios from your `scenarios` list the same way
    };
  },
});
```

### Cap per-session maps

Wrap every `Map.set` on session-scoped state with `enforceMapCap` to reject unbounded growth with a typed `INVALID_STATE` error (vs. silent LRU eviction, which would make compliance tests nondeterministic). Existing-key overwrites always pass — only _net-new_ keys are rejected at the cap. Default cap is `SESSION_ENTRY_CAP` (1000).

### Custom MCP wrappers

If you need `AsyncLocalStorage`, sandbox gating, or a custom task store around the controller tool, bypass `registerTestController` and call the exported building blocks directly. `toMcpResponse` and `TOOL_INPUT_SHAPE` are the exact pieces the default registration uses — reusing them keeps the envelope shape identical.

```
import { AsyncLocalStorage } from 'node:async_hooks';
import { handleTestControllerRequest, toMcpResponse, TOOL_INPUT_SHAPE } from '@adcp/client';

const sessionContext = new AsyncLocalStorage<{ sessionId: string }>();
const store = { async forceAccountStatus(id, status) { /* ... */ } };

server.tool('comply_test_controller', 'Sandbox only.', TOOL_INPUT_SHAPE, async input => {
  if (!sandboxEnabled()) {
    return toMcpResponse({ success: false, error: 'FORBIDDEN', error_detail: 'Sandbox disabled' });
  }
  const sessionId = (input.context as { session_id: string }).session_id;
  return sessionContext.run({ sessionId }, async () => {
    const response = await handleTestControllerRequest(store, input as Record<string, unknown>);
    return toMcpResponse(response);
  });
});
```

## SDK Quick Reference

| SDK piece                                                                 | Usage                                                                          |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `createAdcpServer(config)`                                                | Domain-grouped server — auto-wires schemas, response builders, capabilities    |
| `serve(() => createAdcpServer(config))`                                   | Start HTTP server on `:3001/mcp`                                               |
| `ctx.store`                                                               | State store in every handler — `get`, `put`, `patch`, `delete`, `list`         |
| `InMemoryStateStore`                                                      | Default state store (dev/testing)                                              |
| `PostgresStateStore`                                                      | Production state store (shared across instances)                               |
| `DEFAULT_REPORTING_CAPABILITIES`                                          | Use as `reporting_capabilities: DEFAULT_REPORTING_CAPABILITIES` on products    |
| `checkGovernance(options)`                                                | Call governance agent before financial commits                                 |
| `governanceDeniedError(result)`                                           | Convert governance denial to GOVERNANCE_DENIED error                           |
| `mediaBuyResponse(data)`                                                  | Auto-applied for `createMediaBuy` (sets revision, confirmed_at, valid_actions) |
| `adcpError(code, { message })`                                            | Structured error (e.g., `BUDGET_TOO_LOW`, `PRODUCT_NOT_FOUND`)                 |
| `registerTestController(server, store \| { scenarios, createStore })`     | Add `comply_test_controller`. Plain store or per-request factory.              |
| `TestControllerError(code, message)`                                      | Typed error from store methods                                                 |
| `handleTestControllerRequest(store, input)`                               | Low-level dispatch for custom MCP wrappers                                     |
| `toMcpResponse(response)` / `TOOL_INPUT_SHAPE`                            | MCP envelope + Zod input schema for custom wrappers                            |
| `enforceMapCap(map, key, label, cap?)`                                    | Reject net-new keys once a session Map hits `SESSION_ENTRY_CAP` (1000)         |
| `expectControllerError(result, code)` / `expectControllerSuccess(result)` | Unit-test assertions — narrow responses to error or success arms               |

Response builders (`productsResponse`, `mediaBuyResponse`, `deliveryResponse`, etc.) are auto-applied by `createAdcpServer` — you return the data, the framework wraps it. You only need to call them directly for tools without a dedicated builder.

Import everything from `@adcp/client`. Types from `@adcp/client` with `import type`.

## Setup

```bash
npm init -y
npm install @adcp/client
npm install -D typescript @types/node
```

Minimal `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "strict": true,
    "skipLibCheck": true,
    "outDir": "dist"
  }
}
```

`skipLibCheck: true` avoids false-positive errors from transitive `.d.ts` files (e.g., `@opentelemetry/api`).

## Implementation

Use `createAdcpServer` — it auto-wires schemas, response builders, and `get_adcp_capabilities` from the handlers you provide. Handlers receive `(params, ctx)` where `ctx.store` persists state and `ctx.account` is the resolved account.

**Imports**: most things live at `@adcp/client`. The idempotency store helpers (`createIdempotencyStore`, `memoryBackend`, `pgBackend`) live at the narrower `@adcp/client/server` subpath. Both are re-exported from the root — either works — but splitting them makes intent obvious.

```typescript
import { randomUUID } from 'node:crypto';
import {
  createAdcpServer,
  serve,
  adcpError,
  InMemoryStateStore,
  checkGovernance,
  governanceDeniedError,
} from '@adcp/client';
import { createIdempotencyStore, memoryBackend } from '@adcp/client/server';
import type { ServeContext } from '@adcp/client';

const stateStore = new InMemoryStateStore(); // shared across requests

// Idempotency — required for any v3-compliant seller that accepts mutating
// requests. `createIdempotencyStore` throws if `ttlSeconds` is outside the
// spec bounds (3600–604800).
const idempotency = createIdempotencyStore({
  backend: memoryBackend(), // pgBackend(pool) for production
  ttlSeconds: 86400, // 24 hours
});

function createAgent({ taskStore }: ServeContext) {
  return createAdcpServer({
    name: 'My Seller Agent',
    version: '1.0.0',
    taskStore,
    stateStore,
    idempotency,

    // Principal scoping for idempotency. MUST never return undefined — or
    // every mutating request rejects as SERVICE_UNAVAILABLE. A constant is
    // fine for a demo; for multi-tenant production use ctx.account typed
    // via `createAdcpServer<MyAccount>({...})`.
    resolveSessionKey: () => 'default-principal',

    resolveAccount: async ref => {
      if ('account_id' in ref) return stateStore.get('accounts', ref.account_id);
      return null;
    },

    accounts: {
      syncAccounts: async (params, ctx) => {
        /* ... */
      },
    },
    mediaBuy: {
      getProducts: async (params, ctx) => {
        return { products: PRODUCTS, sandbox: true };
        // productsResponse() auto-applied by framework
      },
      createMediaBuy: async (params, ctx) => {
        // Governance check for financial commitment
        if (ctx.account?.governanceUrl) {
          const gov = await checkGovernance({
            agentUrl: ctx.account.governanceUrl,
            planId: params.plan_id ?? 'default',
            caller: 'https://my-agent.com/mcp',
            tool: 'create_media_buy',
            payload: params,
          });
          if (!gov.approved) return governanceDeniedError(gov);
        }
        // Use randomUUID (not Date.now) so ids are unguessable — a guessable
        // media_buy_id lets another buyer probe or cancel. Same applies to
        // any seller-issued id (package_id, creative_id, etc.).
        const buy = {
          media_buy_id: `mb_${randomUUID()}`,
          status: 'pending_creatives' as const,
          packages:
            params.packages?.map(pkg => ({
              package_id: `pkg_${randomUUID()}`,
              product_id: pkg.product_id,
              pricing_option_id: pkg.pricing_option_id,
              budget: pkg.budget,
            })) ?? [],
        };
        await ctx.store.put('media_buys', buy.media_buy_id, buy);
        return buy; // mediaBuyResponse() auto-applied (sets revision, confirmed_at, valid_actions)
      },
      updateMediaBuy: async (params, ctx) => {
        const existing = await ctx.store.get('media_buys', params.media_buy_id);
        if (!existing) {
          return adcpError('MEDIA_BUY_NOT_FOUND', {
            message: `No media buy with id ${params.media_buy_id}`,
            field: 'media_buy_id',
          });
        }
        // Only merge the fields you want to persist — do NOT spread `params`
        // wholesale. `params` carries envelope fields (idempotency_key,
        // context) that have no business in your domain state. Spreading
        // them pollutes `get_media_buys` responses and breaks dedup.
        const updated = { ...existing, status: params.active === false ? 'paused' : 'active' };
        await ctx.store.put('media_buys', params.media_buy_id, updated);
        return {
          media_buy_id: params.media_buy_id,
          status: updated.status as 'paused' | 'active',
          affected_packages: [],
        };
      },
      getMediaBuys: async (params, ctx) => {
        const result = await ctx.store.list('media_buys');
        return { media_buys: result.items };
      },
      getMediaBuyDelivery: async (params, ctx) => {
        /* ... */
      },
      listCreativeFormats: async (params, ctx) => {
        /* ... */
      },
      syncCreatives: async (params, ctx) => {
        return {
          // Response shape is `creatives: [{ creative_id, action }]` per the
          // sync_creatives response schema — NOT `synced_creatives`.
          creatives:
            params.creatives?.map(c => ({
              creative_id: c.creative_id ?? `cr_${randomUUID()}`,
              action: 'created' as const,
            })) ?? [],
        };
      },
    },
    capabilities: {
      features: { inlineCreativeManagement: false },
    },
  });
}

serve(createAgent);
```

Key points:

1. Single `.ts` file — all domain handlers in one `createAdcpServer` call
2. `get_adcp_capabilities` is auto-generated from your handlers — don't register it manually (idempotency capability is auto-declared too)
3. Response builders are auto-applied — just return the data
4. Use `ctx.store` for state — persists across stateless HTTP requests
5. Set `sandbox: true` on all mock/demo responses
6. Use `adcpError()` for business validation failures
7. Use `as const` on string literal arrays and union-typed fields in product definitions — TypeScript infers `string[]` from `['display', 'olv']` but the SDK requires specific union types like `MediaChannel[]`. Apply `as const` to `channels`, `delivery_type`, `selection_type`, and `pricing_model` values.

<a name="idempotency"></a>
## Idempotency

AdCP v3 requires an `idempotency_key` on every mutating request. For sellers, that's `create_media_buy`, `update_media_buy`, `sync_creatives`, and any `sync_*` tools you implement. Idempotency is wired in the Implementation example above — this section explains what the framework does for you and the subtleties to know.

**What the framework handles when you pass `idempotency` to `createAdcpServer`:**

- Rejects missing or malformed `idempotency_key` with `INVALID_REQUEST`. The spec pattern is `^[A-Za-z0-9_.:-]{16,255}$` — a test key like `"key1"` will be rejected for length, not idempotency logic.
- Hashes the request payload with RFC 8785 JCS; returns `IDEMPOTENCY_CONFLICT` on same-key-different-payload. The error body carries only `code` + `message` — no payload hash, no field pointer, no leaked cached content.
- Returns `IDEMPOTENCY_EXPIRED` when a key is past the TTL (with ±60s clock-skew tolerance).
- Injects `replayed: true` on `result.structuredContent.replayed` when returning a cached response; fresh executions omit the field.
- Auto-declares `adcp.idempotency.replay_ttl_seconds` on `get_adcp_capabilities`.
- Only caches successful responses — errors re-execute on retry so transient failures don't lock into the cache.
- Atomic claim on `check()` so concurrent retries with a fresh key don't all race to execute side effects.

**Scoping**: the principal comes from `resolveSessionKey` (or override with `resolveIdempotencyPrincipal(ctx, params, toolName)` for per-tool custom scopes). Two callers with the same principal share a cache namespace; different principals are isolated.

**Two things to know**:

1. `ttlSeconds` must be `3600` (1h) to `604800` (7d) — out of range throws at `createIdempotencyStore` construction. Don't pass minutes thinking they're seconds.
2. If you register mutating handlers without passing `idempotency`, the framework logs an error at server-creation time (v3 non-compliance). Silence it by either wiring idempotency or setting `capabilities.idempotency.replay_ttl_seconds` in your config (declares non-compliance to buyers).

## Going to Production

The quick-start uses `memoryBackend()` for idempotency and `InMemoryStateStore` for state — both reset on process restart and don't scale across replicas. Production swaps three pieces:

```typescript
import { Pool } from 'pg';
import {
  createIdempotencyStore,
  pgBackend,
  getIdempotencyMigration,
  PostgresStateStore,
  getAdcpStateMigration,
  PostgresTaskStore,
  MCP_TASKS_MIGRATION,
  cleanupExpiredIdempotency,
} from '@adcp/client/server';

// Fail fast — pg silently defaults to localhost+OS-user if DATABASE_URL is
// missing, which works on a dev laptop and breaks cryptically in CI.
if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is required');
}
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Run once per deployment before starting the server (e.g., as a
// separate migrate step, or at boot with a feature flag).
await pool.query(getIdempotencyMigration());
await pool.query(getAdcpStateMigration());
await pool.query(MCP_TASKS_MIGRATION);

const idempotency = createIdempotencyStore({
  backend: pgBackend(pool),
  ttlSeconds: 86400,
});
const stateStore = new PostgresStateStore(pool);
const taskStore = new PostgresTaskStore(pool);

// Cleanup expired idempotency rows hourly so the cache table doesn't
// grow unboundedly. Schedule via cron in production.
setInterval(() => cleanupExpiredIdempotency(pool).catch(console.error), 3600 * 1000);

serve(() =>
  createAdcpServer({
    name: 'My Seller Agent',
    version: '1.0.0',
    taskStore,
    stateStore,
    idempotency,

    // Real multi-tenant principal resolution — derived from an authenticated
    // session (e.g., JWT claims middleware before serve()), not a constant.
    resolveAccount: async ref => db.findAccount(ref),
    resolveSessionKey: ctx => (ctx.account as { id?: string } | undefined)?.id ?? 'unknown-principal',

    mediaBuy: {
      /* handlers */
    },
  })
);
```

Two things the example doesn't wire (app-specific):

- **Authentication** — the quick-start has no auth. Production agents need bearer-token or OAuth in front of `serve()`. The library provides OAuth helpers; bearer is middleware territory (Express/Fastify).
- **Connection-pool sizing** — pass `max`, `idleTimeoutMillis`, `connectionTimeoutMillis` on `new Pool({...})` per your deployment's concurrency characteristics. The pg driver defaults are fine for low traffic.

<a name="protecting-your-agent"></a>
## Protecting your agent

**An AdCP agent that accepts unauthenticated requests is non-compliant.** The compliance runner enforces this via the `security_baseline` storyboard (every agent regardless of specialism). You MUST pick at least one of:

- **API key** — static bearer tokens looked up in your database or a constant map. Best for B2B integrations with a known counterparty.
- **OAuth 2.0** — JWTs signed by an IdP (WorkOS, Auth0, Clerk, Okta, a self-hosted authorization server). Best when buyers authenticate as themselves.
- **Both** — accept either at runtime via `anyOf(verifyApiKey(...), verifyBearer(...))`.

Ask the operator which mechanism they want before generating code. "API key, OAuth, or both?" is the first question.

### API key

```typescript
import { serve, verifyApiKey } from '@adcp/client';

serve(createAgent, {
  authenticate: verifyApiKey({
    verify: async (token) => {
      const row = await db.api_keys.findUnique({ where: { token } });
      if (!row) return null;  // framework replies 401 with WWW-Authenticate
      return { principal: row.account_id };
    },
  }),
});
```

For local development use the static `keys` map: `verifyApiKey({ keys: { sk_test: { principal: 'dev' } } })`.

### OAuth

```typescript
import { serve, verifyBearer } from '@adcp/client';

const AGENT_URL = 'https://my-agent.example.com/mcp';

serve(createAgent, {
  publicUrl: AGENT_URL, // canonical RFC 8707 audience
  authenticate: verifyBearer({
    jwksUri: 'https://auth.example.com/.well-known/jwks.json',
    issuer: 'https://auth.example.com',
    audience: AGENT_URL, // MUST equal publicUrl
  }),
  protectedResource: {
    authorization_servers: ['https://auth.example.com'],
    scopes_supported: ['read', 'write'],
  },
});
```

Set `publicUrl` to the canonical https:// URL clients use — the framework serves `/.well-known/oauth-protected-resource/mcp` with that exact `resource` value, and the JWT `audience` check rejects tokens minted for any other URL. Deriving the resource URL from `publicUrl` (not the incoming `Host` header) is what stops a phishing attacker from making your server advertise `https://evil.example/mcp` as the audience.

### Both

```typescript
import { serve, verifyApiKey, verifyBearer, anyOf } from '@adcp/client';

serve(createAgent, {
  publicUrl: AGENT_URL,
  authenticate: anyOf(
    verifyApiKey({ verify: lookupApiKey }),
    verifyBearer({ jwksUri, issuer, audience: AGENT_URL }),
  ),
  protectedResource: { authorization_servers: [issuer] },
});
```

### Compliance checklist

The `security_baseline` storyboard verifies:

1. Unauthenticated request → MUST return 401 (or 403) with a `WWW-Authenticate: Bearer ...` header. The framework does this for you when `authenticate` returns `null` or throws.
2. At least one of API-key or OAuth discovery must succeed.
3. If OAuth is advertised, the `resource` field in `/.well-known/oauth-protected-resource` MUST match the URL being called. Set `publicUrl` once — the framework enforces this automatically.

## Validation

**After writing the agent, validate it. Fix failures. Repeat.**

**Full validation** (if you can bind ports):

```bash
npx tsx agent.ts &
npx @adcp/client storyboard run http://localhost:3001/mcp media_buy_seller --json
```

**Sandbox validation** (if ports are blocked):

```bash
npx tsc --noEmit
```

When storyboard output shows failures, fix each one:

- `response_schema` → response doesn't match Zod schema
- `field_present` → required field missing
- MCP error → check tool registration (schema, name)

**Keep iterating until all steps pass.**

## Storyboards

| Storyboard                      | Use case                                               |
| ------------------------------- | ------------------------------------------------------ |
| `media_buy_seller`              | Full lifecycle — every seller should pass this         |
| `media_buy_non_guaranteed`      | Auction flow with bid adjustment                       |
| `media_buy_guaranteed_approval` | IO approval workflow                                   |
| `media_buy_proposal_mode`       | AI-generated proposals                                 |
| `media_buy_catalog_creative`    | Catalog sync + conversions                             |
| `schema_validation`             | Schema compliance + date validation errors             |
| `deterministic_testing`         | State machine correctness via `comply_test_controller` |

## Common Mistakes

| Mistake                                                    | Fix                                                                                                                                                                              |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Using `createTaskCapableServer` + `server.tool()`          | Use `createAdcpServer` — handles schemas, response builders, capabilities                                                                                                        |
| Using module-level Maps for state                          | Use `ctx.store` — persists across HTTP requests, swappable for postgres                                                                                                          |
| Return raw JSON without response builders                  | `createAdcpServer` auto-applies response builders — just return the data                                                                                                         |
| Missing `brand`/`operator` in sync_accounts response       | Echo them back from the request — they're required                                                                                                                               |
| sync_governance returns wrong shape                        | Must include `status: 'synced'` and `governance_agents` array                                                                                                                    |
| `sandbox: false` on mock data                              | Buyers may treat mock data as real                                                                                                                                               |
| Returns raw JSON for validation failures                   | Use `adcpError('INVALID_REQUEST', { message })` — storyboards validate the `adcp_error` structure                                                                                |
| Missing `publisher_properties` or `format_ids` on Product  | Both are required — see product example in `get_products` section                                                                                                                |
| format_ids in products don't match list_creative_formats   | Buyers echo format_ids from products into sync_creatives — if your validation rejects your own format_ids, the buyer can't fulfill creative requirements                         |
| Missing `@types/node` in devDependencies                   | `process.env` doesn't resolve without it — see Setup section                                                                                                                     |
| Dropping `context` from responses                          | Echo `args.context` back unchanged in every response — buyers use it for correlation                                                                                             |
| `channels` typed as `string[]` instead of `MediaChannel[]` | Use `as const` on channel arrays: `channels: ['display', 'olv'] as const`. TypeScript infers `string[]` from array literals, but the SDK requires the `MediaChannel` union type. |

## Specialism Details

### <a name="specialism-sales-guaranteed"></a>sales-guaranteed

Storyboard: `sales_guaranteed`. Guaranteed media buys with human IO signing are modelled as **A2A tasks**, not as a stepwise MediaBuy status machine. There is no `pending_approval` value in `MediaBuy.status` — review lives at the task layer, and the MediaBuy itself doesn't exist as a queryable object until the task completes.

**What `create_media_buy` must return when IO signing is required:** a task envelope in `submitted` state. No `media_buy_id`, no `packages`, no `setup` or `estimated_completion` on a MediaBuy object yet.

```typescript
// Use an A2A-task-capable tool registration for async operations.
// See src/lib/server/tasks.ts — registerAdcpTaskTool wraps the MCP SDK's
// server.experimental.tasks.registerToolTask(). Your create_media_buy handler
// initiates a task and returns the submitted envelope:
import { taskToolResponse } from '@adcp/client/server';

// Inside your create_media_buy task handler:
return taskToolResponse(
  {
    status: 'submitted',   // TASK status, not MediaBuy.status
    task_id: taskId,       // the handle the buyer polls or gets webhooks on
    message: 'Awaiting IO signature from sales team; typical turnaround 2–4 hours',
  },
  'IO signature pending',
);
```

**When the task completes** (after your humans sign the IO), your platform emits the final `create_media_buy` result — now carrying `media_buy_id` and `packages` — to the buyer's `push_notification_config.url` (or the next `tasks/get` poll). The buyer calls `get_media_buys` with that `media_buy_id` and sees the buy `active`.

Declare `requires_io_approval` in your `capabilities.features` so buyers can filter for agents that will return task envelopes on guaranteed buys.

For deterministic compliance testing, implement `forceTaskStatus` (not `forceMediaBuyStatus`) in your `TestControllerStore` to drive the task from `submitted → completed` without waiting for a human.

### <a name="specialism-sales-non-guaranteed"></a>sales-non-guaranteed

Storyboard: `media_buy_non_guaranteed`. The specialism hinges on `bid_price` and `update_media_buy`, neither of which the baseline example shows.

Packages on `create_media_buy` carry `bid_price`. Validate it against the product's `floor_price`:

```typescript
createMediaBuy: async (params, ctx) => {
  for (const pkg of params.packages ?? []) {
    const product = PRODUCTS.find((p) => p.product_id === pkg.product_id);
    const floor = product?.pricing_options[0].floor_price;
    if (floor && pkg.bid_price != null && pkg.bid_price < floor) {
      return adcpError('INVALID_REQUEST', {
        message: `bid_price ${pkg.bid_price} below floor_price ${floor}`,
      });
    }
  }
  return {
    media_buy_id: `mb_${Date.now()}`,
    status: 'active' as const,   // instant — no IO
    packages: /* ... */,
  };
},

updateMediaBuy: async (params, ctx) => {
  const existing = await ctx.store.get('media_buys', params.media_buy_id);
  if (!existing) return adcpError('NOT_FOUND', { message: `Media buy ${params.media_buy_id} not found` });
  // Apply bid/budget updates from params.packages
  const updated = { ...existing, packages: /* merged */ };
  await ctx.store.put('media_buys', params.media_buy_id, updated);
  return updated;
},
```

`valid_actions` on an active non-guaranteed buy should include `pause`, `update_bid`, `get_delivery`. The framework auto-populates this when `createMediaBuy`/`updateMediaBuy` return with `status: 'active'`.

### <a name="specialism-sales-broadcast-tv"></a>sales-broadcast-tv

Storyboard: `media_buy_broadcast_seller`. Broadcast has four protocol surfaces not used in digital.

**Pricing** — unit-based (cost per spot). Until a `pricing_model: 'unit'` lands, express as CPM with a very high `fixed_price` that represents the cost per thousand spots equivalent, or use a custom pricing option ID and clarify in `description`.

**Agency estimate number** — top-level on `create_media_buy`. Echo it on the response:

```typescript
{
  media_buy_id,
  agency_estimate_number: params.agency_estimate_number,  // "PNNL-NM-2026-Q4-0847"
  status: 'submitted',
  // ...
}
```

**Measurement terms** — per-package on the request:

```typescript
packages: [{
  product_id: 'primetime_30s_mf',
  measurement_terms: {
    billing_measurement: {
      vendor: { domain: 'videoamp.com' },
      measurement_window: 'c7',
      max_variance_percent: 10,
    },
  },
}]
```

Echo `measurement_terms` on the response's package entries — the buyer uses `c7` as the guarantee basis for reconciliation.

**Ad-ID on creatives** — `sync_creatives` rejects spots without a valid Ad-ID:

```typescript
syncCreatives: async (params) => ({
  creatives: params.creatives.map((c) => {
    const adId = c.industry_identifiers?.find((x) => x.type === 'ad_id')?.value;
    if (!adId) return { creative_id: c.creative_id, action: 'created', status: 'rejected',
      rejection_reason: 'Ad-ID required for broadcast spots' };
    return { creative_id: c.creative_id, action: 'created', status: 'accepted' };
  }),
}),
```

**Measurement windows on delivery** — each delivery row tags `measurement_window: 'live' | 'c3' | 'c7'`, `is_final: boolean`, and `supersedes_window` (for window upgrades). Live ratings mature in 24h, C3 in ~4d, C7 in ~8d. Final reconciliation lands ~15d after last air date.

### <a name="specialism-sales-social"></a>sales-social

Storyboard: `social_platform`. This is a walled-garden sync flow — the classic `get_products` → `create_media_buy` path does not apply. The buyer pushes audiences and creatives **into** the platform.

Required tools (on top of baseline):

- `sync_accounts` with `account_scope`, `payment_terms`, `setup` fields
- `list_accounts` with brand filter
- `sync_audiences` → returns `{ audiences: [{ audience_id, name, status: 'active', action: 'created' }] }`
- `log_event` → returns `{ events: [{ event_id, status: 'accepted' }] }`
- `get_account_financials` → returns `{ account, financials: { currency, current_spend, remaining_balance, payment_status } }`
- `sync_creatives` for platform-native assemblies with `{ creative_id, action, status: 'pending_review' }`

`sync_audiences` and `log_event` live under `eventTracking`, not `mediaBuy`, in `createAdcpServer`. `get_account_financials` lives under `accounts`.

### <a name="specialism-sales-proposal-mode"></a>sales-proposal-mode

Storyboard: `media_buy_proposal_mode`. The acceptance path inverts the baseline — buyer sends `proposal_id` + `total_budget`, no `packages`.

`get_products` returns a `proposals[]` array alongside products:

```typescript
return {
  products: PRODUCTS,
  proposals: [{
    proposal_id: 'balanced_reach_q2',
    name: 'Balanced Reach Plan',
    rationale: 'CTV for premium reach, OLV for sports frequency, display for always-on context.',
    total_budget: { amount: 50000, currency: 'USD' },
    budget_allocations: [
      { product_id: 'ctv_outdoor_lifestyle', pricing_option_id: 'ctv_cpm', amount: 25000, currency: 'USD' },
      { product_id: 'olv_sports', pricing_option_id: 'olv_cpm', amount: 15000, currency: 'USD' },
      { product_id: 'display_endemic', pricing_option_id: 'display_cpm', amount: 10000, currency: 'USD' },
    ],
    forecast: { impressions: 3_500_000, reach: 1_200_000, frequency: 2.9 },
  }],
  sandbox: true,
};
```

Handle `buying_mode: 'refine'` by returning an updated `proposals[]` plus `refinement_applied[]` describing what changed.

`create_media_buy` with `proposal_id`:

```typescript
createMediaBuy: async (params, ctx) => {
  if (params.proposal_id) {
    const proposal = PROPOSALS[params.proposal_id];
    if (!proposal) return adcpError('INVALID_REQUEST', { message: `Unknown proposal_id: ${params.proposal_id}` });
    // TTL check — return PROPOSAL_EXPIRED if the proposal has aged out
    return {
      media_buy_id: `mb_${Date.now()}`,
      status: 'active' as const,       // instant on proposal accept
      proposal_id: proposal.proposal_id,
      packages: proposal.budget_allocations.map((a, i) => ({ /* expand server-side */ })),
    };
  }
  // ... fall through to baseline packages path
},
```

### <a name="specialism-audience-sync"></a>audience-sync

Storyboard: `audience_sync`. Track is `audiences` — separate from the core seller lifecycle, but lives in this skill because identifier sync and account discovery sit next to media-buying.

Required tools: `sync_audiences` and `list_accounts`. `sync_audiences` is overloaded — it handles three cases through its request payload:

- **Discovery**: call with no `audiences` array (or empty). Returns the audiences already on the platform for the account.
- **Add**: each audience entry has an `add: [{ hashed_email }, { hashed_phone }, ...]` array of hashed identifiers.
- **Delete**: each audience entry has `delete: true`.

There is no separate `delete_audience` tool — deletion rides on `sync_audiences`.

```typescript
createAdcpServer({
  accounts: {
    syncAccounts: /* baseline */,
    listAccounts: async (params, ctx) => {
      const { items } = await ctx.store.list('accounts');
      const brandFilter = params.brand?.domain;
      return { accounts: brandFilter ? items.filter((a) => a.brand.domain === brandFilter) : items };
    },
  },
  eventTracking: {
    syncAudiences: async (params, ctx) => {
      // Discovery mode — no audiences in request
      if (!params.audiences?.length) {
        const { items } = await ctx.store.list('audiences');
        return { audiences: items.map((a) => ({ audience_id: a.audience_id, name: a.name, status: 'active' as const })) };
      }
      // Add / delete mode
      return {
        audiences: await Promise.all(params.audiences.map(async (a) => {
          if (a.delete) {
            await ctx.store.delete('audiences', a.audience_id);
            return { audience_id: a.audience_id, name: a.name, action: 'deleted' as const, status: 'inactive' as const };
          }
          const identifiers = a.add ?? [];
          const uploaded = identifiers.length;
          const matched = Math.floor(uploaded * 0.72);   // simulated match rate
          await ctx.store.put('audiences', a.audience_id, { ...a, uploaded, matched });
          return {
            audience_id: a.audience_id,
            name: a.name,
            action: 'created' as const,
            status: 'active' as const,
            uploaded_count: uploaded,
            matched_count: matched,
            effective_match_rate: uploaded ? matched / uploaded : 0,
          };
        })),
      };
    },
  },
});
```

**Identifier rules:** each `add` entry is a single-identifier object (`{hashed_email}` OR `{hashed_phone}`, not both). Values are SHA-256 of lowercased, trimmed input. Salting/normalization is out-of-band between buyer and platform — document your expected input format.

**Platform types:** destinations span `['dsp', 'retail_media', 'social', 'audio', 'pmax']`. Each has its own `activation_key` shape — see `skills/build-signals-agent/SKILL.md` for activation patterns, which are shared across signals and audience sync.

### <a name="specialism-signed-requests"></a>signed-requests

Storyboard: `signed_requests`. Transport-layer security specialism — certifies that your agent correctly verifies incoming RFC 9421 HTTP Signatures on mutating AdCP operations.

**If you run this behind OAuth or combine it with idempotency,** also read [§ Composing OAuth, signing, and idempotency](#composing-oauth-signing-and-idempotency) for middleware mount order, 401 disambiguation (Bearer vs Signature challenge), and how the verified signing `keyid` threads into the idempotency principal.

The specialism yaml still carries `status: preview`, but the conformance grader shipped. Phases are `capability_discovery`, `positive_vectors`, `negative_vectors`. Test vectors live at `compliance/cache/latest/test-vectors/request-signing/`; the test kit is `test-kits/signed-requests-runner.yaml`.

**Grading model.** The runner constructs signed HTTP requests per each vector and sends them to your agent. Your verifier's responses are compared against the vector's `expected_outcome`:

- **Positive vectors** must produce a non-4xx response — the agent accepted the signed request.
- **Negative vectors** must produce `401` with `WWW-Authenticate: Signature error="<code>"`, where `<code>` matches the vector's `expected_outcome.error_code` byte-for-byte.

The `WWW-Authenticate` header is the grading surface — return the right error code there, not just any 401.

**Prerequisites.** Claim this specialism only if:

1. `get_adcp_capabilities` advertises `request_signing.supported: true` along with the full `VerifierCapability` (`required_for`, `supported_for`, `covers_content_digest`).
2. Your JWKS accepts the runner's test keypairs (`test-ed25519-2026`, `test-es256-2026`) as a registered test counterparty with `adcp_use: "request-signing"`.
3. For negative vectors `016` (replayed nonce), `017` (revoked key), `020` (per-keyid cap), your verifier is pre-configured per `signed-requests-runner.yaml` — the runner cannot set that state from outside. Missing prerequisites grade as **FAIL**, not SKIP.

**Use the SDK's server verifier.** Don't write signature parsing or canonicalization yourself — `@adcp/client/signing/server` ships the full pipeline and produces the right `WWW-Authenticate` error codes.

```typescript
import {
  verifyRequestSignature,        // low-level verifier
  createExpressVerifier,         // Express middleware — emits the 401 + WWW-Authenticate
  InMemoryReplayStore,
  InMemoryRevocationStore,
  StaticJwksResolver,
  RequestSignatureError,
  type VerifierCapability,
} from '@adcp/client/signing/server';

// Policy that ships in your get_adcp_capabilities response:
const capability: VerifierCapability = {
  supported: true,
  required_for: ['create_media_buy', 'update_media_buy', 'acquire_rights'],
  supported_for: ['sync_creatives', 'sync_audiences', 'sync_accounts'],
  covers_content_digest: 'required',
  agent_url: 'https://seller.example.com/mcp',
  per_keyid_request_rate_limit: 60,   // vector 020 targets this — match the per-keyid cap in test-kits/signed-requests-runner.yaml
};

const jwks = new StaticJwksResolver({
  // Test counterparty keys — load from compliance/cache/latest/test-vectors/request-signing/keys.json:
  'test-ed25519-2026': { /* public JWK */ },
  'test-es256-2026':   { /* public JWK */ },
  'test-revoked-2026': { /* public JWK — still present, but marked revoked below */ },
});

const revocationStore = new InMemoryRevocationStore();
// Vector 017 requires this keyid to be revoked before the runner sends its signed request:
await revocationStore.insert('test-revoked-2026', { revoked_at: new Date().toISOString() });

const verifier = createExpressVerifier({
  capability,
  jwks,
  replayStore: new InMemoryReplayStore(),
  revocationStore,
  operationFor: (req) => req.body?.method ?? req.path,
});

// MOUNT ORDER MATTERS. The verifier needs the raw request body to compute
// content-digest — mount it BEFORE express.json() or any other body parser.
// If a parser has already consumed the stream, covers_content_digest silently fails.
app.use('/mcp', verifier);          // raw body available here
app.use(express.json());            // parses for downstream handlers
```

**Advertise your policy in `get_adcp_capabilities`.** Put your `VerifierCapability` under `capabilities.request_signing`. Client SDKs fetch this on first call, cache it for 300s, and use it to decide whether to sign outbound calls. If you don't advertise, the grader skips you (and so do auto-signing clients). If you advertise without actually verifying, negative vectors will fail.

**Don't claim unless tested.** Before claiming, run the grader against a local instance that has the test kit pre-wired (`test-revoked-2026` revoked, per-keyid cap set to match the test kit):

```bash
npx tsx agent.ts &
npx @adcp/client storyboard run http://localhost:3001/mcp signed_requests --json
```

Every negative vector must return the exact `expected_outcome.error_code` in `WWW-Authenticate: Signature error="<code>"`. A non-claiming agent is not graded against this specialism.

## Reference

- `docs/guides/BUILD-AN-AGENT.md` — createAdcpServer patterns, async tools, state persistence
- `docs/llms.txt` — full protocol reference
- `docs/TYPE-SUMMARY.md` — curated type signatures
- `storyboards/media_buy_seller.yaml` — full buyer interaction sequence
- `examples/error-compliant-server.ts` — seller with error handling
- `src/lib/server/create-adcp-server.ts` — framework source (for TypeScript autocomplete exploration)
