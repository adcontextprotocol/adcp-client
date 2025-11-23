[**@adcp/client API Reference v3.1.0**](../README.md)

***

[@adcp/client API Reference](../globals.md) / SingleAgentClient

# Class: SingleAgentClient

Defined in: [src/lib/core/SingleAgentClient.ts:112](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/SingleAgentClient.ts#L112)

Internal single-agent client implementation

This is an internal implementation detail used by AgentClient and ADCPMultiAgentClient.
External users should use AdCPClient (alias for ADCPMultiAgentClient) instead.

Key features:
- 🔒 Full type safety for all ADCP tasks
- 💬 Conversation management with context preservation
- 🔄 Input handler pattern for clarifications
- ⏱️ Timeout and retry support
- 🐛 Debug logging and observability
- 🎯 Works with both MCP and A2A protocols

## Constructors

### Constructor

> **new SingleAgentClient**(`agent`, `config`): `SingleAgentClient`

Defined in: [src/lib/core/SingleAgentClient.ts:118](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/SingleAgentClient.ts#L118)

#### Parameters

##### agent

[`AgentConfig`](../interfaces/AgentConfig.md)

##### config

[`SingleAgentClientConfig`](../interfaces/SingleAgentClientConfig.md) = `{}`

#### Returns

`SingleAgentClient`

## Methods

### handleWebhook()

> **handleWebhook**(`payload`, `signature?`, `timestamp?`): `Promise`\<`boolean`\>

Defined in: [src/lib/core/SingleAgentClient.ts:298](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/SingleAgentClient.ts#L298)

Handle webhook from agent (async task completion)

#### Parameters

##### payload

[`WebhookPayload`](../interfaces/WebhookPayload.md)

Webhook payload from agent

##### signature?

`string`

X-ADCP-Signature header (format: "sha256=...")

##### timestamp?

X-ADCP-Timestamp header (Unix timestamp)

`string` | `number`

#### Returns

`Promise`\<`boolean`\>

Whether webhook was handled successfully

#### Example

```typescript
app.post('/webhook', async (req, res) => {
  const signature = req.headers['x-adcp-signature'];
  const timestamp = req.headers['x-adcp-timestamp'];

  try *     const handled = await client.handleWebhook(req.body, signature, timestamp);
    res.status(200).json({ received: handled });
  } catch (error) {
    res.status(401).json({ error: error.message });
  }
});
```

***

### getWebhookUrl()

> **getWebhookUrl**(`taskType`, `operationId`): `string`

Defined in: [src/lib/core/SingleAgentClient.ts:351](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/SingleAgentClient.ts#L351)

Generate webhook URL using macro substitution

#### Parameters

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
// With template: "https://myapp.com/webhook/{task_type}/{agent_id}/{operation_id}"
const webhookUrl = client.getWebhookUrl('sync_creatives', 'op_123');
// Returns: https://myapp.com/webhook/sync_creatives/agent_x/op_123

// With template: "https://myapp.com/webhook?agent={agent_id}&op={operation_id}"
const webhookUrl = client.getWebhookUrl('sync_creatives', 'op_123');
// Returns: https://myapp.com/webhook?agent=agent_x&op=op_123
```

***

### createWebhookHandler()

> **createWebhookHandler**(): (`req`, `res`) => `Promise`\<`void`\>

Defined in: [src/lib/core/SingleAgentClient.ts:393](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/SingleAgentClient.ts#L393)

Create an HTTP webhook handler that automatically verifies signatures

This helper creates a standard HTTP handler (Express/Next.js/etc.) that:
- Extracts X-ADCP-Signature and X-ADCP-Timestamp headers
- Verifies HMAC signature (if webhookSecret configured)
- Validates timestamp freshness
- Calls handleWebhook() with proper error handling

#### Returns

HTTP handler function compatible with Express, Next.js, etc.

> (`req`, `res`): `Promise`\<`void`\>

##### Parameters

###### req

`any`

###### res

`any`

##### Returns

`Promise`\<`void`\>

#### Examples

```typescript
const client = new ADCPClient(agent, {
  webhookSecret: 'your-secret-key',
  handlers: {
    onSyncCreativesStatusChange: async (result) => {
      console.log('Creative synced:', result);
    }
  }
});

app.post('/webhook', client.createWebhookHandler());
```

```typescript
export default client.createWebhookHandler();
```

***

### verifyWebhookSignature()

> **verifyWebhookSignature**(`payload`, `signature`, `timestamp`): `boolean`

Defined in: [src/lib/core/SingleAgentClient.ts:438](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/SingleAgentClient.ts#L438)

Verify webhook signature using HMAC-SHA256 per AdCP PR #86 spec

Signature format: sha256={hex_signature}
Message format: {timestamp}.{json_payload}

#### Parameters

##### payload

`any`

Webhook payload object

##### signature

`string`

X-ADCP-Signature header value (format: "sha256=...")

##### timestamp

X-ADCP-Timestamp header value (Unix timestamp)

`string` | `number`

#### Returns

`boolean`

true if signature is valid

***

### getProducts()

> **getProducts**(`params`, `inputHandler?`, `options?`): `Promise`\<[`TaskResult`](../interfaces/TaskResult.md)\<[`GetProductsResponse`](../interfaces/GetProductsResponse.md)\>\>

Defined in: [src/lib/core/SingleAgentClient.ts:526](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/SingleAgentClient.ts#L526)

Discover available advertising products

#### Parameters

##### params

[`GetProductsRequest`](../interfaces/GetProductsRequest.md)

Product discovery parameters

##### inputHandler?

[`InputHandler`](../type-aliases/InputHandler.md)

Handler for clarification requests

##### options?

[`TaskOptions`](../interfaces/TaskOptions.md)

Task execution options

#### Returns

`Promise`\<[`TaskResult`](../interfaces/TaskResult.md)\<[`GetProductsResponse`](../interfaces/GetProductsResponse.md)\>\>

#### Example

```typescript
const products = await client.getProducts(
  {
    brief: 'Premium coffee brands for millennials',
    promoted_offering: 'Artisan coffee blends'
  },
  (context) => {
    if (context.inputRequest.field === 'budget') return 50000;
    return context.deferToHuman();
  }
);
```

***

### listCreativeFormats()

> **listCreativeFormats**(`params`, `inputHandler?`, `options?`): `Promise`\<[`TaskResult`](../interfaces/TaskResult.md)\<[`ListCreativeFormatsResponse`](../interfaces/ListCreativeFormatsResponse.md)\>\>

Defined in: [src/lib/core/SingleAgentClient.ts:547](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/SingleAgentClient.ts#L547)

List available creative formats

#### Parameters

##### params

[`ListCreativeFormatsRequest`](../interfaces/ListCreativeFormatsRequest.md)

Format listing parameters

##### inputHandler?

[`InputHandler`](../type-aliases/InputHandler.md)

Handler for clarification requests

##### options?

[`TaskOptions`](../interfaces/TaskOptions.md)

Task execution options

#### Returns

`Promise`\<[`TaskResult`](../interfaces/TaskResult.md)\<[`ListCreativeFormatsResponse`](../interfaces/ListCreativeFormatsResponse.md)\>\>

***

### createMediaBuy()

> **createMediaBuy**(`params`, `inputHandler?`, `options?`): `Promise`\<[`TaskResult`](../interfaces/TaskResult.md)\<[`CreateMediaBuyResponse`](../type-aliases/CreateMediaBuyResponse.md)\>\>

Defined in: [src/lib/core/SingleAgentClient.ts:568](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/SingleAgentClient.ts#L568)

Create a new media buy

#### Parameters

##### params

[`CreateMediaBuyRequest`](../interfaces/CreateMediaBuyRequest.md)

Media buy creation parameters

##### inputHandler?

[`InputHandler`](../type-aliases/InputHandler.md)

Handler for clarification requests

##### options?

[`TaskOptions`](../interfaces/TaskOptions.md)

Task execution options

#### Returns

`Promise`\<[`TaskResult`](../interfaces/TaskResult.md)\<[`CreateMediaBuyResponse`](../type-aliases/CreateMediaBuyResponse.md)\>\>

***

### updateMediaBuy()

> **updateMediaBuy**(`params`, `inputHandler?`, `options?`): `Promise`\<[`TaskResult`](../interfaces/TaskResult.md)\<[`UpdateMediaBuyResponse`](../type-aliases/UpdateMediaBuyResponse.md)\>\>

Defined in: [src/lib/core/SingleAgentClient.ts:611](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/SingleAgentClient.ts#L611)

Update an existing media buy

#### Parameters

##### params

[`UpdateMediaBuyRequest`](../type-aliases/UpdateMediaBuyRequest.md)

Media buy update parameters

##### inputHandler?

[`InputHandler`](../type-aliases/InputHandler.md)

Handler for clarification requests

##### options?

[`TaskOptions`](../interfaces/TaskOptions.md)

Task execution options

#### Returns

`Promise`\<[`TaskResult`](../interfaces/TaskResult.md)\<[`UpdateMediaBuyResponse`](../type-aliases/UpdateMediaBuyResponse.md)\>\>

***

### syncCreatives()

> **syncCreatives**(`params`, `inputHandler?`, `options?`): `Promise`\<[`TaskResult`](../interfaces/TaskResult.md)\<[`SyncCreativesResponse`](../type-aliases/SyncCreativesResponse.md)\>\>

Defined in: [src/lib/core/SingleAgentClient.ts:632](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/SingleAgentClient.ts#L632)

Sync creative assets

#### Parameters

##### params

[`SyncCreativesRequest`](../interfaces/SyncCreativesRequest.md)

Creative sync parameters

##### inputHandler?

[`InputHandler`](../type-aliases/InputHandler.md)

Handler for clarification requests

##### options?

[`TaskOptions`](../interfaces/TaskOptions.md)

Task execution options

#### Returns

`Promise`\<[`TaskResult`](../interfaces/TaskResult.md)\<[`SyncCreativesResponse`](../type-aliases/SyncCreativesResponse.md)\>\>

***

### listCreatives()

> **listCreatives**(`params`, `inputHandler?`, `options?`): `Promise`\<[`TaskResult`](../interfaces/TaskResult.md)\<[`ListCreativesResponse`](../interfaces/ListCreativesResponse.md)\>\>

Defined in: [src/lib/core/SingleAgentClient.ts:653](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/SingleAgentClient.ts#L653)

List creative assets

#### Parameters

##### params

[`ListCreativesRequest`](../interfaces/ListCreativesRequest.md)

Creative listing parameters

##### inputHandler?

[`InputHandler`](../type-aliases/InputHandler.md)

Handler for clarification requests

##### options?

[`TaskOptions`](../interfaces/TaskOptions.md)

Task execution options

#### Returns

`Promise`\<[`TaskResult`](../interfaces/TaskResult.md)\<[`ListCreativesResponse`](../interfaces/ListCreativesResponse.md)\>\>

***

### previewCreative()

> **previewCreative**(`params`, `inputHandler?`, `options?`): `Promise`\<[`TaskResult`](../interfaces/TaskResult.md)\<`PreviewCreativeResponse`\>\>

Defined in: [src/lib/core/SingleAgentClient.ts:674](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/SingleAgentClient.ts#L674)

Preview a creative

#### Parameters

##### params

`PreviewCreativeRequest`

Preview creative parameters

##### inputHandler?

[`InputHandler`](../type-aliases/InputHandler.md)

Handler for clarification requests

##### options?

[`TaskOptions`](../interfaces/TaskOptions.md)

Task execution options

#### Returns

`Promise`\<[`TaskResult`](../interfaces/TaskResult.md)\<`PreviewCreativeResponse`\>\>

***

### getMediaBuyDelivery()

> **getMediaBuyDelivery**(`params`, `inputHandler?`, `options?`): `Promise`\<[`TaskResult`](../interfaces/TaskResult.md)\<[`GetMediaBuyDeliveryResponse`](../interfaces/GetMediaBuyDeliveryResponse.md)\>\>

Defined in: [src/lib/core/SingleAgentClient.ts:695](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/SingleAgentClient.ts#L695)

Get media buy delivery information

#### Parameters

##### params

[`GetMediaBuyDeliveryRequest`](../interfaces/GetMediaBuyDeliveryRequest.md)

Delivery information parameters

##### inputHandler?

[`InputHandler`](../type-aliases/InputHandler.md)

Handler for clarification requests

##### options?

[`TaskOptions`](../interfaces/TaskOptions.md)

Task execution options

#### Returns

`Promise`\<[`TaskResult`](../interfaces/TaskResult.md)\<[`GetMediaBuyDeliveryResponse`](../interfaces/GetMediaBuyDeliveryResponse.md)\>\>

***

### listAuthorizedProperties()

> **listAuthorizedProperties**(`params`, `inputHandler?`, `options?`): `Promise`\<[`TaskResult`](../interfaces/TaskResult.md)\<[`ListAuthorizedPropertiesResponse`](../interfaces/ListAuthorizedPropertiesResponse.md)\>\>

Defined in: [src/lib/core/SingleAgentClient.ts:716](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/SingleAgentClient.ts#L716)

List authorized properties

#### Parameters

##### params

[`ListAuthorizedPropertiesRequest`](../interfaces/ListAuthorizedPropertiesRequest.md)

Property listing parameters

##### inputHandler?

[`InputHandler`](../type-aliases/InputHandler.md)

Handler for clarification requests

##### options?

[`TaskOptions`](../interfaces/TaskOptions.md)

Task execution options

#### Returns

`Promise`\<[`TaskResult`](../interfaces/TaskResult.md)\<[`ListAuthorizedPropertiesResponse`](../interfaces/ListAuthorizedPropertiesResponse.md)\>\>

***

### providePerformanceFeedback()

> **providePerformanceFeedback**(`params`, `inputHandler?`, `options?`): `Promise`\<[`TaskResult`](../interfaces/TaskResult.md)\<[`ProvidePerformanceFeedbackResponse`](../type-aliases/ProvidePerformanceFeedbackResponse.md)\>\>

Defined in: [src/lib/core/SingleAgentClient.ts:737](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/SingleAgentClient.ts#L737)

Provide performance feedback

#### Parameters

##### params

[`ProvidePerformanceFeedbackRequest`](../interfaces/ProvidePerformanceFeedbackRequest.md)

Performance feedback parameters

##### inputHandler?

[`InputHandler`](../type-aliases/InputHandler.md)

Handler for clarification requests

##### options?

[`TaskOptions`](../interfaces/TaskOptions.md)

Task execution options

#### Returns

`Promise`\<[`TaskResult`](../interfaces/TaskResult.md)\<[`ProvidePerformanceFeedbackResponse`](../type-aliases/ProvidePerformanceFeedbackResponse.md)\>\>

***

### getSignals()

> **getSignals**(`params`, `inputHandler?`, `options?`): `Promise`\<[`TaskResult`](../interfaces/TaskResult.md)\<[`GetSignalsResponse`](../interfaces/GetSignalsResponse.md)\>\>

Defined in: [src/lib/core/SingleAgentClient.ts:760](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/SingleAgentClient.ts#L760)

Get audience signals

#### Parameters

##### params

[`GetSignalsRequest`](../interfaces/GetSignalsRequest.md)

Signals request parameters

##### inputHandler?

[`InputHandler`](../type-aliases/InputHandler.md)

Handler for clarification requests

##### options?

[`TaskOptions`](../interfaces/TaskOptions.md)

Task execution options

#### Returns

`Promise`\<[`TaskResult`](../interfaces/TaskResult.md)\<[`GetSignalsResponse`](../interfaces/GetSignalsResponse.md)\>\>

***

### activateSignal()

> **activateSignal**(`params`, `inputHandler?`, `options?`): `Promise`\<[`TaskResult`](../interfaces/TaskResult.md)\<[`ActivateSignalResponse`](../type-aliases/ActivateSignalResponse.md)\>\>

Defined in: [src/lib/core/SingleAgentClient.ts:781](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/SingleAgentClient.ts#L781)

Activate audience signals

#### Parameters

##### params

[`ActivateSignalRequest`](../interfaces/ActivateSignalRequest.md)

Signal activation parameters

##### inputHandler?

[`InputHandler`](../type-aliases/InputHandler.md)

Handler for clarification requests

##### options?

[`TaskOptions`](../interfaces/TaskOptions.md)

Task execution options

#### Returns

`Promise`\<[`TaskResult`](../interfaces/TaskResult.md)\<[`ActivateSignalResponse`](../type-aliases/ActivateSignalResponse.md)\>\>

***

### executeTask()

> **executeTask**\<`T`\>(`taskName`, `params`, `inputHandler?`, `options?`): `Promise`\<[`TaskResult`](../interfaces/TaskResult.md)\<`T`\>\>

Defined in: [src/lib/core/SingleAgentClient.ts:814](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/SingleAgentClient.ts#L814)

Execute any task by name with type safety

#### Type Parameters

##### T

`T` = `any`

#### Parameters

##### taskName

`string`

Name of the task to execute

##### params

`any`

Task parameters

##### inputHandler?

[`InputHandler`](../type-aliases/InputHandler.md)

Handler for clarification requests

##### options?

[`TaskOptions`](../interfaces/TaskOptions.md)

Task execution options

#### Returns

`Promise`\<[`TaskResult`](../interfaces/TaskResult.md)\<`T`\>\>

#### Example

```typescript
const result = await client.executeTask(
  'get_products',
  { brief: 'Coffee brands' },
  handler
);
```

***

### resumeDeferredTask()

> **resumeDeferredTask**\<`T`\>(`token`, `inputHandler`): `Promise`\<[`TaskResult`](../interfaces/TaskResult.md)\<`T`\>\>

Defined in: [src/lib/core/SingleAgentClient.ts:847](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/SingleAgentClient.ts#L847)

Resume a deferred task using its token

#### Type Parameters

##### T

`T` = `any`

#### Parameters

##### token

`string`

Deferred task token

##### inputHandler

[`InputHandler`](../type-aliases/InputHandler.md)

Handler to provide the missing input

#### Returns

`Promise`\<[`TaskResult`](../interfaces/TaskResult.md)\<`T`\>\>

#### Example

```typescript
try {
  await client.createMediaBuy(params, handler);
} catch (error) {
  if (error instanceof DeferredTaskError) {
    // Get human input and resume
    const result = await client.resumeDeferredTask(
      error.token,
      (context) => humanProvidedValue
    );
  }
}
```

***

### continueConversation()

> **continueConversation**\<`T`\>(`message`, `contextId`, `inputHandler?`): `Promise`\<[`TaskResult`](../interfaces/TaskResult.md)\<`T`\>\>

Defined in: [src/lib/core/SingleAgentClient.ts:875](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/SingleAgentClient.ts#L875)

Continue an existing conversation with the agent

#### Type Parameters

##### T

`T` = `any`

#### Parameters

##### message

`string`

Message to send to the agent

##### contextId

`string`

Conversation context ID to continue

##### inputHandler?

[`InputHandler`](../type-aliases/InputHandler.md)

Handler for any clarification requests

#### Returns

`Promise`\<[`TaskResult`](../interfaces/TaskResult.md)\<`T`\>\>

#### Example

```typescript
const agent = new ADCPClient(config);
const initial = await agent.getProducts({ brief: 'Tech products' });

// Continue the conversation
const refined = await agent.continueConversation(
  'Focus only on laptops under $1000',
  initial.metadata.taskId
);
```

***

### getConversationHistory()

> **getConversationHistory**(`taskId`): `undefined` \| [`Message`](../interfaces/Message.md)[]

Defined in: [src/lib/core/SingleAgentClient.ts:887](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/SingleAgentClient.ts#L887)

Get conversation history for a task

#### Parameters

##### taskId

`string`

#### Returns

`undefined` \| [`Message`](../interfaces/Message.md)[]

***

### clearConversationHistory()

> **clearConversationHistory**(`taskId`): `void`

Defined in: [src/lib/core/SingleAgentClient.ts:894](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/SingleAgentClient.ts#L894)

Clear conversation history for a task

#### Parameters

##### taskId

`string`

#### Returns

`void`

***

### getAgent()

> **getAgent**(): [`AgentConfig`](../interfaces/AgentConfig.md)

Defined in: [src/lib/core/SingleAgentClient.ts:903](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/SingleAgentClient.ts#L903)

Get the agent configuration

#### Returns

[`AgentConfig`](../interfaces/AgentConfig.md)

***

### getAgentId()

> **getAgentId**(): `string`

Defined in: [src/lib/core/SingleAgentClient.ts:910](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/SingleAgentClient.ts#L910)

Get the agent ID

#### Returns

`string`

***

### getAgentName()

> **getAgentName**(): `string`

Defined in: [src/lib/core/SingleAgentClient.ts:917](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/SingleAgentClient.ts#L917)

Get the agent name

#### Returns

`string`

***

### getProtocol()

> **getProtocol**(): `"mcp"` \| `"a2a"`

Defined in: [src/lib/core/SingleAgentClient.ts:924](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/SingleAgentClient.ts#L924)

Get the agent protocol

#### Returns

`"mcp"` \| `"a2a"`

***

### getActiveTasks()

> **getActiveTasks**(): [`TaskState`](../interfaces/TaskState.md)[]

Defined in: [src/lib/core/SingleAgentClient.ts:931](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/SingleAgentClient.ts#L931)

Get active tasks for this agent

#### Returns

[`TaskState`](../interfaces/TaskState.md)[]

***

### listTasks()

> **listTasks**(): `Promise`\<`TaskInfo`[]\>

Defined in: [src/lib/core/SingleAgentClient.ts:950](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/SingleAgentClient.ts#L950)

List all tasks for this agent with detailed information

#### Returns

`Promise`\<`TaskInfo`[]\>

Promise resolving to array of task information

#### Example

```typescript
const tasks = await client.listTasks();
tasks.forEach(task => {
  console.log(`${task.taskName}: ${task.status}`);
});
```

***

### getTaskInfo()

> **getTaskInfo**(`taskId`): `Promise`\<`null` \| `TaskInfo`\>

Defined in: [src/lib/core/SingleAgentClient.ts:960](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/SingleAgentClient.ts#L960)

Get detailed information about a specific task

#### Parameters

##### taskId

`string`

ID of the task to get information for

#### Returns

`Promise`\<`null` \| `TaskInfo`\>

Promise resolving to task information

***

### onTaskUpdate()

> **onTaskUpdate**(`callback`): () => `void`

Defined in: [src/lib/core/SingleAgentClient.ts:983](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/SingleAgentClient.ts#L983)

Subscribe to task notifications for this agent

#### Parameters

##### callback

(`task`) => `void`

Function to call when task status changes

#### Returns

Unsubscribe function

> (): `void`

##### Returns

`void`

#### Example

```typescript
const unsubscribe = client.onTaskUpdate((task) => {
  console.log(`Task ${task.taskName} is now ${task.status}`);
  if (task.status === 'completed') {
    // Handle completion
  }
});

// Later, stop listening
unsubscribe();
```

***

### onTaskEvents()

> **onTaskEvents**(`callbacks`): () => `void`

Defined in: [src/lib/core/SingleAgentClient.ts:993](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/SingleAgentClient.ts#L993)

Subscribe to all task events (create, update, complete, error)

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

Unsubscribe function

> (): `void`

##### Returns

`void`

***

### registerWebhook()

> **registerWebhook**(`webhookUrl`, `taskTypes?`): `Promise`\<`void`\>

Defined in: [src/lib/core/SingleAgentClient.ts:1013](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/SingleAgentClient.ts#L1013)

Register webhook URL for receiving task notifications

#### Parameters

##### webhookUrl

`string`

URL to receive webhook notifications

##### taskTypes?

`string`[]

Optional array of task types to watch (defaults to all)

#### Returns

`Promise`\<`void`\>

#### Example

```typescript
await client.registerWebhook('https://myapp.com/webhook', ['create_media_buy']);
```

***

### unregisterWebhook()

> **unregisterWebhook**(): `Promise`\<`void`\>

Defined in: [src/lib/core/SingleAgentClient.ts:1021](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/SingleAgentClient.ts#L1021)

Unregister webhook notifications

#### Returns

`Promise`\<`void`\>

***

### getAgentInfo()

> **getAgentInfo**(): `Promise`\<\{ `name`: `string`; `description?`: `string`; `protocol`: `"mcp"` \| `"a2a"`; `url`: `string`; `tools`: `object`[]; \}\>

Defined in: [src/lib/core/SingleAgentClient.ts:1048](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/SingleAgentClient.ts#L1048)

Get comprehensive agent information including name, description, and available tools/skills

Works with both MCP (tools) and A2A (skills) protocols to discover what the agent can do.

#### Returns

`Promise`\<\{ `name`: `string`; `description?`: `string`; `protocol`: `"mcp"` \| `"a2a"`; `url`: `string`; `tools`: `object`[]; \}\>

Promise resolving to agent information including tools

#### Example

```typescript
const client = new ADCPClient(agentConfig);
const info = await client.getAgentInfo();

console.log(`${info.name}: ${info.description}`);
console.log(`Supports ${info.tools.length} tools`);

info.tools.forEach(tool => {
  console.log(`  - ${tool.name}: ${tool.description}`);
});
```

***

### discoverCreativeFormats()

> `static` **discoverCreativeFormats**(`creativeAgentUrl`, `protocol`): `Promise`\<[`Format`](../interfaces/Format.md)[]\>

Defined in: [src/lib/core/SingleAgentClient.ts:1213](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/SingleAgentClient.ts#L1213)

Query a creative agent to discover available creative formats

This is a static utility method that allows you to query any creative agent
(like creative.adcontextprotocol.org) to discover what formats are available
before creating a media buy.

#### Parameters

##### creativeAgentUrl

`string`

URL of the creative agent (e.g., 'https://creative.adcontextprotocol.org/mcp')

##### protocol

Protocol to use ('mcp' or 'a2a'), defaults to 'mcp'

`"mcp"` | `"a2a"`

#### Returns

`Promise`\<[`Format`](../interfaces/Format.md)[]\>

Promise resolving to the list of available formats

#### Example

```typescript
// Discover formats from the standard creative agent
const formats = await SingleAgentClient.discoverCreativeFormats(
  'https://creative.adcontextprotocol.org/mcp'
);

// Find a specific format
const banner = formats.find(f => f.format_id.id === 'display_300x250_image');

// Use the format in a media buy
await salesAgent.createMediaBuy({
  packages: [{
    format_ids: [{
      agent_url: banner.format_id.agent_url,
      id: banner.format_id.id
    }]
  }]
});
```
