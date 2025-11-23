[**@adcp/client API Reference v3.1.0**](../README.md)

***

[@adcp/client API Reference](../globals.md) / NotificationMetadata

# Interface: NotificationMetadata

Defined in: [src/lib/core/AsyncHandler.ts:47](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/AsyncHandler.ts#L47)

Metadata for agent-initiated notifications
Same as WebhookMetadata but includes notification-specific fields

## Extends

- [`WebhookMetadata`](WebhookMetadata.md)

## Properties

### operation\_id

> **operation\_id**: `string`

Defined in: [src/lib/core/AsyncHandler.ts:26](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/AsyncHandler.ts#L26)

Client-provided operation ID

#### Inherited from

[`WebhookMetadata`](WebhookMetadata.md).[`operation_id`](WebhookMetadata.md#operation_id)

***

### context\_id?

> `optional` **context\_id**: `string`

Defined in: [src/lib/core/AsyncHandler.ts:28](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/AsyncHandler.ts#L28)

Server's context ID

#### Inherited from

[`WebhookMetadata`](WebhookMetadata.md).[`context_id`](WebhookMetadata.md#context_id)

***

### task\_id?

> `optional` **task\_id**: `string`

Defined in: [src/lib/core/AsyncHandler.ts:30](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/AsyncHandler.ts#L30)

Server's task ID

#### Inherited from

[`WebhookMetadata`](WebhookMetadata.md).[`task_id`](WebhookMetadata.md#task_id)

***

### agent\_id

> **agent\_id**: `string`

Defined in: [src/lib/core/AsyncHandler.ts:32](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/AsyncHandler.ts#L32)

Agent ID

#### Inherited from

[`WebhookMetadata`](WebhookMetadata.md).[`agent_id`](WebhookMetadata.md#agent_id)

***

### task\_type

> **task\_type**: `string`

Defined in: [src/lib/core/AsyncHandler.ts:34](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/AsyncHandler.ts#L34)

Task type/tool name

#### Inherited from

[`WebhookMetadata`](WebhookMetadata.md).[`task_type`](WebhookMetadata.md#task_type)

***

### status?

> `optional` **status**: `string`

Defined in: [src/lib/core/AsyncHandler.ts:36](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/AsyncHandler.ts#L36)

Task status (completed, failed, needs_input, working, etc)

#### Inherited from

[`WebhookMetadata`](WebhookMetadata.md).[`status`](WebhookMetadata.md#status)

***

### error?

> `optional` **error**: `string`

Defined in: [src/lib/core/AsyncHandler.ts:38](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/AsyncHandler.ts#L38)

Error message if status is failed

#### Inherited from

[`WebhookMetadata`](WebhookMetadata.md).[`error`](WebhookMetadata.md#error)

***

### timestamp

> **timestamp**: `string`

Defined in: [src/lib/core/AsyncHandler.ts:40](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/AsyncHandler.ts#L40)

Timestamp

#### Inherited from

[`WebhookMetadata`](WebhookMetadata.md).[`timestamp`](WebhookMetadata.md#timestamp)

***

### notification\_type

> **notification\_type**: `"scheduled"` \| `"final"` \| `"delayed"`

Defined in: [src/lib/core/AsyncHandler.ts:49](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/AsyncHandler.ts#L49)

Notification type

***

### sequence\_number?

> `optional` **sequence\_number**: `number`

Defined in: [src/lib/core/AsyncHandler.ts:51](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/AsyncHandler.ts#L51)

Sequence number of this notification

***

### next\_expected\_at?

> `optional` **next\_expected\_at**: `string`

Defined in: [src/lib/core/AsyncHandler.ts:53](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/AsyncHandler.ts#L53)

When next notification is expected (not present for 'final')
