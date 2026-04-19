---
'@adcp/client': patch
---

Storyboard runner: enforce a brand/account invariant on every outgoing request.

Sellers that scope session state by brand (required for per-tenant isolation) derive a session key from `brand.domain`. Before this fix, a storyboard's `create_*` step could send one brand while the follow-up `get_*` / `update_*` / `delete_*` / `validate_*` step sent another — or omitted brand entirely and hit the default `test.example`. The list created in one session was then invisible to the lookup in a different session, surfacing as `NOT_FOUND` across `property_governance`, `collection_governance`, `media_buy_seller`, and any storyboard that exercises stateful CRUD.

The runner now merges `options.brand` into every request after builder / `sample_request` resolution, overriding any conflicting brand and filling in `account.brand` when the request carries an `account` object. A storyboard run now lands in one session regardless of per-tool authorship. Storyboards that don't configure a brand (e.g. `universal/security.yaml` probes) pass through unchanged.

Fixes #579.
