---
'@adcp/client': patch
---

Fix `get_media_buys` and `get_media_buy_delivery` request enrichers
to skip injection when context lacks a real `media_buy_id`. Closes
#983.

The pre-fix enrichers always returned
`{ media_buy_ids: [context.media_buy_id ?? 'unknown'] }`. When a
storyboard's `sample_request` omitted `media_buy_ids` (broad-list
pagination tests), the merge `{ ...enriched, ...fixture }` kept the
enricher's `["unknown"]` because the fixture didn't override it. The
agent received a placeholder ID, returned 0 matches, and the
storyboard's `pagination.has_more` assertion failed.

Per `get-media-buys-request.json` the field is optional
(`minItems: 1`); omitting it asks for "a paginated set of accessible
media buys matching status_filter" — a conformant broad-list query.
The fix mirrors how peer paginated-read enrichers
(`list_creatives`, `list_creative_formats`, `list_accounts`,
`get_signals`) already operate: don't fabricate IDs.

`get-media-buy-delivery-request.json` likewise has no top-level
`required[]` — `media_buy_ids` is optional there too. The pre-fix
`'unknown'` placeholder produced phantom NOT_FOUND responses on
storyboards that omitted the field (the seller's `x-entity:
media_buy` resolution couldn't find the placeholder); the
empty-enricher post-fix lets fixtures be authoritative. Storyboards
that intend to filter delivery by id must now declare
`media_buy_ids` explicitly in `sample_request`.

**Behavior**:

- Context has a real `media_buy_id` → enricher injects it (unchanged).
- Context lacks one → enricher returns `{}`; fixture's `sample_request`
  is authoritative. If the fixture also omits the field, the
  request goes out without `media_buy_ids` — both endpoints accept
  this; the seller returns a broad result set or applies its own
  default scoping.

**Migration**:

Storyboards that previously relied on `media_buy_ids: ['unknown']`
being coerced into a NOT_FOUND must now supply a real id via prior-
step context (e.g. via `context_outputs.media_buy_id` on a preceding
`create_media_buy`) or declare an explicit invalid id in
`sample_request`. The phantom-NOT_FOUND path was always a bug; any
storyboard that depended on it was masking an authoring gap.

**Tests** (`test/lib/request-builder.test.js`): 8 new cases
covering injection, broad-list pass-through, fixture precedence,
empty-string context guard, and the cross-spec behavior on the two
enrichers.

Unblocks `adcontextprotocol/adcp#3122` (get_media_buys pagination
conformance storyboard) — once this fix ships, the storyboard can
return to its multi-page walk against the broad-list path.
