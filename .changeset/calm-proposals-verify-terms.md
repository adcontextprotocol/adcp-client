---
'@adcp/sdk': minor
---

Add a schema-bundle-derived buyer verifier for proposal commercial terms. It checks the proposal digest before recursively comparing every binding field, returns typed JSON Pointer mismatches, and fails closed for unavailable or unsupported schema bundles.
