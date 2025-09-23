[**@adcp/client API Reference v2.0.0**](../README.md)

***

[@adcp/client API Reference](../README.md) / UpdateMediaBuyResponse

# Interface: UpdateMediaBuyResponse

Defined in: [src/lib/types/tools.generated.ts:1219](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/types/tools.generated.ts#L1219)

Response payload for update_media_buy task

## Properties

### adcp\_version

> **adcp\_version**: `string`

Defined in: [src/lib/types/tools.generated.ts:1223](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/types/tools.generated.ts#L1223)

AdCP schema version used for this response

***

### media\_buy\_id

> **media\_buy\_id**: `string`

Defined in: [src/lib/types/tools.generated.ts:1227](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/types/tools.generated.ts#L1227)

Publisher's identifier for the media buy

***

### buyer\_ref

> **buyer\_ref**: `string`

Defined in: [src/lib/types/tools.generated.ts:1231](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/types/tools.generated.ts#L1231)

Buyer's reference identifier for the media buy

***

### implementation\_date?

> `optional` **implementation\_date**: `null` \| `string`

Defined in: [src/lib/types/tools.generated.ts:1235](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/types/tools.generated.ts#L1235)

ISO 8601 timestamp when changes take effect (null if pending approval)

***

### affected\_packages

> **affected\_packages**: `object`[]

Defined in: [src/lib/types/tools.generated.ts:1239](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/types/tools.generated.ts#L1239)

Array of packages that were modified

#### package\_id

> **package\_id**: `string`

Publisher's package identifier

#### buyer\_ref

> **buyer\_ref**: `string`

Buyer's reference for the package

***

### errors?

> `optional` **errors**: `Error`[]

Defined in: [src/lib/types/tools.generated.ts:1252](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/types/tools.generated.ts#L1252)

Task-specific errors and warnings (e.g., partial update failures)
