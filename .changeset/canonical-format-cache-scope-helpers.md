---
'@adcp/sdk': minor
---

Expose canonical creative format migration helpers and get_products cache-scope helpers.

Adds the `CanonicalFormat` namespace plus projection subpath builder helpers for authoring `format_options[]` and v1 fallback refs, exports the existing projection/write-side helpers from the package root, and adds `ensureGetProductsCacheScope()` / `validateGetProductsCacheScope()` for storefronts composing legacy upstream product feeds.

Also widens `SyncCreativesPayload` to include operation-level `SyncCreativesError` payloads and adds explicit `list_creative_formats` server payload aliases.
