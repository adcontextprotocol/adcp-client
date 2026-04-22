---
'@adcp/client': patch
---

Cycle-A fixes from matrix v12 failure analysis:

**SDK**: `TaskExecutor.normalizeResponseForValidation` now strips underscore-prefixed client-side annotations (`_message`, future `_*` fields) before running AJV schema validation. These are added by the response unwrapper as text-summary hints; they're not part of the wire protocol. Schemas with `additionalProperties: false` (`create-property-list-response`, `create-collection-list-response`, etc.) would otherwise reject every response reaching the grader's schema check. Fixes 6 v12 failures across governance property-list CRUD.

**Skills**: added a "Cross-cutting pitfalls matrix runs keep catching" block to each `build-*-agent/SKILL.md` inside the existing imperative callout. Each skill lists the specific patterns Claude drifted on in matrix v12 runs — targeted per tool surface:

- `capabilities.specialisms` is `string[]` of enum ids, NOT `[{id, version}]` objects (all 8 skills)
- `get_media_buy_delivery` requires top-level `currency: string` (seller, retail-media, generative-seller)
- `build_creative` returns `{creative_manifest: {format_id, assets}}`, not sync_creatives-style fields (creative, generative-seller)
- Each asset in `creative_manifest.assets` requires an `asset_type` discriminator (creative, generative-seller)
- Mutating-tool responses have `additionalProperties: false` — don't add extra fields (governance)

These live inside the imperative "fetch docs/llms.txt before writing return" callout so they're adjacent to where Claude scans for shape info.
