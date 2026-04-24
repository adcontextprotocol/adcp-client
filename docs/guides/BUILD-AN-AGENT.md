# Build an AdCP Agent

## Overview

This guide walks through building an AdCP agent (server) using `@adcp/client`. While most documentation covers the client side — calling existing agents — this guide covers the server side: implementing an agent that other clients can discover and call.

We'll build a **signals agent** that serves audience segments via the `get_signals` tool. The same patterns apply to any AdCP tool (`get_products`, `create_media_buy`, etc.).

## Prerequisites

- Node.js 18+
- `@adcp/client` installed (`npm install @adcp/client`)
- `@modelcontextprotocol/sdk` (installed as a dependency of `@adcp/client`)

## Quick Start

A minimal signals agent using `createAdcpServer`:

```typescript
import { createAdcpServer, serve } from '@adcp/client';

serve(() => createAdcpServer({
  name: 'My Signals Agent',
  version: '1.0.0',

  signals: {
    getSignals: async (params, ctx) => ({
      signals: [
        {
          signal_agent_segment_id: 'demo_segment',
          signal_id: { source: 'catalog', data_provider_domain: 'example.com', id: 'demo_segment' },
          name: 'Demo Segment',
          description: 'A demo audience segment.',
          value_type: 'binary',
          signal_type: 'owned',
          data_provider: 'My Agent',
          coverage_percentage: 10,
          deployments: [],
          pricing_options: [
            { pricing_option_id: 'po_demo', model: 'cpm', currency: 'USD', cpm: 5 },
          ],
        },
      ],
      sandbox: true,
    }),
  },
})); // listening on http://localhost:3001/mcp
```

Start it and test immediately:

```bash
npx tsx agent.ts
npx @adcp/client@latest http://localhost:3001/mcp                    # discover tools
npx @adcp/client@latest http://localhost:3001/mcp get_signals '{}'   # call get_signals
```

## Key Concepts

### createAdcpServer (Recommended)

The declarative way to build AdCP agents. You provide domain-grouped handler functions, and the framework handles schema validation, response formatting, account resolution, capabilities generation, and error catching.

```typescript
import { createAdcpServer, serve } from '@adcp/client';

serve(() => createAdcpServer({
  name: 'My Publisher',
  version: '1.0.0',

  resolveAccount: async (ref) => db.findAccount(ref),

  mediaBuy: {
    getProducts: async (params, ctx) => ({ products: catalog.search(params) }),
    createMediaBuy: async (params, ctx) => ({
      media_buy_id: `mb_${Date.now()}`,
      packages: [],
    }),
    getMediaBuyDelivery: async (params, ctx) => ({
      media_buys: [],
    }),
  },

  accounts: {
    listAccounts: async (params, ctx) => ({ accounts: [] }),
    syncAccounts: async (params, ctx) => ({ accounts: [] }),
  },
}));
```

**What the framework does for you:**

- **Auto-generates `get_adcp_capabilities`** from registered handlers — no manual capability declaration
- **Auto-applies response builders** — return raw data objects, the framework wraps them in MCP `CallToolResult` with `structuredContent`
- **Resolves accounts** — if a tool has an `account` field and `resolveAccount` is configured, the framework resolves it before calling your handler. Returns `ACCOUNT_NOT_FOUND` if resolution returns null.
- **Catches handler errors** — unhandled exceptions return `SERVICE_UNAVAILABLE` instead of crashing
- **Sets tool annotations** — `readOnlyHint`, `destructiveHint`, `idempotentHint` per tool
- **Warns on incoherent tool sets** — e.g., `create_media_buy` without `get_products`
- **Narrows response unions** — a handler may return the Success arm *or* the full response union (`Success | Error | Submitted`). Adapter-style handlers that already produce `Result<CreateMediaBuyResponse, ...>` don't need to pre-narrow: the dispatcher detects the arm by shape and routes accordingly. Error arms surface as `{ isError: true, structuredContent: { errors: [...] } }`; Submitted arms surface as `{ structuredContent: { status: 'submitted', task_id, ... } }` without the Success-only `revision` / `confirmed_at` defaults. You can still call `adcpError('CODE', ...)` directly for framework-style error envelopes.

