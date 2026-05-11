---
"@adcp/sdk": patch
---

fix(creative): `CreativeBuilderPlatform` no longer advertises `list_creatives`, `get_creative_delivery`, or `sync_creatives` in `tools/list` when those methods are absent from the platform implementation.

Previously, `buildCreativeHandlers` unconditionally attached handler stubs for these three tools regardless of platform archetype, causing them to appear in `tools/list` for every creative agent — including stateless builder/transform agents that never had these methods. Buyer agents would call them, receive `UNSUPPORTED_FEATURE`, and burn retry attempts against tools that were never callable. The fix conditionalises handler registration on method presence, matching the pattern already used by `buildAccountHandlers`.
