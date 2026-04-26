---
name: build-decisioning-creative-template
description: Build an AdCP v6.0 (preview) creative-template decisioning platform — a stateless creative transform service (TTS, watermarking, format conversion, template fill). Use ONLY when the user explicitly wants the v6.0 DecisioningPlatform shape; for v5.x handler-style creative agents, use `build-creative-agent` instead.
---

# Build a Creative-Template Decisioning Platform (v6.0 preview)

You're building a **stateless creative transform** service that fits the AdCP `creative-template` specialism: take an input creative manifest + format spec, produce an output creative manifest. No library, no review queue, no persisting state. Examples: TTS audio synthesis, image watermarking, video format conversion, template-based ad generation.

## When this skill applies

- User wants a creative-template service on the **v6.0 DecisioningPlatform** surface (preview, pre-GA)
- Specialism: `creative-template` (stateless transform; not `creative-ad-server` which is stateful, not `creative-generative` which is brief-driven)
- SDK package: `@adcp/client` v5.18+ with the `decisioning` preview surface

**Wrong skill if:**
- User wants v5.x handler-style API → `skills/build-creative-agent/`
- User wants stateful creative library/ad-server → `skills/build-creative-agent/` § creative-ad-server
- User wants brief-to-creative generation → `skills/build-creative-agent/` § creative-generative
- User wants to sell media inventory → `skills/build-seller-agent/`

## The whole shape (read this first)

A v6.0 creative-template platform is a **single class** implementing `DecisioningPlatform` with a `creative` field of type `CreativeTemplatePlatform`. The framework dispatches each tool call to the right method.

### Key fact: `CreativeManifest.assets` is a **keyed map**, not an array

Every example below depends on this — it's the most common day-1 trip-up:

```ts
// ✅ CORRECT — assets is { [asset_id]: ImageAsset | AudioAsset | VideoAsset | ... }
const url = req.creative_manifest?.assets?.['source_image']?.url;

// ❌ WRONG — there is no manifest_id; assets is not an array
const url = req.creative_manifest?.assets?.[0]?.url;
```

Asset values are **discriminated by `asset_type`** (`'image' | 'audio' | 'video' | 'vast' | 'text' | 'url' | 'html' | ...`). TypeScript will narrow them for you when you check the discriminator — no casting needed.

### Minimal worked example — image watermark service

Takes an image asset by id, applies a brand watermark, returns a manifest with the watermarked asset:

