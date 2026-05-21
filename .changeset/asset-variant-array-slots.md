---
'@adcp/sdk': major
---

feat(manifest-helpers): handle `AssetVariant | AssetVariant[]` slot widening (3.1.0-beta.2)

AdCP 3.1.0-beta.2 widened each `creative_manifest.assets[asset_id]` slot from `AssetVariant` to `AssetVariant | AssetVariant[]` so carousel `cards`, responsive_creative `headlines`, and other multi-element slots can carry multiple assets per asset_id.

**Changes:**
- **`getAsset` / `requireAsset`**: when the slot is an array, return the first element. Preserves pre-3.1 behavior for single-asset callers without breaking the type signature.
- **New `getAssetSlot(manifest, assetId, assetType)`**: returns the full array (or single-element array if the slot is scalar), filtered by `asset_type`. Use when authoring carousel / responsive_creative platforms that need every asset in the slot.

**Adopter migration:**
- Single-asset callers: no code change required. `getAsset(m, 'cover_image', 'image')` keeps working whether `cover_image` is a single asset or a one-element array.
- Multi-asset callers: switch to `getAssetSlot(m, 'cards', 'image')` to receive the full array.

Part of the #1902 8.0-beta sweep (4/5 structural breaks closed).
