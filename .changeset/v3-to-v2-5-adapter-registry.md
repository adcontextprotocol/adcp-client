---
'@adcp/sdk': minor
---

Consolidates the v3 → v2.5 adapter dispatch into a typed registry pattern. Each AdCP tool that needs version translation now has a per-tool `AdapterPair<V3Req, V25Req, V25Res, V3Res>` module under `src/lib/adapters/v3-to-v2-5/`. `SingleAgentClient.adaptRequestForServerVersion` and `normalizeResponseToV3` dispatch through `getV3ToV25Adapter(taskName)` instead of carrying tool-specific switch arms.

Six pairs land in this PR: `get_products`, `create_media_buy`, `update_media_buy`, `sync_creatives`, `list_creative_formats`, `preview_creative`. The pairs wrap the existing scattered helpers (`adaptGetProductsRequestForV2`, `adaptCreateMediaBuyRequestForV2`, `normalizeMediaBuyResponse`, etc.) unchanged — wire-level behavior is identical and pinned by a regression suite that diffs registry output vs direct-helper output for every pair. The underlying logic stays in `utils/*-adapter.ts` files until each pair gets a focused per-tool refactor (e.g. `#1116` for sync_creatives).

Adding v2.6 / v3.1 in the future follows the same shape: a sibling `v3-to-v2-6/` directory with its own per-tool modules, then a dispatch table keyed by `(serverVersion, toolName)`. Today's single-pair surface is the smallest version of that pattern that lets v3 buyers talk to v2.5 sellers without breaking, plus the type endpoints from `@adcp/sdk/types/v2-5` so adapter signatures are compile-time-checked.

No public API change. The existing `adaptGetProductsRequestForV2` / etc. functions are still exported from `utils/*-adapter.ts` (no rename, no signature change) for any downstream caller using them directly. The registry is purely a centralized dispatch wrapper, not a migration of the helper code.
