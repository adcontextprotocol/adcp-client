# @adcp/client

[![npm version](https://badge.fury.io/js/@adcp%2Fclient.svg)](https://badge.fury.io/js/@adcp%2Fclient)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-Ready-blue.svg)](https://www.typescriptlang.org/)

Official TypeScript/JavaScript client library for the **Ad Context Protocol (AdCP)**. Connect to advertising agents via A2A or MCP protocols with full type safety and runtime validation.

## Features

- 🎯 **Clean, curated API** - Only ~120 exports (65% reduction from 200+)
- 🔒 **Full TypeScript support** - Complete type safety for all AdCP operations
- ✅ **Runtime validation** - Zod schemas for request/response validation
- 🔌 **Multi-protocol** - Supports both A2A and MCP protocols
- 🌐 **Multi-agent** - Query multiple agents in parallel
- 🪝 **Async operations** - Webhook support for long-running tasks
- 📝 **AdCP 2.4.0 compliant** - Latest protocol specification

## Installation

```bash
npm install @adcp/client
```

## Quick Start

```typescript
import { AdCPClient } from '@adcp/client';

// Create client with agent configuration
const client = new AdCPClient([
  {
    id: 'my-sales-agent',
    name: 'My Sales Agent',
    agent_uri: 'https://sales-agent.example.com',
    protocol: 'a2a',
    auth_token_env: 'SALES_AUTH_TOKEN',  // Reads from process.env
    requiresAuth: true
  }
]);

// Query products
const result = await client
  .agent('my-sales-agent')
  .getProducts({
    brand_manifest: 'https://mybrand.com',
    brief: 'Looking for video inventory for Q4 campaign'
  });

console.log(`Found ${result.data.products.length} products`);
```

## Core Concepts

### Client Creation

Configure your client with one or more agent connections:

```typescript
import { AdCPClient, type AgentConfig } from '@adcp/client';

const agents: AgentConfig[] = [
  {
    id: 'sales-1',
    name: 'Sales Agent',
    agent_uri: 'https://sales.example.com',
    protocol: 'a2a',
    auth_token_env: 'SALES_AUTH_TOKEN'  // Recommended: use env vars
  },
  {
    id: 'creative-1',
    name: 'Creative Agent',
    agent_uri: 'https://creative.example.com/mcp',
    protocol: 'mcp',
    auth_token: 'direct-token-value'  // Or provide token directly
  }
];

const client = new AdCPClient(agents);
```

### Single Agent Operations

Execute operations against a specific agent:

```typescript
// Get products from a specific agent
const result = await client.agent('sales-1').getProducts({
  brand_manifest: {
    name: 'ACME Corp',
    url: 'https://acmecorp.com'
  },
  brief: 'Premium video inventory for Q4'
});

// List available creative formats
const formats = await client.agent('creative-1').listCreativeFormats({
  format_types: ['video', 'display']
});
```

### Multi-Agent Operations

Query multiple agents in parallel:

```typescript
// Query multiple agents at once
const results = await client
  .agents(['sales-1', 'sales-2'])
  .getProducts({
    brand_manifest: 'https://mybrand.com',
    brief: 'Premium video inventory'
  });

// Process results
results.forEach(result => {
  if (result.success) {
    console.log(`✓ ${result.agentName}: ${result.data.products.length} products`);
  } else {
    console.error(`✗ ${result.agentName}: ${result.error}`);
  }
});
```

## Available Tools

The SDK provides full type-safe access to all AdCP tools:

### Media Buy Tools

- `getProducts(request)` - Query available advertising products
- `listCreativeFormats(request)` - List supported creative formats
- `createMediaBuy(request)` - Create a media buy order
- `updateMediaBuy(request)` - Update an existing media buy
- `syncCreatives(request)` - Sync creative assets
- `listCreatives(request)` - List creative assets
- `getMediaBuyDelivery(request)` - Get delivery statistics
- `listAuthorizedProperties(request)` - List authorized properties
- `providePerformanceFeedback(request)` - Send performance data

### Creative Tools

- `buildCreative(request)` - Generate creative assets
- `previewCreative(request)` - Preview creative rendering

### Signals Tools

- `getSignals(request)` - Query available signals
- `activateSignal(request)` - Activate a signal

## Creating Media Buys

Complete example of creating a media buy with creatives:

```typescript
import type {
  CreateMediaBuyRequest,
  PackageRequest
} from '@adcp/client';

const packages: PackageRequest[] = [
  {
    package_id: 'pkg-001',
    product_id: 'prod-video-premium',
    pricing: {
      pricing_model: 'cpm',
      rate: 25.00,
      currency: 'USD'
    },
    targeting: {
      geographic: {
        countries: ['US', 'CA']
      },
      demographic: {
        age_ranges: [{ min: 25, max: 54 }]
      }
    },
    delivery: {
      exposures: 1000000,
      start_time: '2024-01-01T00:00:00Z',
      end_time: '2024-03-31T23:59:59Z'
    },
    creatives: [
      {
        creative_id: 'creative-001',
        format_id: {
          agent_url: 'https://formats.adcontextprotocol.org',
          id: 'video_1920x1080_30s'
        },
        assets: {
          vast: {
            url: 'https://cdn.example.com/vast/creative-001.xml',
            vast_version: '4.2'
          }
        }
      }
    ]
  }
];

const mediaBuy = await client.agent('sales-1').createMediaBuy({
  buyer_ref: 'campaign-q4-2024',
  brand_manifest: 'https://mybrand.com',
  packages,
  start_time: 'asap',
  end_time: '2024-12-31T23:59:59Z'
});

console.log(`Media buy created: ${mediaBuy.data.media_buy_id}`);
```

## Async Operations with Webhooks

For long-running operations, use webhooks to receive status updates:

```typescript
import { AsyncHandler, AdCPClient } from '@adcp/client';

// Set up webhook handler
const asyncHandler = new AsyncHandler({
  webhookBaseUrl: 'https://myapp.com/api/adcp',

  // Handle status changes
  onGetProductsStatusChange: async (status, result, metadata) => {
    if (status === 'completed') {
      console.log(`Products ready: ${result.products.length}`);
      // Process products
    }
  },

  // Handle delivery notifications
  onMediaBuyDeliveryNotification: async (notification, metadata) => {
    console.log(`Delivered: ${notification.delivery.impressions_delivered}`);
  }
});

// Execute with webhook support
const task = await client.agent('sales-1').getProducts(
  {
    brand_manifest: 'https://mybrand.com'
  },
  {
    asyncHandler,
    taskTimeout: 300000  // 5 minute timeout
  }
);
```

## Type-Safe Requests & Responses

All request and response types are fully typed:

```typescript
import type {
  GetProductsRequest,
  GetProductsResponse,
  Product
} from '@adcp/client';

// Request is fully typed
const request: GetProductsRequest = {
  brand_manifest: 'https://mybrand.com',
  brief: 'Video inventory',
  filters: {
    delivery_type: ['guaranteed'],
    min_exposures: 100000
  }
};

// Response is fully typed
const response = await client.agent('sales-1').getProducts(request);
const products: Product[] = response.data.products;

// TypeScript provides autocomplete for all fields
products.forEach(product => {
  console.log(`${product.name}: ${product.pricing_model} @ ${product.base_price}`);
});
```

## Runtime Validation with Zod

Validate data at runtime using the included Zod schemas:

```typescript
import {
  GetProductsRequestSchema,
  GetProductsResponseSchema,
  FormatIDSchema,
  ProductSchema
} from '@adcp/client';

// Validate user input
try {
  const validatedRequest = GetProductsRequestSchema.parse(userInput);
  const response = await client.agent('sales-1').getProducts(validatedRequest);

  // Validate agent response
  const validatedResponse = GetProductsResponseSchema.parse(response.data);
} catch (error) {
  console.error('Validation failed:', error);
}

// Validate individual data structures
const formatId = FormatIDSchema.parse({
  agent_url: 'https://formats.example.com',
  id: 'video_1920x1080_30s'
});
```

## Error Handling

The SDK provides specific error types for different failure scenarios:

```typescript
import {
  ADCPError,
  TaskTimeoutError,
  ADCPValidationError,
  AgentNotFoundError,
  ProtocolError
} from '@adcp/client';

try {
  const result = await client.agent('sales-1').getProducts({
    brand_manifest: 'https://mybrand.com'
  });
} catch (error) {
  if (error instanceof TaskTimeoutError) {
    console.error('Operation timed out after', error.timeout, 'ms');
  } else if (error instanceof ADCPValidationError) {
    console.error('Invalid request:', error.field, error.constraint);
  } else if (error instanceof AgentNotFoundError) {
    console.error('Agent not found:', error.agentId);
    console.log('Available:', error.availableAgents);
  } else if (error instanceof ProtocolError) {
    console.error('Protocol error:', error.protocol, error.message);
  } else if (error instanceof ADCPError) {
    console.error('AdCP error:', error.code, error.message);
  }
}
```

## Best Practices

### 1. Use Environment Variables for Auth

```typescript
const agent: AgentConfig = {
  id: 'agent-1',
  agent_uri: 'https://agent.example.com',
  protocol: 'a2a',
  auth_token_env: 'AGENT_AUTH_TOKEN'  // Reads from process.env
};
```

### 2. Reuse Client Instances

```typescript
// Good: Create once, reuse everywhere
const client = new AdCPClient(agents);

// Bad: Creating new client for each request
// function getProducts() { const client = new AdCPClient(...); }
```

### 3. Handle Multi-Agent Failures Gracefully

```typescript
const results = await client.agents(['agent-1', 'agent-2']).getProducts(request);

const successful = results.filter(r => r.success);
const failed = results.filter(r => !r.success);

if (failed.length > 0) {
  console.warn(`${failed.length} agents failed`);
}
```

### 4. Use TypeScript for Type Safety

```typescript
// TypeScript catches errors at compile time
const result = await client.agent('agent-1').getProducts({
  brand_manifest: 'https://mybrand.com',
  filters: {
    delivery_type: ['invalid']  // TS error: invalid enum value
  }
});
```

## Factory Methods

Create clients from environment variables:

```typescript
import { AdCPClient } from '@adcp/client';

// Load agent configuration from environment
// Expects SALES_AGENTS_CONFIG env var with JSON array
const client = AdCPClient.fromEnv();
```

## Complete Example

Multi-agent product discovery with error handling:

```typescript
import {
  AdCPClient,
  type AgentConfig,
  type GetProductsRequest,
  type Product,
  ADCPError
} from '@adcp/client';

async function discoverProducts() {
  // Configure agents
  const agents: AgentConfig[] = [
    {
      id: 'sales-premium',
      name: 'Premium Sales Agent',
      agent_uri: 'https://premium-sales.example.com',
      protocol: 'a2a',
      auth_token_env: 'PREMIUM_AUTH_TOKEN'
    },
    {
      id: 'sales-standard',
      name: 'Standard Sales Agent',
      agent_uri: 'https://standard-sales.example.com',
      protocol: 'mcp',
      auth_token_env: 'STANDARD_AUTH_TOKEN'
    }
  ];

  const client = new AdCPClient(agents);

  // Query all agents
  const request: GetProductsRequest = {
    brand_manifest: {
      name: 'ACME Corporation',
      url: 'https://acmecorp.com',
      colors: {
        primary: '#FF6B35'
      }
    },
    brief: 'Looking for premium video inventory for Q4 holiday campaign',
    filters: {
      delivery_type: ['guaranteed'],
      format_types: ['video'],
      min_exposures: 500000
    }
  };

  try {
    const results = await client
      .agents(['sales-premium', 'sales-standard'])
      .getProducts(request);

    // Aggregate products
    const allProducts: Product[] = [];
    results.forEach(result => {
      if (result.success) {
        console.log(`✓ ${result.agentName}: ${result.data.products.length} products`);
        allProducts.push(...result.data.products);
      } else {
        console.error(`✗ ${result.agentName}: ${result.error}`);
      }
    });

    // Sort by price
    allProducts.sort((a, b) => a.base_price - b.base_price);

    console.log(`\nTotal: ${allProducts.length} products from ${results.filter(r => r.success).length} agents`);

    return allProducts;
  } catch (error) {
    if (error instanceof ADCPError) {
      console.error('AdCP Error:', error.code, error.message);
    }
    throw error;
  }
}

discoverProducts().catch(console.error);
```

## What's NOT in the Public API

The SDK only exports what you need for building applications. Internal implementation details are not exposed:

### Clean Imports

```typescript
import {
  AdCPClient,              // ✓ Main client
  GetProductsRequest,      // ✓ Tool request types
  GetProductsResponse,     // ✓ Tool response types
  Product,                 // ✓ Data models
  FormatID,                // ✓ Core identifiers
  ADCPError,               // ✓ Error classes
  GetProductsRequestSchema // ✓ Validation schemas
  // Only ~70 relevant exports total
} from '@adcp/client';
```

### You Won't See

- `BrandManifestReference1` (internal discriminated union variant)
- `CreativeStatus1` (internal type collision)
- `UpdateMediaBuyRequest2` (internal implementation detail)
- 80+ other internal Zod schemas
- Internal server types
- Protocol implementation details

The SDK maintains a clean, professional API surface with comprehensive type safety and validation.

## API Documentation

### Main Classes

- **AdCPClient** - Primary client for agent communication
- **AsyncHandler** - Webhook handler for async operations
- **TaskExecutor** - Task execution engine (used internally)

### Request/Response Types

All 13 AdCP tools have corresponding `*Request` and `*Response` types:

- Media Buy: `GetProducts`, `ListCreativeFormats`, `CreateMediaBuy`, `UpdateMediaBuy`, `SyncCreatives`, `ListCreatives`, `GetMediaBuyDelivery`, `ListAuthorizedProperties`, `ProvidePerformanceFeedback`
- Creative: `BuildCreative`, `PreviewCreative`
- Signals: `GetSignals`, `ActivateSignal`

### Core Data Models

- **Product** - Advertising product definition
- **Format** - Creative format specification
- **FormatID** - Format identifier (agent_url + id)
- **PackageRequest** - Media buy package configuration
- **CreativeAsset** - Creative asset with media/snippet
- **CreativePolicy** - Creative approval policy

### Error Classes

- **ADCPError** - Base error class (abstract)
- **TaskTimeoutError** - Operation timeout
- **ADCPValidationError** - Validation failure
- **AgentNotFoundError** - Unknown agent ID
- **ProtocolError** - Protocol communication failure
- **InputRequiredError** - Agent needs clarification
- **UnsupportedTaskError** - Agent doesn't support operation

### Validation Schemas

All request/response types have corresponding Zod schemas for runtime validation:
- `*RequestSchema` - Validate request data
- `*ResponseSchema` - Validate response data
- `FormatIDSchema`, `ProductSchema`, `PackageRequestSchema`, `CreativeAssetSchema` - Core data validation

## Protocol Support

### A2A (Agent-to-Agent)

RESTful protocol for agent communication. Supports both sync and async operations.

### MCP (Model Context Protocol)

JSON-RPC 2.0 protocol optimized for LLM interactions. Supports tool calling and structured responses.

The SDK handles protocol differences transparently - use the same API regardless of protocol.

## AdCP Specification

This library implements [AdCP 2.4.0](https://adcontextprotocol.org).

Key features:
- Modern `assets` dictionary structure for creatives
- Comprehensive targeting options
- Multiple pricing models (CPM, CPC, flat rate, etc.)
- Rich format definitions with constraints
- Delivery tracking and performance feedback

## TypeScript Support

The SDK is written in TypeScript and provides complete type definitions. All types are automatically inferred:

```typescript
// Types are inferred automatically
const result = await client.agent('sales-1').getProducts({
  brand_manifest: 'https://mybrand.com'
});

// result.data.products is typed as Product[]
// IDE provides full autocomplete
```

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development setup and contribution guidelines.

## License

MIT

## Links

- [AdCP Specification](https://adcontextprotocol.org)
- [npm Package](https://www.npmjs.com/package/@adcp/client)
- [GitHub Repository](https://github.com/ad-tech-group/adcp-client)
- [Issue Tracker](https://github.com/ad-tech-group/adcp-client/issues)
