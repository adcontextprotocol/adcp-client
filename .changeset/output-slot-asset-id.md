---
"@adcp/sdk": patch
---

Declare output slots in `hello_creative_adapter_*` formats so `build_creative` response keys match declared asset_ids per spec.

Per `schemas/cache/3.0.5/core/creative-manifest.json:14`: "Each key MUST match an asset_id from the format's assets array." Both worked creative adapters were keying their build_creative output (`assets['serving_tag']` and `assets['tag']` respectively) against asset_ids that **weren't declared** in the format — only input slots were declared (image, headline, script, click_url for the template adapter; nothing at all for the ad-server adapter).

PE caught this in two rounds of expert review on PR #1508 ("the doc-comment slightly oversells `adopter-defined` relative to creative-manifest.json:14"). This patch closes the drift across both creative adapters:

- `examples/hello_creative_adapter_template.ts` — added `outputSlot(t)` helper that returns the right `FormatAsset.{html,javascript,vast,audio}({ asset_id: 'serving_tag', required: false })` based on `template.output_kind`. `templateToFormat` now appends it to the format's `assets[]` alongside the input slots. Tightened the `projectRenderToManifest` doc-comment to reflect that `serving_tag` IS now declared (no longer "adopter-defined diverges from spec").
- `examples/hello_creative_adapter_ad_server.ts` — `projectFormat` now declares a single `FormatAsset.html({ asset_id: 'serving_tag', required: false })` output slot on every format (the ad-server adapter always renders to HTML serving tags in this worked example). Adopters whose video formats emit VAST should swap in `FormatAsset.vast(...)` instead. Asset_id aligned with `hello_creative_adapter_template.ts` so adopters across both worked examples see the same contract — the asset_id is declared by the format, not platform-flavored.
- `skills/build-creative-agent/SKILL.md` — audio-adopter checklist now includes the `outputSlot` extension as step 2 (was 3 steps; now 4). Each step references the spec source so adopters understand WHY each delta is required.

Adopters forking either adapter inherit a spec-aligned format declaration. fork-matrix 23/23 still green; typecheck + format clean.

Pure additive at the wire — formats grow by one asset slot, no existing fields change shape. Adopters whose buyers already work against these formats see one extra entry in `format.assets[]`; the extra entry is `required: false` so input requests don't change.

**Spec gap filed upstream**: `format.assets[]` doesn't currently distinguish input slots (buyer-provided) from output-only slots (build_creative-produced) — `required: false` is the closest legal expression but understates the constraint. Tracked at [adcontextprotocol/adcp#4021](https://github.com/adcontextprotocol/adcp/issues/4021); when the upstream lands an `output_only` flag or `produced_by` enum, both adapters will adopt it.

