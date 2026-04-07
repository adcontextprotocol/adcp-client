# Build an AdCP Agent

## Overview

This guide walks through building an AdCP agent (server) using `@adcp/client`. While most documentation covers the client side — calling existing agents — this guide covers the server side: implementing an agent that other clients can discover and call.

We'll build a **signals agent** that serves audience segments via the `get_signals` tool. The same patterns apply to any AdCP tool (`get_products`, `create_media_buy`, etc.).

## Prerequisites

- Node.js 18+
- `@adcp/client` installed (`npm install @adcp/client`)
- `@modelcontextprotocol/sdk` (installed as a dependency of `@adcp/client`)

## Quick Start

A minimal signals agent in ~40 lines:

```typescript
import { createTaskCapableServer, taskToolResponse } from '@adcp/client';
import { GetSignalsRequestSchema } from '@adcp/client';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from 'http';

const server = createTaskCapableServer('My Signals Agent', '1.0.0');

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

const httpServer = createServer(async (req, res) => {
  if (req.url === '/mcp' || req.url === '/mcp/') {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

httpServer.listen(3001, () => console.log('Agent running at http://localhost:3001/mcp'));
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

// Pass .shape to server.tool() for MCP tool registration
server.tool('get_signals', GetSignalsRequestSchema.shape, async (args) => {
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

### HTTP Transport

AdCP agents serve over HTTP using the MCP Streamable HTTP transport. The standard pattern creates a new server instance per request:

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

## What's Next

- Add `activate_signal` to let clients activate segments on destinations
- Add `get_adcp_capabilities` to declare your agent's supported protocols
- Implement `registerAdcpTaskTool()` for async tools that need background processing
- Deploy behind a reverse proxy with authentication for production use
