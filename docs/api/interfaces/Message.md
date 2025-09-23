[**@adcp/client API Reference v2.0.0**](../README.md)

***

[@adcp/client API Reference](../README.md) / Message

# Interface: Message

Defined in: [src/lib/core/ConversationTypes.ts:7](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/core/ConversationTypes.ts#L7)

Represents a single message in a conversation with an agent

## Properties

### id

> **id**: `string`

Defined in: [src/lib/core/ConversationTypes.ts:9](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/core/ConversationTypes.ts#L9)

Unique identifier for this message

***

### role

> **role**: `"user"` \| `"agent"` \| `"system"`

Defined in: [src/lib/core/ConversationTypes.ts:11](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/core/ConversationTypes.ts#L11)

Role of the message sender

***

### content

> **content**: `any`

Defined in: [src/lib/core/ConversationTypes.ts:13](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/core/ConversationTypes.ts#L13)

Message content - can be structured or text

***

### timestamp

> **timestamp**: `string`

Defined in: [src/lib/core/ConversationTypes.ts:15](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/core/ConversationTypes.ts#L15)

Timestamp when message was created

***

### metadata?

> `optional` **metadata**: `object`

Defined in: [src/lib/core/ConversationTypes.ts:17](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/core/ConversationTypes.ts#L17)

Optional metadata about the message

#### Index Signature

\[`key`: `string`\]: `any`

Additional context data

#### toolName?

> `optional` **toolName**: `string`

Tool/task name if this message is tool-related

#### type?

> `optional` **type**: `string`

Message type (request, response, clarification, etc.)
