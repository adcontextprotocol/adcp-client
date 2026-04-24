---
'@adcp/client': minor
---

**A2A serve adapter (preview).** `createA2AAdapter({ server, agentCard, authenticate, taskStore })` exposes the same `AdcpServer` that `serve()` mounts over MCP as a peer A2A JSON-RPC transport. Both transports share the dispatch pipeline — idempotency store, state store, `resolveAccount`, request/response validation, governance — so a handler change is picked up by both at once.

**Scope (v0):** `message/send`, `tasks/get`, `tasks/cancel`, `GET /.well-known/agent-card.json`. Streaming (`message/stream`), push notifications, and mid-flight `input-required` interrupts are explicit "not yet" — tracked for v1. The adapter is marked preview; pin a minor version while the AdCP-over-A2A conventions stabilise across the ecosystem.

**Handler return → A2A `Task.state`:**

- Success arm → `completed` + DataPart artifact carrying the typed payload
- Submitted arm (`status:'submitted'`) → `submitted` + DataPart artifact with `adcp_task_id` surfaced alongside the AdCP payload. A2A's `Task.id` is SDK-generated; the AdCP-level handle rides on the artifact.
- Error arm (`errors:[]`) → `failed` + DataPart artifact preserving the spec-defined error shape
- `adcpError('CODE', ...)` → `failed` + DataPart artifact with `adcp_error`

**Agent card.** Seller supplies identity (`name`, `description`, `url`, `version`, `provider`, `securitySchemes`); the SDK seeds `skills[]` from registered AdCP tools, defaults `capabilities.streaming=false` / `pushNotifications=false` (v0 ships neither), and validates the merged card against A2A's required-field set at boot — unserviceable cards fail `createA2AAdapter()` rather than shipping to the wire.

**Skill addressing.** Clients send a `Message` with a single `DataPart` carrying `{ skill: '<tool_name>', input: { ... } }`. Non-conforming messages surface as `Task.state='failed'` with `reason: 'INVALID_INVOCATION'` rather than silently misrouting.

**New public surface.** `AdcpServer.invoke({ toolName, args, authInfo, signal })` — production-safe alias of the tool-call path both transports run through. Documented as requiring the caller to have authenticated the principal. `dispatchTestRequest` stays as the test-only sibling with its "never mount behind HTTP" docstring intact.

**New exports** (from `@adcp/client` and `@adcp/client/server`): `createA2AAdapter`, `A2AInvocationError`, `A2AAdapter`, `A2AAdapterOptions`, `A2AAgentCardOverrides`, plus `AdcpAuthInfo` and `AdcpInvokeOptions` for transport authors building custom adapters.

**Dependencies.** Uses `@a2a-js/sdk` (already a peer dep for the client-side caller) via its `/server` subpath export; no new peer deps required. `@types/express` added as a devDep so our types resolve when the SDK's express middleware returns `RequestHandler` from `express`.
