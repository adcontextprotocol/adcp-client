---
'@adcp/sdk': minor
---

`adcpError()` and the `{errors:[...]}` typed Error arm now both ship the
two-layer wire shape required by 18 AdCP response schemas
(`{adcp_error: {...}, errors: [{...}]}` instead of envelope-only or
payload-only). Adopters keep calling `adcpError()` and returning typed
Error arms exactly as before — the framework dispatcher derives the
affected tools from the bundled schema cache at server build, then
mirrors `adcp_error` ↔ `errors[]` in the `finalize()` seam on the
failure path so both spec-mandated layers ride on every failing
response.

The wire change is on the failure path only and is strictly additive:
responses that previously failed schema validation against the
`*Error` arm of their `oneOf` now pass it. Adopters who already emit
both layers manually are detected and pass through unchanged
(idempotent — no duplicate or replacement). Tools whose response
schema does NOT declare an Error arm (e.g. `get_products`,
`get_signals`, `tasks/get`) are untouched. No adopter code changes
required.

Eighteen tools auto-wrap: `create_media_buy`, `update_media_buy`,
`provide_performance_feedback`, `build_creative`, `sync_audiences`,
`sync_catalogs`, `sync_event_sources`, `log_event`, `activate_signal`,
`sync_creatives`, `get_creative_features`, `validate_content_delivery`,
`list_content_standards`, `get_media_buy_artifacts`,
`get_content_standards`, `create_content_standards`,
`update_content_standards`, `calibrate_content`. The set is derived
dynamically — future AdCP minors that add Error-arm tools join
automatically.

`update_content_standards` is the lone tool whose Error arm carries a
`success: false` discriminator alongside `errors[]`; the dispatcher
stamps the constant when synthesising so the payload satisfies its
`oneOf` discriminator.

Migration recipe: `docs/migration-6.14-to-6.15.md`. RFC:
`docs/proposals/adcperror-two-layer-emission.md`. Closes #1606.
