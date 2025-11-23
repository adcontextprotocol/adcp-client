# @adcp/client API Reference

Complete TypeScript API documentation for the **@adcp/client** library - the official client for the Ad Context Protocol (AdCP).

## Overview

The @adcp/client library provides a comprehensive, type-safe interface for interacting with AdCP agents supporting both **MCP** (Model Context Protocol) and **A2A** (Agent-to-Agent) protocols. Whether you're working with a single agent or orchestrating operations across multiple agents, this library provides the tools you need.

## Quick Start

```typescript
import { ADCPMultiAgentClient } from '@adcp/client';

// Configure agents
const client = new ADCPMultiAgentClient([
  { id: 'agent1', agent_uri: 'https://agent1.com', protocol: 'mcp' },
  { id: 'agent2', agent_uri: 'https://agent2.com', protocol: 'a2a' }
]);

// Execute operation
const result = await client.agent('agent1').getProducts({
  brief: 'Premium coffee brands for millennial audience'
});

if (result.status === 'completed') {
  console.log('Products:', result.data.products);
}
```

## Core Concepts

### 🎯 Client Classes

The library provides flexible client patterns for different use cases:

- **[`ADCPMultiAgentClient`](./classes/ADCPMultiAgentClient.md)** - Main entry point supporting single and multi-agent operations
- **[`AgentClient`](./classes/AgentClient.md)** - Individual agent operations with full AdCP method support
- **[`AgentCollection`](./classes/AgentCollection.md)** - Parallel operations across multiple agents

### 📦 Request/Response Types

All AdCP operations have strongly-typed request and response interfaces:

**Product Discovery:**
- [`GetProductsRequest`](./interfaces/GetProductsRequest.md) / [`GetProductsResponse`](./interfaces/GetProductsResponse.md)
- [`ListCreativeFormatsRequest`](./interfaces/ListCreativeFormatsRequest.md) / [`ListCreativeFormatsResponse`](./interfaces/ListCreativeFormatsResponse.md)

**Media Buy Lifecycle:**
- [`CreateMediaBuyRequest`](./interfaces/CreateMediaBuyRequest.md) / [`CreateMediaBuyResponse`](./interfaces/CreateMediaBuyResponse.md)
- [`UpdateMediaBuyRequest`](./type-aliases/UpdateMediaBuyRequest.md) / [`UpdateMediaBuyResponse`](./interfaces/UpdateMediaBuyResponse.md)
- [`SyncCreativesRequest`](./interfaces/SyncCreativesRequest.md) / [`SyncCreativesResponse`](./interfaces/SyncCreativesResponse.md)

**Targeting & Signals:**
- [`GetSignalsRequest`](./interfaces/GetSignalsRequest.md) / [`GetSignalsResponse`](./interfaces/GetSignalsResponse.md)
- [`ActivateSignalRequest`](./interfaces/ActivateSignalRequest.md) / [`ActivateSignalResponse`](./interfaces/ActivateSignalResponse.md)

