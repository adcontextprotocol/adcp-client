---
'@adcp/sdk': patch
---

Reduce cold MCP output-schema compilation and validation memory by factoring large remote schemas into small referenced validators. Preserve seller constraints, reference scopes, formats, and protocol dialects. Add required regression checks for generated function size and repeated output validation, and reduce discovery's peak-memory budget to 512 MiB.
