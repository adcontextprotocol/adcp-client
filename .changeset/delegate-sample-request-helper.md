---
'@adcp/client': patch
---

refactor(testing): extract `delegateSampleRequest` helper and enforce the contract across all storyboard builders

The storyboard runner's rule — **if a storyboard authors `sample_request`, pass it through (after context injection) instead of overwriting with synthesized data** — was previously open-coded in 18 builders, with three separate behaviors:

- Pattern A (5 builders): delegate **with** account injection
- Pattern B (13 builders): delegate **without** account injection
- Pattern C (10 builders): silently **ignore** `sample_request`

The inconsistency is the class of bug behind #818 and #821 — every time a storyboard authored a specific id for a builder that ignored `sample_request`, downstream steps broke with `*_NOT_FOUND`.

This change introduces a single `delegateSampleRequest(step, context, options, { withAccount })` helper. Every builder now either:

1. Calls `delegateSampleRequest` (default behavior — honors authored `sample_request`), or
2. Appears in the new `INLINE_SAMPLE_REQUEST_BUILDERS` allowlist because it consumes `sample_request` inline (`create_media_buy`, `get_products`, `get_brand_identity`, `get_signals`, `activate_signal`, `comply_test_controller`).

A new coverage test walks every builder and asserts the contract, so the next builder that forgets to honor `sample_request` fails the test instead of shipping.

Side effects:

- Fixes `sync_event_sources` (previously Pattern C; subsumes #819).
- Previously Pattern C builders (`sync_accounts`, `list_accounts`, `get_media_buys`, `get_media_buy_delivery`, `list_creatives`, `preview_creative`, `list_content_standards`, `get_content_standards`, `get_account_financials`, `get_adcp_capabilities`) now honor `sample_request` when authored. No storyboard currently exposes a behavior change on these, but future authoring works correctly.

Exports `INLINE_SAMPLE_REQUEST_BUILDERS` and `listRequestBuilders()` from `@adcp/client/testing/storyboard/request-builder` for tooling that introspects builders.
