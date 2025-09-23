[**@adcp/client API Reference v2.0.0**](../README.md)

***

[@adcp/client API Reference](../README.md) / ListCreativeFormatsResponse

# Interface: ListCreativeFormatsResponse

Defined in: [src/lib/types/tools.generated.ts:350](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/types/tools.generated.ts#L350)

Response payload for list_creative_formats task

## Properties

### adcp\_version

> **adcp\_version**: `string`

Defined in: [src/lib/types/tools.generated.ts:354](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/types/tools.generated.ts#L354)

AdCP schema version used for this response

***

### status?

> `optional` **status**: `TaskStatus`

Defined in: [src/lib/types/tools.generated.ts:355](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/types/tools.generated.ts#L355)

***

### formats

> **formats**: `Format`[]

Defined in: [src/lib/types/tools.generated.ts:359](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/types/tools.generated.ts#L359)

Array of available creative formats

***

### errors?

> `optional` **errors**: `Error`[]

Defined in: [src/lib/types/tools.generated.ts:363](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/types/tools.generated.ts#L363)

Task-specific errors and warnings (e.g., format availability issues)
