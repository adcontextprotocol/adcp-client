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
  // See result.adcpError for structured error details (code, recovery, suggestion)
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
const result = await agent.getProducts({ brief: 'test' });

if (!result.success) {
  // Human-readable error string
  console.error('Failed:', result.error);
  // e.g. "INVALID_REQUEST: Negative budget not allowed"

  // Structured error info (when the agent returns adcp_error)
  if (result.adcpError) {
    console.log('Code:', result.adcpError.code);
    console.log('Recovery:', result.adcpError.recovery);

    if (result.adcpError.recovery === 'transient') {
      // Retry after the suggested delay (retryAfterMs is in milliseconds)
      await sleep(result.adcpError.retryAfterMs ?? 5000);
    } else if (result.adcpError.recovery === 'correctable') {
      // Fix the request using the agent's suggestion
      console.log('Fix:', result.adcpError.suggestion);
    }
  }

  // Correlation ID for tracing across agents
  if (result.correlationId) {
    console.log('Correlation ID:', result.correlationId);
  }

  return;
}

console.log('Data:', result.data);
```

For retry logic, use the built-in utilities:

```typescript
import { isRetryable, getRetryDelay } from '@adcp/client';

async function withRetry(fn: () => Promise<TaskResult>, maxRetries = 3) {
  for (let i = 0; i <= maxRetries; i++) {
    const result = await fn();
    if (result.success || !isRetryable(result)) return result;
    await sleep(getRetryDelay(result)); // ms, defaults to 5000
  }
  return fn();
}
```

**Type narrowing:** `TaskResult` is a discriminated union on `success`. After checking `result.success`, TypeScript narrows the type:

```typescript
if (result.success && result.status === 'completed') {
  result.data    // T (not T | undefined)
}
if (!result.success) {
  result.error   // string (always present)
  result.status  // 'failed' | 'governance-denied'
}
```

Use `getExpectedAction(result.adcpError.recovery)` to map recovery to an action string (`'retry'`, `'fix_request'`, `'escalate'`). If `correlationId` is undefined, the agent did not include one — use `result.metadata.taskId` as a local trace reference.

`result.adcpError.synthetic` is `true` when the SDK inferred the error from unstructured text (the agent didn't return a proper `adcp_error` object). Synthetic errors have a code of `mcp_error` and may lack recovery classification.

## Next Steps

- Explore [Real-World Examples](./guides/REAL-WORLD-EXAMPLES.md)
- Learn about [Async Patterns](./guides/ASYNC-DEVELOPER-GUIDE.md)
- Read the [API Reference](./api/index.html)
- Try the Interactive Testing UI (`npm run dev`)