```ts
import {
  AdcpError,
  createAdcpServerFromPlatform,
  getAsset,
  requireAsset,
  type DecisioningPlatform,
  type AccountStore,
  type CreativeTemplatePlatform,
} from '@adcp/client/server/decisioning';
import type {
  BuildCreativeRequest,
  CreativeManifest,
  PreviewCreativeRequest,
  PreviewCreativeResponse,
  CreativeAsset,
  AccountReference,
  ImageAsset,
} from '@adcp/client/types';
import { serve } from '@adcp/client/server';

interface WatermarkConfig {
  watermarkUrl: string;
}

interface WatermarkMeta {
  brand_id: string;
}

class WatermarkPlatform implements DecisioningPlatform<WatermarkConfig, WatermarkMeta> {
  capabilities = {
    specialisms: ['creative-template'] as const,
    creative_agents: [],
    channels: ['display'] as const,
    pricingModels: ['cpm'] as const,
    config: {
      watermarkUrl: 'https://cdn.example.com/brand-watermark.png',
    } satisfies WatermarkConfig,
  };

  // statusMappers + AccountStore.upsert/list are now optional. Stateless
  // platforms (creative-template, signal-marketplace proxies) typically
  // omit them; framework returns UNSUPPORTED_FEATURE to buyers calling
  // sync_accounts / list_accounts on platforms that don't implement them.

  accounts: AccountStore<WatermarkMeta> = {
    resolve: async (ref: AccountReference) => {
      const id = 'account_id' in ref ? ref.account_id : 'wm_acc_default';
      return {
        id,
        name: 'Watermark default',     // required by wire Account
        status: 'active',              // required by wire Account
        operator: 'watermark.example.com',
        metadata: { brand_id: 'brand_default' },
        authInfo: { kind: 'api_key' },
      };
    },
    // upsert / list omitted — stateless platform doesn't manage accounts.
  };

  creative: CreativeTemplatePlatform = {
    /** Sync transform — fast operation, return result immediately. */
    buildCreative: async (req: BuildCreativeRequest): Promise<CreativeManifest> => {
      // requireAsset throws AdcpError with field path if missing/wrong type.
      // After the call, TS narrows `source` to `ImageAsset` — no cast needed.
      const source = requireAsset(req.creative_manifest, 'source_image', 'image');
      const watermarkedUrl = await applyWatermark(source.url, this.capabilities.config.watermarkUrl);

      const formatId = req.target_format_id;
      if (!formatId) {
        throw new AdcpError('INVALID_REQUEST', {
          recovery: 'correctable',
          message: 'target_format_id is required',
          field: 'target_format_id',
        });
      }

      const watermarked: ImageAsset = {
        asset_type: 'image',
        url: watermarkedUrl,
        width: source.width,
        height: source.height,
      };
      return {
        format_id: formatId,
        assets: { watermarked_image: watermarked },
      };
    },

    /** Always sync — preview is just a sandbox URL. */
    previewCreative: async (req: PreviewCreativeRequest): Promise<PreviewCreativeResponse> => {
      // Soft-form helper — preview is best-effort even if source is missing.
      const source = getAsset(req.creative_manifest, 'source_image', 'image');
      const sourceUrl = source?.url ?? '';
      // PreviewCreativeResponse is a discriminated union by `response_type`.
      // Use `'single'` for one preview-per-request (the common case for
      // stateless template platforms).
      return {
        response_type: 'single',
        previews: [
          {
            preview_id: `pv_${Date.now()}`,
            input: { name: 'default' },
            renders: [
              {
                render_id: 'r1',
                output_format: 'url',
                role: 'primary',
                preview_url: `https://watermark.example.com/preview?src=${encodeURIComponent(sourceUrl)}`,
              },
            ],
          },
        ],
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
      };
    },

    /**
     * Stateless template platforms typically auto-approve. Each row is the
     * wire `SyncCreativesSuccess.creatives[]` shape: `action` is required
     * (CRUD outcome — what your platform did), `status` is optional (review
     * state). Stateless transforms use `action: 'unchanged'` since they
     * don't persist; review state is `'approved'` since auto-approving.
     */
    syncCreatives: async (creatives: CreativeAsset[]) => {
      return creatives.map(c => ({
        creative_id: c.creative_id ?? `cr_${Math.random()}`,
        action: 'unchanged' as const,
        status: 'approved' as const,
      }));
    },
  };
}

async function applyWatermark(src: string, mark: string): Promise<string> {
  // Real impl calls your imaging service. Stub for the example.
  return `${src}?watermark=${encodeURIComponent(mark)}`;
}

// Boot — bind HTTP, dispatch tool calls into the platform.
const platform = new WatermarkPlatform();
const server = createAdcpServerFromPlatform(platform, {
  name: 'watermark',
  version: '1.0.0',
  validation: { requests: 'strict', responses: 'strict' },
});
serve(() => server, { publicUrl: 'https://watermark.example.com' });
```

That's the entire shape. **No `as never` casts in adopter code** — the wire types are typed. Discriminators do narrowing for you. The rest of this skill is the rules around it.

## Two wire shapes that trip people up

### `target_format_id` is a `FormatID` object, not a bare string

```ts
// ❌ WRONG
if (req.target_format_id === 'audio_30s') { ... }

