---
'@adcp/sdk': patch
---

Infer creative wire support from reachable local JSON Schema references in MCP tool input schemas, retaining complete schema documents through scoped discovery and shared-cache reuse. Sellers advertising AdCP 3.1 with `$defs`/`$ref` now get the same canonical or legacy creative projection as equivalent inline schemas. Unused definitions and annotations do not establish support; cyclic, missing, and external references remain bounded and never trigger network requests. Existing property-map priming and adaptive request filtering keep their API contract.
