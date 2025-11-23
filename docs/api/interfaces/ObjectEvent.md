[**@adcp/client API Reference v3.1.0**](../README.md)

***

[@adcp/client API Reference](../globals.md) / ObjectEvent

# Interface: ObjectEvent

Defined in: [src/lib/core/TaskEventTypes.ts:72](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/TaskEventTypes.ts#L72)

Object tracking event - for tracking individual objects (creatives, products, etc)

## Properties

### operationId

> **operationId**: `string`

Defined in: [src/lib/core/TaskEventTypes.ts:74](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/TaskEventTypes.ts#L74)

Client-generated operation ID

***

### agentId

> **agentId**: `string`

Defined in: [src/lib/core/TaskEventTypes.ts:76](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/TaskEventTypes.ts#L76)

Agent ID

***

### contextId?

> `optional` **contextId**: `string`

Defined in: [src/lib/core/TaskEventTypes.ts:78](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/TaskEventTypes.ts#L78)

Context ID from server (if applicable)

***

### taskId?

> `optional` **taskId**: `string`

Defined in: [src/lib/core/TaskEventTypes.ts:80](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/TaskEventTypes.ts#L80)

Task ID from server (if applicable)

***

### objectType

> **objectType**: `string`

Defined in: [src/lib/core/TaskEventTypes.ts:82](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/TaskEventTypes.ts#L82)

Type of object

***

### objectId?

> `optional` **objectId**: `string`

Defined in: [src/lib/core/TaskEventTypes.ts:84](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/TaskEventTypes.ts#L84)

Object identifier

***

### targetEntity

> **targetEntity**: `string`

Defined in: [src/lib/core/TaskEventTypes.ts:86](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/TaskEventTypes.ts#L86)

Target entity (agent ID, platform, etc)

***

### status

> **status**: `string`

Defined in: [src/lib/core/TaskEventTypes.ts:88](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/TaskEventTypes.ts#L88)

Object status

***

### payload?

> `optional` **payload**: `any`

Defined in: [src/lib/core/TaskEventTypes.ts:90](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/TaskEventTypes.ts#L90)

Object payload/data

***

### timestamp

> **timestamp**: `string`

Defined in: [src/lib/core/TaskEventTypes.ts:92](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/TaskEventTypes.ts#L92)

Event timestamp
