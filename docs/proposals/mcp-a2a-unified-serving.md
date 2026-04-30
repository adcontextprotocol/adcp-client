# MCP + A2A unified serving (v6.0)

Companion to `decisioning-platform-v1.md`. The DecisioningPlatform interface is protocol-agnostic by construction — adopters describe their decisioning system once. This proposal locks how the framework projects that single description onto both MCP and A2A transports without the adopter writing protocol-specific code.

**Goal**: a developer who writes `class MyPlatform implements DecisioningPlatform<...>` gets an agent that responds correctly to MCP `tools/list` + `tools/call`, A2A `agent-card.json` + `message/send` + `tasks/get` + `tasks/cancel`, with consistent semantics, without ever opening an MCP or A2A library.

## Why "build it from the start"

Today's `serve()` is MCP-only. `a2a-adapter.ts` is the v0 A2A peer that takes the same `AdcpServer` handle. The two share dispatcher, idempotency, state, account resolution, and governance — the framework owns transport-agnostic concerns. What's NOT shared:

- **Capability declaration**: today, adopters call `server.registerTool()` per tool. To add A2A, the AgentCard skill manifest is hand-rolled. Two declarations of the same fact.
- **Async-completion path**: MCP returns `submitted` as a structured-content marker; A2A wraps in a Task envelope. Each transport's adapter projects independently.
- **Error shape**: MCP `isError: true` + `adcp_error` payload; A2A `Task.status.state: 'failed'` + DataPart with the same envelope. Same shape, two projections.

A retrofit ships these as separate "MCP path" and "A2A path" code branches that both call into the same handler. Acceptable. But the cleaner shape — one capability declaration drives one runtime registry, both transports project from there — is only achievable if we design it before the runtime ships.

## Core shape

```ts
import { createAdcpServer, serve } from '@adcp/client/server';

const platform = new MyPlatform(deps);

serve(platform, {
  port: 3001,
  // Both transports mount automatically:
  //   MCP:  /mcp                       (StreamableHTTPServerTransport)
  //   A2A:  /a2a + /.well-known/agent-card.json
});
```

`serve(platform, opts)` is the only entry point an adopter needs. It:

1. Reads `platform.capabilities.specialisms[]`.
2. Derives the tool registry from `RequiredPlatformsFor<S>` × known wire-tool catalog.
3. Wires both transports to the same dispatcher.
4. Mounts MCP at `opts.mcpPath ?? '/mcp'` and A2A at `opts.a2aPath ?? '/a2a'` on a single Express app.
5. Serves `/.well-known/agent-card.json` derived from `capabilities`.
6. Serves `/.well-known/oauth-protected-resource{/mcp,/a2a}` for both transports.

**Adopters who want fine-grained control** can drop to `createAdcpServer(platform).expressMcp` / `.expressA2a` and mount themselves. The opinionated `serve()` covers the 95% case.

## Capability → registry derivation

The framework owns one canonical mapping table:

```ts
// framework-internal — one row per AdCP tool
const TOOL_REGISTRY: ReadonlyArray<ToolBinding> = [
  { tool: 'get_products',          specialism: 'sales-non-guaranteed', method: 'sales.getProducts' },
  { tool: 'create_media_buy',      specialism: 'sales-non-guaranteed', method: 'sales.createMediaBuy' },
  { tool: 'update_media_buy',      specialism: 'sales-non-guaranteed', method: 'sales.updateMediaBuy' },
  { tool: 'sync_creatives',        specialism: 'sales-non-guaranteed', method: 'sales.syncCreatives' },
  { tool: 'get_media_buy_delivery',specialism: 'sales-non-guaranteed', method: 'sales.getMediaBuyDelivery' },
  { tool: 'build_creative',        specialism: 'creative-template',    method: 'creative.buildCreative' },
  { tool: 'preview_creative',      specialism: 'creative-template',    method: 'creative.previewCreative' },
  { tool: 'sync_audiences',        specialism: 'audience-sync',        method: 'audiences.syncAudiences' },
  // ... plus framework-owned tools ALWAYS registered:
  { tool: 'get_adcp_capabilities', specialism: null, method: '__framework__' },
  { tool: 'tasks/get',             specialism: null, method: '__framework__' },
  { tool: 'list_authorized_properties', specialism: null, method: '__framework__' },
  // signed-requests is cross-cutting; framework verifies signatures regardless of specialisms
];
```

At `serve(platform)`:

1. For each `specialism` in `platform.capabilities.specialisms`, register the matching `TOOL_REGISTRY` rows.
2. Always register the `specialism: null` cross-cutting rows.
3. Each registered tool gets a single dispatcher entry that resolves `platform[method-path]` lazily and calls it with the validated request + resolved `Account`.

