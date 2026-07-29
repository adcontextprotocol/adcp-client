---
'@adcp/sdk': major
---

Remove `RegistryClient.resolveBrandHierarchy()`, `resolveBrandHierarchies()`, and their compatibility-only types. The public v3 registry deliberately retired those undeclared routes; use `lookupBrand()` and require `relationship_trust` to be `mutual` or `inline` before extending trust to `house_domain`. Document deterministic source precedence and preserve the registry's provenance, freshness, and migration evidence fields for consumers.
