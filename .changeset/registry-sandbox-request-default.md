---
'@adcp/sdk': patch
---

Sync the cached registry OpenAPI contract and generated types with the current registry. Keep the new defaulted `sandbox` flag optional on `ResolveIdentifiersRequest`, preserving existing callers that omit it.
