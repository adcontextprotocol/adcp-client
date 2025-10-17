---
"@adcp/client": patch
---

Improve type safety and use structured data from schemas

- Replace custom types with generated schema types (Format, Product, etc)
- Remove all 'as any' type casts for better type safety
- Remove 30+ lines of workaround code for non-standard responses
- Export key schema types for public API (Format, Product, PackageRequest, CreativeAsset, CreativePolicy)
- Client now expects servers to return proper structured responses per AdCP spec
