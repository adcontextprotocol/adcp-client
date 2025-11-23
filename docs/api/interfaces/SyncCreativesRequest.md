[**@adcp/client API Reference v3.1.0**](../README.md)

***

[@adcp/client API Reference](../globals.md) / SyncCreativesRequest

# Interface: SyncCreativesRequest

Defined in: [src/lib/types/tools.generated.ts:2084](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L2084)

VAST (Video Ad Serving Template) tag for third-party video ad serving

## Properties

### creatives

> **creatives**: [`CreativeAsset`](CreativeAsset.md)[]

Defined in: [src/lib/types/tools.generated.ts:2090](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L2090)

Array of creative assets to sync (create or update)

#### Max Items

100

***

### patch?

> `optional` **patch**: `boolean`

Defined in: [src/lib/types/tools.generated.ts:2094](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L2094)

When true, only provided fields are updated (partial update). When false, entire creative is replaced (full upsert).

***

### assignments?

> `optional` **assignments**: `object`

Defined in: [src/lib/types/tools.generated.ts:2098](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L2098)

Optional bulk assignment of creatives to packages

#### Index Signature

\[`k`: `string`\]: `string`[]

Array of package IDs to assign this creative to

This interface was referenced by `undefined`'s JSON-Schema definition
via the `patternProperty` "^[a-zA-Z0-9_-]+$".

***

### delete\_missing?

> `optional` **delete\_missing**: `boolean`

Defined in: [src/lib/types/tools.generated.ts:2110](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L2110)

When true, creatives not included in this sync will be archived. Use with caution for full library replacement.

***

### dry\_run?

> `optional` **dry\_run**: `boolean`

Defined in: [src/lib/types/tools.generated.ts:2114](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L2114)

When true, preview changes without applying them. Returns what would be created/updated/deleted.

***

### validation\_mode?

> `optional` **validation\_mode**: `"strict"` \| `"lenient"`

Defined in: [src/lib/types/tools.generated.ts:2118](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L2118)

Validation strictness. 'strict' fails entire sync on any validation error. 'lenient' processes valid creatives and reports errors.

***

### push\_notification\_config?

> `optional` **push\_notification\_config**: `PushNotificationConfig`

Defined in: [src/lib/types/tools.generated.ts:2119](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L2119)

***

### context?

> `optional` **context**: `object`

Defined in: [src/lib/types/tools.generated.ts:2123](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L2123)

Initiator-provided context included in the request payload. Agents must echo this value back unchanged in responses and webhooks. Use for UI/session hints, correlation tokens, or tracking metadata.
