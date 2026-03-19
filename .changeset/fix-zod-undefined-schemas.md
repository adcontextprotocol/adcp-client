---
"@adcp/client": patch
---

Fix generated Zod schemas breaking MCP SDK JSON Schema conversion

Remove `z.undefined()` from generated union types (e.g., `z.union([z.boolean(), z.undefined()])` → `z.boolean()`) since `z.undefined()` has no JSON Schema representation and causes `toJSONSchema()` to throw. Also strip redundant `.and(z.record(...))` intersections that create `ZodIntersection` types losing `.shape` access needed by MCP SDK for tool registration.
