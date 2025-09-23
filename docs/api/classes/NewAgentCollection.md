[**@adcp/client API Reference v2.0.0**](../README.md)

***

[@adcp/client API Reference](../README.md) / NewAgentCollection

# Class: NewAgentCollection

Defined in: [src/lib/core/ADCPMultiAgentClient.ts:40](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/core/ADCPMultiAgentClient.ts#L40)

Collection of agent clients for parallel operations

## Constructors

### Constructor

> **new NewAgentCollection**(`agents`, `config`): `AgentCollection`

Defined in: [src/lib/core/ADCPMultiAgentClient.ts:43](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/core/ADCPMultiAgentClient.ts#L43)

#### Parameters

##### agents

[`AgentConfig`](../interfaces/AgentConfig.md)[]

##### config

[`ADCPClientConfig`](../interfaces/ADCPClientConfig.md) = `{}`

#### Returns

`AgentCollection`

## Accessors

### count

#### Get Signature

> **get** **count**(): `number`

Defined in: [src/lib/core/ADCPMultiAgentClient.ts:239](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/core/ADCPMultiAgentClient.ts#L239)

Get agent count

##### Returns

`number`

## Methods

### getProducts()

> **getProducts**(`params`, `inputHandler?`, `options?`): `Promise`\<[`TaskResult`](../interfaces/TaskResult.md)\<[`GetProductsResponse`](../interfaces/GetProductsResponse.md)\>[]\>

Defined in: [src/lib/core/ADCPMultiAgentClient.ts:57](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/core/ADCPMultiAgentClient.ts#L57)

Execute getProducts on all agents in parallel

#### Parameters

##### params

[`GetProductsRequest`](../interfaces/GetProductsRequest.md)

##### inputHandler?

[`InputHandler`](../type-aliases/InputHandler.md)

##### options?

[`TaskOptions`](../interfaces/TaskOptions.md)

#### Returns

`Promise`\<[`TaskResult`](../interfaces/TaskResult.md)\<[`GetProductsResponse`](../interfaces/GetProductsResponse.md)\>[]\>

***

### listCreativeFormats()

> **listCreativeFormats**(`params`, `inputHandler?`, `options?`): `Promise`\<[`TaskResult`](../interfaces/TaskResult.md)\<[`ListCreativeFormatsResponse`](../interfaces/ListCreativeFormatsResponse.md)\>[]\>

Defined in: [src/lib/core/ADCPMultiAgentClient.ts:71](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/core/ADCPMultiAgentClient.ts#L71)

Execute listCreativeFormats on all agents in parallel

#### Parameters

##### params

[`ListCreativeFormatsRequest`](../interfaces/ListCreativeFormatsRequest.md)

##### inputHandler?

[`InputHandler`](../type-aliases/InputHandler.md)

##### options?

[`TaskOptions`](../interfaces/TaskOptions.md)

#### Returns

`Promise`\<[`TaskResult`](../interfaces/TaskResult.md)\<[`ListCreativeFormatsResponse`](../interfaces/ListCreativeFormatsResponse.md)\>[]\>

***

### createMediaBuy()

> **createMediaBuy**(`params`, `inputHandler?`, `options?`): `Promise`\<[`TaskResult`](../interfaces/TaskResult.md)\<[`CreateMediaBuyResponse`](../interfaces/CreateMediaBuyResponse.md)\>[]\>

Defined in: [src/lib/core/ADCPMultiAgentClient.ts:86](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/core/ADCPMultiAgentClient.ts#L86)

Execute createMediaBuy on all agents in parallel
Note: This might not make sense for all use cases, but provided for completeness

#### Parameters

##### params

[`CreateMediaBuyRequest`](../interfaces/CreateMediaBuyRequest.md)

##### inputHandler?

[`InputHandler`](../type-aliases/InputHandler.md)

##### options?

[`TaskOptions`](../interfaces/TaskOptions.md)

#### Returns

`Promise`\<[`TaskResult`](../interfaces/TaskResult.md)\<[`CreateMediaBuyResponse`](../interfaces/CreateMediaBuyResponse.md)\>[]\>

***

### updateMediaBuy()

> **updateMediaBuy**(`params`, `inputHandler?`, `options?`): `Promise`\<[`TaskResult`](../interfaces/TaskResult.md)\<[`UpdateMediaBuyResponse`](../interfaces/UpdateMediaBuyResponse.md)\>[]\>

Defined in: [src/lib/core/ADCPMultiAgentClient.ts:100](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/core/ADCPMultiAgentClient.ts#L100)

Execute updateMediaBuy on all agents in parallel

#### Parameters

##### params

[`UpdateMediaBuyRequest`](../type-aliases/UpdateMediaBuyRequest.md)

##### inputHandler?

[`InputHandler`](../type-aliases/InputHandler.md)

##### options?

[`TaskOptions`](../interfaces/TaskOptions.md)

#### Returns

`Promise`\<[`TaskResult`](../interfaces/TaskResult.md)\<[`UpdateMediaBuyResponse`](../interfaces/UpdateMediaBuyResponse.md)\>[]\>

***

### syncCreatives()

> **syncCreatives**(`params`, `inputHandler?`, `options?`): `Promise`\<[`TaskResult`](../interfaces/TaskResult.md)\<[`SyncCreativesResponse`](../interfaces/SyncCreativesResponse.md)\>[]\>

Defined in: [src/lib/core/ADCPMultiAgentClient.ts:114](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/core/ADCPMultiAgentClient.ts#L114)

Execute syncCreatives on all agents in parallel

#### Parameters

##### params

[`SyncCreativesRequest`](../interfaces/SyncCreativesRequest.md)

##### inputHandler?

[`InputHandler`](../type-aliases/InputHandler.md)

##### options?

[`TaskOptions`](../interfaces/TaskOptions.md)

#### Returns

`Promise`\<[`TaskResult`](../interfaces/TaskResult.md)\<[`SyncCreativesResponse`](../interfaces/SyncCreativesResponse.md)\>[]\>

***

### listCreatives()

> **listCreatives**(`params`, `inputHandler?`, `options?`): `Promise`\<[`TaskResult`](../interfaces/TaskResult.md)\<[`ListCreativesResponse`](../interfaces/ListCreativesResponse.md)\>[]\>

Defined in: [src/lib/core/ADCPMultiAgentClient.ts:128](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/core/ADCPMultiAgentClient.ts#L128)

Execute listCreatives on all agents in parallel

#### Parameters

##### params

[`ListCreativesRequest`](../interfaces/ListCreativesRequest.md)

##### inputHandler?

[`InputHandler`](../type-aliases/InputHandler.md)

##### options?

[`TaskOptions`](../interfaces/TaskOptions.md)

#### Returns

`Promise`\<[`TaskResult`](../interfaces/TaskResult.md)\<[`ListCreativesResponse`](../interfaces/ListCreativesResponse.md)\>[]\>

***

### getMediaBuyDelivery()

> **getMediaBuyDelivery**(`params`, `inputHandler?`, `options?`): `Promise`\<[`TaskResult`](../interfaces/TaskResult.md)\<[`GetMediaBuyDeliveryResponse`](../interfaces/GetMediaBuyDeliveryResponse.md)\>[]\>

Defined in: [src/lib/core/ADCPMultiAgentClient.ts:142](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/core/ADCPMultiAgentClient.ts#L142)

Execute getMediaBuyDelivery on all agents in parallel

#### Parameters

##### params

[`GetMediaBuyDeliveryRequest`](../interfaces/GetMediaBuyDeliveryRequest.md)

##### inputHandler?

[`InputHandler`](../type-aliases/InputHandler.md)

##### options?

[`TaskOptions`](../interfaces/TaskOptions.md)

#### Returns

`Promise`\<[`TaskResult`](../interfaces/TaskResult.md)\<[`GetMediaBuyDeliveryResponse`](../interfaces/GetMediaBuyDeliveryResponse.md)\>[]\>

***

### listAuthorizedProperties()

> **listAuthorizedProperties**(`params`, `inputHandler?`, `options?`): `Promise`\<[`TaskResult`](../interfaces/TaskResult.md)\<[`ListAuthorizedPropertiesResponse`](../interfaces/ListAuthorizedPropertiesResponse.md)\>[]\>

Defined in: [src/lib/core/ADCPMultiAgentClient.ts:156](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/core/ADCPMultiAgentClient.ts#L156)

Execute listAuthorizedProperties on all agents in parallel

#### Parameters

##### params

[`ListAuthorizedPropertiesRequest`](../interfaces/ListAuthorizedPropertiesRequest.md)

##### inputHandler?

[`InputHandler`](../type-aliases/InputHandler.md)

##### options?

[`TaskOptions`](../interfaces/TaskOptions.md)

#### Returns

`Promise`\<[`TaskResult`](../interfaces/TaskResult.md)\<[`ListAuthorizedPropertiesResponse`](../interfaces/ListAuthorizedPropertiesResponse.md)\>[]\>

***

### providePerformanceFeedback()

> **providePerformanceFeedback**(`params`, `inputHandler?`, `options?`): `Promise`\<[`TaskResult`](../interfaces/TaskResult.md)\<[`ProvidePerformanceFeedbackResponse`](../interfaces/ProvidePerformanceFeedbackResponse.md)\>[]\>

Defined in: [src/lib/core/ADCPMultiAgentClient.ts:170](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/core/ADCPMultiAgentClient.ts#L170)

Execute providePerformanceFeedback on all agents in parallel

#### Parameters

##### params

[`ProvidePerformanceFeedbackRequest`](../interfaces/ProvidePerformanceFeedbackRequest.md)

##### inputHandler?

[`InputHandler`](../type-aliases/InputHandler.md)

##### options?

[`TaskOptions`](../interfaces/TaskOptions.md)

#### Returns

`Promise`\<[`TaskResult`](../interfaces/TaskResult.md)\<[`ProvidePerformanceFeedbackResponse`](../interfaces/ProvidePerformanceFeedbackResponse.md)\>[]\>

***

### getSignals()

> **getSignals**(`params`, `inputHandler?`, `options?`): `Promise`\<[`TaskResult`](../interfaces/TaskResult.md)\<[`GetSignalsResponse`](../interfaces/GetSignalsResponse.md)\>[]\>

Defined in: [src/lib/core/ADCPMultiAgentClient.ts:184](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/core/ADCPMultiAgentClient.ts#L184)

Execute getSignals on all agents in parallel

#### Parameters

##### params

[`GetSignalsRequest`](../interfaces/GetSignalsRequest.md)

##### inputHandler?

[`InputHandler`](../type-aliases/InputHandler.md)

##### options?

[`TaskOptions`](../interfaces/TaskOptions.md)

#### Returns

`Promise`\<[`TaskResult`](../interfaces/TaskResult.md)\<[`GetSignalsResponse`](../interfaces/GetSignalsResponse.md)\>[]\>

***

### activateSignal()

> **activateSignal**(`params`, `inputHandler?`, `options?`): `Promise`\<[`TaskResult`](../interfaces/TaskResult.md)\<[`ActivateSignalResponse`](../interfaces/ActivateSignalResponse.md)\>[]\>

Defined in: [src/lib/core/ADCPMultiAgentClient.ts:198](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/core/ADCPMultiAgentClient.ts#L198)

Execute activateSignal on all agents in parallel

#### Parameters

##### params

[`ActivateSignalRequest`](../interfaces/ActivateSignalRequest.md)

##### inputHandler?

[`InputHandler`](../type-aliases/InputHandler.md)

##### options?

[`TaskOptions`](../interfaces/TaskOptions.md)

#### Returns

`Promise`\<[`TaskResult`](../interfaces/TaskResult.md)\<[`ActivateSignalResponse`](../interfaces/ActivateSignalResponse.md)\>[]\>

***

### getAgent()

> **getAgent**(`agentId`): [`AgentClient`](AgentClient.md)

Defined in: [src/lib/core/ADCPMultiAgentClient.ts:214](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/core/ADCPMultiAgentClient.ts#L214)

Get individual agent client

#### Parameters

##### agentId

`string`

#### Returns

[`AgentClient`](AgentClient.md)

***

### getAllAgents()

> **getAllAgents**(): [`AgentClient`](AgentClient.md)[]

Defined in: [src/lib/core/ADCPMultiAgentClient.ts:225](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/core/ADCPMultiAgentClient.ts#L225)

Get all agent clients

#### Returns

[`AgentClient`](AgentClient.md)[]

***

### getAgentIds()

> **getAgentIds**(): `string`[]

Defined in: [src/lib/core/ADCPMultiAgentClient.ts:232](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/core/ADCPMultiAgentClient.ts#L232)

Get agent IDs

#### Returns

`string`[]

***

### filter()

> **filter**(`predicate`): [`AgentClient`](AgentClient.md)[]

Defined in: [src/lib/core/ADCPMultiAgentClient.ts:246](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/core/ADCPMultiAgentClient.ts#L246)

Filter agents by a condition

#### Parameters

##### predicate

(`agent`) => `boolean`

#### Returns

[`AgentClient`](AgentClient.md)[]

***

### map()

> **map**\<`T`\>(`mapper`): `T`[]

Defined in: [src/lib/core/ADCPMultiAgentClient.ts:253](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/core/ADCPMultiAgentClient.ts#L253)

Map over all agents

#### Type Parameters

##### T

`T`

#### Parameters

##### mapper

(`agent`) => `T`

#### Returns

`T`[]

***

### execute()

> **execute**\<`T`\>(`executor`): `Promise`\<`T`[]\>

Defined in: [src/lib/core/ADCPMultiAgentClient.ts:260](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/core/ADCPMultiAgentClient.ts#L260)

Execute a custom function on all agents in parallel

#### Type Parameters

##### T

`T`

#### Parameters

##### executor

(`agent`) => `Promise`\<`T`\>

#### Returns

`Promise`\<`T`[]\>
