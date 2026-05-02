---
"@adcp/sdk": patch
---

Codegen now rewrites mutual-exclusion `oneOf` patterns (`{ required: [X], not: { required: [Y] } }`) into explicit closed-shape branches before json-schema-to-typescript runs. Fixes `Format.renders[]` and `SyncPlansRequest.plans[].budget`, both of which previously degraded to `{ [k: string]: unknown | undefined }` for one branch — incompatible with closed-shape values returned by typed builders under strict tsc (#1325).

`displayRender({...})`, `parameterizedRender({...})`, `templateRender({...})`, and the `FormatRender.*` namespace now type-check cleanly when assigned to `Format['renders']` under `--strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes`. Adopters that fell back to inline objects to satisfy strict tsc can switch back to the typed builders.

`format-render-builders.ts` derives `DimensionsRender`, `ParameterizedRender`, `RenderDimensions`, and the new `FormatRenderItem` from the generated `Format['renders']` type — single source of truth for the render shape. No runtime change.
