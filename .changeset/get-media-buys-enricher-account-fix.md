---
"@adcp/sdk": patch
---

fix(conformance): get_media_buys and get_media_buy_delivery enrichers now resolve account via resolveAccount(options); create_media_buy context extractor now captures package_id

Adds both enrichers to FIXTURE_AWARE_ENRICHERS and uses `context.account ?? resolveAccount(options)` for account resolution, matching the pattern already used by create_media_buy. Previously, the generic fixture-authoritative merge let the fixture's raw account block (which may lack sandbox:true) override the harness-resolved account, causing namespace mismatches on the create→get round-trip and resulting in targeting_overlay store misses.

Fixture fields other than account are preserved via an explicit spread, so storyboards that author filters, status, or pagination fields continue to work.

The create_media_buy context extractor now extracts packages[0].package_id from the create response into `context.package_id`. This allows subsequent steps (e.g. update_media_buy) to use `$context.package_id` substitution with the seller-assigned id, rather than receiving the literal placeholder string. Without this, createMediaBuyStore.mergeFromUpdate stored the overlay under the wrong key and backfill on get_after_update found nothing.

Fixes #1487. Fixes #1505.
