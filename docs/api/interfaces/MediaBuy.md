[**@adcp/client API Reference v3.1.0**](../README.md)

***

[@adcp/client API Reference](../globals.md) / MediaBuy

# Interface: MediaBuy

Defined in: [src/lib/types/adcp.ts:7](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/adcp.ts#L7)

## Properties

### id

> **id**: `string`

Defined in: [src/lib/types/adcp.ts:8](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/adcp.ts#L8)

***

### campaign\_name?

> `optional` **campaign\_name**: `string`

Defined in: [src/lib/types/adcp.ts:9](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/adcp.ts#L9)

***

### advertiser\_name?

> `optional` **advertiser\_name**: `string`

Defined in: [src/lib/types/adcp.ts:10](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/adcp.ts#L10)

***

### status

> **status**: `"active"` \| `"paused"` \| `"completed"` \| `"cancelled"`

Defined in: [src/lib/types/adcp.ts:11](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/adcp.ts#L11)

***

### total\_budget

> **total\_budget**: `number`

Defined in: [src/lib/types/adcp.ts:13](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/adcp.ts#L13)

Total budget amount (currency determined by pricing options)

***

### targeting

> **targeting**: [`Targeting`](Targeting.md)

Defined in: [src/lib/types/adcp.ts:14](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/adcp.ts#L14)

***

### creative\_assets

> **creative\_assets**: `CreativeAsset`[]

Defined in: [src/lib/types/adcp.ts:15](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/adcp.ts#L15)

***

### delivery\_schedule

> **delivery\_schedule**: [`DeliverySchedule`](DeliverySchedule.md)

Defined in: [src/lib/types/adcp.ts:16](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/adcp.ts#L16)

***

### created\_at

> **created\_at**: `string`

Defined in: [src/lib/types/adcp.ts:17](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/adcp.ts#L17)

***

### updated\_at

> **updated\_at**: `string`

Defined in: [src/lib/types/adcp.ts:18](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/adcp.ts#L18)
