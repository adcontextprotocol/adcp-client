---
'@adcp/sdk': minor
---

Consolidates the v2.5 wire-compat dispatch into a typed registry pattern. Each AdCP tool that needs translation between the SDK's v3 surface and a v2.5 seller now has a per-tool `AdapterPair<V3Req, V25Req, V25Res, V3Res>` module under `src/lib/adapters/legacy/v2-5/`. `SingleAgentClient.adaptRequestForServerVersion` and `normalizeResponseToV3` dispatch through `getV25Adapter(taskName)` instead of carrying tool-specific switch arms.

Six pairs land in this PR: `get_products`, `create_media_buy`, `update_media_buy`, `sync_creatives`, `list_creative_formats`, `preview_creative`. The pairs wrap the existing scattered helpers (`adaptGetProductsRequestForV2`, `adaptCreateMediaBuyRequestForV2`, `normalizeMediaBuyResponse`, etc.) unchanged — wire-level behavior is identical and pinned by a regression suite that diffs registry output vs direct-helper output for every pair. The underlying logic stays in `utils/*-adapter.ts` files until each pair gets a focused per-tool refactor (e.g. `#1116` for sync_creatives).

Naming intentionally matches `legacy/<seller-version>/`, NOT `<sdk-version>-to-<seller-version>/`. Real ad-tech compat layers carry **N=1 active legacy shim with a deprecation runway** (OpenRTB, Prebid, GAM all behave this way). Encoding a `v3-to-v2-5/` matrix would commit the codebase to a layout nobody will staff. When the SDK pin moves from v3 to v4 in the future, `legacy/v2-5/` continues to hold the v2.5 compat shim and a sibling `legacy/v3/` joins for v3 sellers — the directory tree expresses "exceptional, time-boxed compat" rather than encoding a buyer-version axis.

No public API change. The existing `adaptGetProductsRequestForV2` / etc. functions are still exported from `utils/*-adapter.ts` (no rename, no signature change) for any downstream caller using them directly. The registry is purely a centralized dispatch wrapper, not a migration of the helper code.
