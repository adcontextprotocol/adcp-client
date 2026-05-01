---
"@adcp/sdk": patch
---

fix(server): per-account SeedFixtureCache scoping for multi-tenant servers

The comply-controller's `SeedFixtureCache` previously keyed by `seed_<scenario>:${id}` (process-wide). Two sandbox accounts on one server (e.g., a single-tenant server with multiple sandbox accounts, or a multi-tenant host that doesn't shard servers per tenant) couldn't seed the same `id` with divergent fixtures — the second seed returned `INVALID_PARAMS` ("Seed replays must carry an equivalent fixture") even though each account's fixture was internally consistent.

`handleTestControllerRequest` now extracts `account.account_id` from the input envelope and prefixes the cache key with it. Same-account replays still hit the equivalent-fixture path (returns `Fixture re-seeded (equivalent)`); cross-account same-id divergent fixtures now succeed cleanly.

Backward-compatible: requests without `account.account_id` still use unscoped keys, preserving existing behavior for adopters who don't pass account refs into seed calls.

Closes #1215.
