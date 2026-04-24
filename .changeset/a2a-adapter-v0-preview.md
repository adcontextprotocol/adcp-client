---
'@adcp/client': minor
---

**A2A serve adapter (preview).** `createA2AAdapter({ server, agentCard, authenticate, taskStore })` exposes the same `AdcpServer` that `serve()` mounts over MCP as a peer A2A JSON-RPC transport. Both transports share the dispatch pipeline — idempotency store, state store, `resolveAccount`, request/response validation, governance — so a handler change is picked up by both at once.

**Scope (v0):** `message/send`, `tasks/get`, `tasks/cancel`, `GET /.well-known/agent-card.json`. Streaming (`message/stream`), push notifications, and mid-flight `input-required` interrupts are explicit "not yet" — tracked for v1. The adapter is marked preview; pin a minor version while the AdCP-over-A2A conventions stabilise across the ecosystem.

**Handler return → A2A `Task.state` mapping (aligned with A2A 0.3.0 lifecycle):**

- Success arm → `completed` + DataPart artifact carrying the typed payload
- Submitted arm (`status:'submitted'`) → `completed` (the transport call itself completed; `submitted` is initial-only per A2A 0.3.0, not terminal) + DataPart artifact preserving the AdCP response; **`adcp_task_id` rides on `artifact.metadata`** so the AdCP payload still validates cleanly against the tool's response schema
- Error arm (`errors:[]`) → `failed` + DataPart artifact preserving the spec-defined error shape
- `adcpError('CODE', ...)` → `failed` + DataPart artifact with `adcp_error`

**Two lifecycles, one response.** A2A `Task.state` tracks the transport call (did the HTTP request complete?); AdCP `status` inside the artifact tracks the work (submitted / completed / failed). A `completed` A2A task can carry a `submitted` AdCP response — they're orthogonal state machines. Buyers resume async AdCP work via `artifact.metadata.adcp_task_id`.

**`mount(app)` convenience helper.** `adapter.mount(app)` wires all four routes from one call: JSON-RPC at the agent-card URL's pathname, the agent card at both `{basePath}/.well-known/agent-card.json` (A2A SDK discovery convention) and `/.well-known/agent-card.json` (origin-root probes). Eliminates the common 404 on first discovery when sellers mount the card at only one path. `A2AMountOptions` supports `basePath` override and `wellKnownAtRoot: false` for deployments where an upstream proxy owns origin-root routes.

**Skill addressing.** Clients send a `Message` with a single `DataPart` carrying `{ skill: '<tool_name>', input: { ... } }`. The legacy key `parameters` (emitted by `src/lib/protocols/a2a.ts` before the adapter landed) is accepted as an alias for `input` so same-SDK client/server pairs talk cleanly. Non-conforming messages surface as `Task.state='failed'` with `reason: 'INVALID_INVOCATION'`.

**New public surface.** `AdcpServer.invoke({ toolName, args, authInfo, signal })` — production-safe alias of the tool-call path both transports run through. Docstring makes auth the caller's responsibility; `dispatchTestRequest` stays the test-only sibling.

**New exports** (from `@adcp/client` and `@adcp/client/server`): `createA2AAdapter`, `A2AInvocationError`, `A2AAdapter`, `A2AAdapterOptions`, `A2AAgentCardOverrides`, `A2AMountOptions`, `ExpressAppLike`, plus `AdcpAuthInfo` and `AdcpInvokeOptions` for transport authors building custom adapters.

**Dependencies.** Uses `@a2a-js/sdk` (already a peer dep for the client-side caller) via its `/server` subpath export; no new peer deps required. `@types/express` added as a devDep so our types resolve when the SDK's express middleware returns `RequestHandler` from `express`.
