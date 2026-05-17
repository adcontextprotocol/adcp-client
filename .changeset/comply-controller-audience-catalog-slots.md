---
'@adcp/sdk': minor
---

Add `force.audience_status` and `force.catalog_item_status` slots to `ComplyControllerConfig` (issue #1819).

Adopters wiring `comply_test_controller` through `createComplyController` now have a registration slot for the two resource families that previously forced hand-rolled dispatchers — audience-sync (`forceAudienceStatus`) and catalog-driven seller (`forceCatalogItemStatus`). Both are exposed via the same domain-grouped `force` block as the existing creative/account/media-buy/session slots, and the underlying `TestControllerStore` interface gains matching optional methods so flat-store callers can opt in the same way.

The new scenarios (`force_audience_status`, `force_catalog_item_status`) are treated as extension scenarios — accepted by the dispatcher under `TOOL_INPUT_SHAPE.scenario: z.string()` and advertised via `list_scenarios` when the adapter is registered, but not yet members of `CONTROLLER_SCENARIOS` because the schema cache's `ListScenariosSuccess['scenarios']` union hasn't picked them up. Same pattern as `query_upstream_traffic`. Status values validate against the spec-shipped `AudienceStatusSchema` / `CatalogItemStatusSchema`, so when adcp#2860's offline values (`suspended` / `withdrawn`) land in the spec and codegen reruns, the new transitions flow through with no further SDK change.

Purely additive — existing adopters keep working without modification.
