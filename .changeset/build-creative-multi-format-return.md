---
'@adcp/sdk': minor
---

`buildCreative` on both `CreativeBuilderPlatform` and `CreativeAdServerPlatform` now accepts a discriminated return shape: `CreativeManifest | CreativeManifest[] | BuildCreativeSuccess | BuildCreativeMultiSuccess`. Previously the return was `Promise<CreativeManifest>` (single only), so multi-format storyboards (`target_format_ids: [...]`) hit double-wrapped responses that failed schema validation against the spec's `BuildCreativeMultiSuccess` arm. The framework projector now branches on shape:

- Plain `CreativeManifest` → wrap as `{ creative_manifest: <obj> }` (single, no metadata)
- `CreativeManifest[]` → wrap as `{ creative_manifests: <array> }` (multi, no metadata)
- Already-shaped `BuildCreativeSuccess` (has `creative_manifest` field) → passthrough — adopter set `sandbox` / `expires_at` / `preview` themselves
- Already-shaped `BuildCreativeMultiSuccess` (has `creative_manifests` field) → passthrough

Adopters route on `req.target_format_id` (single) vs `req.target_format_ids` (multi) and return the matching arm. Returning an array for a single-format request, or a bare manifest for a multi-format request, is an adopter contract violation that surfaces as schema-validation failure on the wire response. New `BuildCreativeReturn` type alias exported from `@adcp/sdk/server/decisioning`. Surfaced by training-agent v6 spike (F16) on `creative_template/build_multi_format` and `creative_generative/build_multi_format` storyboards.

Also documents `brand` field in the `TOOL_INPUT_SHAPE` and `ComplyControllerConfig.inputSchema` extension examples — both `account` and `brand` are stripped by the spec-canonical comply controller shape and need extending when storyboard fixtures send them at the top level (F17).
