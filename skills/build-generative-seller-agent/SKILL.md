---
name: build-generative-seller-agent
description: Use when building an AdCP generative seller — an AI ad network, generative DSP, or platform that sells inventory AND generates creatives from briefs.
---

# Build a Generative Seller Agent

A generative seller does everything a standard seller does (products, media buys, delivery) **plus** generates creatives from briefs. The buyer sends a creative brief instead of uploading pre-built assets. Your platform resolves the brand identity, generates the creative, and serves it.

A generative seller that sells programmatic inventory MUST also accept standard IAB formats (display images, VAST tags, HTML banners). The generative capability is additive — buyers who already have creatives need to upload them directly.

## Pick your fork target

There's no dedicated `hello_generative_seller_adapter_*.ts` yet — generative-seller is `sales-non-guaranteed` + `creative-generative`, so adopters fork the seller adapter and add the `build_creative` surface.

| Specialism | Status | Fork this | Add | Storyboard |
| --- | --- | --- | --- | --- |
| `creative-generative` | stable | [`hello_seller_adapter_non_guaranteed.ts`](../../examples/hello_seller_adapter_non_guaranteed.ts) | `creatives.buildCreative`, `creatives.previewCreative`, brand-resolution logic | `creative_generative` |

Declare all your claims (`['sales-non-guaranteed', 'creative-generative']`, plus `'sales-catalog-driven'` if you ingest catalogs for dynamic creative) on `createAdcpServerFromPlatform`'s `capabilities.specialisms`. Missing the claim fails the grader with "No applicable tracks found" even if every tool works.

For exact response shapes, error codes, and optional fields, `docs/llms.txt` is the canonical reference.

## When to use this skill

- User wants to build a generative DSP or AI ad network
- User's platform both sells inventory and creates/generates creatives
- User mentions "creative from brief", "AI-generated ads", or "generative"

**Not this skill:**

- Standard seller, no creative generation → `skills/build-seller-agent/`
- Standalone creative agent (renders but doesn't sell) → `skills/build-creative-agent/`
- Signals/audience data → `skills/build-signals-agent/`

**Often claimed alongside:** `creative-template` — hybrid creative platforms (Celtra, Bannerflow) claim both; template-driven and AI-driven generation share the same creative library. See [Common multi-specialism bundles](../../examples/README.md#common-multi-specialism-bundles).

## Cross-cutting rules

Every generative seller hits the cross-cutting rules in [`../cross-cutting.md`](../cross-cutting.md). Plus the seller cross-cutting from [`../build-seller-agent/SKILL.md`](../build-seller-agent/SKILL.md) — generative-seller is additive on top of the seller baseline.

## Specialism deltas at a glance

**`creative-generative`** —

- `build_creative` accepts `message` + `brand.domain` + optional `quality: draft|production`; supports refinement (re-send manifest in)
- Response is `{ creative_manifest: { format_id, assets } }` — **not** `{ creative_id, status, quality, preview_url }` (those are `sync_creatives` fields; don't leak them in)
- Each asset in `creative_manifest.assets` requires an `asset_type` discriminator — use the typed factories (`imageAsset({...})`, `videoAsset({...})`, `htmlAsset({...})`, `urlAsset({...})`)
- `preview_creative` renders use `urlRender({...})` / `htmlRender({...})` / `bothRender({...})` — they inject `output_format` and enforce the matching `preview_url` / `preview_html` at the type level
- Brand resolution: brands register dynamically through `sync_accounts` (a buyer syncs an account with `brand.domain`; treat that domain as resolvable). Don't hardcode a brand allowlist. Storyboards use fictional `.example` TLD brands; a hardcoded list will fail validation.

**`sales-non-guaranteed`** baseline applies — see [`../build-seller-agent/specialisms/sales-non-guaranteed.md`](../build-seller-agent/specialisms/sales-non-guaranteed.md).

**`sales-catalog-driven`** (optional) — if you ingest catalogs for dynamic creative generation, see [`../build-retail-media-agent/SKILL.md`](../build-retail-media-agent/SKILL.md).

## Validate locally

```bash
# Run the fork-matrix gate against the seller-non-guaranteed baseline
npm run compliance:fork-matrix -- --test-name-pattern="hello-seller-adapter-non-guaranteed"

# Or validate your forked agent directly against the generative storyboard
adcp storyboard run http://127.0.0.1:3005/mcp creative_generative \
  --bearer "$ADCP_AUTH_TOKEN" --include-bundles --json
```

The fork-matrix gate is the three-gate contract from [`docs/guides/EXAMPLE-TEST-CONTRACT.md`](../../docs/guides/EXAMPLE-TEST-CONTRACT.md): tsc strict / storyboard zero-failures / upstream façade.

For deeper validation: [`docs/guides/VALIDATE-YOUR-AGENT.md`](../../docs/guides/VALIDATE-YOUR-AGENT.md).

## Common shape gotchas

`BuildCreativeReturn` has 4 valid shapes (framework auto-wraps the bare manifest). Asset discriminators are required — use the typed factories. `get_media_buy_delivery` requires top-level `currency`; per-package rows require the billing quintet (`package_id`, `spend`, `pricing_model`, `rate`, `currency`). See [`../SHAPE-GOTCHAS.md`](../SHAPE-GOTCHAS.md).

## Migration notes

- 6.6 → 6.7: [`docs/migration-6.6-to-6.7.md`](../../docs/migration-6.6-to-6.7.md)
- 4.x → 5.x: [`docs/migration-4.x-to-5.x.md`](../../docs/migration-4.x-to-5.x.md)
