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
npx @adcp/client http://localhost:3001/mcp                    # discover tools
npx @adcp/client http://localhost:3001/mcp get_signals '{}'   # call get_signals
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
npx @adcp/client http://localhost:3001/mcp
```

This lists all tools your agent exposes, their descriptions, and parameters. If `get_signals` appears with the correct schema, your agent is wired up correctly.

### Calling Tools

```bash
# All segments
npx @adcp/client http://localhost:3001/mcp get_signals '{"signal_spec":"audience segments"}'

# Filtered by text
npx @adcp/client http://localhost:3001/mcp get_signals '{"signal_spec":"shoppers"}'

# Filtered by catalog type
npx @adcp/client http://localhost:3001/mcp get_signals '{"filters":{"catalog_types":["marketplace"]}}'

# JSON output for scripting
npx @adcp/client http://localhost:3001/mcp get_signals '{}' --json
```

### Compliance Check

```bash
npx @adcp/client storyboard run http://localhost:3001/mcp
```

This runs a standard validation suite against your agent to check AdCP compliance.

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
