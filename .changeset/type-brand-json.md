---
"@adcp/client": minor
---

Type brand_json with Zod schema matching the AdCP brand.json spec. SandboxBrand.brand_json is now typed as BrandJson instead of Record<string, unknown>, and sandbox data is validated at load time. Brand entries use spec-compliant field names (id, names) instead of the previous brand_id/name.
