[**@adcp/client API Reference v3.1.0**](../README.md)

***

[@adcp/client API Reference](../globals.md) / AsyncHandlerConfig

# Interface: AsyncHandlerConfig

Defined in: [src/lib/core/AsyncHandler.ts:103](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/AsyncHandler.ts#L103)

Configuration for async handler with typed callbacks

## Properties

### onGetProductsStatusChange()?

> `optional` **onGetProductsStatusChange**: (`response`, `metadata`) => `void` \| `Promise`\<`void`\>

Defined in: [src/lib/core/AsyncHandler.ts:105](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/AsyncHandler.ts#L105)

#### Parameters

##### response

[`GetProductsResponse`](GetProductsResponse.md)

##### metadata

[`WebhookMetadata`](WebhookMetadata.md)

#### Returns

`void` \| `Promise`\<`void`\>

***

### onListCreativeFormatsStatusChange()?

> `optional` **onListCreativeFormatsStatusChange**: (`response`, `metadata`) => `void` \| `Promise`\<`void`\>

Defined in: [src/lib/core/AsyncHandler.ts:106](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/AsyncHandler.ts#L106)

#### Parameters

##### response

[`ListCreativeFormatsResponse`](ListCreativeFormatsResponse.md)

##### metadata

[`WebhookMetadata`](WebhookMetadata.md)

#### Returns

`void` \| `Promise`\<`void`\>

***

### onCreateMediaBuyStatusChange()?

> `optional` **onCreateMediaBuyStatusChange**: (`response`, `metadata`) => `void` \| `Promise`\<`void`\>

Defined in: [src/lib/core/AsyncHandler.ts:110](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/AsyncHandler.ts#L110)

#### Parameters

##### response

[`CreateMediaBuyResponse`](../type-aliases/CreateMediaBuyResponse.md)

##### metadata

[`WebhookMetadata`](WebhookMetadata.md)

#### Returns

`void` \| `Promise`\<`void`\>

***

### onUpdateMediaBuyStatusChange()?

> `optional` **onUpdateMediaBuyStatusChange**: (`response`, `metadata`) => `void` \| `Promise`\<`void`\>

Defined in: [src/lib/core/AsyncHandler.ts:111](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/AsyncHandler.ts#L111)

#### Parameters

##### response

[`UpdateMediaBuyResponse`](../type-aliases/UpdateMediaBuyResponse.md)

##### metadata

[`WebhookMetadata`](WebhookMetadata.md)

#### Returns

`void` \| `Promise`\<`void`\>

***

### onSyncCreativesStatusChange()?

> `optional` **onSyncCreativesStatusChange**: (`response`, `metadata`) => `void` \| `Promise`\<`void`\>

Defined in: [src/lib/core/AsyncHandler.ts:112](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/AsyncHandler.ts#L112)

#### Parameters

##### response

[`SyncCreativesResponse`](../type-aliases/SyncCreativesResponse.md)

##### metadata

[`WebhookMetadata`](WebhookMetadata.md)

#### Returns

`void` \| `Promise`\<`void`\>

***

### onListCreativesStatusChange()?

> `optional` **onListCreativesStatusChange**: (`response`, `metadata`) => `void` \| `Promise`\<`void`\>

Defined in: [src/lib/core/AsyncHandler.ts:113](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/AsyncHandler.ts#L113)

#### Parameters

##### response

[`ListCreativesResponse`](ListCreativesResponse.md)

##### metadata

[`WebhookMetadata`](WebhookMetadata.md)

#### Returns

`void` \| `Promise`\<`void`\>

***

### onPreviewCreativeStatusChange()?

> `optional` **onPreviewCreativeStatusChange**: (`response`, `metadata`) => `void` \| `Promise`\<`void`\>

Defined in: [src/lib/core/AsyncHandler.ts:114](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/AsyncHandler.ts#L114)

#### Parameters

##### response

`PreviewCreativeResponse`

##### metadata

[`WebhookMetadata`](WebhookMetadata.md)

#### Returns

`void` \| `Promise`\<`void`\>

***

### onGetMediaBuyDeliveryStatusChange()?

> `optional` **onGetMediaBuyDeliveryStatusChange**: (`response`, `metadata`) => `void` \| `Promise`\<`void`\>

Defined in: [src/lib/core/AsyncHandler.ts:118](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/AsyncHandler.ts#L118)

#### Parameters

##### response

[`GetMediaBuyDeliveryResponse`](GetMediaBuyDeliveryResponse.md)

##### metadata

[`WebhookMetadata`](WebhookMetadata.md)

#### Returns

`void` \| `Promise`\<`void`\>

***

### onListAuthorizedPropertiesStatusChange()?

> `optional` **onListAuthorizedPropertiesStatusChange**: (`response`, `metadata`) => `void` \| `Promise`\<`void`\>

Defined in: [src/lib/core/AsyncHandler.ts:122](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/AsyncHandler.ts#L122)

#### Parameters

##### response

[`ListAuthorizedPropertiesResponse`](ListAuthorizedPropertiesResponse.md)

##### metadata

[`WebhookMetadata`](WebhookMetadata.md)

#### Returns

`void` \| `Promise`\<`void`\>

***

### onProvidePerformanceFeedbackStatusChange()?

> `optional` **onProvidePerformanceFeedbackStatusChange**: (`response`, `metadata`) => `void` \| `Promise`\<`void`\>

Defined in: [src/lib/core/AsyncHandler.ts:126](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/AsyncHandler.ts#L126)

#### Parameters

##### response

[`ProvidePerformanceFeedbackResponse`](../type-aliases/ProvidePerformanceFeedbackResponse.md)

##### metadata

[`WebhookMetadata`](WebhookMetadata.md)

#### Returns

`void` \| `Promise`\<`void`\>

***

### onGetSignalsStatusChange()?

> `optional` **onGetSignalsStatusChange**: (`response`, `metadata`) => `void` \| `Promise`\<`void`\>

Defined in: [src/lib/core/AsyncHandler.ts:130](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/AsyncHandler.ts#L130)

#### Parameters

##### response

[`GetSignalsResponse`](GetSignalsResponse.md)

##### metadata

[`WebhookMetadata`](WebhookMetadata.md)

#### Returns

`void` \| `Promise`\<`void`\>

***

### onActivateSignalStatusChange()?

> `optional` **onActivateSignalStatusChange**: (`response`, `metadata`) => `void` \| `Promise`\<`void`\>

Defined in: [src/lib/core/AsyncHandler.ts:131](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/AsyncHandler.ts#L131)

#### Parameters

##### response

[`ActivateSignalResponse`](../type-aliases/ActivateSignalResponse.md)

##### metadata

[`WebhookMetadata`](WebhookMetadata.md)

#### Returns

`void` \| `Promise`\<`void`\>

***

### onTaskStatusChange()?

> `optional` **onTaskStatusChange**: (`response`, `metadata`) => `void` \| `Promise`\<`void`\>

Defined in: [src/lib/core/AsyncHandler.ts:134](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/AsyncHandler.ts#L134)

#### Parameters

##### response

`any`

##### metadata

[`WebhookMetadata`](WebhookMetadata.md)

#### Returns

`void` \| `Promise`\<`void`\>

***

### onActivity()?

> `optional` **onActivity**: (`activity`) => `void` \| `Promise`\<`void`\>

Defined in: [src/lib/core/AsyncHandler.ts:137](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/AsyncHandler.ts#L137)

#### Parameters

##### activity

[`Activity`](Activity.md)

#### Returns

`void` \| `Promise`\<`void`\>

***

### onMediaBuyDeliveryNotification()?

> `optional` **onMediaBuyDeliveryNotification**: (`notification`, `metadata`) => `void` \| `Promise`\<`void`\>

Defined in: [src/lib/core/AsyncHandler.ts:140](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/AsyncHandler.ts#L140)

#### Parameters

##### notification

[`MediaBuyDeliveryNotification`](MediaBuyDeliveryNotification.md)

##### metadata

[`NotificationMetadata`](NotificationMetadata.md)

#### Returns

`void` \| `Promise`\<`void`\>
