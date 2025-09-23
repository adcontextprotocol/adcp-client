[**@adcp/client API Reference v2.0.0**](../README.md)

***

[@adcp/client API Reference](../README.md) / CreativeLibraryItem

# Interface: CreativeLibraryItem

Defined in: [src/lib/types/adcp.ts:219](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/types/adcp.ts#L219)

## Properties

### creative\_id

> **creative\_id**: `string`

Defined in: [src/lib/types/adcp.ts:220](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/types/adcp.ts#L220)

***

### name

> **name**: `string`

Defined in: [src/lib/types/adcp.ts:221](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/types/adcp.ts#L221)

***

### format

> **format**: `string`

Defined in: [src/lib/types/adcp.ts:222](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/types/adcp.ts#L222)

***

### type

> **type**: `"image"` \| `"video"` \| `"html"` \| `"native"`

Defined in: [src/lib/types/adcp.ts:223](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/types/adcp.ts#L223)

***

### media\_url?

> `optional` **media\_url**: `string`

Defined in: [src/lib/types/adcp.ts:225](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/types/adcp.ts#L225)

***

### snippet?

> `optional` **snippet**: `string`

Defined in: [src/lib/types/adcp.ts:226](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/types/adcp.ts#L226)

***

### snippet\_type?

> `optional` **snippet\_type**: `"html"` \| `"javascript"` \| `"amp"`

Defined in: [src/lib/types/adcp.ts:227](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/types/adcp.ts#L227)

***

### dimensions?

> `optional` **dimensions**: `object`

Defined in: [src/lib/types/adcp.ts:229](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/types/adcp.ts#L229)

#### width

> **width**: `number`

#### height

> **height**: `number`

***

### file\_size?

> `optional` **file\_size**: `number`

Defined in: [src/lib/types/adcp.ts:233](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/types/adcp.ts#L233)

***

### duration?

> `optional` **duration**: `number`

Defined in: [src/lib/types/adcp.ts:234](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/types/adcp.ts#L234)

***

### tags?

> `optional` **tags**: `string`[]

Defined in: [src/lib/types/adcp.ts:235](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/types/adcp.ts#L235)

***

### status

> **status**: `"active"` \| `"inactive"` \| `"pending_review"` \| `"approved"` \| `"rejected"`

Defined in: [src/lib/types/adcp.ts:236](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/types/adcp.ts#L236)

***

### created\_date

> **created\_date**: `string`

Defined in: [src/lib/types/adcp.ts:238](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/types/adcp.ts#L238)

***

### last\_updated

> **last\_updated**: `string`

Defined in: [src/lib/types/adcp.ts:239](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/types/adcp.ts#L239)

***

### assignments

> **assignments**: `string`[]

Defined in: [src/lib/types/adcp.ts:240](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/types/adcp.ts#L240)

***

### assignment\_count

> **assignment\_count**: `number`

Defined in: [src/lib/types/adcp.ts:241](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/types/adcp.ts#L241)

***

### performance\_metrics?

> `optional` **performance\_metrics**: [`CreativePerformanceMetrics`](CreativePerformanceMetrics.md)

Defined in: [src/lib/types/adcp.ts:242](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/types/adcp.ts#L242)

***

### compliance?

> `optional` **compliance**: [`CreativeComplianceData`](CreativeComplianceData.md)

Defined in: [src/lib/types/adcp.ts:243](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/types/adcp.ts#L243)

***

### sub\_assets?

> `optional` **sub\_assets**: [`CreativeSubAsset`](CreativeSubAsset.md)[]

Defined in: [src/lib/types/adcp.ts:244](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/types/adcp.ts#L244)
