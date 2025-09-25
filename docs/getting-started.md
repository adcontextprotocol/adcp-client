# Getting Started with @adcp/client

## Installation

Install the package and its peer dependencies:

```bash
npm install @adcp/client @a2a-js/sdk @modelcontextprotocol/sdk
```

## Basic Usage

### Simple Client Setup

The easiest way to get started is with the simple client:

```typescript
import { ADCPClient } from '@adcp/client';

// Create a client for a single agent
const client = ADCPClient.simple('https://agent.example.com/mcp/', {
  authToken: 'YOUR_AUTH_TOKEN_HERE'
});

// Execute a task
const result = await client.executeTask('get_products', {
  brief: 'Looking for advertising opportunities',
  promoted_offering: 'Premium products'
});

if (result.success) {
  console.log('Products:', result.data.products);
} else {
  console.error('Error:', result.error);
}
```

### Multi-Agent Setup

For testing multiple agents:

```typescript
import { ADCPMultiAgentClient } from '@adcp/client';

const client = new ADCPMultiAgentClient([
  {
    id: 'mcp-agent',
    name: 'MCP Test Agent',
    agent_uri: 'https://agent1.example.com/mcp/',
    protocol: 'mcp',
    requiresAuth: true,
    auth_token_env: 'MCP_TOKEN'
  },
  {
    id: 'a2a-agent',
    name: 'A2A Test Agent', 
    agent_uri: 'https://agent2.example.com',
    protocol: 'a2a',
    requiresAuth: true,
    auth_token_env: 'A2A_TOKEN'
  }
]);

// Execute on specific agent
const result = await client.executeTask('mcp-agent', 'get_products', {
  brief: 'Tech products'
});

// Execute on all agents
const results = await client.executeTaskOnAll('get_products', {
  brief: 'Tech products'
});
```

## Authentication

### Environment Variables

Store auth tokens in environment variables:

```bash
# .env file
MCP_TOKEN=your-mcp-auth-token
A2A_TOKEN=your-a2a-auth-token
```

Then reference them in your agent configuration:

```typescript
const agents = [
  {
    id: 'agent1',
    name: 'Test Agent',
    agent_uri: 'https://agent.example.com',
    protocol: 'mcp',
    auth_token_env: 'MCP_TOKEN', // References env variable
    requiresAuth: true
  }
];
```

### Direct Token

For testing, you can provide tokens directly:

```typescript
const client = ADCPClient.simple('https://agent.example.com', {
  authToken: 'YOUR_BEARER_TOKEN_HERE'
});
```

## Handling Async Tasks

The client supports various async patterns:

### Input-Required Tasks

```typescript
const client = ADCPClient.simple('https://agent.example.com', {
  authToken: 'token',
  inputHandler: async (request) => {
    console.log('Agent needs input:', request);
    
    // Provide input immediately
    if (request.type === 'confirmation') {
      return { confirmed: true };
    }
    
    // Or defer for later
    return { defer: true };
  }
});
```

### Long-Running Tasks

```typescript
const result = await client.executeTask('analyze_campaign', {
  campaign_id: '12345'
});

// Check the status
if (result.status === 'submitted') {
  // Task is running on server
  const { taskId, webhookUrl } = result.submitted;
  console.log(`Task ${taskId} submitted, webhook: ${webhookUrl}`);
  
  // Poll for completion
  const finalResult = await client.pollTaskCompletion(taskId, {
    maxAttempts: 10,
    intervalMs: 5000
  });
}
```

## Error Handling

Always handle errors appropriately:

```typescript
try {
  const result = await client.executeTask('get_products', params);
  
  if (!result.success) {
    // Agent returned an error
    console.error('Task failed:', result.error);
    return;
  }
  
  // Process successful result
  console.log('Data:', result.data);
  
} catch (error) {
  // Network or client error
  console.error('Client error:', error);
}
```

## Next Steps

- Explore [Real-World Examples](./guides/REAL-WORLD-EXAMPLES.md)
- Learn about [Async Patterns](./guides/ASYNC-DEVELOPER-GUIDE.md)
- Read the [API Reference](./api/index.html)
- Try the [Interactive Testing UI](#testing-ui)