// ✅ CORRECT — FormatID is { id: string; agent_url: string }
if (req.target_format_id?.id === 'audio_30s') { ... }
```

The wire schema separates format identity (`id`) from the creative agent that hosts the format definition (`agent_url`). Always read `.id` for the literal format identifier.

### `PreviewCreativeResponse` is a discriminated union — pick `'single'`

```ts
// 3 variants by `response_type`: 'single' | 'batch' | 'variant'
// For stateless creative-template platforms, return `'single'`. Always.
return {
  response_type: 'single',
  previews: [{ preview_id, input: { name: 'default' }, renders: [...] }],
  expires_at,
};
```

`batch` and `variant` are for advanced post-flight workflows you don't need. The full union exists because the spec covers ad servers that produce per-impression preview variants — irrelevant for transform platforms. **If you're a creative-template platform, always return `'single'`.**

(See [#3268](https://github.com/adcontextprotocol/adcp/issues/3268) — proposing to hoist `preview_url` to the top level for the single-render case.)

## The interface you implement

`CreativeTemplatePlatform` has 5 method slots. **For each method-pair you implement EXACTLY ONE — sync OR `*Task`** — `validatePlatform()` will throw at construction if you provide both.

| Slot | Sync variant | HITL `*Task` variant | Required? |
|---|---|---|---|
| build creative | `buildCreative(req, ctx)` | `buildCreativeTask(taskId, req, ctx)` | One required |
| preview creative | `previewCreative(req, ctx)` | — (always sync) | Required |
| sync creatives | `syncCreatives(creatives, ctx)` | `syncCreativesTask(taskId, creatives, ctx)` | One required |

### Sync vs `*Task` — pick by latency, not by preference

| Your operation typically takes... | Pick |
|---|---|
| Under ~5 seconds (image manipulation, simple template fill) | **Sync** (`buildCreative`) |
| 10-60 seconds (TTS, audio mixing, video transcode) | **Sync** is fine — buyer awaits in the request |
| 1-30 minutes (heavy generation, multi-pass rendering) | **HITL** (`buildCreativeTask`) — buyer immediately gets a `submitted` envelope with `task_id` |
| Unknown / variable | Pick sync; switch to `*Task` only if observed latency > 30s |

**Critical**: when you pick HITL (`*Task`), the buyer cannot poll task status over the wire today (`tasks/get` integration is post-6.0-rc.1). The framework records terminal state in its task registry, but exposing it to the buyer is preview-incomplete. Default to sync unless your operation truly cannot be awaited.

## Reading typed assets out of `creative_manifest`

`req.creative_manifest?.assets?.[asset_id]` returns a discriminated union (`ImageAsset | AudioAsset | VideoAsset | VASTAsset | TextAsset | URLAsset | HTMLAsset | JavaScriptAsset | WebhookAsset | CSSAsset | DAASTAsset | MarkdownAsset | BriefAsset | CatalogAsset`). Use the `asset_type` discriminator to narrow:

```ts
const asset = req.creative_manifest?.assets?.['script'];
if (asset?.asset_type === 'text') {
  // TS narrows to TextAsset — `.content`, `.language` available without cast
  const scriptText = asset.content;
}
if (asset?.asset_type === 'audio') {
  // TS narrows to AudioAsset — `.url`, `.duration_ms`, `.codec` etc.
  const audioUrl = asset.url;
}
```

**Field names matter** — `TextAsset.content` (not `.text`), `ImageAsset.url`, `AudioAsset.url`, `VideoAsset.url`, `HTMLAsset.content`, `URLAsset.url`. Use IntelliSense after the discriminator narrows; don't guess.

Likewise when *returning* a manifest, type the asset value to its concrete shape and TypeScript will validate it against the manifest's union:

```ts
const audio: AudioAsset = {
  asset_type: 'audio',
  url: 'https://cdn.example.com/render.mp3',
  duration_ms: 30_000,
  container_format: 'mp3',
  codec: 'mp3',
};
return {
  format_id: req.target_format_id!,
  assets: { rendered_audio: audio },
};
```

**Do not write `as any` or `as never` on platform code.** If you find yourself reaching for those, you almost certainly want to `import type` the right asset from `@adcp/client/types` and use the discriminator instead.

The asset types are generated from the spec; full list at `src/lib/types/tools.generated.ts`. Each carries `asset_type` as a literal-typed discriminator.

### Helpers — `getAsset` and `requireAsset`

Most platform methods do the same null-check + discriminator-check + extract pattern over and over. The SDK ships two helpers that collapse it:

```ts
import { getAsset, requireAsset } from '@adcp/client/server/decisioning';

// Soft form — returns undefined if missing or wrong asset_type
const optionalVoice = getAsset(req.creative_manifest, 'voice', 'text');
//    ^^^^^^^^^^^^^ TextAsset | undefined

// Throw form — throws AdcpError('INVALID_REQUEST') with a field path
// if missing or wrong asset_type. Use when the asset is required for
// the platform method to proceed.
const script = requireAsset(req.creative_manifest, 'script', 'text');
//    ^^^^^^ TextAsset (never undefined past this line)

