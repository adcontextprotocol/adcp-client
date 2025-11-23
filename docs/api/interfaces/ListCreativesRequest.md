[**@adcp/client API Reference v3.1.0**](../README.md)

***

[@adcp/client API Reference](../globals.md) / ListCreativesRequest

# Interface: ListCreativesRequest

Defined in: [src/lib/types/tools.generated.ts:2227](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L2227)

Request parameters for querying creative assets from the centralized library with filtering, sorting, and pagination

## Properties

### filters?

> `optional` **filters**: `object`

Defined in: [src/lib/types/tools.generated.ts:2231](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L2231)

Filter criteria for querying creatives

#### format?

> `optional` **format**: `string`

Filter by creative format type (e.g., video, audio, display)

#### formats?

> `optional` **formats**: `string`[]

Filter by multiple creative format types

#### status?

> `optional` **status**: `CreativeStatus`

#### statuses?

> `optional` **statuses**: `CreativeStatus1`[]

Filter by multiple creative statuses

#### tags?

> `optional` **tags**: `string`[]

Filter by creative tags (all tags must match)

#### tags\_any?

> `optional` **tags\_any**: `string`[]

Filter by creative tags (any tag must match)

#### name\_contains?

> `optional` **name\_contains**: `string`

Filter by creative names containing this text (case-insensitive)

#### creative\_ids?

> `optional` **creative\_ids**: `string`[]

Filter by specific creative IDs

##### Max Items

100

#### created\_after?

> `optional` **created\_after**: `string`

Filter creatives created after this date (ISO 8601)

#### created\_before?

> `optional` **created\_before**: `string`

Filter creatives created before this date (ISO 8601)

#### updated\_after?

> `optional` **updated\_after**: `string`

Filter creatives last updated after this date (ISO 8601)

#### updated\_before?

> `optional` **updated\_before**: `string`

Filter creatives last updated before this date (ISO 8601)

#### assigned\_to\_package?

> `optional` **assigned\_to\_package**: `string`

Filter creatives assigned to this specific package

#### assigned\_to\_packages?

> `optional` **assigned\_to\_packages**: `string`[]

Filter creatives assigned to any of these packages

#### unassigned?

> `optional` **unassigned**: `boolean`

Filter for unassigned creatives when true, assigned creatives when false

#### has\_performance\_data?

> `optional` **has\_performance\_data**: `boolean`

Filter creatives that have performance data when true

***

### sort?

> `optional` **sort**: `object`

Defined in: [src/lib/types/tools.generated.ts:2299](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L2299)

Sorting parameters

#### field?

> `optional` **field**: `"name"` \| `"created_date"` \| `"updated_date"` \| `"status"` \| `"assignment_count"` \| `"performance_score"`

Field to sort by

#### direction?

> `optional` **direction**: `"asc"` \| `"desc"`

Sort direction

***

### pagination?

> `optional` **pagination**: `object`

Defined in: [src/lib/types/tools.generated.ts:2312](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L2312)

Pagination parameters

#### limit?

> `optional` **limit**: `number`

Maximum number of creatives to return

#### offset?

> `optional` **offset**: `number`

Number of creatives to skip

***

### include\_assignments?

> `optional` **include\_assignments**: `boolean`

Defined in: [src/lib/types/tools.generated.ts:2325](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L2325)

Include package assignment information in response

***

### include\_performance?

> `optional` **include\_performance**: `boolean`

Defined in: [src/lib/types/tools.generated.ts:2329](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L2329)

Include aggregated performance metrics in response

***

### include\_sub\_assets?

> `optional` **include\_sub\_assets**: `boolean`

Defined in: [src/lib/types/tools.generated.ts:2333](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L2333)

Include sub-assets (for carousel/native formats) in response

***

### fields?

> `optional` **fields**: (`"creative_id"` \| `"format"` \| `"name"` \| `"tags"` \| `"created_date"` \| `"updated_date"` \| `"status"` \| `"assignments"` \| `"performance"` \| `"sub_assets"`)[]

Defined in: [src/lib/types/tools.generated.ts:2337](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L2337)

Specific fields to include in response (omit for all fields)

***

### context?

> `optional` **context**: `object`

Defined in: [src/lib/types/tools.generated.ts:2352](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L2352)

Initiator-provided context included in the request payload. Agentsmust echo this value back unchanged in responses and webhooks. Use for UI/session hints, correlation tokens, or tracking metadata.
