---
"@adcp/client": patch
---

Fix MCP tool calls failing with "Unexpected keyword argument" for agents with partial v3 implementations

When calling `get_products` on an MCP agent, the client infers and adds `buying_mode` to the request for backwards compatibility with callers that don't supply it. For agents that are detected as v3 (have `get_adcp_capabilities`) but have an incomplete v3 `get_products` implementation that doesn't accept `buying_mode`, this caused a pydantic validation error and the entire call to fail.

The fix adds schema-based argument filtering in the MCP protocol layer: before calling a tool, the client calls `tools/list` to retrieve the tool's declared `inputSchema`, then drops any arguments not present in `properties`. If `tools/list` fails, it falls back to the original args unchanged. Dropped fields are logged as info entries.

This is complementary to the existing v2/v3 version detection — version detection works at the server level (binary v2 vs v3), while this check works at the individual tool field level, handling partial/in-progress v3 implementations.
