[**@adcp/client API Reference v3.1.0**](../README.md)

***

[@adcp/client API Reference](../globals.md) / UpdateMediaBuyResponse

# Type Alias: UpdateMediaBuyResponse

> **UpdateMediaBuyResponse** = \{ `media_buy_id`: `string`; `buyer_ref`: `string`; `implementation_date?`: `string` \| `null`; `affected_packages?`: `object`[]; `context?`: \{ \}; \} \| \{ `errors`: \[`Error`, `...Error[]`\]; `context?`: \{ \}; \}

Defined in: [src/lib/types/tools.generated.ts:2659](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L2659)

Response payload for update_media_buy task. Returns either complete success data OR error information, never both. This enforces atomic operation semantics - updates are either fully applied or not applied at all.

## Type Declaration

\{ `media_buy_id`: `string`; `buyer_ref`: `string`; `implementation_date?`: `string` \| `null`; `affected_packages?`: `object`[]; `context?`: \{ \}; \}

### media\_buy\_id

> **media\_buy\_id**: `string`

Publisher's identifier for the media buy

### buyer\_ref

> **buyer\_ref**: `string`

Buyer's reference identifier for the media buy

### implementation\_date?

> `optional` **implementation\_date**: `string` \| `null`

ISO 8601 timestamp when changes take effect (null if pending approval)

### affected\_packages?

> `optional` **affected\_packages**: `object`[]

Array of packages that were modified

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
