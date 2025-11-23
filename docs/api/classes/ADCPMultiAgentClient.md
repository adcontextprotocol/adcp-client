[**@adcp/client API Reference v3.1.0**](../README.md)

***

[@adcp/client API Reference](../globals.md) / ADCPMultiAgentClient

# Class: ADCPMultiAgentClient

Defined in: [src/lib/core/ADCPMultiAgentClient.ts:369](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ADCPMultiAgentClient.ts#L369)

Main multi-agent AdCP client providing unified access to multiple advertising protocol agents.

This is the **primary entry point** for the @adcp/client library. It provides flexible
access patterns for working with one or multiple AdCP agents (MCP or A2A protocols).

## Key Features

- **Single agent access** via `agent(id)` - for individual operations
- **Multi-agent access** via `agents([ids])` - for parallel execution across specific agents
- **Broadcast access** via `allAgents()` - for parallel execution across all configured agents
- **Auto-configuration** via static factory methods (`fromConfig()`, `fromEnv()`, `fromFile()`)
- **Full type safety** - all AdCP request/response types are strongly typed
- **Protocol agnostic** - works seamlessly with both MCP and A2A agents

## Basic Usage

## Examples

```typescript
const client = new ADCPMultiAgentClient([
  { id: 'agent1', agent_uri: 'https://agent1.com', protocol: 'mcp' },
  { id: 'agent2', agent_uri: 'https://agent2.com', protocol: 'a2a' }
]);

// Execute operation on single agent
const result = await client.agent('agent1').getProducts({
  brief: 'Coffee brands for premium audience'
});

if (result.status === 'completed') {
  console.log('Products:', result.data.products);
}
```

```typescript
// Execute across specific agents
const results = await client.agents(['agent1', 'agent2']).getProducts({
  brief: 'Coffee brands'
});

// Execute across all agents
const allResults = await client.allAgents().getProducts({
  brief: 'Coffee brands'
});

// Process results from all agents
allResults.forEach((result, i) => {
  console.log(`Agent ${client.agentIds[i]}: ${result.status}`);
  if (result.status === 'completed') {
    console.log(`  Products: ${result.data.products.length}`);
  }
});
```

```typescript
// Load agents from environment variables or config files
const client = ADCPMultiAgentClient.fromConfig();

// Or from environment only
const client = ADCPMultiAgentClient.fromEnv();

// Or from specific file
const client = ADCPMultiAgentClient.fromFile('./my-agents.json');
```

## Available Operations

All standard AdCP operations are available:
- `getProducts()` - Discover advertising products
- `listCreativeFormats()` - Get supported creative formats
- `createMediaBuy()` - Create new media buy
- `updateMediaBuy()` - Update existing media buy
- `syncCreatives()` - Upload/sync creative assets
- `listCreatives()` - List creative assets
- `getMediaBuyDelivery()` - Get delivery performance
- `listAuthorizedProperties()` - Get authorized properties
- `getSignals()` - Get audience signals
- `activateSignal()` - Activate audience signals
- `providePerformanceFeedback()` - Send performance feedback

## See

 - [AgentClient](AgentClient.md) for single-agent operations
 - [AgentCollection](AgentCollection.md) for multi-agent parallel operations
 - [SingleAgentClientConfig](../interfaces/SingleAgentClientConfig.md) for configuration options

## Constructors

### Constructor

> **new ADCPMultiAgentClient**(`agentConfigs`, `config`): `ADCPMultiAgentClient`

Defined in: [src/lib/core/ADCPMultiAgentClient.ts:372](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ADCPMultiAgentClient.ts#L372)

#### Parameters

##### agentConfigs

[`AgentConfig`](../interfaces/AgentConfig.md)[] = `[]`

##### config

[`SingleAgentClientConfig`](../interfaces/SingleAgentClientConfig.md) = `{}`

#### Returns

`ADCPMultiAgentClient`

## Accessors

### agentCount

#### Get Signature

> **get** **agentCount**(): `number`

Defined in: [src/lib/core/ADCPMultiAgentClient.ts:711](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ADCPMultiAgentClient.ts#L711)

Get count of configured agents

##### Returns

`number`

## Methods

### fromConfig()

> `static` **fromConfig**(`config?`): `ADCPMultiAgentClient`

Defined in: [src/lib/core/ADCPMultiAgentClient.ts:405](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ADCPMultiAgentClient.ts#L405)

Create client by auto-discovering agent configuration

Automatically loads agents from:
1. Environment variables (SALES_AGENTS_CONFIG, ADCP_AGENTS_CONFIG, etc.)
2. Config files (adcp.config.json, adcp.json, .adcp.json, agents.json)

#### Parameters

##### config?

[`SingleAgentClientConfig`](../interfaces/SingleAgentClientConfig.md)

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

Defined in: [src/lib/core/ADCPMultiAgentClient.ts:431](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ADCPMultiAgentClient.ts#L431)

Create client from environment variables only

#### Parameters

##### config?

[`SingleAgentClientConfig`](../interfaces/SingleAgentClientConfig.md)

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

Defined in: [src/lib/core/ADCPMultiAgentClient.ts:459](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ADCPMultiAgentClient.ts#L459)

Create client from a specific config file

#### Parameters

##### configPath?

`string`

Path to configuration file

##### config?

[`SingleAgentClientConfig`](../interfaces/SingleAgentClientConfig.md)

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

Defined in: [src/lib/core/ADCPMultiAgentClient.ts:492](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ADCPMultiAgentClient.ts#L492)

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

Defined in: [src/lib/core/ADCPMultiAgentClient.ts:556](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ADCPMultiAgentClient.ts#L556)

Get a single agent client for individual operations.

This is the primary method for executing operations on a specific agent.
Returns an [AgentClient](AgentClient.md) instance that provides all AdCP operations.

#### Parameters

##### agentId

`string`

The unique identifier of the agent to retrieve

#### Returns

[`AgentClient`](AgentClient.md)

Agent client instance for the specified agent

#### Throws

If agent ID is not found in configuration

#### Example

```typescript
const client = new ADCPMultiAgentClient([
  { id: 'sales_agent', agent_uri: 'https://sales.example.com', protocol: 'a2a' }
]);

// Get specific agent and execute operation
const agent = client.agent('sales_agent');
const result = await agent.getProducts({ brief: 'Premium coffee brands' });
```

#### See

[AgentClient](AgentClient.md) for available operations

***

### agents()

> **agents**(`agentIds`): `AgentCollection`

Defined in: [src/lib/core/ADCPMultiAgentClient.ts:594](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ADCPMultiAgentClient.ts#L594)

Get multiple specific agents for parallel operations.

Returns an [AgentCollection](AgentCollection.md) that executes operations across the specified
agents in parallel using Promise.all(). Useful when you want to query specific
agents simultaneously and compare results.

#### Parameters

##### agentIds

`string`[]

Array of agent IDs to include in the collection

#### Returns

`AgentCollection`

Agent collection for parallel operations across specified agents

#### Throws

If any agent ID is not found in configuration

#### Example

```typescript
// Execute across specific agents
const results = await client.agents(['sales_agent_1', 'sales_agent_2']).getProducts({
  brief: 'Premium coffee brands'
});

// Process parallel results
results.forEach((result, i) => {
  if (result.status === 'completed') {
    console.log(`Agent ${i + 1}: ${result.data.products.length} products`);
  }
});
```

#### See

[AgentCollection](AgentCollection.md) for available parallel operations

***

### allAgents()

> **allAgents**(): `AgentCollection`

Defined in: [src/lib/core/ADCPMultiAgentClient.ts:637](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ADCPMultiAgentClient.ts#L637)

Get all configured agents for broadcast operations.

Returns an [AgentCollection](AgentCollection.md) containing all agents in the client configuration.
Executes operations across all agents in parallel, useful for market research,
price comparison, or discovering capabilities across your entire agent network.

#### Returns

`AgentCollection`

Agent collection for parallel operations across all configured agents

#### Example

```typescript
const client = new ADCPMultiAgentClient([
  { id: 'agent1', agent_uri: 'https://agent1.com', protocol: 'a2a' },
  { id: 'agent2', agent_uri: 'https://agent2.com', protocol: 'mcp' },
  { id: 'agent3', agent_uri: 'https://agent3.com', protocol: 'a2a' }
]);

// Query all agents simultaneously
const allResults = await client.allAgents().getProducts({
  brief: 'Premium coffee brands'
});

// Find best options across all agents
const successfulResults = allResults.filter(r => r.status === 'completed');
console.log(`Got products from ${successfulResults.length} agents`);
```

#### See

[AgentCollection](AgentCollection.md) for available parallel operations

***

### addAgent()

> **addAgent**(`agentConfig`): `void`

Defined in: [src/lib/core/ADCPMultiAgentClient.ts:654](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ADCPMultiAgentClient.ts#L654)

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

Defined in: [src/lib/core/ADCPMultiAgentClient.ts:668](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ADCPMultiAgentClient.ts#L668)

Remove an agent from the client

#### Parameters

##### agentId

`string`

ID of agent to remove

#### Returns

`boolean`

True if agent was removed, false if not found

***

### getAgent()

> **getAgent**(`agentId`): [`AgentClient`](AgentClient.md)

Defined in: [src/lib/core/ADCPMultiAgentClient.ts:679](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ADCPMultiAgentClient.ts#L679)

Get individual agent client by ID

#### Parameters

##### agentId

`string`

ID of agent to retrieve

#### Returns

[`AgentClient`](AgentClient.md)

AgentClient instance

#### Throws

Error if agent not found

***

### hasAgent()

> **hasAgent**(`agentId`): `boolean`

Defined in: [src/lib/core/ADCPMultiAgentClient.ts:690](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ADCPMultiAgentClient.ts#L690)

Check if an agent exists

#### Parameters

##### agentId

`string`

#### Returns

`boolean`

***

### getAgentIds()

> **getAgentIds**(): `string`[]

Defined in: [src/lib/core/ADCPMultiAgentClient.ts:697](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ADCPMultiAgentClient.ts#L697)

Get all configured agent IDs

#### Returns

`string`[]

***

### getAgentConfigs()

> **getAgentConfigs**(): [`AgentConfig`](../interfaces/AgentConfig.md)[]

Defined in: [src/lib/core/ADCPMultiAgentClient.ts:704](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ADCPMultiAgentClient.ts#L704)

Get all agent configurations

#### Returns

[`AgentConfig`](../interfaces/AgentConfig.md)[]

***

### getAgentsByProtocol()

> **getAgentsByProtocol**(`protocol`): `AgentCollection`

Defined in: [src/lib/core/ADCPMultiAgentClient.ts:720](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ADCPMultiAgentClient.ts#L720)

Filter agents by protocol

#### Parameters

##### protocol

`"mcp"` | `"a2a"`

#### Returns

`AgentCollection`

***

### findAgentsForTask()

> **findAgentsForTask**(`taskName`): `AgentCollection`

Defined in: [src/lib/core/ADCPMultiAgentClient.ts:732](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ADCPMultiAgentClient.ts#L732)

Find agents that support a specific task
This is a placeholder - in a full implementation, you'd query agent capabilities

#### Parameters

##### taskName

`string`

#### Returns

`AgentCollection`

***

### getAllActiveTasks()

> **getAllActiveTasks**(): [`TaskState`](../interfaces/TaskState.md)[]

Defined in: [src/lib/core/ADCPMultiAgentClient.ts:740](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ADCPMultiAgentClient.ts#L740)

Get all active tasks across all agents

#### Returns

[`TaskState`](../interfaces/TaskState.md)[]

***

### listAllTasks()

> **listAllTasks**(): `Promise`\<`TaskInfo`[]\>

Defined in: [src/lib/core/ADCPMultiAgentClient.ts:761](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ADCPMultiAgentClient.ts#L761)

Get all tasks from all agents with detailed information

#### Returns

`Promise`\<`TaskInfo`[]\>

Promise resolving to array of all tasks across agents

#### Example

```typescript
const allTasks = await client.listAllTasks();
console.log(`Total active tasks: ${allTasks.length}`);
```

***

### listTasksForAgents()

> **listTasksForAgents**(`agentIds`): `Promise`\<`TaskInfo`[]\>

Defined in: [src/lib/core/ADCPMultiAgentClient.ts:773](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ADCPMultiAgentClient.ts#L773)

Get tasks for specific agents

#### Parameters

##### agentIds

`string`[]

Array of agent IDs to get tasks for

#### Returns

`Promise`\<`TaskInfo`[]\>

Promise resolving to array of tasks from specified agents

***

### getTaskInfo()

> **getTaskInfo**(`taskId`): `Promise`\<`null` \| `TaskInfo`\>

Defined in: [src/lib/core/ADCPMultiAgentClient.ts:788](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ADCPMultiAgentClient.ts#L788)

Get task information by ID from any agent

#### Parameters

##### taskId

`string`

ID of the task to find

#### Returns

`Promise`\<`null` \| `TaskInfo`\>

Promise resolving to task information or null if not found

***

### onTaskEvents()

> **onTaskEvents**(`callbacks`): () => `void`

Defined in: [src/lib/core/ADCPMultiAgentClient.ts:816](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ADCPMultiAgentClient.ts#L816)

Subscribe to task events from all agents

#### Parameters

##### callbacks

Event callbacks for different task events

###### onTaskCreated?

(`task`) => `void`

###### onTaskUpdated?

(`task`) => `void`

###### onTaskCompleted?

(`task`) => `void`

###### onTaskFailed?

(`task`, `error`) => `void`

#### Returns

Unsubscribe function that removes all subscriptions

> (): `void`

##### Returns

`void`

#### Example

```typescript
const unsubscribe = client.onTaskEvents({
  onTaskCompleted: (task) => {
    console.log(`Task ${task.taskName} completed!`);
  },
  onTaskFailed: (task, error) => {
    console.error(`Task ${task.taskName} failed:`, error);
  }
});
```

***

### onAnyTaskUpdate()

> **onAnyTaskUpdate**(`callback`): () => `void`

Defined in: [src/lib/core/ADCPMultiAgentClient.ts:840](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ADCPMultiAgentClient.ts#L840)

Subscribe to task updates from all agents

#### Parameters

##### callback

(`task`) => `void`

Function to call when any task status changes

#### Returns

Unsubscribe function

> (): `void`

##### Returns

`void`

***

### registerWebhooksForAll()

> **registerWebhooksForAll**(`webhookUrl`, `taskTypes?`): `Promise`\<`void`\>

Defined in: [src/lib/core/ADCPMultiAgentClient.ts:859](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ADCPMultiAgentClient.ts#L859)

Register webhooks for all agents

#### Parameters

##### webhookUrl

`string`

Base webhook URL (will append agent ID)

##### taskTypes?

`string`[]

Optional array of task types to watch

#### Returns

`Promise`\<`void`\>

***

### unregisterAllWebhooks()

> **unregisterAllWebhooks**(): `Promise`\<`void`\>

Defined in: [src/lib/core/ADCPMultiAgentClient.ts:869](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ADCPMultiAgentClient.ts#L869)

Unregister webhooks for all agents

#### Returns

`Promise`\<`void`\>

***

### getTaskCountsByStatus()

> **getTaskCountsByStatus**(): `Promise`\<`Record`\<`string`, `number`\>\>

Defined in: [src/lib/core/ADCPMultiAgentClient.ts:885](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ADCPMultiAgentClient.ts#L885)

Get count of active tasks by status

#### Returns

`Promise`\<`Record`\<`string`, `number`\>\>

Promise resolving to object with counts by status

#### Example

```typescript
const counts = await client.getTaskCountsByStatus();
console.log(`Working: ${counts.working}, Completed: ${counts.completed}`);
```

***

### getWebhookUrl()

> **getWebhookUrl**(`agentId`, `taskType`, `operationId`): `string`

Defined in: [src/lib/core/ADCPMultiAgentClient.ts:912](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ADCPMultiAgentClient.ts#L912)

Generate webhook URL for a specific agent, task type, and operation

#### Parameters

##### agentId

`string`

ID of the agent

##### taskType

`string`

Type of task (e.g., 'get_products', 'media_buy_delivery')

##### operationId

`string`

Operation ID for this request

#### Returns

`string`

Full webhook URL with macros replaced

#### Example

```typescript
const webhookUrl = client.getWebhookUrl('agent1', 'sync_creatives', 'op_123');
// Returns: https://myapp.com/webhook/sync_creatives/agent1/op_123
```

***

### handleWebhook()

> **handleWebhook**(`payload`, `signature?`, `timestamp?`): `Promise`\<`boolean`\>

Defined in: [src/lib/core/ADCPMultiAgentClient.ts:942](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ADCPMultiAgentClient.ts#L942)

Handle webhook from any agent (async task completion or notifications)

Automatically routes webhook to the correct agent based on agent_id in payload.

#### Parameters

##### payload

`any`

Webhook payload from agent (must contain agent_id or operation_id)

##### signature?

`string`

Optional signature for verification (X-ADCP-Signature)

##### timestamp?

Optional timestamp for verification (X-ADCP-Timestamp)

`string` | `number`

#### Returns

`Promise`\<`boolean`\>

Whether webhook was handled successfully

#### Example

```typescript
app.post('/webhook', async (req, res) => {
  const signature = req.headers['x-adcp-signature'];
  const timestamp = req.headers['x-adcp-timestamp'];

  try {
    const handled = await client.handleWebhook(req.body, signature, timestamp);
    res.status(200).json({ received: handled });
  } catch (error) {
    res.status(401).json({ error: error.message });
  }
});
```

***

### createCreativeAgent()

> **createCreativeAgent**(`agentUrl`, `protocol`, `authToken?`): [`CreativeAgentClient`](CreativeAgentClient.md)

Defined in: [src/lib/core/ADCPMultiAgentClient.ts:1002](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ADCPMultiAgentClient.ts#L1002)

Create a creative agent client

#### Parameters

##### agentUrl

`string`

URL of the creative agent

##### protocol

Protocol to use (defaults to 'mcp')

`"mcp"` | `"a2a"`

##### authToken?

`string`

Optional authentication token

#### Returns

[`CreativeAgentClient`](CreativeAgentClient.md)

CreativeAgentClient instance

#### Example

```typescript
// Use standard creative agent
const creativeAgent = client.createCreativeAgent(
  'https://creative.adcontextprotocol.org/mcp'
);

// List formats
const formats = await creativeAgent.listFormats();
```

***

### getStandardCreativeAgent()

> **getStandardCreativeAgent**(`protocol`): [`CreativeAgentClient`](CreativeAgentClient.md)

Defined in: [src/lib/core/ADCPMultiAgentClient.ts:1023](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ADCPMultiAgentClient.ts#L1023)

Get the standard AdCP creative agent

#### Parameters

##### protocol

Protocol to use (defaults to 'mcp')

`"mcp"` | `"a2a"`

#### Returns

[`CreativeAgentClient`](CreativeAgentClient.md)

CreativeAgentClient instance for standard agent

#### Example

```typescript
const creativeAgent = client.getStandardCreativeAgent();
const formats = await creativeAgent.listFormats();
```

***

### discoverFormats()

> **discoverFormats**(): `Promise`\<[`CreativeFormat`](../interfaces/CreativeFormat.md)[]\>

Defined in: [src/lib/core/ADCPMultiAgentClient.ts:1045](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ADCPMultiAgentClient.ts#L1045)

Discover creative formats from standard creative agent

Convenience method to quickly get formats from the standard AdCP creative agent

#### Returns

`Promise`\<[`CreativeFormat`](../interfaces/CreativeFormat.md)[]\>

Promise resolving to array of creative formats

#### Example

```typescript
const formats = await client.discoverFormats();

// Find specific format
const banner = formats.find(f => f.format_id.id === 'display_300x250_image');
```

***

### findFormatsByType()

> **findFormatsByType**(`type`): `Promise`\<[`CreativeFormat`](../interfaces/CreativeFormat.md)[]\>

Defined in: [src/lib/core/ADCPMultiAgentClient.ts:1062](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ADCPMultiAgentClient.ts#L1062)

Find creative formats by type

#### Parameters

##### type

Format type to filter by

`"video"` | `"audio"` | `"dooh"` | `"native"` | `"display"` | `"rich_media"` | `"universal"`

#### Returns

`Promise`\<[`CreativeFormat`](../interfaces/CreativeFormat.md)[]\>

Promise resolving to matching formats

#### Example

```typescript
const videoFormats = await client.findFormatsByType('video');
const displayFormats = await client.findFormatsByType('display');
```

***

### findFormatsByDimensions()

> **findFormatsByDimensions**(`width`, `height`): `Promise`\<[`CreativeFormat`](../interfaces/CreativeFormat.md)[]\>

Defined in: [src/lib/core/ADCPMultiAgentClient.ts:1082](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ADCPMultiAgentClient.ts#L1082)

Find creative formats by dimensions

#### Parameters

##### width

`number`

Width in pixels

##### height

`number`

Height in pixels

#### Returns

`Promise`\<[`CreativeFormat`](../interfaces/CreativeFormat.md)[]\>

Promise resolving to matching formats

#### Example

```typescript
// Find all 300x250 formats
const mediumRectangles = await client.findFormatsByDimensions(300, 250);
```
