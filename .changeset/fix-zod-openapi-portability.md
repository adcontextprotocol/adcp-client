---
'@adcp/sdk': patch
---

Preserve compact Product format intersections when converting generated schemas to OpenAPI with Zod 4.6 and later. Annotate the shared constraints to avoid duplicating them across every format branch, and require Zod 4.6.6 or later for development (locked to 4.6.7) to resolve its high-severity collection-validation advisory. The published peer range remains compatible with older Zod 4 consumers.

Generate a direct Zod namespace import so browser bundles can remove unused exports with patched Zod versions, keeping single-schema imports within the existing bundle-size limits.
