# @adcp/sdk

[![npm version](https://badge.fury.io/js/@adcp%2Fsdk.svg)](https://badge.fury.io/js/@adcp%2Fsdk)
[![npm downloads](https://img.shields.io/npm/dm/@adcp/sdk.svg)](https://www.npmjs.com/package/@adcp/sdk)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://www.apache.org/licenses/LICENSE-2.0)
[![TypeScript](https://img.shields.io/badge/TypeScript-Ready-blue.svg)](https://www.typescriptlang.org/)
[![API Documentation](https://img.shields.io/badge/API-Documentation-blue.svg)](https://adcontextprotocol.github.io/adcp-client/api/)
[![GitHub Workflow Status](https://img.shields.io/github/actions/workflow/status/adcontextprotocol/adcp-client/ci.yml?branch=main)](https://github.com/adcontextprotocol/adcp-client/actions)

Official TypeScript/JavaScript client for the **Ad Context Protocol (AdCP)**. Build distributed advertising operations that work synchronously OR asynchronously with the same code.

## For AI Agents

Start with [`docs/llms.txt`](./docs/llms.txt) — the full protocol spec in one file (tools, types, error codes, examples). Building a server? See [`docs/guides/BUILD-AN-AGENT.md`](./docs/guides/BUILD-AN-AGENT.md). **Calling** an AdCP agent as a buyer? Load [`skills/call-adcp-agent/SKILL.md`](./skills/call-adcp-agent/SKILL.md) — wire contract, async flow, and error-recovery priors that aren't in the type signatures. Setting up request signing? See [`docs/guides/SIGNING-GUIDE.md`](./docs/guides/SIGNING-GUIDE.md). For type signatures, use [`docs/TYPE-SUMMARY.md`](./docs/TYPE-SUMMARY.md). Skip `src/lib/types/*.generated.ts` — they're machine-generated and will burn context.

These docs are also available in `node_modules/@adcp/sdk/docs/` after install.

## The Core Concept

AdCP operations are **distributed and asynchronous by default**. An agent might:

- Complete your request **immediately** (synchronous)
- Need time to process and **send results via webhook** (asynchronous)
- Ask for **clarifications** before proceeding
- Send periodic **status updates** as work progresses

**Your code stays the same.** You write handlers once, and they work for both sync completions and webhook deliveries.

## Installation

```bash
npm install @adcp/sdk
```

### TypeScript requirements

`@adcp/sdk` exports Zod schemas as part of its public API. Zod v4's CTS locale
types require `esModuleInterop: true` in your `tsconfig.json`. If you see
`TS1259` errors pointing into `node_modules/zod/v4/locales/`, this flag is
missing.

Recommended `tsconfig.json` for new projects (Node16/ESM):

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist"
  }
}
```

For CommonJS projects, substitute `"module": "commonjs"` and omit
`"moduleResolution"`. Both module modes require `esModuleInterop: true`.

`skipLibCheck: true` is required in practice: without it, TypeScript surfaces
`TS2694`/`TS18028` errors from unrelated `@types/*` packages installed by
linters, test runners, or other tools in your workspace.

## Quick Start: Distributed Operations

```typescript
import { ADCPMultiAgentClient } from '@adcp/sdk';

// Configure agents and handlers
const client = new ADCPMultiAgentClient(
  [
    {
      id: 'agent_x',
      agent_uri: 'https://agent-x.com',
      protocol: 'a2a',
    },
    {
      id: 'agent_y',
      agent_uri: 'https://agent-y.com/mcp/',
      protocol: 'mcp',
    },
  ],
  {
    // Webhook URL template (macros: {agent_id}, {task_type}, {operation_id})
    webhookUrlTemplate: 'https://myapp.com/webhook/{task_type}/{agent_id}/{operation_id}',

    // Activity callback - fires for ALL events (requests, responses, status changes, webhooks)
    onActivity: activity => {
      console.log(`[${activity.type}] ${activity.task_type} - ${activity.operation_id}`);
      // Log to monitoring, update UI, etc.
    },

    // Status change handlers - called for ALL status changes (completed, failed, input-required, working, etc)
    handlers: {
      onGetProductsStatusChange: (response, metadata) => {
        // Called for sync completion, async webhook, AND status changes
        console.log(`[${metadata.status}] Got products for ${metadata.operation_id}`);

        if (metadata.status === 'completed') {
          db.saveProducts(metadata.operation_id, response.products);
        } else if (metadata.status === 'failed') {
          db.markFailed(metadata.operation_id, metadata.message);
        } else if (metadata.status === 'input-required') {
          // Handle clarification needed
          console.log('Needs input:', metadata.message);
        }
      },
    },
  }
);

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

### Handling Clarifications (input-required)

When an agent needs more information, you can continue the conversation:

```typescript
const result = await agent.getProducts({ brief: 'Coffee brands' });

if (result.status === 'input-required') {
  console.log('❓ Agent needs clarification:', result.metadata.inputRequest?.question);
  // onActivity fired: status_change (input-required)

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
  webhookUrlTemplate: 'https://myapp.com/adcp-webhooks/{agent_id}/{task_type}/{operation_id}',
});
```

### Single Webhook Endpoint

```typescript
// Handles ALL webhooks (task completions and notifications)
app.post('/webhook/:task_type/:agent_id/:operation_id', async (req, res) => {
  const { task_type, agent_id, operation_id } = req.params;

  // Route to agent client - handlers fire automatically
  const agent = client.agent(agent_id);
  await agent.handleWebhook(
    req.body,
    task_type,
    operation_id,
    req.headers['x-adcp-signature'],
    req.headers['x-adcp-timestamp']
  );

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
  onActivity: activity => {
    console.log({
      type: activity.type, // 'protocol_request', 'webhook_received', etc.
      operation_id: activity.operation_id,
      agent_id: activity.agent_id,
      status: activity.status,
    });

    // Stream to UI, save to database, send to monitoring
    eventStream.send(activity);
  },
});
```

Activity types:

- `protocol_request` - Request sent to agent
- `protocol_response` - Response received from agent
- `status_change` - Task status changed
- `webhook_received` - Webhook received from agent

## Notifications (Agent-Initiated)

**Mental Model**: Notifications are operations that get set up when you create a media buy. The agent sends periodic updates (like delivery reports) to the webhook URL you configured during media buy creation.

```typescript
// When creating a media buy, agent registers for delivery notifications
const result = await agent.createMediaBuy({
  campaign_id: 'camp_123',
  budget: { amount: 10000, currency: 'USD' },
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
    },
  },
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
  onCreateMediaBuyStatusChange: (response, metadata) => {
    // response: CreateMediaBuyResponse | CreateMediaBuyAsyncWorking | ...
    // metadata: WebhookMetadata
    if (metadata.status === 'completed') {
      const buyId = (response as CreateMediaBuyResponse).media_buy_id; // Typed!
    }
  };
}
```

### Platform Implementors

Building a server that receives AdCP tool calls? **v6 (recommended for new agents):** declare a typed `DecisioningPlatform` per-specialism and let the framework wire idempotency, signing, capability projection, async tasks, status normalization, and lifecycle state.

```typescript
import { serve } from '@adcp/sdk';
import { createAdcpServerFromPlatform, type DecisioningPlatform } from '@adcp/sdk/server/decisioning';

const platform = {
  capabilities: {
    specialisms: ['sales-non-guaranteed'] as const,
    creative_agents: [],
    channels: ['display'] as const,
    pricingModels: ['cpm'] as const,
    config: {},
  },
  statusMappers: {},
  accounts: {
    resolve: async (ref, ctx) => db.findAccount(ref, ctx),
  },
  sales: {
    getProducts: async (req, ctx) => ({ products: catalog.search(req) }),
    createMediaBuy: async (req, ctx) => ({
      media_buy_id: 'mb_1',
      status: 'pending_creatives',
      confirmed_at: new Date().toISOString(),
      packages: [],
    }),
    updateMediaBuy: async (id, req, ctx) => ({ media_buy_id: id, status: 'active' }),
    syncCreatives: async (creatives, ctx) =>
      creatives.map(c => ({ creative_id: c.creative_id, action: 'created' as const, status: 'approved' })),
    getMediaBuyDelivery: async (req, ctx) => ({
      currency: 'USD',
      reporting_period: { start: '...', end: '...' },
      media_buy_deliveries: [],
    }),
  },
} satisfies DecisioningPlatform;

serve(() => createAdcpServerFromPlatform(platform, { name: 'My Publisher', version: '1.0.0' }));
```

`RequiredPlatformsFor<S>` enforces specialism claims at compile time — claim `'sales-non-guaranteed'` and the typechecker requires `sales: SalesPlatform`. `creative-template` and `creative-generative` claims both map to `CreativeBuilderPlatform`; `creative-ad-server` is its own archetype with `listCreatives` + `getCreativeDelivery`.

**v5 lower-level API** (still fully supported as the substrate the v6 path calls into):

```typescript
import { CreateMediaBuyRequest, CreateMediaBuyResponse, CreateMediaBuyRequestSchema } from '@adcp/sdk';

function handleCreateMediaBuy(rawParams: unknown): CreateMediaBuyResponse {
  const request: CreateMediaBuyRequest = CreateMediaBuyRequestSchema.parse(rawParams);
  // request.buyer_ref, request.account, request.brand — all typed
}
```

Migration path from 5.x → 6.x: see [`docs/migration-5.x-to-6.x.md`](docs/migration-5.x-to-6.x.md). Note: `PackageRequest` (creation-shaped, required fields) differs from `Package` (response-shaped). See the [type catalog](docs/ZOD-SCHEMAS.md#type-catalog) for all request types and their required fields.

## Multi-Agent Operations

Execute across multiple agents simultaneously:

```typescript
const client = new ADCPMultiAgentClient([agentX, agentY, agentZ]);

// Parallel execution across all agents
const results = await client.allAgents().getProducts({ brief: 'Coffee brands' });
// results: TaskResult<GetProductsResponse>[]

const agentIds = client.getAgentIds();
results.forEach((result, i) => {
  console.log(`${agentIds[i]}: ${result.status}`);

  if (result.status === 'completed') {
    console.log(`  Sync: ${result.data?.products?.length} products`);
  } else if (result.status === 'submitted') {
    console.log(`  Async: webhook to ${result.submitted?.webhookUrl}`);
  }
});
```

## Idempotency

Every mutating tool call (`createMediaBuy`, `syncCreatives`, `activateSignal`, etc.) auto-generates an `idempotency_key` (UUID v4) when the caller omits one. Internal retries reuse the key so a re-sent request returns the cached response rather than double-booking. See `docs/llms.txt` for the full protocol story.

```typescript
const result = await client.createMediaBuy({ account, brand, start_time, end_time, packages });

// Key used on the wire (auto-generated or caller-supplied). Log alongside your own IDs.
result.metadata.idempotency_key;

// true when the response was a cached replay. Side-effecting callers MUST gate
// notifications, memory writes, downstream calls on this flag.
result.metadata.replayed;
```

**Typed errors on replay conflicts** — check `result.errorInstance` with `instanceof` instead of switching on error codes:

```typescript
import { IdempotencyConflictError, IdempotencyExpiredError } from '@adcp/sdk';

if (result.errorInstance instanceof IdempotencyConflictError) {
  // Agent re-planned with a different payload. Mint a fresh key and retry.
}
if (result.errorInstance instanceof IdempotencyExpiredError) {
  // Key past the seller's replay window. Look up by natural key before retrying.
}
```

**BYOK** (persist keys across process restarts so crash-recovery can resend the exact key):

```typescript
import { useIdempotencyKey } from '@adcp/sdk';

// Validates against the spec pattern `^[A-Za-z0-9_.:-]{16,255}$` before the round-trip.
const key = await db.getOrCreateIdempotencyKey(campaign.id);
await client.createMediaBuy({ ...params, ...useIdempotencyKey(key) });

// Check the seller's replay window so you know when to fall back to natural-key lookup.
// Throws on v3 sellers that omit the declaration — the SDK does NOT default to 24h.
const ttlSeconds = await client.getIdempotencyReplayTtlSeconds();
```

Idempotency keys are retry-pattern oracles within their TTL, so the SDK truncates them to the first 8 characters in debug logs by default. Set `ADCP_LOG_IDEMPOTENCY_KEYS=1` to opt into full logging for local debugging.

**Crash recovery**: if your process dies mid-retry and you need to decide whether to re-send — look up the persisted key by natural key, check `result.metadata.replayed`, and handle `IdempotencyConflictError` / `IdempotencyExpiredError`. Worked recipe in [`docs/guides/idempotency-crash-recovery.md`](./docs/guides/idempotency-crash-recovery.md).

## Security

### Webhook Signature Verification

```typescript
const client = new ADCPMultiAgentClient(agents, {
  webhookSecret: process.env.WEBHOOK_SECRET,
});

// Signatures verified automatically on handleWebhook()
// Returns 401 if signature invalid
```

### Request Signing (RFC 9421)

AdCP 3.0 supports [HTTP Message Signatures (RFC 9421)](https://www.rfc-editor.org/rfc/rfc9421) for cryptographic request authentication. A buyer signs outbound requests so the seller can verify who sent them and that nothing was tampered with. A seller signs outbound webhooks so the buyer can verify authenticity. Optional in 3.0, mandatory in 3.1+ for mutating operations.

**Generate a signing key:**

```bash
adcp signing generate-key --alg ed25519 --kid my-agent-2026 \
  --private-out ./private.jwk --public-out ./public-jwks.json
# Publish public-jwks.json at your /.well-known/jwks.json endpoint.
# Point to it from your /.well-known/brand.json agents[].jwks_uri.
```

**Sign outbound requests (buyer):**

```typescript
import { createSigningFetch } from '@adcp/sdk/signing';

const signingFetch = createSigningFetch(fetch, {
  keyid: 'my-agent-2026',
  alg: 'ed25519',
  privateKey: privateJwk, // JWK with `d` field
});

await signingFetch('https://seller.example.com/mcp', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
});
// Signature, Signature-Input, and Content-Digest headers added automatically.
```

**Verify inbound signatures (seller):**

```typescript
import { createExpressVerifier, StaticJwksResolver, InMemoryReplayStore } from '@adcp/sdk/signing';

app.post(
  '/mcp',
  rawBodyMiddleware(),
  createExpressVerifier({
    capability: {
      supported: true,
      covers_content_digest: 'required',
      required_for: ['create_media_buy'],
    },
    jwks: new StaticJwksResolver(buyerPublicKeys),
    replayStore: new InMemoryReplayStore(),
    resolveOperation: req => req.body?.method ?? 'unknown',
  }),
  handler
);
// On verify: req.verifiedSigner = { keyid, agent_url?, verified_at }.
// On reject: 401 with WWW-Authenticate: Signature error="<code>".
```

Full guide covering key generation, JWKS publication, brand.json setup, webhook signing, capability declaration, key rotation, and conformance testing: **[docs/guides/SIGNING-GUIDE.md](./docs/guides/SIGNING-GUIDE.md)**.

### Authentication

```typescript
const agents = [
  {
    id: 'agent_x',
    name: 'Agent X',
    agent_uri: 'https://agent-x.com',
    protocol: 'a2a',
    auth_token: process.env.AGENT_X_TOKEN, // ✅ Secure - load from env
  },
];
```

## Environment Configuration

```bash
# .env
WEBHOOK_URL_TEMPLATE="https://myapp.com/webhook/{task_type}/{agent_id}/{operation_id}"
WEBHOOK_SECRET="your-webhook-secret"

ADCP_AGENTS_CONFIG='[
  {
    "id": "agent_x",
    "name": "Agent X",
    "agent_uri": "https://agent-x.com",
    "protocol": "a2a",
    "auth_token": "actual-token-here"
  }
]'
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

- `getSignals()` - Get audience signals
- `activateSignal()` - Activate audience signals
- `providePerformanceFeedback()` - Send performance feedback

**Protocol:**

- `getAdcpCapabilities()` - Get agent capabilities (v3)

## Property Discovery (AdCP v2.2.0)

Build agent registries by discovering properties agents can sell. Works with AdCP v2.2.0's publisher-domain model.

### How It Works

1. **Agents return publisher domains**: Call `listAuthorizedProperties()` → get `publisher_domains[]`
2. **Fetch property definitions**: Get `https://{domain}/.well-known/adagents.json` from each domain
3. **Index properties**: Build fast lookups for "who can sell X?" and "what can agent Y sell?"

### Three Key Queries

```typescript
import { PropertyCrawler, getPropertyIndex } from '@adcp/sdk';

// First, crawl agents to discover properties
const crawler = new PropertyCrawler();
await crawler.crawlAgents([
  { agent_url: 'https://agent-x.com', protocol: 'a2a' },
  { agent_url: 'https://agent-y.com/mcp/', protocol: 'mcp' },
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
import { PropertyCrawler, getPropertyIndex } from '@adcp/sdk';

const crawler = new PropertyCrawler();

// Crawl agents - gets publisher_domains from each, then fetches adagents.json
const result = await crawler.crawlAgents([
  { agent_url: 'https://sales.cnn.com' },
  { agent_url: 'https://sales.espn.com' },
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
npx @adcp/sdk@latest --save-auth test https://test-agent.adcontextprotocol.org

# Use the alias
npx @adcp/sdk@latest test get_products '{"brief":"Coffee brands"}'

# List saved agents
npx @adcp/sdk@latest --list-agents
```

### Direct URL Usage

Auto-detect protocol and call directly:

```bash
# Protocol auto-detection (default)
npx @adcp/sdk@latest https://test-agent.adcontextprotocol.org get_products '{"brief":"Coffee"}'

# Force specific protocol with --protocol flag
npx @adcp/sdk@latest https://agent.example.com get_products '{"brief":"Coffee"}' --protocol mcp
npx @adcp/sdk@latest https://agent.example.com list_authorized_properties --protocol a2a

# List available tools
npx @adcp/sdk@latest https://agent.example.com

# Use a file for payload
npx @adcp/sdk@latest https://agent.example.com create_media_buy @payload.json

# JSON output for scripting
npx @adcp/sdk@latest https://agent.example.com get_products '{"brief":"..."}' --json | jq '.products'
```

### Authentication

Three ways to provide auth tokens (priority order):

```bash
# 1. Explicit flag (highest priority)
npx @adcp/sdk@latest test get_products '{"brief":"..."}' --auth your-token

# 2. Saved in agent config (recommended)
npx @adcp/sdk@latest --save-auth prod https://prod-agent.com
# Will prompt for auth token securely

# 3. Environment variable (fallback)
export ADCP_AUTH_TOKEN=your-token
npx @adcp/sdk@latest test get_products '{"brief":"..."}'
```

### Agent Management

```bash
# Save agent with auth
npx @adcp/sdk@latest --save-auth prod https://prod-agent.com mcp

# List all saved agents
npx @adcp/sdk@latest --list-agents

# Remove an agent
npx @adcp/sdk@latest --remove-agent test

# Show config file location
npx @adcp/sdk@latest --show-config
```

### Testing & Compliance

```bash
# Run test scenarios against an agent
npx @adcp/sdk@latest test test-mcp full_sales_flow
npx @adcp/sdk@latest test test-mcp --list-scenarios

# Run compliance assessment
npx @adcp/sdk@latest comply test-mcp
npx @adcp/sdk@latest comply test-mcp --platform-type social_platform
npx @adcp/sdk@latest comply --list-platform-types
```

**Protocol Auto-Detection**: The CLI automatically detects whether an endpoint uses MCP or A2A by checking URL patterns and discovery endpoints. Override with `--protocol mcp` or `--protocol a2a` if needed.

**Config File**: Agent configurations are saved to `~/.adcp/config.json` with secure file permissions (0600).

See [docs/CLI.md](docs/CLI.md) for complete CLI documentation including webhook support for async operations.

### Claude Code Plugin

Install the AdCP CLI as a Claude Code plugin to use `/adcp-client:adcp` directly in your AI coding assistant:

```bash
# Add the marketplace (one time)
/plugin marketplace add adcontextprotocol/adcp-client

# Install the plugin
/plugin install adcp-client@adcp
```

Or test locally during development:

```bash
claude --plugin-dir ./path/to/adcp-client
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
  { buyer_ref: 'campaign-123', account_id: 'acct-456', packages: [...] },
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
    webhookUrl: agent.getWebhookUrl('sync_creatives', operationId),
  }
);

// Result will be 'submitted', webhook arrives later
// Handler fires when webhook received
```

## Building an Agent (Server)

The fastest way to build an AdCP agent is to point your coding tool (Claude Code, Codex, Cursor, etc.) at the right skill file:

```
# Seller agent (publisher, SSP, retail media)
"Read skills/build-seller-agent/SKILL.md and build me a [your platform description]"

# Signals agent (CDP, data provider)
"Read skills/build-signals-agent/SKILL.md and build me a [your data platform description]"
```

The skill guides domain decisions, scaffolds code, and tells you how to validate:

```bash
npx tsx agent.ts
npx @adcp/sdk@latest storyboard run http://localhost:3001/mcp media_buy_seller --json
```

Available skills:

| Skill                                                                                    | For                             | Storyboard                           |
| ---------------------------------------------------------------------------------------- | ------------------------------- | ------------------------------------ |
| [`skills/build-seller-agent/`](skills/build-seller-agent/SKILL.md)                       | Publishers, SSPs, retail media  | `media_buy_seller`                   |
| [`skills/build-generative-seller-agent/`](skills/build-generative-seller-agent/SKILL.md) | AI ad networks, generative DSPs | `media_buy_generative_seller`        |
| [`skills/build-signals-agent/`](skills/build-signals-agent/SKILL.md)                     | CDPs, data providers            | `signal_owned`, `signal_marketplace` |
| [`skills/build-retail-media-agent/`](skills/build-retail-media-agent/SKILL.md)           | Retail media networks           | `media_buy_catalog_creative`         |
| [`skills/build-creative-agent/`](skills/build-creative-agent/SKILL.md)                   | Ad servers, creative platforms  | `creative_lifecycle`                 |

For manual implementation, see the [Build an Agent guide](docs/guides/BUILD-AN-AGENT.md) and [`examples/signals-agent.ts`](examples/signals-agent.ts).

## Contributing

Contributions welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

Apache 2.0 License - see [LICENSE](LICENSE) file for details.

## Support

- **Documentation**: [docs.adcontextprotocol.org](https://docs.adcontextprotocol.org)
- **Issues**: [GitHub Issues](https://github.com/adcontextprotocol/adcp-client/issues)
- **Protocol Spec**: [AdCP Specification](https://github.com/adcontextprotocol/adcp)
