[**@adcp/client API Reference v3.1.0**](../README.md)

***

[@adcp/client API Reference](../globals.md) / GetProductsResponse

# Interface: GetProductsResponse

Defined in: [src/lib/types/tools.generated.ts:306](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L306)

Response payload for get_products task

## Properties

### products

> **products**: [`Product`](Product.md)[]

Defined in: [src/lib/types/tools.generated.ts:310](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L310)

Array of matching products

***

### errors?

> `optional` **errors**: `Error`[]

Defined in: [src/lib/types/tools.generated.ts:314](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L314)

Task-specific errors and warnings (e.g., product filtering issues)

***

### context?

> `optional` **context**: `object`

Defined in: [src/lib/types/tools.generated.ts:318](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L318)

Initiator-provided context echoed inside the task payload. Opaque metadata such as UI/session hints, correlation tokens, or tracking identifiers.
