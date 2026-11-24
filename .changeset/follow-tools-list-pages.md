---
'@adcp/sdk': patch
---

`getAgentInfo()` and capability discovery now read every page of an MCP agent's `tools/list`. AdCP asks sellers to paginate the tool catalog, and clients that need all of it must follow `nextCursor`. The legacy MCP client paths read only the first page: in-process, the shared scoped session, and the one-shot connection. So a seller with `get_adcp_capabilities` on a later page was treated as not supporting AdCP 3, and tools on later pages were missing from `getAgentInfo().tools` and from request validation.

- Reads stop at a repeated cursor and fail after 64 pages.
- `transport.maxResponseBytes` applies to each page, and each page has its own streamed-response allowance.
- After a multi-page read, the legacy MCP client's cached tool metadata covers the whole catalog, as it does for a single-page server. That metadata is the output-schema validators and MCP Tasks support. The MCP Tasks path reads the whole catalog the same way.
