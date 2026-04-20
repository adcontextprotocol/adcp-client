---
'@adcp/client': minor
---

Ship five downstream-ergonomics fixes surfaced while porting a training agent onto 5.3. One public-type change (breaking for pre-release consumers only — the type never reached a stable release), four additive.

**BREAKING (pre-release only) — `createAdcpServer()` returns `AdcpServer` instead of SDK `McpServer`.** Re-exporting the SDK's `McpServer` type forced consumers through a specific module resolution path. A TypeScript ESM consumer importing `@adcp/client` (CJS) and separately importing `@modelcontextprotocol/sdk` (ESM) got two structurally-identical but distinct `McpServer` types — the SDK's private `_serverInfo` field breaks assignment compatibility between them. Owning the type on our side eliminates the hazard for every consumer. `AdcpServer` exposes `connect`, `close`, and the new `dispatchTestRequest`. Tool registration continues to flow through `createAdcpServer`'s domain-grouped handler config. `serve()` accepts both `AdcpServer` and raw `McpServer` (for `createTaskCapableServer` users). See `docs/migration-5.3-to-5.4.md` for the verbatim diffs.

**`AdcpServer.dispatchTestRequest({ method, params })`** — encapsulated test-only dispatch so downstream harnesses stop writing `(server as any)._requestHandlers.get(...)`. The `'tools/call'` overload returns a typed `CallToolResult`; the generic fallback returns `unknown`.

**`McpToolResponse.structuredContent` is now optional.** Error responses no longer need to fabricate an empty `structuredContent` to satisfy the type. All built-in success builders still populate it.

**`SingleAgentClient.validateRequest` drops `schema.strict()`.** The storyboard runner's `applyBrandInvariant` injects top-level `brand`/`account` onto every outgoing request for run-scoped tenancy. Tools whose schema declares neither (`list_creative_formats`, `get_signals`, `activate_signal`, `sync_creatives`) had strict() rejecting the injection client-side BEFORE `adaptRequestForServerVersion` could strip by schema. Non-strict parse lets the injection flow to the adapter. Required-field and shape violations still reject. Typo detection on unknown top-level keys now happens server-side.

**Storyboard runner `request_signing.transport: 'raw' | 'mcp'`.** Plumbs the existing grader option through the storyboard runner so MCP-only agents can pass the `signed-requests` specialism's vectors — each vector body is wrapped in a JSON-RPC `tools/call` envelope and posted to the `/mcp` mount instead of per-operation HTTP endpoints. Matches the `adcp grade request-signing --transport mcp` CLI flag.
