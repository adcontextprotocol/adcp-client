[**@adcp/client API Reference v2.0.0**](../README.md)

***

[@adcp/client API Reference](../README.md) / CreativeAsset

# Interface: CreativeAsset

Defined in: [src/lib/types/adcp.ts:23](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/types/adcp.ts#L23)

## Properties

### id

> **id**: `string`

Defined in: [src/lib/types/adcp.ts:24](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/types/adcp.ts#L24)

***

### name

> **name**: `string`

Defined in: [src/lib/types/adcp.ts:25](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/types/adcp.ts#L25)

***

### type

> **type**: `"image"` \| `"video"` \| `"html"` \| `"native"`

Defined in: [src/lib/types/adcp.ts:26](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/types/adcp.ts#L26)

***

### format

> **format**: `string`

Defined in: [src/lib/types/adcp.ts:27](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/types/adcp.ts#L27)

***

### dimensions

> **dimensions**: `object`

Defined in: [src/lib/types/adcp.ts:28](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/types/adcp.ts#L28)

#### width

> **width**: `number`

#### height

> **height**: `number`

***

### url?

> `optional` **url**: `string`

Defined in: [src/lib/types/adcp.ts:33](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/types/adcp.ts#L33)

***

### media\_url?

> `optional` **media\_url**: `string`

Defined in: [src/lib/types/adcp.ts:34](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/types/adcp.ts#L34)

***

### snippet?

> `optional` **snippet**: `string`

Defined in: [src/lib/types/adcp.ts:35](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/types/adcp.ts#L35)

***

### snippet\_type?

> `optional` **snippet\_type**: `"html"` \| `"javascript"` \| `"amp"`

Defined in: [src/lib/types/adcp.ts:36](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/types/adcp.ts#L36)

***

### status

> **status**: `"active"` \| `"inactive"` \| `"pending_review"` \| `"approved"` \| `"rejected"`

Defined in: [src/lib/types/adcp.ts:37](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/types/adcp.ts#L37)

***

### file\_size?

> `optional` **file\_size**: `number`

Defined in: [src/lib/types/adcp.ts:38](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/types/adcp.ts#L38)

***

### duration?

> `optional` **duration**: `number`

Defined in: [src/lib/types/adcp.ts:39](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/types/adcp.ts#L39)

***

### tags?

> `optional` **tags**: `string`[]

Defined in: [src/lib/types/adcp.ts:41](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/types/adcp.ts#L41)

***

### sub\_assets?

> `optional` **sub\_assets**: [`CreativeSubAsset`](CreativeSubAsset.md)[]

Defined in: [src/lib/types/adcp.ts:42](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/types/adcp.ts#L42)

***

### created\_at?

> `optional` **created\_at**: `string`

Defined in: [src/lib/types/adcp.ts:43](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/types/adcp.ts#L43)

***

### updated\_at?

> `optional` **updated\_at**: `string`

Defined in: [src/lib/types/adcp.ts:44](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/types/adcp.ts#L44)
