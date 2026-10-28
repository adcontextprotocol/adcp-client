---
'@adcp/sdk': patch
---

Backport the current SDK line's compact OpenAPI rendering for Zod 4.6. Annotate common product constraints and inline union operands so schema rendering preserves one intersection instead of copying shared constraints into every union branch. Validation is unchanged. This keeps adopter schema extensions portable with the patched Zod dependency.
