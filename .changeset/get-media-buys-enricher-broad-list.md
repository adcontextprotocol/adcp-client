---
'@adcp/client': patch
---

**Fix `get_media_buys` and `get_media_buy_delivery` storyboard enrichers injecting `media_buy_ids: ["unknown"]` when no context ID is present (#983).** Both enrichers unconditionally built `media_buy_ids: [context.media_buy_id ?? 'unknown']`. When a storyboard tests the broad-list/pagination path (no IDs in `sample_request`), the fixture-wins merge (`{ ...enriched, ...fixture }`) could not clear the injected placeholder because the fixture simply omitted the key. Agents received `media_buy_ids: ["unknown"]`, returned 0 matches, and storyboard `pagination.has_more` assertions failed.

Both enrichers now omit `media_buy_ids` entirely when `context.media_buy_id` is absent, matching the pattern used by `list_creatives` and `list_accounts`. When a real ID is present the behavior is unchanged. This unblocks the `get-media-buys-pagination-integrity` storyboard in `adcontextprotocol/adcp#3122` from upgrading to its intended multi-page seeded walk.
