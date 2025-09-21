# ADCP TypeScript Client Library v2.0

A comprehensive, conversation-aware TypeScript client library for the **Ad Context Protocol (ADCP)**.

## 🤔 What is ADCP?

**ADCP (Ad Context Protocol)** is a standardized protocol that enables programmatic advertising tools to communicate with advertising agents. Think of it as "APIs for advertising" - it allows your applications to:

- **Discover ad inventory** from multiple publishers and networks
- **Create and manage campaigns** programmatically
- **Query audience signals** for targeting
- **Sync creative assets** across platforms
- **Get performance data** and optimize campaigns

Instead of integrating with dozens of different advertising APIs, you integrate once with ADCP and connect to any ADCP-compliant advertising agent.

## 🚀 30-Second Quick Start

### Installation

```bash
npm install @adcp/client
```

### Option 1: Super Simple Setup (Recommended)

**Just set an environment variable and go:**

```bash
# Set your agent configuration
export SALES_AGENTS_CONFIG='{"agents":[{"id":"my-agent","name":"My Agent","agent_uri":"https://your-agent.example.com","protocol":"mcp"}]}'
```

```typescript
import { ADCPMultiAgentClient } from '@adcp/client';

// 1. Auto-load configuration from environment
const client = ADCPMultiAgentClient.fromConfig();

// 2. Ask for products - that's it!
const agent = client.agent('my-agent');
const result = await agent.getProducts({
  brief: 'Coffee products for young professionals',
  promoted_offering: 'Premium coffee subscriptions'
});

if (result.success) {
  console.log(`Found ${result.data.products.length} advertising products!`);
}
```

### Option 2: Config File Setup

**Create `adcp.config.json`:**
```json
{
  "agents": [
    {
      "id": "my-agent",
      "name": "My Advertising Agent", 
      "agent_uri": "https://your-agent.example.com",
      "protocol": "mcp"
    }
  ]
}
```

```typescript
import { ADCPMultiAgentClient } from '@adcp/client';

// Auto-discovers and loads adcp.config.json
const client = ADCPMultiAgentClient.fromConfig();
const agent = client.agent('my-agent');
// Use agent...
```

### Option 3: One-Liner Setup

```typescript
import { ADCPMultiAgentClient } from '@adcp/client';

// Single agent setup in one line
const client = ADCPMultiAgentClient.simple('https://your-agent.example.com');
const agent = client.agent('default-agent');
// Use agent...
```

**That's it!** No complex configuration objects, no manual agent array setup. The library auto-discovers your configuration and handles the rest.

## 🎯 When You Need More Control

For production use, you'll often want to handle agent clarifications automatically:

```typescript
import { createFieldHandler } from '@adcp/client';

// Handle common questions agents ask
const handler = createFieldHandler({
  budget: 50000,           // Auto-answer budget questions
  targeting: ['US', 'CA'], // Auto-answer targeting questions
  approval: true           // Auto-approve when asked
});

const result = await agent.getProducts({
  brief: 'Coffee advertising campaign'
}, handler); // Pass handler for clarifications
```

## 🌟 Key Features

- **🔒 Full Type Safety**: IntelliSense support for all ADCP tasks
- **💬 Conversation Memory**: Agents remember your conversation context
- **🎯 Smart Clarifications**: Handle agent questions with custom logic
- **⚡ Multi-Agent Support**: Query multiple agents in parallel
- **🛡️ Protocol Agnostic**: Works with both MCP and A2A protocols seamlessly  
- **📦 Zero Dependencies**: No database setup required
- **🔌 Optional Everything**: Storage, logging, auth - all optional

## 📚 Step-by-Step Tutorial

### Step 1: Basic Product Discovery

Start with the simplest possible ADCP operation:

```typescript
import { ADCPMultiAgentClient } from '@adcp/client';

const client = new ADCPMultiAgentClient([{
  id: 'fashion-agent',
  name: 'Fashion Ad Network',
  agent_uri: 'https://fashion-ads.example.com',
  protocol: 'mcp'
}]);

// Just ask for products
const agent = client.agent('fashion-agent');
const products = await agent.getProducts({
  brief: 'Summer fashion for Gen Z',
  promoted_offering: 'Sustainable clothing brands'
});

console.log(`Found ${products.data.products.length} products`);
```

