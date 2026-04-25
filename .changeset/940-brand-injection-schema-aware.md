---
'@adcp/client': patch
---

**Fix storyboard runner injecting `brand`/`account` into tools whose request schemas declare `additionalProperties: false` (#940).** The storyboard runner's `applyBrandInvariant` helper unconditionally injected `brand` (and a synthetic `account` when none was present) into every outgoing request. Tools like `sync_plans`, `list_property_lists`, and `delete_property_list` have strict request schemas that do not include these fields. Before v5.17.0 this was silently tolerated (request validation defaulted to `'warn'`); PR #909 flipped the default to `'strict'`, causing 11 storyboards to regress with `VALIDATION_ERROR: must NOT have additional properties`.

`applyBrandInvariant` now accepts an optional `taskName` and consults the raw request schema JSON to decide which fields are safe to inject. It skips top-level `brand` injection when the schema declares `additionalProperties: false` and does not list `brand` in `properties`; similarly for the synthetic `account` construction. Tools that do declare these fields (e.g. `get_products`, `create_media_buy`) are unaffected. Fails open when schemas are unavailable (not synced) or `taskName` is omitted, preserving backwards compatibility.

A new exported helper `schemaAllowsTopLevelField(toolName, field)` is added to `schema-loader.ts` for this purpose; it reads raw JSON without touching AJV internals.
