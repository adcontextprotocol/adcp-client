---
"@adcp/sdk": patch
---

Internal: consolidated the duplicated `__dirname`-relative schema/data-root resolution across 7 loaders (`validation/schema-loader.ts`, `conformance/schemaLoader.ts`, `server/error-arm-tools.ts`, `v2/projection/{catalog,registry,canonical-properties}.ts`, `testing/storyboard/compliance.ts`) into shared `getPackageRoot()`/`getSchemaDataRoots()` helpers (`src/lib/internal/`). Resolution now anchors via `require.resolve('@adcp/sdk/package.json')` self-reference instead of hand-tuned `path.join(__dirname, '..', ...)` arithmetic tied to each file's own directory depth. No public API changes.