### Step 2: Add Automatic Responses

When agents ask for clarification, you can respond automatically:

```typescript
import { createFieldHandler } from '@adcp/client';

const smartHandler = createFieldHandler({
  budget: 25000,                    // When asked about budget
  targeting: ['US', 'CA', 'UK'],    // When asked about targeting
  approval: true                    // When asked for approval
});

const products = await agent.getProducts({
  brief: 'Tech gadgets for remote workers'
}, smartHandler);
```

### Step 3: Multi-Agent Comparison

Query multiple advertising networks simultaneously:

```typescript
const client = new ADCPMultiAgentClient([
  { id: 'premium-network', agent_uri: 'https://premium.example.com', protocol: 'mcp' },
  { id: 'budget-network', agent_uri: 'https://budget.example.com', protocol: 'a2a' },
  { id: 'social-network', agent_uri: 'https://social.example.com', protocol: 'mcp' }
]);

// Query all networks in parallel
const results = await client.allAgents().getProducts({
  brief: 'Holiday gift campaign'
}, smartHandler);

// Compare results
results.forEach(result => {
  if (result.success) {
    console.log(`${result.metadata.agent.name}: ${result.data.products.length} products`);
  }
});
```

### Step 4: Conversation Flow

Have back-and-forth conversations with agents:

```typescript
const agent = client.agent('premium-network');

// Initial request
const initial = await agent.getProducts({
  brief: 'Luxury travel experiences'
});

// Refine based on results
const refined = await agent.continueConversation(
  'Focus only on European destinations under $5000'
);

// Check conversation history
const history = agent.getHistory();
console.log(`Conversation has ${history?.length} messages`);
```

## 🎯 Real-World Use Cases

### Campaign Planning Workflow

```typescript
async function planCampaign(brief: string, budget: number) {
  const handler = createFieldHandler({ budget, approval: true });
  
  // 1. Discover available products
  const products = await agent.getProducts({ brief }, handler);
  
  // 2. Check creative formats
  const formats = await agent.listCreativeFormats({ 
    type: 'video' 
  }, handler);
  
  // 3. Create media buy
  const mediaBuy = await agent.createMediaBuy({
    name: 'Summer Campaign 2024',
    products: products.data.products.slice(0, 3), // Top 3
    budget: { amount: budget, currency: 'USD' }
  }, handler);
  
  return { products, formats, mediaBuy };
}

// Usage
const campaign = await planCampaign('Summer fashion for millennials', 50000);
```

### Multi-Network Price Comparison

```typescript
async function findBestPricing(campaign: string) {
  const results = await client.allAgents().getProducts({
    brief: campaign
  }, createFieldHandler({ budget: 100000 }));
  
  // Find best pricing
  const successful = results.filter(r => r.success);
  const bestDeal = successful
    .flatMap(r => r.data.products.map(p => ({ ...p, network: r.metadata.agent.name })))
    .sort((a, b) => a.pricing.price - b.pricing.price)[0];
    
  console.log(`Best deal: ${bestDeal.name} at ${bestDeal.network} for $${bestDeal.pricing.price}`);
  return bestDeal;
}
```

## 📖 Core Concepts

### 1. Conversation Context

Every interaction maintains conversation history and context:

```typescript
const agent = client.agent('my-agent');

// First request
await agent.getProducts({ brief: 'Tech products' });

// Continues the same conversation
await agent.continueConversation('Focus on laptops under $1000');

// Access conversation history
const history = agent.getHistory();
console.log(`Conversation has ${history?.length} messages`);
```

### 2. Input Handlers

Handle agent clarification requests with custom logic:

```typescript
import { createFieldHandler, createConditionalHandler } from '@adcp/client';

// Field-specific responses
const fieldHandler = createFieldHandler({
  budget: 25000,
  targeting: ['US', 'UK'],
  approval: (context) => context.attempt === 1 ? true : false
});

// Conditional logic
const conditionalHandler = createConditionalHandler([
  {
    condition: (ctx) => ctx.agent.name.includes('Premium'),
    handler: (ctx) => 100000 // Higher budget for premium agents
  },
  {
    condition: (ctx) => ctx.attempt > 2,
    handler: (ctx) => ctx.deferToHuman() // Defer if too many attempts
  }
]);
```

