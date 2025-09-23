[**@adcp/client API Reference v2.0.0**](../README.md)

***

[@adcp/client API Reference](../README.md) / Agent

# Class: Agent

Defined in: [src/lib/agents/index.generated.ts:65](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/agents/index.generated.ts#L65)

Single agent operations with full type safety

## Constructors

### Constructor

> **new Agent**(`config`, `client`): `Agent`

Defined in: [src/lib/agents/index.generated.ts:66](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/agents/index.generated.ts#L66)

#### Parameters

##### config

[`AgentConfig`](../interfaces/AgentConfig.md)

##### client

`any`

#### Returns

`Agent`

## Methods

### getProducts()

> **getProducts**(`params`): `Promise`\<`ToolResult`\<[`GetProductsResponse`](../interfaces/GetProductsResponse.md)\>\>

Defined in: [src/lib/agents/index.generated.ts:116](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/agents/index.generated.ts#L116)

Official AdCP get_products tool schema
Official AdCP get_products tool schema

#### Parameters

##### params

[`GetProductsRequest`](../interfaces/GetProductsRequest.md)

#### Returns

`Promise`\<`ToolResult`\<[`GetProductsResponse`](../interfaces/GetProductsResponse.md)\>\>

***

### listCreativeFormats()

> **listCreativeFormats**(`params`): `Promise`\<`ToolResult`\<[`ListCreativeFormatsResponse`](../interfaces/ListCreativeFormatsResponse.md)\>\>

Defined in: [src/lib/agents/index.generated.ts:124](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/agents/index.generated.ts#L124)

Official AdCP list_creative_formats tool schema
Official AdCP list_creative_formats tool schema

#### Parameters

##### params

[`ListCreativeFormatsRequest`](../interfaces/ListCreativeFormatsRequest.md)

#### Returns

`Promise`\<`ToolResult`\<[`ListCreativeFormatsResponse`](../interfaces/ListCreativeFormatsResponse.md)\>\>

***

### createMediaBuy()

> **createMediaBuy**(`params`): `Promise`\<`ToolResult`\<[`CreateMediaBuyResponse`](../interfaces/CreateMediaBuyResponse.md)\>\>

Defined in: [src/lib/agents/index.generated.ts:132](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/agents/index.generated.ts#L132)

Official AdCP create_media_buy tool schema
Official AdCP create_media_buy tool schema

#### Parameters

##### params

[`CreateMediaBuyRequest`](../interfaces/CreateMediaBuyRequest.md)

#### Returns

`Promise`\<`ToolResult`\<[`CreateMediaBuyResponse`](../interfaces/CreateMediaBuyResponse.md)\>\>

***

### syncCreatives()

> **syncCreatives**(`params`): `Promise`\<`ToolResult`\<[`SyncCreativesResponse`](../interfaces/SyncCreativesResponse.md)\>\>

Defined in: [src/lib/agents/index.generated.ts:140](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/agents/index.generated.ts#L140)

Official AdCP sync_creatives tool schema
Official AdCP sync_creatives tool schema

#### Parameters

##### params

[`SyncCreativesRequest`](../interfaces/SyncCreativesRequest.md)

#### Returns

`Promise`\<`ToolResult`\<[`SyncCreativesResponse`](../interfaces/SyncCreativesResponse.md)\>\>

***

### listCreatives()

> **listCreatives**(`params`): `Promise`\<`ToolResult`\<[`ListCreativesResponse`](../interfaces/ListCreativesResponse.md)\>\>

Defined in: [src/lib/agents/index.generated.ts:148](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/agents/index.generated.ts#L148)

Official AdCP list_creatives tool schema
Official AdCP list_creatives tool schema

#### Parameters

##### params

[`ListCreativesRequest`](../interfaces/ListCreativesRequest.md)

#### Returns

`Promise`\<`ToolResult`\<[`ListCreativesResponse`](../interfaces/ListCreativesResponse.md)\>\>

***

### updateMediaBuy()

> **updateMediaBuy**(`params`): `Promise`\<`ToolResult`\<[`UpdateMediaBuyResponse`](../interfaces/UpdateMediaBuyResponse.md)\>\>

Defined in: [src/lib/agents/index.generated.ts:156](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/agents/index.generated.ts#L156)

Official AdCP update_media_buy tool schema
Official AdCP update_media_buy tool schema

#### Parameters

##### params

[`UpdateMediaBuyRequest`](../type-aliases/UpdateMediaBuyRequest.md)

#### Returns

`Promise`\<`ToolResult`\<[`UpdateMediaBuyResponse`](../interfaces/UpdateMediaBuyResponse.md)\>\>

***

### getMediaBuyDelivery()

> **getMediaBuyDelivery**(`params`): `Promise`\<`ToolResult`\<[`GetMediaBuyDeliveryResponse`](../interfaces/GetMediaBuyDeliveryResponse.md)\>\>

Defined in: [src/lib/agents/index.generated.ts:164](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/agents/index.generated.ts#L164)

Official AdCP get_media_buy_delivery tool schema
Official AdCP get_media_buy_delivery tool schema

#### Parameters

##### params

[`GetMediaBuyDeliveryRequest`](../interfaces/GetMediaBuyDeliveryRequest.md)

#### Returns

`Promise`\<`ToolResult`\<[`GetMediaBuyDeliveryResponse`](../interfaces/GetMediaBuyDeliveryResponse.md)\>\>

***

### listAuthorizedProperties()

> **listAuthorizedProperties**(`params`): `Promise`\<`ToolResult`\<[`ListAuthorizedPropertiesResponse`](../interfaces/ListAuthorizedPropertiesResponse.md)\>\>

Defined in: [src/lib/agents/index.generated.ts:172](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/agents/index.generated.ts#L172)

Official AdCP list_authorized_properties tool schema
Official AdCP list_authorized_properties tool schema

#### Parameters

##### params

[`ListAuthorizedPropertiesRequest`](../interfaces/ListAuthorizedPropertiesRequest.md)

#### Returns

`Promise`\<`ToolResult`\<[`ListAuthorizedPropertiesResponse`](../interfaces/ListAuthorizedPropertiesResponse.md)\>\>

***

### providePerformanceFeedback()

> **providePerformanceFeedback**(`params`): `Promise`\<`ToolResult`\<[`ProvidePerformanceFeedbackResponse`](../interfaces/ProvidePerformanceFeedbackResponse.md)\>\>

Defined in: [src/lib/agents/index.generated.ts:180](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/agents/index.generated.ts#L180)

Official AdCP provide_performance_feedback tool schema
Official AdCP provide_performance_feedback tool schema

#### Parameters

##### params

[`ProvidePerformanceFeedbackRequest`](../interfaces/ProvidePerformanceFeedbackRequest.md)

#### Returns

`Promise`\<`ToolResult`\<[`ProvidePerformanceFeedbackResponse`](../interfaces/ProvidePerformanceFeedbackResponse.md)\>\>

***

### getSignals()

> **getSignals**(`params`): `Promise`\<`ToolResult`\<[`GetSignalsResponse`](../interfaces/GetSignalsResponse.md)\>\>

Defined in: [src/lib/agents/index.generated.ts:188](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/agents/index.generated.ts#L188)

Official AdCP get_signals tool schema
Official AdCP get_signals tool schema

#### Parameters

##### params

[`GetSignalsRequest`](../interfaces/GetSignalsRequest.md)

#### Returns

`Promise`\<`ToolResult`\<[`GetSignalsResponse`](../interfaces/GetSignalsResponse.md)\>\>

***

### activateSignal()

> **activateSignal**(`params`): `Promise`\<`ToolResult`\<[`ActivateSignalResponse`](../interfaces/ActivateSignalResponse.md)\>\>

Defined in: [src/lib/agents/index.generated.ts:196](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/agents/index.generated.ts#L196)

Official AdCP activate_signal tool schema
Official AdCP activate_signal tool schema

#### Parameters

##### params

[`ActivateSignalRequest`](../interfaces/ActivateSignalRequest.md)

#### Returns

`Promise`\<`ToolResult`\<[`ActivateSignalResponse`](../interfaces/ActivateSignalResponse.md)\>\>
