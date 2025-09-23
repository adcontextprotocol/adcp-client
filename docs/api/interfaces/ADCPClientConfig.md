[**@adcp/client API Reference v2.0.0**](../README.md)

***

[@adcp/client API Reference](../README.md) / ADCPClientConfig

# Interface: ADCPClientConfig

Defined in: [src/lib/core/ADCPClient.ts:40](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/core/ADCPClient.ts#L40)

Configuration for ADCPClient

## Extends

- [`ConversationConfig`](ConversationConfig.md)

## Properties

### debug?

> `optional` **debug**: `boolean`

Defined in: [src/lib/core/ADCPClient.ts:42](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/core/ADCPClient.ts#L42)

Enable debug logging

***

### userAgent?

> `optional` **userAgent**: `string`

Defined in: [src/lib/core/ADCPClient.ts:44](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/core/ADCPClient.ts#L44)

Custom user agent string

***

### headers?

> `optional` **headers**: `Record`\<`string`, `string`\>

Defined in: [src/lib/core/ADCPClient.ts:46](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/core/ADCPClient.ts#L46)

Additional headers to include in requests

***

### maxHistorySize?

> `optional` **maxHistorySize**: `number`

Defined in: [src/lib/core/ConversationTypes.ts:250](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/core/ConversationTypes.ts#L250)

Maximum messages to keep in history

#### Inherited from

[`ConversationConfig`](ConversationConfig.md).[`maxHistorySize`](ConversationConfig.md#maxhistorysize)

***

### persistConversations?

> `optional` **persistConversations**: `boolean`

Defined in: [src/lib/core/ConversationTypes.ts:252](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/core/ConversationTypes.ts#L252)

Whether to persist conversations

#### Inherited from

[`ConversationConfig`](ConversationConfig.md).[`persistConversations`](ConversationConfig.md#persistconversations)

***

### workingTimeout?

> `optional` **workingTimeout**: `number`

Defined in: [src/lib/core/ConversationTypes.ts:254](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/core/ConversationTypes.ts#L254)

Timeout for 'working' status (max 120s per PR #78)

#### Inherited from

[`ConversationConfig`](ConversationConfig.md).[`workingTimeout`](ConversationConfig.md#workingtimeout)

***

### defaultMaxClarifications?

> `optional` **defaultMaxClarifications**: `number`

Defined in: [src/lib/core/ConversationTypes.ts:256](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/core/ConversationTypes.ts#L256)

Default max clarifications

#### Inherited from

[`ConversationConfig`](ConversationConfig.md).[`defaultMaxClarifications`](ConversationConfig.md#defaultmaxclarifications)
