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

### Requirements

- **Node.js**: Version 18.0.0 or higher (specified in `.nvmrc`)
- **TypeScript**: 5.3.0+ for full type safety
- **Peer Dependencies**: `@a2a-js/sdk` and `@modelcontextprotocol/sdk`

## Quick Start

```typescript
import { ADCPMultiAgentClient } from '@adcp/client';

// Multi-agent setup with type safety
const client = new ADCPMultiAgentClient([{
  id: 'premium-agent',
  name: 'Premium Ad Agent', 
  agent_uri: 'https://agent.example.com/mcp/',
  protocol: 'mcp',
  auth_token_env: 'PREMIUM_AGENT_TOKEN' // Secure: references environment variable
}]);

const agent = client.agent('premium-agent');

// ✅ TYPE-SAFE: Full IntelliSense and compile-time checking
const result = await agent.getProducts({
  brief: 'Looking for premium coffee advertising',
  promoted_offering: 'Artisan coffee blends'
});
// result is TaskResult<GetProductsResponse> with known properties

if (result.success) {
  console.log('Products:', result.data.products); // Fully typed!
} else {
  console.error('Error:', result.error);
}
```

## 🔧 Easy Configuration

### Environment-based Setup (Recommended)
Set your agent configuration once and auto-discover everywhere:

```bash
# .env file - NEVER commit real tokens to version control
ADCP_AGENTS='[{"id":"agent1","name":"My Agent","agent_uri":"https://agent.example.com","protocol":"mcp","auth_token_env":"MY_AGENT_TOKEN"}]'
MY_AGENT_TOKEN=your_actual_token_here
```

**Security Best Practices:**
- Use `auth_token_env` to reference environment variables instead of hardcoding tokens
- Add `.env` files to `.gitignore`
- Rotate tokens regularly
- Use different tokens for different environments

```typescript
// Auto-discover agents from environment
const client = ADCPMultiAgentClient.fromEnv();
console.log(`Found ${client.agentCount} agents`); // Auto-discovered!

// Or manually configure
const client = new ADCPMultiAgentClient([
  { id: 'agent1', agent_uri: 'https://...', protocol: 'mcp' }
]);
```

### Multiple Agents Made Simple
```typescript
const client = new ADCPMultiAgentClient([
  { id: 'premium', agent_uri: 'https://premium.example.com', protocol: 'mcp' },
  { id: 'budget', agent_uri: 'https://budget.example.com', protocol: 'a2a' }
]);

// Work with specific agents
const premium = client.agent('premium');
const budget = client.agent('budget');

// Or run across all agents in parallel
const allResults = await client.getProducts(params); // TaskResult<GetProductsResponse>[]
```

## 🛡️ Type Safety

Get **full TypeScript support** with compile-time checking and IntelliSense:

```typescript
const agent = client.agent('agent-id');

// ✅ TYPE-SAFE METHODS: Full IntelliSense, compile-time checking
await agent.getProducts(params);           // TaskResult<GetProductsResponse>
await agent.createMediaBuy(params);       // TaskResult<CreateMediaBuyResponse>
await agent.listCreativeFormats(params);  // TaskResult<ListCreativeFormatsResponse>

// ✅ GENERIC METHOD WITH AUTO TYPE INFERENCE: No casting needed!
const result = await agent.executeTask('get_products', params);
// result is TaskResult<GetProductsResponse> - TypeScript knows the return type!

// ✅ CUSTOM TYPES: For non-standard tasks
const customResult = await agent.executeTask<MyCustomResponse>('custom_task', params);

// ✅ BOTH support async patterns & input handlers!
const withHandler = await agent.getProducts(
  { brief: "Premium inventory" },
  async (inputRequest) => ({ approve: true })
);
```

## Key Features

- **🔗 Unified Interface** - Single API for MCP and A2A protocols
- **⚡ Async Support** - Handle long-running tasks with webhooks and deferrals  
- **🔐 Built-in Auth** - Bearer tokens and API key support with environment variable security
- **🛡️ Type Safe** - Full TypeScript with comprehensive types
- **📊 Production Ready** - Circuit breakers, retries, and validation
- **🔒 Security-First** - No hardcoded tokens, SSRF protection, secure defaults
- **🧪 Protocol Compliance** - 100% A2A and MCP specification compliance
- **🌐 Cross-Platform** - Works with Node.js 18+ and modern JavaScript environments

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