await audioStackClient.synthesize({ text: script.content });
```

Both helpers preserve the discriminator narrowing — `script.content` types correctly without a cast. `requireAsset` throws an `AdcpError` with a precomposed field path (e.g., `creative_manifest.assets.script`) so the buyer sees actionable feedback. Pass `messageOverride` if the default doesn't fit.

## Errors — `throw new AdcpError(...)`

Every method either returns its success type OR throws `AdcpError` for structured rejection. Generic thrown errors map to `SERVICE_UNAVAILABLE` with `recovery: 'transient'`.

```ts
buildCreative: async (req) => {
  if (!req.format_id?.id?.startsWith('image_')) {
    throw new AdcpError('UNSUPPORTED_FEATURE', {
      recovery: 'terminal',
      message: 'WatermarkPlatform only supports image_* formats',
      field: 'format_id.id',
    });
  }
  if ((req as any).creative_manifest?.assets?.length > 10) {
    throw new AdcpError('INVALID_REQUEST', {
      recovery: 'correctable',
      message: 'Maximum 10 assets per build_creative call',
      field: 'creative_manifest.assets',
      suggestion: 'Split into multiple requests',
    });
  }
  // ... happy path
}
```

`AdcpError` constructor:
```ts
new AdcpError(code: ErrorCode | string, options: {
  recovery: 'transient' | 'correctable' | 'terminal';   // REQUIRED
  message: string;                                       // REQUIRED
  field?: string;                                        // path like 'packages[0].targeting'
  suggestion?: string;                                   // human-readable fix
  retry_after?: number;                                  // seconds; for transient
  details?: Record<string, unknown>;                     // for multi-error pre-flight, etc.
})
```

Common codes for creative-template: `INVALID_REQUEST`, `UNSUPPORTED_FEATURE`, `VALIDATION_ERROR`, `RATE_LIMITED`, `SERVICE_UNAVAILABLE`, `CREATIVE_REJECTED`. The full vocabulary is in `@adcp/client/server/decisioning`'s `ErrorCode` type — return any spec code OR your own platform-specific string (agents fall back to `recovery` classification on unknowns).

## Account resolution

`accounts.resolve(ref)` is called by the framework BEFORE any creative method. Whatever you return becomes `ctx.account` inside your methods. `AccountReference` is a discriminated union:

```ts
type AccountReference =
  | { account_id: string; sandbox?: boolean }
  | { brand_domain: string; sandbox?: boolean }
  | { agency_buyer: { brand_domain: string }; advertiser: { brand_domain: string }; sandbox?: boolean };
```

Throw `AccountNotFoundError` (importable from `@adcp/client/server/decisioning`) when you can't resolve — the framework projects to the wire `ACCOUNT_NOT_FOUND` envelope.

`sandbox: true` — the buyer is asking you to validate against your platform without actually transacting. Route reads/writes to your sandbox backend if you have one; otherwise just return realistic-shaped responses without persisting.

## Serving the agent

<!-- skill-example-skip: continuation of the watermark example above; re-uses identifiers defined there -->
```ts
import { serve } from '@adcp/client/server';

const platform = new WatermarkPlatform();
const server = createAdcpServerFromPlatform(platform, {
  name: 'watermark',
  version: '1.0.0',
  validation: { requests: 'strict', responses: 'strict' },
});

serve(() => server, {
  publicUrl: 'https://watermark.example.com',
  // For multi-host: pass a function `(host) => server` and branch.
});
```

`createAdcpServerFromPlatform`:
- Calls `validatePlatform()` — throws if you advertise a specialism but don't implement it, or define both halves of a method-pair
- Wraps each method with `AdcpError`-catch + `submitted`-envelope projection for HITL
- Returns a `DecisioningAdcpServer` (extends `AdcpServer`) with `getTaskState(taskId)` + `awaitTask(taskId)` for HITL inspection

`serve()` is unchanged from v5.x; it accepts the server and binds HTTP transport for both MCP and A2A.

## Capabilities — declare what you support

```ts
capabilities = {
  specialisms: ['creative-template'] as const,    // single literal in the const tuple
  creative_agents: [],                             // not used by template platforms
  channels: ['display', 'video', 'audio'] as const,
  pricingModels: ['cpm'] as const,
  config: { /* your platform-specific config */ } satisfies YourConfig,
};
```

The `as const` is load-bearing — it preserves the literal types so `RequiredPlatformsFor<S>` can compile-check that you provide `creative: CreativeTemplatePlatform`.

## Scaffolding — minimum viable project

```
my-creative-template-agent/
├── package.json          # depends on @adcp/client ^5.18.0
├── tsconfig.json         # strict: true
├── src/
│   ├── platform.ts       # MyPlatform implements DecisioningPlatform
│   └── serve.ts          # createAdcpServerFromPlatform + serve()
└── README.md
```

`package.json`:
```json
{
  "name": "my-creative-template-agent",
  "type": "module",
  "scripts": { "start": "tsx src/serve.ts" },
  "dependencies": { "@adcp/client": "^5.18.0" },
  "devDependencies": { "tsx": "^4", "typescript": "^5" }
}
```

## Testing your platform

The fastest test loop: instantiate your platform, build a server, and dispatch a fake tool call without binding HTTP:

```ts
import { AudioStackPlatform } from './platform';
import { createAdcpServerFromPlatform } from '@adcp/client/server/decisioning';

