---
'@adcp/sdk': minor
---

Restore required reporting-status view fields and strict closed reporting evidence validation in generated Zod schemas. Extra fields in source-closed reporting evidence are now rejected. Preserve the deprecated registry `ResolvedBrand.provenance` type for SDK callers while syncing the authoritative registry OpenAPI.
