---
"@adcp/sdk": patch
---

Restore ZodObject helper access on ProductSchema and marker-backed canonical format schemas by collapsing marker-only intersections during schema generation.

Also preserve exact known-key typing for exported tool request/input schema maps while keeping dynamic string lookups explicitly nullable.
