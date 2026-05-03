---
name: build-creative-agent
description: Use when building an AdCP creative agent — an ad server, creative management platform, or any system that accepts, stores, transforms, and serves ad creatives.
---

# Build a Creative Agent

A creative agent accepts assets from buyers, stores or transforms them, and returns serving artifacts (tags, rendered manifests, previews). The fastest path to a passing agent is to **fork a worked adapter** that matches your archetype. This skill tells you which one and what cross-cutting rules apply.

## Pick your fork target

Three creative archetypes; two have dedicated worked adapters, the third lives in `build-generative-seller-agent` because it's coupled with selling inventory.

| Specialism | Archetype | Fork this | Mock upstream | Storyboard |
| --- | --- | --- | --- | --- |
| `creative-ad-server` | Stateful library, pricing + billing (Innovid, Flashtalking, CM360, GAM-creative) | [`hello_creative_adapter_ad_server.ts`](../../examples/hello_creative_adapter_ad_server.ts) | `npx adcp mock-server creative-ad-server` | `creative_ad_server` |
| `creative-template` | Stateless transform from inline manifest (Celtra, AudioStack, ElevenLabs, Resemble) | [`hello_creative_adapter_template.ts`](../../examples/hello_creative_adapter_template.ts) | `npx adcp mock-server creative-template` | `creative_template` |
| `creative-generative` | Brief-to-creative generation (AI ad networks coupled with sales) | → `skills/build-generative-seller-agent/` | — | `creative_generative` |

The `interaction_model` in each specialism's `index.yaml` is the forcing function: `stateful_ad_server`, `stateless_transform`, `stateless_generate`. Decide which one matches your business, then fork the adapter for that row.

For exact response shapes, error codes, and optional fields, `docs/llms.txt` is the canonical reference. The fork target stays in sync with the spec because PR #1394's three-gate contract fails CI when it drifts.

## When to use this skill

- User wants to build an ad server, creative management platform, or audio creative agent
- User mentions `sync_creatives`, `build_creative`, `list_creative_formats`, or VAST/tag generation

**Not this skill:**

- Brief-to-creative generation coupled with selling inventory (AI ad network) → `skills/build-generative-seller-agent/`
- Publisher creative service that pairs with selling — usually a `build-seller-agent` adopter that omits a creative-* specialism claim

## Cross-cutting rules

Every creative agent hits the cross-cutting rules in [`../cross-cutting.md`](../cross-cutting.md). Two creative-specific notes on top of those:

### Webhooks for async review pipelines

Creative review is naturally async. `sync_creatives` may return `pending_review` with a task envelope; your review pipeline emits `creative_review` completion webhooks when state transitions. `build_creative` for the ad-server archetype emits `report_usage` completion webhooks. Use `ctx.emitWebhook` per the pattern in [`../cross-cutting.md` § Webhooks](../cross-cutting.md#webhooks-stable-operation_id-across-retries).

### `previewCreative` and `listCreativeFormats` are no-account tools

Both run with `NoAccountCtx<TCtxMeta>` — they don't carry an authenticated account. The fork target's resolver synthesizes a default-listing network so `ctx.account` resolves cleanly inside the no-account handler (migration recipe #11). If you fork from scratch you'll trip this; let the hello adapter do it.

`preview_creative` should return `urlRender` or `bothRender`, **not `htmlRender` alone**. The creative-template storyboard asserts `previews[0].renders[0].preview_url` is renderable. If your platform can host a preview URL, use `urlRender`. If you only have inline HTML, use `bothRender` (emit both `preview_url` and `preview_html`).

## Specialism deltas at a glance

The fork targets cover the baseline + specialism deltas. Quick reference for what each archetype needs that the others don't:

**`creative-ad-server`** — stateful library (`POST/GET/PATCH /v1/creatives`), tag generation via macro substitution against a stored snippet, per-creative pricing (`include_pricing=true` on `list_creatives`, `pricing_option_id` echoed by `build_creative`, `report_usage` closes the loop), `getCreativeDelivery` with multi-id pass-through and required top-level `currency` + `reporting_period`. Output formats from `list_creative_formats` are **serving-tag formats** (VAST 4.2, display tag HTML, native JSON), not input visual formats.

**`creative-template`** — stateless: build from inline `creative_manifest` in the request, no `ctx.store` lookup. Multi-format path: `target_format_ids` (plural) returns `{ creative_manifests: [...] }` (auto-wrapped to `buildCreativeMultiResponse`); single returns `{ creative_manifest: ... }`. Formats declare `variables[]` the template substitutes. Audio templates (TTS / mix / master) use `parameterizedRender({ role: 'primary' })` — no width/height — and typically run async (return task envelope, emit `creative_review` webhook on completion). Audio inputs come in as `creative_manifest.assets.script` (a `TextAsset` with `.content`, not `.text`).

**`creative-generative`** — generate from `message` + `brand.domain`; honor `quality: draft|production`; support refinement (re-send manifest in). Goes through `skills/build-generative-seller-agent/` because it's coupled with selling inventory.

## Validate locally

```bash
# Run the fork-matrix gates for both creative archetypes
npm run compliance:fork-matrix -- --test-name-pattern="hello-creative-adapter"

# Or validate your forked agent directly against its storyboard
adcp storyboard run http://127.0.0.1:3002/mcp creative_ad_server \
  --bearer "$ADCP_AUTH_TOKEN" --include-bundles --json
```

Each gate is the three-gate contract from [`docs/guides/EXAMPLE-TEST-CONTRACT.md`](../../docs/guides/EXAMPLE-TEST-CONTRACT.md): tsc strict / storyboard zero-failures / upstream façade. Adopters who fork extend the test file with their own adapter path and `expectedRoutes`.

For deeper validation (fuzz, request-signing grading, custom invariants): [`docs/guides/VALIDATE-YOUR-AGENT.md`](../../docs/guides/VALIDATE-YOUR-AGENT.md).

## Common shape gotchas

`BuildCreativeReturn` has 4 valid shapes (framework auto-wraps the bare manifest). `VASTAsset` requires an embedded `delivery_type` discriminator. `Format.renders[]` is a `oneOf` — `dimensions` (width + height) OR `parameters_from_format_id: true`, never both, never neither. See [`../SHAPE-GOTCHAS.md`](../SHAPE-GOTCHAS.md) — schema validators catch these at runtime; type checkers don't.

## Migration notes

- 6.6 → 6.7: `defineCreativeAdServerPlatform` family drops `req: unknown` casts; `Format.renders[]` codegen is closed-shape (#1325) so typed render builders compose under strict tsc; `NoAccountCtx<TCtxMeta>` narrows the no-account tools. See [`docs/migration-6.6-to-6.7.md`](../../docs/migration-6.6-to-6.7.md).
- 4.x → 5.x: [`docs/migration-4.x-to-5.x.md`](../../docs/migration-4.x-to-5.x.md).
