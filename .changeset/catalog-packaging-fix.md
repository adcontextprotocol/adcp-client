---
"@adcp/sdk": patch
---

Fix v2/projection loader crash in npm installs — bundle `aao-reference-formats.json` directly with the package and fix `registry.ts`/`canonical-properties.ts` to resolve schemas from `dist/lib/schemas-data/` instead of the dev-only `schemas/cache/` path. Before this fix, any call to `lookupV1Format()`, `findCatalogEntryByCanonicalAndSize()`, or `projectV1ProductToV2()` in an npm install threw `AAO catalog (reference-formats.json) not found`.
