---
'@adcp/sdk': minor
---

Fix public Zod array projection so complex `minItems: 1` arrays no longer render as tuples with an incorrect OpenAPI `minItems: 2`, and collapse bounded homogeneous tuple unions that caused `ProductSchema` OpenAPI documents to grow to roughly 99 MB. Generated public array inference is widened from tuple types to ordinary arrays in line with the documented relaxed-cardinality contract.
