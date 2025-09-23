[**@adcp/client API Reference v2.0.0**](../README.md)

***

[@adcp/client API Reference](../README.md) / ManageCreativeAssetsRequest

# Interface: ManageCreativeAssetsRequest

Defined in: [src/lib/types/adcp.ts:265](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/types/adcp.ts#L265)

## Properties

### action

> **action**: `"upload"` \| `"list"` \| `"update"` \| `"assign"` \| `"unassign"` \| `"delete"`

Defined in: [src/lib/types/adcp.ts:266](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/types/adcp.ts#L266)

***

### adcp\_version?

> `optional` **adcp\_version**: `string`

Defined in: [src/lib/types/adcp.ts:267](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/types/adcp.ts#L267)

***

### assets?

> `optional` **assets**: [`CreativeAsset`](CreativeAsset.md)[]

Defined in: [src/lib/types/adcp.ts:269](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/types/adcp.ts#L269)

***

### filters?

> `optional` **filters**: [`CreativeFilters`](CreativeFilters.md)

Defined in: [src/lib/types/adcp.ts:270](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/types/adcp.ts#L270)

***

### pagination?

> `optional` **pagination**: [`PaginationOptions`](PaginationOptions.md)

Defined in: [src/lib/types/adcp.ts:271](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/types/adcp.ts#L271)

***

### creative\_id?

> `optional` **creative\_id**: `string`

Defined in: [src/lib/types/adcp.ts:272](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/types/adcp.ts#L272)

***

### updates?

> `optional` **updates**: `Partial`\<[`CreativeAsset`](CreativeAsset.md)\>

Defined in: [src/lib/types/adcp.ts:273](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/types/adcp.ts#L273)

***

### creative\_ids?

> `optional` **creative\_ids**: `string`[]

Defined in: [src/lib/types/adcp.ts:274](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/types/adcp.ts#L274)

***

### media\_buy\_id?

> `optional` **media\_buy\_id**: `string`

Defined in: [src/lib/types/adcp.ts:275](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/types/adcp.ts#L275)

***

### buyer\_ref?

> `optional` **buyer\_ref**: `string`

Defined in: [src/lib/types/adcp.ts:276](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/types/adcp.ts#L276)

***

### package\_assignments?

> `optional` **package\_assignments**: `object`

Defined in: [src/lib/types/adcp.ts:277](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/types/adcp.ts#L277)

#### Index Signature

\[`creative_id`: `string`\]: `string`[]

***

### package\_ids?

> `optional` **package\_ids**: `string`[]

Defined in: [src/lib/types/adcp.ts:278](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/types/adcp.ts#L278)

***

### archive?

> `optional` **archive**: `boolean`

Defined in: [src/lib/types/adcp.ts:279](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/types/adcp.ts#L279)
