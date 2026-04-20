# Migrating from @adcp/client 5.3 → 5.4

5.4 ships four downstream-ergonomics fixes surfaced while porting a training
agent. Three are additive; one changes a public type. The breaking change
only affects pre-release consumers — the type never shipped to a stable
release. If you're on 5.3, the work is mechanical and under 20 minutes.

## 1. **BREAKING** — `createAdcpServer()` returns `AdcpServer`, not `McpServer`

`createAdcpServer()` now returns an opaque `AdcpServer` interface owned by
`@adcp/client`. The SDK's `McpServer` type is no longer part of the
framework's public surface.

**Why.** Re-exporting the SDK's `McpServer` type forced downstream consumers
through a specific SDK resolution path. A TypeScript ESM consumer importing
`@adcp/client` (CJS) and separately importing
`@modelcontextprotocol/sdk` (ESM) got two structurally-identical
`McpServer` types whose private `_serverInfo` field broke assignment
compatibility. Owning the type on our side eliminates the hazard for every
consumer.

**What to change.**

```ts
// 5.3 — return type was the SDK's McpServer
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
const server: McpServer = createAdcpServer({ ... });
server.tool('custom', schema, handler);  // ← no longer typed
```

```ts
// 5.4 — return type is the opaque AdcpServer
import type { AdcpServer } from '@adcp/client';
const server: AdcpServer = createAdcpServer({ ... });
```

The `AdcpServer` interface exposes `connect`, `close`, and the new
`dispatchTestRequest()`. Tool registration now flows through
`createAdcpServer()`'s domain-grouped handler config — the framework owns
the registration conventions (idempotency auto-inject, governance,
validation, response shape). For non-AdCP tools, keep using
`createTaskCapableServer()` directly; `serve()` accepts either.

## 2. Test harnesses — `dispatchTestRequest` instead of `_requestHandlers`

If you were reaching into the SDK's private handler map from tests, replace
the cast with the new method:

```ts
// Before
const handler = (server as any).server._requestHandlers.get('tools/call');
const result = await handler({ method: 'tools/call', params: { name, arguments } }, extra);
```

```ts
// After
const result = await server.dispatchTestRequest({
  method: 'tools/call',
  params: { name: 'get_products', arguments: { brief: 'premium' } },
});
// `result` is typed as CallToolResult for the tools/call overload.
```

Works on any server returned by `createAdcpServer()`. For generic JSON-RPC
methods (`tools/list`, resource methods, etc.), pass `method` + `params`
and narrow the response yourself.

## 3. `McpToolResponse.structuredContent` is now optional

If you have custom response wrappers that return error envelopes with no
structured data, you no longer need to fabricate an empty
`structuredContent`. All framework builders (`productsResponse`,
`mediaBuyResponse`, …) still populate it on success.

```ts
// Still valid — nothing changed for success paths.
return productsResponse({ products });

// Now valid for adapt()-style wrappers — no stub object needed.
return { content: [{ type: 'text', text: 'Rejected' }] };
```

## 4. Client-side request validation no longer enforces strict mode

`SingleAgentClient.validateRequest` now uses a default (non-strict) Zod
parse. Unknown top-level fields pass through; required-field and
shape violations still reject.

**Why.** The storyboard runner's `applyBrandInvariant` injects top-level
`brand` and `account` onto every outgoing request for scoping. Tools
whose schema declares neither (`list_creative_formats`, `get_signals`,
`activate_signal`, `sync_creatives`) had strict() rejecting the
injection client-side before `adaptRequestForServerVersion` could strip
the fields. Non-strict parse lets the injection flow to the adapter,
which strips by schema.

**What to change.** Nothing, unless you relied on the client rejecting
unknown top-level keys. Typo detection on unknown fields now happens
server-side.

## 5. Storyboard runner — `transport: 'mcp'` for signed_requests vectors

If you grade an MCP-only agent against the `signed-requests` specialism,
pass `transport: 'mcp'` in `request_signing` so every vector routes
through the agent's `/mcp` mount in a JSON-RPC `tools/call` envelope
instead of per-operation HTTP endpoints:

```ts
await runStoryboard({
  agentUrl: 'https://agent.example.com/mcp',
  // …
  request_signing: {
    transport: 'mcp',  // new in 5.4 — matches `adcp grade --transport mcp`
  },
});
```

Raw per-operation dispatch remains the default.

## Quick check after upgrade

- [ ] Replace `import type { McpServer } ...` with `import type { AdcpServer } ...` in files that typed the return of `createAdcpServer()`.
- [ ] Swap `(server as any)._requestHandlers.get(...)` test helpers for `server.dispatchTestRequest(...)`.
- [ ] (Optional) Drop any `structuredContent: {}` stubs on error-only response wrappers.
- [ ] (Optional) Stop relying on client-side rejection of unknown top-level request fields.
- [ ] (MCP-only graders) Add `request_signing: { transport: 'mcp' }` to storyboard run options.
