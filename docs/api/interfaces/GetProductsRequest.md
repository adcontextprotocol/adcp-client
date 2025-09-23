[**@adcp/client API Reference v2.0.0**](../README.md)

***

[@adcp/client API Reference](../README.md) / GetProductsRequest

# Interface: GetProductsRequest

Defined in: [src/lib/types/tools.generated.ts:13](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/types/tools.generated.ts#L13)

Request parameters for discovering available advertising products

## Properties

### adcp\_version?

> `optional` **adcp\_version**: `string`

Defined in: [src/lib/types/tools.generated.ts:17](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/types/tools.generated.ts#L17)

AdCP schema version for this request

***

### brief?

> `optional` **brief**: `string`

Defined in: [src/lib/types/tools.generated.ts:21](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/types/tools.generated.ts#L21)

Natural language description of campaign requirements

***

### promoted\_offering

> **promoted\_offering**: `string`

Defined in: [src/lib/types/tools.generated.ts:25](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/types/tools.generated.ts#L25)

Description of advertiser and what is being promoted

***

### filters?

> `optional` **filters**: `object`

Defined in: [src/lib/types/tools.generated.ts:29](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/types/tools.generated.ts#L29)

Structured filters for product discovery

#### delivery\_type?

> `optional` **delivery\_type**: `DeliveryType`

#### is\_fixed\_price?

> `optional` **is\_fixed\_price**: `boolean`

Filter for fixed price vs auction products

#### format\_types?

> `optional` **format\_types**: (`"video"` \| `"display"` \| `"audio"`)[]

Filter by format types

#### format\_ids?

> `optional` **format\_ids**: `string`[]

Filter by specific format IDs

#### standard\_formats\_only?

> `optional` **standard\_formats\_only**: `boolean`

Only return products accepting IAB standard formats
