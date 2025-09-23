[**@adcp/client API Reference v2.0.0**](../README.md)

***

[@adcp/client API Reference](../README.md) / AgentClient

# Class: AgentClient

Defined in: [src/lib/core/AgentClient.ts:42](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/core/AgentClient.ts#L42)

Per-agent client that maintains conversation context across calls

This wrapper provides a persistent conversation context for a single agent,
making it easy to have multi-turn conversations and maintain state.

## Constructors

### Constructor

> **new AgentClient**(`agent`, `config`): `AgentClient`

Defined in: [src/lib/core/AgentClient.ts:46](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/core/AgentClient.ts#L46)

#### Parameters

##### agent

[`AgentConfig`](../interfaces/AgentConfig.md)

##### config

[`ADCPClientConfig`](../interfaces/ADCPClientConfig.md) = `{}`

#### Returns

`AgentClient`

## Methods

### getProducts()

> **getProducts**(`params`, `inputHandler?`, `options?`): `Promise`\<[`TaskResult`](../interfaces/TaskResult.md)\<[`GetProductsResponse`](../interfaces/GetProductsResponse.md)\>\>

Defined in: [src/lib/core/AgentClient.ts:58](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/core/AgentClient.ts#L58)

Discover available advertising products

#### Parameters

##### params

[`GetProductsRequest`](../interfaces/GetProductsRequest.md)

##### inputHandler?

[`InputHandler`](../type-aliases/InputHandler.md)

##### options?

[`TaskOptions`](../interfaces/TaskOptions.md)

#### Returns

`Promise`\<[`TaskResult`](../interfaces/TaskResult.md)\<[`GetProductsResponse`](../interfaces/GetProductsResponse.md)\>\>

***

### listCreativeFormats()

> **listCreativeFormats**(`params`, `inputHandler?`, `options?`): `Promise`\<[`TaskResult`](../interfaces/TaskResult.md)\<[`ListCreativeFormatsResponse`](../interfaces/ListCreativeFormatsResponse.md)\>\>

Defined in: [src/lib/core/AgentClient.ts:79](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/core/AgentClient.ts#L79)

List available creative formats

#### Parameters

##### params

[`ListCreativeFormatsRequest`](../interfaces/ListCreativeFormatsRequest.md)

##### inputHandler?

[`InputHandler`](../type-aliases/InputHandler.md)

##### options?

[`TaskOptions`](../interfaces/TaskOptions.md)

#### Returns

`Promise`\<[`TaskResult`](../interfaces/TaskResult.md)\<[`ListCreativeFormatsResponse`](../interfaces/ListCreativeFormatsResponse.md)\>\>

***

### createMediaBuy()

> **createMediaBuy**(`params`, `inputHandler?`, `options?`): `Promise`\<[`TaskResult`](../interfaces/TaskResult.md)\<[`CreateMediaBuyResponse`](../interfaces/CreateMediaBuyResponse.md)\>\>

Defined in: [src/lib/core/AgentClient.ts:100](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/core/AgentClient.ts#L100)

Create a new media buy

#### Parameters

##### params

[`CreateMediaBuyRequest`](../interfaces/CreateMediaBuyRequest.md)

##### inputHandler?

[`InputHandler`](../type-aliases/InputHandler.md)

##### options?

[`TaskOptions`](../interfaces/TaskOptions.md)

#### Returns

`Promise`\<[`TaskResult`](../interfaces/TaskResult.md)\<[`CreateMediaBuyResponse`](../interfaces/CreateMediaBuyResponse.md)\>\>

***

### updateMediaBuy()

> **updateMediaBuy**(`params`, `inputHandler?`, `options?`): `Promise`\<[`TaskResult`](../interfaces/TaskResult.md)\<[`UpdateMediaBuyResponse`](../interfaces/UpdateMediaBuyResponse.md)\>\>

Defined in: [src/lib/core/AgentClient.ts:121](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/core/AgentClient.ts#L121)

Update an existing media buy

#### Parameters

##### params

[`UpdateMediaBuyRequest`](../type-aliases/UpdateMediaBuyRequest.md)

##### inputHandler?

[`InputHandler`](../type-aliases/InputHandler.md)

##### options?

[`TaskOptions`](../interfaces/TaskOptions.md)

#### Returns

`Promise`\<[`TaskResult`](../interfaces/TaskResult.md)\<[`UpdateMediaBuyResponse`](../interfaces/UpdateMediaBuyResponse.md)\>\>

***

### syncCreatives()

> **syncCreatives**(`params`, `inputHandler?`, `options?`): `Promise`\<[`TaskResult`](../interfaces/TaskResult.md)\<[`SyncCreativesResponse`](../interfaces/SyncCreativesResponse.md)\>\>

Defined in: [src/lib/core/AgentClient.ts:142](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/core/AgentClient.ts#L142)

Sync creative assets

#### Parameters

##### params

[`SyncCreativesRequest`](../interfaces/SyncCreativesRequest.md)

##### inputHandler?

[`InputHandler`](../type-aliases/InputHandler.md)

##### options?

[`TaskOptions`](../interfaces/TaskOptions.md)

#### Returns

`Promise`\<[`TaskResult`](../interfaces/TaskResult.md)\<[`SyncCreativesResponse`](../interfaces/SyncCreativesResponse.md)\>\>

***

### listCreatives()

> **listCreatives**(`params`, `inputHandler?`, `options?`): `Promise`\<[`TaskResult`](../interfaces/TaskResult.md)\<[`ListCreativesResponse`](../interfaces/ListCreativesResponse.md)\>\>

Defined in: [src/lib/core/AgentClient.ts:163](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/core/AgentClient.ts#L163)

List creative assets

#### Parameters

##### params

[`ListCreativesRequest`](../interfaces/ListCreativesRequest.md)

##### inputHandler?

[`InputHandler`](../type-aliases/InputHandler.md)

##### options?

[`TaskOptions`](../interfaces/TaskOptions.md)

#### Returns

`Promise`\<[`TaskResult`](../interfaces/TaskResult.md)\<[`ListCreativesResponse`](../interfaces/ListCreativesResponse.md)\>\>

***

### getMediaBuyDelivery()

> **getMediaBuyDelivery**(`params`, `inputHandler?`, `options?`): `Promise`\<[`TaskResult`](../interfaces/TaskResult.md)\<[`GetMediaBuyDeliveryResponse`](../interfaces/GetMediaBuyDeliveryResponse.md)\>\>

Defined in: [src/lib/core/AgentClient.ts:184](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/core/AgentClient.ts#L184)

Get media buy delivery information

#### Parameters

##### params

[`GetMediaBuyDeliveryRequest`](../interfaces/GetMediaBuyDeliveryRequest.md)

##### inputHandler?

[`InputHandler`](../type-aliases/InputHandler.md)

##### options?

[`TaskOptions`](../interfaces/TaskOptions.md)

#### Returns

`Promise`\<[`TaskResult`](../interfaces/TaskResult.md)\<[`GetMediaBuyDeliveryResponse`](../interfaces/GetMediaBuyDeliveryResponse.md)\>\>

***

### listAuthorizedProperties()

> **listAuthorizedProperties**(`params`, `inputHandler?`, `options?`): `Promise`\<[`TaskResult`](../interfaces/TaskResult.md)\<[`ListAuthorizedPropertiesResponse`](../interfaces/ListAuthorizedPropertiesResponse.md)\>\>

Defined in: [src/lib/core/AgentClient.ts:205](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/core/AgentClient.ts#L205)

List authorized properties

#### Parameters

##### params

[`ListAuthorizedPropertiesRequest`](../interfaces/ListAuthorizedPropertiesRequest.md)

##### inputHandler?

[`InputHandler`](../type-aliases/InputHandler.md)

##### options?

[`TaskOptions`](../interfaces/TaskOptions.md)

#### Returns

`Promise`\<[`TaskResult`](../interfaces/TaskResult.md)\<[`ListAuthorizedPropertiesResponse`](../interfaces/ListAuthorizedPropertiesResponse.md)\>\>

***

### providePerformanceFeedback()

> **providePerformanceFeedback**(`params`, `inputHandler?`, `options?`): `Promise`\<[`TaskResult`](../interfaces/TaskResult.md)\<[`ProvidePerformanceFeedbackResponse`](../interfaces/ProvidePerformanceFeedbackResponse.md)\>\>

Defined in: [src/lib/core/AgentClient.ts:226](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/core/AgentClient.ts#L226)

Provide performance feedback

#### Parameters

##### params

[`ProvidePerformanceFeedbackRequest`](../interfaces/ProvidePerformanceFeedbackRequest.md)

##### inputHandler?

[`InputHandler`](../type-aliases/InputHandler.md)

##### options?

[`TaskOptions`](../interfaces/TaskOptions.md)

#### Returns

`Promise`\<[`TaskResult`](../interfaces/TaskResult.md)\<[`ProvidePerformanceFeedbackResponse`](../interfaces/ProvidePerformanceFeedbackResponse.md)\>\>

***

### getSignals()

> **getSignals**(`params`, `inputHandler?`, `options?`): `Promise`\<[`TaskResult`](../interfaces/TaskResult.md)\<[`GetSignalsResponse`](../interfaces/GetSignalsResponse.md)\>\>

Defined in: [src/lib/core/AgentClient.ts:249](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/core/AgentClient.ts#L249)

Get audience signals

#### Parameters

##### params

[`GetSignalsRequest`](../interfaces/GetSignalsRequest.md)

##### inputHandler?

[`InputHandler`](../type-aliases/InputHandler.md)

##### options?

[`TaskOptions`](../interfaces/TaskOptions.md)

#### Returns

`Promise`\<[`TaskResult`](../interfaces/TaskResult.md)\<[`GetSignalsResponse`](../interfaces/GetSignalsResponse.md)\>\>

***

### activateSignal()

> **activateSignal**(`params`, `inputHandler?`, `options?`): `Promise`\<[`TaskResult`](../interfaces/TaskResult.md)\<[`ActivateSignalResponse`](../interfaces/ActivateSignalResponse.md)\>\>

Defined in: [src/lib/core/AgentClient.ts:270](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/core/AgentClient.ts#L270)

Activate audience signals

#### Parameters

##### params

[`ActivateSignalRequest`](../interfaces/ActivateSignalRequest.md)

##### inputHandler?

[`InputHandler`](../type-aliases/InputHandler.md)

##### options?

[`TaskOptions`](../interfaces/TaskOptions.md)

#### Returns

`Promise`\<[`TaskResult`](../interfaces/TaskResult.md)\<[`ActivateSignalResponse`](../interfaces/ActivateSignalResponse.md)\>\>

***

### continueConversation()

> **continueConversation**\<`T`\>(`message`, `inputHandler?`, `options?`): `Promise`\<[`TaskResult`](../interfaces/TaskResult.md)\<`T`\>\>

Defined in: [src/lib/core/AgentClient.ts:307](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/core/AgentClient.ts#L307)

Continue the conversation with a natural language message

#### Type Parameters

##### T

`T` = `any`

#### Parameters

##### message

`string`

Natural language message to send to the agent

##### inputHandler?

[`InputHandler`](../type-aliases/InputHandler.md)

Handler for any clarification requests

##### options?

[`TaskOptions`](../interfaces/TaskOptions.md)

#### Returns

`Promise`\<[`TaskResult`](../interfaces/TaskResult.md)\<`T`\>\>

#### Example

```typescript
const agent = multiClient.agent('my-agent');
await agent.getProducts({ brief: 'Tech products' });

// Continue the conversation
const refined = await agent.continueConversation(
  'Focus only on laptops under $1000'
);
```

***

### getHistory()

> **getHistory**(): `undefined` \| [`Message`](../interfaces/Message.md)[]

Defined in: [src/lib/core/AgentClient.ts:332](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/core/AgentClient.ts#L332)

Get the full conversation history

#### Returns

`undefined` \| [`Message`](../interfaces/Message.md)[]

***

### clearContext()

> **clearContext**(): `void`

Defined in: [src/lib/core/AgentClient.ts:342](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/core/AgentClient.ts#L342)

Clear the conversation context (start fresh)

#### Returns

`void`

***

### getContextId()

> **getContextId**(): `undefined` \| `string`

Defined in: [src/lib/core/AgentClient.ts:352](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/core/AgentClient.ts#L352)

Get the current conversation context ID

#### Returns

`undefined` \| `string`

***

### setContextId()

> **setContextId**(`contextId`): `void`

Defined in: [src/lib/core/AgentClient.ts:359](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/core/AgentClient.ts#L359)

Set a specific conversation context ID

#### Parameters

##### contextId

`string`

#### Returns

`void`

***

### getAgent()

> **getAgent**(): [`AgentConfig`](../interfaces/AgentConfig.md)

Defined in: [src/lib/core/AgentClient.ts:368](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/core/AgentClient.ts#L368)

Get the agent configuration

#### Returns

[`AgentConfig`](../interfaces/AgentConfig.md)

***

### getAgentId()

> **getAgentId**(): `string`

Defined in: [src/lib/core/AgentClient.ts:375](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/core/AgentClient.ts#L375)

Get the agent ID

#### Returns

`string`

***

### getAgentName()

> **getAgentName**(): `string`

Defined in: [src/lib/core/AgentClient.ts:382](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/core/AgentClient.ts#L382)

Get the agent name

#### Returns

`string`

***

### getProtocol()

> **getProtocol**(): `"mcp"` \| `"a2a"`

Defined in: [src/lib/core/AgentClient.ts:389](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/core/AgentClient.ts#L389)

Get the agent protocol

#### Returns

`"mcp"` \| `"a2a"`

***

### hasActiveConversation()

> **hasActiveConversation**(): `boolean`

Defined in: [src/lib/core/AgentClient.ts:396](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/core/AgentClient.ts#L396)

Check if there's an active conversation

#### Returns

`boolean`

***

### getActiveTasks()

> **getActiveTasks**(): [`TaskState`](../interfaces/TaskState.md)[]

Defined in: [src/lib/core/AgentClient.ts:403](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/core/AgentClient.ts#L403)

Get active tasks for this agent

#### Returns

[`TaskState`](../interfaces/TaskState.md)[]

***

### executeTask()

> **executeTask**\<`T`\>(`taskName`, `params`, `inputHandler?`, `options?`): `Promise`\<[`TaskResult`](../interfaces/TaskResult.md)\<`T`\>\>

Defined in: [src/lib/core/AgentClient.ts:412](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/core/AgentClient.ts#L412)

Execute any task by name, maintaining conversation context

#### Type Parameters

##### T

`T` = `any`

#### Parameters

##### taskName

`string`

##### params

`any`

##### inputHandler?

[`InputHandler`](../type-aliases/InputHandler.md)

##### options?

[`TaskOptions`](../interfaces/TaskOptions.md)

#### Returns

`Promise`\<[`TaskResult`](../interfaces/TaskResult.md)\<`T`\>\>
