[**@adcp/client API Reference v3.1.0**](../README.md)

***

[@adcp/client API Reference](../globals.md) / Agent

# Class: Agent

Defined in: [src/lib/agents/index.generated.ts:43](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/agents/index.generated.ts#L43)

Single agent operations with full type safety

Returns raw AdCP responses matching schema exactly.
No SDK wrapping - responses follow AdCP discriminated union patterns.

## Constructors

### Constructor

> **new Agent**(`config`, `client`): `Agent`

Defined in: [src/lib/agents/index.generated.ts:44](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/agents/index.generated.ts#L44)

#### Parameters

##### config

[`AgentConfig`](../interfaces/AgentConfig.md)

##### client

`any`

#### Returns

`Agent`

## Methods

### getProducts()

> **getProducts**(`params`): `Promise`\<[`GetProductsResponse`](../interfaces/GetProductsResponse.md)\>

Defined in: [src/lib/agents/index.generated.ts:80](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/agents/index.generated.ts#L80)

Official AdCP get_products tool schema
Official AdCP get_products tool schema

#### Parameters

##### params

[`GetProductsRequest`](../interfaces/GetProductsRequest.md)

#### Returns

`Promise`\<[`GetProductsResponse`](../interfaces/GetProductsResponse.md)\>

***

### listCreativeFormats()

> **listCreativeFormats**(`params`): `Promise`\<[`ListCreativeFormatsResponse`](../interfaces/ListCreativeFormatsResponse.md)\>

Defined in: [src/lib/agents/index.generated.ts:88](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/agents/index.generated.ts#L88)

Official AdCP list_creative_formats tool schema
Official AdCP list_creative_formats tool schema

#### Parameters

##### params

[`ListCreativeFormatsRequest`](../interfaces/ListCreativeFormatsRequest.md)

#### Returns

`Promise`\<[`ListCreativeFormatsResponse`](../interfaces/ListCreativeFormatsResponse.md)\>

***

### createMediaBuy()

> **createMediaBuy**(`params`): `Promise`\<[`CreateMediaBuyResponse`](../type-aliases/CreateMediaBuyResponse.md)\>

Defined in: [src/lib/agents/index.generated.ts:96](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/agents/index.generated.ts#L96)

Official AdCP create_media_buy tool schema
Official AdCP create_media_buy tool schema

#### Parameters

##### params

[`CreateMediaBuyRequest`](../interfaces/CreateMediaBuyRequest.md)

#### Returns

`Promise`\<[`CreateMediaBuyResponse`](../type-aliases/CreateMediaBuyResponse.md)\>

***

### syncCreatives()

> **syncCreatives**(`params`): `Promise`\<[`SyncCreativesResponse`](../type-aliases/SyncCreativesResponse.md)\>

Defined in: [src/lib/agents/index.generated.ts:104](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/agents/index.generated.ts#L104)

Official AdCP sync_creatives tool schema
Official AdCP sync_creatives tool schema

#### Parameters

##### params

[`SyncCreativesRequest`](../interfaces/SyncCreativesRequest.md)

#### Returns

`Promise`\<[`SyncCreativesResponse`](../type-aliases/SyncCreativesResponse.md)\>

***

### listCreatives()

> **listCreatives**(`params`): `Promise`\<[`ListCreativesResponse`](../interfaces/ListCreativesResponse.md)\>

Defined in: [src/lib/agents/index.generated.ts:112](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/agents/index.generated.ts#L112)

Official AdCP list_creatives tool schema
Official AdCP list_creatives tool schema

#### Parameters

##### params

[`ListCreativesRequest`](../interfaces/ListCreativesRequest.md)

#### Returns

`Promise`\<[`ListCreativesResponse`](../interfaces/ListCreativesResponse.md)\>

***

### updateMediaBuy()

> **updateMediaBuy**(`params`): `Promise`\<[`UpdateMediaBuyResponse`](../type-aliases/UpdateMediaBuyResponse.md)\>

Defined in: [src/lib/agents/index.generated.ts:120](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/agents/index.generated.ts#L120)

Official AdCP update_media_buy tool schema
Official AdCP update_media_buy tool schema

#### Parameters

##### params

[`UpdateMediaBuyRequest`](../type-aliases/UpdateMediaBuyRequest.md)

#### Returns

`Promise`\<[`UpdateMediaBuyResponse`](../type-aliases/UpdateMediaBuyResponse.md)\>

***

### getMediaBuyDelivery()

> **getMediaBuyDelivery**(`params`): `Promise`\<[`GetMediaBuyDeliveryResponse`](../interfaces/GetMediaBuyDeliveryResponse.md)\>

Defined in: [src/lib/agents/index.generated.ts:128](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/agents/index.generated.ts#L128)

Official AdCP get_media_buy_delivery tool schema
Official AdCP get_media_buy_delivery tool schema

#### Parameters

##### params

[`GetMediaBuyDeliveryRequest`](../interfaces/GetMediaBuyDeliveryRequest.md)

#### Returns

`Promise`\<[`GetMediaBuyDeliveryResponse`](../interfaces/GetMediaBuyDeliveryResponse.md)\>

***

### listAuthorizedProperties()

> **listAuthorizedProperties**(`params`): `Promise`\<[`ListAuthorizedPropertiesResponse`](../interfaces/ListAuthorizedPropertiesResponse.md)\>

Defined in: [src/lib/agents/index.generated.ts:136](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/agents/index.generated.ts#L136)

Official AdCP list_authorized_properties tool schema
Official AdCP list_authorized_properties tool schema

#### Parameters

##### params

[`ListAuthorizedPropertiesRequest`](../interfaces/ListAuthorizedPropertiesRequest.md)

#### Returns

`Promise`\<[`ListAuthorizedPropertiesResponse`](../interfaces/ListAuthorizedPropertiesResponse.md)\>

***

### providePerformanceFeedback()

> **providePerformanceFeedback**(`params`): `Promise`\<[`ProvidePerformanceFeedbackResponse`](../type-aliases/ProvidePerformanceFeedbackResponse.md)\>

Defined in: [src/lib/agents/index.generated.ts:144](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/agents/index.generated.ts#L144)

Official AdCP provide_performance_feedback tool schema
Official AdCP provide_performance_feedback tool schema

#### Parameters

##### params

[`ProvidePerformanceFeedbackRequest`](../interfaces/ProvidePerformanceFeedbackRequest.md)

#### Returns

`Promise`\<[`ProvidePerformanceFeedbackResponse`](../type-aliases/ProvidePerformanceFeedbackResponse.md)\>

***

### buildCreative()

> **buildCreative**(`params`): `Promise`\<`BuildCreativeResponse`\>

Defined in: [src/lib/agents/index.generated.ts:152](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/agents/index.generated.ts#L152)

Official AdCP build_creative tool schema
Official AdCP build_creative tool schema

#### Parameters

##### params

`BuildCreativeRequest`

#### Returns

`Promise`\<`BuildCreativeResponse`\>

***

### previewCreative()

> **previewCreative**(`params`): `Promise`\<`PreviewCreativeResponse`\>

Defined in: [src/lib/agents/index.generated.ts:160](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/agents/index.generated.ts#L160)

Official AdCP preview_creative tool schema
Official AdCP preview_creative tool schema

#### Parameters

##### params

`PreviewCreativeRequest`

#### Returns

`Promise`\<`PreviewCreativeResponse`\>

***

### getSignals()

> **getSignals**(`params`): `Promise`\<[`GetSignalsResponse`](../interfaces/GetSignalsResponse.md)\>

Defined in: [src/lib/agents/index.generated.ts:168](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/agents/index.generated.ts#L168)

Official AdCP get_signals tool schema
Official AdCP get_signals tool schema

#### Parameters

##### params

[`GetSignalsRequest`](../interfaces/GetSignalsRequest.md)

#### Returns

`Promise`\<[`GetSignalsResponse`](../interfaces/GetSignalsResponse.md)\>

***

### activateSignal()

> **activateSignal**(`params`): `Promise`\<[`ActivateSignalResponse`](../type-aliases/ActivateSignalResponse.md)\>

Defined in: [src/lib/agents/index.generated.ts:176](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/agents/index.generated.ts#L176)

Official AdCP activate_signal tool schema
Official AdCP activate_signal tool schema

#### Parameters

##### params

[`ActivateSignalRequest`](../interfaces/ActivateSignalRequest.md)

#### Returns

`Promise`\<[`ActivateSignalResponse`](../type-aliases/ActivateSignalResponse.md)\>