### 3. Multi-Agent Operations

Execute tasks across multiple agents in parallel:

```typescript
// Query specific agents
const results = await client.agents(['agent1', 'agent2']).getProducts(params, handler);

// Query all agents
const allResults = await client.allAgents().getProducts(params, handler);

// Process results
allResults.forEach(result => {
  if (result.success) {
    console.log(`${result.metadata.agent.name}: ${result.data.products.length} products`);
  } else {
    console.error(`${result.metadata.agent.name} failed: ${result.error}`);
  }
});
```

## 🛠️ Available Tasks

All ADCP standard tasks are supported with full type safety:

### Media Buy Tasks
- `getProducts(params, handler?, options?)` - Discover advertising products
- `listCreativeFormats(params, handler?, options?)` - List available creative formats
- `createMediaBuy(params, handler?, options?)` - Create new media buy
- `updateMediaBuy(params, handler?, options?)` - Update existing media buy
- `syncCreatives(params, handler?, options?)` - Sync creative assets
- `listCreatives(params, handler?, options?)` - List creative assets
- `getMediaBuyDelivery(params, handler?, options?)` - Get delivery information
- `listAuthorizedProperties(params, handler?, options?)` - List authorized properties
- `providePerformanceFeedback(params, handler?, options?)` - Provide performance feedback

### Signals Tasks
- `getSignals(params, handler?, options?)` - Get audience signals
- `activateSignal(params, handler?, options?)` - Activate audience signals

## 🎯 Advanced Features

### Storage Configuration

Configure optional storage for persistence:

```typescript
import { createMemoryStorageConfig, MemoryStorage } from '@adcp/client';

// Use built-in memory storage
const client = new ADCPMultiAgentClient(agents, {
  storage: createMemoryStorageConfig()
});

// Or provide custom storage (Redis, database, etc.)
class RedisStorage implements Storage<any> {
  async get(key: string) { /* your implementation */ }
  async set(key: string, value: any, ttl?: number) { /* your implementation */ }
  // ... other methods
}

const client = new ADCPMultiAgentClient(agents, {
  storage: {
    conversations: new RedisStorage(),
    tokens: new RedisStorage()
  }
});
```

### Error Handling Made Simple

The library provides helpful error messages that tell you exactly what to do:

```typescript
import { isADCPError, AgentNotFoundError } from '@adcp/client';

try {
  const result = await agent.getProducts(params);
} catch (error) {
  if (error instanceof AgentNotFoundError) {
    // Clear guidance on what agents are available
    console.log(error.message);
    // "Agent 'my-agent' not found. Available agents: premium-agent, budget-agent"
    console.log('Available agents:', error.availableAgents);
  } else if (isADCPError(error)) {
    // All ADCP errors have helpful context
    console.log(`Error [${error.code}]: ${error.message}`);
  } else {
    // Network or other errors
    console.log('Network error:', error.message);
  }
}
```

**Common Errors and Solutions:**

```typescript
// ❌ Problem: Agent not responding
// ✅ Solution: Check agent URL and network connectivity
const result = await agent.getProducts(params).catch(error => {
  if (error.message.includes('ECONNREFUSED')) {
    console.log('💡 Check your agent URL and ensure the agent is running');
  }
  return { success: false, error: error.message };
});

// ❌ Problem: Agent asks for clarification but no handler provided
// ✅ Solution: Add an input handler
const result = await agent.getProducts(params, createFieldHandler({
  budget: 50000  // Provide answers for common questions
}));

// ❌ Problem: Authentication errors
// ✅ Solution: Check your auth token configuration
const agents = [{
  id: 'secure-agent',
  agent_uri: 'https://secure.example.com',
  protocol: 'mcp',
  requiresAuth: true,
  auth_token_env: 'AGENT_API_KEY'  // Make sure this env var is set
}];
```

### Debug and Observability

Enable debug logging for observability:

```typescript
const client = new ADCPMultiAgentClient(agents, {
  debug: true,
  // Custom debug callback
  debugCallback: (log) => {
    console.log(`[${log.level}] ${log.message}`, log.context);
  }
});

// Access debug logs in results
const result = await agent.getProducts(params, handler, { debug: true });
console.log('Debug logs:', result.debugLogs);
```

## 🔧 Configuration

