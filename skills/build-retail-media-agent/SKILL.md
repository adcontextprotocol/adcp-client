---
name: build-retail-media-agent
description: Use when building an AdCP retail media network agent — a platform that sells on-site placements, supports product catalogs, tracks conversions, and reports performance.
---

# Build a Retail Media Agent

## Overview

A retail media agent sells advertising on a retailer's properties (sponsored products, homepage banners, search results). It extends the standard seller with catalog sync, event tracking, and performance feedback. Buyers sync product catalogs, the platform renders dynamic ads from the feed, and conversion data flows back for optimization.

## When to Use

- User wants to build a retail media network, commerce media platform, or sponsored products agent
- User mentions catalogs, product feeds, conversion tracking, or performance feedback
- User references `sync_catalogs`, `log_event`, or `provide_performance_feedback`

**Not this skill:**

- Standard seller without catalogs → `skills/build-seller-agent/`
- Generative seller (AI creative from briefs) → `skills/build-generative-seller-agent/`
- Signals/audience data → `skills/build-signals-agent/`

**Often claimed alongside:** [`audience-sync`](../build-seller-agent/SKILL.md) (first-party audience push), [`creative-template`](../build-creative-agent/SKILL.md) (dynamic-creative rendering from catalog). Together these form the canonical retail-media bundle — see [Common multi-specialism bundles](../../examples/README.md#common-multi-specialism-bundles).

Despite the name, **this skill also covers non-retail catalog-driven sales** — restaurants, travel, local commerce, any platform where the ad unit is rendered from a feed of products/listings/menu items. The compliance storyboard `media_buy_catalog_creative` uses a steakhouse protagonist, not a retailer.

## Specialisms This Skill Covers

| Specialism             | Status  | Delta                                                                                                                                                                                                                                                                      |
| ---------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sales-catalog-driven` | stable  | Products declare `supports_catalog: true` and `supports_conversion_tracking: true`; `create_media_buy` accepts `packages[].catalogs[]`; `log_event` response includes `match_quality`. Applies to retail, restaurants, travel, and any platform rendering ads from a feed. |
| `sales-retail-media`   | preview | v3.1 placeholder. Ship the `sales-catalog-driven` baseline plus retail-specific surface encoding (search vs PDP vs homepage vs offsite vs in-store) in `publisher_properties` / `format_ids`                                                                               |

Attribution linkage (`log_event.content_ids` → catalog `item_id` → `media_buy_id`) is deliberately out-of-scope for AdCP 3.0 — the storyboard accepts counter-only responses. Closed-loop attribution + ROAS reporting land in 3.1.

## Protocol-Wide Requirements

Full treatment in `skills/build-seller-agent/SKILL.md` §Protocol-Wide Requirements and §Composing — a retail-media agent inherits all the baseline-seller requirements. Minimum viable pointers:

- **`idempotency_key`** on every mutating request (`create_media_buy`, `update_media_buy`, `sync_accounts`, `sync_creatives`, `sync_catalogs`, `sync_event_sources`, `log_event`, `provide_performance_feedback`). Pass `createIdempotencyStore` to `createAdcpServerFromPlatform(platform, { idempotency })`.
- **Authentication** via `serve({ authenticate })`. Unauthenticated agents fail the universal `security_baseline` storyboard.
- **Signature-header transparency**: accept `Signature-Input`/`Signature` headers even if you don't claim `signed-requests`.

## Before Writing Code

Same domain decisions as the seller skill, plus:

### 1. Products and pricing

Same as seller. Each product needs: `product_id`, `name`, `description`, `publisher_properties`, `format_ids`, `delivery_type`, `pricing_options`, `reporting_capabilities`. See [`docs/TYPE-SUMMARY.md`](../../docs/TYPE-SUMMARY.md) for full field details.

### 2. Catalog support

What product catalogs does the platform accept?

- Feed format: JSON, CSV, XML
- What fields: product_id, title, price, image_url, category
- How does the catalog connect to ad rendering?

### 3. Event tracking

What conversion events does the platform track?

- Purchase, add_to_cart, page_view, search
- How are events attributed to catalog items?

### 4. Performance feedback

Does the buyer send performance metrics back for optimization?

## Tools and Required Response Shapes

> **Before writing any handler's return statement, fetch [`docs/llms.txt`](../../docs/llms.txt) and grep for `#### \`<tool_name>\``(e.g.`#### \`sync_catalogs\``) to read the exact required + optional field list.** The schema-derived contract lives there; this skill covers patterns, gotchas, and domain-specific examples. Strict response validation is on by default in dev — it will tell you the exact field path if you drift, so write the obvious thing and trust the contract.
>
> **Cross-cutting pitfalls matrix runs keep catching:**
>
> - **Declare `capabilities.specialisms: ['sales-catalog-driven'] as const` on the `DecisioningPlatform` you pass to `createAdcpServerFromPlatform`.** Value is `string[]` of enum ids (not `[{id, version}]`). Agents that don't declare their specialism fail the grader with "No applicable tracks found" even if every tool works — tracks are gated on the specialism claim.
> - `get_media_buy_delivery` response requires **top-level `currency: string`** (ISO 4217).
> - `get_media_buy_delivery /media_buy_deliveries[i]/by_package[j]` rows require `package_id`, `spend`, `pricing_model`, `rate`, `currency`. Mock handlers that return `{package_id, impressions, clicks}` fail validation — include the billing quintet on every package row.
> - `get_media_buy_delivery /reporting_period/start` and `/end` are ISO 8601 **date-time** strings (`new Date().toISOString()`), not date-only. `'2026-04-21'` fails the GA format check.
> - `get_media_buys /media_buys[i]` rows require `media_buy_id`, `status`, `currency`, `total_budget`, `packages`. Persist `currency` + `total_budget` from `create_media_buy` so they can be echoed back verbatim.
> - `sync_accounts` response: each `accounts[]` row requires `action: 'created' | 'updated' | 'unchanged' | 'failed'` (same shape as `sync_creatives`). Omitting `action` fails schema validation and blocks every downstream stateful step.

All standard seller tools apply (see `skills/build-seller-agent/SKILL.md`). The additional tools:

**`get_adcp_capabilities`** — auto-generated by `createAdcpServerFromPlatform` from the typed `DecisioningPlatform` you provide. Do not implement manually.

**`sync_accounts`** — `SyncAccountsRequestSchema.shape`

```
taskToolResponse({
  accounts: [{
    account_id: string,
    brand: { domain: string },
    operator: string,
    action: 'created' | 'updated',
    status: 'active' | 'pending_approval',
  }]
})
```

**`get_products`** — `GetProductsRequestSchema.shape`

```typescript
import { DEFAULT_REPORTING_CAPABILITIES } from '@adcp/sdk/server';

productsResponse({
  products: [
    {
      product_id: 'sponsored-home',
      name: 'Sponsored Products — Home',
      description: 'On-site sponsored placements.',
      publisher_properties: [{ publisher_domain: 'retailer.example', selection_type: 'all' }],
      format_ids: [{ agent_url: 'https://retailer.example/mcp', id: 'display_300x250' }],
      delivery_type: 'non_guaranteed',
      pricing_options: [{ pricing_option_id: 'cpc-std', pricing_model: 'cpc', fixed_price: 0.75, currency: 'USD' }],
      reporting_capabilities: DEFAULT_REPORTING_CAPABILITIES, // required — never hand-roll
      supports_catalog: true,
      supports_conversion_tracking: true,
    },
  ],
  sandbox: true,
});
```

Hand-rolling `reporting_capabilities: { ... }` is the biggest drift tax — the spec adds required fields (most recently `date_range_support`) and literals go stale. Always use `DEFAULT_REPORTING_CAPABILITIES`.

**`create_media_buy`** — `CreateMediaBuyRequestSchema.shape`

```
// revision, confirmed_at, and valid_actions are auto-set:
mediaBuyResponse({
  media_buy_id: string,
  status: 'pending_creatives',
  packages: [{ package_id, product_id, pricing_option_id, budget }],
})
```

**`list_creative_formats`** — `ListCreativeFormatsRequestSchema.shape`

```
listCreativeFormatsResponse({
  formats: [{
    format_id: { agent_url: string, id: string },
    name: string,
    renders: [{                                    // required — at least one render
      role: 'primary',                             // required
      dimensions: { width: 300, height: 250 },     // oneOf: dimensions (object) OR parameters_from_format_id: true
    }],
  }]
})
```

**`sync_catalogs`** — `SyncCatalogsRequestSchema.shape`

Accept product catalog feeds. Return per-catalog status with item counts.

```
taskToolResponse({
  catalogs: [{
    catalog_id: string,        // required — echo from request
    action: 'created' | 'updated',  // required
    item_count: number,        // total items in catalog
    items_approved: number,    // items that passed validation
  }],
  sandbox: true,
})
```

**`sync_event_sources`** — `SyncEventSourcesRequestSchema.shape`

Register event tracking integrations.

```
taskToolResponse({
  event_sources: [{
    event_source_id: string,   // required — echo from request
    action: 'created' | 'updated',  // required
  }],
  sandbox: true,
})
```

**`log_event`** — `LogEventRequestSchema.shape`

Accept conversion events.

```
taskToolResponse({
  events_received: number,     // required — how many events in the request
  events_processed: number,    // required — how many were successfully processed
  sandbox: true,
})
```

**`provide_performance_feedback`** — `ProvidePerformanceFeedbackRequestSchema.shape`

Accept performance metrics from the buyer.

```
performanceFeedbackResponse({
  success: true,
  sandbox: true,
})
```

**`get_media_buy_delivery`** — `GetMediaBuyDeliveryRequestSchema.shape`

```
deliveryResponse({
  reporting_period: { start: string, end: string },
  media_buy_deliveries: [{
    media_buy_id: string,
    status: 'active',
    totals: { impressions: number, spend: number },
    by_package: [],
  }]
})
```

### Context and Ext Passthrough

The framework auto-echoes the request's `context` into every response — **do not set `context` yourself in your handler return values.** It's injected post-handler only when the field isn't already present.

**Crucial:** `context` is schema-typed as an object. If your handler hand-sets a string or narrative description, validation fails with `/context: must be object` and the framework does not overwrite. Leave the field out entirely.

Some schemas also define an `ext` field for vendor-namespaced extensions. If your request schema includes `ext`, accept it without error. Tools with explicit `ext` support: `sync_event_sources`, `provide_performance_feedback`.

## Compliance Testing (Optional)

Add `registerTestController` so the comply framework can deterministically test your state machines. One function call — the SDK handles request parsing, status validation, and response formatting.

```
import { registerTestController, TestControllerError } from '@adcp/sdk';
import type { TestControllerStore } from '@adcp/sdk';

const store: TestControllerStore = {
  async forceAccountStatus(accountId, status) {
    const prev = accounts.get(accountId);
    if (!prev) throw new TestControllerError('NOT_FOUND', `Account ${accountId} not found`);
    accounts.set(accountId, status);
    return { success: true, previous_state: prev, current_state: status };
  },
  async forceMediaBuyStatus(mediaBuyId, status) { /* same pattern */ },
  async forceCreativeStatus(creativeId, status) { /* same pattern */ },
  // simulateDelivery, simulateBudgetSpend — implement as needed
};

registerTestController(server, store);
```

`registerTestController` auto-emits the `capabilities.compliance_testing.scenarios` block per AdCP 3.0 — no manual `supported_protocols` edit. Only implement the store methods for scenarios your agent supports; unimplemented methods are excluded from `list_scenarios` automatically. For typed domain state (catalog entries with inventory, audience assignments), see `examples/seller-test-controller.ts`.

Validate with: `adcp storyboard run <agent> deterministic_testing --json`

## SDK Quick Reference

| SDK piece                                                   | Usage                                                                                                                                        |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `createAdcpServerFromPlatform(platform, opts)`              | Create server from a typed `DecisioningPlatform` — compile-time specialism enforcement, ctx_metadata round-trip, auto-generated capabilities |
| `createAdcpServer(config)` _(legacy)_                       | v5 handler-bag entry. Mid-migration / escape-hatch only; reach via `@adcp/sdk/server/legacy/v5`                                              |
| `serve(() => createAdcpServerFromPlatform(platform, opts))` | Start HTTP server on `:3001/mcp`                                                                                                             |
| `ctx.store`                                                 | State persistence — `get/put/patch/delete/list` domain objects                                                                               |
| `adcpError(code, { message })`                              | Structured error                                                                                                                             |
| `registerTestController(server, store)`                     | Add `comply_test_controller` for deterministic testing                                                                                       |

Response builders (`productsResponse`, `mediaBuyResponse`, `deliveryResponse`, etc.) are auto-applied by the framework. Handlers return raw data objects — the framework wraps them.

`get_adcp_capabilities` is auto-generated from registered handlers. Do not register it manually.

Import: `import { createAdcpServerFromPlatform, serve, adcpError } from '@adcp/sdk/server';`

## Setup

```bash
npm init -y
npm install @adcp/sdk
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

1. Single `.ts` file — all tools in one file
2. Use `createAdcpServerFromPlatform` with `sales` (incl. `syncCatalogs`/`syncEventSources`/`logEvent`/`syncAudiences`) on a typed `DecisioningPlatform` class
3. Handlers return raw data objects — the framework auto-applies response builders
4. `get_adcp_capabilities` is auto-generated from registered handlers — do not register it manually
5. Use `ctx.store` for state persistence (accounts, media buys, catalogs)
6. Set `sandbox: true` on all mock/demo responses

Catalog/event/audience methods (`syncCatalogs`, `syncEventSources`, `logEvent`, `syncAudiences`, `providePerformanceFeedback`) live on the `sales: SalesPlatform` field — they're optional methods on the same interface as `getProducts`/`createMediaBuy`/etc. (See `src/lib/server/decisioning/specialisms/sales.ts`.)

```typescript
import { randomUUID } from 'node:crypto';
import {
  createAdcpServerFromPlatform,
  serve,
  adcpError,
  createIdempotencyStore,
  memoryBackend,
  type DecisioningPlatform,
  type SalesPlatform,
  type AccountStore,
} from '@adcp/sdk/server';

// Idempotency — required for v3. Retail media has many mutating tools:
// create/update_media_buy, sync_creatives, sync_catalogs, sync_event_sources,
// sync_audiences, log_event. Without this, the framework logs a non-
// compliance error at startup.
const idempotency = createIdempotencyStore({
  backend: memoryBackend(), // pgBackend(pool) for production
  ttlSeconds: 86400, // 24 hours (spec bounds: 1h–7d)
});

class MyRetailMedia implements DecisioningPlatform {
  capabilities = {
    specialisms: ['sales-non-guaranteed', 'sales-catalog-driven'] as const,
    pricingModels: ['cpm'] as const,
    channels: ['display'] as const,
    config: {},
  };

  accounts: AccountStore = {
    resolve: async ref => ({
      id: 'account_id' in ref ? ref.account_id : 'rm_acc_1',
      operator: 'me',
      ctx_metadata: {},
    }),
    upsert: async () => ({ ok: true, items: [] }),
    list: async () => ({ items: [], nextCursor: null }),
  };

  sales: SalesPlatform = {
    getProducts: async (req, ctx) => ({ products: PRODUCTS, sandbox: true }),
    createMediaBuy: async (req, ctx) => {
      const buy = {
        media_buy_id: `mb_${randomUUID()}`,
        status: 'pending_creatives' as const,
        packages:
          req.packages?.map(p => ({
            package_id: `pkg_${randomUUID()}`,
            product_id: p.product_id,
            pricing_option_id: p.pricing_option_id,
            budget: p.budget,
          })) ?? [],
      };
      await ctx.store.put('media_buys', buy.media_buy_id, buy);
      return buy;
    },
    updateMediaBuy: async (id, patch, ctx) => ({ media_buy_id: id, status: 'active' }),
    getMediaBuys: async () => ({ media_buys: [] }),
    getMediaBuyDelivery: async () => ({ deliveries: [] }),
    syncCreatives: async () => [],
    listCreativeFormats: async () => ({ formats: [] }),

    // Catalog-driven specialism methods — all optional on SalesPlatform.
    syncCatalogs: async (req, ctx) => ({
      catalogs: req.catalogs.map(c => ({
        catalog_id: c.catalog_id,
        action: 'created' as const,
        item_count: c.items?.length ?? 0,
        items_approved: c.items?.length ?? 0,
      })),
    }),
    syncEventSources: async (req, ctx) => ({
      event_sources: req.event_sources.map(s => ({
        event_source_id: s.event_source_id,
        action: 'created' as const,
      })),
    }),
    logEvent: async (req, ctx) => ({
      events_received: req.events?.length ?? 0,
      events_processed: req.events?.length ?? 0,
    }),
    providePerformanceFeedback: async (req, ctx) => ({ feedback_id: `fb_${randomUUID()}` }),
  };
}

const platform = new MyRetailMedia();

serve(() =>
  createAdcpServerFromPlatform(platform, {
    name: 'My Retail Media Agent',
    version: '1.0.0',
    idempotency,
  })
);
```

The skill contains everything you need. Do not read additional docs before writing code.

## Idempotency

AdCP v3 requires an `idempotency_key` on every mutating request — for retail media that's `create_media_buy`, `update_media_buy`, `sync_creatives`, `sync_event_sources`, `sync_catalogs`, `sync_audiences`, and `log_event`. Idempotency is already wired in the Implementation example above. The framework then handles:

- Missing/malformed key → `INVALID_REQUEST` (spec pattern `^[A-Za-z0-9_.:-]{16,255}$`)
- JCS-canonicalized payload hashing with same-key-different-payload → `IDEMPOTENCY_CONFLICT` (no payload leaked in the error body)
- Past-TTL replay → `IDEMPOTENCY_EXPIRED` (±60s clock-skew tolerance)
- Cache hits replay the cached envelope with `replayed: true` injected
- `adcp.idempotency.replay_ttl_seconds` auto-declared on `get_adcp_capabilities`
- Only successful responses cache — failed catalog syncs or event ingests re-execute on retry
- Atomic claim so concurrent retries with the same key don't all race

Scoping is per-principal via `resolveSessionKey` (override with `resolveIdempotencyPrincipal`). `ttlSeconds` must be 3600–604800 — out of range throws at construction.

## Protecting your agent

**An AdCP agent that accepts unauthenticated requests is non-compliant** (see `security_baseline` in the universal storyboard bundle). Ask the operator: "API key, OAuth, or both?" — then wire one of these into `serve()`.

```typescript
import { serve } from '@adcp/sdk';
import { verifyApiKey, verifyBearer, anyOf } from '@adcp/sdk/server';

// API key — simplest, good for B2B integrations
serve(createAgent, {
  authenticate: verifyApiKey({
    verify: async token => {
      const row = await db.api_keys.findUnique({ where: { token } });
      return row ? { principal: row.account_id } : null;
    },
  }),
});

// OAuth — best when buyers authenticate as themselves
const AGENT_URL = 'https://my-agent.example.com/mcp';
serve(createAgent, {
  publicUrl: AGENT_URL, // canonical RFC 8707 audience — also served as `resource` in protected-resource metadata
  authenticate: verifyBearer({
    jwksUri: 'https://auth.example.com/.well-known/jwks.json',
    issuer: 'https://auth.example.com',
    audience: AGENT_URL, // MUST equal publicUrl
  }),
  protectedResource: { authorization_servers: ['https://auth.example.com'] },
});

// Both
serve(createAgent, {
  publicUrl: AGENT_URL,
  authenticate: anyOf(verifyApiKey({ verify: lookupKey }), verifyBearer({ jwksUri, issuer, audience: AGENT_URL })),
  protectedResource: { authorization_servers: [issuer] },
});
```

The framework produces RFC 6750-compliant `WWW-Authenticate: Bearer` 401s on failure, and serves `/.well-known/oauth-protected-resource<mountPath>` with `publicUrl` as the `resource` field so buyers get tokens bound to the right audience. The default JWT allowlist is asymmetric-only (RS*/ES*/PS\*/EdDSA) to prevent algorithm-confusion attacks.

## Validate Locally

**Full validation checklist:** [docs/guides/VALIDATE-YOUR-AGENT.md](../../docs/guides/VALIDATE-YOUR-AGENT.md). Retail-media-specific commands:

```bash
# Boot
npx tsx agent.ts &

# Happy path — catalog-driven creative + conversion tracking
npx @adcp/sdk@latest storyboard run http://localhost:3001/mcp sales_catalog_driven --auth $TOKEN

# Cross-cutting obligations
npx @adcp/sdk@latest storyboard run http://localhost:3001/mcp \
  --storyboards security_baseline,idempotency,schema_validation,error_compliance --auth $TOKEN

# Rejection-surface fuzz — includes the catalog surface
npx @adcp/sdk@latest fuzz http://localhost:3001/mcp \
  --tools get_products,list_creative_formats \
  --auth-token $TOKEN
```

**Substitution verification** (required for catalog-driven macro URLs):

Wire `SubstitutionEncoder.encode_for_url_context()` into your tracker-URL macro expansion. The storyboard `sales_catalog_driven` asserts that emitted preview URLs pass `SubstitutionObserver.assert_rfc3986_safe()` — unencoded values (especially those containing `javascript:`, reserved chars, or nested macros) fail with `substitution_encoding_violation`. See [VALIDATE-YOUR-AGENT.md § Substitution](../../docs/guides/VALIDATE-YOUR-AGENT.md#substitution-verification-catalog-driven-sellers) for the API.

Common failure decoder:

- `substitution_encoding_violation` → switch from `encodeURIComponent` to `SubstitutionEncoder.encode_for_url_context`
- `substitution_binding_missing` → seller stripped the macro entirely; return the rendered URL with the macro expanded, not deleted
- `log_event` missing `events_received` / `events_processed` → required counters on the response

**Keep iterating until all steps pass.** Can't bind ports? `npm run compliance:skill-matrix -- --filter retail-media` runs an isolated end-to-end test.

## Common Mistakes

| Mistake                                                  | Fix                                                                                                                                                      |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Manually registering `get_adcp_capabilities`             | Auto-generated by `createAdcpServer` — do not register it                                                                                                |
| Putting event tracking handlers in `mediaBuy`            | `syncEventSources`, `logEvent`, `syncCatalogs`, `syncAudiences` belong in `eventTracking`                                                                |
| Using `server.tool()` instead of domain groups           | Use `createAdcpServer({ mediaBuy: {...}, eventTracking: {...} })`                                                                                        |
| sync_catalogs missing `item_count` / `items_approved`    | Optional but recommended for catalog validation results                                                                                                  |
| format_ids in products don't match list_creative_formats | Buyers echo format_ids from products into sync_creatives — if your validation rejects your own format_ids, the buyer can't fulfill creative requirements |
| log_event missing `events_received` / `events_processed` | Required counters                                                                                                                                        |
| `sandbox: false` on mock data                            | Buyers may treat mock data as real                                                                                                                       |
| Dropping `context` from responses                        | Echo `args.context` back unchanged in every response — buyers use it for correlation                                                                     |

## Reference

- `skills/build-seller-agent/SKILL.md` — base seller skill (retail media extends this)
- `storyboards/media_buy_catalog_creative.yaml` — full catalog creative storyboard
- `docs/guides/BUILD-AN-AGENT.md` — SDK patterns
- `docs/TYPE-SUMMARY.md` — curated type signatures
- `docs/llms.txt` — full protocol reference
