---
'@adcp/sdk': patch
---

Sync `schemas/registry/registry.yaml` and `src/lib/registry/types.generated.ts` with the upstream AdCP registry.

Generated output only — no hand edits and no behavior change. The registry types are published, so this is a type-surface addition rather than a no-op; existing type references are unaffected (additive).

Regenerate with `npm run sync-schemas:all && npm run generate-types && npm run generate-registry-types -- --sync`.
