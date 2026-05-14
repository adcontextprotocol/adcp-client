---
'@adcp/sdk': minor
---

feat(testing): governance/property-lists/content-standards/collection-lists seeded bridges (#1755 phase 2)

Extends `TestControllerBridge<TAccount>` with three opt-in callbacks so platform-proxy sellers can seed governance-domain fixtures into conformance storyboards without driving real upstream calls. The same seeded array feeds the list AND get path for each entity:

- `getSeededPropertyLists(ctx) → PropertyList[]` — feeds both `list_property_lists` (append-merge by `list_id`, seeded wins on collision; updates `pagination.total_count` by the non-colliding seeded count) and `get_property_list` (singleton replace: pick by `request.list_id` matching entry `list_id`, replace the response's `list` field while preserving handler's `identifiers` / `pagination` / `resolved_at` / `cache_valid_until` / `coverage_gaps` / `context` / `ext`). Unblocks the `property-lists` and `governance-aware-seller` storyboards.

- `getSeededCollectionLists(ctx) → CollectionList[]` — feeds both `list_collection_lists` and `get_collection_list` with the same shape as property lists (dedup key `list_id`, identical envelope-preservation policy on singleton replace). Unblocks the `collection-lists` storyboard (program-level brand safety via IMDb/Gracenote/EIDR IDs).

- `getSeededContentStandards(ctx) → ContentStandards[]` — feeds both `list_content_standards` (success arm `standards: ContentStandards[]`, append-merge by `standards_id`, seeded wins on collision; `pagination.total_count` updates) and `get_content_standards` (singleton replace; success arm IS `ContentStandards` directly with no envelope wrapper, so the entire response is replaced — only handler `ext` is preserved, mirroring `replaceAccountFinancialsIfSeeded`'s framework-managed-envelope-fields-win policy). Unblocks the `content-standards` storyboard.

All three bridges follow the existing collision precedent (seeded wins) and the established triply-gated sandbox check (controller present + sandbox marker on request + resolved account is `sandbox: true` when `resolveAccount` produced one). `BridgeFromSessionStoreOptions` gains matching `selectSeededPropertyLists` / `selectSeededCollectionLists` / `selectSeededContentStandards` selectors.

`list_authorized_properties` was deliberately NOT added — that tool was removed from AdCP and replaced by the `get_adcp_capabilities` discovery path; no schema exists in `schemas/cache/3.0.11/`.
