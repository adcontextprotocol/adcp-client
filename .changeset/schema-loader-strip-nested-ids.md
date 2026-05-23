---
'@adcp/sdk': patch
---

fix(validation): unblock 14 tool validators from Ajv ambiguous-ref on bundled responses (#1950 item 1)

The production schema-loader compiles each tool's response/request schema lazily via Ajv. For tools whose responses live in the spec's `bundled/` subtree (those whose `$ref`s the spec publishes fully inlined), the bundled `.json` file embeds every referenced subschema with its **canonical `$id`** — e.g. `core/version-envelope.json` appears as a nested schema inside `bundled/signals/activate-signal-response.json`, with the same `$id` as the standalone `core/version-envelope.json`.

Once `ensureCoreLoaded` has run (which happens whenever any non-bundled tool, like `acquire_rights` / `get_brand_identity` / property-list tasks, is compiled — they live in flat domain trees and need `core/*` pre-registered for `$ref` resolution), the standalone core schemas are in Ajv's registry. Subsequent compile of a bundled tool response then trips Ajv's `checkAmbiguousRef` on every nested `$id` that already exists standalone.

Net effect: 14 tools (`activate_signal`, `build_creative`, `create_media_buy`, `get_adcp_capabilities`, `get_creative_delivery`, `get_media_buys`, `list_creative_formats`, `list_creatives`, `preview_creative`, `sync_audiences`, `sync_catalogs`, `sync_creatives`, `sync_event_sources`, `update_media_buy`) could not have their responses validated at all on the SDK's production loader once any flat-tree tool had been touched in the same process. Validation calls would throw `reference "/schemas/3.1.0-beta.3/core/<x>.json" resolves to more than one schema`.

**The fix**: bundled response files explicitly declare themselves as inlined (`"note": "This is a bundled schema with all $ref resolved inline"`) and carry **no internal `$ref`s** at all. The nested `$id`s are vestigial spec-build artifacts — Ajv only needs the root `$id` for validator lookup. The loader now strips every nested `$id` from bundled files before passing them to `ajv.compile`, preserving only the root `$id`.

The strip is a deep-copy walk so the on-disk schema cache is untouched, and is gated on `file.includes('/bundled/')` so flat-tree schemas (which DO have `$ref`s and need their nested registrations to resolve) are unaffected.

**Tests flipped back on**: `test/validation-oneof-cascade.test.js` — the 14-tool `SCHEMA_LOADER_AMBIGUOUS_REF_SKIP` carve-out added in #1949 is removed; all 31 tests now run and pass.