const platform = new AudioStackPlatform();
const server = createAdcpServerFromPlatform(platform, {
  name: 'audiostack-test',
  version: '0.0.1',
  validation: { requests: 'off', responses: 'off' },
});

const result = await server.dispatchTestRequest({
  method: 'tools/call',
  params: {
    name: 'build_creative',
    arguments: {
      target_format_id: { id: 'audio_30s', agent_url: 'https://x' },
      creative_manifest: {
        format_id: { id: 'audio_30s', agent_url: 'https://x' },
        assets: { script: { asset_type: 'text', text: 'Hello world.' } },
      },
      account: { account_id: 'test_acc' },
    },
  },
});
console.log(result.structuredContent);
```

`dispatchTestRequest` is the canonical loop for unit-testing platform behavior without HTTP. It's available on `DecisioningAdcpServer` (the type returned by `createAdcpServerFromPlatform`). Set `validation: { requests: 'off' }` while iterating; turn it back to `strict` for end-to-end tests.

For HITL platforms, `server.awaitTask(taskId)` settles the background promise; `server.getTaskState(taskId)` reads terminal status.

## What NOT to do

❌ **Don't import from `@adcp/client/server` for the platform shape.** That's the v5.x handler-style API. Use `@adcp/client/server/decisioning` for v6.0.

❌ **Don't use `ctx.runAsync(...)` or `ctx.startTask(...)`.** Those were in earlier preview drops; they're gone in v2.1. The async story is dual-method (`xxx` vs `xxxTask`), period.

❌ **Don't define both `buildCreative` and `buildCreativeTask`.** `validatePlatform()` will throw with a clear diagnostic. Pick one.

❌ **Don't return error envelopes manually.** Throw `AdcpError`; the framework projects to the wire shape.

❌ **Don't write `as never` or `as any` on platform code.** The wire types are typed, including `creative_manifest.assets[asset_id]` as a discriminated union. If you reach for a cast, you're missing an `import type` or skipping a discriminator check.

❌ **Don't treat `creative_manifest.assets` as an array.** It's a keyed map: `{ [asset_id: string]: ImageAsset | AudioAsset | ... }`. Look up by asset_id, not by index.

❌ **Don't try to write to the buyer's `media_buy_status_changes` channel** (or any other resource type). Creative-template platforms don't emit lifecycle events; they're stateless.

❌ **Don't implement `getMediaBuyDelivery` / `createMediaBuy` / etc.** Those are sales-shaped tools. Creative-template only implements `creative.*`.

## Reference: imports cheat sheet

```ts
// From @adcp/client/server/decisioning
import {
  AdcpError,
  AccountNotFoundError,
  createAdcpServerFromPlatform,
  // Manifest accessors that preserve discriminator narrowing
  getAsset,
  requireAsset,
  type DecisioningPlatform,
  type AccountStore,
  type Account,
  type CreativeTemplatePlatform,
  type CreativeReviewResult,
  type RequestContext,
  type ErrorCode,
  type AdcpStructuredError,
} from '@adcp/client/server/decisioning';

// From @adcp/client/types — wire schemas (auto-generated)
import type {
  BuildCreativeRequest,
  CreativeManifest,
  PreviewCreativeRequest,
  PreviewCreativeResponse,
  CreativeAsset,
  AccountReference,
  // Asset types for narrowing — pull only the ones you produce/consume
  ImageAsset,
  AudioAsset,
  VideoAsset,
  TextAsset,
  URLAsset,
  HTMLAsset,
  VASTAsset,
} from '@adcp/client/types';

// From @adcp/client/server — HTTP serving
import { serve } from '@adcp/client/server';
```

## When you're stuck

- `validatePlatform()` threw at construction → check the diagnostic; usually you advertised a specialism without implementing the matching field, or defined both sync and `*Task` for the same pair.
- TS compiler complains about `RequiredPlatformsFor<S>` constraint → you claimed `creative-template` but your `creative:` field doesn't match `CreativeTemplatePlatform`. Re-check the method signatures.
- Wire request doesn't reach your method → check the framework's `validation: 'strict'` config; the request may be failing schema validation before dispatch. Set `validation: { requests: 'off' }` temporarily to diagnose.

For fuller protocol context (request/response shapes, AdCP error vocabulary): read `docs/llms.txt`. For the v6.0 design rationale: `docs/proposals/decisioning-platform-v2-hitl-split.md`.
