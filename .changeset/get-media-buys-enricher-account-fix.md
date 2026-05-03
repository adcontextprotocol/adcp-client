---
"@adcp/sdk": patch
---

fix(conformance): get_media_buys and get_media_buy_delivery enrichers now resolve account via resolveAccount(options)

Adds both enrichers to FIXTURE_AWARE_ENRICHERS and uses `context.account ?? resolveAccount(options)` for account resolution, matching the pattern already used by create_media_buy. Previously, the generic fixture-authoritative merge let the fixture's raw account block (which may lack sandbox:true) override the harness-resolved account, causing namespace mismatches on the create→get round-trip and resulting in targeting_overlay store misses.

Fixture fields other than account are preserved via an explicit spread, so storyboards that author filters, status, or pagination fields continue to work.

Fixes #1487.
