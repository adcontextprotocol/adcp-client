[**@adcp/client API Reference v3.1.0**](../README.md)

***

[@adcp/client API Reference](../globals.md) / ManageCreativeAssetsResponse

# Interface: ManageCreativeAssetsResponse

Defined in: [src/lib/types/adcp.ts:323](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/adcp.ts#L323)

## Properties

### success

> **success**: `boolean`

Defined in: [src/lib/types/adcp.ts:324](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/adcp.ts#L324)

***

### action

> **action**: `string`

Defined in: [src/lib/types/adcp.ts:325](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/adcp.ts#L325)

***

### results?

> `optional` **results**: `object`

Defined in: [src/lib/types/adcp.ts:326](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/adcp.ts#L326)

#### uploaded?

> `optional` **uploaded**: [`CreativeLibraryItem`](CreativeLibraryItem.md)[]

#### listed?

> `optional` **listed**: `object`

##### listed.creatives

> **creatives**: [`CreativeLibraryItem`](CreativeLibraryItem.md)[]

##### listed.total\_count

> **total\_count**: `number`

##### listed.pagination?

> `optional` **pagination**: `object`

##### listed.pagination.offset

> **offset**: `number`

##### listed.pagination.limit

> **limit**: `number`

##### listed.pagination.has\_more

> **has\_more**: `boolean`

##### listed.pagination.next\_cursor?

> `optional` **next\_cursor**: `string`

#### updated?

> `optional` **updated**: [`CreativeLibraryItem`](CreativeLibraryItem.md)

#### assigned?

> `optional` **assigned**: `object`[]

#### unassigned?

> `optional` **unassigned**: `object`[]

#### deleted?

> `optional` **deleted**: `object`[]

***

### errors?

> `optional` **errors**: `object`[]

Defined in: [src/lib/types/adcp.ts:352](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/adcp.ts#L352)

#### creative\_id?

> `optional` **creative\_id**: `string`

#### error\_code

> **error\_code**: `string`

#### message

> **message**: `string`
