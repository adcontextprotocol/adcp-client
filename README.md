# @adcp/client

[![npm version](https://badge.fury.io/js/@adcp%2Fclient.svg)](https://badge.fury.io/js/@adcp%2Fclient)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-Ready-blue.svg)](https://www.typescriptlang.org/)

Official TypeScript/JavaScript client for the **Ad Context Protocol (AdCP)**. Build distributed advertising operations that work synchronously OR asynchronously with the same code.

## The Core Concept

AdCP operations are **distributed and asynchronous by default**. An agent might:
- Complete your request **immediately** (synchronous)
- Need time to process and **send results via webhook** (asynchronous)
- Ask for **clarifications** before proceeding
- Send periodic **status updates** as work progresses

**Your code stays the same.** You write handlers once, and they work for both sync completions and webhook deliveries.

## Installation

```bash
npm install @adcp/client
```

## Quick Start: Distributed Operations

```typescript
import { ADCPMultiAgentClient, createOperationId } from '@adcp/client';

// Configure agents and handlers
const client = new ADCPMultiAgentClient([
  {
    id: 'agent_x',
    agent_uri: 'https://agent-x.com',
    protocol: 'a2a'
  },
  {
    id: 'agent_y',
    agent_uri: 'https://agent-y.com/mcp/',
    protocol: 'mcp'
  }
], {
  // Webhook URL template (macros: {agent_id}, {task_type}, {operation_id})
  webhookUrlTemplate: 'https://myapp.com/webhook/{task_type}/{agent_id}/{operation_id}',

  // Single handlers work for BOTH sync and async completions
  handlers: {
    onGetProductsComplete: (response, metadata) => {
      console.log(`Got ${response.products?.length} products`);
      console.log(`Via: ${metadata.operation_id}`);
      db.saveProducts(metadata.operation_id, response.products);
    },

    onTaskFailed: (metadata, error) => {
      console.error(`Operation ${metadata.operation_id} failed: ${error}`);
      db.markFailed(metadata.operation_id, error);
    }
  }
});

// Execute operation
const operationId = createOperationId();
const agent = client.agent('agent_x');

const result = await agent.getProducts(
  { brief: 'Coffee brands' },
  null, // No input handler = allow webhooks
  {
    contextId: operationId,
    webhookUrl: agent.getWebhookUrl('get_products', operationId)
  }
);

// Check result
if (result.status === 'completed') {
  // Agent completed synchronously!
  console.log('Sync:', result.data.products);
  // Handler ALREADY fired ✓
}

if (result.status === 'submitted') {
  // Agent will send webhook when complete
  console.log('Async - webhook will arrive at:', result.submitted?.webhookUrl);
  // Handler will fire when webhook arrives ✓
}
```

## Webhook Pattern

All webhooks (task completions AND notifications) use one endpoint with flexible URL templates.

### Configure Your Webhook URL Structure

```typescript
const client = new ADCPMultiAgentClient(agents, {
  // Path-based (default pattern)
  webhookUrlTemplate: 'https://myapp.com/webhook/{task_type}/{agent_id}/{operation_id}',

  // OR query string
  webhookUrlTemplate: 'https://myapp.com/webhook?agent={agent_id}&op={operation_id}&type={task_type}',

  // OR custom path
  webhookUrlTemplate: 'https://myapp.com/api/v1/adcp/{agent_id}?operation={operation_id}',

  // OR namespace to avoid conflicts
  webhookUrlTemplate: 'https://myapp.com/adcp-webhooks/{agent_id}/{task_type}/{operation_id}'
});
```

### Single Webhook Endpoint

```typescript
// Handles ALL webhooks (task completions and notifications)
app.post('/webhook/:task_type/:agent_id/:operation_id', async (req, res) => {
  const { task_type, agent_id, operation_id } = req.params;

  // Inject URL parameters into payload
  const payload = {
    ...req.body,
    task_type,
    operation_id
  };

  // Route to agent client - handlers fire automatically
  const agent = client.agent(agent_id);
  await agent.handleWebhook(payload, req.headers['x-adcp-signature']);

  res.json({ received: true });
});
```

### URL Generation is Automatic

```typescript
const operationId = createOperationId();
const webhookUrl = agent.getWebhookUrl('sync_creatives', operationId);
// Returns: https://myapp.com/webhook/sync_creatives/agent_x/op_123
// (or whatever your template generates)
```

## Activity Events

Get observability into everything happening:

```typescript
const client = new ADCPMultiAgentClient(agents, {
  onActivity: (activity) => {
    console.log({
      type: activity.type,              // 'protocol_request', 'webhook_received', etc.
      operation_id: activity.operation_id,
      agent_id: activity.agent_id,
      status: activity.status
    });

    // Stream to UI, save to database, send to monitoring
    eventStream.send(activity);
  }
});
```

Activity types:
- `protocol_request` - Request sent to agent
- `protocol_response` - Response received from agent
- `webhook_received` - Webhook received from agent
- `handler_called` - Completion handler fired

## Notifications (Agent-Initiated)

Agents can send periodic updates (like delivery reports) without you requesting them.

**Mental Model**: Notifications are status updates for an ongoing operation:
- `notification_type: 'scheduled'` → Progress update (like `status: 'working'`)
- `notification_type: 'final'` → Operation complete (like `status: 'completed'`)
- `notification_type: 'delayed'` → Still waiting (extended timeline)

```typescript
const client = new ADCPMultiAgentClient(agents, {
  handlers: {
    onMediaBuyDeliveryNotification: (notification, metadata) => {
      console.log(`Report ${metadata.sequence_number}: ${metadata.notification_type}`);

      // Save as status update for this operation
      // All notifications for same agent + month share operation_id
      db.saveDeliveryUpdate(metadata.operation_id, notification);

      // If final report, mark operation complete
      if (metadata.notification_type === 'final') {
        db.markOperationComplete(metadata.operation_id);
      }
    }
  }
});
```

Notifications use the **same webhook URL pattern**:
```
POST https://myapp.com/webhook/media_buy_delivery/agent_x/delivery_report_agent_x_2025-10
```

The `operation_id` is lazily generated from agent + month: `delivery_report_{agent_id}_{YYYY-MM}`

All intermediate reports for the same agent + month → same `operation_id`

## Type Safety

Full TypeScript support with IntelliSense:

```typescript
// All responses are fully typed
const result = await agent.getProducts(params);
// result: TaskResult<GetProductsResponse>

if (result.success) {
  result.data.products.forEach(p => {
    console.log(p.name, p.price); // Full autocomplete!
  });
}

// Handlers receive typed responses
handlers: {
  onCreateMediaBuyComplete: (response, metadata) => {
    // response: CreateMediaBuyResponse
    // metadata: WebhookMetadata
    const buyId = response.media_buy_id; // Typed!
  }
}
```

## Multi-Agent Operations

Execute across multiple agents simultaneously:

```typescript
const client = new ADCPMultiAgentClient([agentX, agentY, agentZ]);

// Parallel execution across all agents
const results = await client.getProducts({ brief: 'Coffee brands' });
// results: TaskResult<GetProductsResponse>[]

results.forEach((result, i) => {
  const agentId = client.agentIds[i];
  console.log(`${agentId}: ${result.status}`);

  if (result.status === 'completed') {
    console.log(`  Sync: ${result.data.products?.length} products`);
  } else if (result.status === 'submitted') {
    console.log(`  Async: webhook to ${result.submitted?.webhookUrl}`);
  }
});
```

## Security

### Webhook Signature Verification

```typescript
const client = new ADCPMultiAgentClient(agents, {
  webhookSecret: process.env.WEBHOOK_SECRET
});

// Signatures verified automatically on handleWebhook()
// Returns 401 if signature invalid
```

### Authentication

```typescript
const agents = [{
  id: 'agent_x',
  agent_uri: 'https://agent-x.com',
  protocol: 'a2a',
  auth_token_env: process.env.AGENT_X_TOKEN, // ✅ Secure
  requiresAuth: true
}];
```

## Environment Configuration

```bash
# .env
WEBHOOK_URL_TEMPLATE="https://myapp.com/webhook/{task_type}/{agent_id}/{operation_id}"
WEBHOOK_SECRET="your-webhook-secret"

ADCP_AGENTS='[
  {
    "id": "agent_x",
    "agent_uri": "https://agent-x.com",
    "protocol": "a2a",
    "auth_token_env": "AGENT_X_TOKEN"
  }
]'
AGENT_X_TOKEN="actual-token-here"
```

```typescript
// Auto-discover from environment
const client = ADCPMultiAgentClient.fromEnv();
```

## Available Tools

All AdCP tools with full type safety:

**Media Buy Lifecycle:**
- `getProducts()` - Discover advertising products
- `listCreativeFormats()` - Get supported creative formats
- `createMediaBuy()` - Create new media buy
- `updateMediaBuy()` - Update existing media buy
- `syncCreatives()` - Upload/sync creative assets
- `listCreatives()` - List creative assets
- `getMediaBuyDelivery()` - Get delivery performance

**Audience & Targeting:**
- `listAuthorizedProperties()` - Get authorized properties
- `getSignals()` - Get audience signals
- `activateSignal()` - Activate audience signals
- `providePerformanceFeedback()` - Send performance feedback

## Database Schema

Simple unified event log for all operations:

```sql
CREATE TABLE webhook_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id TEXT NOT NULL,        -- Groups related events
  agent_id TEXT NOT NULL,
  task_type TEXT NOT NULL,           -- 'sync_creatives', 'media_buy_delivery', etc.
  status TEXT,                       -- For tasks: 'submitted', 'working', 'completed'
  notification_type TEXT,            -- For notifications: 'scheduled', 'final', 'delayed'
  sequence_number INTEGER,           -- For notifications: report sequence
  payload JSONB NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_events_operation ON webhook_events(operation_id);
CREATE INDEX idx_events_agent ON webhook_events(agent_id);
CREATE INDEX idx_events_timestamp ON webhook_events(timestamp DESC);

-- Query all events for an operation
SELECT * FROM webhook_events
WHERE operation_id = 'op_123'
ORDER BY timestamp;

-- Get all delivery reports for agent + month
SELECT * FROM webhook_events
WHERE operation_id = 'delivery_report_agent_x_2025-10'
ORDER BY sequence_number;
```

## Testing

Try the live testing UI at `http://localhost:8080` when running the server:

```bash
npm start
```

Features:
- Configure multiple agents (test agents + your own)
- Execute ONE operation across all agents
- See live activity stream (protocol requests, webhooks, handlers)
- View sync vs async completions side-by-side
- Test different scenarios (clarifications, errors, timeouts)

## Examples

### Basic Operation
```typescript
const result = await agent.getProducts({ brief: 'Coffee brands' });
```

### With Clarification Handler
```typescript
const result = await agent.createMediaBuy(
  { brief: 'Coffee campaign' },
  (context) => {
    // Agent needs more info
    if (context.inputRequest.field === 'budget') {
      return 50000; // Provide programmatically
    }
    return context.deferToHuman(); // Or defer to human
  }
);
```

### With Webhook for Long-Running Operations
```typescript
const operationId = createOperationId();

const result = await agent.syncCreatives(
  { creatives: largeCreativeList },
  null, // No clarification handler = webhook mode
  {
    contextId: operationId,
    webhookUrl: agent.getWebhookUrl('sync_creatives', operationId)
  }
);

// Result will be 'submitted', webhook arrives later
// Handler fires when webhook received
```

## Contributing

Contributions welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

MIT License - see [LICENSE](LICENSE) file for details.

## Support

- **Documentation**: [GitHub Pages](https://your-org.github.io/adcp-client/)
- **Issues**: [GitHub Issues](https://github.com/your-org/adcp-client/issues)
- **Protocol Spec**: [AdCP Specification](https://github.com/adcontextprotocol/adcp)
