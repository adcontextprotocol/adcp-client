[**@adcp/client API Reference v3.1.0**](../README.md)

***

[@adcp/client API Reference](../globals.md) / Activity

# Interface: Activity

Defined in: [src/lib/core/AsyncHandler.ts:88](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/AsyncHandler.ts#L88)

Activity event for logging/observability

## Properties

### type

> **type**: `"protocol_request"` \| `"protocol_response"` \| `"status_change"` \| `"webhook_received"`

Defined in: [src/lib/core/AsyncHandler.ts:89](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/AsyncHandler.ts#L89)

***

### operation\_id

> **operation\_id**: `string`

Defined in: [src/lib/core/AsyncHandler.ts:90](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/AsyncHandler.ts#L90)

***

### agent\_id

> **agent\_id**: `string`

Defined in: [src/lib/core/AsyncHandler.ts:91](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/AsyncHandler.ts#L91)

***

### context\_id?

> `optional` **context\_id**: `string`

Defined in: [src/lib/core/AsyncHandler.ts:92](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/AsyncHandler.ts#L92)

***

### task\_id?

> `optional` **task\_id**: `string`

Defined in: [src/lib/core/AsyncHandler.ts:93](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/AsyncHandler.ts#L93)

***

### task\_type

> **task\_type**: `string`

Defined in: [src/lib/core/AsyncHandler.ts:94](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/AsyncHandler.ts#L94)

***

### status?

> `optional` **status**: `string`

Defined in: [src/lib/core/AsyncHandler.ts:95](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/AsyncHandler.ts#L95)

***

### payload?

> `optional` **payload**: `any`

Defined in: [src/lib/core/AsyncHandler.ts:96](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/AsyncHandler.ts#L96)

***

### timestamp

> **timestamp**: `string`

Defined in: [src/lib/core/AsyncHandler.ts:97](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/AsyncHandler.ts#L97)
