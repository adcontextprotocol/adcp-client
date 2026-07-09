---
'@adcp/sdk': patch
---

fix(runtime): `list_accounts` projects `CursorPage` into the `pagination` block instead of top-level `next_cursor`

Both 3.0 and 3.1 `list-accounts-response` model pagination via `pagination: { has_more, cursor?, total_count? }` referencing `core/pagination-response.json`. The prior projector emitted `next_cursor` at the top level — schema-invisible under `additionalProperties: true`, but every adopter silently failed the `pagination_integrity_list_accounts` storyboard's `field_value pagination.has_more: true` + `field_present pagination.cursor` assertions regardless of `accounts.list` output. Fixes adcontextprotocol/adcp#5723.
