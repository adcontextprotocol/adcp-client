---
'@adcp/client': patch
---

Fix storyboard runner injecting deprecated `brand:` on property-list tool calls.

The hardcoded request builders for `create_property_list`, `get_property_list`,
`update_property_list`, `list_property_lists`, `delete_property_list`, and
`validate_property_delivery` injected a top-level `brand:` field that is no
longer part of those request schemas (AdCP removed the workaround-era `brand`
in favor of `account` via adcontextprotocol/adcp#2336). The client was
stripping `brand` against any agent built to current spec, session keying
collapsed, and every post-create step in the `property-lists` storyboard
failed with `NOT_FOUND`.

The builders are removed so the runner falls through to each step's
`sample_request` (which carries the spec-correct `account` primitive). This
mirrors `collection_list`, which has never had hardcoded builders for the
same reason.

Fixes [#577](https://github.com/adcontextprotocol/adcp-client/issues/577).
