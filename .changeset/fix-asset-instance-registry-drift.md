---
'@adcp/sdk': minor
---

Expose `PublishedPostAsset`, `ZipAsset`, `CardAsset`, `PixelTrackerAsset`, `VASTTrackerAsset`, and `DAASTTrackerAsset` from the package root and `@adcp/sdk/types`, and include every generated registry-backed variant in `AssetInstance`.

BREAKING NOTE: exhaustive `AssetInstance` switches must add cases for `zip`, `published_post`, `card`, `pixel_tracker`, `vast_tracker`, and `daast_tracker`. These are additive protocol variants that the SDK previously omitted from its public union.
