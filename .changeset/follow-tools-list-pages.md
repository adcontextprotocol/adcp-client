---
'@adcp/sdk': patch
---

`getAgentInfo()` and capability discovery now read every page of an MCP agent's `tools/list`. AdCP asks sellers to paginate the tool catalog, and clients that need all of it must follow `nextCursor`. The legacy MCP client paths (in-process, the shared scoped session and the one-shot connection) read only the first page, so a seller with `get_adcp_capabilities` on a later page was treated as not supporting AdCP 3, and tools on later pages were missing from `getAgentInfo().tools` and from request validation. Reads stop at a repeated cursor and fail after 64 pages; `transport.maxResponseBytes` applies to each page. The MCP Tasks path now pages until it finds the called tool, so its task-support metadata is cached even when the tool is on a later page.
