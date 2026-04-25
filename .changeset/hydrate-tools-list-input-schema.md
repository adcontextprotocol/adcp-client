---
'@adcp/client': patch
---

**Fix `createAdcpServer` publishing empty `inputSchema` on `tools/list` (#954).** Framework-registered tools were wired with `z.object({}).passthrough()` as `inputSchema`, which the MCP SDK serialised to `{ type: 'object', properties: {} }` — advertising no fields even though every AdCP 3.0 tool has a published JSON Schema. Two consequences: buyer agents doing `tools/list` introspection could not discover field shapes, and `SingleAgentClient.adaptRequestForServerVersion`'s field-stripping guard silently failed open for all framework-registered tools (empty-properties fail-open path always taken).

`createAdcpServer` now calls the new `getRawRequestSchema(toolName)` from `schema-loader.ts`, which returns the pre-resolved JSON schema from `schemas/cache/{version}/bundled/` for bundled tools. `additionalProperties: false` is relaxed at the root and in all direct `oneOf`/`anyOf`/`allOf` branches so the MCP SDK does not reject protocol envelope fields (`idempotency_key`, `context`, `caller`, `ext`) if it validates the advertised shape. Flat-tree domain schemas (governance, property-lists) contain unresolved `$ref`s and still fall back to the passthrough Zod schema. `get_adcp_capabilities` is unchanged.
