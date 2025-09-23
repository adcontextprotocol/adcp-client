[**@adcp/client API Reference v2.0.0**](../README.md)

***

[@adcp/client API Reference](../README.md) / ADCPMultiAgentClient

# Class: ADCPMultiAgentClient

Defined in: [src/lib/core/ADCPMultiAgentClient.ts:294](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/core/ADCPMultiAgentClient.ts#L294)

Main multi-agent ADCP client providing simple, intuitive API

This is the primary entry point for most users. It provides:
- Single agent access via agent(id)
- Multi-agent access via agents([ids])  
- Broadcast access via allAgents()
- Simple parallel execution using Promise.all()

## Example

```typescript
const client = new ADCPMultiAgentClient([
  { id: 'agent1', name: 'Agent 1', agent_uri: 'https://agent1.com', protocol: 'mcp' },
  { id: 'agent2', name: 'Agent 2', agent_uri: 'https://agent2.com', protocol: 'a2a' }
]);

// Single agent
const result = await client.agent('agent1').getProducts(params, handler);

// Multiple specific agents  
const results = await client.agents(['agent1', 'agent2']).getProducts(params, handler);

// All agents
const allResults = await client.allAgents().getProducts(params, handler);
```

## Constructors

### Constructor

> **new ADCPMultiAgentClient**(`agentConfigs`, `config`): `ADCPMultiAgentClient`

Defined in: [src/lib/core/ADCPMultiAgentClient.ts:297](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/core/ADCPMultiAgentClient.ts#L297)

#### Parameters

##### agentConfigs

[`AgentConfig`](../interfaces/AgentConfig.md)[]

##### config

[`ADCPClientConfig`](../interfaces/ADCPClientConfig.md) = `{}`

#### Returns

`ADCPMultiAgentClient`

## Accessors

### agentCount

#### Get Signature

> **get** **agentCount**(): `number`

Defined in: [src/lib/core/ADCPMultiAgentClient.ts:598](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/core/ADCPMultiAgentClient.ts#L598)

Get count of configured agents

##### Returns

`number`

## Methods

### fromConfig()

> `static` **fromConfig**(`config?`): `ADCPMultiAgentClient`

Defined in: [src/lib/core/ADCPMultiAgentClient.ts:330](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/core/ADCPMultiAgentClient.ts#L330)

Create client by auto-discovering agent configuration

Automatically loads agents from:
1. Environment variables (SALES_AGENTS_CONFIG, ADCP_AGENTS_CONFIG, etc.)
2. Config files (adcp.config.json, adcp.json, .adcp.json, agents.json)

#### Parameters

##### config?

[`ADCPClientConfig`](../interfaces/ADCPClientConfig.md)

Optional client configuration

#### Returns

`ADCPMultiAgentClient`

ADCPMultiAgentClient instance with discovered agents

#### Example

```typescript
// Simplest possible setup - auto-discovers configuration
const client = ADCPMultiAgentClient.fromConfig();

// Use with options
const client = ADCPMultiAgentClient.fromConfig({
  debug: true,
  defaultTimeout: 60000
});
```

***

### fromEnv()

> `static` **fromEnv**(`config?`): `ADCPMultiAgentClient`

Defined in: [src/lib/core/ADCPMultiAgentClient.ts:356](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/core/ADCPMultiAgentClient.ts#L356)

Create client from environment variables only

#### Parameters

##### config?

[`ADCPClientConfig`](../interfaces/ADCPClientConfig.md)

Optional client configuration

#### Returns

`ADCPMultiAgentClient`

ADCPMultiAgentClient instance with environment-loaded agents

#### Example

```typescript
// Load agents from SALES_AGENTS_CONFIG environment variable
const client = ADCPMultiAgentClient.fromEnv();
```

***

### fromFile()

> `static` **fromFile**(`configPath?`, `config?`): `ADCPMultiAgentClient`

Defined in: [src/lib/core/ADCPMultiAgentClient.ts:387](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/core/ADCPMultiAgentClient.ts#L387)

Create client from a specific config file

#### Parameters

##### configPath?

`string`

Path to configuration file

##### config?

[`ADCPClientConfig`](../interfaces/ADCPClientConfig.md)

Optional client configuration

#### Returns

`ADCPMultiAgentClient`

ADCPMultiAgentClient instance with file-loaded agents

#### Example

```typescript
// Load from specific file
const client = ADCPMultiAgentClient.fromFile('./my-agents.json');

// Load from default locations
const client = ADCPMultiAgentClient.fromFile();
```

***

### simple()

> `static` **simple**(`agentUrl`, `options`): `ADCPMultiAgentClient`

Defined in: [src/lib/core/ADCPMultiAgentClient.ts:422](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/core/ADCPMultiAgentClient.ts#L422)

Create a simple client with minimal configuration

#### Parameters

##### agentUrl

`string`

Single agent URL

##### options

Optional agent and client configuration

###### agentId?

`string`

###### agentName?

`string`

###### protocol?

`"mcp"` \| `"a2a"`

###### requiresAuth?

`boolean`

###### authTokenEnv?

`string`

###### debug?

`boolean`

###### timeout?

`number`

#### Returns

`ADCPMultiAgentClient`

ADCPMultiAgentClient instance with single agent

#### Example

```typescript
// Simplest possible setup for single agent
const client = ADCPMultiAgentClient.simple('https://my-agent.example.com');

// With options
const client = ADCPMultiAgentClient.simple('https://my-agent.example.com', {
  agentName: 'My Agent',
  protocol: 'mcp',
  requiresAuth: true,
  debug: true
});
```

***

### agent()

> **agent**(`agentId`): [`AgentClient`](AgentClient.md)

Defined in: [src/lib/core/ADCPMultiAgentClient.ts:477](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/core/ADCPMultiAgentClient.ts#L477)

Get a single agent for operations

#### Parameters

##### agentId

`string`

ID of the agent to get

#### Returns

[`AgentClient`](AgentClient.md)

AgentClient for the specified agent

#### Throws

Error if agent not found

#### Example

```typescript
const agent = client.agent('premium-agent');
const products = await agent.getProducts({ brief: 'Coffee brands' }, handler);
const refined = await agent.continueConversation('Focus on premium brands');
```

***

### agents()

> **agents**(`agentIds`): [`NewAgentCollection`](NewAgentCollection.md)

Defined in: [src/lib/core/ADCPMultiAgentClient.ts:507](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/core/ADCPMultiAgentClient.ts#L507)

Get multiple specific agents for parallel operations

#### Parameters

##### agentIds

`string`[]

Array of agent IDs

#### Returns

[`NewAgentCollection`](NewAgentCollection.md)

AgentCollection for parallel operations

#### Throws

Error if any agent not found

#### Example

```typescript
const agents = client.agents(['agent1', 'agent2']);
const results = await agents.getProducts({ brief: 'Coffee brands' }, handler);

// Process results
results.forEach(result => {
  if (result.success) {
    console.log(`${result.metadata.agent.name}: ${result.data.products.length} products`);
  }
});
```

***

### allAgents()

> **allAgents**(): [`NewAgentCollection`](NewAgentCollection.md)

Defined in: [src/lib/core/ADCPMultiAgentClient.ts:539](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/core/ADCPMultiAgentClient.ts#L539)

Get all configured agents for broadcast operations

#### Returns

[`NewAgentCollection`](NewAgentCollection.md)

AgentCollection containing all agents

#### Example

```typescript
const allResults = await client.allAgents().getProducts({
  brief: 'Premium coffee brands'
}, handler);

// Find best result
const successful = allResults.filter(r => r.success);
const bestResult = successful.sort((a, b) => 
  b.data.products.length - a.data.products.length
)[0];
```

***

### addAgent()

> **addAgent**(`agentConfig`): `void`

Defined in: [src/lib/core/ADCPMultiAgentClient.ts:556](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/core/ADCPMultiAgentClient.ts#L556)

Add an agent to the client

#### Parameters

##### agentConfig

[`AgentConfig`](../interfaces/AgentConfig.md)

Agent configuration to add

#### Returns

`void`

#### Throws

Error if agent ID already exists

***

### removeAgent()

> **removeAgent**(`agentId`): `boolean`

Defined in: [src/lib/core/ADCPMultiAgentClient.ts:570](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/core/ADCPMultiAgentClient.ts#L570)

Remove an agent from the client

#### Parameters

##### agentId

`string`

ID of agent to remove

#### Returns

`boolean`

True if agent was removed, false if not found

***

### hasAgent()

> **hasAgent**(`agentId`): `boolean`

Defined in: [src/lib/core/ADCPMultiAgentClient.ts:577](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/core/ADCPMultiAgentClient.ts#L577)

Check if an agent exists

#### Parameters

##### agentId

`string`

#### Returns

`boolean`

***

### getAgentIds()

> **getAgentIds**(): `string`[]

Defined in: [src/lib/core/ADCPMultiAgentClient.ts:584](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/core/ADCPMultiAgentClient.ts#L584)

Get all configured agent IDs

#### Returns

`string`[]

***

### getAgentConfigs()

> **getAgentConfigs**(): [`AgentConfig`](../interfaces/AgentConfig.md)[]

Defined in: [src/lib/core/ADCPMultiAgentClient.ts:591](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/core/ADCPMultiAgentClient.ts#L591)

Get all agent configurations

#### Returns

[`AgentConfig`](../interfaces/AgentConfig.md)[]

***

### getAgentsByProtocol()

> **getAgentsByProtocol**(`protocol`): [`NewAgentCollection`](NewAgentCollection.md)

Defined in: [src/lib/core/ADCPMultiAgentClient.ts:607](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/core/ADCPMultiAgentClient.ts#L607)

Filter agents by protocol

#### Parameters

##### protocol

`"mcp"` | `"a2a"`

#### Returns

[`NewAgentCollection`](NewAgentCollection.md)

***

### findAgentsForTask()

> **findAgentsForTask**(`taskName`): [`NewAgentCollection`](NewAgentCollection.md)

Defined in: [src/lib/core/ADCPMultiAgentClient.ts:619](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/core/ADCPMultiAgentClient.ts#L619)

Find agents that support a specific task
This is a placeholder - in a full implementation, you'd query agent capabilities

#### Parameters

##### taskName

`string`

#### Returns

[`NewAgentCollection`](NewAgentCollection.md)

***

### getAllActiveTasks()

> **getAllActiveTasks**(): [`TaskState`](../interfaces/TaskState.md)[]

Defined in: [src/lib/core/ADCPMultiAgentClient.ts:627](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/core/ADCPMultiAgentClient.ts#L627)

Get all active tasks across all agents

#### Returns

[`TaskState`](../interfaces/TaskState.md)[]
