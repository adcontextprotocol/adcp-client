[**@adcp/client API Reference v3.1.0**](../README.md)

***

[@adcp/client API Reference](../globals.md) / TaskResult

# Interface: TaskResult\<T\>

Defined in: [src/lib/core/ConversationTypes.ts:216](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ConversationTypes.ts#L216)

Result of a task execution

## Type Parameters

### T

`T` = `any`

## Properties

### success

> **success**: `boolean`

Defined in: [src/lib/core/ConversationTypes.ts:218](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ConversationTypes.ts#L218)

Whether the task completed successfully

***

### status

> **status**: `"completed"` \| `"deferred"` \| `"submitted"`

Defined in: [src/lib/core/ConversationTypes.ts:220](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ConversationTypes.ts#L220)

Task execution status

***

### data?

> `optional` **data**: `T`

Defined in: [src/lib/core/ConversationTypes.ts:222](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ConversationTypes.ts#L222)

Task result data (if successful)

***

### error?

> `optional` **error**: `string`

Defined in: [src/lib/core/ConversationTypes.ts:224](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ConversationTypes.ts#L224)

Error message (if failed)

***

### deferred?

> `optional` **deferred**: `DeferredContinuation`\<`T`\>

Defined in: [src/lib/core/ConversationTypes.ts:226](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ConversationTypes.ts#L226)

Deferred continuation (client needs time for input)

***

### submitted?

> `optional` **submitted**: `SubmittedContinuation`\<`T`\>

Defined in: [src/lib/core/ConversationTypes.ts:228](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ConversationTypes.ts#L228)

Submitted continuation (server needs time for processing)

***

### metadata

> **metadata**: `object`

Defined in: [src/lib/core/ConversationTypes.ts:230](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ConversationTypes.ts#L230)

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

Defined in: [src/lib/core/ConversationTypes.ts:248](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ConversationTypes.ts#L248)

Full conversation history

***

### debug\_logs?

> `optional` **debug\_logs**: `any`[]

Defined in: [src/lib/core/ConversationTypes.ts:250](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ConversationTypes.ts#L250)

Debug logs (if debug enabled)
