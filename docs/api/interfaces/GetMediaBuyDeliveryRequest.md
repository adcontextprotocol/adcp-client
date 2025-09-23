[**@adcp/client API Reference v2.0.0**](../README.md)

***

[@adcp/client API Reference](../README.md) / GetMediaBuyDeliveryRequest

# Interface: GetMediaBuyDeliveryRequest

Defined in: [src/lib/types/tools.generated.ts:1262](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/types/tools.generated.ts#L1262)

Request parameters for retrieving comprehensive delivery metrics

## Properties

### adcp\_version?

> `optional` **adcp\_version**: `string`

Defined in: [src/lib/types/tools.generated.ts:1266](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/types/tools.generated.ts#L1266)

AdCP schema version for this request

***

### media\_buy\_ids?

> `optional` **media\_buy\_ids**: `string`[]

Defined in: [src/lib/types/tools.generated.ts:1270](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/types/tools.generated.ts#L1270)

Array of publisher media buy IDs to get delivery data for

***

### buyer\_refs?

> `optional` **buyer\_refs**: `string`[]

Defined in: [src/lib/types/tools.generated.ts:1274](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/types/tools.generated.ts#L1274)

Array of buyer reference IDs to get delivery data for

***

### status\_filter?

> `optional` **status\_filter**: `"active"` \| `"paused"` \| `"completed"` \| `"pending"` \| `"failed"` \| `"all"` \| (`"active"` \| `"paused"` \| `"completed"` \| `"pending"` \| `"failed"`)[]

Defined in: [src/lib/types/tools.generated.ts:1278](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/types/tools.generated.ts#L1278)

Filter by status. Can be a single status or array of statuses

***

### start\_date?

> `optional` **start\_date**: `string`

Defined in: [src/lib/types/tools.generated.ts:1284](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/types/tools.generated.ts#L1284)

Start date for reporting period (YYYY-MM-DD)

***

### end\_date?

> `optional` **end\_date**: `string`

Defined in: [src/lib/types/tools.generated.ts:1288](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/types/tools.generated.ts#L1288)

End date for reporting period (YYYY-MM-DD)
