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

For `get_media_buy_delivery` (which requires `media_buy_ids` per the
spec), the same change converts the silent NOT_FOUND failure mode
(when no real ID was in context) into a surfacing INVALID_REQUEST
that authors can debug.

**Behavior**:

- Context has a real `media_buy_id` → enricher injects it (unchanged).
- Context lacks one → enricher returns `{}`; fixture's `sample_request`
  is authoritative. If the fixture also omits the field, the
  request goes out without `media_buy_ids` (broad-list path for
  `get_media_buys`; spec violation for `get_media_buy_delivery` that
  the agent rejects cleanly).

**Tests** (`test/lib/request-builder.test.js`): 8 new cases
covering injection, broad-list pass-through, fixture precedence,
empty-string context guard, and the cross-spec behavior on the two
enrichers.

Unblocks `adcontextprotocol/adcp#3122` (get_media_buys pagination
conformance storyboard) — once this fix ships, the storyboard can
return to its multi-page walk against the broad-list path.
