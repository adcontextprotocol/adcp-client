# @adcp/client

[![npm version](https://badge.fury.io/js/@adcp%2Fclient.svg)](https://badge.fury.io/js/@adcp%2Fclient)
[![npm downloads](https://img.shields.io/npm/dm/@adcp/client.svg)](https://www.npmjs.com/package/@adcp/client)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-Ready-blue.svg)](https://www.typescriptlang.org/)
[![API Documentation](https://img.shields.io/badge/API-Documentation-blue.svg)](https://adcontextprotocol.github.io/adcp-client/api/)
[![GitHub Workflow Status](https://img.shields.io/github/actions/workflow/status/adcontextprotocol/adcp-client/ci.yml?branch=main)](https://github.com/adcontextprotocol/adcp-client/actions)

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
import { ADCPMultiAgentClient } from '@adcp/client';

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

  // Activity callback - fires for ALL events (requests, responses, status changes, webhooks)
  onActivity: (activity) => {
    console.log(`[${activity.type}] ${activity.task_type} - ${activity.operation_id}`);
    // Log to monitoring, update UI, etc.
  },

  // Status change handlers - called for ALL status changes (completed, failed, needs_input, working, etc)
  handlers: {
    onGetProductsStatusChange: (response, metadata) => {
      // Called for sync completion, async webhook, AND status changes
      console.log(`[${metadata.status}] Got products for ${metadata.operation_id}`);

      if (metadata.status === 'completed') {
        db.saveProducts(metadata.operation_id, response.products);
      } else if (metadata.status === 'failed') {
        db.markFailed(metadata.operation_id, metadata.error);
      } else if (metadata.status === 'needs_input') {
        // Handle clarification needed
        console.log('Needs input:', response.message);
      }
    }
  }
});

// Execute operation - library handles operation IDs, webhook URLs, context management
const agent = client.agent('agent_x');
const result = await agent.getProducts({ brief: 'Coffee brands' });

// onActivity fired: protocol_request
// onActivity fired: protocol_response

// Check result
if (result.status === 'completed') {
  // Agent completed synchronously!
  console.log('✅ Sync completion:', result.data.products.length, 'products');
  // onGetProductsStatusChange handler ALREADY fired with status='completed' ✓
}

if (result.status === 'submitted') {
  // Agent will send webhook when complete
  console.log('⏳ Async - webhook registered at:', result.submitted?.webhookUrl);
  // onGetProductsStatusChange handler will fire when webhook arrives ✓
}
```

### Handling Clarifications (needs_input)

When an agent needs more information, you can continue the conversation:

```typescript
const result = await agent.getProducts({ brief: 'Coffee brands' });

if (result.status === 'needs_input') {
  console.log('❓ Agent needs clarification:', result.needs_input?.message);
  // onActivity fired: status_change (needs_input)

  // Continue the conversation with the same agent
  const refined = await agent.continueConversation('Only premium brands above $50');
  // onActivity fired: protocol_request
  // onActivity fired: protocol_response

  if (refined.status === 'completed') {
    console.log('✅ Got refined results:', refined.data.products.length);
    // onGetProductsStatusChange handler fired ✓
  }
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

**Mental Model**: Notifications are operations that get set up when you create a media buy. The agent sends periodic updates (like delivery reports) to the webhook URL you configured during media buy creation.

```typescript
// When creating a media buy, agent registers for delivery notifications
const result = await agent.createMediaBuy({
  campaign_id: 'camp_123',
  budget: { amount: 10000, currency: 'USD' }
  // Agent internally sets up recurring delivery_report notifications
});

// Later, agent sends notifications to your webhook
const client = new ADCPMultiAgentClient(agents, {
  handlers: {
    onMediaBuyDeliveryNotification: (notification, metadata) => {
      console.log(`Report #${metadata.sequence_number}: ${metadata.notification_type}`);

      // notification_type indicates progress:
      // 'scheduled' → Progress update (like status: 'working')
      // 'final' → Operation complete (like status: 'completed')
      // 'delayed' → Still waiting (extended timeline)

      db.saveDeliveryUpdate(metadata.operation_id, notification);

      if (metadata.notification_type === 'final') {
        db.markOperationComplete(metadata.operation_id);
      }
    }
  }
});
```

Notifications use the **same webhook URL pattern** as regular operations:
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

## Property Discovery (AdCP v2.2.0)

Build agent registries by discovering properties agents can sell. Works with AdCP v2.2.0's publisher-domain model.

### How It Works

1. **Agents return publisher domains**: Call `listAuthorizedProperties()` → get `publisher_domains[]`
2. **Fetch property definitions**: Get `https://{domain}/.well-known/adagents.json` from each domain
3. **Index properties**: Build fast lookups for "who can sell X?" and "what can agent Y sell?"

### Three Key Queries

```typescript
import { PropertyCrawler, getPropertyIndex } from '@adcp/client';

// First, crawl agents to discover properties
const crawler = new PropertyCrawler();
await crawler.crawlAgents([
  { agent_url: 'https://agent-x.com', protocol: 'a2a' },
  { agent_url: 'https://agent-y.com/mcp/', protocol: 'mcp' }
]);

const index = getPropertyIndex();

// Query 1: Who can sell this property?
const matches = index.findAgentsForProperty('domain', 'cnn.com');
// Returns: [{ property, agent_url, publisher_domain }]

// Query 2: What can this agent sell?
const auth = index.getAgentAuthorizations('https://agent-x.com');
// Returns: { agent_url, publisher_domains: [...], properties: [...] }

// Query 3: Find by tags
const premiumProperties = index.findAgentsByPropertyTags(['premium', 'ctv']);
```

### Full Example

```typescript
import { PropertyCrawler, getPropertyIndex } from '@adcp/client';

const crawler = new PropertyCrawler();

// Crawl agents - gets publisher_domains from each, then fetches adagents.json
const result = await crawler.crawlAgents([
  { agent_url: 'https://sales.cnn.com' },
  { agent_url: 'https://sales.espn.com' }
]);

console.log(`✅ ${result.successfulAgents} agents`);
console.log(`📡 ${result.totalPublisherDomains} publisher domains`);
console.log(`📦 ${result.totalProperties} properties indexed`);

// Now query
const index = getPropertyIndex();
const whoCanSell = index.findAgentsForProperty('ios_bundle', 'com.cnn.app');

for (const match of whoCanSell) {
  console.log(`${match.agent_url} can sell ${match.property.name}`);
}
```

### Property Types

Supports 18 identifier types: `domain`, `subdomain`, `ios_bundle`, `android_package`, `apple_app_store_id`, `google_play_id`, `roku_channel_id`, `podcast_rss_feed`, and more.

### Use Case

Build a registry service that:
- Periodically crawls agents with `PropertyCrawler`
- Persists discovered properties to a database
- Exposes fast query APIs using the in-memory index patterns
- Provides web UI for browsing properties and agents

Library provides discovery logic - you add persistence layer.

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

## CLI Tool

For development and testing, use the included CLI tool to interact with AdCP agents.

### Quick Start with Aliases

Save agents for quick access:

```bash
# Save an agent with an alias
npx @adcp/client --save-auth test https://test-agent.adcontextprotocol.org

# Use the alias
npx @adcp/client test get_products '{"brief":"Coffee brands"}'

# List saved agents
npx @adcp/client --list-agents
```

### Direct URL Usage

Auto-detect protocol and call directly:

```bash
# Protocol auto-detection (default)
npx @adcp/client https://test-agent.adcontextprotocol.org get_products '{"brief":"Coffee"}'

# Force specific protocol with --protocol flag
npx @adcp/client https://agent.example.com get_products '{"brief":"Coffee"}' --protocol mcp
npx @adcp/client https://agent.example.com list_authorized_properties --protocol a2a

# List available tools
npx @adcp/client https://agent.example.com

# Use a file for payload
npx @adcp/client https://agent.example.com create_media_buy @payload.json

# JSON output for scripting
npx @adcp/client https://agent.example.com get_products '{"brief":"..."}' --json | jq '.products'
```

### Authentication

Three ways to provide auth tokens (priority order):

```bash
# 1. Explicit flag (highest priority)
npx @adcp/client test get_products '{"brief":"..."}' --auth your-token

# 2. Saved in agent config (recommended)
npx @adcp/client --save-auth prod https://prod-agent.com
# Will prompt for auth token securely

# 3. Environment variable (fallback)
export ADCP_AUTH_TOKEN=your-token
npx @adcp/client test get_products '{"brief":"..."}'
```

### Agent Management

```bash
# Save agent with auth
npx @adcp/client --save-auth prod https://prod-agent.com mcp

# List all saved agents
npx @adcp/client --list-agents

# Remove an agent
npx @adcp/client --remove-agent test

# Show config file location
npx @adcp/client --show-config
```

**Protocol Auto-Detection**: The CLI automatically detects whether an endpoint uses MCP or A2A by checking URL patterns and discovery endpoints. Override with `--protocol mcp` or `--protocol a2a` if needed.

**Config File**: Agent configurations are saved to `~/.adcp/config.json` with secure file permissions (0600).

See [docs/CLI.md](docs/CLI.md) for complete CLI documentation including webhook support for async operations.

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

Apache 2.0 License - see [LICENSE](LICENSE) file for details.

## Support

- **Documentation**: [docs.adcontextprotocol.org](https://docs.adcontextprotocol.org)
- **Issues**: [GitHub Issues](https://github.com/adcontextprotocol/adcp-client/issues)
- **Protocol Spec**: [AdCP Specification](https://github.com/adcontextprotocol/adcp)
