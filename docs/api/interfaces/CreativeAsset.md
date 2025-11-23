[**@adcp/client API Reference v3.1.0**](../README.md)

***

[@adcp/client API Reference](../globals.md) / CreativeAsset

# Interface: CreativeAsset

Defined in: [src/lib/types/tools.generated.ts:1717](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L1717)

Creative asset for upload to library - supports static assets, generative formats, and third-party snippets

## Properties

### creative\_id

> **creative\_id**: `string`

Defined in: [src/lib/types/tools.generated.ts:1721](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L1721)

Unique identifier for the creative

***

### name

> **name**: `string`

Defined in: [src/lib/types/tools.generated.ts:1725](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L1725)

Human-readable creative name

***

### format\_id

> **format\_id**: `FormatID1`

Defined in: [src/lib/types/tools.generated.ts:1726](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L1726)

***

### assets

> **assets**: `object`

Defined in: [src/lib/types/tools.generated.ts:1730](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L1730)

Assets required by the format, keyed by asset_role

#### Index Signature

\[`k`: `string`\]: `VASTAsset` \| `DAASTAsset` \| `ImageAsset` \| `VideoAsset` \| `AudioAsset` \| `TextAsset` \| `HTMLAsset` \| `CSSAsset` \| `JavaScriptAsset` \| `PromotedOfferings` \| `URLAsset`

This interface was referenced by `undefined`'s JSON-Schema definition
via the `patternProperty` "^[a-zA-Z0-9_-]+$".

***

### inputs?

> `optional` **inputs**: `object`[]

Defined in: [src/lib/types/tools.generated.ts:1751](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L1751)

Preview contexts for generative formats - defines what scenarios to generate previews for

#### name

> **name**: `string`

Human-readable name for this preview variant

#### macros?

> `optional` **macros**: `object`

Macro values to apply for this preview

##### Index Signature

\[`k`: `string`\]: `string`

#### context\_description?

> `optional` **context\_description**: `string`

Natural language description of the context for AI-generated content

***

### tags?

> `optional` **tags**: `string`[]

Defined in: [src/lib/types/tools.generated.ts:1770](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L1770)

User-defined tags for organization and searchability

***

### approved?

> `optional` **approved**: `boolean`

Defined in: [src/lib/types/tools.generated.ts:1774](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L1774)

For generative creatives: set to true to approve and finalize, false to request regeneration with updated assets/message. Omit for non-generative creatives.
