[**@adcp/client API Reference v3.1.0**](../README.md)

***

[@adcp/client API Reference](../globals.md) / ConversationConfig

# Interface: ConversationConfig

Defined in: [src/lib/core/ConversationTypes.ts:256](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ConversationTypes.ts#L256)

Configuration for conversation management

## Extended by

- [`SingleAgentClientConfig`](SingleAgentClientConfig.md)

## Properties

### maxHistorySize?

> `optional` **maxHistorySize**: `number`

Defined in: [src/lib/core/ConversationTypes.ts:258](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ConversationTypes.ts#L258)

Maximum messages to keep in history

***

### persistConversations?

> `optional` **persistConversations**: `boolean`

Defined in: [src/lib/core/ConversationTypes.ts:260](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ConversationTypes.ts#L260)

Whether to persist conversations

***

### workingTimeout?

> `optional` **workingTimeout**: `number`

Defined in: [src/lib/core/ConversationTypes.ts:262](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ConversationTypes.ts#L262)

Timeout for 'working' status (max 120s per PR #78)

***

### defaultMaxClarifications?

> `optional` **defaultMaxClarifications**: `number`

Defined in: [src/lib/core/ConversationTypes.ts:264](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ConversationTypes.ts#L264)

Default max clarifications
