# @adcp/client API Reference

Complete API documentation for the AdCP client library.

## Table of Contents

- [Overview](#overview)
- [Installation](#installation)
- [Core Classes](#core-classes)
  - [AdCPClient](#adcpclient)
  - [ConfigurationManager](#configurationmanager)
- [Protocol Factories](#protocol-factories)
  - [createMCPClient](#createmcpclient)
  - [createA2AClient](#createa2aclient)
- [Types](#types)
- [Utilities](#utilities)
- [Error Handling](#error-handling)
- [Examples](#examples)

## Overview

The `@adcp/client` library provides a unified interface for communicating with advertising agents that implement the AdCP (Ad Context Protocol) over either MCP or A2A transport protocols.

## Installation

```bash
npm install @adcp/client @a2a-js/sdk @modelcontextprotocol/sdk
```

## Core Classes

### AdCPClient

The main client class for interacting with multiple AdCP agents.

#### Constructor

```typescript
new AdCPClient(agents?: AgentConfig[])
```

**Parameters:**
- `agents` (optional): Array of agent configurations

**Example:**
```typescript
import { AdCPClient } from '@adcp/client';

const client = new AdCPClient([
  {
    id: 'my-agent',
    name: 'My Agent',
    agent_uri: 'https://agent.example.com/mcp/',
    protocol: 'mcp',
    requiresAuth: true,
    auth_token_env: 'AGENT_TOKEN'
  }
]);
```

#### Methods

##### `addAgent(agent: AgentConfig): void`

Add an agent configuration to the client.

**Parameters:**
- `agent`: Agent configuration object

**Example:**
```typescript
client.addAgent({
  id: 'new-agent',
  name: 'New Agent',
  agent_uri: 'https://new-agent.example.com',
  protocol: 'a2a',
  requiresAuth: false
});
```

##### `getAgents(): AgentConfig[]`

Get list of all configured agents.

**Returns:** Array of agent configurations (defensive copy)

**Example:**
```typescript
const agents = client.getAgents();
console.log(`Configured ${agents.length} agents`);
```

##### `callTool(agentId: string, toolName: string, args: Record<string, any>): Promise<TestResult>`

Call a tool on a specific agent.

**Parameters:**
- `agentId`: ID of the agent to call
- `toolName`: Name of the tool to invoke
- `args`: Tool-specific arguments

**Returns:** Promise resolving to TestResult with success/failure information

**Example:**
```typescript
const result = await client.callTool('my-agent', 'get_products', {
  brief: 'Looking for premium coffee advertising opportunities',
  promoted_offering: 'Artisan coffee blends'
});

if (result.success) {
  console.log('Products:', result.data);
  console.log('Response time:', result.response_time_ms, 'ms');
} else {
  console.error('Error:', result.error);
}
```

##### `callToolOnAgents(agentIds: string[], toolName: string, args: Record<string, any>): Promise<TestResult[]>`

Call a tool on multiple agents in parallel.

**Parameters:**
- `agentIds`: Array of agent IDs to call
- `toolName`: Name of the tool to invoke on all agents
- `args`: Tool-specific arguments (same for all agents)

**Returns:** Promise resolving to array of TestResult objects

**Example:**
```typescript
const results = await client.callToolOnAgents(
  ['agent1', 'agent2', 'agent3'],
  'get_products',
  {
    brief: 'Tech gadgets for remote work',
    promoted_offering: 'Ergonomic workspace solutions'
  }
);

// Process results
results.forEach(result => {
  console.log(`${result.agent_name}: ${result.success ? '✅' : '❌'} (${result.response_time_ms}ms)`);
});

// Get summary statistics
const successful = results.filter(r => r.success).length;
const avgTime = results.reduce((sum, r) => sum + r.response_time_ms, 0) / results.length;
console.log(`${successful}/${results.length} successful, avg ${Math.round(avgTime)}ms`);
```

##### `getStandardFormats(): CreativeFormat[]`

Get standard creative formats supported by AdCP.

**Returns:** Array of standard creative format definitions

**Example:**
```typescript
const formats = client.getStandardFormats();
console.log('Available formats:');
formats.forEach(format => {
  console.log(`${format.name} (${format.dimensions.width}x${format.dimensions.height})`);
  console.log(`  Max file size: ${format.max_file_size} bytes`);
  console.log(`  Supported types: ${format.file_types.join(', ')}`);
});
```

### ConfigurationManager

Utility class for loading agent configurations from various sources.

#### Static Methods

##### `loadAgentsFromEnv(): AgentConfig[]`

Load agents from environment configuration.

**Returns:** Array of agent configurations from SALES_AGENTS_CONFIG environment variable

**Environment Setup:**
```bash
export SALES_AGENTS_CONFIG='{"agents":[{"id":"test-agent","name":"Test Agent","agent_uri":"https://agent.example.com","protocol":"mcp","auth_token_env":"AGENT_TOKEN","requiresAuth":true}]}'
export AGENT_TOKEN=your-actual-auth-token
```

**Example:**
```typescript
import { ConfigurationManager, AdCPClient } from '@adcp/client';

const agents = ConfigurationManager.loadAgentsFromEnv();
if (agents.length > 0) {
  const client = new AdCPClient(agents);
  console.log(`Loaded ${agents.length} agents from environment`);
} else {
  console.log('No agents configured in environment');
}
```

## Protocol Factories

### createMCPClient

Create a client for MCP protocol specifically.

```typescript
createMCPClient(agentUrl: string, authToken?: string): MCPClientWrapper
```

**Parameters:**
- `agentUrl`: URL of the MCP agent
- `authToken` (optional): Authentication token

**Returns:** MCP client wrapper with `callTool` method

**Example:**
```typescript
import { createMCPClient } from '@adcp/client';

const mcpClient = createMCPClient(
  'https://agent.example.com/mcp/',
  'your-auth-token'
);

const result = await mcpClient.callTool('get_products', {
  brief: 'Sustainable fashion brands',
  promoted_offering: 'Eco-friendly clothing'
});
```

### createA2AClient

Create a client for A2A protocol specifically.

```typescript
createA2AClient(agentUrl: string, authToken?: string): A2AClientWrapper
```

**Parameters:**
- `agentUrl`: URL of the A2A agent
- `authToken` (optional): Authentication token

**Returns:** A2A client wrapper with `callTool` method

**Example:**
```typescript
import { createA2AClient } from '@adcp/client';

const a2aClient = createA2AClient(
  'https://agent.example.com',
  'your-auth-token'
);

const result = await a2aClient.callTool(
  'list_creative_formats',
  'Video advertising formats',
  'Premium video content'
);
```

## Types

### AgentConfig

Configuration for an AdCP agent.

```typescript
interface AgentConfig {
  id: string;                    // Unique identifier for the agent
  name: string;                  // Human-readable name
  agent_uri: string;             // Agent endpoint URL
  protocol: 'mcp' | 'a2a';       // Protocol type
  auth_token_env?: string;       // Auth token or env var name
  requiresAuth?: boolean;        // Whether authentication is required (default: true)
}
```

### TestResult

Result of a tool call operation.

```typescript
interface TestResult {
  agent_id: string;              // ID of the agent that was called
  agent_name: string;            // Name of the agent
  success: boolean;              // Whether the call succeeded
  response_time_ms: number;      // Response time in milliseconds
  data?: any;                    // Response data (if successful)
  error?: string;                // Error message (if failed)
  timestamp: string;             // ISO timestamp of the call
  debug_logs?: any[];            // Debug information (if enabled)
}
```

### CreativeFormat

Standard creative format definition.

```typescript
interface CreativeFormat {
  format_id: string;             // Unique format identifier
  name: string;                  // Human-readable name
  dimensions: {                  // Creative dimensions
    width: number;
    height: number;
  };
  aspect_ratio?: string;         // Aspect ratio (e.g., "16:9")
  file_types: string[];          // Supported file types
  max_file_size: number;         // Maximum file size in bytes
  duration_range?: {             // For video formats
    min: number;
    max: number;
  };
}
```

### Additional Types

See the [full type definitions](./src/lib/types/adcp.ts) for complete type information including:

- `AdvertisingProduct` - Product information
- `CreativeAsset` - Creative asset definitions
- `MediaBuy` - Media buy configurations
- `Targeting` - Targeting options
- Request/response types for all tools

## Utilities

### Authentication

```typescript
import { getAuthToken, createAdCPHeaders } from '@adcp/client/auth';

// Get authentication token for an agent
const token = getAuthToken(agentConfig);

// Create AdCP-compliant headers
const headers = createAdCPHeaders(token, false); // false = not MCP
```

### Validation

```typescript
import { validateAgentUrl, validateAdCPResponse } from '@adcp/client/validation';

// Validate agent URL (throws on invalid)
validateAgentUrl('https://agent.example.com');

// Validate response format
const validation = validateAdCPResponse(response, 'products');
if (!validation.valid) {
  console.error('Validation errors:', validation.errors);
}
```

### Circuit Breaker

```typescript
import { getCircuitBreaker } from '@adcp/client/utils';

const circuitBreaker = getCircuitBreaker('agent-id');
const result = await circuitBreaker.call(async () => {
  // Your agent call here
  return await callAgent();
});
```

## Error Handling

### Common Error Patterns

#### Agent Not Found
```typescript
const result = await client.callTool('non-existent-agent', 'get_products', {});
if (!result.success) {
  console.error(result.error); // "Agent with ID 'non-existent-agent' not found"
}
```

#### Network Errors
```typescript
try {
  const result = await client.callTool('agent-id', 'get_products', args);
  // Handle result...
} catch (error) {
  console.error('Network or client error:', error.message);
}
```

#### Protocol Errors
```typescript
const result = await client.callTool('agent-id', 'get_products', args);
if (!result.success) {
  if (result.error?.includes('JSON-RPC error')) {
    console.error('Agent returned protocol error:', result.error);
  } else if (result.error?.includes('timeout')) {
    console.error('Request timed out');
  }
}
```

#### Circuit Breaker Errors
```typescript
const result = await client.callTool('failing-agent', 'get_products', args);
if (!result.success && result.error?.includes('Circuit breaker is open')) {
  console.log('Agent is temporarily unavailable due to repeated failures');
  // Wait before retrying or use a different agent
}
```

### Error Response Structure

All errors follow a consistent structure:

```typescript
interface ErrorResult extends TestResult {
  success: false;
  error: string;                 // Human-readable error message
  response_time_ms: number;      // Time until error occurred
  debug_logs?: any[];            // Debug information (if available)
}
```

## Available Tools

### get_products

Retrieve advertising products matching a brief.

**Parameters:**
```typescript
{
  brief: string;                 // Description of advertising needs
  promoted_offering?: string;    // Specific offering to promote
}
```

**Example:**
```typescript
const result = await client.callTool('agent-id', 'get_products', {
  brief: 'Looking for premium coffee advertising opportunities',
  promoted_offering: 'Artisan coffee blends'
});
```

### list_creative_formats

Get supported creative formats.

**Parameters:**
```typescript
{
  type?: string;                 // Filter by format type
  category?: string;             // Filter by category
  format_ids?: string[];         // Specific format IDs
}
```

**Example:**
```typescript
const result = await client.callTool('agent-id', 'list_creative_formats', {
  type: 'video',
  category: 'premium'
});
```

### create_media_buy

Create media buys from selected products.

**Parameters:**
```typescript
{
  products: string[];            // Product IDs to include
  creative_assets?: string[];    // Creative asset IDs
  targeting?: object;            // Targeting parameters
  budget?: object;               // Budget configuration
}
```

**Example:**
```typescript
const result = await client.callTool('agent-id', 'create_media_buy', {
  products: ['product-123', 'product-456'],
  creative_assets: ['asset-789'],
  targeting: { age_range: '25-54', interests: ['technology'] },
  budget: { total: 10000, currency: 'USD' }
});
```

### manage_creative_assets

Upload, update, or manage creative assets.

**Parameters:**
```typescript
{
  action: 'upload' | 'list' | 'update' | 'assign' | 'unassign' | 'delete';
  assets?: CreativeAsset[];      // For upload
  filters?: object;              // For list
  creative_id?: string;          // For update/assign/unassign/delete
  updates?: object;              // For update
  // ... additional action-specific parameters
}
```

**Example:**
```typescript
const result = await client.callTool('agent-id', 'manage_creative_assets', {
  action: 'upload',
  assets: [
    {
      id: 'creative-1',
      name: 'Banner Ad',
      type: 'image',
      format: 'banner_300x250',
      media_url: 'https://example.com/banner.jpg',
      dimensions: { width: 300, height: 250 },
      status: 'active'
    }
  ]
});
```

### sync_creatives

Bulk synchronization of creative assets.

**Parameters:**
```typescript
{
  creatives: CreativeAsset[];    // Assets to sync
  patch?: boolean;               // Enable partial updates
  dry_run?: boolean;             // Preview changes without applying
  assignments?: object;          // Bulk assign to packages
  validation_mode?: 'strict' | 'lenient';
}
```

### list_creatives

Query and filter creative assets.

**Parameters:**
```typescript
{
  filters?: {
    format?: string | string[];
    type?: string | string[];
    status?: string | string[];
    tags?: string | string[];
    created_after?: string;
    created_before?: string;
    // ... additional filters
  };
  sort?: {
    field: string;
    direction: 'asc' | 'desc';
  };
  pagination?: {
    offset?: number;
    limit?: number;
    cursor?: string;
  };
}
```

## Examples

### Basic Usage

```typescript
import { AdCPClient } from '@adcp/client';

const client = new AdCPClient([
  {
    id: 'test-agent',
    name: 'Test Agent',
    agent_uri: 'https://agent.example.com/mcp/',
    protocol: 'mcp',
    requiresAuth: false
  }
]);

const result = await client.callTool('test-agent', 'get_products', {
  brief: 'Summer campaign for outdoor gear'
});

console.log(result.success ? result.data : result.error);
```

### Environment Configuration

```typescript
import { ConfigurationManager, createAdCPClient } from '@adcp/client';

// Load from environment
const agents = ConfigurationManager.loadAgentsFromEnv();
const client = createAdCPClient(agents);

// Test all configured agents
const agentIds = agents.map(a => a.id);
const results = await client.callToolOnAgents(agentIds, 'get_products', {
  brief: 'Q4 holiday campaign planning'
});

console.log(`Tested ${results.length} agents`);
```

### Error Handling with Retry

```typescript
async function callWithRetry(client, agentId, toolName, args, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await client.callTool(agentId, toolName, args);
      if (result.success) {
        return result;
      }
      
      // Don't retry for certain error types
      if (result.error?.includes('not found') || result.error?.includes('unauthorized')) {
        throw new Error(result.error);
      }
      
      if (attempt < maxRetries) {
        console.log(`Attempt ${attempt} failed, retrying...`);
        await new Promise(resolve => setTimeout(resolve, 1000 * attempt)); // Exponential backoff
      }
    } catch (error) {
      if (attempt === maxRetries) throw error;
      console.log(`Network error on attempt ${attempt}, retrying...`);
    }
  }
  
  throw new Error(`Failed after ${maxRetries} attempts`);
}
```

### Performance Monitoring

```typescript
function monitorPerformance(results) {
  const successful = results.filter(r => r.success);
  const failed = results.filter(r => !r.success);
  
  const avgResponseTime = successful.length > 0 
    ? successful.reduce((sum, r) => sum + r.response_time_ms, 0) / successful.length
    : 0;
  
  console.log(`Performance Summary:`);
  console.log(`  Success Rate: ${successful.length}/${results.length} (${Math.round(successful.length/results.length*100)}%)`);
  console.log(`  Average Response Time: ${Math.round(avgResponseTime)}ms`);
  console.log(`  Fastest: ${Math.min(...successful.map(r => r.response_time_ms))}ms`);
  console.log(`  Slowest: ${Math.max(...successful.map(r => r.response_time_ms))}ms`);
  
  if (failed.length > 0) {
    console.log(`  Common Errors:`);
    const errorCounts = {};
    failed.forEach(r => {
      const errorType = r.error?.split(':')[0] || 'Unknown';
      errorCounts[errorType] = (errorCounts[errorType] || 0) + 1;
    });
    Object.entries(errorCounts).forEach(([error, count]) => {
      console.log(`    ${error}: ${count}`);
    });
  }
}
```

---

For more examples, see the [`examples/`](./examples/) directory in the repository.