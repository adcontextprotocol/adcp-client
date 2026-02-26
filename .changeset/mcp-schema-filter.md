---
"@adcp/client": patch
---

Fix get_products failing with "Unexpected keyword argument: buying_mode" on partial v3 agents

When calling `get_products`, the client infers and adds `buying_mode` to requests for backwards compatibility. For agents detected as v3 (have `get_adcp_capabilities`) but with an incomplete `get_products` implementation that doesn't declare `buying_mode` in its tool schema, this caused a pydantic validation error and the entire call to fail.

The fix caches tool `inputSchema` data (already fetched via `listTools` during capability detection) and uses it in `adaptRequestForServerVersion` to strip `buying_mode` from `get_products` requests when the agent's schema doesn't declare the field. Fails open — if no schema is cached, the field is sent unchanged.

This is targeted to `get_products` + `buying_mode` at the existing version-adaptation layer, rather than blanket schema filtering at the protocol layer.
