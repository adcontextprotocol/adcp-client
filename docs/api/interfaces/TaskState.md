[**@adcp/client API Reference v3.1.0**](../README.md)

***

[@adcp/client API Reference](../globals.md) / TaskState

# Interface: TaskState

Defined in: [src/lib/core/ConversationTypes.ts:136](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ConversationTypes.ts#L136)

Internal task state for tracking execution

## Properties

### taskId

> **taskId**: `string`

Defined in: [src/lib/core/ConversationTypes.ts:138](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ConversationTypes.ts#L138)

Unique task identifier

***

### taskName

> **taskName**: `string`

Defined in: [src/lib/core/ConversationTypes.ts:140](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ConversationTypes.ts#L140)

Task name (tool name)

***

### params

> **params**: `any`

Defined in: [src/lib/core/ConversationTypes.ts:142](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ConversationTypes.ts#L142)

Original parameters

***

### status

> **status**: [`TaskStatus`](../type-aliases/TaskStatus.md)

Defined in: [src/lib/core/ConversationTypes.ts:144](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ConversationTypes.ts#L144)

Current status

***

### messages

> **messages**: [`Message`](Message.md)[]

Defined in: [src/lib/core/ConversationTypes.ts:146](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ConversationTypes.ts#L146)

Message history

***

### pendingInput?

> `optional` **pendingInput**: [`InputRequest`](InputRequest.md)

Defined in: [src/lib/core/ConversationTypes.ts:148](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ConversationTypes.ts#L148)

Current input request (if waiting for input)

***

### startTime

> **startTime**: `number`

Defined in: [src/lib/core/ConversationTypes.ts:150](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ConversationTypes.ts#L150)

Start time

***

### attempt

> **attempt**: `number`

Defined in: [src/lib/core/ConversationTypes.ts:152](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ConversationTypes.ts#L152)

Current attempt number

***

### maxAttempts

> **maxAttempts**: `number`

Defined in: [src/lib/core/ConversationTypes.ts:154](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ConversationTypes.ts#L154)

Maximum attempts allowed

***

### options

> **options**: [`TaskOptions`](TaskOptions.md)

Defined in: [src/lib/core/ConversationTypes.ts:156](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ConversationTypes.ts#L156)

Task options

***

### agent

> **agent**: `object`

Defined in: [src/lib/core/ConversationTypes.ts:158](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ConversationTypes.ts#L158)

Agent configuration

#### id

> **id**: `string`

#### name

> **name**: `string`

#### protocol

> **protocol**: `"mcp"` \| `"a2a"`