### Exposing your agent over A2A (preview)

MCP is the default transport (`serve({ server: adcp })`). To additionally expose the same `AdcpServer` over A2A JSON-RPC — so A2A-native buyers can discover and call your agent — mount `createA2AAdapter`:

```typescript
import express from 'express';
import { createAdcpServer, serve, createA2AAdapter } from '@adcp/client';

const adcp = createAdcpServer({
  mediaBuy: { getProducts: async () => ({ products: [] }) },
});

// MCP (as today)
serve(() => adcp);

// A2A (new, preview)
const a2a = createA2AAdapter({
  server: adcp,
  agentCard: {
    name: 'Acme SSP',
    description: 'Guaranteed + non-guaranteed display inventory',
    url: 'https://ssp.acme.com/a2a',
    version: '1.0.0',
    provider: { organization: 'Acme', url: 'https://acme.com' },
    securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
  },
  async authenticate(req) {
    const token = req.headers.authorization?.replace(/^Bearer\s+/, '');
    return token ? { token, clientId: 'buyer_123', scopes: [] } : null;
  },
});

const app = express();
app.use(express.json());
// mount() wires: JSON-RPC at the `agentCard.url` pathname (`/a2a` here),
// the agent card at both `{basePath}/.well-known/agent-card.json` (A2A
// SDK discovery derives this) AND `/.well-known/agent-card.json` (origin-
// root probes). The `jsonRpcHandler` and `agentCardHandler` properties
// stay exposed for deployments that need custom mounting.
a2a.mount(app);
app.listen(3000);
```

Both transports share the same `AdcpServer` — handlers, idempotency store, state store, and `resolveAccount` all run the same pipeline regardless of which transport received the request. Changes to handlers are picked up by both at once.

**Skill addressing.** A2A clients send a `Message` with a single `DataPart`: `{ kind: 'data', data: { skill: 'get_products', input: { brief: '...' } } }`. `skill` matches an AdCP tool name; `input` is the tool arguments. The legacy key `parameters` (shipped by `src/lib/protocols/a2a.ts` before the adapter landed) is accepted as an alias for `input` so same-SDK clients and servers talk cleanly.

**Two lifecycles, one response.** A2A's `Task.state` tracks the *transport call* (did the HTTP request complete?). AdCP's `status` inside the artifact tracks the *work* (submitted / completed / failed). Don't conflate them — a `completed` A2A task can carry a `submitted` AdCP response, meaning the call returned but the ad-tech operation is still queued.

**Handler return → A2A `Task.state` + artifact:**

| Handler returned… | A2A `Task.state` | Artifact payload |
|---|---|---|
| Success arm | `completed` | DataPart with the typed AdCP response |
| Submitted arm (`status:'submitted'`) | `completed` | DataPart with the AdCP response; `adcp_task_id` on `artifact.metadata` |
| Error arm (`errors: [...]`) | `failed` | DataPart with the Error arm payload |
| `adcpError('CODE', ...)` | `failed` | DataPart with `adcp_error` |

**A2A `Task.id` vs AdCP `task_id`.** A2A owns its `Task.id` (SDK-generated per `message/send`). The AdCP-level `task_id` — present when the handler returned a Submitted arm — rides on `artifact.metadata.adcp_task_id`, off the DataPart's payload so the `data` still validates cleanly against the AdCP response schema. Buyers resuming the A2A side poll via `tasks/get` using the A2A `Task.id`; buyers reaching for AdCP-side async state use `adcp_task_id`.

**v0 scope.** `message/send`, `tasks/get`, `tasks/cancel`, `GET /.well-known/agent-card.json`. Streaming (`message/stream`), push notifications, and `input-required` mid-flight interrupts are explicit "not yet" — tracked for v1. Pin a minor version while the surface stabilises.

### Reading tool results (client side)

The framework emits responses with typed data in `structuredContent` (MCP L3) and a human-readable summary in `content[0].text` (L2). When calling an AdCP agent from client code, prefer `structuredContent`; only fall back to parsing the text block for pre-`structuredContent` servers. The SDK ships two helpers with different failure modes:

