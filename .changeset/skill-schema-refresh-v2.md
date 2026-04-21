---
'@adcp/client': patch
---

Follow-up to the skill schema refresh (PR #716) targeting matrix failures that persisted:

- **`DEFAULT_REPORTING_CAPABILITIES` over hand-rolled literals** — seller, generative-seller, and retail-media skill product examples previously hand-rolled `reporting_capabilities: { ... }` which drifts every time the spec adds a required field (most recently `date_range_support` in AdCP latest). Skills now use the SDK-provided constant and flag the drift tax explicitly.
- **`create_media_buy` must persist `currency` + `total_budget`** — seller skill's `createMediaBuy` example flattens request `total_budget: { amount, currency }` into top-level `currency` + `total_budget` fields on the persisted buy, so subsequent `get_media_buys` responses pass the new required-field schema check. The old example stored only `packages[].budget` and the required top-level fields weren't reconstructable.
- **`update_media_buy.affected_packages` must be `Package[]`, not `string[]`** — seller skill's `updateMediaBuy` example now returns package objects (`{ package_id, ... }`) instead of bare IDs. The `update-media-buy-response` oneOf discriminator rejects string arrays with `/affected_packages/0: must be object`.
