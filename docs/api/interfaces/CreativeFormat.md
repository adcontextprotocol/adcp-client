[**@adcp/client API Reference v3.1.0**](../README.md)

***

[@adcp/client API Reference](../globals.md) / CreativeFormat

# Interface: CreativeFormat

Defined in: [src/lib/core/CreativeAgentClient.ts:178](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/CreativeAgentClient.ts#L178)

Creative format definition (per AdCP v2.0.0 spec)

Extends the official Format type from the schema with an additional
agent_url field for convenience when working with creative agents.

## Extends

- [`Format`](Format.md)

## Properties

### agent\_url

> **agent\_url**: `string`

Defined in: [src/lib/core/CreativeAgentClient.ts:180](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/CreativeAgentClient.ts#L180)

Base URL of the creative agent that provides this format

***

### format\_id

> **format\_id**: `FormatID`

Defined in: [src/lib/types/tools.generated.ts:1113](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L1113)

#### Inherited from

[`Format`](Format.md).[`format_id`](Format.md#format_id)

***

### name

> **name**: `string`

Defined in: [src/lib/types/tools.generated.ts:1117](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L1117)

Human-readable format name

#### Inherited from

[`Format`](Format.md).[`name`](Format.md#name)

***

### description?

> `optional` **description**: `string`

Defined in: [src/lib/types/tools.generated.ts:1121](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L1121)

Plain text explanation of what this format does and what assets it requires

#### Inherited from

[`Format`](Format.md).[`description`](Format.md#description)

***

### preview\_image?

> `optional` **preview\_image**: `string`

Defined in: [src/lib/types/tools.generated.ts:1125](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L1125)

DEPRECATED: Use format_card instead. Optional preview image URL for format browsing/discovery UI. Should be 400x300px (4:3 aspect ratio) PNG or JPG. Used as thumbnail/card image in format browsers. This field is maintained for backward compatibility but format_card provides a more flexible, structured approach.

#### Inherited from

[`Format`](Format.md).[`preview_image`](Format.md#preview_image)

***

### example\_url?

> `optional` **example\_url**: `string`

Defined in: [src/lib/types/tools.generated.ts:1129](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L1129)

Optional URL to showcase page with examples and interactive demos of this format

#### Inherited from

[`Format`](Format.md).[`example_url`](Format.md#example_url)

***

### type

> **type**: `"video"` \| `"audio"` \| `"dooh"` \| `"native"` \| `"display"` \| `"rich_media"` \| `"universal"`

Defined in: [src/lib/types/tools.generated.ts:1133](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L1133)

Media type of this format - determines rendering method and asset requirements

#### Inherited from

[`Format`](Format.md).[`type`](Format.md#type)

***

### renders?

> `optional` **renders**: \[\{ `role`: `string`; `dimensions`: \{ `width?`: `number`; `height?`: `number`; `min_width?`: `number`; `min_height?`: `number`; `max_width?`: `number`; `max_height?`: `number`; `responsive?`: \{ `width`: `boolean`; `height`: `boolean`; \}; `aspect_ratio?`: `string`; `unit`: `"px"` \| `"dp"` \| `"inches"` \| `"cm"`; \}; \}, ...\{ role: string; dimensions: \{ width?: number; height?: number; min\_width?: number; min\_height?: number; max\_width?: number; max\_height?: number; responsive?: \{ width: boolean; height: boolean \}; aspect\_ratio?: string; unit: "px" \| "dp" \| "inches" \| "cm" \} \}\[\]\]

Defined in: [src/lib/types/tools.generated.ts:1139](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L1139)

Specification of rendered pieces for this format. Most formats produce a single render. Companion ad formats (video + banner), adaptive formats, and multi-placement formats produce multiple renders. Each render specifies its role and dimensions.

#### Min Items

1

#### Inherited from

[`Format`](Format.md).[`renders`](Format.md#renders)

***

### assets\_required?

> `optional` **assets\_required**: (\{ `item_type`: `"individual"`; `asset_id`: `string`; `asset_type`: `"url"` \| `"image"` \| `"video"` \| `"audio"` \| `"vast"` \| `"daast"` \| `"text"` \| `"html"` \| `"css"` \| `"javascript"` \| `"webhook"` \| `"markdown"` \| `"promoted_offerings"`; `asset_role?`: `string`; `required?`: `boolean`; `requirements?`: \{\[`k`: `string`\]: `unknown`; \}; \} \| \{ `item_type`: `"repeatable_group"`; `asset_group_id`: `string`; `min_count`: `number`; `max_count`: `number`; `assets`: `object`[]; \})[]

Defined in: [src/lib/types/tools.generated.ts:1244](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L1244)

Array of required assets or asset groups for this format. Each asset is identified by its asset_id, which must be used as the key in creative manifests. Can contain individual assets or repeatable asset sequences (e.g., carousel products, slideshow frames).

#### Inherited from

[`Format`](Format.md).[`assets_required`](Format.md#assets_required)

***

### delivery?

> `optional` **delivery**: `object`

Defined in: [src/lib/types/tools.generated.ts:1348](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L1348)

Delivery method specifications (e.g., hosted, VAST, third-party tags)

#### Index Signature

\[`k`: `string`\]: `unknown`

#### Inherited from

[`Format`](Format.md).[`delivery`](Format.md#delivery)

***

### supported\_macros?

> `optional` **supported\_macros**: `string`[]

Defined in: [src/lib/types/tools.generated.ts:1354](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L1354)

List of universal macros supported by this format (e.g., MEDIA_BUY_ID, CACHEBUSTER, DEVICE_ID). Used for validation and developer tooling.

#### Inherited from

[`Format`](Format.md).[`supported_macros`](Format.md#supported_macros)

***

### output\_format\_ids?

> `optional` **output\_format\_ids**: `FormatID1`[]

Defined in: [src/lib/types/tools.generated.ts:1358](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L1358)

For generative formats: array of format IDs that this format can generate. When a format accepts inputs like brand_manifest and message, this specifies what concrete output formats can be produced (e.g., a generative banner format might output standard image banner formats).

#### Inherited from

[`Format`](Format.md).[`output_format_ids`](Format.md#output_format_ids)

***

### format\_card?

> `optional` **format\_card**: `object`

Defined in: [src/lib/types/tools.generated.ts:1362](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L1362)

Optional standard visual card (300x400px) for displaying this format in user interfaces. Can be rendered via preview_creative or pre-generated.

#### format\_id

> **format\_id**: `FormatID2`

#### manifest

> **manifest**: `object`

Asset manifest for rendering the card, structure defined by the format

##### Index Signature

\[`k`: `string`\]: `unknown`

#### Inherited from

[`Format`](Format.md).[`format_card`](Format.md#format_card)

***

### format\_card\_detailed?

> `optional` **format\_card\_detailed**: `object`

Defined in: [src/lib/types/tools.generated.ts:1374](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L1374)

Optional detailed card with carousel and full specifications. Provides rich format documentation similar to ad spec pages.

#### format\_id

> **format\_id**: `FormatID3`

#### manifest

> **manifest**: `object`

Asset manifest for rendering the detailed card, structure defined by the format

##### Index Signature

\[`k`: `string`\]: `unknown`

#### Inherited from

[`Format`](Format.md).[`format_card_detailed`](Format.md#format_card_detailed)
