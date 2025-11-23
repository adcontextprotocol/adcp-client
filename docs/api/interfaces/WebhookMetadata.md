[**@adcp/client API Reference v3.1.0**](../README.md)

***

[@adcp/client API Reference](../globals.md) / WebhookMetadata

# Interface: WebhookMetadata

Defined in: [src/lib/core/AsyncHandler.ts:24](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/AsyncHandler.ts#L24)

Metadata provided with webhook responses

## Extended by

- [`NotificationMetadata`](NotificationMetadata.md)

## Properties

### operation\_id

> **operation\_id**: `string`

Defined in: [src/lib/core/AsyncHandler.ts:26](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/AsyncHandler.ts#L26)

Client-provided operation ID

***

### context\_id?

> `optional` **context\_id**: `string`

Defined in: [src/lib/core/AsyncHandler.ts:28](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/AsyncHandler.ts#L28)

Server's context ID

***

### task\_id?

> `optional` **task\_id**: `string`

Defined in: [src/lib/core/AsyncHandler.ts:30](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/AsyncHandler.ts#L30)

Server's task ID

***

### agent\_id

> **agent\_id**: `string`

Defined in: [src/lib/core/AsyncHandler.ts:32](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/AsyncHandler.ts#L32)

Agent ID

***

### task\_type

> **task\_type**: `string`

Defined in: [src/lib/core/AsyncHandler.ts:34](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/AsyncHandler.ts#L34)

Task type/tool name

***

### status?

> `optional` **status**: `string`

Defined in: [src/lib/core/AsyncHandler.ts:36](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/AsyncHandler.ts#L36)

Task status (completed, failed, needs_input, working, etc)

***

### error?

> `optional` **error**: `string`

Defined in: [src/lib/core/AsyncHandler.ts:38](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/AsyncHandler.ts#L38)

Error message if status is failed

***

### timestamp

> **timestamp**: `string`

Defined in: [src/lib/core/AsyncHandler.ts:40](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/AsyncHandler.ts#L40)

Timestamp
