---
'@adcp/client': patch
---

Testing: schema-driven round-trip invariant for every storyboard request builder, plus fallback fixes so each builder's fallback round-trips through the generated Zod schema.

Adds `test/lib/request-builder-schema-roundtrip.test.js` that iterates every task in `TOOL_REQUEST_SCHEMAS` (plus `creative_approval` and `update_rights`) and asserts the fallback request — empty context, empty `sample_request`, synthetic `idempotency_key` where required — parses cleanly against the matching schema from `src/lib/types/schemas.generated.ts`. New builders are picked up automatically.

Running the invariant surfaced eight pre-existing fallbacks that had drifted out of spec. Fixed:

- `update_media_buy` packages fallback now sets `package_id`.
- `update_rights` / `creative_approval` fallbacks use `rights_id` (the spec field) instead of `rights_grant_id`; `creative_approval` now emits `creative_url` + `creative_id`.
- `sync_creatives` fallback assets carry the required `asset_type` discriminator (`image` / `video` / `text`). `buildAssetsForFormat` uses spec-correct video fields (`duration_ms`, `container_format`, `width`, `height`).
- `calibrate_content` / `validate_content_delivery` artifacts use `assets: []` (the schema is an array of typed assets, not an object map).
- `activate_signal` defaults `destinations` to a placeholder agent entry so the fallback path satisfies the schema's required array.
- `create_content_standards` / `update_content_standards` fallbacks align with the current `scope` + `policies` shape (old schema used `name` + `rules`).
- `si_get_offering` / `si_initiate_session` pass `options.si_context` through the schema's `intent` (string) field instead of the wire-level `context` slot that the spec types as `ContextObject`; `si_initiate_session` now emits the required `intent`.

Closes #803.
