# @adcp/client

[![npm version](https://badge.fury.io/js/@adcp%2Fclient.svg)](https://badge.fury.io/js/@adcp%2Fclient)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-Ready-blue.svg)](https://www.typescriptlang.org/)
[![Documentation](https://img.shields.io/badge/docs-GitHub%20Pages-blue)](https://your-org.github.io/adcp-client/)

Official TypeScript/JavaScript client for the **Ad Context Protocol (AdCP)**. Seamlessly communicate with advertising agents using MCP and A2A protocols.

## Installation

```bash
npm install @adcp/client
```

## Quick Start

```typescript
import { ADCPClient } from '@adcp/client';

// Simple setup with direct URL
const client = ADCPClient.simple('https://agent.example.com/mcp/', {
  authToken: 'your-auth-token'
});

// Execute a task
const result = await client.executeTask('get_products', {
  brief: 'Looking for premium coffee advertising',
  promoted_offering: 'Artisan coffee blends'
});

if (result.success) {
  console.log('Products:', result.data.products);
} else {
  console.error('Error:', result.error);
}
```

## Key Features

- **🔗 Unified Interface** - Single API for MCP and A2A protocols
- **⚡ Async Support** - Handle long-running tasks with webhooks and deferrals
- **🔐 Built-in Auth** - Bearer tokens and API key support
- **🛡️ Type Safe** - Full TypeScript with comprehensive types
- **📊 Production Ready** - Circuit breakers, retries, and validation

## Async Execution Model

Handle complex async patterns with ease:

```typescript
// Configure input handler for interactive tasks
const client = ADCPClient.simple('https://agent.example.com', {
  authToken: 'token',
  inputHandler: async (request) => {
    // Handle 'input-required' status
    if (request.type === 'user_approval') {
      const approved = await getUserApproval(request.data);
      return { approved };
    }
    // Defer for human review
    return { defer: true };
  }
});

// Long-running server task (returns immediately)
const result = await client.executeTask('analyze_campaign', {
  campaign_id: '12345'
});

if (result.status === 'submitted') {
  // Task running on server, will notify via webhook
  console.log('Task ID:', result.submitted.taskId);
  console.log('Webhook:', result.submitted.webhookUrl);
}

// Client-deferred task (needs human input)
if (result.status === 'deferred') {
  // Save continuation for later
  const continuation = result.deferred;
  
  // ... later, after human provides input ...
  const finalResult = await client.resumeDeferredTask(
    continuation,
    { approved: true, budget: 50000 }
  );
}
```

## Multi-Agent Support

```typescript
import { ADCPMultiAgentClient } from '@adcp/client';

const client = new ADCPMultiAgentClient([
  { 
    id: 'agent1',
    name: 'MCP Agent',
    agent_uri: 'https://agent1.example.com/mcp/',
    protocol: 'mcp',
    requiresAuth: true,
    auth_token_env: 'AGENT1_TOKEN'
  },
  {
    id: 'agent2', 
    name: 'A2A Agent',
    agent_uri: 'https://agent2.example.com',
    protocol: 'a2a'
  }
]);

// Execute on specific agent
const result = await client.executeTask('agent1', 'get_products', params);

// Execute on all agents in parallel
const results = await client.executeTaskOnAll('get_products', params);
```

## Documentation

- 📚 **[Full Documentation](https://your-org.github.io/adcp-client/)** - Complete guides and API reference
- 🚀 **[Getting Started Guide](https://your-org.github.io/adcp-client/getting-started)** - Step-by-step tutorial
- 🔄 **[Async Patterns](https://your-org.github.io/adcp-client/async-patterns)** - Handle complex async flows
- 📖 **[API Reference](https://your-org.github.io/adcp-client/api)** - Generated from TypeDoc
- 💡 **[Examples](./examples/)** - Real-world usage examples

## Examples

```bash
# Clone for full examples
git clone https://github.com/your-org/adcp-client
cd adcp-client/examples

# Run examples
npx tsx basic-usage.ts
npx tsx async-patterns.ts
npx tsx multi-agent.ts
```

## Testing UI

The package includes an interactive testing framework:

```bash
# Install and run locally
git clone https://github.com/your-org/adcp-client
cd adcp-client
npm install
npm run dev

# Open http://localhost:8080
```

## Contributing

We welcome contributions! See [CONTRIBUTING.md](./CONTRIBUTING.md) for guidelines.

## License

MIT - see [LICENSE](./LICENSE) for details.

## Links

- [AdCP Specification](https://adcontextprotocol.org)
- [Issue Tracker](https://github.com/your-org/adcp-client/issues)
- [npm Package](https://www.npmjs.com/package/@adcp/client)