---
'@adcp/client': minor
---

Follow upstream AdCP 3.0 account migration (adcontextprotocol/adcp#2336) across
storyboard runner, generated types, and property-list adapter.

**Storyboard runner — property-list builders removed.** The hardcoded request
builders for `create_property_list`, `get_property_list`, `update_property_list`,
`list_property_lists`, `delete_property_list`, and `validate_property_delivery`
injected a top-level `brand:` field that is no longer part of those request
schemas (replaced by `account`). The client stripped `brand` against any agent
built to current spec, session keying collapsed, and every post-create step in
the `property-lists` storyboard failed with `NOT_FOUND`. The builders are
removed so the runner falls through to each step's `sample_request` (spec-correct
`account` primitive), matching how `collection_list` tools have always worked.
Fixes [#577](https://github.com/adcontextprotocol/adcp-client/issues/577).

**Generated types regenerated** from upstream `latest.tgz` to pick up the
account migration, new `signed-requests` specialism, and `request_signing`
capability field on `GetAdCPCapabilitiesResponse`.

**Public API**

- `BudgetAuthorityLevel` type is removed — upstream no longer defines it.
- `DelegationAuthority` is re-exported from `./types/core.generated` (moved
  upstream; the re-export path is the only change for consumers).

**Property-list adapter (`@adcp/client/server`)**

- `PropertyListAdapter.listLists` now filters by the `account` primitive instead
  of the removed `principal` field. Both `account_id` and `brand+operator`
  shapes are matched.
