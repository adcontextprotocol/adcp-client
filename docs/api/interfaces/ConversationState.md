[**@adcp/client API Reference v2.0.0**](../README.md)

***

[@adcp/client API Reference](../README.md) / ConversationState

# Interface: ConversationState

Defined in: [src/lib/storage/interfaces.ts:80](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/storage/interfaces.ts#L80)

Conversation state for persistence

## Properties

### conversationId

> **conversationId**: `string`

Defined in: [src/lib/storage/interfaces.ts:82](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/storage/interfaces.ts#L82)

Conversation ID

***

### agentId

> **agentId**: `string`

Defined in: [src/lib/storage/interfaces.ts:84](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/storage/interfaces.ts#L84)

Agent ID

***

### messages

> **messages**: `object`[]

Defined in: [src/lib/storage/interfaces.ts:86](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/storage/interfaces.ts#L86)

Message history

#### id

> **id**: `string`

#### role

> **role**: `"user"` \| `"agent"` \| `"system"`

#### content

> **content**: `any`

#### timestamp

> **timestamp**: `string`

#### metadata?

> `optional` **metadata**: `Record`\<`string`, `any`\>

***

### currentTask?

> `optional` **currentTask**: `object`

Defined in: [src/lib/storage/interfaces.ts:94](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/storage/interfaces.ts#L94)

Current task information

#### taskId

> **taskId**: `string`

#### taskName

> **taskName**: `string`

#### status

> **status**: `string`

#### params

> **params**: `any`

***

### createdAt

> **createdAt**: `string`

Defined in: [src/lib/storage/interfaces.ts:101](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/storage/interfaces.ts#L101)

When conversation was created

***

### updatedAt

> **updatedAt**: `string`

Defined in: [src/lib/storage/interfaces.ts:103](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/storage/interfaces.ts#L103)

When conversation was last updated

***

### metadata?

> `optional` **metadata**: `Record`\<`string`, `any`\>

Defined in: [src/lib/storage/interfaces.ts:105](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/storage/interfaces.ts#L105)

Additional metadata