[View all request/response types →](./README.md#interfaces)

### 🔄 Task Results

All operations return a [`TaskResult<T>`](./interfaces/TaskResult.md) with status tracking:

```typescript
type TaskStatus = 'completed' | 'submitted' | 'needs_input' | 'failed' | 'aborted';

interface TaskResult<T> {
  status: TaskStatus;
  data?: T;              // Present when status === 'completed'
  error?: Error;         // Present when status === 'failed'
  needs_input?: {...};   // Present when status === 'needs_input'
  submitted?: {...};     // Present when status === 'submitted'
}
```

### 🔐 Configuration

Multiple ways to configure agents:

```typescript
// 1. Direct construction
const client = new ADCPMultiAgentClient([...agents]);

// 2. Auto-discover from environment/config
const client = ADCPMultiAgentClient.fromConfig();

// 3. Environment variables only
const client = ADCPMultiAgentClient.fromEnv();

// 4. Specific config file
const client = ADCPMultiAgentClient.fromFile('./agents.json');

// 5. Simple single-agent setup
const client = ADCPMultiAgentClient.simple('https://agent.example.com');
```

See [`ConfigurationManager`](./classes/ConfigurationManager.md) for configuration file formats and environment variable names.

## Usage Patterns

### Single Agent Operations

```typescript
// Get agent and execute
const agent = client.agent('sales_agent');
const products = await agent.getProducts({ brief: 'Coffee brands' });

// Continue conversation if clarification needed
if (products.status === 'needs_input') {
  const refined = await agent.continueConversation('Premium brands only');
}
```

### Multi-Agent Parallel Execution

```typescript
// Execute across specific agents
const results = await client.agents(['agent1', 'agent2']).getProducts({
  brief: 'Coffee brands'
});

// Or across all agents
const allResults = await client.allAgents().getProducts({
  brief: 'Coffee brands'
});

// Process results
allResults.forEach((result, i) => {
  if (result.status === 'completed') {
    console.log(`Agent ${i}: ${result.data.products.length} products`);
  }
});
```

### Property Discovery (AdCP v2.2.0+)

Build agent registries by discovering what properties agents can sell:

```typescript
import { PropertyCrawler, getPropertyIndex } from '@adcp/client';

// Crawl agents
const crawler = new PropertyCrawler();
await crawler.crawlAgents([
  { agent_url: 'https://agent1.com' },
  { agent_url: 'https://agent2.com' }
]);

// Query index
const index = getPropertyIndex();
const matches = index.findAgentsForProperty('domain', 'cnn.com');
```

See [`PropertyCrawler`](./classes/PropertyCrawler.md) and [`PropertyIndex`](./classes/PropertyIndex.md) for details.

## Error Handling

The library provides specific error types for different failure modes:

- [`ADCPError`](./classes/ADCPError.md) - Base error class
- [`ProtocolError`](./classes/ProtocolError.md) - Protocol-level failures
- [`TaskTimeoutError`](./classes/TaskTimeoutError.md) - Operation timeouts
- [`AgentNotFoundError`](./classes/AgentNotFoundError.md) - Invalid agent ID
- [`ValidationError`](./classes/ADCPValidationError.md) - Schema validation failures

```typescript
import { isADCPError, isErrorOfType, TaskTimeoutError } from '@adcp/client';

try {
  const result = await agent.getProducts(params);
} catch (error) {
  if (isErrorOfType(error, TaskTimeoutError)) {
    console.error('Operation timed out');
  } else if (isADCPError(error)) {
    console.error('AdCP error:', error.message);
  }
}
```

## Type Safety

All types are automatically generated from the AdCP JSON schemas, ensuring perfect alignment with the protocol specification:

```typescript
import type {
  GetProductsRequest,
  GetProductsResponse,
  BrandManifest,
  Product,
  Format
} from '@adcp/client';

// Full IntelliSense support
const request: GetProductsRequest = {
  brand_manifest: { name: 'Acme Corp' },
  brief: 'Coffee products'
};
```

## Validation

Runtime validation using Zod schemas:

```typescript
import {
  GetProductsRequestSchema,
  GetProductsResponseSchema
} from '@adcp/client';

// Validate request
const validRequest = GetProductsRequestSchema.parse(requestData);

// Validate response
const validResponse = GetProductsResponseSchema.parse(responseData);
```

See [`schemas.generated`](./README.md#type-aliases) for all available Zod schemas.

## Advanced Features

### Async Handlers & Webhooks

Handle asynchronous operations with automatic webhook management:

```typescript
const client = new ADCPMultiAgentClient(agents, {
  webhookUrlTemplate: 'https://myapp.com/webhook/{task_type}/{agent_id}/{operation_id}',
  handlers: {
    onGetProductsStatusChange: (response, metadata) => {
      console.log(`Status: ${metadata.status}`);
      if (metadata.status === 'completed') {
        saveProducts(response.products);
      }
    }
  }
});
```

See [`AsyncHandler`](./classes/AsyncHandler.md) for webhook configuration.

### Creative Agent Integration

Work with creative generation agents:

```typescript
import { CreativeAgentClient, STANDARD_CREATIVE_AGENTS } from '@adcp/client';

const creativeClient = new CreativeAgentClient({
  agents: STANDARD_CREATIVE_AGENTS
});

const creative = await creativeClient.generateCreative({
  format: 'banner_300x250',
  brand_manifest: { name: 'Acme' },
  targeting: { demographics: { age_ranges: ['25-34'] } }
});
```

See [`CreativeAgentClient`](./classes/CreativeAgentClient.md) for details.

## Protocol Support

The library seamlessly supports both protocols:

- **MCP (Model Context Protocol)** - SSE-based streaming protocol
- **A2A (Agent-to-Agent)** - REST-based protocol

Protocol is specified per-agent in configuration. All operations work identically regardless of protocol.

## Version Information

Check library and protocol versions:

```typescript
import {
  LIBRARY_VERSION,
  ADCP_VERSION,
  isCompatibleWith
} from '@adcp/client';

console.log(`Library: ${LIBRARY_VERSION}`);
console.log(`AdCP Protocol: ${ADCP_VERSION}`);

if (isCompatibleWith('2.4.0')) {
  console.log('Compatible with AdCP 2.4.0');
}
```

## Additional Resources

- **Main README**: [Getting Started Guide](../README.md)
- **Protocol Spec**: [AdCP Specification](https://github.com/adcontextprotocol/adcp)
- **Full Documentation**: [docs.adcontextprotocol.org](https://docs.adcontextprotocol.org)
- **npm Package**: [@adcp/client](https://www.npmjs.com/package/@adcp/client)
- **GitHub**: [adcontextprotocol/adcp-client](https://github.com/adcontextprotocol/adcp-client)

## Browse the API

Use the navigation below to explore all classes, interfaces, types, and utilities in the library.

---

**📚 Generated from source code with TypeDoc** • [View on GitHub](https://github.com/adcontextprotocol/adcp-client)
