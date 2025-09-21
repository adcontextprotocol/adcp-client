# AdCP Client Examples

This directory contains practical examples of how to use the `@adcp/client` library.

## Examples

### Basic Usage

- **`basic-mcp.ts`** - Simple MCP protocol client usage
- **`basic-a2a.ts`** - Simple A2A protocol client usage with multi-agent testing
- **`env-config.ts`** - Loading agent configuration from environment variables

### Running Examples

```bash
# Install dependencies
npm install

# Set up environment variables (copy from .env.example)
cp .env.example .env
# Edit .env with your agent configurations

# Run TypeScript examples directly
npx tsx examples/basic-mcp.ts
npx tsx examples/basic-a2a.ts
npx tsx examples/env-config.ts

# Or compile and run
npm run build
node dist/examples/basic-mcp.js
```

## Environment Configuration

The library supports loading agent configurations from environment variables. Set `SALES_AGENTS_CONFIG` in your `.env` file:

```bash
SALES_AGENTS_CONFIG='{"agents":[{"id":"test-agent","name":"Test Agent","agent_uri":"https://test-agent.example.com","protocol":"mcp","auth_token_env":"TEST_AUTH_TOKEN","requiresAuth":true}]}'
TEST_AUTH_TOKEN=your-actual-auth-token
```

## Library Usage Patterns

### 1. Simple Client Creation

```typescript
import { createMCPClient, createA2AClient } from '@adcp/client';

const mcpClient = createMCPClient('https://agent.example.com/mcp/', 'token');
const a2aClient = createA2AClient('https://agent.example.com', 'token');
```

### 2. Full AdCP Client

```typescript
import { AdCPClient, type AgentConfig } from '@adcp/client';

const agents: AgentConfig[] = [/* your agents */];
const client = new AdCPClient(agents);

// Single agent call
const result = await client.callTool('agent-id', 'get_products', { brief: '...' });

// Multi-agent call
const results = await client.callToolOnAgents(['id1', 'id2'], 'get_products', { brief: '...' });
```

### 3. Environment-based Configuration

```typescript
import { ConfigurationManager, AdCPClient } from '@adcp/client';

const agents = ConfigurationManager.loadAgentsFromEnv();
const client = new AdCPClient(agents);
```

## Available Tools

Common AdCP tools you can call:

- `get_products` - Retrieve advertising products
- `list_creative_formats` - Get supported creative formats
- `manage_creative_assets` - Manage creative assets
- `sync_creatives` - Sync creative assets
- `list_creatives` - List creative assets

## Error Handling

The library includes comprehensive error handling:

```typescript
try {
  const result = await client.callTool('agent-id', 'get_products', { brief: 'test' });
  if (result.success) {
    console.log('Data:', result.data);
  } else {
    console.log('Error:', result.error);
  }
} catch (error) {
  console.error('Network or client error:', error);
}
```

## Testing Framework

This package also includes a complete testing framework. To run the testing UI:

```bash
npm run dev
# Open http://localhost:3000
```

See the main README for full testing framework documentation.