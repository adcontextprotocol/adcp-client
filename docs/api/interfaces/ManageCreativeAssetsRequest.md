[**@adcp/client API Reference v3.1.0**](../README.md)

***

[@adcp/client API Reference](../globals.md) / ManageCreativeAssetsRequest

# Interface: ManageCreativeAssetsRequest

Defined in: [src/lib/types/adcp.ts:266](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/adcp.ts#L266)

## Properties

### action

> **action**: `"upload"` \| `"list"` \| `"update"` \| `"assign"` \| `"unassign"` \| `"delete"`

Defined in: [src/lib/types/adcp.ts:267](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/adcp.ts#L267)

***

### adcp\_version?

> `optional` **adcp\_version**: `string`

Defined in: [src/lib/types/adcp.ts:268](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/adcp.ts#L268)

***

### assets?

> `optional` **assets**: `CreativeAsset`[]

Defined in: [src/lib/types/adcp.ts:270](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/adcp.ts#L270)

***

### filters?

> `optional` **filters**: [`CreativeFilters`](CreativeFilters.md)

Defined in: [src/lib/types/adcp.ts:271](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/adcp.ts#L271)

***

### pagination?

> `optional` **pagination**: [`PaginationOptions`](PaginationOptions.md)

Defined in: [src/lib/types/adcp.ts:272](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/adcp.ts#L272)

***

### creative\_id?

> `optional` **creative\_id**: `string`

Defined in: [src/lib/types/adcp.ts:273](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/adcp.ts#L273)

***

### updates?

> `optional` **updates**: `Partial`\<`CreativeAsset`\>

Defined in: [src/lib/types/adcp.ts:274](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/adcp.ts#L274)

***

### creative\_ids?

> `optional` **creative\_ids**: `string`[]

Defined in: [src/lib/types/adcp.ts:275](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/adcp.ts#L275)

***

### media\_buy\_id?

> `optional` **media\_buy\_id**: `string`

Defined in: [src/lib/types/adcp.ts:276](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/adcp.ts#L276)

***

### buyer\_ref?

> `optional` **buyer\_ref**: `string`

Defined in: [src/lib/types/adcp.ts:277](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/adcp.ts#L277)

***

### package\_assignments?

> `optional` **package\_assignments**: `object`

Defined in: [src/lib/types/adcp.ts:278](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/adcp.ts#L278)

#### Index Signature

\[`creative_id`: `string`\]: `string`[]

***

### package\_ids?

> `optional` **package\_ids**: `string`[]

Defined in: [src/lib/types/adcp.ts:279](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/adcp.ts#L279)

***

### archive?

> `optional` **archive**: `boolean`

Defined in: [src/lib/types/adcp.ts:280](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/adcp.ts#L280)
