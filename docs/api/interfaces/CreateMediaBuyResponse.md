[**@adcp/client API Reference v2.0.0**](../README.md)

***

[@adcp/client API Reference](../README.md) / CreateMediaBuyResponse

# Interface: CreateMediaBuyResponse

Defined in: [src/lib/types/tools.generated.ts:550](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/types/tools.generated.ts#L550)

Current task state - typically 'completed' for successful creation or 'input-required' if approval needed

## Properties

### adcp\_version

> **adcp\_version**: `string`

Defined in: [src/lib/types/tools.generated.ts:554](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/types/tools.generated.ts#L554)

AdCP schema version used for this response

***

### status?

> `optional` **status**: `TaskStatus`

Defined in: [src/lib/types/tools.generated.ts:555](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/types/tools.generated.ts#L555)

***

### media\_buy\_id

> **media\_buy\_id**: `string`

Defined in: [src/lib/types/tools.generated.ts:559](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/types/tools.generated.ts#L559)

Publisher's unique identifier for the created media buy

***

### buyer\_ref

> **buyer\_ref**: `string`

Defined in: [src/lib/types/tools.generated.ts:563](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/types/tools.generated.ts#L563)

Buyer's reference identifier for this media buy

***

### creative\_deadline?

> `optional` **creative\_deadline**: `string`

Defined in: [src/lib/types/tools.generated.ts:567](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/types/tools.generated.ts#L567)

ISO 8601 timestamp for creative upload deadline

***

### packages

> **packages**: `object`[]

Defined in: [src/lib/types/tools.generated.ts:571](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/types/tools.generated.ts#L571)

Array of created packages

#### package\_id

> **package\_id**: `string`

Publisher's unique identifier for the package

#### buyer\_ref

> **buyer\_ref**: `string`

Buyer's reference identifier for the package

***

### errors?

> `optional` **errors**: `Error`[]

Defined in: [src/lib/types/tools.generated.ts:584](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/types/tools.generated.ts#L584)

Task-specific errors and warnings (e.g., partial package creation failures)
