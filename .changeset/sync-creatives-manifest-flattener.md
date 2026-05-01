---
'@adcp/sdk': patch
---

Fix `adaptSyncCreativesRequestForV2` to flatten v3 manifest assets to v2.5 single-asset payload.

`adaptSyncCreativesRequestForV2` previously leaked the v3 `assets` manifest shape (`{ role: { asset_type, url, … } }`) through to v2.5 servers unchanged. v2.5's `creative-asset.json` schema expects a single asset payload discriminated by `asset_type`; every adapted creative therefore failed the `oneOf` check and was rejected by strict v2.5 sellers.

The adapter now detects manifest-shaped `assets` (a role-keyed object whose values carry `asset_type`) and extracts the primary (first) role's payload as the v2 asset. Multi-role manifests emit a `console.warn` naming the dropped roles; single-role manifests are silently flattened. Already-flat assets (top-level `asset_type` present) pass through unchanged.

Covers image, video, audio, VAST, text, and HTML asset variants per the v2.5 test plan.
