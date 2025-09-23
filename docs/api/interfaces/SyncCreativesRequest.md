[**@adcp/client API Reference v2.0.0**](../README.md)

***

[@adcp/client API Reference](../README.md) / SyncCreativesRequest

# Interface: SyncCreativesRequest

Defined in: [src/lib/types/tools.generated.ts:594](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/types/tools.generated.ts#L594)

Creative asset for upload to library - supports both hosted assets and third-party snippets

## Properties

### adcp\_version?

> `optional` **adcp\_version**: `string`

Defined in: [src/lib/types/tools.generated.ts:598](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/types/tools.generated.ts#L598)

AdCP schema version for this request

***

### creatives

> **creatives**: `CreativeAsset`[]

Defined in: [src/lib/types/tools.generated.ts:604](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/types/tools.generated.ts#L604)

Array of creative assets to sync (create or update)

#### Max Items

100

***

### patch?

> `optional` **patch**: `boolean`

Defined in: [src/lib/types/tools.generated.ts:608](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/types/tools.generated.ts#L608)

When true, only provided fields are updated (partial update). When false, entire creative is replaced (full upsert).

***

### assignments?

> `optional` **assignments**: `object`

Defined in: [src/lib/types/tools.generated.ts:612](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/types/tools.generated.ts#L612)

Optional bulk assignment of creatives to packages

#### Index Signature

\[`k`: `string`\]: `string`[]

Array of package IDs to assign this creative to

This interface was referenced by `undefined`'s JSON-Schema definition
via the `patternProperty` "^[a-zA-Z0-9_-]+$".

***

### delete\_missing?

> `optional` **delete\_missing**: `boolean`

Defined in: [src/lib/types/tools.generated.ts:624](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/types/tools.generated.ts#L624)

When true, creatives not included in this sync will be archived. Use with caution for full library replacement.

***

### dry\_run?

> `optional` **dry\_run**: `boolean`

Defined in: [src/lib/types/tools.generated.ts:628](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/types/tools.generated.ts#L628)

When true, preview changes without applying them. Returns what would be created/updated/deleted.

***

### validation\_mode?

> `optional` **validation\_mode**: `"strict"` \| `"lenient"`

Defined in: [src/lib/types/tools.generated.ts:632](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/types/tools.generated.ts#L632)

Validation strictness. 'strict' fails entire sync on any validation error. 'lenient' processes valid creatives and reports errors.
