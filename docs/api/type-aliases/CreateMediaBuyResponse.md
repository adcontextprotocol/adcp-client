[**@adcp/client API Reference v3.1.0**](../README.md)

***

[@adcp/client API Reference](../globals.md) / CreateMediaBuyResponse

# Type Alias: CreateMediaBuyResponse

> **CreateMediaBuyResponse** = \{ `media_buy_id`: `string`; `buyer_ref`: `string`; `creative_deadline?`: `string`; `packages`: `object`[]; `context?`: \{ \}; \} \| \{ `errors`: \[`Error`, `...Error[]`\]; `context?`: \{ \}; \}

Defined in: [src/lib/types/tools.generated.ts:2031](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L2031)

Response payload for create_media_buy task. Returns either complete success data OR error information, never both. This enforces atomic operation semantics - the media buy is either fully created or not created at all.

## Type Declaration

\{ `media_buy_id`: `string`; `buyer_ref`: `string`; `creative_deadline?`: `string`; `packages`: `object`[]; `context?`: \{ \}; \}

### media\_buy\_id

> **media\_buy\_id**: `string`

Publisher's unique identifier for the created media buy

### buyer\_ref

> **buyer\_ref**: `string`

Buyer's reference identifier for this media buy

### creative\_deadline?

> `optional` **creative\_deadline**: `string`

ISO 8601 timestamp for creative upload deadline

### packages

> **packages**: `object`[]

Array of created packages

### context?

> `optional` **context**: `object`

Initiator-provided context echoed inside the task payload. Opaque metadata such as UI/session hints, correlation tokens, or tracking identifiers.

\{ `errors`: \[`Error`, `...Error[]`\]; `context?`: \{ \}; \}

### errors

> **errors**: \[`Error`, `...Error[]`\]

Array of errors explaining why the operation failed

#### Min Items

1

### context?

> `optional` **context**: `object`

Initiator-provided context echoed inside the task payload. Opaque metadata such as UI/session hints, correlation tokens, or tracking identifiers.
