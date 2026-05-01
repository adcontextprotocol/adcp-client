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

- **`idempotency_key`** on every mutating request (`create_media_buy`, `sync_creatives`, `build_creative`, `sync_catalogs`). Pass `createIdempotencyStore({ backend, ttlSeconds })` to `createAdcpServerFromPlatform(platform, { idempotency })` — framework handles replay.
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
> - **Declare `capabilities.specialisms: ['creative-generative'] as const` on the `DecisioningPlatform` you pass to `createAdcpServerFromPlatform`.** The value is `string[]` of enum ids (not `[{id, version}]`). Agents that don't declare their specialism fail the grader with "No applicable tracks found" even if every tool works — tracks are gated on the specialism claim.
> - `build_creative` response is `{ creative_manifest: { format_id, assets } }` — NOT `{ creative_id, status, quality, preview_url }`. Those are `sync_creatives` fields; don't leak them in.
> - Each asset in `creative_manifest.assets` requires an `asset_type` discriminator — use the typed factories (`imageAsset({...})`, `videoAsset({...})`, `htmlAsset({...})`, `urlAsset({...})`) instead of writing the literal; discriminator is injected for you.
> - `preview_creative` renders have the same pattern: use `urlRender({...})` / `htmlRender({...})` / `bothRender({...})` — they inject `output_format` and enforce the matching `preview_url` / `preview_html` at the type level.
> - `get_media_buy_delivery` requires **top-level `currency: string`** (ISO 4217), and each `media_buy_deliveries[i]/by_package[j]` row requires `package_id`, `spend`, `pricing_model`, `rate`, `currency` (billing quintet).
> - `reporting_period/start` and `/end` are ISO 8601 **date-time** strings (`new Date().toISOString()`), not date-only — `'2026-04-21'` fails GA validation.
> - `videoAsset({...})` requires `width` + `height` in GA (previously optional). Omitting them fails validation at `/creative_manifest/assets/<name>/width` when the asset is constructed from video content.
> - `get_media_buys /media_buys[i]` rows require `media_buy_id`, `status`, `currency`, `total_budget`, `packages`. Persist `currency` + `total_budget` from the `create_media_buy` request so they can be echoed back verbatim.
> - `sync_accounts` response: each `accounts[]` row requires `action: 'created' | 'updated' | 'unchanged' | 'failed'` (same shape as `sync_creatives`). Omitting `action` fails schema validation and blocks every downstream stateful step.

Everything from the standard seller skill applies. The delta is in `list_creative_formats` and `sync_creatives`.

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
    reporting_capabilities: DEFAULT_REPORTING_CAPABILITIES,  // from @adcp/sdk/server — stays in sync with schema
  }],
  sandbox: true,
})
```

Import: `import { DEFAULT_REPORTING_CAPABILITIES } from '@adcp/sdk/server';`. Hand-rolling `reporting_capabilities: { ... }` on every product is the biggest source of schema-drift failures — the constant stays in sync with the spec.

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

#### Format requirements as generation constraints

Generative sellers consume `requirements` as the input spec the generator must satisfy. When you declare a format, its requirements are the contract for what your generator will produce — so the field names and units have to match the spec exactly or downstream validators will reject what you generate even when the bytes are correct.

Four constraints that recur on every generative format declaration:

1. **Image** uses `formats: ('jpg' | 'png' | 'gif' | 'webp' | 'svg' | 'avif' | 'tiff' | 'pdf' | 'eps')[]` — not `file_types`. Image `aspect_ratio` matches `^\d+(\.\d+)?:\d+(\.\d+)?$` (decimals allowed, e.g. `1.91:1`), single-valued.
2. **Video** uses `containers: ('mp4' | 'webm' | 'mov' | 'avi' | 'mkv')[]` — not `file_types`. Video `aspect_ratio` is integer-only `^\d+:\d+$`. Durations are `min_duration_ms` / `max_duration_ms`.
3. **Audio** uses `formats: ('mp3' | 'aac' | 'wav' | 'ogg' | 'flac')[]`. Durations are `min_duration_ms` / `max_duration_ms`.
4. **`min_count` / `max_count`** live on the `repeatable_group` wrapper for formats that generate multiple items (carousel packs, product collections). Never on an individual asset.

Use the typed slot builders to declare format slots — the `requirements` object is strictly typed per `asset_type`, so misnamed fields and wrong units fail at compile time:

```typescript
import {
  briefAssetSlot,
  imageAssetSlot,
  videoAssetSlot,
  repeatableGroup,
  imageGroupAsset,
  textGroupAsset,
} from '@adcp/sdk';

