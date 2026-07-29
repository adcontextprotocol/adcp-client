---
'@adcp/sdk': major
---

Remove `RegistryClient.resolveBrandHierarchy()`, `resolveBrandHierarchies()`, and their compatibility-only types. The public v3 registry deliberately retired those undeclared routes; use `lookupBrand()` and require `relationship_trust` to be `mutual` or `inline` before extending trust to `house_domain`. Add typed fresh-origin lookup support and document how consumers should interpret provenance, freshness, and migration evidence.
