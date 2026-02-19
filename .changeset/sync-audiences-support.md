---
"@adcp/client": minor
---

Add sync_audiences tool support and BrandReference migration

- Added `testSyncAudiences()` scenario for testing first-party CRM audience management
- Added `audienceManagement` feature detection in capabilities
- Added `sync_audiences` to supported tool list
- Migrated from `BrandManifest` to `BrandReference` (upstream schema change)
- Backwards-compatible: `BrandManifest`, `BrandManifestReference`, and `brandManifestToBrandReference()` re-exported from `compat.ts` with deprecation notice
- Updated `TestOptions` to accept `brand?: { domain: string; brand_id?: string }` and `audience_account_id?: string`
