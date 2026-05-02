---
"@adcp/sdk": patch
---

fix(server): drive auto-hydration off spec `x-entity` annotations instead of hardcoded field names. The framework's five hand-rolled per-tool hydration call sites in `from-platform.ts` (`update_media_buy`, `provide_performance_feedback`, `activate_signal`, `acquire_rights`, `update_rights`) collapsed onto a single `hydrateForTool(toolName, params)` helper that walks a codegen-derived `TOOL_ENTITY_FIELDS` map plus a hand-curated `x-entity → ResourceKind` table.

The annotation acts as a renaming-firewall: if a future spec rename moves `media_buy_id` → `mediabuy_id`, the `x-entity: "media_buy"` tag travels with the field; the codegen step picks up the new field name automatically. The hardcoded `(field_name, ResourceKind)` literals at each call site previously made this scenario silent breakage, flagged by protocol-expert review of #1086.

`provide_performance_feedback` now also hydrates `req.package` when the buyer scoped feedback to a package (additive — silent no-op until publishers seed `package` records). Other destination field names (`req.media_buy`, `req.creative`, `req.signal`, `req.rights`, `req.rights_grant`) preserved via an explicit override table.

`creative_approval` (webhook-only payload from #551) is filtered out of the codegen — it's not a dispatchable tool. A regression test asserts every `x-entity` value in `TOOL_ENTITY_FIELDS` is either mapped to a `ResourceKind` or in the documented `INTENTIONALLY_UNHYDRATED_ENTITIES` allowlist, so a future spec entity tag can't silently bypass hydration.

Closes #1109.