```typescript
import { extractResult, unwrapProtocolResponse } from '@adcp/client';

const res = await mcpClient.callTool({ name: 'get_products', arguments: { brief: '...' } });

// Happy-path: returns structuredContent (or JSON-parsed text); undefined if neither yields data.
const payload = extractResult<GetProductsResponse>(res);

// Validated read: narrows against the tool schema, throws on missing / drifted payloads.
const validated = unwrapProtocolResponse(res, 'get_products', 'mcp');
```

Pick based on the caller: `extractResult` when you just want the payload and can handle `undefined`; `unwrapProtocolResponse` when you want a schema-narrowed AdCP response or an explicit throw.

### Returning errors from handlers

Two shapes round-trip as errors, and they mean different things:

- **Spec-defined tool failure** — return the tool's `*Error` arm directly: `return { errors: [{ code: 'PRODUCT_NOT_FOUND', message: 'no such product' }] }`. The dispatcher detects the Error arm by shape, sets `isError: true`, and preserves the `errors[]` / `context` / `ext` fields on `structuredContent`. Use this when the AdCP spec defines a per-tool error variant for the condition you're surfacing.
- **Framework / infra failure** — return `adcpError('CODE', { message: '...' })`. Use this for validation drift, idempotency conflicts, authentication failures, rate-limits, `SERVICE_UNAVAILABLE`, and anything else the spec classifies via the standard `code` vocabulary. The envelope lands at `structuredContent.adcp_error`.

Both surface as `isError: true` on the wire, and both skip response-schema validation. Buyers that need to distinguish can look for `structuredContent.adcp_error` (framework) vs `structuredContent.errors` (tool Error arm).

**7 domain groups:**

| Group | Handler keys |
|-------|-------------|
| `mediaBuy` | `getProducts`, `createMediaBuy`, `updateMediaBuy`, `getMediaBuys`, `getMediaBuyDelivery`, `providePerformanceFeedback`, `listCreativeFormats`, `syncCreatives`, `listCreatives` |
| `signals` | `getSignals`, `activateSignal` |
| `creative` | `listCreativeFormats`, `buildCreative`, `listCreatives`, `syncCreatives`, `getCreativeDelivery` |
| `governance` | `createPropertyList`, `updatePropertyList`, `getPropertyList`, `listPropertyLists`, `deletePropertyList`, `listContentStandards`, `getContentStandards`, `createContentStandards`, `updateContentStandards`, `calibrateContent`, `validateContentDelivery`, `getMediaBuyArtifacts`, `getCreativeFeatures`, `syncPlans`, `checkGovernance`, `reportPlanOutcome`, `getPlanAuditLogs` |
| `accounts` | `listAccounts`, `syncAccounts`, `syncGovernance`, `getAccountFinancials`, `reportUsage` |
| `eventTracking` | `syncEventSources`, `logEvent`, `syncAudiences`, `syncCatalogs` |
| `sponsoredIntelligence` | `getOffering`, `initiateSession`, `sendMessage`, `terminateSession` |

### State Persistence (ctx.store)

Every handler receives `ctx.store` — a key-value store for persisting domain objects across requests. Operations: `get`, `put`, `patch`, `delete`, `list`, each scoped by collection and ID.

```typescript
mediaBuy: {
  createMediaBuy: async (params, ctx) => {
    const mediaBuy = { media_buy_id: `mb_${Date.now()}`, status: 'pending', packages: [] };
    await ctx.store.put('media_buys', mediaBuy.media_buy_id, mediaBuy);
    return mediaBuy;
  },
  getMediaBuys: async (params, ctx) => {
    if (params.media_buy_ids?.length) {
      const buys = await Promise.all(
        params.media_buy_ids.map(id => ctx.store.get('media_buys', id))
      );
      return { media_buys: buys.filter(Boolean) };
    }
    const all = await ctx.store.list('media_buys');
    return { media_buys: all };
  },
},
```

`InMemoryStateStore` is the default (good for development and testing). Use `PostgresStateStore` for production deployments where state must survive restarts.

### Account Resolution

When `resolveAccount` is configured and a tool request includes an `account` field, the framework resolves the account before calling your handler. The resolved account is available as `ctx.account`.

