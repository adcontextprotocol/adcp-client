[**@adcp/client API Reference v2.0.0**](../README.md)

***

[@adcp/client API Reference](../README.md) / AgentCollection

# Class: AgentCollection

Defined in: [src/lib/agents/index.generated.ts:205](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/agents/index.generated.ts#L205)

Multi-agent operations with full type safety

## Constructors

### Constructor

> **new AgentCollection**(`configs`, `client`): `AgentCollection`

Defined in: [src/lib/agents/index.generated.ts:206](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/agents/index.generated.ts#L206)

#### Parameters

##### configs

[`AgentConfig`](../interfaces/AgentConfig.md)[]

##### client

`any`

#### Returns

`AgentCollection`

## Methods

### getProducts()

> **getProducts**(`params`): `Promise`\<`ToolResult`\<[`GetProductsResponse`](../interfaces/GetProductsResponse.md)\>[]\>

Defined in: [src/lib/agents/index.generated.ts:221](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/agents/index.generated.ts#L221)

Official AdCP get_products tool schema (across multiple agents)
Official AdCP get_products tool schema

#### Parameters

##### params

[`GetProductsRequest`](../interfaces/GetProductsRequest.md)

#### Returns

`Promise`\<`ToolResult`\<[`GetProductsResponse`](../interfaces/GetProductsResponse.md)\>[]\>

***

### listCreativeFormats()

> **listCreativeFormats**(`params`): `Promise`\<`ToolResult`\<[`ListCreativeFormatsResponse`](../interfaces/ListCreativeFormatsResponse.md)\>[]\>

Defined in: [src/lib/agents/index.generated.ts:229](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/agents/index.generated.ts#L229)

Official AdCP list_creative_formats tool schema (across multiple agents)
Official AdCP list_creative_formats tool schema

#### Parameters

##### params

[`ListCreativeFormatsRequest`](../interfaces/ListCreativeFormatsRequest.md)

#### Returns

`Promise`\<`ToolResult`\<[`ListCreativeFormatsResponse`](../interfaces/ListCreativeFormatsResponse.md)\>[]\>

***

### syncCreatives()

> **syncCreatives**(`params`): `Promise`\<`ToolResult`\<[`SyncCreativesResponse`](../interfaces/SyncCreativesResponse.md)\>[]\>

Defined in: [src/lib/agents/index.generated.ts:237](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/agents/index.generated.ts#L237)

Official AdCP sync_creatives tool schema (across multiple agents)
Official AdCP sync_creatives tool schema

#### Parameters

##### params

[`SyncCreativesRequest`](../interfaces/SyncCreativesRequest.md)

#### Returns

`Promise`\<`ToolResult`\<[`SyncCreativesResponse`](../interfaces/SyncCreativesResponse.md)\>[]\>

***

### listCreatives()

> **listCreatives**(`params`): `Promise`\<`ToolResult`\<[`ListCreativesResponse`](../interfaces/ListCreativesResponse.md)\>[]\>

Defined in: [src/lib/agents/index.generated.ts:245](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/agents/index.generated.ts#L245)

Official AdCP list_creatives tool schema (across multiple agents)
Official AdCP list_creatives tool schema

#### Parameters

##### params

[`ListCreativesRequest`](../interfaces/ListCreativesRequest.md)

#### Returns

`Promise`\<`ToolResult`\<[`ListCreativesResponse`](../interfaces/ListCreativesResponse.md)\>[]\>

***

### getMediaBuyDelivery()

> **getMediaBuyDelivery**(`params`): `Promise`\<`ToolResult`\<[`GetMediaBuyDeliveryResponse`](../interfaces/GetMediaBuyDeliveryResponse.md)\>[]\>

Defined in: [src/lib/agents/index.generated.ts:253](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/agents/index.generated.ts#L253)

Official AdCP get_media_buy_delivery tool schema (across multiple agents)
Official AdCP get_media_buy_delivery tool schema

#### Parameters

##### params

[`GetMediaBuyDeliveryRequest`](../interfaces/GetMediaBuyDeliveryRequest.md)

#### Returns

`Promise`\<`ToolResult`\<[`GetMediaBuyDeliveryResponse`](../interfaces/GetMediaBuyDeliveryResponse.md)\>[]\>

***

### listAuthorizedProperties()

> **listAuthorizedProperties**(`params`): `Promise`\<`ToolResult`\<[`ListAuthorizedPropertiesResponse`](../interfaces/ListAuthorizedPropertiesResponse.md)\>[]\>

Defined in: [src/lib/agents/index.generated.ts:261](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/agents/index.generated.ts#L261)

Official AdCP list_authorized_properties tool schema (across multiple agents)
Official AdCP list_authorized_properties tool schema

#### Parameters

##### params

[`ListAuthorizedPropertiesRequest`](../interfaces/ListAuthorizedPropertiesRequest.md)

#### Returns

`Promise`\<`ToolResult`\<[`ListAuthorizedPropertiesResponse`](../interfaces/ListAuthorizedPropertiesResponse.md)\>[]\>

***

### providePerformanceFeedback()

> **providePerformanceFeedback**(`params`): `Promise`\<`ToolResult`\<[`ProvidePerformanceFeedbackResponse`](../interfaces/ProvidePerformanceFeedbackResponse.md)\>[]\>

Defined in: [src/lib/agents/index.generated.ts:269](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/agents/index.generated.ts#L269)

Official AdCP provide_performance_feedback tool schema (across multiple agents)
Official AdCP provide_performance_feedback tool schema

#### Parameters

##### params

[`ProvidePerformanceFeedbackRequest`](../interfaces/ProvidePerformanceFeedbackRequest.md)

#### Returns

`Promise`\<`ToolResult`\<[`ProvidePerformanceFeedbackResponse`](../interfaces/ProvidePerformanceFeedbackResponse.md)\>[]\>

***

### getSignals()

> **getSignals**(`params`): `Promise`\<`ToolResult`\<[`GetSignalsResponse`](../interfaces/GetSignalsResponse.md)\>[]\>

Defined in: [src/lib/agents/index.generated.ts:277](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/agents/index.generated.ts#L277)

Official AdCP get_signals tool schema (across multiple agents)
Official AdCP get_signals tool schema

#### Parameters

##### params

[`GetSignalsRequest`](../interfaces/GetSignalsRequest.md)

#### Returns

`Promise`\<`ToolResult`\<[`GetSignalsResponse`](../interfaces/GetSignalsResponse.md)\>[]\>

***

### activateSignal()

> **activateSignal**(`params`): `Promise`\<`ToolResult`\<[`ActivateSignalResponse`](../interfaces/ActivateSignalResponse.md)\>[]\>

Defined in: [src/lib/agents/index.generated.ts:285](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/agents/index.generated.ts#L285)

Official AdCP activate_signal tool schema (across multiple agents)
Official AdCP activate_signal tool schema

#### Parameters

##### params

[`ActivateSignalRequest`](../interfaces/ActivateSignalRequest.md)

#### Returns

`Promise`\<`ToolResult`\<[`ActivateSignalResponse`](../interfaces/ActivateSignalResponse.md)\>[]\>
