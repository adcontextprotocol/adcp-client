---
"@adcp/client": minor
---

Add storyboards, scenarios, and SDK helpers covering AdCP 3.0 primitives

- New `collection_governance` storyboard for collection list CRUD, webhook delivery, and targeting via `CollectionListReference`
- New `media_buy_seller/measurement_terms_rejected` scenario exercising the `TERMS_REJECTED` round-trip: buyer proposes unworkable terms, seller rejects, buyer retries with seller-compatible terms
- New `media_buy_seller/governance_denied_recovery` scenario verifying the buyer can correct a denied buy and retry within plan limits
- New `media_buy_seller/pending_creatives_to_start` scenario validating the `pending_creatives → pending_start` transition after `sync_creatives`
- New `media_buy_seller/inventory_list_targeting` scenario exercising `property_list` + `collection_list` targeting on both `create_media_buy` AND `update_media_buy` (catches create/update parity regressions) and verifying persistence via `get_media_buys`
- New `media_buy_seller/inventory_list_no_match` scenario covering the case where referenced lists resolve to zero matching inventory — seller must return a zero-forecast product or an informative error, not crash
- New `signal_marketplace/governance_denied` and `brand_rights/governance_denied` scenarios covering governance across signal activation and rights licensing purchase types
- Extended `error_compliance` with a `version_negotiation` phase that validates `VERSION_UNSUPPORTED` on an unsupported `adcp_major_version` and acceptance of a supported one
- New `media_buy_seller/invalid_transitions` scenario with hard `error_code` assertions for `MEDIA_BUY_NOT_FOUND`, `PACKAGE_NOT_FOUND`, and `NOT_CANCELLABLE` (state-machine hardening)
- Hardened existing `error_compliance` probes (`negative_budget`, `reversed_dates_error`, `nonexistent_product`) from soft `field_present: errors` to specific `error_code` assertions via `allowed_values`
- `check: error_code` validations now accept `allowed_values` in addition to `value`, so scenarios can assert one-of for semantically overlapping codes (e.g. `VALIDATION_ERROR` vs `INVALID_REQUEST`)
- Wired new scenarios into parent storyboards via `requires_scenarios`
- Extended `fictional-entities.yaml` with a `collections` section (outdoor, automotive, and food programming) so storyboards have canonical test data for `collection_list` targeting
- Extended `test-kits/acme-outdoor.yaml` with an `inventory_targets` section providing matching and non-matching `PropertyListReference` / `CollectionListReference` fixtures
- Added `resolvePropertyList` / `resolveCollectionList` / `matchesPropertyList` / `matchesCollectionList` helpers to `@adcp/client/server` so seller handlers can filter inventory against buyer-supplied list references in one line
