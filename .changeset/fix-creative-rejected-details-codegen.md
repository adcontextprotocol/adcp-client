---
"@adcp/sdk": patch
---

fix(codegen): emit `CreativeRejectedDetails` from error-details/creative-rejected.json

`compileGapSchemas` was checking `generatedTypes.has(typeName)` using the file-path-derived
name (`CreativeRejected`), which was already registered by the brand-domain
`creative-approval-response.json` pass, so the schema was silently skipped. The fix reads
the JSON Schema `title` field first and gates on the title-derived name
(`CreativeRejectedDetails`) instead, which does not collide.

Adds `CreativeRejectedDetails` interface and `CreativeRejectedDetailsSchema` Zod schema,
matching the six other error-details types already emitted. Fixes a long-standing gap —
not a regression of the 3.0.4 bump.