// Generative display format — brief in, spec-compliant image out
{
  format_id: { agent_url, id: 'display_300x250_generative' },
  name: 'Generated Display 300x250',
  renders: [{ role: 'primary', dimensions: { width: 300, height: 250 } }],
  assets: [
    briefAssetSlot({ asset_id: 'brief', required: true }),
  ],
}

// Generative carousel pack — generator produces 3–6 image+headline cards
{
  format_id: { agent_url, id: 'carousel_generative' },
  name: 'Generated Product Carousel',
  renders: [{ role: 'primary', dimensions: { width: 1080, height: 1080 } }],
  assets: [
    briefAssetSlot({ asset_id: 'brief', required: true }),
    repeatableGroup({
      asset_group_id: 'cards',
      required: true,
      min_count: 3,
      max_count: 6,
      selection_mode: 'sequential',
      assets: [
        imageGroupAsset({ asset_id: 'card_image', required: true, requirements: { aspect_ratio: '1:1', formats: ['jpg', 'png'] } }),
        textGroupAsset({ asset_id: 'card_headline', required: true, requirements: { max_length: 40 } }),
      ],
    }),
  ],
}
```

Reading requirements on the generation path — discriminate by `asset_type` to narrow to the correct requirements shape, then feed it to the generator:

```typescript
import type { IndividualAssetSlot } from '@adcp/sdk';

function constraintsFor(slot: IndividualAssetSlot) {
  switch (slot.asset_type) {
    case 'image':
      return slot.requirements; // ImageAssetRequirements — formats, aspect_ratio, max_file_size_kb
    case 'video':
      return slot.requirements; // VideoAssetRequirements — containers, *_duration_ms, aspect_ratio
    case 'audio':
      return slot.requirements; // AudioAssetRequirements — formats, *_duration_ms
    default:
      return undefined;
  }
}
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

The framework auto-echoes the request's `context` into every response — **do not set `context` yourself in your handler return values.** It's injected post-handler only when the field isn't already present.

**Crucial:** `context` is schema-typed as an object. If your handler hand-sets a string or narrative description, validation fails with `/context: must be object` and the framework does not overwrite. Leave the field out entirely.

Some schemas also define an `ext` field for vendor-namespaced extensions. If your request schema includes `ext`, accept it without error. Tools with explicit `ext` support: `sync_governance`, `provide_performance_feedback`.

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

`registerTestController` auto-emits the `capabilities.compliance_testing.scenarios` block per AdCP 3.0 — no manual `supported_protocols` edit. Only implement the store methods for scenarios your agent supports; unimplemented methods are excluded from `list_scenarios` automatically.

Validate with: `adcp storyboard run <agent> deterministic_testing --json`

## SDK Quick Reference

| SDK piece                               | Usage                                                                   |
| --------------------------------------- | ----------------------------------------------------------------------- |
| `createAdcpServerFromPlatform(platform, opts)` | Create server from a typed `DecisioningPlatform` — compile-time specialism enforcement, auto-generated capabilities, ctx_metadata round-trip |
| `createAdcpServer(config)` *(legacy)*          | v5 handler-bag entry. Mid-migration / escape-hatch only; reach via `@adcp/sdk/server/legacy/v5`                                              |
| `serve(() => createAdcpServerFromPlatform(platform, opts))` | Start HTTP server on `:3001/mcp`                                                                       |
| `ctx.store`                             | State persistence — `get/put/patch/delete/list` domain objects          |
| `adcpError(code, { message })`          | Structured error                                                        |
| `registerTestController(server, store)` | Add `comply_test_controller` for deterministic testing                  |

