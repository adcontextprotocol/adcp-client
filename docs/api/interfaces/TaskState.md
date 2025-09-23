[**@adcp/client API Reference v2.0.0**](../README.md)

***

[@adcp/client API Reference](../README.md) / TaskState

# Interface: TaskState

Defined in: [src/lib/core/ConversationTypes.ts:128](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/core/ConversationTypes.ts#L128)

Internal task state for tracking execution

## Properties

### taskId

> **taskId**: `string`

Defined in: [src/lib/core/ConversationTypes.ts:130](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/core/ConversationTypes.ts#L130)

Unique task identifier

***

### taskName

> **taskName**: `string`

Defined in: [src/lib/core/ConversationTypes.ts:132](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/core/ConversationTypes.ts#L132)

Task name (tool name)

***

### params

> **params**: `any`

Defined in: [src/lib/core/ConversationTypes.ts:134](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/core/ConversationTypes.ts#L134)

Original parameters

***

### status

> **status**: [`TaskStatus`](../type-aliases/TaskStatus.md)

Defined in: [src/lib/core/ConversationTypes.ts:136](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/core/ConversationTypes.ts#L136)

Current status

***

### messages

> **messages**: [`Message`](Message.md)[]

Defined in: [src/lib/core/ConversationTypes.ts:138](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/core/ConversationTypes.ts#L138)

Message history

***

### pendingInput?

> `optional` **pendingInput**: [`InputRequest`](InputRequest.md)

Defined in: [src/lib/core/ConversationTypes.ts:140](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/core/ConversationTypes.ts#L140)

Current input request (if waiting for input)

***

### startTime

> **startTime**: `number`

Defined in: [src/lib/core/ConversationTypes.ts:142](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/core/ConversationTypes.ts#L142)

Start time

***

### attempt

> **attempt**: `number`

Defined in: [src/lib/core/ConversationTypes.ts:144](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/core/ConversationTypes.ts#L144)

Current attempt number

***

### maxAttempts

> **maxAttempts**: `number`

Defined in: [src/lib/core/ConversationTypes.ts:146](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/core/ConversationTypes.ts#L146)

Maximum attempts allowed

***

### options

> **options**: [`TaskOptions`](TaskOptions.md)

Defined in: [src/lib/core/ConversationTypes.ts:148](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/core/ConversationTypes.ts#L148)

Task options

***

### agent

> **agent**: `object`

Defined in: [src/lib/core/ConversationTypes.ts:150](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/core/ConversationTypes.ts#L150)

Agent configuration

#### id

> **id**: `string`

#### name

> **name**: `string`

#### protocol

> **protocol**: `"mcp"` \| `"a2a"`