**No per-tool registration code in adopter land**. The capability declaration is the registration.

## Wire projection: AsyncOutcome → MCP / A2A

The framework's projection table — one source of truth, two transport renderings:

| `AsyncOutcome.kind` | MCP `tools/call` response | A2A `message/send` response |
|---|---|---|
| `sync` | `{ structuredContent: { ...result }, content: [...] }`; `isError: false` | `Task` with `status.state: 'completed'`; artifact = DataPart with `result` |
| `submitted` | `{ structuredContent: { ...partialResult, status: 'submitted', task_id }, content: [...] }`; `isError: false`; framework auto-fills `status: 'submitted'` and `task_id` from `taskHandle.taskId` | `Task` with `status.state: 'completed'` (TRANSPORT done); artifact metadata carries `adcp_task_id`; data carries `status: 'submitted'` |
| `rejected` | `{ structuredContent: { adcp_error: { ...error } }, content: [...] }`; `isError: true` | `Task` with `status.state: 'failed'`; artifact = DataPart with `adcp_error: { ...error }` |

Two lifecycles stay distinct: A2A `Task.state` tracks the transport call; AdCP `status` tracks the work. The matrix above is normative — adopters never see it.

## Notify push (`taskHandle.notify`)

`taskHandle.notify(update)` is the canonical push surface. The framework resolves which transport(s) to project to based on which transport the task envelope was issued on:

