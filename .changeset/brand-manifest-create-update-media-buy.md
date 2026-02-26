---
"@adcp/client": patch
---

Fix v2/v3 backwards compatibility for create_media_buy, update_media_buy, and get_products

**Inbound normalization (pre-strict-validation)**
- `brand_manifest` passed to `create_media_buy` is now converted to `brand` (BrandReference) and stripped before Zod strict validation fires, matching the existing `get_products` pattern. Previously these requests failed with "Request validation failed: Unrecognized key: brand_manifest".
- `update_media_buy` is no longer incorrectly included in the `brand_manifest` normalization block — neither the v2 nor v3 update schema has a `brand` field.

**Outbound adaptation (v3 client → v2 server)**
- `adaptCreateMediaBuyRequestForV2` now converts `brand: { domain }` → `brand_manifest: 'https://<domain>'` before sending to v2 servers. Previously `brand` passed through unchanged and v2 servers rejected it as an unrecognised field.
- `adaptCreateMediaBuyRequestForV2` now preserves `brand` in the output when it cannot be converted (no `domain` present), consistent with `adaptGetProductsRequestForV2`.
- `adaptCreateMediaBuyRequestForV2` now throws a clear error when `proposal_id` is present with no packages — proposal mode is v3-only and v2 servers require an explicit `packages` array.
- `adaptGetProductsRequestForV2` now correctly strips the `account` field (was erroneously deleting `account_id`, a field that doesn't exist at the top level).
- `adaptPackageRequestForV2` now strips `catalog` from package items — it is a v3-only field not present in the v2 package schema. Applies to both `create_media_buy` and `update_media_buy` packages.
- Brand manifest URL format aligned: both `get_products` and `create_media_buy` now use the bare domain URL (`https://<domain>`) when converting `brand` → `brand_manifest` for v2 servers.
