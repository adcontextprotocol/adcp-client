[**@adcp/client API Reference v3.1.0**](../README.md)

***

[@adcp/client API Reference](../globals.md) / ListCreativesResponse

# Interface: ListCreativesResponse

Defined in: [src/lib/types/tools.generated.ts:2401](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L2401)

Response from creative library query with filtered results, metadata, and optional enriched data

## Properties

### query\_summary

> **query\_summary**: `object`

Defined in: [src/lib/types/tools.generated.ts:2405](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L2405)

Summary of the query that was executed

#### total\_matching

> **total\_matching**: `number`

Total number of creatives matching filters (across all pages)

#### returned

> **returned**: `number`

Number of creatives returned in this response

#### filters\_applied?

> `optional` **filters\_applied**: `string`[]

List of filters that were applied to the query

#### sort\_applied?

> `optional` **sort\_applied**: `object`

Sort order that was applied

##### sort\_applied.field?

> `optional` **field**: `string`

##### sort\_applied.direction?

> `optional` **direction**: `"asc"` \| `"desc"`

***

### pagination

> **pagination**: `object`

Defined in: [src/lib/types/tools.generated.ts:2429](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L2429)

Pagination information for navigating results

#### limit

> **limit**: `number`

Maximum number of results requested

#### offset

> **offset**: `number`

Number of results skipped

#### has\_more

> **has\_more**: `boolean`

Whether more results are available

#### total\_pages?

> `optional` **total\_pages**: `number`

Total number of pages available

#### current\_page?

> `optional` **current\_page**: `number`

Current page number (1-based)

***

### creatives

> **creatives**: `object`[]

Defined in: [src/lib/types/tools.generated.ts:2454](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L2454)

Array of creative assets matching the query

#### creative\_id

> **creative\_id**: `string`

Unique identifier for the creative

#### name

> **name**: `string`

Human-readable creative name

#### format\_id

> **format\_id**: `FormatID`

#### status

> **status**: `CreativeStatus`

#### created\_date

> **created\_date**: `string`

When the creative was uploaded to the library

#### updated\_date

> **updated\_date**: `string`

When the creative was last modified

#### assets?

> `optional` **assets**: `object`

Assets for this creative, keyed by asset_role

##### Index Signature

\[`k`: `string`\]: `VASTAsset` \| `DAASTAsset` \| `ImageAsset` \| `VideoAsset` \| `AudioAsset` \| `TextAsset` \| `HTMLAsset` \| `CSSAsset` \| `JavaScriptAsset` \| `PromotedOfferings` \| `URLAsset`

This interface was referenced by `undefined`'s JSON-Schema definition
via the `patternProperty` "^[a-zA-Z0-9_-]+$".

#### tags?

> `optional` **tags**: `string`[]

User-defined tags for organization and searchability

#### assignments?

> `optional` **assignments**: `object`

Current package assignments (included when include_assignments=true)

##### assignments.assignment\_count

> **assignment\_count**: `number`

Total number of active package assignments

##### assignments.assigned\_packages?

> `optional` **assigned\_packages**: `object`[]

List of packages this creative is assigned to

#### performance?

> `optional` **performance**: `object`

Aggregated performance metrics (included when include_performance=true)

##### performance.impressions?

> `optional` **impressions**: `number`

Total impressions across all assignments

##### performance.clicks?

> `optional` **clicks**: `number`

Total clicks across all assignments

##### performance.ctr?

> `optional` **ctr**: `number`

Click-through rate (clicks/impressions)

##### performance.conversion\_rate?

> `optional` **conversion\_rate**: `number`

Conversion rate across all assignments

##### performance.performance\_score?

> `optional` **performance\_score**: `number`

Aggregated performance score (0-100)

##### performance.last\_updated

> **last\_updated**: `string`

When performance data was last updated

#### sub\_assets?

> `optional` **sub\_assets**: `SubAsset`[]

Sub-assets for multi-asset formats (included when include_sub_assets=true)

***

### format\_summary?

> `optional` **format\_summary**: `object`

Defined in: [src/lib/types/tools.generated.ts:2565](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L2565)

Breakdown of creatives by format type

#### Index Signature

\[`k`: `string`\]: `number`

Number of creatives with this format

This interface was referenced by `undefined`'s JSON-Schema definition
via the `patternProperty` "^[a-zA-Z0-9_-]+$".

***

### status\_summary?

> `optional` **status\_summary**: `object`

Defined in: [src/lib/types/tools.generated.ts:2577](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L2577)

Breakdown of creatives by status

#### approved?

> `optional` **approved**: `number`

Number of approved creatives

#### pending\_review?

> `optional` **pending\_review**: `number`

Number of creatives pending review

#### rejected?

> `optional` **rejected**: `number`

Number of rejected creatives

#### archived?

> `optional` **archived**: `number`

Number of archived creatives

***

### context?

> `optional` **context**: `object`

Defined in: [src/lib/types/tools.generated.ts:2598](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L2598)

Initiator-provided context echoed inside the task payload. Opaque metadata such as UI/session hints, correlation tokens, or tracking identifiers.
