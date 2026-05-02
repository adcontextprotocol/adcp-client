---
"@adcp/sdk": patch
---

Add `examples/hello_seller_adapter_brand.ts` — a Hello-world brand-rights adapter implementing `get_brand_identity`, `get_rights`, and `acquire_rights` using `createAdcpServerFromPlatform` + `defineBrandRightsPlatform`. Includes in-memory stub backend, governance check for the `governance_denied` storyboard scenario, and `examples/README.md` entry.
