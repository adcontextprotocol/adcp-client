# Getting Started with @adcp/client

## Installation

```bash
npm install @adcp/client
```

## Basic Usage

### Simple Client Setup

The easiest way to get started is with the simple client:

```typescript
import { ADCPMultiAgentClient } from '@adcp/client';

// Create a client for a single agent
const client = ADCPMultiAgentClient.simple('https://agent.example.com/mcp/', {
  authToken: 'YOUR_AUTH_TOKEN_HERE'
});

// simple() creates an agent with id 'default-agent'
const agent = client.agent('default-agent');
const result = await agent.getProducts({
  brief: 'Looking for advertising opportunities'
});

if (result.success && result.status === 'completed') {
  console.log('Products:', result.data?.products);
} else {
  console.error('Error:', result.error);
}
```

### Multi-Agent Setup

For working with multiple agents:

```typescript
import { ADCPMultiAgentClient } from '@adcp/client';

const client = new ADCPMultiAgentClient([
  {
    id: 'mcp-agent',
    name: 'MCP Test Agent',
    agent_uri: 'https://agent1.example.com/mcp/',
    protocol: 'mcp',
    auth_token: process.env.MCP_TOKEN
  },
  {
    id: 'a2a-agent',
    name: 'A2A Test Agent',
    agent_uri: 'https://agent2.example.com',
    protocol: 'a2a',
    auth_token: process.env.A2A_TOKEN
  }
]);

// Execute on specific agent
const agent = client.agent('mcp-agent');
const result = await agent.getProducts({ brief: 'Tech products' });

// Execute on all agents in parallel
const results = await client.allAgents().getProducts({ brief: 'Tech products' });
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
    auth_token: process.env.MCP_TOKEN
  }
];
```

### Simple Factory with Token

For quick testing:

```typescript
const client = ADCPMultiAgentClient.simple('https://agent.example.com', {
  authToken: 'YOUR_BEARER_TOKEN_HERE'
});
```

## Handling Async Tasks

### Input-Required Tasks

When an agent needs clarification, provide an input handler:

```typescript
const result = await agent.getProducts(
  { brief: 'Premium products' },
  (context) => {
    // Agent needs input
    console.log('Agent asks:', context.inputRequest.question);

    if (context.inputRequest.field === 'budget') {
      return 50000;
    }
    return context.deferToHuman();
  }
);

if (result.status === 'input-required') {
  // Continue the conversation
  const refined = await agent.continueConversation('Only premium brands');
}
```

### Long-Running Tasks

```typescript
const result = await agent.createMediaBuy({
  buyer_ref: 'campaign-123',
  account_id: 'acct-456',
  packages: [...]
});

if (result.status === 'submitted') {
  // Task is running on server, will complete via webhook
  console.log(`Task submitted, webhook: ${result.submitted?.webhookUrl}`);

  // Or poll for completion (interval in ms, default 60000)
  const finalResult = await result.submitted.waitForCompletion(5000);
}
```

## Error Handling

```typescript
import { isADCPError, isErrorOfType, TaskTimeoutError } from '@adcp/client';

try {
  const result = await agent.getProducts({ brief: 'test' });

  if (!result.success) {
    console.error('Task failed:', result.error);
    return;
  }

  console.log('Data:', result.data);
} catch (error) {
  if (isErrorOfType(error, TaskTimeoutError)) {
    console.error('Operation timed out');
  } else if (isADCPError(error)) {
    console.error('AdCP error:', error.message);
  }
}
```

## Next Steps

- Explore [Real-World Examples](./guides/REAL-WORLD-EXAMPLES.md)
- Learn about [Async Patterns](./guides/ASYNC-DEVELOPER-GUIDE.md)
- Read the [API Reference](./api/index.html)
- Try the Interactive Testing UI (`npm run dev`)
