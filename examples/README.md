# AdCP Client Examples

This directory contains practical examples of how to use the `@adcp/client` library.

## Examples

### Basic Usage

- **`basic-mcp.ts`** - Simple MCP protocol client usage
- **`basic-a2a.ts`** - Simple A2A protocol client usage with multi-agent testing
- **`env-config.ts`** - Loading agent configuration from environment variables
- **`conversation-client.ts`** - Conversation-aware client with input handlers

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
import { ADCPMultiAgentClient, type AgentConfig } from '@adcp/client';

const agents: AgentConfig[] = [/* your agents */];
const client = new ADCPMultiAgentClient(agents);

// Single agent operation
const agent = client.agent('agent-id');
const result = await agent.getProducts({ brief: '...' });

// Multi-agent parallel operation
const results = await client.agents(['id1', 'id2']).getProducts({ brief: '...' });
```

### 2. Environment-based Configuration

```typescript
import { ADCPMultiAgentClient } from '@adcp/client';

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
