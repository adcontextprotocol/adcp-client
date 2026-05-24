---
'@adcp/sdk': patch
---

Restore `ZodObject` ergonomics for generated schemas whose only intersection arms are opaque `Record<string, unknown>` markers.

`ProductSchema` and related marker-only format schemas now expose object helpers like `.extend()`, `.omit()`, `.pick()`, and `.shape` again without changing runtime validation behavior.
