[**@adcp/client API Reference v2.0.0**](../README.md)

***

[@adcp/client API Reference](../README.md) / ConversationConfig

# Interface: ConversationConfig

Defined in: [src/lib/core/ConversationTypes.ts:248](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/core/ConversationTypes.ts#L248)

Configuration for conversation management

## Extended by

- [`ADCPClientConfig`](ADCPClientConfig.md)

## Properties

### maxHistorySize?

> `optional` **maxHistorySize**: `number`

Defined in: [src/lib/core/ConversationTypes.ts:250](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/core/ConversationTypes.ts#L250)

Maximum messages to keep in history

***

### persistConversations?

> `optional` **persistConversations**: `boolean`

Defined in: [src/lib/core/ConversationTypes.ts:252](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/core/ConversationTypes.ts#L252)

Whether to persist conversations

***

### workingTimeout?

> `optional` **workingTimeout**: `number`

Defined in: [src/lib/core/ConversationTypes.ts:254](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/core/ConversationTypes.ts#L254)

Timeout for 'working' status (max 120s per PR #78)

***

### defaultMaxClarifications?

> `optional` **defaultMaxClarifications**: `number`

Defined in: [src/lib/core/ConversationTypes.ts:256](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/core/ConversationTypes.ts#L256)

Default max clarifications
