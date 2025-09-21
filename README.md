# @adcp/client

[![npm version](https://badge.fury.io/js/@adcp%2Fclient.svg)](https://badge.fury.io/js/@adcp%2Fclient)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-Ready-blue.svg)](https://www.typescriptlang.org/)

The official TypeScript/JavaScript client library for the **Ad Context Protocol (AdCP)**. Build applications that communicate with advertising agents using both MCP (Model Context Protocol) and A2A (Agent-to-Agent) protocols.

## 🚀 Why @adcp/client?

- **🔗 Unified Interface** - Single API for both MCP and A2A protocols
- **🔐 Built-in Authentication** - Handle bearer tokens and API keys seamlessly  
- **🛡️ Type Safe** - Full TypeScript support with comprehensive type definitions
- **⚡ Production Ready** - Circuit breakers, retries, timeout handling, and validation
- **🧪 Well Tested** - Includes comprehensive testing framework and examples
- **📚 Great Developer Experience** - Extensive documentation, examples, and debugging tools

## 📦 Installation

```bash
npm install @adcp/client
```

### Peer Dependencies

The library requires the official protocol SDKs:

```bash
npm install @a2a-js/sdk @modelcontextprotocol/sdk
```

## 🏃‍♂️ Quick Start

### Basic Usage

```typescript
import { AdCPClient, type AgentConfig } from '@adcp/client';

// Configure your agents
const agents: AgentConfig[] = [
  {
    id: 'my-mcp-agent',
    name: 'My MCP Agent', 
    agent_uri: 'https://my-agent.example.com/mcp/',
    protocol: 'mcp',
    auth_token_env: 'MCP_AUTH_TOKEN',
    requiresAuth: true
  }
];

// Create client
const client = new AdCPClient(agents);

// Call a tool
const result = await client.callTool('my-mcp-agent', 'get_products', {
  brief: 'Looking for premium coffee advertising opportunities',
  promoted_offering: 'Artisan coffee blends'
});

console.log(result.success ? result.data : result.error);
```

### Protocol-Specific Clients

```typescript
import { createMCPClient, createA2AClient } from '@adcp/client';

// MCP client
const mcpClient = createMCPClient(
  'https://agent.example.com/mcp/', 
  'your-auth-token'
);

const products = await mcpClient.callTool('get_products', {
  brief: 'Sustainable fashion brands',
  promoted_offering: 'Eco-friendly clothing'
});

// A2A client  
const a2aClient = createA2AClient(
  'https://agent.example.com',
  'your-auth-token'
);

const formats = await a2aClient.callTool(
  'list_creative_formats',
  'Video advertising formats',
  'Premium video content'
);
```

## 🔧 Core Features

### Multi-Agent Testing

```typescript
// Test multiple agents simultaneously
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
  if (result.success) {
    console.log('Products:', result.data.products?.length || 0);
  } else {
    console.log('Error:', result.error);
  }
});
```

### Environment Configuration

```typescript
import { ConfigurationManager } from '@adcp/client';

// Load agents from environment variables
const agents = ConfigurationManager.loadAgentsFromEnv();
const client = new AdCPClient(agents);
```

Set up your `.env` file:
```bash
SALES_AGENTS_CONFIG='{"agents":[{"id":"test-agent","name":"Test Agent","agent_uri":"https://agent.example.com","protocol":"mcp","auth_token_env":"AGENT_TOKEN","requiresAuth":true}]}'
AGENT_TOKEN=your-actual-auth-token
```

### Error Handling & Debugging

```typescript
try {
  const result = await client.callTool('agent-id', 'get_products', {
    brief: 'Test query'
  });
  
  if (result.success) {
    console.log('Success:', result.data);
    
    // Check for warnings
    if (result.debug_logs) {
      result.debug_logs.forEach(log => {
        if (log.type === 'warning') {
          console.warn('Warning:', log.message);
        }
      });
    }
  } else {
    console.error('Agent error:', result.error);
    console.log('Response time:', result.response_time_ms, 'ms');
  }
} catch (error) {
  console.error('Network or client error:', error);
}
```

## 📋 Available Tools

The library supports the official AdCP tools as defined in the [AdCP Specification](https://adcontextprotocol.org):

| Tool | Description | Parameters |
|------|-------------|------------|
| `get_products` | Retrieve advertising products | `brief`, `promoted_offering` |
| `list_creative_formats` | Get supported creative formats | Optional filters |
| `create_media_buy` | Create media buys from products | `products`, `creative_assets`, `targeting`, `budget` |
| `manage_creative_assets` | Manage creative assets | `action`, `assets`, etc. |
| `sync_creatives` | Sync creative assets | `creatives`, `patch`, `dry_run` |
| `list_creatives` | List creative assets | `filters`, `pagination` |

> **Note**: This list reflects the current AdCP specification. For the complete and authoritative tool definitions, see the [official AdCP documentation](https://adcontextprotocol.org).

## 🏗️ API Reference

### AdCPClient Class

```typescript
class AdCPClient {
  constructor(agents?: AgentConfig[])
  
  // Agent management
  addAgent(agent: AgentConfig): void
  getAgents(): AgentConfig[]
  
  // Tool execution
  callTool(agentId: string, toolName: string, args: Record<string, any>): Promise<TestResult>
  callToolOnAgents(agentIds: string[], toolName: string, args: Record<string, any>): Promise<TestResult[]>
  
  // Utilities
  getStandardFormats(): CreativeFormat[]
}
```

### Configuration Types

```typescript
interface AgentConfig {
  id: string
  name: string
  agent_uri: string
  protocol: 'mcp' | 'a2a'
  auth_token_env?: string
  requiresAuth?: boolean
}

interface TestResult {
  agent_id: string
  agent_name: string
  success: boolean
  response_time_ms: number
  data?: any
  error?: string
  timestamp: string
  debug_logs?: any[]
}
```

## 🧪 Testing Framework

This package also includes a complete testing framework with a web UI:

```bash
# Clone the repository for full testing capabilities
git clone https://github.com/your-org/adcp-client
cd adcp-client
npm install

# Start the testing UI
npm run dev
# Open http://localhost:3000
```

The testing framework provides:
- 🌐 **Interactive Web UI** for point-and-click testing
- 📊 **Detailed Results** with timing and debug information  
- 🔍 **Protocol Debugging** with request/response logging
- 📈 **Performance Analysis** with response time metrics
- 🔄 **Concurrent Testing** of multiple agents

## 📖 Examples

Check out the [`examples/`](./examples/) directory for comprehensive usage examples:

- **[basic-mcp.ts](./examples/basic-mcp.ts)** - Simple MCP client usage
- **[basic-a2a.ts](./examples/basic-a2a.ts)** - A2A client with multi-agent testing
- **[env-config.ts](./examples/env-config.ts)** - Environment-based configuration

## 🔒 Security

- **Authentication**: Supports both bearer tokens and API keys
- **URL Validation**: Prevents SSRF attacks with built-in URL validation
- **Rate Limiting**: Built-in circuit breakers prevent overwhelming agents
- **Secure Defaults**: Production-safe defaults for all configuration options

See [SECURITY.md](./SECURITY.md) for security policy and reporting procedures.

## 🛠️ Development

### Building from Source

```bash
git clone https://github.com/your-org/adcp-client
cd adcp-client
npm install

# Build library only
npm run build:lib

# Build everything (library + testing framework)
npm run build

# Run tests
npm test

# Start development server
npm run dev
```

### Contributing

We welcome contributions! Please see [CONTRIBUTING.md](./CONTRIBUTING.md) for guidelines.

## 📝 Changelog

See [CHANGELOG.md](./CHANGELOG.md) for version history and breaking changes.

## 📄 License

MIT License - see [LICENSE](./LICENSE) for details.

## 🔗 Links

- **[AdCP Specification](https://adcontextprotocol.org)** - Protocol documentation
- **[MCP Documentation](https://spec.modelcontextprotocol.io/)** - Model Context Protocol
- **[A2A Documentation](https://github.com/a2a-js/sdk)** - Agent-to-Agent protocol
- **[API Documentation](./API.md)** - Detailed API reference
- **[Examples](./examples/)** - Usage examples and tutorials

---

**Need help?** [Open an issue](https://github.com/your-org/adcp-client/issues) or check our [documentation](./API.md).