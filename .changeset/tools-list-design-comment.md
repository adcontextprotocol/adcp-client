---
'@adcp/client': patch
---

**Docs (in-source): clarify why `tools/list` publishes empty `inputSchema`.** The framework intentionally registers tools with `PASSTHROUGH_INPUT_SCHEMA` so MCP `tools/list` returns `{ type: 'object', properties: {} }` per tool — full per-tool schemas would balloon the context window for LLM consumers, who are the primary readers of MCP discovery. Tool shapes live in `docs/llms.txt`, the SKILL.md files, and `schemas/cache/`. Comment-only change at `create-adcp-server.ts` (registration + `PASSTHROUGH_INPUT_SCHEMA` definition) and `SingleAgentClient.adaptRequestForServerVersion` (consumer side) so future engineers don't try to "fix" the empty schemas by inlining them. Points downstream consumers at `schema-loader.ts` / `schemaAllowsTopLevelField` (#940) as the canonical pattern when they need a tool's shape.
