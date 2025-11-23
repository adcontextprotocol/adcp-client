[**@adcp/client API Reference v3.1.0**](../README.md)

***

[@adcp/client API Reference](../globals.md) / GetProductsRequest

# Interface: GetProductsRequest

Defined in: [src/lib/types/tools.generated.ts:17](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L17)

Request parameters for discovering available advertising products

## Properties

### brief?

> `optional` **brief**: `string`

Defined in: [src/lib/types/tools.generated.ts:21](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L21)

Natural language description of campaign requirements

***

### brand\_manifest?

> `optional` **brand\_manifest**: [`BrandManifestReference`](../type-aliases/BrandManifestReference.md)

Defined in: [src/lib/types/tools.generated.ts:22](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L22)

***

### filters?

> `optional` **filters**: `object`

Defined in: [src/lib/types/tools.generated.ts:26](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L26)

Structured filters for product discovery

#### delivery\_type?

> `optional` **delivery\_type**: `DeliveryType`

#### is\_fixed\_price?

> `optional` **is\_fixed\_price**: `boolean`

Filter for fixed price vs auction products

#### format\_types?

> `optional` **format\_types**: (`"video"` \| `"audio"` \| `"display"`)[]

Filter by format types

#### format\_ids?

> `optional` **format\_ids**: `FormatID`[]

Filter by specific format IDs

#### standard\_formats\_only?

> `optional` **standard\_formats\_only**: `boolean`

Only return products accepting IAB standard formats

#### min\_exposures?

> `optional` **min\_exposures**: `number`

Minimum exposures/impressions needed for measurement validity

***

### context?

> `optional` **context**: `object`

Defined in: [src/lib/types/tools.generated.ts:52](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L52)

Initiator-provided context included in the request payload. Agentsmust echo this value back unchanged in responses and webhooks. Use for UI/session hints, correlation tokens, or tracking metadata.
