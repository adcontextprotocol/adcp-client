[**@adcp/client API Reference v2.0.0**](../README.md)

***

[@adcp/client API Reference](../README.md) / ListCreativeFormatsRequest

# Interface: ListCreativeFormatsRequest

Defined in: [src/lib/types/tools.generated.ts:295](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/types/tools.generated.ts#L295)

Request parameters for discovering supported creative formats

## Properties

### adcp\_version?

> `optional` **adcp\_version**: `string`

Defined in: [src/lib/types/tools.generated.ts:299](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/types/tools.generated.ts#L299)

AdCP schema version for this request

***

### type?

> `optional` **type**: `"video"` \| `"display"` \| `"audio"`

Defined in: [src/lib/types/tools.generated.ts:303](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/types/tools.generated.ts#L303)

Filter by format type

***

### standard\_only?

> `optional` **standard\_only**: `boolean`

Defined in: [src/lib/types/tools.generated.ts:307](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/types/tools.generated.ts#L307)

Only return IAB standard formats

***

### category?

> `optional` **category**: `"standard"` \| `"custom"`

Defined in: [src/lib/types/tools.generated.ts:311](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/types/tools.generated.ts#L311)

Filter by format category

***

### format\_ids?

> `optional` **format\_ids**: `string`[]

Defined in: [src/lib/types/tools.generated.ts:315](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/types/tools.generated.ts#L315)

Filter by specific format IDs (e.g., from get_products response)
