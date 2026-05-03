# AdCP Client Examples

This directory contains practical examples of how to use the `@adcp/sdk` library.

## Examples

### Basic Usage

- **`basic-mcp.ts`** - Simple MCP protocol client usage
- **`basic-a2a.ts`** - Simple A2A protocol client usage with multi-agent testing
- **`env-config.ts`** - Loading agent configuration from environment variables
- **`conversation-client.ts`** - Conversation-aware client with input handlers

### Hello adapters

Worked starting points for adopters wrapping a real upstream platform with the `createAdcpServerFromPlatform` surface. Fork one and replace the in-memory backend with your real catalog / ledger / generation pipeline. All use the same `BuyerAgentRegistry` pattern with Addie (the storyboard runner) seeded as a sandbox-only buyer.

| Shape                                                   | File                                         | Default port |
| ------------------------------------------------------- | -------------------------------------------- | ------------ |
| Single specialism, single tenant — `signal-marketplace` | `hello_seller_adapter_signal_marketplace.ts` | 3001         |
| Multi-specialism, multi-tenant (account-routed)         | `hello_seller_adapter_multi_tenant.ts`       | 3003         |

`hello_seller_adapter_multi_tenant.ts` demonstrates the **account-routed** multi-tenant model: one server hosts `governance-spend-authority`, `property-lists`, and `brand-rights` for two distinct tenants whose data never crosses. Two resolution paths:

- Tools that carry `account` (governance, property-lists) → `accounts.resolve(ref)` reads `ref.operator` and routes to the matching tenant. Same buyer credential can hit different tenants by varying `account.operator`.
- Tools without `account` (`get_brand_identity`, `get_rights`) → `accounts.resolve(undefined, ctx)` reads the resolved buyer agent's home tenant from `ctx.agent`. Different credentials → different views of the catalog without any account field on the wire.

This is distinct from `decisioning-platform-multi-tenant.ts` which uses **host-routed** tenancy via `TenantRegistry` (different agentUrls per tenant). Both are valid; pick by deployment shape.

Boot any of them with:

```bash
NODE_ENV=development npx tsx examples/hello_seller_adapter_<name>.ts
```

`NODE_ENV=development` is required because the adapters use the in-memory task registry; production deployments wire `taskRegistry: createPostgresTaskRegistry({ pool })` (or pass `createInMemoryTaskRegistry()` explicitly to opt in).

### Agent testing (`comply_test_controller`)

Start with `createComplyController` (`comply-controller-seller.ts`). Switch to `registerTestController` (`seller-test-controller.ts`) only when your domain state has internal structure that multiple production tools read from — i.e., when the adapter surface's one-method-per-scenario shape starts fighting the code you already have.

- **`comply-controller-seller.ts`** — `createComplyController` adapter surface. Each scenario maps cleanly to one repository method (`seed_creative` → `creativeRepo.upsert`). The default choice.
- **`seller-test-controller.ts`** — `registerTestController` with a hand-rolled `TestControllerStore`. Pick this when your media buy / creative records carry internal structure (packages, revision, history) that seed must populate AND production tools (`get_media_buy`, `sync_creatives`) must read. Flat store surface, session-scoped factory.

Both wire `comply_test_controller`, both auto-emit the `capabilities.compliance_testing.scenarios` block, both sit on the same primitives. Pick by state shape, not by perceived helper tier.

Run `npm run typecheck:examples` to validate both examples against the built `dist/`.

### Running Examples

```bash
# Install dependencies
npm install

# Set up environment variables
export A2A_AUTH_TOKEN=your-token
export MCP_AUTH_TOKEN=your-token

# Run TypeScript examples directly
npx tsx examples/basic-mcp.ts
npx tsx examples/basic-a2a.ts
npx tsx examples/env-config.ts
npx tsx examples/conversation-client.ts
```

## Environment Configuration

The library supports loading agent configurations from environment variables. Set `ADCP_AGENTS_CONFIG` (or `SALES_AGENTS_CONFIG`):

```bash
ADCP_AGENTS_CONFIG='[{"id":"test-agent","name":"Test Agent","agent_uri":"https://test-agent.example.com","protocol":"mcp","auth_token":"your-token"}]'
```

## Library Usage Patterns

### 1. Multi-Agent Client

```typescript
import { ADCPMultiAgentClient, type AgentConfig } from '@adcp/sdk';

const agents: AgentConfig[] = [
  /* your agents */
];
const client = new ADCPMultiAgentClient(agents);

// Single agent operation
const agent = client.agent('agent-id');
const result = await agent.getProducts({ brief: '...' });

// Multi-agent parallel operation
const results = await client.agents(['id1', 'id2']).getProducts({ brief: '...' });
```

### 2. Environment-based Configuration

```typescript
import { ADCPMultiAgentClient } from '@adcp/sdk';

// Auto-discover from env vars and config files
const client = ADCPMultiAgentClient.fromConfig();

// Or from environment only
const client = ADCPMultiAgentClient.fromEnv();
```

## Available Tools

AdCP tools available on `AgentClient`:

- `getProducts()` - Discover advertising products
- `listCreativeFormats()` - Get supported creative formats
- `createMediaBuy()` - Create a media buy
- `updateMediaBuy()` - Update a media buy
- `syncCreatives()` - Sync creative assets
- `listCreatives()` - List creative assets
- `getMediaBuyDelivery()` - Get delivery performance
- `getSignals()` - Get audience signals
- `activateSignal()` - Activate audience signals
- `providePerformanceFeedback()` - Send performance feedback
- `getAdcpCapabilities()` - Get agent capabilities (v3)

## Error Handling

```typescript
const result = await agent.getProducts({ brief: 'test' });

if (result.success && result.status === 'completed') {
  console.log('Data:', result.data);
} else {
  console.log('Error:', result.error);
}
```

## Testing Framework

This package also includes a complete testing framework. To run the testing UI:

```bash
npm run dev
# Open http://localhost:8080
```

See the main README for full testing framework documentation.
