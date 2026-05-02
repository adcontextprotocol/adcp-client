---
name: build-creative-agent
description: Use when building an AdCP creative agent — an ad server, creative management platform, or any system that accepts, stores, transforms, and serves ad creatives.
---

# Build a Creative Agent

## Overview

A creative agent manages the creative lifecycle: accepts assets from buyers, stores them in a library, builds serving tags, and renders previews. Unlike a generative seller (which also sells inventory), a creative agent is a standalone creative platform — it manages creatives but doesn't sell media.

> **Common shape gotchas:** `PreviewCreativeResponse` is a three-way discriminated union (`single` | `batch` | `variant`); `BuildCreativeReturn` has 4 valid shapes (framework auto-wraps bare manifests); `VASTAsset` requires `delivery_type` (`'inline'` or `'redirect'`) before `content`/`vast_url`. See [SHAPE-GOTCHAS.md](../SHAPE-GOTCHAS.md) for the patterns adopters consistently get wrong on first pass — schema validators catch these at runtime; type checkers don't.

## When to Use

- User wants to build an ad server, creative management platform, or creative rendering service
- User mentions `build_creative`, `preview_creative`, `sync_creatives`, or `list_creatives`
- User references creative formats, VAST tags, serving tags, or creative libraries

**Not this skill:**

- Selling inventory + generating creatives → `skills/build-generative-seller-agent/`
- Selling inventory (no creative management) → `skills/build-seller-agent/`
- Serving audience segments → `skills/build-signals-agent/`

## Specialisms This Skill Covers

Creative specialisms are three distinct archetypes with materially different tool contracts. Pick the one that matches your platform — do not try to make one handler cover all three.

