---
'@adcp/sdk': patch
---

Fix(types): restore typed Zod for per-asset-type `*AssetRequirementsSchema`

Regression in 6.19.0 (introduced by #1654): the 12 `*AssetRequirementsSchema`
exports (`ImageAssetRequirementsSchema`, `TextAssetRequirementsSchema`, …) and
the parent `AssetRequirementsSchema` union were emitted as `z.any()` stubs, and
the `requirements` field on every `Individual*AssetSchema` / `Group*AssetSchema`
slot collapsed to `z.optional(z.any())`. TypeScript types were unaffected.

Root cause: #1654's codegen post-processor injects
`import type { ImageAssetRequirements, … } from './core.generated';` at the top
of `tools.generated.ts` so the file typechecks standalone. The Zod codegen step
concatenates `core.generated.ts` + `tools.generated.ts` and passes the combined
source to `ts-to-zod`, but `ts-to-zod` still parses the cross-file `import type`
block and treats those names as external — emitting `z.any()` stubs even though
the actual interfaces are present in the same source.

Fix: strip cross-file `import type { … } from './core.generated';` declarations
from `tools.generated.ts` before merging into the combined source. The types
are already inlined from `core.generated.ts`, so the import is redundant.

Restores field-level runtime validation on `Individual*AssetSchema.requirements`
and re-exports the typed per-asset-type requirements schemas that consumers
like agentic-api had imported in 6.18. Added a regression test in
`test/lib/zod-schemas.test.js` that asserts the schemas reject wrong-typed
fields (a `z.any()` regression would silently accept them).
