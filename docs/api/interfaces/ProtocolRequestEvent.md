[**@adcp/client API Reference v3.1.0**](../README.md)

***

[@adcp/client API Reference](../globals.md) / ProtocolRequestEvent

# Interface: ProtocolRequestEvent

Defined in: [src/lib/core/TaskEventTypes.ts:32](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/TaskEventTypes.ts#L32)

Protocol request event - emitted when request is sent

## Extends

- [`BaseTaskEvent`](BaseTaskEvent.md)

## Properties

### operationId

> **operationId**: `string`

Defined in: [src/lib/core/TaskEventTypes.ts:16](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/TaskEventTypes.ts#L16)

Client-generated operation ID - groups related work across multiple agents

#### Inherited from

[`BaseTaskEvent`](BaseTaskEvent.md).[`operationId`](BaseTaskEvent.md#operationid)

***

### agentId

> **agentId**: `string`

Defined in: [src/lib/core/TaskEventTypes.ts:18](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/TaskEventTypes.ts#L18)

Agent ID - which agent is handling this

#### Inherited from

[`BaseTaskEvent`](BaseTaskEvent.md).[`agentId`](BaseTaskEvent.md#agentid)

***

### contextId?

> `optional` **contextId**: `string`

Defined in: [src/lib/core/TaskEventTypes.ts:20](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/TaskEventTypes.ts#L20)

Context ID from server - created by agent on first response

#### Inherited from

[`BaseTaskEvent`](BaseTaskEvent.md).[`contextId`](BaseTaskEvent.md#contextid)

***

### taskId?

> `optional` **taskId**: `string`

Defined in: [src/lib/core/TaskEventTypes.ts:22](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/TaskEventTypes.ts#L22)

Task ID from server - only present for async operations

#### Inherited from

[`BaseTaskEvent`](BaseTaskEvent.md).[`taskId`](BaseTaskEvent.md#taskid)

***

### taskType

> **taskType**: `string`

Defined in: [src/lib/core/TaskEventTypes.ts:24](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/TaskEventTypes.ts#L24)

Task/tool name

#### Inherited from

[`BaseTaskEvent`](BaseTaskEvent.md).[`taskType`](BaseTaskEvent.md#tasktype)

***

### timestamp

> **timestamp**: `string`

Defined in: [src/lib/core/TaskEventTypes.ts:26](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/TaskEventTypes.ts#L26)

Event timestamp

#### Inherited from

[`BaseTaskEvent`](BaseTaskEvent.md).[`timestamp`](BaseTaskEvent.md#timestamp)

***

### eventType

> **eventType**: `"protocol_request"`

Defined in: [src/lib/core/TaskEventTypes.ts:33](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/TaskEventTypes.ts#L33)

***

### protocol

> **protocol**: `"mcp"` \| `"a2a"`

Defined in: [src/lib/core/TaskEventTypes.ts:34](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/TaskEventTypes.ts#L34)

***

### method

> **method**: `string`

Defined in: [src/lib/core/TaskEventTypes.ts:35](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/TaskEventTypes.ts#L35)

***

### payload

> **payload**: `object`

Defined in: [src/lib/core/TaskEventTypes.ts:36](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/TaskEventTypes.ts#L36)

#### params

> **params**: `Record`\<`string`, `any`\>

#### headers?

> `optional` **headers**: `Record`\<`string`, `string`\>
