---
'@adcp/client': patch
---

**Fix `get_media_buys` convention extractor poisoning context during multi-page pagination walks (#998).** The extractor unconditionally captured `media_buys[0].media_buy_id` from every successful `get_media_buys` response. When a storyboard walks multi-page results, the page-1 response carries `pagination.has_more: true` — buys[0] is not the canonical buy, it is just the first item in a list slice. The captured ID was then picked up by the request-builder enricher on step 2 and injected as `media_buy_ids: [that_id]`, turning the pagination continuation into a single-ID lookup. The agent returned one buy with `has_more: false, total_count: 1`, failing `total_count: 3` storyboard assertions.

The extractor now skips extraction when `pagination.has_more === true`, matching the conservative `=== true` convention used elsewhere in the codebase (`hasMorePages()` in `validations.ts`). When `has_more` is absent or `false` — i.e., a terminal or single-page response — extraction proceeds as before. This unblocks `get-media-buys-pagination-integrity` in `adcontextprotocol/adcp#3122` from upgrading to the seeded multi-page walk model used by `list_creatives` and other paginated storyboards.