```typescript
createAdcpServer({
  resolveAccount: async (ref) => {
    // ref is an AccountReference — has account_id, name, or domain
    return await db.accounts.findOne({ account_id: ref.account_id });
  },

  mediaBuy: {
    getProducts: async (params, ctx) => {
      // ctx.account is the resolved account (guaranteed non-null here)
      const products = await catalog.search(params, ctx.account.id);
      return { products };
    },
  },
});
```

If `resolveAccount` returns `null`, the framework responds with `ACCOUNT_NOT_FOUND` and the handler never runs.

### Idempotency (mutating tools)

AdCP v3 requires `idempotency_key` on every mutating request and requires sellers to declare a replay window. `@adcp/client/server` ships `createIdempotencyStore` which handles validation, JCS canonicalization, replay, and capability declaration:

```typescript
import {
  createAdcpServer,
  createIdempotencyStore,
  memoryBackend,
  pgBackend,
  serve,
} from '@adcp/client/server';

const idempotency = createIdempotencyStore({
  backend: memoryBackend(),       // or pgBackend(pool) — run getIdempotencyMigration() once
  ttlSeconds: 86400,              // 1h–7d, clamped to spec bounds
});

serve(() => createAdcpServer({
  name: 'My Publisher',
  version: '1.0.0',
  idempotency,
  resolveSessionKey: (ctx) => ctx.account?.id,  // doubles as idempotency principal
  mediaBuy: {
    createMediaBuy: async (params, ctx) => ({
      media_buy_id: `mb_${Date.now()}`,
      packages: [],
    }),
  },
}));
```

The framework auto-handles:
- `INVALID_REQUEST` when the key is missing on mutating tools
- `IDEMPOTENCY_CONFLICT` on same-key-different-payload (no payload leak in the error body)
- `IDEMPOTENCY_EXPIRED` past the TTL, with ±60s clock-skew tolerance
- `replayed: true` injection on the envelope when replaying a cached response
- `adcp.idempotency.replay_ttl_seconds` declared on `get_adcp_capabilities`

Scoping is per-principal — `resolveSessionKey` doubles as the idempotency principal, so two buyers with different session keys won't share cache entries. Override with `resolveIdempotencyPrincipal` if you need a different scope (e.g., `operator_id`).

**Only successful responses are cached.** Handler errors re-execute on retry rather than replaying — so a transient 5xx doesn't lock a failure into the cache.

### Schema-Driven Validation (opt-in)

`createAdcpServer` can validate every inbound request and handler response against the bundled AdCP JSON schemas for the SDK's declared version. Catches field-name drift (e.g. a handler emits `targeting_overlay` where the spec expects `targeting`) before the response leaves your agent.

```typescript
createAdcpServer({
  name: 'my-seller',
  version: '1.0.0',
  validation: {
    requests: 'strict',   // reject malformed requests with VALIDATION_ERROR
    responses: 'warn',    // log handler drift, return response unchanged
  },
  mediaBuy: { /* … */ },
});
```

Modes per side: `'strict' | 'warn' | 'off'`. Default is `'off'` — enable explicitly. `VALIDATION_ERROR` envelopes carry the full issue list (pointer, message, keyword, schema path) at the top level `adcp_error.issues` (and mirrored at `details.issues` for spec-convention compatibility) so buyers can surface each offending field without drilling into nested metadata.

