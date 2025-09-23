[**@adcp/client API Reference v2.0.0**](../README.md)

***

[@adcp/client API Reference](../README.md) / TaskResult

# Interface: TaskResult\<T\>

Defined in: [src/lib/core/ConversationTypes.ts:208](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/core/ConversationTypes.ts#L208)

Result of a task execution

## Type Parameters

### T

`T` = `any`

## Properties

### success

> **success**: `boolean`

Defined in: [src/lib/core/ConversationTypes.ts:210](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/core/ConversationTypes.ts#L210)

Whether the task completed successfully

***

### status

> **status**: `"completed"` \| `"submitted"` \| `"deferred"`

Defined in: [src/lib/core/ConversationTypes.ts:212](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/core/ConversationTypes.ts#L212)

Task execution status

***

### data?

> `optional` **data**: `T`

Defined in: [src/lib/core/ConversationTypes.ts:214](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/core/ConversationTypes.ts#L214)

Task result data (if successful)

***

### error?

> `optional` **error**: `string`

Defined in: [src/lib/core/ConversationTypes.ts:216](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/core/ConversationTypes.ts#L216)

Error message (if failed)

***

### deferred?

> `optional` **deferred**: `DeferredContinuation`\<`T`\>

Defined in: [src/lib/core/ConversationTypes.ts:218](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/core/ConversationTypes.ts#L218)

Deferred continuation (client needs time for input)

***

### submitted?

> `optional` **submitted**: `SubmittedContinuation`\<`T`\>

Defined in: [src/lib/core/ConversationTypes.ts:220](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/core/ConversationTypes.ts#L220)

Submitted continuation (server needs time for processing)

***

### metadata

> **metadata**: `object`

Defined in: [src/lib/core/ConversationTypes.ts:222](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/core/ConversationTypes.ts#L222)

Task execution metadata

#### taskId

> **taskId**: `string`

#### taskName

> **taskName**: `string`

#### agent

> **agent**: `object`

##### agent.id

> **id**: `string`

##### agent.name

> **name**: `string`

##### agent.protocol

> **protocol**: `"mcp"` \| `"a2a"`

#### responseTimeMs

> **responseTimeMs**: `number`

Total execution time in milliseconds

#### timestamp

> **timestamp**: `string`

ISO timestamp of completion

#### clarificationRounds

> **clarificationRounds**: `number`

Number of clarification rounds

#### status

> **status**: [`TaskStatus`](../type-aliases/TaskStatus.md)

Final status

***

### conversation?

> `optional` **conversation**: [`Message`](Message.md)[]

Defined in: [src/lib/core/ConversationTypes.ts:240](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/core/ConversationTypes.ts#L240)

Full conversation history

***

### debugLogs?

> `optional` **debugLogs**: `any`[]

Defined in: [src/lib/core/ConversationTypes.ts:242](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/core/ConversationTypes.ts#L242)

Debug logs (if debug enabled)
