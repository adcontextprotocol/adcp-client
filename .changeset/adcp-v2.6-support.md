---
"@adcp/client": minor
---

Add AdCP v2.6 support with backward compatibility for Format schema changes

- New `assets` field in Format schema (replaces deprecated `assets_required`)
- Added format-assets utilities: `getFormatAssets()`, `getRequiredAssets()`, `getOptionalAssets()`, etc.
- Updated testing framework to use new utilities
- Added URL input option for image/video assets in testing UI
- Added 21 unit tests for format-assets utilities
