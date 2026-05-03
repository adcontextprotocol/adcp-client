---
'@adcp/sdk': minor
---

Add `examples/hello_creative_adapter_ad_server.ts` — worked starting point for an AdCP creative agent (specialism `creative-ad-server`). Closes #1460 (sub-issue of #1381 hello-adapter-family completion).

Pattern: GAM-creative / Innovid / Flashtalking / CM360 model — stateful library + tag generation. The structural delta from `hello_creative_adapter_template.ts` is additive: promotes `CreativeBuilderPlatform` → `CreativeAdServerPlatform`, adds `listCreatives` + `getCreativeDelivery` + stateful `syncCreatives` library, replaces template-driven `buildCreative` with macro-substitution flow against a stored snippet template.

Implements all 6 `CreativeAdServerPlatform` methods:

- `buildCreative` — pulls stored snippet from `GET /v1/creatives/{id}`, calls upstream `POST /v1/creatives/{id}/render` for macro substitution, returns `BuildCreativeSuccess` with `creative_manifest.assets` carrying the rendered HTML tag.
- `previewCreative` — `NoAccountCtx` no-account tool; returns a real iframe-embeddable URL pointing at the mock's `/serve/{id}` endpoint.
- `listCreativeFormats` — `NoAccountCtx`; projects upstream catalog to closed-shape `Format.renders[]` (display fixed dimensions, video/CTV 1080p baseline, parameterized 1×1 placeholder).
- `syncCreatives` — wraps `POST /v1/creatives`. Library write. `creative_id` round-tripped to upstream `client_request_id`. Typed `CREATIVE_REJECTED` errors when format auto-detection fails.
- `listCreatives` — wraps `GET /v1/creatives` with cursor pagination. `filter.creative_ids[]` multi-id pass-through (#1410). Projects to `query_summary` + `pagination` + `creatives[]` per `tools.generated.ListCreativesResponse`.
- `getCreativeDelivery` — wraps `GET /v1/creatives/{id}/delivery`. Multi-id fan-out per `filter.creative_ids[]`. Returns currency + reporting_period + per-creative impressions/clicks rows.

Auth + multi-tenant routing: static Bearer; `accounts.resolve` translates `ref.brand.domain` → `X-Network-Code` via `GET /_lookup/network`. No-account tools fall back to `KNOWN_PUBLISHERS[0]` so `previewCreative` / `listCreativeFormats` resolve cleanly. Sandbox arm in `accounts.resolve` stamps `mode: 'sandbox'` (#1435 phase 3 posture); `account_id` arm routes any opaque id to the ACME network so storyboard fixtures referencing seeded ids resolve cleanly.

`comply_test_controller` wired via `complyTest:` config — `seed.creative` adapter forwards storyboard fixture entries (`controller_seeding: true`) to the upstream library via `POST /v1/creatives` with the caller-supplied `creative_id` override (test-only path on the mock).

Three-gate CI test (`test/examples/hello-creative-adapter-ad-server.test.js`) lands alongside: strict tsc / `creative_ad_server` storyboard / upstream-traffic façade. All seven storyboard steps pass on first build (no SDK gaps deferred).

The mock's `POST /v1/creatives` gains a TEST-ONLY `creative_id` override field so cascade fixtures can reference seeded creatives by their declared alias instead of resolving server-assigned ids. Production-shipped servers should reject this field; the override is gated by being optional + undocumented in the public OpenAPI surface.
