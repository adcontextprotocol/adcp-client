[**@adcp/client API Reference v3.1.0**](../README.md)

***

[@adcp/client API Reference](../globals.md) / BaseTaskEvent

# Interface: BaseTaskEvent

Defined in: [src/lib/core/TaskEventTypes.ts:14](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/TaskEventTypes.ts#L14)

Base event structure - all events share these fields

Key identifiers:
- operationId + agentId = YOUR unique identifier for this work
- contextId = server's conversation identifier (server creates this)
- taskId = server's work identifier (server creates this, only for async)

## Extended by

- [`ProtocolRequestEvent`](ProtocolRequestEvent.md)
- [`ProtocolResponseEvent`](ProtocolResponseEvent.md)
- [`TaskStatusEvent`](TaskStatusEvent.md)

## Properties

### operationId

> **operationId**: `string`

Defined in: [src/lib/core/TaskEventTypes.ts:16](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/TaskEventTypes.ts#L16)

Client-generated operation ID - groups related work across multiple agents

***

### agentId

> **agentId**: `string`

Defined in: [src/lib/core/TaskEventTypes.ts:18](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/TaskEventTypes.ts#L18)

Agent ID - which agent is handling this

***

### contextId?

> `optional` **contextId**: `string`

Defined in: [src/lib/core/TaskEventTypes.ts:20](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/TaskEventTypes.ts#L20)

Context ID from server - created by agent on first response

***

### taskId?

> `optional` **taskId**: `string`

Defined in: [src/lib/core/TaskEventTypes.ts:22](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/TaskEventTypes.ts#L22)

Task ID from server - only present for async operations

***

### taskType

> **taskType**: `string`

Defined in: [src/lib/core/TaskEventTypes.ts:24](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/TaskEventTypes.ts#L24)

Task/tool name

***

### timestamp

> **timestamp**: `string`

Defined in: [src/lib/core/TaskEventTypes.ts:26](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/TaskEventTypes.ts#L26)

Event timestamp
