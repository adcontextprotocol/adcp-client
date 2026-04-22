---
'@adcp/client': patch
---

Fix storyboard `REQUEST_BUILDERS` for `log_event` and `create_media_buy` so they emit spec-conformant payloads and honor hand-authored `step.sample_request` — framework-dispatch agents running zod at the MCP boundary previously rejected these with `-32602 invalid_type` (#793).

- **`log_event`** now honors `step.sample_request` when present (same convention as `sync_catalogs`, `update_media_buy`, `report_usage`). The synthetic fallback emits `event_time` (was `timestamp`) and places `value` + `currency` under `custom_data` (was nested `value: { amount, currency }`). Unblocks `sales_catalog_driven` and `sales_social` storyboards whose authored events carried `event_time`, `content_ids`, and spec-shaped siblings that the builder was discarding.
- **`create_media_buy`** now emits every authored package instead of dropping `packages[1+]`. The first package still receives context-derived `product_id` / `pricing_option_id` overrides (so single-package storyboards against arbitrary sellers keep working); additional packages pass through with context injection only, preserving per-package `product_id`, `bid_price`, `pricing_option_id`, and `creative_assignments`. Unblocks multi-package storyboards (e.g. `sales_non_guaranteed`) where `context_outputs` captured `packages[1].package_id` as `second_package_id` — the next step was being skipped with "unresolved context variables from prior steps".

Surfaced while diagnosing adcontextprotocol/adcp#2872.
