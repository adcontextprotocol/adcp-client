---
'@adcp/client': minor
---

**Fix MCP/A2A validation asymmetry (#909).** Before this change, the MCP SDK's Zod validator ran only on the MCP transport — A2A bypassed it via `AdcpServer.invoke()`, so the same malformed request could be rejected on MCP (with a raw `-32602` JSON-RPC error) while silently reaching the handler on A2A. The framework AJV validator now runs authoritatively on both transports, producing a single structured `adcp_error` envelope with the same pointer-level `issues[]` regardless of transport.

**Implementation:**

- Framework-registered tools (`create-adcp-server.ts`) now pass `z.object({}).passthrough()` as `inputSchema` instead of per-tool Zod shapes. The passthrough shape preserves handler arguments (the SDK's `validateToolInput` returns `undefined` when no schema is registered, which would have destroyed args on MCP); the empty declared-properties make the framework AJV validator the sole enforcer for both transports.
- `requests` validation mode default flipped from `'warn'` to `'strict'` outside production. Matches the existing `responses: 'strict'` default and ensures A2A malformed payloads are rejected before reaching handlers (previously the MCP SDK's Zod filled this role; that safety net is gone).
- Client-side field-stripping in `SingleAgentClient.adaptRequestForServerVersion` treats an empty-properties schema as "fail open" instead of "strip everything" (JSON Schema semantics). Required because the server's post-#909 `tools/list` publishes `{ type: 'object', properties: {} }` for every tool — the previous code would have stripped every buyer-supplied field.

**Wire format change:**

- MCP clients no longer receive raw `-32602 Input validation error: <Zod text>` on malformed requests. They receive the framework's structured `adcp_error` envelope (`code: 'VALIDATION_ERROR'`, `issues: [{ pointer, message, keyword }]`) — same shape A2A clients always get. Clients that parsed `-32602` text need to migrate to reading `structuredContent.adcp_error`.
- `tools/list` over MCP returns `{ type: 'object', properties: {} }` per tool (no per-tool parameter schemas). AdCP-native discovery (`get_adcp_capabilities`) already works over both transports; upstream [adcp#3057](https://github.com/adcontextprotocol/adcp/issues/3057) proposes `get_schema` as a capability tool for per-tool shape discovery.
- Test seller fixtures using sparse payloads now need explicit `validation: { requests: 'off' }` alongside `responses: 'off'`. The seven in-tree test helpers were updated accordingly.

**New test:** `test/server-validation-symmetry.test.js` sends the same malformed request to one `AdcpServer` over MCP and A2A; asserts `adcp_error.code`, `recovery`, and sorted issue-pointer lists match. Locks #909 against regression.
