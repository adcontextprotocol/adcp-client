---
'@adcp/sdk': minor
---

feat(testing): signals/creative-delivery/creative-features seeded bridges (#1755 phase 3)

Extends `TestControllerBridge<TAccount>` with three opt-in callbacks so platform-proxy sellers can seed signals + creative read-path fixtures into conformance storyboards without driving real upstream calls:

- `getSeededSignals(ctx) → SeededSignal[]` — feeds `get_signals` (append-merge into `signals: SeededSignal[]`). Dedup key is canonical over the `signal_id` discriminated union: `${source}|${data_provider_domain|agent_url}|${id}` — catalog and agent signals with the same id remain distinct because their source discriminator differs. Works uniformly across `signal-marketplace` and `signal-owned` specialisms (one bridge, one dispatched tool; per-entry `signal_type` is the spec-level marketplace-vs-owned discriminator on the response side). No `pagination.total_count` mirror (`PaginationResponse` has none); no `query_summary` block (this tool doesn't carry one in 3.0.11). Validation drops entries with malformed or missing `signal_id` discriminators.

- `getSeededCreativeDelivery(ctx) → SeededCreativeDelivery[]` — feeds `get_creative_delivery` (append-merge into `creatives[]`, dedup by `creative_id`, seeded wins on collision). `pagination.total` (when set by the handler) updates by the count of new non-colliding seeded entries — the schema-correct field name on `GetCreativeDeliveryResponse` is `total` (distinct from `total_count` used on other list responses). No top-level aggregated-totals envelope to recompute on this response, unlike `get_media_buy_delivery`. Unblocks creative delivery readback storyboards across `creative-ad-server` / `creative-template` / `creative-generative`.

- `getSeededCreativeFeatures(ctx) → SeededCreativeFeature[]` — feeds `get_creative_features`. The response is a `oneOf` envelope: success arm carries `results: CreativeFeatureResult[]`, error arm carries `errors: Error[]`. When the handler returned the success arm, seeded `CreativeFeatureResult[]` merge into the `results` array (dedup by `feature_id`, seeded wins on collision); framework-managed envelope fields (`context`, `ext`, `detail_url`, `pricing_option_id`, `vendor_cost`, `currency`, `consumption`) round-trip from the handler verbatim — the bridge only augments per-feature evaluations. When the handler returned the error arm, the bridge is a no-op; the error envelope passes through unchanged. This is the first nested-array merge bridge (the seeded array merges into a property of the success arm, not the top-level response).

All three bridges follow the existing collision precedent (seeded wins) and the established triply-gated sandbox check (controller present + sandbox marker on request + resolved account is `sandbox: true` when `resolveAccount` produced one). `BridgeFromSessionStoreOptions` gains matching `selectSeededSignals` / `selectSeededCreativeDelivery` / `selectSeededCreativeFeatures` selectors.

`list_audiences` and `list_targeting_categories` were deliberately NOT added — neither tool exists in AdCP 3.0.11. Audience discovery is folded into `sync_audiences` (the discovery-only call omits the request `audiences` array but still returns `audiences[]`); targeting capabilities are surfaced via `get_adcp_capabilities`. No schemas exist for those names in `schemas/cache/3.0.11/`.
