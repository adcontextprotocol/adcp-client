---
'@adcp/sdk': patch
---

Trim the published package from 26.86 MB to 24.99 MB packed (8,529 to 8,176 files). Runtime behavior is unchanged.

- The compliance bundles no longer ship their `domains/` directories. Each was a byte-identical copy of `protocols/`, which is what the storyboard loader reads. If you read storyboards from `node_modules/@adcp/sdk/compliance/cache/<version>/domains/<id>/`, read `protocols/<id>/` instead. `index.json` keeps listing both arrays because it is the upstream bundle file.
- The ESM declarations for the generated protocol and registry types (`types/core.generated.d.mts`, `types/tools.generated.d.mts`, `registry/types.generated.d.mts`) now re-export the CommonJS declarations, as `types/schemas.generated.d.mts` already did, instead of shipping a second copy. ESM and CommonJS consumers get the same types.
- The MCP `tools/list` request projections under `dist/lib/schemas-data/<version>/mcp/` are stored as compact JSON. `tools/list` serves the parsed schemas, so the wire output is the same.
