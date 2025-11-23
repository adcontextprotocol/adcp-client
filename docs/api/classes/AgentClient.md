[**@adcp/client API Reference v3.1.0**](../README.md)

***

[@adcp/client API Reference](../globals.md) / AgentClient

# Class: AgentClient

Defined in: [src/lib/core/AgentClient.ts:60](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/AgentClient.ts#L60)

Per-agent client that maintains conversation context across calls

This wrapper provides a persistent conversation context for a single agent,
making it easy to have multi-turn conversations and maintain state.

## Constructors

### Constructor

> **new AgentClient**(`agent`, `config`): `AgentClient`

Defined in: [src/lib/core/AgentClient.ts:64](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/AgentClient.ts#L64)

#### Parameters

##### agent

[`AgentConfig`](../interfaces/AgentConfig.md)

##### config

[`SingleAgentClientConfig`](../interfaces/SingleAgentClientConfig.md) = `{}`

#### Returns

`AgentClient`

## Methods

### handleWebhook()

> **handleWebhook**(`payload`, `signature?`, `timestamp?`): `Promise`\<`boolean`\>

Defined in: [src/lib/core/AgentClient.ts:79](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/AgentClient.ts#L79)

Handle webhook from agent (async task completion or notifications)

#### Parameters

##### payload

`any`

Webhook payload from agent

##### signature?

`string`

Optional signature for verification (X-ADCP-Signature)

##### timestamp?

Optional timestamp for verification (X-ADCP-Timestamp)

`string` | `number`

#### Returns

`Promise`\<`boolean`\>

Whether webhook was handled successfully

***

### getWebhookUrl()

> **getWebhookUrl**(`taskType`, `operationId`): `string`

Defined in: [src/lib/core/AgentClient.ts:90](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/AgentClient.ts#L90)

Generate webhook URL for a specific task and operation

#### Parameters

##### taskType

`string`

Type of task (e.g., 'get_products', 'media_buy_delivery')

##### operationId

`string`

Operation ID for this request

#### Returns

`string`

Full webhook URL

***

### verifyWebhookSignature()

> **verifyWebhookSignature**(`payload`, `signature`, `timestamp`): `boolean`

Defined in: [src/lib/core/AgentClient.ts:102](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/AgentClient.ts#L102)

Verify webhook signature using HMAC-SHA256 per AdCP PR #86 spec

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

Defined in: [src/lib/core/AgentClient.ts:111](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/AgentClient.ts#L111)

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

Defined in: [src/lib/core/AgentClient.ts:131](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/AgentClient.ts#L131)

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

> **createMediaBuy**(`params`, `inputHandler?`, `options?`): `Promise`\<[`TaskResult`](../interfaces/TaskResult.md)\<[`CreateMediaBuyResponse`](../type-aliases/CreateMediaBuyResponse.md)\>\>

Defined in: [src/lib/core/AgentClient.ts:151](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/AgentClient.ts#L151)

Create a new media buy

#### Parameters

##### params

[`CreateMediaBuyRequest`](../interfaces/CreateMediaBuyRequest.md)

##### inputHandler?

[`InputHandler`](../type-aliases/InputHandler.md)

##### options?

[`TaskOptions`](../interfaces/TaskOptions.md)

#### Returns

`Promise`\<[`TaskResult`](../interfaces/TaskResult.md)\<[`CreateMediaBuyResponse`](../type-aliases/CreateMediaBuyResponse.md)\>\>

***

### updateMediaBuy()

> **updateMediaBuy**(`params`, `inputHandler?`, `options?`): `Promise`\<[`TaskResult`](../interfaces/TaskResult.md)\<[`UpdateMediaBuyResponse`](../type-aliases/UpdateMediaBuyResponse.md)\>\>

Defined in: [src/lib/core/AgentClient.ts:171](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/AgentClient.ts#L171)

Update an existing media buy

#### Parameters

##### params

[`UpdateMediaBuyRequest`](../type-aliases/UpdateMediaBuyRequest.md)

##### inputHandler?

[`InputHandler`](../type-aliases/InputHandler.md)

##### options?

[`TaskOptions`](../interfaces/TaskOptions.md)

#### Returns

`Promise`\<[`TaskResult`](../interfaces/TaskResult.md)\<[`UpdateMediaBuyResponse`](../type-aliases/UpdateMediaBuyResponse.md)\>\>

***

### syncCreatives()

> **syncCreatives**(`params`, `inputHandler?`, `options?`): `Promise`\<[`TaskResult`](../interfaces/TaskResult.md)\<[`SyncCreativesResponse`](../type-aliases/SyncCreativesResponse.md)\>\>

Defined in: [src/lib/core/AgentClient.ts:191](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/AgentClient.ts#L191)

Sync creative assets

#### Parameters

##### params

[`SyncCreativesRequest`](../interfaces/SyncCreativesRequest.md)

##### inputHandler?

[`InputHandler`](../type-aliases/InputHandler.md)

##### options?

[`TaskOptions`](../interfaces/TaskOptions.md)

#### Returns

`Promise`\<[`TaskResult`](../interfaces/TaskResult.md)\<[`SyncCreativesResponse`](../type-aliases/SyncCreativesResponse.md)\>\>

***

### listCreatives()

> **listCreatives**(`params`, `inputHandler?`, `options?`): `Promise`\<[`TaskResult`](../interfaces/TaskResult.md)\<[`ListCreativesResponse`](../interfaces/ListCreativesResponse.md)\>\>

Defined in: [src/lib/core/AgentClient.ts:211](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/AgentClient.ts#L211)

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

Defined in: [src/lib/core/AgentClient.ts:231](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/AgentClient.ts#L231)

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

Defined in: [src/lib/core/AgentClient.ts:251](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/AgentClient.ts#L251)

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

> **providePerformanceFeedback**(`params`, `inputHandler?`, `options?`): `Promise`\<[`TaskResult`](../interfaces/TaskResult.md)\<[`ProvidePerformanceFeedbackResponse`](../type-aliases/ProvidePerformanceFeedbackResponse.md)\>\>

Defined in: [src/lib/core/AgentClient.ts:271](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/AgentClient.ts#L271)

Provide performance feedback

#### Parameters

##### params

[`ProvidePerformanceFeedbackRequest`](../interfaces/ProvidePerformanceFeedbackRequest.md)

##### inputHandler?

[`InputHandler`](../type-aliases/InputHandler.md)

##### options?

[`TaskOptions`](../interfaces/TaskOptions.md)

#### Returns

`Promise`\<[`TaskResult`](../interfaces/TaskResult.md)\<[`ProvidePerformanceFeedbackResponse`](../type-aliases/ProvidePerformanceFeedbackResponse.md)\>\>

***

### getSignals()

> **getSignals**(`params`, `inputHandler?`, `options?`): `Promise`\<[`TaskResult`](../interfaces/TaskResult.md)\<[`GetSignalsResponse`](../interfaces/GetSignalsResponse.md)\>\>

Defined in: [src/lib/core/AgentClient.ts:293](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/AgentClient.ts#L293)

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

> **activateSignal**(`params`, `inputHandler?`, `options?`): `Promise`\<[`TaskResult`](../interfaces/TaskResult.md)\<[`ActivateSignalResponse`](../type-aliases/ActivateSignalResponse.md)\>\>

Defined in: [src/lib/core/AgentClient.ts:310](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/AgentClient.ts#L310)

Activate audience signals

#### Parameters

##### params

[`ActivateSignalRequest`](../interfaces/ActivateSignalRequest.md)

##### inputHandler?

[`InputHandler`](../type-aliases/InputHandler.md)

##### options?

[`TaskOptions`](../interfaces/TaskOptions.md)

#### Returns

`Promise`\<[`TaskResult`](../interfaces/TaskResult.md)\<[`ActivateSignalResponse`](../type-aliases/ActivateSignalResponse.md)\>\>

***

### continueConversation()

> **continueConversation**\<`T`\>(`message`, `inputHandler?`, `options?`): `Promise`\<[`TaskResult`](../interfaces/TaskResult.md)\<`T`\>\>

Defined in: [src/lib/core/AgentClient.ts:346](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/AgentClient.ts#L346)

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

Defined in: [src/lib/core/AgentClient.ts:367](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/AgentClient.ts#L367)

Get the full conversation history

#### Returns

`undefined` \| [`Message`](../interfaces/Message.md)[]

***

### clearContext()

> **clearContext**(): `void`

Defined in: [src/lib/core/AgentClient.ts:377](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/AgentClient.ts#L377)

Clear the conversation context (start fresh)

#### Returns

`void`

***

### getContextId()

> **getContextId**(): `undefined` \| `string`

Defined in: [src/lib/core/AgentClient.ts:387](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/AgentClient.ts#L387)

Get the current conversation context ID

#### Returns

`undefined` \| `string`

***

### setContextId()

> **setContextId**(`contextId`): `void`

Defined in: [src/lib/core/AgentClient.ts:394](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/AgentClient.ts#L394)

Set a specific conversation context ID

#### Parameters

##### contextId

`string`

#### Returns

`void`

***

### getAgent()

> **getAgent**(): [`AgentConfig`](../interfaces/AgentConfig.md)

Defined in: [src/lib/core/AgentClient.ts:403](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/AgentClient.ts#L403)

Get the agent configuration

#### Returns

[`AgentConfig`](../interfaces/AgentConfig.md)

***

### getAgentId()

> **getAgentId**(): `string`

Defined in: [src/lib/core/AgentClient.ts:410](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/AgentClient.ts#L410)

Get the agent ID

#### Returns

`string`

***

### getAgentName()

> **getAgentName**(): `string`

Defined in: [src/lib/core/AgentClient.ts:417](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/AgentClient.ts#L417)

Get the agent name

#### Returns

`string`

***

### getProtocol()

> **getProtocol**(): `"mcp"` \| `"a2a"`

Defined in: [src/lib/core/AgentClient.ts:424](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/AgentClient.ts#L424)

Get the agent protocol

#### Returns

`"mcp"` \| `"a2a"`

***

### getAgentInfo()

> **getAgentInfo**(): `Promise`\<\{ `name`: `string`; `description?`: `string`; `protocol`: `"mcp"` \| `"a2a"`; `url`: `string`; `tools`: `object`[]; \}\>

Defined in: [src/lib/core/AgentClient.ts:431](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/AgentClient.ts#L431)

Get agent information including capabilities

#### Returns

`Promise`\<\{ `name`: `string`; `description?`: `string`; `protocol`: `"mcp"` \| `"a2a"`; `url`: `string`; `tools`: `object`[]; \}\>

***

### hasActiveConversation()

> **hasActiveConversation**(): `boolean`

Defined in: [src/lib/core/AgentClient.ts:438](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/AgentClient.ts#L438)

Check if there's an active conversation

#### Returns

`boolean`

***

### getActiveTasks()

> **getActiveTasks**(): [`TaskState`](../interfaces/TaskState.md)[]

Defined in: [src/lib/core/AgentClient.ts:445](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/AgentClient.ts#L445)

Get active tasks for this agent

#### Returns

[`TaskState`](../interfaces/TaskState.md)[]

***

### executeTask()

#### Call Signature

> **executeTask**\<`K`\>(`taskName`, `params`, `inputHandler?`, `options?`): `Promise`\<[`TaskResult`](../interfaces/TaskResult.md)\<[`TaskResponseTypeMap`](../type-aliases/TaskResponseTypeMap.md)\[`K`\]\>\>

Defined in: [src/lib/core/AgentClient.ts:464](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/AgentClient.ts#L464)

Execute any ADCP task by name with full type safety

##### Type Parameters

###### K

`K` *extends* keyof [`TaskResponseTypeMap`](../type-aliases/TaskResponseTypeMap.md)

##### Parameters

###### taskName

`K`

###### params

`any`

###### inputHandler?

[`InputHandler`](../type-aliases/InputHandler.md)

###### options?

[`TaskOptions`](../interfaces/TaskOptions.md)

##### Returns

`Promise`\<[`TaskResult`](../interfaces/TaskResult.md)\<[`TaskResponseTypeMap`](../type-aliases/TaskResponseTypeMap.md)\[`K`\]\>\>

##### Example

```typescript
// ✅ TYPE-SAFE: Automatic response type inference
const result = await agent.executeTask('get_products', params);
// result is TaskResult<GetProductsResponse> - no casting needed!

// ✅ CUSTOM TYPES: For non-standard tasks
const customResult = await agent.executeTask<MyCustomResponse>('custom_task', params);
```

#### Call Signature

> **executeTask**\<`T`\>(`taskName`, `params`, `inputHandler?`, `options?`): `Promise`\<[`TaskResult`](../interfaces/TaskResult.md)\<`T`\>\>

Defined in: [src/lib/core/AgentClient.ts:474](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/AgentClient.ts#L474)

Execute any task by name with custom response type

##### Type Parameters

###### T

`T` = `any`

##### Parameters

###### taskName

`string`

###### params

`any`

###### inputHandler?

[`InputHandler`](../type-aliases/InputHandler.md)

###### options?

[`TaskOptions`](../interfaces/TaskOptions.md)

##### Returns

`Promise`\<[`TaskResult`](../interfaces/TaskResult.md)\<`T`\>\>

***

### listTasks()

> **listTasks**(): `Promise`\<`TaskInfo`[]\>

Defined in: [src/lib/core/AgentClient.ts:504](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/AgentClient.ts#L504)

List all tasks for this agent

#### Returns

`Promise`\<`TaskInfo`[]\>

***

### getTaskInfo()

> **getTaskInfo**(`taskId`): `Promise`\<`null` \| `TaskInfo`\>

Defined in: [src/lib/core/AgentClient.ts:511](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/AgentClient.ts#L511)

Get detailed information about a specific task

#### Parameters

##### taskId

`string`

#### Returns

`Promise`\<`null` \| `TaskInfo`\>

***

### onTaskUpdate()

> **onTaskUpdate**(`callback`): () => `void`

Defined in: [src/lib/core/AgentClient.ts:518](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/AgentClient.ts#L518)

Subscribe to task notifications for this agent

#### Parameters

##### callback

(`task`) => `void`

#### Returns

> (): `void`

##### Returns

`void`

***

### onTaskEvents()

> **onTaskEvents**(`callbacks`): () => `void`

Defined in: [src/lib/core/AgentClient.ts:525](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/AgentClient.ts#L525)

Subscribe to all task events

#### Parameters

##### callbacks

###### onTaskCreated?

(`task`) => `void`

###### onTaskUpdated?

(`task`) => `void`

###### onTaskCompleted?

(`task`) => `void`

###### onTaskFailed?

(`task`, `error`) => `void`

#### Returns

> (): `void`

##### Returns

`void`

***

### registerWebhook()

> **registerWebhook**(`webhookUrl`, `taskTypes?`): `Promise`\<`void`\>

Defined in: [src/lib/core/AgentClient.ts:537](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/AgentClient.ts#L537)

Register webhook for task notifications

#### Parameters

##### webhookUrl

`string`

##### taskTypes?

`string`[]

#### Returns

`Promise`\<`void`\>

***

### unregisterWebhook()

> **unregisterWebhook**(): `Promise`\<`void`\>

Defined in: [src/lib/core/AgentClient.ts:544](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/AgentClient.ts#L544)

Unregister webhook notifications

#### Returns

`Promise`\<`void`\>
