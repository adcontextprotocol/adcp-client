[**@adcp/client API Reference v3.1.0**](../README.md)

***

[@adcp/client API Reference](../globals.md) / GetMediaBuyDeliveryRequest

# Interface: GetMediaBuyDeliveryRequest

Defined in: [src/lib/types/tools.generated.ts:2712](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L2712)

Request parameters for retrieving comprehensive delivery metrics

## Properties

### media\_buy\_ids?

> `optional` **media\_buy\_ids**: `string`[]

Defined in: [src/lib/types/tools.generated.ts:2716](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L2716)

Array of publisher media buy IDs to get delivery data for

***

### buyer\_refs?

> `optional` **buyer\_refs**: `string`[]

Defined in: [src/lib/types/tools.generated.ts:2720](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L2720)

Array of buyer reference IDs to get delivery data for

***

### status\_filter?

> `optional` **status\_filter**: `"active"` \| `"paused"` \| `"completed"` \| `"all"` \| `"pending"` \| `"failed"` \| (`"active"` \| `"paused"` \| `"completed"` \| `"pending"` \| `"failed"`)[]

Defined in: [src/lib/types/tools.generated.ts:2724](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L2724)

Filter by status. Can be a single status or array of statuses

***

### start\_date?

> `optional` **start\_date**: `string`

Defined in: [src/lib/types/tools.generated.ts:2730](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L2730)

Start date for reporting period (YYYY-MM-DD)

***

### end\_date?

> `optional` **end\_date**: `string`

Defined in: [src/lib/types/tools.generated.ts:2734](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L2734)

End date for reporting period (YYYY-MM-DD)

***

### context?

> `optional` **context**: `object`

Defined in: [src/lib/types/tools.generated.ts:2738](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L2738)

Initiator-provided context included in the request payload. Agentsmust echo this value back unchanged in responses and webhooks. Use for UI/session hints, correlation tokens, or tracking metadata.
