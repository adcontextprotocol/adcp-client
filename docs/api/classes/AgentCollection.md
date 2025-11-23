[**@adcp/client API Reference v3.1.0**](../README.md)

***

[@adcp/client API Reference](../globals.md) / AgentCollection

# Class: AgentCollection

Defined in: [src/lib/agents/index.generated.ts:185](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/agents/index.generated.ts#L185)

Multi-agent operations with full type safety

## Constructors

### Constructor

> **new AgentCollection**(`configs`, `client`): `AgentCollection`

Defined in: [src/lib/agents/index.generated.ts:186](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/agents/index.generated.ts#L186)

#### Parameters

##### configs

[`AgentConfig`](../interfaces/AgentConfig.md)[]

##### client

`any`

#### Returns

`AgentCollection`

## Methods

### getProducts()

> **getProducts**(`params`): `Promise`\<[`GetProductsResponse`](../interfaces/GetProductsResponse.md)[]\>

Defined in: [src/lib/agents/index.generated.ts:201](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/agents/index.generated.ts#L201)

Official AdCP get_products tool schema (across multiple agents)
Official AdCP get_products tool schema

#### Parameters

##### params

[`GetProductsRequest`](../interfaces/GetProductsRequest.md)

#### Returns

`Promise`\<[`GetProductsResponse`](../interfaces/GetProductsResponse.md)[]\>

***

### listCreativeFormats()

> **listCreativeFormats**(`params`): `Promise`\<[`ListCreativeFormatsResponse`](../interfaces/ListCreativeFormatsResponse.md)[]\>

Defined in: [src/lib/agents/index.generated.ts:209](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/agents/index.generated.ts#L209)

Official AdCP list_creative_formats tool schema (across multiple agents)
Official AdCP list_creative_formats tool schema

#### Parameters

##### params

[`ListCreativeFormatsRequest`](../interfaces/ListCreativeFormatsRequest.md)

#### Returns

`Promise`\<[`ListCreativeFormatsResponse`](../interfaces/ListCreativeFormatsResponse.md)[]\>

***

### syncCreatives()

> **syncCreatives**(`params`): `Promise`\<[`SyncCreativesResponse`](../type-aliases/SyncCreativesResponse.md)[]\>

Defined in: [src/lib/agents/index.generated.ts:217](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/agents/index.generated.ts#L217)

Official AdCP sync_creatives tool schema (across multiple agents)
Official AdCP sync_creatives tool schema

#### Parameters

##### params

[`SyncCreativesRequest`](../interfaces/SyncCreativesRequest.md)

#### Returns

`Promise`\<[`SyncCreativesResponse`](../type-aliases/SyncCreativesResponse.md)[]\>

***

### listCreatives()

> **listCreatives**(`params`): `Promise`\<[`ListCreativesResponse`](../interfaces/ListCreativesResponse.md)[]\>

Defined in: [src/lib/agents/index.generated.ts:225](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/agents/index.generated.ts#L225)

Official AdCP list_creatives tool schema (across multiple agents)
Official AdCP list_creatives tool schema

#### Parameters

##### params

[`ListCreativesRequest`](../interfaces/ListCreativesRequest.md)

#### Returns

`Promise`\<[`ListCreativesResponse`](../interfaces/ListCreativesResponse.md)[]\>

***

### getMediaBuyDelivery()

> **getMediaBuyDelivery**(`params`): `Promise`\<[`GetMediaBuyDeliveryResponse`](../interfaces/GetMediaBuyDeliveryResponse.md)[]\>

Defined in: [src/lib/agents/index.generated.ts:233](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/agents/index.generated.ts#L233)

Official AdCP get_media_buy_delivery tool schema (across multiple agents)
Official AdCP get_media_buy_delivery tool schema

#### Parameters

##### params

[`GetMediaBuyDeliveryRequest`](../interfaces/GetMediaBuyDeliveryRequest.md)

#### Returns

`Promise`\<[`GetMediaBuyDeliveryResponse`](../interfaces/GetMediaBuyDeliveryResponse.md)[]\>

***

### listAuthorizedProperties()

> **listAuthorizedProperties**(`params`): `Promise`\<[`ListAuthorizedPropertiesResponse`](../interfaces/ListAuthorizedPropertiesResponse.md)[]\>

Defined in: [src/lib/agents/index.generated.ts:241](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/agents/index.generated.ts#L241)

Official AdCP list_authorized_properties tool schema (across multiple agents)
Official AdCP list_authorized_properties tool schema

#### Parameters

##### params

[`ListAuthorizedPropertiesRequest`](../interfaces/ListAuthorizedPropertiesRequest.md)

#### Returns

`Promise`\<[`ListAuthorizedPropertiesResponse`](../interfaces/ListAuthorizedPropertiesResponse.md)[]\>

***

### providePerformanceFeedback()

> **providePerformanceFeedback**(`params`): `Promise`\<[`ProvidePerformanceFeedbackResponse`](../type-aliases/ProvidePerformanceFeedbackResponse.md)[]\>

Defined in: [src/lib/agents/index.generated.ts:249](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/agents/index.generated.ts#L249)

Official AdCP provide_performance_feedback tool schema (across multiple agents)
Official AdCP provide_performance_feedback tool schema

#### Parameters

##### params

[`ProvidePerformanceFeedbackRequest`](../interfaces/ProvidePerformanceFeedbackRequest.md)

#### Returns

`Promise`\<[`ProvidePerformanceFeedbackResponse`](../type-aliases/ProvidePerformanceFeedbackResponse.md)[]\>

***

### buildCreative()

> **buildCreative**(`params`): `Promise`\<`BuildCreativeResponse`[]\>

Defined in: [src/lib/agents/index.generated.ts:257](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/agents/index.generated.ts#L257)

Official AdCP build_creative tool schema (across multiple agents)
Official AdCP build_creative tool schema

#### Parameters

##### params

`BuildCreativeRequest`

#### Returns

`Promise`\<`BuildCreativeResponse`[]\>

***

### previewCreative()

> **previewCreative**(`params`): `Promise`\<`PreviewCreativeResponse`[]\>

Defined in: [src/lib/agents/index.generated.ts:265](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/agents/index.generated.ts#L265)

Official AdCP preview_creative tool schema (across multiple agents)
Official AdCP preview_creative tool schema

#### Parameters

##### params

`PreviewCreativeRequest`

#### Returns

`Promise`\<`PreviewCreativeResponse`[]\>

***

### getSignals()

> **getSignals**(`params`): `Promise`\<[`GetSignalsResponse`](../interfaces/GetSignalsResponse.md)[]\>

Defined in: [src/lib/agents/index.generated.ts:273](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/agents/index.generated.ts#L273)

Official AdCP get_signals tool schema (across multiple agents)
Official AdCP get_signals tool schema

#### Parameters

##### params

[`GetSignalsRequest`](../interfaces/GetSignalsRequest.md)

#### Returns

`Promise`\<[`GetSignalsResponse`](../interfaces/GetSignalsResponse.md)[]\>

***

### activateSignal()

> **activateSignal**(`params`): `Promise`\<[`ActivateSignalResponse`](../type-aliases/ActivateSignalResponse.md)[]\>

Defined in: [src/lib/agents/index.generated.ts:281](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/agents/index.generated.ts#L281)

Official AdCP activate_signal tool schema (across multiple agents)
Official AdCP activate_signal tool schema

#### Parameters

##### params

[`ActivateSignalRequest`](../interfaces/ActivateSignalRequest.md)

#### Returns

`Promise`\<[`ActivateSignalResponse`](../type-aliases/ActivateSignalResponse.md)[]\>
