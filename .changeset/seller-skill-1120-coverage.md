---
'@adcp/sdk': patch
---

Seller skill (`skills/build-seller-agent/SKILL.md` and `specialisms/sales-guaranteed.md`) — behavioral coverage gaps surfaced by the v4 storyboard matrix run (#1120):

1. **Minimum tool surface callout.** Documents the exact set of tools `sales-guaranteed` storyboards expect — adopters who skipped `list_accounts` or `list_creative_formats` were getting cascade-skips with `skip_reason: missing_tool` instead of useful diagnostics.
2. **Error-code matrix on `create_media_buy` / `update_media_buy`.** Spec-defined rejections (`TERMS_REJECTED`, `PRODUCT_NOT_FOUND`, `BUDGET_TOO_LOW`, `INVALID_REQUEST`, `MEDIA_BUY_NOT_FOUND`, `PACKAGE_NOT_FOUND`) now appear in one place with the wire-correct `adcpError(...)` shape.
3. **State-machine logic in the `update_media_buy` example.** `pending_creatives` is a transient state — when `creative_assignments` arrive the buy advances to `pending_start` (start_time in future) or `active` (start_time now/past). The pre-fix example only handled `paused ↔ active`, so storyboards depending on creative-attachment transitions failed.
4. **`property_list` / `collection_list` live inside `targeting_overlay`.** Per `/schemas/latest/core/package.json`, these are nested under `targeting_overlay`, not flat on `Package`. The skill now teaches the spec-correct path and flags the known storyboard discrepancy (some grader checks the flat path) so adopters don't chase a phantom bug.

Skills are bundled with the npm package (`files: ["skills/**/*"]`), so this is a publishable change.
