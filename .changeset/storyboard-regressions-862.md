---
'@adcp/client': patch
---

Two storyboard regressions from the 5.14 train (closes #862).

- **Schema loader**: `sync_plans`, `check_governance`, `acquire_rights`,
  `create_property_list`, and every other tool whose request schema
  lives in a flat-tree domain directory (`governance/`, `brand/`,
  `property/`, `collection/`, `content-standards/`, `account/`, …) now
  compiles cleanly regardless of sibling `$ref`s. Previously the loader
  pre-registered only `core/` and `enums/` before compile; refs like
  `governance/sync-plans-request.json` → `governance/audience-constraints.json`
  threw `can't resolve reference` at AJV compile time.

  `ensureCoreLoaded` now walks every directory outside `bundled/` and
  pre-registers non-tool JSON fragments — covering `core/`, `enums/`,
  `pricing-options/`, `error-details/`, `extensions/`, and every
  flat-tree domain's sibling building blocks. Tool request/response
  files stay lazy-compiled so `relaxResponseRoot` still applies.

- **`create_media_buy` enricher**: fixture package identifiers now win
  over discovery-derived values. When a storyboard authors
  `packages[0].product_id`, `packages[0].pricing_option_id`, or
  `packages[0].bid_price`, the enricher no longer overrides them with
  the first discovered product's fields. Discovery still fills gaps
  when the author omits per-package identifiers — the behavior
  single-package storyboards against arbitrary sellers rely on. Closes
  the 5.14 regression where a seller's `get_products`-returned
  `pricing_options[0].pricing_option_id` (e.g.
  `pinnacle_news_video_premium_pricing_0`) replaced the fixture's
  explicit value (e.g. `cpm_guaranteed`) and created-buy failed with
  `INVALID_REQUEST`.

  The fixture-authoritative refactor (#816) set this direction for
  top-level fields but the `create_media_buy` nested-package merge
  kept the prior builder-authoritative precedence. Now aligned.
