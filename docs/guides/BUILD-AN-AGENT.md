# Build an AdCP Agent

## Overview

This guide walks through building an AdCP agent (server) using `@adcp/client`. While most documentation covers the client side — calling existing agents — this guide covers the server side: implementing an agent that other clients can discover and call.

We'll build a **signals agent** that serves audience segments via the `get_signals` tool. The same patterns apply to any AdCP tool (`get_products`, `create_media_buy`, etc.).

## Prerequisites

- Node.js 18+
- `@adcp/client` installed (`npm install @adcp/client`)
- `@modelcontextprotocol/sdk` (installed as a dependency of `@adcp/client`)

## Quick Start

A minimal signals agent in ~20 lines:

```typescript
import {
  createTaskCapableServer,
  taskToolResponse,
  serve,
  GetSignalsRequestSchema,
} from '@adcp/client';

function createAgent({ taskStore }) {
  const server = createTaskCapableServer('My Signals Agent', '1.0.0', { taskStore });

  server.tool(
    'get_signals',
    'Discover audience segments.',
    GetSignalsRequestSchema.shape,
    async (args) => {
      const signals = [
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
      ];

      return taskToolResponse({ signals, sandbox: true }, `Found ${signals.length} segment(s)`);
    },
  );

  return server;
}

serve(createAgent); // listening on http://localhost:3001/mcp
```

Start it and test immediately:

```bash
npx tsx agent.ts
npx @adcp/client http://localhost:3001/mcp                    # discover tools
npx @adcp/client http://localhost:3001/mcp get_signals '{}'   # call get_signals
```

## Key Concepts

### createTaskCapableServer

Creates an MCP server pre-configured with task support (async operations). This is the recommended way to build AdCP agents — it handles task lifecycle plumbing so you can focus on business logic.

```typescript
import { createTaskCapableServer } from '@adcp/client';

const server = createTaskCapableServer('Agent Name', '1.0.0', {
  instructions: 'Description of what your agent does.',
});
```

For sync-only tools, use `server.tool()` directly. For tools that need async processing, use `registerAdcpTaskTool()` which requires explicit `createTask`/`getTask`/`getTaskResult` handlers.

### Generated Schemas

`@adcp/client` exports Zod schemas for every AdCP tool's input and output. Use these instead of hand-rolling JSON Schema definitions:

```typescript
import {
  GetSignalsRequestSchema,    // input validation for get_signals
  GetSignalsResponseSchema,   // output validation
  GetProductsRequestSchema,   // input validation for get_products
  CreateMediaBuyRequestSchema,
} from '@adcp/client';

// The MCP SDK expects a plain object of Zod fields, not a Zod schema — .shape unwraps it.
server.tool('get_signals', 'Discover audience segments.', GetSignalsRequestSchema.shape, async (args) => {
  // args is fully typed from the schema
});
```

### taskToolResponse

Builds a properly formatted MCP `CallToolResult` from your response data:

```typescript
import { taskToolResponse } from '@adcp/client';

// Returns { content: [{ type: 'text', text: '...' }] }
return taskToolResponse(
  { signals: [...], sandbox: true },
  'Found 3 audience segment(s)',  // summary text
);
```

For media buy and product tools, dedicated response builders are also available:

```typescript
import { productsResponse, mediaBuyResponse, deliveryResponse, adcpError } from '@adcp/client';
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

For synchronous tools, use `taskToolResponse()` — it sets `completed` automatically:

```typescript
return taskToolResponse({ signals: [...], sandbox: true }, 'Found 3 segments');
```

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

The `serve()` helper handles HTTP transport setup. Pass it a factory function that receives a `ServeContext` and returns a configured `McpServer`:

```typescript
import { serve } from '@adcp/client';

serve(createMyAgent);                          // defaults: port 3001, path /mcp
serve(createMyAgent, { port: 8080 });          // custom port
serve(createMyAgent, { path: '/v1/mcp' });     // custom path
```

`serve()` creates a shared task store and passes it to your factory on every request via `{ taskStore }`. Pass it through to `createTaskCapableServer()` so MCP Tasks work correctly across stateless HTTP requests.

`serve()` returns the underlying `http.Server` for lifecycle control (e.g., graceful shutdown).

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
npx @adcp/client comply http://localhost:3001/mcp
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
