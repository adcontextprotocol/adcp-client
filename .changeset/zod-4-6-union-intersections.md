---
'@adcp/sdk': patch
---

Keep every exported Zod schema compact when rendered to JSON Schema or OpenAPI on Zod 4.6. Zod 4.6 rewrites an intersection with a union (`A & (X | Y)`) as `(A & X) | (A & Y)`, copying `A` into every branch. The Product format declaration was already annotated to prevent this; inline union operands of every generated intersection now carry a description too, which brings the total rendered size of all exported schemas back to within 0.1% of Zod 4.4.3 (e.g. `PlacementSchema` 339 KB → 167 KB, `ProductSchema` 917 KB → 727 KB, postal-area schemas about 3.4× smaller). Validation is unchanged.