| Specialism            | Archetype                           | `build_creative` behavior                                                                                                                       | `sync_creatives` behavior                                                          | See                                                      |
| --------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `creative-ad-server`  | Stateful library, pricing + billing | Look up in library by `target_format_id`; return VAST/tag output with macro placeholders; price the output (`pricing_option_id`, `vendor_cost`) | Accept assets into the library; support `include_pricing=true` on `list_creatives` | [§ creative-ad-server](#specialism-creative-ad-server)   |
| `creative-template`   | Stateless transform                 | Build from inline `creative_manifest` in the request; no `ctx.store` lookup; support `target_format_ids` (plural) for multi-format              | Not used — agents in this specialism are stateless                                 | [§ creative-template](#specialism-creative-template)     |
| `creative-generative` | Brief-to-creative generation        | Generate assets from `message` + `brand.domain`; honor `quality: draft\|production`; support refinement (re-send manifest in)                   | Not used — output is ephemeral; buyer syncs to the seller separately               | [§ creative-generative](#specialism-creative-generative) |

The `interaction_model` in each specialism's `index.yaml` is the forcing function: `stateful_ad_server`, `stateless_transform`, `stateless_generate`. Decide which one matches your business, then follow the archetype section below.

## Protocol-Wide Requirements

Full treatment in `skills/build-seller-agent/SKILL.md` §Protocol-Wide Requirements and §Composing. Minimum viable pointers for a creative agent:

- **`idempotency_key`** on every mutating request (`sync_creatives`, `build_creative`, `report_usage`, any `sync_*` you implement). Pass `createIdempotencyStore` to `createAdcpServerFromPlatform(platform, { idempotency })`.
- **Authentication** via `serve({ authenticate })` with `verifyApiKey`/`verifyBearer` from `@adcp/sdk/server`. Unauthenticated agents fail the universal `security_baseline` storyboard.
- **Signature-header transparency**: accept requests with `Signature-Input`/`Signature` headers even if you don't claim `signed-requests`.

## Webhooks (for async review pipelines)

Creative review flows are naturally async — `sync_creatives` may return `pending_review` with a task envelope, and your review pipeline emits completion webhooks when the creative is approved, rejected, or transitions to a new state. `build_creative` for the ad-server archetype emits `report_usage` completion webhooks. Use `ctx.emitWebhook` — don't hand-roll `fetch` with HMAC signing.

Pass `webhooks: { signerKey }` to `createAdcpServerFromPlatform(platform, { webhooks })` and call `ctx.emitWebhook({ url, payload, operation_id })` from any handler. The framework handles RFC 9421 signing, stable `idempotency_key` across retries, backoff + terminal error handling. Full pattern in [`skills/build-seller-agent/SKILL.md`](../build-seller-agent/SKILL.md) § Webhooks.

**`operation_id` rules** (the top at-least-once-delivery bug): stable across retries. `creative_review.${creative_id}` or `report_usage.${report_batch_id}` — NOT a fresh UUID per retry.

## Before Writing Code

Determine these things. Ask the user — don't guess.

### 1. What kind of creative platform?

- **Ad server** (Innovid, Flashtalking, CM360) — specialism `creative-ad-server`. Stateful library, builds serving tags (VAST, display tags), tracks delivery, reconciles billing.
- **Creative management platform** (Celtra) — specialism `creative-template`. Stateless transformation from inline manifest, template rendering across formats.
- **Generative creative agent** — specialism `creative-generative`. Takes a brief + brand reference, generates finished creatives from scratch (no inventory sold — that's `build-generative-seller-agent`).
- **Publisher creative service** — accepts buyer assets, validates against publisher specs, renders previews. Usually pairs with `build-seller-agent` and doesn't claim a creative specialism on its own.

### 2. What formats?

Get specific formats the platform supports. Common ones:

- **Display**: `display_300x250`, `display_728x90`, `display_160x600`
- **Video**: `video_30s`, `vast_30s`, `video_15s`
- **Native**: `native_content` (image + headline + description)
- **Rich media**: `html5_300x250` (interactive HTML)

Each format needs: dimensions, accepted asset types (image, video, html, text), mime types.

### 3. What operations?

- **Sync** — accept and store creatives from buyers (always needed)
- **List** — query the creative library with filtering (recommended)
- **Preview** — render a visual preview of a creative (recommended)
- **Build** — produce serving tags (VAST, display tags, etc.) from stored creatives (recommended)

### 4. Review pipeline?

What happens when a creative is synced:

- **Instant accept** — creative passes validation, immediately available
- **Pending review** — human or automated review before going live
- **Rejection** — creative fails validation (wrong dimensions, prohibited content)

## Tools and Required Response Shapes

> **Before writing any handler's return statement, fetch [`docs/llms.txt`](../../docs/llms.txt) and grep for `#### \`<tool_name>\``(e.g.`#### \`build_creative\``) to read the exact required + optional field list.** The schema-derived contract lives there; this skill covers patterns, gotchas, and domain-specific examples. Strict response validation is on by default in dev — it will tell you the exact field path if you drift, so write the obvious thing and trust the contract.
>
> **Cross-cutting pitfalls matrix runs keep catching:**
>
> - **Declare `capabilities.specialisms: ['creative-ad-server'] as const` (or `'creative-template'` / `'creative-generative'`) on the `DecisioningPlatform` you pass to `createAdcpServerFromPlatform`.** Value is `string[]` of enum ids (not `[{id, version}]`). Agents that don't declare their specialism fail the grader with "No applicable tracks found" even if every tool works — tracks are gated on the specialism claim.
> - **`list_creative_formats` response — each `Format` MUST have strict-shape `renders[]` and `assets[]`** (matrix v2 PR #1207 keeps catching this).
>   - `renders[i]` requires `role` (string) PLUS exactly one of `dimensions: { width, height }` (object — NOT `{ width, height }` inline at the render root) OR `parameters_from_format_id: true`.
>   - `assets[i]` requires the **discriminator quartet**: `item_type: 'individual' as const` + `asset_id` + `asset_type` (`'image'`/`'video'`/`'audio'`/`'text'`/`'click_url'`/`'html'`) + `required: boolean`. Missing any of these fails strict validation with `must match exactly one schema in oneOf`.
>
>   ```ts
>   // ✗ WRONG — passes lenient mode but fails strict (the actual mistake matrix v2 catches)
>   { format_id, renders: [{ width: 300, height: 250 }],
>     assets: [{ asset_id: 'image', required: true }] }
>
>   // ✓ RIGHT — passes strict
>   { format_id,
>     renders: [{ role: 'primary', dimensions: { width: 300, height: 250 } }],
>     assets: [{
>       item_type: 'individual' as const,
>       asset_id: 'image',
>       asset_type: 'image',
>       required: true,
>       accepted_media_types: ['image/jpeg', 'image/png'],
>     }] }
>   ```
> - `build_creative` response is `{ creative_manifest: { format_id, assets } }` (single) or `{ creative_manifests: [...] }` (multi). Platform-native fields at the top level (`tag_url`, `creative_id`, `media_type`) are **invalid** — use `buildCreativeResponse({ creative_manifest })` / `buildCreativeMultiResponse({ creative_manifests })` from `@adcp/sdk/server` to lock the shape at compile time.
> - Each asset in `creative_manifest.assets` requires an `asset_type` discriminator. Use the typed factories (`imageAsset`, `videoAsset`, `audioAsset`, `htmlAsset`, `urlAsset`, `textAsset`) so the discriminator is injected for you; a plain `{ serving_tag: { content: '<vast>...' } }` fails validation.
> - `preview_creative` renders have the same pattern — each `renders[]` entry is a oneOf on `output_format`. Use `urlRender({...})`, `htmlRender({...})`, or `bothRender({...})` to inject the discriminator and require the matching `preview_url` / `preview_html` field automatically. **Even a single-preview response must use the top-level `previews[]` array, not a bare object:**
>   ```ts
>   // ✗ WRONG — bare preview object fails schema validation:
>   { preview_id: 'p1', renders: [...] }
>   // ✓ RIGHT — always wrap in previews[]:
>   { previews: [{ preview_id: 'p1', renders: [...] }] }
>   ```
> - **`VASTAsset`** inside `creative_manifest.assets[]` requires a `delivery_type` discriminator. The redirect-URL field is named `url`, not `vast_url`:
>   ```ts
>   // ✗ WRONG — missing delivery_type:
>   { asset_type: 'vast', content: '<vast>...</vast>' }
>   // ✗ WRONG — redirect field name is `url`, not `vast_url`:
>   { asset_type: 'vast', delivery_type: 'url', vast_url: 'https://...' }
>   // ✓ RIGHT — redirect:
>   { asset_type: 'vast', delivery_type: 'url', url: 'https://vast.example.com/tag' }
>   // ✓ RIGHT — inline:
>   { asset_type: 'vast', delivery_type: 'inline', content: '<VAST version="4.0">...</VAST>' }
>   ```
> - `get_creative_delivery` requires **top-level `currency: string`** (ISO 4217), in addition to any per-row spend fields. `reporting_period/start` and `/end` are ISO 8601 **date-time** strings (`new Date().toISOString()`), not date-only.
> - `videoAsset({...})` requires `width` + `height` per GA (previously optional). Set realistic pixel values — `{ url, width: 1920, height: 1080 }`.
> - `list_creatives` response — each `creatives[i].pricing_options[j]` uses the **vendor-pricing discriminator**, which is different from products' `pricing_model`. Field name is `model` (not `pricing_model`), valid values are `cpm` / `percent_of_media` / `flat_fee` / `per_unit` / `custom`. Each model has its own required fields: `cpm` needs `{model, cpm, currency}`; `flat_fee` needs `{model, amount, period, currency}` (`period` is required — the schema rejects `flat_fee` without it); `percent_of_media` needs `{model, percent, currency}`; `per_unit` needs `{model, unit, unit_price, currency}`. If you echo pricing_options from a seed fixture, normalize the shape — storyboard fixtures sometimes carry abbreviated shapes that fail validation on the way out.

**Handler bindings — read the Contract column entry before writing each return:**

| Tool                    | Handler                        | Contract (field list)                                                 | Gotchas                                                                                                                                                                                                                              |
| ----------------------- | ------------------------------ | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `get_adcp_capabilities` | auto-generated                 | n/a                                                                   | Do not register manually.                                                                                                                                                                                                            |
| `list_creative_formats` | `creative.listCreativeFormats` | [`#list_creative_formats`](../../docs/llms.txt#list_creative_formats) | Each `renders[]` entry MUST have `role` + exactly one of `dimensions` (object) OR `parameters_from_format_id: true` — `{width, height}` shorthand fails. Each `assets[]` entry MUST have `item_type: 'individual' as const` + `asset_id` + `asset_type` (image/video/audio/text/click_url/html) + `required: boolean`. See the strict-shape callout above the table. |
| `sync_creatives`        | `creative.syncCreatives`       | [`#sync_creatives`](../../docs/llms.txt#sync_creatives)               | Echo `creative_id`; `action` ∈ `created \| updated \| unchanged \| failed \| deleted`.                                                                                                                                               |
| `list_creatives`        | `creative.listCreatives`       | [`#list_creatives`](../../docs/llms.txt#list_creatives)               | Honor `args.filters?.format_ids` when present. `created_date` + `updated_date` on each row are required ISO timestamps.                                                                                                              |
| `preview_creative`      | `creative.previewCreative`     | [`#preview_creative`](../../docs/llms.txt#preview_creative)           | `renders[].output_format` is a discriminator — use `urlRender({...})`, `htmlRender({...})`, or `bothRender({...})` so the discriminator is injected and the required `preview_url`/`preview_html` field is enforced at compile time. |
| `build_creative`        | `creative.buildCreative`       | [`#build_creative`](../../docs/llms.txt#build_creative)               | Check `args.target_format_id` → library lookup; fall back to `args.creative_id`. Response requires `creative_manifest.format_id` + `creative_manifest.assets`.                                                                       |

Asset values use type-specific shapes, not a generic `asset_type` discriminator:

- Image: `{ url: string, width: number, height: number, format: string }`
- Video: `{ url: string, duration_ms: number, format: string }`
- Audio: `{ url: string, container_format: string, codec: string, duration_ms: number, channels?: string, sampling_rate_hz?: number }`
- HTML: `{ content: string }` (not `{ html: string }`)
- Text: `{ content: string }` (not `{ text: string }` — the field is `content`, same as HTML)

### Context and Ext Passthrough

The framework auto-echoes the request's `context` into every response from typed sub-platform handlers — **do not set `context` yourself in your handler return values.** It's injected post-handler only when the field isn't already present.

**Crucial:** `context` is schema-typed as an object. If your handler hand-sets a string or narrative description, validation fails with `/context: must be object` and the framework does not overwrite. Leave the field out entirely.

Some schemas also define an `ext` field for vendor-namespaced extensions. If your request schema includes `ext`, accept it without error. Tools with explicit `ext` support: `get_creative_delivery`, `get_creative_features`.

## SDK Quick Reference

| SDK piece                                               | Usage                                                            |
| ------------------------------------------------------- | ---------------------------------------------------------------- |
| `createAdcpServerFromPlatform(platform, opts)`          | Create server from a typed `DecisioningPlatform` — compile-time specialism enforcement, auto-capabilities |
| `createAdcpServer(config)` *(legacy)*                   | v5 handler-bag entry. Mid-migration / escape-hatch only; reach via `@adcp/sdk/server/legacy/v5`            |
| `serve(() => createAdcpServerFromPlatform(platform, opts))` | Start HTTP server on `:3001/mcp`                                                                       |
| `creative: { listCreativeFormats, syncCreatives, ... }` | Domain group — register handlers by name                         |
| `ctx.store.put(collection, id, data)`                   | Persist state (creative library) across requests                 |
| `ctx.store.get(collection, id)`                         | Retrieve persisted state                                         |
| `ctx.store.list(collection)`                            | List all items in a collection (for `list_creatives`)            |
| `listCreativeFormatsResponse(data)`                     | Auto-applied response builder (don't call manually)              |
| `syncCreativesResponse(data)`                           | Auto-applied response builder (don't call manually)              |
| `listCreativesResponse(data)`                           | Auto-applied response builder (don't call manually)              |
| `buildCreativeResponse(data)`                           | Auto-applied response builder (don't call manually)              |
| `previewCreativeResponse(data)`                         | Auto-applied response builder (don't call manually)              |
| `adcpError(code, { message })`                          | Structured error                                                 |

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
2. Use `createAdcpServerFromPlatform` with `creative: CreativeAdServerPlatform` (or `CreativeBuilderPlatform`) on a `DecisioningPlatform` class — `get_adcp_capabilities` is auto-generated
3. Handlers return raw data objects — response builders are auto-applied
4. Use `ctx.store` for persisting the creative library across requests (InMemoryStateStore by default)
5. Register `preview_creative` manually on the returned server (union schema not in domain group)
6. Set `sandbox: true` on all mock/demo responses
7. Context passthrough is handled by the framework — no need to manually echo `args.context`

```typescript
import {
  createAdcpServerFromPlatform,
  serve,
  adcpError,
  urlRender,
  createIdempotencyStore,
  memoryBackend,
  type DecisioningPlatform,
  type CreativeAdServerPlatform,
  type AccountStore,
} from '@adcp/sdk/server';

const formats = [
  {
    format_id: { agent_url: 'https://creative.example.com/mcp', id: 'display_banner_300x250' },
    name: 'Display Banner 300x250',
    description: 'Standard MRec display unit',
    renders: [
      { role: 'primary', dimensions: { width: 300, height: 250 } }, // role + dimensions (oneOf)
    ],
    assets: [
      {
        item_type: 'individual' as const,
        asset_id: 'image',
        asset_type: 'image',
        required: true,
        accepted_media_types: ['image/png', 'image/jpeg'],
      },
    ],
  },
];

// The plain literal above works, but creative agents declaring richer
// acceptance specs (technical `requirements`, carousel/collection wrappers)
// should use the typed slot builders — see "Format asset slot builders"
// below.

// Idempotency — required for v3 compliance on any agent with mutating
// handlers. `sync_creatives`, `build_creative`, and `calibrate_content`
// are all mutating for creative agents.
const idempotency = createIdempotencyStore({
  backend: memoryBackend(), // pgBackend(pool) for production
  ttlSeconds: 86400, // 24 hours (spec bounds: 1h–7d)
});

class MyCreative implements DecisioningPlatform {
  capabilities = {
    specialisms: ['creative-ad-server'] as const,
    config: {},
  };

  accounts: AccountStore = {
    resolve: async ref => ({
      id: 'account_id' in ref ? ref.account_id : 'cr_acc_1',
      operator: 'me',
      ctx_metadata: {},
    }),
    upsert: async () => ({ ok: true, items: [] }),
    list: async () => ({ items: [], nextCursor: null }),
  };

  creative: CreativeAdServerPlatform = {
    listCreativeFormats: async (params, ctx) => {
        return { formats };
      },

      syncCreatives: async (params, ctx) => {
        const results = [];
        for (const creative of params.creatives) {
          const now = new Date().toISOString();
          const existing = await ctx.store.get('creatives', creative.creative_id);
          await ctx.store.put('creatives', creative.creative_id, {
            ...creative,
            status: 'approved',
            created_date: existing?.created_date ?? now,
            updated_date: now,
          });
          results.push({
            creative_id: creative.creative_id,
            action: existing ? ('updated' as const) : ('created' as const),
          });
        }
        return { creatives: results };
      },

      listCreatives: async (params, ctx) => {
        // `ctx.store.list` returns `{ items, nextCursor? }` — destructure.
        let { items: creatives } = await ctx.store.list('creatives');
        if (params.filters?.format_ids) {
          creatives = creatives.filter(c => params.filters!.format_ids!.some(fid => fid.id === c.format_id?.id));
        }
        return {
          query_summary: { total_matching: creatives.length, returned: creatives.length, filters_applied: [] },
          creatives,
          pagination: { has_more: false },
        };
      },

      buildCreative: async (params, ctx) => {
        // `ctx.store.list` returns `{ items, nextCursor? }` — destructure.
        // Calling `.find`/`.map` on the raw result throws `TypeError` and
        // the dispatcher wraps it as `SERVICE_UNAVAILABLE`.
        const { items: creatives } = await ctx.store.list('creatives');
        const match = params.target_format_id
          ? creatives.find(c => c.format_id?.id === params.target_format_id!.id)
          : params.creative_id
            ? await ctx.store.get('creatives', params.creative_id)
            : null;
        // Return structured errors — don't throw. The dispatcher now unwraps
        // thrown envelopes, but throwing still releases the idempotency claim
        // before the throw is caught. If your handler mutated state before
        // throwing, a retry with the same key re-executes the write. Returning
        // an error envelope has the same claim-release semantics, so the rule
        // holds for both paths: mutate last, or don't mutate at all on error.
        if (!match) return adcpError('CREATIVE_NOT_FOUND', { message: 'No matching creative' });
        return {
          creative_manifest: { format_id: match.format_id, assets: match.assets ?? {} },
          sandbox: true,
        };
      },

    previewCreative: async params => {
      return {
        response_type: 'single',
        previews: [
          {
            preview_id: `prev_${Date.now()}`,
            input: { name: params.creative_manifest?.name ?? 'Preview' },
            renders: [
              urlRender({
                render_id: `r_${Date.now()}`,
                preview_url: 'https://example.com/preview.png',
                role: 'primary',
                dimensions: { width: 300, height: 250 },
              }),
            ],
          },
        ],
        expires_at: new Date(Date.now() + 3600000).toISOString(),
      };
    },
  };
}

const platform = new MyCreative();

serve(() =>
  createAdcpServerFromPlatform(platform, {
    name: 'My Creative Agent',
    version: '1.0.0',
    idempotency,
    // Principal scoping for idempotency. MUST never return undefined —
    // every mutating request would reject as SERVICE_UNAVAILABLE.
    resolveSessionKey: () => 'default-principal',
  })
);
```

### Key implementation detail: creative library

Use `ctx.store` to persist synced creatives. The framework provides `InMemoryStateStore` by default — no need for module-level Maps or external state management.

The `sync_creatives` handler adds/updates entries via `ctx.store.put('creatives', id, data)`. The `list_creatives` handler queries via `ctx.store.list('creatives')` (include `created_date` and `updated_date` in each creative). The `preview_creative` handler previews the `creative_manifest` sent in the request (no library lookup needed). The `build_creative` handler finds a synced creative by `target_format_id` (matching the format), then builds a serving tag from it.

### Format asset slot builders

Ad servers and creative management platforms declare the technical acceptance contract in `Format.assets[]` — what a buyer must submit for a creative to be accepted. The spec's closed enums and field shapes are easy to get slightly wrong in a handwritten literal; strict response validation then rejects the format even when it's structurally close.

Four recurring mistakes:

1. **Image** uses `formats: ('jpg' | 'png' | 'gif' | 'webp' | 'svg' | 'avif' | 'tiff' | 'pdf' | 'eps')[]` — not `file_types`. Image `aspect_ratio` matches `^\d+(\.\d+)?:\d+(\.\d+)?$` (single-valued).
2. **Video** uses `containers: ('mp4' | 'webm' | 'mov' | 'avi' | 'mkv')[]` and `codecs: ('h264' | 'h265' | 'vp8' | 'vp9' | 'av1' | 'prores')[]`. Video `aspect_ratio` is integer-only `^\d+:\d+$`. Durations are `min_duration_ms` / `max_duration_ms`.
3. **Audio** uses `formats: ('mp3' | 'aac' | 'wav' | 'ogg' | 'flac')[]`. Durations are `*_duration_ms`.
4. **`min_count` / `max_count`** live on the `repeatable_group` wrapper. Formats that render multiple items (galleries, story frames, product showcases) declare an `item_type: 'repeatable_group'` slot with `assets[]` inside — never put counts on an individual asset.

Use the typed slot builders when declaring acceptance specs. `requirements` is strictly typed per `asset_type`, so misnamed fields and wrong units fail at compile time:

```typescript
import {
  imageAssetSlot,
  videoAssetSlot,
  repeatableGroup,
  imageGroupAsset,
  textGroupAsset,
} from '@adcp/sdk';

// MRec banner with typed image requirements
{
  format_id: { agent_url: AGENT_URL, id: 'display_banner_300x250' },
  name: 'Display Banner 300x250',
  renders: [{ role: 'primary', dimensions: { width: 300, height: 250 } }],
  assets: [
    imageAssetSlot({
      asset_id: 'image',
      required: true,
      requirements: { formats: ['jpg', 'png', 'webp'], max_file_size_kb: 200 },
    }),
  ],
}

// In-stream video, 6–30s
{
  format_id: { agent_url: AGENT_URL, id: 'video_instream_16x9' },
  name: 'In-Stream Video 16:9',
  renders: [{ role: 'primary', dimensions: { width: 1920, height: 1080 } }],
  assets: [
    videoAssetSlot({
      asset_id: 'video',
      required: true,
      requirements: {
        aspect_ratio: '16:9',
        containers: ['mp4', 'webm'],
        codecs: ['h264', 'h265'],
        min_duration_ms: 6000,
        max_duration_ms: 30000,
      },
    }),
  ],
}

// Gallery format — 3 to 8 image+headline pairs. Counts on the GROUP.
{
  format_id: { agent_url: AGENT_URL, id: 'gallery_1x1' },
  name: 'Image Gallery',
  renders: [{ role: 'primary', dimensions: { width: 1080, height: 1080 } }],
  assets: [
    repeatableGroup({
      asset_group_id: 'cards',
      required: true,
      min_count: 3,
      max_count: 8,
      selection_mode: 'sequential',
      assets: [
        imageGroupAsset({ asset_id: 'card_image', required: true, requirements: { aspect_ratio: '1:1', formats: ['jpg', 'png'] } }),
        textGroupAsset({ asset_id: 'card_headline', required: true, requirements: { max_length: 40 } }),
      ],
    }),
  ],
}
```

Ad servers whose output is a serving-tag (VAST, display tag HTML) declare those via `vastAssetSlot`, `htmlAssetSlot`, or `javascriptAssetSlot` with their respective requirement shapes (`vast_version`, `sandbox`, `module_type`).

## Idempotency

AdCP v3 requires an `idempotency_key` on every mutating request — for creative agents that's `sync_creatives`, `build_creative`, and `calibrate_content`. Idempotency is already wired in the Implementation example above. The framework then handles:

- Missing/malformed key → `INVALID_REQUEST` (spec pattern `^[A-Za-z0-9_.:-]{16,255}$`)
- JCS-canonicalized payload hashing with same-key-different-payload → `IDEMPOTENCY_CONFLICT` (no payload leaked in the error body)
- Past-TTL replay → `IDEMPOTENCY_EXPIRED` (±60s clock-skew tolerance)
- Cache hits replay the cached envelope with `replayed: true` injected
- `adcp.idempotency.replay_ttl_seconds` auto-declared on `get_adcp_capabilities`
- Only successful responses cache — failed renders re-execute on retry
- Atomic claim so concurrent retries with a fresh key don't all race to run

Scoping is per-principal via `resolveSessionKey` (override with `resolveIdempotencyPrincipal` for custom scoping). `ttlSeconds` must be 3600–604800 — out of range throws at construction. If you register mutating handlers without wiring `idempotency`, the framework logs an error at server-creation time.

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

## Deterministic Testing (for `creative_generative/seller` and `deterministic_testing`)

Creative generative sellers — and any creative agent that wants to pass `deterministic_testing` — must expose `comply_test_controller` so the grader can force creative-status transitions deterministically. `createComplyController` handles the scaffolding:

```ts
import { createComplyController } from '@adcp/sdk/testing';

const controller = createComplyController({
  sandboxGate: input => input.auth?.sandbox === true,
  seed: {
    creative: params => creativeRepo.upsert(params.creative_id, params.fixture),
  },
  force: {
    creative_status: params => creativeRepo.transition(params.creative_id, params.status, params.rejection_reason),
  },
});

controller.register(server);
```

`controller.register(server)` auto-emits the `capabilities.compliance_testing.scenarios` block per AdCP 3.0 — don't put `compliance_testing` in `supported_protocols`, that's a spec violation on 3.0. Throw `TestControllerError('INVALID_TRANSITION', msg, currentState)` from the adapter when the state machine disallows the transition — the helper emits the typed error envelope. Omitted adapters auto-return `UNKNOWN_SCENARIO`.

Validate with: `adcp storyboard run <agent> deterministic_testing --auth $TOKEN`.

## Validate Locally

**Full validation checklist:** [docs/guides/VALIDATE-YOUR-AGENT.md](../../docs/guides/VALIDATE-YOUR-AGENT.md). Creative-agent-specific commands:

```bash
# Boot
npx tsx agent.ts &

# Happy path — the archetype you're claiming
npx @adcp/sdk@latest storyboard run http://localhost:3001/mcp creative_ad_server --auth $TOKEN     # stateful
npx @adcp/sdk@latest storyboard run http://localhost:3001/mcp creative_template --auth $TOKEN      # stateless
npx @adcp/sdk@latest storyboard run http://localhost:3001/mcp creative_generative --auth $TOKEN    # brief-to-creative

# Cross-cutting obligations (all creative agents)
npx @adcp/sdk@latest storyboard run http://localhost:3001/mcp \
  --storyboards security_baseline,idempotency,schema_validation,error_compliance --auth $TOKEN

# Rejection-surface fuzz — includes preview_creative (referential, fixture-eligible)
npx @adcp/sdk@latest fuzz http://localhost:3001/mcp \
  --tools list_creative_formats,list_creatives,get_creative_features,preview_creative \
  --fixture creative_ids=cre_a,cre_b \
  --auth-token $TOKEN
```

Common failure decoder:

- `response_schema` on `preview_creative` → the union schema requires manual registration; see § creative-template
- `mcp_error` on creative lifecycle → confirm `sync_creatives` status enum is `approved`/`rejected`/`pending_approval`, not a custom value
- `field_present` on build response → `creative_manifest` must be fully populated, not just `id`

**Keep iterating until all steps pass.** Can't bind ports? `npm run compliance:skill-matrix -- --filter creative` runs an isolated end-to-end test.

## Common Mistakes

| Mistake                                                                | Fix                                                                                                                                 |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Using `createTaskCapableServer` + `server.tool()`                      | Use `createAdcpServerFromPlatform` with a typed `creative: CreativeAdServerPlatform` (or `CreativeBuilderPlatform`) field           |
| Calling `createAdcpServer` directly in new code                        | Reach for `createAdcpServerFromPlatform`; `createAdcpServer` lives at `@adcp/sdk/server/legacy/v5` for mid-migration / escape-hatch only |
| Manually registering `get_adcp_capabilities`                           | Auto-generated by `createAdcpServerFromPlatform` from your typed `DecisioningPlatform` — do not register it                         |
| Calling `server.registerTool('preview_creative', ...)`                 | `AdcpServer` does not expose `registerTool` — put `previewCreative` in the `creative:` domain group like the other handlers         |
| Using module-level Maps for state                                      | Use `ctx.store.put/get/list` — framework provides `InMemoryStateStore` by default                                                   |
| Calling response builders manually in domain handlers                  | Handlers return raw data — response builders are auto-applied across the `creative:` group, including `preview_creative`            |
| `list_creatives` ignores format filter                                 | Check `args.filters?.format_ids` and filter results                                                                                 |
| `preview_creative` returns wrong response_type                         | Must be `'single'` for single creative previews                                                                                     |
| `preview_creative` looks up by creative_id                             | Preview the `creative_manifest` from the request — no library lookup needed                                                         |
| `build_creative` looks up by `args.creative_id` only                   | Storyboard sends `target_format_id` — find a synced creative matching that format                                                   |
| `build_creative` missing creative_manifest                             | Required field — contains the built output                                                                                          |
| `creative_manifest` includes `name` field                              | `CreativeManifest` has no `name` — only `format_id` and `assets`                                                                    |
| HTML asset uses `{ html: '...' }`                                      | Use `{ content: '...' }` — the schema field is `content`, not `html`                                                                |
| format_ids in list_creative_formats don't match what sellers reference | Sellers include your format_ids in their products — if the buyer can't look them up via list_creative_formats, creative sync breaks |

## Storyboards

| Storyboard             | Tests                                                            |
| ---------------------- | ---------------------------------------------------------------- |
| `creative_lifecycle`   | Full lifecycle: format discovery → sync → list → preview → build |
| `creative_template`    | Stateless template rendering (build + preview only)              |
| `creative_sales_agent` | Sales agent that accepts pushed assets                           |
| `creative_ad_server`   | Ad server with pre-loaded library                                |

## Specialism Details

### <a name="specialism-creative-ad-server"></a>creative-ad-server

Storyboard: `creative_ad_server`. Stateful — the library is pre-loaded; buyers do **not** push assets via `sync_creatives` at runtime. Pricing and billing round-trips are first-class.

**`list_creatives`** with `include_pricing=true` returns per-creative `pricing_options`:

```typescript
listCreatives: async (params, ctx) => {
  const { items } = await ctx.store.list('creatives');
  const creatives = items.map((c) => ({
    creative_id: c.creative_id,
    name: c.name,
    format_id: c.format_id,
    status: 'approved' as const,
    created_date: c.created_date,
    updated_date: c.updated_date,
    ...(params.include_pricing && {
      pricing_options: [{
        pricing_option_id: 'standard_cpm',
        model: 'cpm' as const,
        cpm: 2.5,
        currency: 'USD',
      }],
    }),
  }));
  return {
    query_summary: { total_matching: creatives.length, returned: creatives.length, filters_applied: [] },
    creatives,
    pagination: { has_more: false },
  };
},
```

**`build_creative`** receives `media_buy_id`, `package_id`, `target_format_id`, and `pricing_option_id`. Return a VAST tag with macro placeholders, plus `vendor_cost` at CPM = 0 (billing happens via `report_usage`):

```typescript
buildCreative: async (params, ctx) => {
  const creative = await lookupCreativeForFormat(params.target_format_id, ctx);
  const vast = `<?xml version="1.0"?>
<VAST version="4.2">
  <Ad id="${creative.creative_id}"><InLine>
    <Impression><![CDATA[https://adserver.example/imp?cb=[CACHEBUSTER]&mb=${params.media_buy_id}]]></Impression>
    <Creatives><Creative>
      <Linear><Duration>00:00:30</Duration>
        <MediaFiles><MediaFile type="video/mp4"><![CDATA[${creative.video_url}]]></MediaFile></MediaFiles>
        <VideoClicks><ClickThrough><![CDATA[[CLICK_URL]https://landing.example]]></ClickThrough></VideoClicks>
      </Linear>
    </Creative></Creatives>
  </InLine></Ad>
</VAST>`;

  return {
    creative_manifest: {
      format_id: params.target_format_id,
      assets: { serving_tag: { content: vast } },     // HTML asset shape: { content: string }
    },
    pricing_option_id: params.pricing_option_id,      // echo
    vendor_cost: { amount: 0, currency: 'USD' },      // CPM at build time — billing is separate
    sandbox: true,
  };
},
```

**`report_usage`** is the billing reconciliation tool. Validate `idempotency_key` (return the same response for the same key) and echo `pricing_option_id` + `reporting_period`:

```typescript
reportUsage: async (params, ctx) => {
  const existing = await ctx.store.get('usage_reports', params.idempotency_key);
  if (existing) return existing;    // idempotent
  const report = {
    idempotency_key: params.idempotency_key,
    creative_id: params.creative_id,
    pricing_option_id: params.pricing_option_id,
    reporting_period: params.reporting_period,
    billable_amount: { amount: params.impressions * 2.5 / 1000, currency: 'USD' },
    status: 'accepted' as const,
  };
  await ctx.store.put('usage_reports', params.idempotency_key, report);
  return report;
},
```

**`get_creative_delivery`** returns impressions/spend, optionally broken down by variant and filtered by `media_buy_ids`:

```typescript
getCreativeDelivery: async (params, ctx) => ({
  reporting_period: params.reporting_period,
  currency: 'USD',                                 // required top-level per get-creative-delivery-response.json
  creatives: (params.creative_ids ?? []).map((id) => ({
    creative_id: id,
    impressions: 12500,
    spend: { amount: 31.25, currency: 'USD' },
    by_variant: [],
  })),
  sandbox: true,
}),
```

Output formats returned by `list_creative_formats` for ad servers are **serving-tag formats** (VAST 4.2, display tag HTML, native JSON payload), not input visual formats.

### <a name="specialism-creative-template"></a>creative-template

Storyboard: `creative_template`. Stateless — build from the inline `creative_manifest` in the request, do not call `ctx.store`.

Formats declare `variables` the template will substitute:

```typescript
import { displayRender } from '@adcp/sdk';

listCreativeFormats: async (params) => ({
  formats: [{
    format_id: { agent_url: AGENT_URL, id: 'banner_300x250_template' },
    name: 'Responsive 300x250 Banner Template',
    type: 'display' as const,
    renders: [displayRender({ role: 'primary', dimensions: { width: 300, height: 250 } })],
    variables: [          // template-agent specific
      { variable_id: 'headline', type: 'text', max_length: 40 },
      { variable_id: 'cta', type: 'text', max_length: 20 },
      { variable_id: 'hero_image', type: 'image' },
      { variable_id: 'accent_color', type: 'color' },
    ],
    assets: [/* acceptance specs */],
  }],
}),
```

`build_creative` must branch on single vs. multi-format:

```typescript
buildCreative: async (params) => {
  const inputManifest = params.creative_manifest;    // already provided — no lookup

  // Multi-format path (plural target_format_ids)
  if (params.target_format_ids?.length) {
    return {
      creative_manifests: params.target_format_ids.map((fid) => renderTemplate(fid, inputManifest)),
      sandbox: true,
    };   // wraps to buildCreativeMultiResponse
  }

  // Single-format
  const targetFid = params.target_format_id ?? inputManifest.format_id;
  return {
    creative_manifest: renderTemplate(targetFid, inputManifest),
    sandbox: true,
  };
},
```

Output can be HTML (`{ content: '<div>...</div>' }`), JavaScript tag (`{ content: '<script>...</script>' }`), or VAST XML. `asset_type: 'url'` is valid for click-through URLs.

`list_creative_formats` accepts filter params (`type`, `max_width`, `max_height`). Return an empty array — not an error — when nothing matches.

**`preview_creative` should return `urlRender` or `bothRender` — not `htmlRender` alone.** The creative-template storyboard asserts the preview carries a renderable URL (`previews[0].renders[0].preview_url`). An html-only render is spec-valid but fails that assertion. If your platform can render the creative to a hosted preview URL, use `urlRender`. If you only have inline HTML, use `bothRender` (emit both `preview_url: "<sandbox URL>"` and `preview_html: "<inline markup>"`).

#### Audio creative-template (TTS / mix / master)

Audio creative agents (AudioStack, ElevenLabs, Resemble) fit the `creative-template` archetype — stateless transform from an inline manifest to a rendered audio file. Three things differ from display:

1. **No width/height.** The `Format.renders[]` item schema has a `oneOf` — each render must satisfy either `dimensions` (width + height required) OR `parameters_from_format_id: true`. Audio has no dimensions, so audio renders go through the parameterized branch. Use `parameterizedRender({ role: 'primary' })` — it auto-injects `parameters_from_format_id: true`. Encode duration/codec/bitrate in the `format_id` parameters (declared via `accepts_parameters`), not in the render entry.
2. **Async render pipelines.** TTS → mix → master is typically minutes long. Don't block the `build_creative` call waiting for the pipeline; the platform-native SDK (AudioStack's 300s poll window, etc.) belongs inside a task worker. If the platform's API returns quickly, build synchronously; otherwise return the task envelope and emit a `creative_review` completion webhook (see the [Webhooks](#webhooks-for-async-review-pipelines) section above for the wiring).
3. **Inputs are text assets keyed by `asset_id`.** The buyer sends `creative_manifest.assets.script` (a `TextAsset` with `content: string`) — read `inputManifest.assets.script?.content`, not `.text`.

Format declaration:

```typescript
import { parameterizedRender } from '@adcp/sdk';

listCreativeFormats: async () => ({
  formats: [{
    format_id: {
      agent_url: AGENT_URL,
      id: 'audio_ad',
      parameters: { duration_seconds: 30, codec: 'mp3' },
    },
    name: 'Audio Ad',
    type: 'audio' as const,
    accepts_parameters: [
      { parameter_id: 'duration_seconds', type: 'number' },
      { parameter_id: 'codec', type: 'string' },
    ],
    renders: [parameterizedRender({ role: 'primary' })],
    assets: [
      { asset_id: 'script',         asset_type: 'text', required: true,  item_type: 'individual', description: 'Ad script (~70-75 words for a 30s read)' },
      { asset_id: 'voice',          asset_type: 'text', required: false, item_type: 'individual', description: 'TTS voice name (e.g. "sara", "isaac")' },
      { asset_id: 'music_template', asset_type: 'text', required: false, item_type: 'individual', description: 'Music-bed template; omit for voice-only' },
    ],
  }],
}),
```

Handler — inline manifest in, rendered audio out:

```typescript
import { buildCreativeResponse, audioAsset } from '@adcp/sdk/server';

buildCreative: async (params) => {
  const inputManifest = params.creative_manifest;                 // already inline — no lookup
  const targetFid = params.target_format_id ?? inputManifest.format_id;

  // Read inputs from the inline manifest's assets (TextAsset.content, not .text)
  const script = inputManifest.assets.script?.content ?? '';
  const voice = inputManifest.assets.voice?.content;
  const musicTemplate = inputManifest.assets.music_template?.content;

  // Platform pipeline (script → speech → mix). Wrap in a task worker if long-running.
  const rendered = await renderAudio({ script, voice, musicTemplate });

  return buildCreativeResponse({
    creative_manifest: {
      format_id: targetFid,
      assets: {
        audio: audioAsset({
          url: rendered.url,
          container_format: 'mp3',
          codec: 'mp3',
          duration_ms: rendered.durationMs,
          channels: 'stereo',
          sampling_rate_hz: 44100,
        }),
      },
    },
    sandbox: params.account?.sandbox === true,
  });
},
```

Common trap — returning platform-native fields (`{ tag_url, creative_id, media_type }`) at the top level instead of wrapping in `creative_manifest`. The wire schema rejects it; `buildCreativeResponse` catches it at compile time.

### <a name="specialism-creative-generative"></a>creative-generative

Storyboard: `creative_generative`. Takes a brief (`message`) and brand reference (`brand.domain`), generates finished assets.

```typescript
buildCreative: (async params => {
  const { message, brand, quality } = params;
  const brandDomain = brand?.domain ?? 'unknown';
  const q = quality ?? 'draft';

  // Multi-format: return one manifest per target
  if (params.target_format_ids?.length) {
    const manifests = await Promise.all(
      params.target_format_ids.map(fid => generateForFormat(fid, message, brandDomain, q))
    );
    return { creative_manifests: manifests, sandbox: true };
  }

  // Single / refinement: if params.creative_manifest is present, use its assets as a seed
  const targetFid = params.target_format_id ?? params.creative_manifest?.format_id;
  const manifest = await generateForFormat(targetFid, message, brandDomain, q, params.creative_manifest);
  return { creative_manifest: manifest, sandbox: true };
},
  async function generateForFormat(fid, message, brandDomain, quality, seed) {
    const priorHeadline = seed?.assets?.headline?.text; // refinement — reuse buyer-approved copy
    // ... call your image/copy model here
    return {
      format_id: fid,
      assets: {
        generated_image: {
          url: `${AGENT_URL}/generated/${fid.id}-${quality}.jpg`,
          width: 300,
          height: 250,
          format: 'jpeg',
        },
        headline: { text: priorHeadline ?? 'Generated headline' },
        cta: { text: 'Shop now' },
      },
      // Provenance metadata when your output is AI-generated:
      provenance: {
        digital_source_type: 'ai',
        ai_tool: 'your-generator-v1',
      },
    };
  });
```

Brand resolution: fetch `https://{brand.domain}/brand.json` (or your internal brand store) to pull logos, voice, palette — use that to style the generated assets. If brand resolution fails, return `BRAND_NOT_FOUND` rather than silently using defaults.

Quality levels: `draft` is fast + cheap (thumbnails, placeholder copy); `production` is final-quality (full-resolution, real copy, brand-reviewed). Use the distinction to let buyers iterate cheaply before paying for final renders.

## Reference

- `storyboards/creative_lifecycle.yaml` — full creative lifecycle storyboard
- `docs/guides/BUILD-AN-AGENT.md` — SDK patterns
- `docs/TYPE-SUMMARY.md` — curated type signatures
- `docs/llms.txt` — full protocol reference