**Note on MCP `tools/list` introspection**: `@adcp/client` agents register framework tools with a passthrough input schema so the framework AJV validator is authoritative on both MCP and A2A (see [#909](https://github.com/adcontextprotocol/adcp-client/issues/909)). One visible consequence: MCP `tools/list` publishes `{ type: 'object', properties: {}, additionalProperties: {} }` for every framework tool — not the per-tool parameter schema. Generic MCP discovery clients that lean on `tools/list` inputSchema for field-level introspection will see an untyped surface. AdCP-native discovery via `get_adcp_capabilities` is unaffected; upstream [adcp#3057](https://github.com/adcontextprotocol/adcp/issues/3057) proposes a `get_schema` capability tool for per-tool shape discovery across transports.

The same validator runs on the `AdcpClient` side — storyboards and third-party clients configure it via `validation: { requests, responses }` on the client config. Request default is `warn` (so existing callers that send partial payloads still work); response default is `strict` in dev/test, `warn` in production. Set either side to `'off'` for zero overhead.

### createTaskCapableServer (Low-Level)

For advanced cases where you need direct control over MCP tool registration, schema wiring, and response formatting. `createAdcpServer` uses this internally.

```typescript
import { createTaskCapableServer, taskToolResponse, GetSignalsRequestSchema } from '@adcp/client';

function createAgent({ taskStore }) {
  const server = createTaskCapableServer('Agent Name', '1.0.0', { taskStore });

  server.tool('get_signals', 'Discover segments.', GetSignalsRequestSchema.shape, async (args) => {
    return taskToolResponse({ signals: [...], sandbox: true }, 'Found segments');
  });

  return server;
}
```

When using `createTaskCapableServer` directly, you are responsible for:
- Wiring Zod schemas via `.shape`
- Wrapping responses with `taskToolResponse()` or domain-specific builders
- Implementing `get_adcp_capabilities` manually
- Error handling in each tool handler

#### Envelope fields — `wrapEnvelope`

Attach `replayed`, `context`, and `operation_id` onto your inner response without reimplementing the per-error-code allowlist (IDEMPOTENCY_CONFLICT drops `replayed`, keeps `context`):

```typescript
import { wrapEnvelope } from '@adcp/client/server';

const inner = await createMediaBuy(request.params);
return wrapEnvelope(inner, { replayed: false, context: request.context });
```

On error, pass the AdCP error envelope as `inner` — the helper reads `adcp_error.code` and applies the allowlist:

```typescript
return wrapEnvelope(
  { adcp_error: { code: 'IDEMPOTENCY_CONFLICT', message, recovery: 'terminal' } },
  { context: request.context }
);
```

### Response Builders

With `createAdcpServer`, response builders are applied automatically — return raw data and the framework wraps it. If you need manual control (e.g., with `createTaskCapableServer`), builders are available:

```typescript
import { productsResponse, mediaBuyResponse, deliveryResponse, adcpError, taskToolResponse } from '@adcp/client';
```

### Task Statuses (Server-Side Contract)

When your agent receives a tool call, it returns one of these statuses. The buyer client handles each differently:

| Status | When to use | What the buyer client does |
|--------|------------|---------------------------|
| `completed` | Request fulfilled synchronously | Reads `result.data` and proceeds |
| `working` | Processing started, not done yet | Polls `tasks/get` until status changes |
| `submitted` | Will notify via webhook when done | Waits for webhook delivery at `push_notification_config.url` |
| `input_required` | Need clarification from buyer | Fires buyer's `InputHandler` callback with the question |
| `deferred` | Requires human decision | Returns a token; human resumes later via `result.deferred.resume()` |

With `createAdcpServer`, synchronous handlers return raw data and the framework sets `completed` automatically. With `createTaskCapableServer`, use `taskToolResponse()` explicitly.

For async tools that need background processing, use `registerAdcpTaskTool()`:

```typescript
import { registerAdcpTaskTool, InMemoryTaskStore } from '@adcp/client';

const taskStore = new InMemoryTaskStore();

registerAdcpTaskTool(server, taskStore, {
  name: 'create_media_buy',
  description: 'Create a media buy.',
  schema: CreateMediaBuyRequestSchema.shape,
  createTask: async (args) => {
    // Start processing, return a task ID
    const taskId = crypto.randomUUID();
    processInBackground(taskId, args); // your async logic
    return { taskId, status: 'submitted' };
  },
  getTask: async (taskId) => taskStore.get(taskId),
  getTaskResult: async (taskId) => taskStore.getResult(taskId),
});
```

**Error responses**: Use `adcpError()` with standard error codes. The buyer agent uses the `recovery` classification to decide retry behavior:

```typescript
import { adcpError } from '@adcp/client';

// correctable — buyer should fix params and retry
return adcpError('BUDGET_TOO_LOW', 'Minimum budget is $1,000');

// transient — buyer should retry after delay
return adcpError('SERVICE_UNAVAILABLE', 'Try again in 30 seconds');

// terminal — buyer should stop
return adcpError('ACCOUNT_SUSPENDED', 'Contact support');
```

See `docs/llms.txt` for the full error code table with recovery classifications.

### Storyboards

The `storyboards/` directory contains YAML files that define exactly what tool call sequences a buyer agent will make against your server. Each storyboard includes phases, steps, sample requests/responses, and validation rules.

Key storyboards for server-side builders:
- `media_buy_non_guaranteed.yaml` — auction-based buying flow
- `media_buy_guaranteed_approval.yaml` — guaranteed buying with IO approval
- `media_buy_proposal_mode.yaml` — proposal-based buying
- `creative_sales_agent.yaml` — push creative assets to your platform
- `signal_marketplace.yaml` / `signal_owned.yaml` — signals agent flows
- `si_session.yaml` — sponsored intelligence sessions
- `media_buy_governance_escalation.yaml` — governance with human escalation

### HTTP Transport

The `serve()` helper handles HTTP transport setup. Pass it a factory function that returns a configured `McpServer`:

```typescript
import { createAdcpServer, serve } from '@adcp/client';

serve(() => createAdcpServer({ name: 'My Agent', version: '1.0.0', /* handlers */ }));
serve(() => createAdcpServer({ /* ... */ }), { port: 8080 });          // custom port
serve(() => createAdcpServer({ /* ... */ }), { path: '/v1/mcp' });     // custom path
```

`serve()` returns the underlying `http.Server` for lifecycle control (e.g., graceful shutdown).

When using `createTaskCapableServer` directly, `serve()` passes a `{ taskStore }` to your factory so MCP Tasks work correctly across stateless HTTP requests.

For custom routing or middleware, you can wire the transport manually:

```typescript
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from 'http';

const httpServer = createServer(async (req, res) => {
  if (req.url === '/mcp' || req.url === '/mcp/') {
    const agentServer = createMyAgent();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    try {
      await agentServer.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      console.error('Server error:', err);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal server error' }));
      }
    } finally {
      await agentServer.close();
    }
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});
```

## Testing Your Agent

### Tool Discovery

```bash
npx @adcp/client@latest http://localhost:3001/mcp
```

This lists all tools your agent exposes, their descriptions, and parameters. If `get_signals` appears with the correct schema, your agent is wired up correctly.

### Calling Tools

```bash
# All segments
npx @adcp/client@latest http://localhost:3001/mcp get_signals '{"signal_spec":"audience segments"}'

# Filtered by text
npx @adcp/client@latest http://localhost:3001/mcp get_signals '{"signal_spec":"shoppers"}'

# Filtered by catalog type
npx @adcp/client@latest http://localhost:3001/mcp get_signals '{"filters":{"catalog_types":["marketplace"]}}'

# JSON output for scripting
npx @adcp/client@latest http://localhost:3001/mcp get_signals '{}' --json
```

### Compliance Check

```bash
npx @adcp/client@latest storyboard run http://localhost:3001/mcp
```

This runs a standard validation suite against your agent to check AdCP compliance. For the full validation picture — storyboard runner, property-based fuzzing (`adcp fuzz`), multi-instance testing, webhook conformance, request-signing, schema-driven validation, and the skill→agent→grader dogfood harness — see [**VALIDATE-YOUR-AGENT.md**](./VALIDATE-YOUR-AGENT.md).

## Complete Example

See [`examples/signals-agent.ts`](../../examples/signals-agent.ts) for a complete, runnable signals agent with:

- Three audience segments (owned, custom, marketplace)
- Text search via `signal_spec`
- Filtering by `signal_ids` and `catalog_types`
- Result limiting via `max_results`
- Proper HTTP transport setup

See [`examples/error-compliant-server.ts`](../../examples/error-compliant-server.ts) for a media buy agent demonstrating:

- Multiple tools (`get_products`, `create_media_buy`, `get_media_buy_delivery`)
- Structured error handling with `adcpError()`
- Rate limiting
- Business logic validation

## Related

- [`registerAdcpTaskTool()`](../../src/lib/server/tasks.ts) — for async tools that need background processing
- [`examples/error-compliant-server.ts`](../../examples/error-compliant-server.ts) — media buy agent with multiple tools and error handling
- [AdCP specification](https://adcontextprotocol.org) — full protocol reference