### Easy Configuration Methods

The library supports multiple ways to configure your agents, from simplest to most flexible:

#### 1. Environment Variable (Recommended for Deployment)

```bash
# Simple format
export SALES_AGENTS_CONFIG='{"agents":[{"id":"agent1","name":"Agent 1","agent_uri":"https://agent1.example.com","protocol":"mcp"}]}'

# Or use any of these environment variables:
export ADCP_AGENTS_CONFIG='...'
export ADCP_CONFIG='...'
```

```typescript
// Automatically loads from environment
const client = ADCPMultiAgentClient.fromEnv();
```

#### 2. Configuration Files (Recommended for Development)

The library auto-discovers config files in this order:
- `adcp.config.json`
- `adcp.json` 
- `.adcp.json`
- `agents.json`

**Example `adcp.config.json`:**
```json
{
  "agents": [
    {
      "id": "premium-agent",
      "name": "Premium Ad Network",
      "agent_uri": "https://premium.example.com/mcp/",
      "protocol": "mcp",
      "requiresAuth": true,
      "auth_token_env": "PREMIUM_TOKEN"
    },
    {
      "id": "budget-agent",
      "name": "Budget Ad Network", 
      "agent_uri": "https://budget.example.com/a2a/",
      "protocol": "a2a"
    }
  ],
  "defaults": {
    "timeout": 30000,
    "debug": false
  }
}
```

```typescript
// Automatically discovers and loads config file
const client = ADCPMultiAgentClient.fromConfig();

// Or load specific file
const client = ADCPMultiAgentClient.fromFile('./my-config.json');
```

#### 3. Simple Single Agent Setup

```typescript
// One-liner for single agent
const client = ADCPMultiAgentClient.simple('https://my-agent.example.com');

// With options
const client = ADCPMultiAgentClient.simple('https://my-agent.example.com', {
  agentName: 'My Agent',
  protocol: 'mcp',
  requiresAuth: true,
  authTokenEnv: 'MY_AGENT_TOKEN',
  debug: true
});
```

#### 4. Programmatic Configuration (Advanced)

```typescript
// Full control over configuration
const client = new ADCPMultiAgentClient([
  {
    id: 'custom-agent',
    name: 'Custom Agent',
    agent_uri: 'https://custom.example.com',
    protocol: 'mcp',
    requiresAuth: true,
    auth_token_env: 'CUSTOM_TOKEN'
  }
], {
  debug: true,
  defaultTimeout: 60000
});
```

### Agent Configuration

```typescript
interface AgentConfig {
  id: string;                    // Unique agent identifier
  name: string;                  // Human-readable name
  agent_uri: string;             // Agent endpoint URL
  protocol: 'mcp' | 'a2a';       // Protocol type
  requiresAuth?: boolean;        // Whether authentication is required
  auth_token_env?: string;       // Environment variable for auth token
}
```

### Client Configuration

```typescript
interface ADCPClientConfig {
  defaultTimeout?: number;              // Default task timeout (ms)
  defaultMaxClarifications?: number;    // Max clarification rounds
  persistConversations?: boolean;       // Enable conversation persistence
  debug?: boolean;                      // Enable debug logging
  storage?: StorageConfig;              // Optional storage configuration
}
```

## 📚 Examples

Check out the [examples directory](./examples/) for comprehensive usage examples:

- `conversation-client.ts` - Complete examples showcasing all features
- Single agent conversations with context
- Multi-agent parallel execution
- Advanced input handler patterns
- Conversation history management

## 🔄 Migration from v1.x

The new library maintains backward compatibility while providing enhanced features:

```typescript
// v1.x style (still works)
const client = new AdCPClient(agents);
const result = await client.agent('my-agent').getProducts(params);

// v2.x style (recommended)
const client = new ADCPMultiAgentClient(agents);
const result = await client.agent('my-agent').getProducts(params, handler);
```

## 🤝 Contributing

This library is part of the ADCP ecosystem. See [CONTRIBUTING.md](./CONTRIBUTING.md) for guidelines.

## 📄 License

MIT License - see [LICENSE](./LICENSE) for details.

---

**Next Steps:**
- Review the [examples](./examples/) to understand usage patterns
- Check the [API documentation](./docs/) for detailed method signatures
- Join the ADCP community for support and discussions