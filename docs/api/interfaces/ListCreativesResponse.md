[**@adcp/client API Reference v2.0.0**](../README.md)

***

[@adcp/client API Reference](../README.md) / ListCreativesResponse

# Interface: ListCreativesResponse

Defined in: [src/lib/types/tools.generated.ts:945](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/types/tools.generated.ts#L945)

Current approval status of the creative

## Properties

### adcp\_version

> **adcp\_version**: `string`

Defined in: [src/lib/types/tools.generated.ts:949](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/types/tools.generated.ts#L949)

AdCP schema version used for this response

***

### message

> **message**: `string`

Defined in: [src/lib/types/tools.generated.ts:953](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/types/tools.generated.ts#L953)

Human-readable result message

***

### context\_id?

> `optional` **context\_id**: `string`

Defined in: [src/lib/types/tools.generated.ts:957](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/types/tools.generated.ts#L957)

Context ID for tracking related operations

***

### query\_summary

> **query\_summary**: `object`

Defined in: [src/lib/types/tools.generated.ts:961](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/types/tools.generated.ts#L961)

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

##### Index Signature

\[`k`: `string`\]: `unknown`

##### sort\_applied.field?

> `optional` **field**: `string`

##### sort\_applied.direction?

> `optional` **direction**: `"asc"` \| `"desc"`

***

### pagination

> **pagination**: `object`

Defined in: [src/lib/types/tools.generated.ts:986](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/types/tools.generated.ts#L986)

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

Defined in: [src/lib/types/tools.generated.ts:1011](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/types/tools.generated.ts#L1011)

Array of creative assets matching the query

#### creative\_id

> **creative\_id**: `string`

Unique identifier for the creative

#### name

> **name**: `string`

Human-readable creative name

#### format

> **format**: `string`

Creative format type

#### status

> **status**: `CreativeStatus`

#### created\_date

> **created\_date**: `string`

When the creative was uploaded to the library

#### updated\_date

> **updated\_date**: `string`

When the creative was last modified

#### media\_url?

> `optional` **media\_url**: `string`

URL of the creative file (for hosted assets)

#### snippet?

> `optional` **snippet**: `string`

Third-party tag, VAST XML, or code snippet (for third-party assets)

#### snippet\_type?

> `optional` **snippet\_type**: `SnippetType`

#### click\_url?

> `optional` **click\_url**: `string`

Landing page URL for the creative

#### duration?

> `optional` **duration**: `number`

Duration in milliseconds (for video/audio)

#### width?

> `optional` **width**: `number`

Width in pixels (for video/display)

#### height?

> `optional` **height**: `number`

Height in pixels (for video/display)

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

Defined in: [src/lib/types/tools.generated.ts:1129](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/types/tools.generated.ts#L1129)

Breakdown of creatives by format type

#### Index Signature

\[`k`: `string`\]: `number`

Number of creatives with this format

This interface was referenced by `undefined`'s JSON-Schema definition
via the `patternProperty` "^[a-zA-Z0-9_-]+$".

***

### status\_summary?

> `optional` **status\_summary**: `object`

Defined in: [src/lib/types/tools.generated.ts:1141](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/types/tools.generated.ts#L1141)

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
