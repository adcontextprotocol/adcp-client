[**@adcp/client API Reference v3.1.0**](../README.md)

***

[@adcp/client API Reference](../globals.md) / CreativeLibraryItem

# Interface: CreativeLibraryItem

Defined in: [src/lib/types/adcp.ts:220](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/adcp.ts#L220)

## Properties

### creative\_id

> **creative\_id**: `string`

Defined in: [src/lib/types/adcp.ts:221](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/adcp.ts#L221)

***

### name

> **name**: `string`

Defined in: [src/lib/types/adcp.ts:222](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/adcp.ts#L222)

***

### format

> **format**: `string`

Defined in: [src/lib/types/adcp.ts:223](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/adcp.ts#L223)

***

### type

> **type**: `"image"` \| `"video"` \| `"html"` \| `"native"`

Defined in: [src/lib/types/adcp.ts:224](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/adcp.ts#L224)

***

### media\_url?

> `optional` **media\_url**: `string`

Defined in: [src/lib/types/adcp.ts:226](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/adcp.ts#L226)

***

### snippet?

> `optional` **snippet**: `string`

Defined in: [src/lib/types/adcp.ts:227](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/adcp.ts#L227)

***

### snippet\_type?

> `optional` **snippet\_type**: `"html"` \| `"javascript"` \| `"amp"`

Defined in: [src/lib/types/adcp.ts:228](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/adcp.ts#L228)

***

### dimensions?

> `optional` **dimensions**: `object`

Defined in: [src/lib/types/adcp.ts:230](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/adcp.ts#L230)

#### width

> **width**: `number`

#### height

> **height**: `number`

***

### file\_size?

> `optional` **file\_size**: `number`

Defined in: [src/lib/types/adcp.ts:234](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/adcp.ts#L234)

***

### duration?

> `optional` **duration**: `number`

Defined in: [src/lib/types/adcp.ts:235](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/adcp.ts#L235)

***

### tags?

> `optional` **tags**: `string`[]

Defined in: [src/lib/types/adcp.ts:236](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/adcp.ts#L236)

***

### status

> **status**: `"active"` \| `"inactive"` \| `"pending_review"` \| `"approved"` \| `"rejected"`

Defined in: [src/lib/types/adcp.ts:237](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/adcp.ts#L237)

***

### created\_date

> **created\_date**: `string`

Defined in: [src/lib/types/adcp.ts:239](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/adcp.ts#L239)

***

### last\_updated

> **last\_updated**: `string`

Defined in: [src/lib/types/adcp.ts:240](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/adcp.ts#L240)

***

### assignments

> **assignments**: `string`[]

Defined in: [src/lib/types/adcp.ts:241](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/adcp.ts#L241)

***

### assignment\_count

> **assignment\_count**: `number`

Defined in: [src/lib/types/adcp.ts:242](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/adcp.ts#L242)

***

### performance\_metrics?

> `optional` **performance\_metrics**: [`CreativePerformanceMetrics`](CreativePerformanceMetrics.md)

Defined in: [src/lib/types/adcp.ts:243](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/adcp.ts#L243)

***

### compliance?

> `optional` **compliance**: [`CreativeComplianceData`](CreativeComplianceData.md)

Defined in: [src/lib/types/adcp.ts:244](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/adcp.ts#L244)

***

### sub\_assets?

> `optional` **sub\_assets**: [`CreativeSubAsset`](CreativeSubAsset.md)[]

Defined in: [src/lib/types/adcp.ts:245](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/adcp.ts#L245)
