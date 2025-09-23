[**@adcp/client API Reference v2.0.0**](../README.md)

***

[@adcp/client API Reference](../README.md) / ADCPClient

# Class: ADCPClient

Defined in: [src/lib/core/ADCPClient.ts:63](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/core/ADCPClient.ts#L63)

Main ADCP Client providing strongly-typed conversation-aware interface

This client handles individual agent interactions with full conversation context.
For multi-agent operations, use ADCPMultiAgentClient or compose multiple instances.

Key features:
- 🔒 Full type safety for all ADCP tasks
- 💬 Conversation management with context preservation  
- 🔄 Input handler pattern for clarifications
- ⏱️ Timeout and retry support
- 🐛 Debug logging and observability
- 🎯 Works with both MCP and A2A protocols

## Constructors

### Constructor

> **new ADCPClient**(`agent`, `config`): `ADCPClient`

Defined in: [src/lib/core/ADCPClient.ts:66](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/core/ADCPClient.ts#L66)

#### Parameters

##### agent

[`AgentConfig`](../interfaces/AgentConfig.md)

##### config

[`ADCPClientConfig`](../interfaces/ADCPClientConfig.md) = `{}`

#### Returns

`ADCPClient`

## Methods

### getProducts()

> **getProducts**(`params`, `inputHandler?`, `options?`): `Promise`\<[`TaskResult`](../interfaces/TaskResult.md)\<[`GetProductsResponse`](../interfaces/GetProductsResponse.md)\>\>

Defined in: [src/lib/core/ADCPClient.ts:100](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/core/ADCPClient.ts#L100)

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

Defined in: [src/lib/core/ADCPClient.ts:121](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/core/ADCPClient.ts#L121)

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

> **createMediaBuy**(`params`, `inputHandler?`, `options?`): `Promise`\<[`TaskResult`](../interfaces/TaskResult.md)\<[`CreateMediaBuyResponse`](../interfaces/CreateMediaBuyResponse.md)\>\>

Defined in: [src/lib/core/ADCPClient.ts:142](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/core/ADCPClient.ts#L142)

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

`Promise`\<[`TaskResult`](../interfaces/TaskResult.md)\<[`CreateMediaBuyResponse`](../interfaces/CreateMediaBuyResponse.md)\>\>

***

### updateMediaBuy()

> **updateMediaBuy**(`params`, `inputHandler?`, `options?`): `Promise`\<[`TaskResult`](../interfaces/TaskResult.md)\<[`UpdateMediaBuyResponse`](../interfaces/UpdateMediaBuyResponse.md)\>\>

Defined in: [src/lib/core/ADCPClient.ts:163](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/core/ADCPClient.ts#L163)

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

`Promise`\<[`TaskResult`](../interfaces/TaskResult.md)\<[`UpdateMediaBuyResponse`](../interfaces/UpdateMediaBuyResponse.md)\>\>

***

### syncCreatives()

> **syncCreatives**(`params`, `inputHandler?`, `options?`): `Promise`\<[`TaskResult`](../interfaces/TaskResult.md)\<[`SyncCreativesResponse`](../interfaces/SyncCreativesResponse.md)\>\>

Defined in: [src/lib/core/ADCPClient.ts:184](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/core/ADCPClient.ts#L184)

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

`Promise`\<[`TaskResult`](../interfaces/TaskResult.md)\<[`SyncCreativesResponse`](../interfaces/SyncCreativesResponse.md)\>\>

***

### listCreatives()

> **listCreatives**(`params`, `inputHandler?`, `options?`): `Promise`\<[`TaskResult`](../interfaces/TaskResult.md)\<[`ListCreativesResponse`](../interfaces/ListCreativesResponse.md)\>\>

Defined in: [src/lib/core/ADCPClient.ts:205](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/core/ADCPClient.ts#L205)

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

### getMediaBuyDelivery()

> **getMediaBuyDelivery**(`params`, `inputHandler?`, `options?`): `Promise`\<[`TaskResult`](../interfaces/TaskResult.md)\<[`GetMediaBuyDeliveryResponse`](../interfaces/GetMediaBuyDeliveryResponse.md)\>\>

Defined in: [src/lib/core/ADCPClient.ts:226](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/core/ADCPClient.ts#L226)

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

Defined in: [src/lib/core/ADCPClient.ts:247](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/core/ADCPClient.ts#L247)

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

> **providePerformanceFeedback**(`params`, `inputHandler?`, `options?`): `Promise`\<[`TaskResult`](../interfaces/TaskResult.md)\<[`ProvidePerformanceFeedbackResponse`](../interfaces/ProvidePerformanceFeedbackResponse.md)\>\>

Defined in: [src/lib/core/ADCPClient.ts:268](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/core/ADCPClient.ts#L268)

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

`Promise`\<[`TaskResult`](../interfaces/TaskResult.md)\<[`ProvidePerformanceFeedbackResponse`](../interfaces/ProvidePerformanceFeedbackResponse.md)\>\>

***

### getSignals()

> **getSignals**(`params`, `inputHandler?`, `options?`): `Promise`\<[`TaskResult`](../interfaces/TaskResult.md)\<[`GetSignalsResponse`](../interfaces/GetSignalsResponse.md)\>\>

Defined in: [src/lib/core/ADCPClient.ts:291](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/core/ADCPClient.ts#L291)

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

> **activateSignal**(`params`, `inputHandler?`, `options?`): `Promise`\<[`TaskResult`](../interfaces/TaskResult.md)\<[`ActivateSignalResponse`](../interfaces/ActivateSignalResponse.md)\>\>

Defined in: [src/lib/core/ADCPClient.ts:312](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/core/ADCPClient.ts#L312)

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

`Promise`\<[`TaskResult`](../interfaces/TaskResult.md)\<[`ActivateSignalResponse`](../interfaces/ActivateSignalResponse.md)\>\>

***

### executeTask()

> **executeTask**\<`T`\>(`taskName`, `params`, `inputHandler?`, `options?`): `Promise`\<[`TaskResult`](../interfaces/TaskResult.md)\<`T`\>\>

Defined in: [src/lib/core/ADCPClient.ts:345](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/core/ADCPClient.ts#L345)

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

Defined in: [src/lib/core/ADCPClient.ts:383](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/core/ADCPClient.ts#L383)

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

Defined in: [src/lib/core/ADCPClient.ts:414](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/core/ADCPClient.ts#L414)

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

Defined in: [src/lib/core/ADCPClient.ts:431](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/core/ADCPClient.ts#L431)

Get conversation history for a task

#### Parameters

##### taskId

`string`

#### Returns

`undefined` \| [`Message`](../interfaces/Message.md)[]

***

### clearConversationHistory()

> **clearConversationHistory**(`taskId`): `void`

Defined in: [src/lib/core/ADCPClient.ts:438](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/core/ADCPClient.ts#L438)

Clear conversation history for a task

#### Parameters

##### taskId

`string`

#### Returns

`void`

***

### getAgent()

> **getAgent**(): [`AgentConfig`](../interfaces/AgentConfig.md)

Defined in: [src/lib/core/ADCPClient.ts:447](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/core/ADCPClient.ts#L447)

Get the agent configuration

#### Returns

[`AgentConfig`](../interfaces/AgentConfig.md)

***

### getAgentId()

> **getAgentId**(): `string`

Defined in: [src/lib/core/ADCPClient.ts:454](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/core/ADCPClient.ts#L454)

Get the agent ID

#### Returns

`string`

***

### getAgentName()

> **getAgentName**(): `string`

Defined in: [src/lib/core/ADCPClient.ts:461](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/core/ADCPClient.ts#L461)

Get the agent name

#### Returns

`string`

***

### getProtocol()

> **getProtocol**(): `"mcp"` \| `"a2a"`

Defined in: [src/lib/core/ADCPClient.ts:468](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/core/ADCPClient.ts#L468)

Get the agent protocol

#### Returns

`"mcp"` \| `"a2a"`

***

### getActiveTasks()

> **getActiveTasks**(): [`TaskState`](../interfaces/TaskState.md)[]

Defined in: [src/lib/core/ADCPClient.ts:475](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/core/ADCPClient.ts#L475)

Get active tasks for this agent

#### Returns

[`TaskState`](../interfaces/TaskState.md)[]