Response builders (`productsResponse`, `mediaBuyResponse`, `syncCreativesResponse`, etc.) are auto-applied by the framework. Handlers return raw data objects — the framework wraps them.

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
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist"
  }
}
```

`skipLibCheck: true` avoids false-positive errors from transitive `.d.ts` files (e.g., `@opentelemetry/api`).

## Implementation

1. Single `.ts` file — all tools in one file
2. Use `createAdcpServerFromPlatform` with `sales` and `creative` typed sub-platforms on a `DecisioningPlatform` class
3. Handlers return raw data objects — the framework auto-applies response builders
4. `get_adcp_capabilities` is auto-generated from registered handlers — do not register it manually
5. Use `ctx.store` for state persistence (accounts, media buys, creatives)
6. Set `sandbox: true` on all mock/demo responses

Creative tools (`listCreativeFormats`, `syncCreatives`, `buildCreative`, `listCreatives`, `getCreativeDelivery`) belong in the `creative` domain group. Media buy tools (`getProducts`, `createMediaBuy`, `getMediaBuys`, `getMediaBuyDelivery`) belong in `mediaBuy`.

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
  type CreativeBuilderPlatform,
  type AccountStore,
} from '@adcp/sdk/server';

// Idempotency — required for v3. Generative creation is expensive and
// non-deterministic, so caching successful responses per key is critical:
// a buyer retry must replay the same ad, not re-burn model tokens.
const idempotency = createIdempotencyStore({
  backend: memoryBackend(), // pgBackend(pool) for production
  ttlSeconds: 86400, // 24 hours (spec bounds: 1h–7d)
});

class MyGenerativeSeller implements DecisioningPlatform {
  capabilities = {
    specialisms: ['sales-non-guaranteed', 'creative-generative'] as const,
    creative_agents: [{ agent_url: 'https://example.com/creative/mcp' }],
    pricingModels: ['cpm'] as const,
    channels: ['display'] as const,
    config: {},
  };

  accounts: AccountStore = {
    resolve: async ref => ({
      id: 'account_id' in ref ? ref.account_id : 'gen_acc_1',
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
    listCreativeFormats: async () => ({ formats: FORMATS }),
    // syncCreatives: generative formats take a `brief`; standard formats
    // carry assets. Check format_id to decide processing. Framework
    // idempotency ensures a retry of the same (key, payload) replays the
    // prior response instead of re-running generation.
    syncCreatives: async (creatives, ctx) =>
      creatives.map(c => ({
        creative_id: (c as { creative_id?: string }).creative_id ?? `cr_${randomUUID()}`,
        action: 'created' as const,
      })),
  };

  creative: CreativeBuilderPlatform = {
    buildCreative: async (req, ctx) => {
      // Generative path — read brief, call your model, return assets.
      // Framework auto-stores the build for refine/lookup via ctx_metadata.
      return { creative_manifest: { /* generated assets */ } };
    },
    previewCreative: async (req, ctx) => {
      return { preview_url: '...' };
    },
  };
}

const platform = new MyGenerativeSeller();

serve(() =>
  createAdcpServerFromPlatform(platform, {
    name: 'My Generative Seller',
    version: '1.0.0',
    idempotency,
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

**Full validation checklist:** [docs/guides/VALIDATE-YOUR-AGENT.md](../../docs/guides/VALIDATE-YOUR-AGENT.md). Generative-seller-specific commands:

```bash
# Boot
npx tsx agent.ts &

# Happy paths — sells inventory AND generates creatives
npx @adcp/sdk@latest storyboard run http://localhost:3001/mcp creative_generative/seller --auth $TOKEN
npx @adcp/sdk@latest storyboard run http://localhost:3001/mcp media_buy_seller --auth $TOKEN

# Cross-cutting obligations
npx @adcp/sdk@latest storyboard run http://localhost:3001/mcp \
  --storyboards security_baseline,idempotency,schema_validation,error_compliance --auth $TOKEN

# Rejection-surface fuzz
npx @adcp/sdk@latest fuzz http://localhost:3001/mcp \
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
| Manually registering `get_adcp_capabilities`             | Auto-generated by `createAdcpServerFromPlatform` from your typed `DecisioningPlatform` — do not register it                                              |
| Using `server.tool()` instead of typed sub-platforms     | Implement `sales: SalesPlatform` + `creative: CreativeBuilderPlatform` on a `DecisioningPlatform` class                                                  |
| Calling `createAdcpServer` directly in new code          | Reach for `createAdcpServerFromPlatform`; `createAdcpServer` lives at `@adcp/sdk/server/legacy/v5` for mid-migration / escape-hatch only                 |
| `sandbox: false` on mock data                            | Buyers may treat mock data as real                                                                                                                       |
| Dropping `context` from responses                        | Echo `args.context` back unchanged in every response — buyers use it for correlation                                                                     |

## Reference

- `storyboards/media_buy_generative_seller.yaml` — full generative seller storyboard
- `storyboards/media_buy_seller.yaml` — base seller storyboard (for standard seller parts)
- `skills/build-seller-agent/SKILL.md` — standard seller skill (generative extends this)
- `docs/guides/BUILD-AN-AGENT.md` — SDK patterns
- `docs/TYPE-SUMMARY.md` — curated type signatures
- `docs/llms.txt` — full protocol reference
