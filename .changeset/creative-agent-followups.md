---
'@adcp/client': minor
---

Creative-agent ergonomics follow-ups from scope3 agentic-adapters#100 review (#844 follow-up):

**`displayRender` / `parameterizedRender` factories for `Format.renders[]`** (closes #846)

The `Format.renders[]` item schema's `oneOf` forces each entry to satisfy exactly one branch — `dimensions` (width + height) OR `parameters_from_format_id: true`. A render with only `{ role }` or `{ role, duration_seconds }` fails strict validation. Two new named exports from `@adcp/client`:

```ts
import { displayRender, parameterizedRender } from '@adcp/client';

renders: [
  displayRender({ role: 'primary', dimensions: { width: 300, height: 250 } }),  // display/video
  parameterizedRender({ role: 'companion' }),                                    // audio / template
]
```

Also **corrects a spec-non-conformant audio example that shipped in #844** — audio `renders[]` must use `parameterizedRender` and encode duration/codec in `format_id.parameters` via `accepts_parameters`, not in the render entry.

**`--strict-flags` on `adcp storyboard run`** (closes #847)

Removed-flag warnings (added in #844) stay advisory by default. `--strict-flags` upgrades them to a hard exit 2 so CI pipelines can catch stale scripts as build-breakers:

```bash
adcp storyboard run my-agent --platform-type creative_transformer --strict-flags
# DEPRECATED: --platform-type was removed in 5.1.0 ...
# ERROR: --strict-flags was set and 1 removed flag(s) were passed: --platform-type.
# exit 2
```

**`detectShapeDriftHint` on `build_creative` responses** (closes #845)

When a `build_creative` response has platform-native fields (`tag_url`, `creative_id`, `media_type`, `tag_type`) at the top level instead of `{ creative_manifest }`, the storyboard runner now attaches an actionable fix-recipe to `ValidationResult.warning` — naming `buildCreativeResponse` / `buildCreativeMultiResponse` from `@adcp/client/server` and pointing at the `creative-template` skill section. Fires on both Zod-fail (common — platform-native shape) and Zod-pass-AJV-fail paths. No change to pass/fail logic — `warning` is advisory.
