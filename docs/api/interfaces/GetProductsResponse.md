[**@adcp/client API Reference v2.0.0**](../README.md)

***

[@adcp/client API Reference](../README.md) / GetProductsResponse

# Interface: GetProductsResponse

Defined in: [src/lib/types/tools.generated.ts:106](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/types/tools.generated.ts#L106)

Response payload for get_products task

## Properties

### adcp\_version

> **adcp\_version**: `string`

Defined in: [src/lib/types/tools.generated.ts:110](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/types/tools.generated.ts#L110)

AdCP schema version used for this response

***

### status?

> `optional` **status**: `TaskStatus`

Defined in: [src/lib/types/tools.generated.ts:111](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/types/tools.generated.ts#L111)

***

### products

> **products**: `Product`[]

Defined in: [src/lib/types/tools.generated.ts:115](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/types/tools.generated.ts#L115)

Array of matching products

***

### errors?

> `optional` **errors**: `Error`[]

Defined in: [src/lib/types/tools.generated.ts:119](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/types/tools.generated.ts#L119)

Task-specific errors and warnings (e.g., product filtering issues)