- **MCP-issued task**: framework egresses to `push_notification_config.url` (the buyer's webhook). MCP has no server-push channel; webhook is the only path.
- **A2A-issued task**: framework records the update in the Task store. The buyer learns via `tasks/get` polling OR via the A2A `tasks/pushNotification/set` webhook (when the buyer registered one). v0 of the A2A adapter does NOT support `message/stream`; the v6.0 framework keeps that constraint until A2A streaming lands.

`notify()` is fire-and-forget (`void`). Errors are framework-internal (push retry, dedup, terminal-update lockout) — not surfaced to the platform. Documented in the JSDoc on `TaskHandle.notify`.

## AgentCard derivation

The A2A AgentCard at `/.well-known/agent-card.json` is derived from `capabilities`:

```json
{
  "name": "<inferred from capabilities or opts.name>",
  "version": "<opts.version>",
  "url": "<publicUrl + a2aPath>",
  "skills": [
    { "id": "get_products", "name": "Get products", "description": "...", "tags": ["sales-non-guaranteed"] },
    { "id": "create_media_buy", "name": "Create media buy", "description": "...", "tags": ["sales-non-guaranteed"] }
  ],
  "capabilities": {
    "streaming": false,
    "pushNotifications": true,
    "stateTransitionHistory": true
  },
  "defaultInputModes": ["application/vnd.adcp.tool-call+json"],
  "defaultOutputModes": ["application/vnd.adcp.tool-result+json"]
}
```

Skills are derived from the same `TOOL_REGISTRY` filtered by claimed specialisms. Tool descriptions come from the spec's tool-call schema; adopters override via `opts.skillDescriptionOverrides[toolName]`.

## MCP `tools/list` derivation

`tools/list` returns the same registered tools, with input schemas auto-loaded from the spec (`schemas/cache/<version>/bundled/<protocol>/<tool>-request.json`). Adopters never write input schemas — the spec is the source of truth.

`outputSchema` similarly auto-loaded. Both are static JSON-Schema; framework-level cache; no per-request overhead.

## Per-tool override hook

For the 5% of adopters who need non-standard shapes (e.g., adding extra fields to `get_products` response, custom MCP `content[]` text formatting beyond the auto-rendered structured-content), the escape hatch:

```ts
serve(platform, {
  toolOverrides: {
    get_products: {
      mapMcpResponse: (raw) => ({ ...raw, content: [{ type: 'text', text: customRender(raw.structuredContent) }] }),
      mapA2aArtifact: (raw) => ({ ...raw, parts: [...raw.parts, { kind: 'text', text: customNote }] }),
    },
  },
});
```

`mapMcpResponse` / `mapA2aArtifact` run AFTER the framework's default projection. Receive the framework's projected response; return a transformed one. The framework re-validates the result against the spec's response schema before sending; adopters can't drift the wire shape.

## Idempotency, signing, validation, sandbox

Already framework-owned today; carries unchanged. Idempotency middleware runs before dispatch on both transports. RFC 9421 signing verification runs before dispatch on both transports (when the platform claims `signed-requests` or `requireSignatureWhenPresent` is on). Strict validation runs before dispatch on both transports. Capability gating runs before dispatch (the spec's `VERSION_UNSUPPORTED` envelope is emitted by the framework when the buyer requests an unsupported `adcp_major_version`).

**Sandbox**, not `dry_run`. AdCP 3.0 expresses "validate against real platform without writing to production" via `AccountReference.sandbox: true`. Framework resolves the buyer's sandbox account through `accounts.resolve()`; the platform sees a normal `Account` and is responsible for routing reads/writes to its sandbox backend. There is no separate framework-level dry-run mode. Tool-specific `dry_run` flags (`sync_catalogs`, `sync_creatives`) are wire fields the platform receives and honors locally.

The platform never sees a request that's been dropped at any of these gates.

## Edge cases

**Streaming (`message/stream`)**. v0 doesn't support it. v6.0 ships without it. v6.1 adds it once A2A streaming conventions converge across the ecosystem; framework projects `AsyncOutcome.kind: 'submitted'` `TaskUpdate` events (`progress` / `completed` / `failed`) onto A2A streamed message frames.

**Mid-flight `input-required`**. Some platforms need to prompt the buyer for missing fields mid-call (e.g., GAM trafficker asks "which advertiser entity?"). v6.0 doesn't model this. Adopters needing it return `submitted` and prompt out-of-band, OR return `rejected` with `recovery: 'correctable'` and `field` populated; the buyer corrects and retries.

**Multi-tenant capability overrides**. Product expert flagged: a multi-tenant Prebid-style server has different `manualApprovalOperations` per tenant. v6.0 design choice: `getCapabilitiesFor(account: Account): DecisioningCapabilities` is an OPTIONAL override on `DecisioningPlatform`. When absent, the framework uses `platform.capabilities` for everyone. When present, it's resolved per-request after `accounts.resolve()` and used to gate that request. The AgentCard is derived from `platform.capabilities` (the static union); per-tenant differences are runtime-only.

**Error code completeness**. Framework expects the full spec enum (45 codes in AdCP 3.0). Adopters can use platform-specific codes via the `(string & {})` escape hatch on `AdcpStructuredError.code`; agents fall back to `recovery` classification on unknowns. Framework auto-fills `retry_after` for `RATE_LIMITED` / `SERVICE_UNAVAILABLE` if the platform omits it (using `opts.defaultRetryAfter` or 60s).

## Open questions

1. **Single `taskId` namespace across transports?** A buy created via A2A and queried via MCP `tasks/get` — should the same `taskId` work? Recommendation: yes, taskIds are opaque strings and the framework's task store is transport-agnostic. Document in JSDoc.

2. **Webhook idempotency**. When `notify` egresses to the buyer's webhook, framework dedupes by `(taskId, update.kind)`. Already in place for MCP; A2A inherits unchanged.

3. **AgentCard caching headers**. Static derivation; safe to cache for hours. Recommendation: `Cache-Control: max-age=3600, public, must-revalidate`. Configurable via `opts.agentCardCacheControl`.

4. **MCP schema versioning**. The MCP `tools/list` doesn't carry an AdCP version field. A2A `agent-card.json` does (`protocolVersion`). Recommendation: include a custom `_meta.adcp_version` field in MCP `tools/list` per tool; matches what the wire spec emits in tool responses today.

## Implementation phases

1. **Phase 1 (v6.0-rc.1)**: Tool registry derivation, MCP+A2A dispatch wiring, AsyncOutcome projection table, AgentCard auto-derivation, framework-owned `dry_run` interception, `getCapabilitiesFor(account)` per-tenant override.
2. **Phase 2 (v6.0-rc.2)**: Per-tool overrides (`mapMcpResponse` / `mapA2aArtifact`), AgentCard `skillDescriptionOverrides`, AdcpStructuredError.field/suggestion/retry_after wire alignment.
3. **Phase 3 (v6.1)**: Streaming (`message/stream`), `input-required` lifecycle, AsyncOutcome → A2A streamed-frame projection.

## What this gives up

Adopters who want non-AdCP MCP tools alongside their AdCP tools (e.g., a custom `internal/health-check` MCP tool exposed through the same server) need to escape the unified surface — they get the underlying `AdcpServer.mcp` handle and call `registerTool()` themselves. This is the explicit cost of opinionated wire mapping.

For DSP-side / agency-side adopters: this scaffold is seller-side only. DSPs/agencies don't implement `DecisioningPlatform`; they consume agents that do. Their SDK story is unchanged (the buyer-side typed client surface).

## Bottom line

`serve(platform)` is the entry point. Capabilities are declared once and project to both transports. Adopters never write protocol-specific code unless they explicitly want the escape hatch. AsyncOutcome is the universal async pattern; the framework owns the wire mapping table.

Build it from the start.
