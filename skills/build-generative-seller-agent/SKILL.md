---
name: build-generative-seller-agent
description: Use when building an AdCP generative seller — an AI ad network, generative DSP, or platform that sells inventory AND generates creatives from briefs.
---

# Build a Generative Seller Agent

## Overview

A generative seller does everything a standard seller does (products, media buys, delivery) plus generates creatives from briefs. The buyer sends a creative brief instead of uploading pre-built assets. Your platform resolves the brand identity, generates the creative, and serves it.

A generative seller that sells programmatic inventory MUST also accept standard IAB formats (display images, VAST tags, HTML banners). The generative capability is additive — buyers who already have creatives need to upload them directly.

## When to Use

- User wants to build a generative DSP or AI ad network
- User's platform both sells inventory and creates/generates creatives
- User mentions "creative from brief", "AI-generated ads", or "generative"

**Not this skill:**

- Standard seller (no creative generation) → `skills/build-seller-agent/`
- Standalone creative agent (renders but doesn't sell) → creative agent
- Signals/audience data → `skills/build-signals-agent/`

## Specialisms This Skill Covers

A generative seller inherits every sales specialism it supports (usually `sales-non-guaranteed`, optionally `sales-catalog-driven`) **plus** `creative-generative`. Declare all three in your `get_adcp_capabilities` response so buyers can filter correctly.

| Specialism             | Status            | Delta                                                                                                                                                                                                                      |
| ---------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `creative-generative`  | stable            | Generate creatives from `message` + `brand.domain`; honor `quality: draft\|production`; support refinement. See the `build-creative-agent` skill's `§ creative-generative` section for the full `build_creative` contract. |
| `sales-non-guaranteed` | stable            | Standard seller baseline with `bid_price` and `update_media_buy`. See `build-seller-agent` `§ sales-non-guaranteed`.                                                                                                       |
| `sales-catalog-driven` | stable (optional) | If you ingest catalogs for dynamic creative generation, see `build-retail-media-agent`.                                                                                                                                    |

## Protocol-Wide Requirements

Every production seller — generative or otherwise — must wire these regardless of specialism. See `skills/build-seller-agent/SKILL.md` for the full treatment; minimum viable pointers:

- **`idempotency_key`** on every mutating request (`create_media_buy`, `sync_creatives`, `build_creative`, `sync_catalogs`). Wire `createIdempotencyStore({ backend, ttlSeconds })` into `createAdcpServer({ idempotency })` — framework handles replay.
- **Authentication** (`serve({ authenticate: verifyApiKey(...)/verifyBearer(...) })`). A non-authenticated agent fails the `security_baseline` universal storyboard.
- **Signature-header transparency**: even if you don't claim `signed-requests`, don't reject requests that carry `Signature-Input`/`Signature` headers.

## Before Writing Code

Determine these things. Ask the user — don't guess.

### 1. What kind of platform?

- **AI ad network** — sells inventory across publishers, generates creatives from briefs
- **Generative DSP** — programmatic buying + AI creative generation
- **Retail media with creative** — retail inventory + dynamic ad generation from catalogs

### 2. Products and pricing

Same as standard seller. Each product needs: `product_id`, `name`, `description`, `publisher_properties`, `format_ids`, `delivery_type`, `pricing_options`, `reporting_capabilities`. See [`docs/TYPE-SUMMARY.md`](../../docs/TYPE-SUMMARY.md) for full field details and `PricingOption` variants.

### 3. Generative formats

What creative formats does your platform generate?

- **Display** — generated static images (300x250, 728x90, etc.)
- **Video** — generated video ads (15s, 30s pre-roll)
- **HTML** — generated interactive/rich media

Each generative format needs a brief asset slot. Standard formats need traditional asset slots (image, video, VAST).

### 4. What inputs does the brief accept?

At minimum: `name`, `objective`, `tone`, `messaging` (headline, cta, key_messages).
Optional: `audience`, `territory`, `compliance` (required_disclosures, prohibited_claims).

### 5. Brand resolution

The buyer's brand domain should be resolvable. If the brand domain is invalid, reject the creative — don't generate with unknown brand identity.

Brands should be registered dynamically through `sync_accounts` — when a buyer syncs an account with a `brand.domain`, treat that domain as resolvable. Do not hardcode a brand allowlist. Storyboards use fictional brand domains with the `.example` TLD (e.g., `acmeoutdoor.example`) from `storyboards/fictional-entities.yaml`, so a hardcoded list will fail validation.

## Tools and Required Response Shapes

> **Before writing any handler's return statement, fetch [`docs/llms.txt`](../../docs/llms.txt) and grep for `#### \`<tool_name>\``(e.g.`#### \`build_creative\``) to read the exact required + optional field list.** The schema-derived contract lives there; this skill covers patterns, gotchas, and domain-specific examples. Strict response validation is on by default in dev — it will tell you the exact field path if you drift, so write the obvious thing and trust the contract.
>
> **Cross-cutting pitfalls matrix runs keep catching:**
>
> - `capabilities.specialisms` is `string[]` of enum ids (e.g. `['creative-generative']`), NOT `[{id, version}]` objects.
> - `build_creative` response is `{ creative_manifest: { format_id, assets } }` — NOT `{ creative_id, status, quality, preview_url }`. Those are `sync_creatives` fields; don't leak them in.
> - Each asset in `creative_manifest.assets` requires an `asset_type` discriminator — use the typed factories (`imageAsset({...})`, `videoAsset({...})`, `htmlAsset({...})`, `urlAsset({...})`) instead of writing the literal; discriminator is injected for you.
> - `preview_creative` renders have the same pattern: use `urlRender({...})` / `htmlRender({...})` / `bothRender({...})` — they inject `output_format` and enforce the matching `preview_url` / `preview_html` at the type level.
> - `get_media_buy_delivery` requires **top-level `currency: string`** (ISO 4217).

Everything from the standard seller skill applies. The delta is in `list_creative_formats` and `sync_creatives`.

**`get_adcp_capabilities`** — auto-generated by `createAdcpServer` from registered handlers. Do not implement manually.

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

```
productsResponse({
  products: [{
    product_id: 'prod-1',
    name: 'AI Display Network',
    description: 'AI-generated display ads across premium publishers',
    publisher_properties: [{ publisher_domain: 'example.com', selection_type: 'all' }],
    format_ids: [{ agent_url: 'https://your-agent.example/mcp', id: 'display_300x250_generative' }],
    delivery_type: 'non_guaranteed',
    pricing_options: [{
      pricing_option_id: 'cpm-standard',
      pricing_model: 'cpm',
      fixed_price: 15.00,
      currency: 'USD',
    }],
    reporting_capabilities: DEFAULT_REPORTING_CAPABILITIES,  // from @adcp/client/server — stays in sync with schema
  }],
  sandbox: true,
})
```

Import: `import { DEFAULT_REPORTING_CAPABILITIES } from '@adcp/client/server';`. Hand-rolling `reporting_capabilities: { ... }` on every product is the biggest source of schema-drift failures — the constant stays in sync with the spec.

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

Return BOTH generative and standard formats:

```
listCreativeFormatsResponse({
  formats: [
    // Generative format — accepts brief input
    {
      format_id: { agent_url: string, id: 'display_300x250_generative' },
      name: 'Generated Display 300x250',
      description: 'AI-generated display ad from creative brief',
      renders: [{ role: 'primary', dimensions: { width: 300, height: 250 } }],  // role + dimensions (oneOf)
      assets: [{
        item_type: 'individual',
        asset_id: 'brief',
        asset_type: 'brief',
        required: true,
        description: 'Creative brief with messaging and brand guidelines',
      }],
    },
    // Standard format — accepts pre-built assets
    {
      format_id: { agent_url: string, id: 'display_300x250' },
      name: 'Display 300x250',
      description: 'Standard IAB display banner',
      renders: [{ role: 'primary', dimensions: { width: 300, height: 250 } }],  // role + dimensions (oneOf)
      assets: [{
        item_type: 'individual',
        asset_id: 'image',
        asset_type: 'image',
        required: true,
        accepted_media_types: ['image/jpeg', 'image/png'],
      }],
    },
  ],
})
```

**`sync_creatives`** — `SyncCreativesRequestSchema.shape`

Handle both brief-based and standard creatives:

```
syncCreativesResponse({
  creatives: [{
    creative_id: string,              // echo from request
    action: 'created' | 'updated',    // required
    preview_url: string,              // optional — URL to preview generative creative
  }],
})
```

For invalid brand domains, return failure:

```
syncCreativesResponse({
  creatives: [{
    creative_id: string,
    action: 'failed',
    errors: [{ code: 'INVALID_BRAND', message: 'Brand domain not found: nonexistent-brand.example' }],
  }],
})
```

**`get_media_buys`** — `GetMediaBuysRequestSchema.shape`

```
getMediaBuysResponse({
  media_buys: [{
    media_buy_id: string,
    status: 'active' | 'pending_start' | ...,
    currency: 'USD',
    packages: [{ package_id: string }],
  }]
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

`createAdcpServer` auto-echoes the request's `context` into every response — **do not set `context` yourself in your handler return values.** The framework injects it post-handler only when the field isn't already present.

**Crucial:** `context` is schema-typed as an object. If your handler hand-sets a string or narrative description, validation fails with `/context: must be object` and the framework does not overwrite. Leave the field out entirely.

Some schemas also define an `ext` field for vendor-namespaced extensions. If your request schema includes `ext`, accept it without error. Tools with explicit `ext` support: `sync_governance`, `provide_performance_feedback`.

## Compliance Testing (Optional)

Add `registerTestController` so the comply framework can deterministically test your state machines. One function call — the SDK handles request parsing, status validation, and response formatting.

```
import { registerTestController, TestControllerError } from '@adcp/client';
import type { TestControllerStore } from '@adcp/client';

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

Declare `compliance_testing` in `supported_protocols` in your `get_adcp_capabilities` response. Only implement the store methods for scenarios your agent supports — unimplemented methods are excluded from `list_scenarios` automatically.

Validate with: `adcp storyboard run <agent> deterministic_testing --json`

## SDK Quick Reference

| SDK piece                               | Usage                                                                   |
| --------------------------------------- | ----------------------------------------------------------------------- |
| `createAdcpServer(config)`              | Create server with domain-grouped handlers, auto-generated capabilities |
| `serve(() => createAdcpServer(config))` | Start HTTP server on `:3001/mcp`                                        |
| `ctx.store`                             | State persistence — `get/put/patch/delete/list` domain objects          |
| `adcpError(code, { message })`          | Structured error                                                        |
| `registerTestController(server, store)` | Add `comply_test_controller` for deterministic testing                  |

Response builders (`productsResponse`, `mediaBuyResponse`, `syncCreativesResponse`, etc.) are auto-applied by the framework. Handlers return raw data objects — the framework wraps them.

`get_adcp_capabilities` is auto-generated from registered handlers. Do not register it manually.

Import: `import { createAdcpServer, serve, adcpError } from '@adcp/client';`

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

1. Single `.ts` file — all tools in one file
2. Use `createAdcpServer` with `mediaBuy` and `creative` domain groups
3. Handlers return raw data objects — the framework auto-applies response builders
4. `get_adcp_capabilities` is auto-generated from registered handlers — do not register it manually
5. Use `ctx.store` for state persistence (accounts, media buys, creatives)
6. Set `sandbox: true` on all mock/demo responses

Creative tools (`listCreativeFormats`, `syncCreatives`, `buildCreative`, `listCreatives`, `getCreativeDelivery`) belong in the `creative` domain group. Media buy tools (`getProducts`, `createMediaBuy`, `getMediaBuys`, `getMediaBuyDelivery`) belong in `mediaBuy`.

```typescript
import { randomUUID } from 'node:crypto';
import { createAdcpServer, serve, adcpError } from '@adcp/client';
import { createIdempotencyStore, memoryBackend } from '@adcp/client/server';

// Idempotency — required for v3. Generative creation is expensive and
// non-deterministic, so caching successful responses per key is critical:
// a buyer retry must replay the same ad, not re-burn model tokens.
const idempotency = createIdempotencyStore({
  backend: memoryBackend(), // pgBackend(pool) for production
  ttlSeconds: 86400, // 24 hours (spec bounds: 1h–7d)
});

serve(() =>
  createAdcpServer({
    name: 'My Generative Seller',
    version: '1.0.0',
    idempotency,

    // Principal scoping. MUST never return undefined — or every mutating
    // request rejects as SERVICE_UNAVAILABLE.
    resolveSessionKey: () => 'default-principal',

    mediaBuy: {
      getProducts: async (params, ctx) => ({ products: PRODUCTS, sandbox: true }),
      createMediaBuy: async (params, ctx) => {
        const buy = {
          media_buy_id: `mb_${randomUUID()}`,
          status: 'pending_creatives' as const,
          packages:
            params.packages?.map(p => ({
              package_id: `pkg_${randomUUID()}`,
              product_id: p.product_id,
              pricing_option_id: p.pricing_option_id,
              budget: p.budget,
            })) ?? [],
        };
        await ctx.store.put('media_buys', buy.media_buy_id, buy);
        return buy;
      },
      // ... updateMediaBuy, getMediaBuys, getMediaBuyDelivery
    },

    creative: {
      listCreativeFormats: async () => ({ formats: FORMATS }),
      syncCreatives: async (params, ctx) => {
        // Generative formats take a `brief`; standard formats carry assets.
        // Check the format_id to decide processing. Framework idempotency
        // ensures a retry of the same (key, payload) replays the prior
        // response instead of re-running generation.
        const results = params.creatives.map(c => ({
          creative_id: c.creative_id ?? `cr_${randomUUID()}`,
          action: 'created' as const,
        }));
        return { creatives: results };
      },
      // ... buildCreative, listCreatives, getCreativeDelivery
    },
  })
);
```

The skill contains everything you need. Do not read additional docs before writing code.

### Key implementation detail: sync_creatives handler

The sync_creatives handler must check the format_id to decide how to process:

- If the format is generative (e.g., id contains "generative"): read the `brief` asset from the creative's assets
- If the format is standard: read the image/video/html asset
- Validate the brand domain from the account — return `action: 'failed'` with an error if invalid
- Return `action: 'created'` for both generative and standard creatives

## Idempotency

AdCP v3 requires an `idempotency_key` on every mutating request — for generative sellers that's `create_media_buy`, `update_media_buy`, and `sync_creatives` (including brief-based creatives whose generation is expensive and must not double-bill). Idempotency is already wired in the Implementation example above. The framework then handles:

- Missing/malformed key → `INVALID_REQUEST` (spec pattern `^[A-Za-z0-9_.:-]{16,255}$`)
- JCS-canonicalized payload hashing with same-key-different-payload → `IDEMPOTENCY_CONFLICT` (no payload leaked in the error body)
- Past-TTL replay → `IDEMPOTENCY_EXPIRED` (±60s clock-skew tolerance)
- Cache hits replay the cached envelope with `replayed: true` injected
- `adcp.idempotency.replay_ttl_seconds` auto-declared on `get_adcp_capabilities`
- Only successful responses cache — a failed generation re-executes on retry without locking the key
- Atomic claim so concurrent retries with the same key don't all race to generate

Scoping is per-principal via `resolveSessionKey` (override with `resolveIdempotencyPrincipal`). `ttlSeconds` must be 3600–604800 — out of range throws at construction.

## Protecting your agent

**An AdCP agent that accepts unauthenticated requests is non-compliant** (see `security_baseline` in the universal storyboard bundle). Ask the operator: "API key, OAuth, or both?" — then wire one of these into `serve()`.

```typescript
import { serve, verifyApiKey, verifyBearer, anyOf } from '@adcp/client';

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

**Full validation checklist:** [docs/guides/VALIDATE-YOUR-AGENT.md](../../docs/guides/VALIDATE-YOUR-AGENT.md). Generative-seller-specific commands:

```bash
# Boot
npx tsx agent.ts &

# Happy paths — sells inventory AND generates creatives
npx @adcp/client storyboard run http://localhost:3001/mcp creative_generative/seller --auth $TOKEN
npx @adcp/client storyboard run http://localhost:3001/mcp media_buy_seller --auth $TOKEN

# Cross-cutting obligations
npx @adcp/client storyboard run http://localhost:3001/mcp \
  --storyboards security_baseline,idempotency,schema_validation,error_compliance --auth $TOKEN

# Rejection-surface fuzz
npx @adcp/client fuzz http://localhost:3001/mcp \
  --tools get_products,list_creative_formats,get_creative_features,preview_creative \
  --auth-token $TOKEN
```

Common failure decoder:

- `response_schema` → response doesn't match Zod schema
- `field_present` → required field missing (often `creative_manifest` on generated output)
- `mcp_error` → check tool registration; generative formats must be in `list_creative_formats`

**Keep iterating until all steps pass.** Can't bind ports? `npm run compliance:skill-matrix -- --filter generative` runs an isolated end-to-end test.

## Common Mistakes

| Mistake                                                  | Fix                                                                                                                                                      |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Only generative formats, no standard IAB                 | Programmatic sellers must accept pre-built assets too                                                                                                    |
| Ignore brand domain on brief sync                        | Validate brand, reject if unresolvable                                                                                                                   |
| Same handler for brief and standard creatives            | Check format_id to decide processing path                                                                                                                |
| format_ids in products don't match list_creative_formats | Buyers echo format_ids from products into sync_creatives — if your validation rejects your own format_ids, the buyer can't fulfill creative requirements |
| Manually registering `get_adcp_capabilities`             | Auto-generated by `createAdcpServer` — do not register it                                                                                                |
| Using `server.tool()` instead of domain groups           | Use `createAdcpServer({ mediaBuy: {...}, creative: {...} })`                                                                                             |
| `sandbox: false` on mock data                            | Buyers may treat mock data as real                                                                                                                       |
| Dropping `context` from responses                        | Echo `args.context` back unchanged in every response — buyers use it for correlation                                                                     |

## Reference

- `storyboards/media_buy_generative_seller.yaml` — full generative seller storyboard
- `storyboards/media_buy_seller.yaml` — base seller storyboard (for standard seller parts)
- `skills/build-seller-agent/SKILL.md` — standard seller skill (generative extends this)
- `docs/guides/BUILD-AN-AGENT.md` — SDK patterns
- `docs/TYPE-SUMMARY.md` — curated type signatures
- `docs/llms.txt` — full protocol reference
