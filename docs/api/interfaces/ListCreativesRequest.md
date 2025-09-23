[**@adcp/client API Reference v2.0.0**](../README.md)

***

[@adcp/client API Reference](../README.md) / ListCreativesRequest

# Interface: ListCreativesRequest

Defined in: [src/lib/types/tools.generated.ts:811](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/types/tools.generated.ts#L811)

Filter by third-party snippet type

## Properties

### adcp\_version?

> `optional` **adcp\_version**: `string`

Defined in: [src/lib/types/tools.generated.ts:815](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/types/tools.generated.ts#L815)

AdCP schema version for this request

***

### filters?

> `optional` **filters**: `object`

Defined in: [src/lib/types/tools.generated.ts:819](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/types/tools.generated.ts#L819)

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

#### snippet\_type?

> `optional` **snippet\_type**: `SnippetType`

#### has\_performance\_data?

> `optional` **has\_performance\_data**: `boolean`

Filter creatives that have performance data when true

***

### sort?

> `optional` **sort**: `object`

Defined in: [src/lib/types/tools.generated.ts:888](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/types/tools.generated.ts#L888)

Sorting parameters

#### field?

> `optional` **field**: `"created_date"` \| `"updated_date"` \| `"name"` \| `"status"` \| `"assignment_count"` \| `"performance_score"`

Field to sort by

#### direction?

> `optional` **direction**: `"asc"` \| `"desc"`

Sort direction

***

### pagination?

> `optional` **pagination**: `object`

Defined in: [src/lib/types/tools.generated.ts:901](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/types/tools.generated.ts#L901)

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

Defined in: [src/lib/types/tools.generated.ts:914](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/types/tools.generated.ts#L914)

Include package assignment information in response

***

### include\_performance?

> `optional` **include\_performance**: `boolean`

Defined in: [src/lib/types/tools.generated.ts:918](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/types/tools.generated.ts#L918)

Include aggregated performance metrics in response

***

### include\_sub\_assets?

> `optional` **include\_sub\_assets**: `boolean`

Defined in: [src/lib/types/tools.generated.ts:922](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/types/tools.generated.ts#L922)

Include sub-assets (for carousel/native formats) in response

***

### fields?

> `optional` **fields**: (`"created_date"` \| `"updated_date"` \| `"name"` \| `"status"` \| `"creative_id"` \| `"format"` \| `"tags"` \| `"assignments"` \| `"performance"` \| `"sub_assets"`)[]

Defined in: [src/lib/types/tools.generated.ts:926](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/types/tools.generated.ts#L926)

Specific fields to include in response (omit for all fields)
