[**@adcp/client API Reference v3.1.0**](../README.md)

***

[@adcp/client API Reference](../globals.md) / ListCreativeFormatsRequest

# Interface: ListCreativeFormatsRequest

Defined in: [src/lib/types/tools.generated.ts:1028](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L1028)

Request parameters for discovering supported creative formats

## Properties

### format\_ids?

> `optional` **format\_ids**: `FormatID`[]

Defined in: [src/lib/types/tools.generated.ts:1032](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L1032)

Return only these specific format IDs (e.g., from get_products response)

***

### type?

> `optional` **type**: `"video"` \| `"audio"` \| `"dooh"` \| `"display"`

Defined in: [src/lib/types/tools.generated.ts:1036](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L1036)

Filter by format type (technical categories with distinct requirements)

***

### asset\_types?

> `optional` **asset\_types**: (`"url"` \| `"image"` \| `"video"` \| `"audio"` \| `"text"` \| `"html"` \| `"javascript"`)[]

Defined in: [src/lib/types/tools.generated.ts:1040](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L1040)

Filter to formats that include these asset types. For third-party tags, search for 'html' or 'javascript'. E.g., ['image', 'text'] returns formats with images and text, ['javascript'] returns formats accepting JavaScript tags.

***

### max\_width?

> `optional` **max\_width**: `number`

Defined in: [src/lib/types/tools.generated.ts:1044](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L1044)

Maximum width in pixels (inclusive). Returns formats where ANY render has width <= this value. For multi-render formats, matches if at least one render fits.

***

### max\_height?

> `optional` **max\_height**: `number`

Defined in: [src/lib/types/tools.generated.ts:1048](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L1048)

Maximum height in pixels (inclusive). Returns formats where ANY render has height <= this value. For multi-render formats, matches if at least one render fits.

***

### min\_width?

> `optional` **min\_width**: `number`

Defined in: [src/lib/types/tools.generated.ts:1052](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L1052)

Minimum width in pixels (inclusive). Returns formats where ANY render has width >= this value.

***

### min\_height?

> `optional` **min\_height**: `number`

Defined in: [src/lib/types/tools.generated.ts:1056](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L1056)

Minimum height in pixels (inclusive). Returns formats where ANY render has height >= this value.

***

### is\_responsive?

> `optional` **is\_responsive**: `boolean`

Defined in: [src/lib/types/tools.generated.ts:1060](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L1060)

Filter for responsive formats that adapt to container size. When true, returns formats without fixed dimensions.

***

### name\_search?

> `optional` **name\_search**: `string`

Defined in: [src/lib/types/tools.generated.ts:1064](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L1064)

Search for formats by name (case-insensitive partial match)

***

### context?

> `optional` **context**: `object`

Defined in: [src/lib/types/tools.generated.ts:1068](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L1068)

Initiator-provided context included in the request payload. Agents must echo this value back unchanged in responses and webhooks. Use for UI/session hints, correlation tokens, or tracking metadata.
