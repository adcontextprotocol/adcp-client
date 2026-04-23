---
'@adcp/client': patch
---

Extend `detectShapeDriftHint` in the storyboard runner to cover `sync_creatives` and `preview_creative` alongside the existing `build_creative` detection (closes #849).

Both tools share the same drift pattern as `build_creative`: a handler returns a single inner shape at the top level instead of wrapping it in the tool's required array/discriminator envelope. A bare schema error ("must have required property X") doesn't tell the developer they've inverted the response shape — this hint does.

- **`sync_creatives`** — top-level `creative_id` / `platform_id` / `action` without a `creatives` array (or `errors` / `task_id` for the other two valid branches) → hint names `syncCreativesResponse()` from `@adcp/client/server`.
- **`preview_creative`** — top-level `preview_url` / `preview_html` without the `previews[].renders[]` nesting and `response_type` discriminator → hint names `previewCreativeResponse()`. `interactive_url` alone doesn't trigger (it's a legal top-level sibling on the single-variant branch).

Scoped per-tool so cross-tool field names can't bleed across branches (e.g. `build_creative`-specific `tag_url` doesn't trip the `preview_creative` branch).

11 new tests covering positive detection, each valid branch that must stay silent, and cross-tool scoping.
