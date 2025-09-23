[**@adcp/client API Reference v2.0.0**](../README.md)

***

[@adcp/client API Reference](../README.md) / GetMediaBuyDeliveryResponse

# Interface: GetMediaBuyDeliveryResponse

Defined in: [src/lib/types/tools.generated.ts:1296](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/types/tools.generated.ts#L1296)

Response payload for get_media_buy_delivery task

## Properties

### adcp\_version

> **adcp\_version**: `string`

Defined in: [src/lib/types/tools.generated.ts:1300](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/types/tools.generated.ts#L1300)

AdCP schema version used for this response

***

### reporting\_period

> **reporting\_period**: `object`

Defined in: [src/lib/types/tools.generated.ts:1304](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/types/tools.generated.ts#L1304)

Date range for the report

#### start

> **start**: `string`

ISO 8601 start timestamp

#### end

> **end**: `string`

ISO 8601 end timestamp

***

### currency

> **currency**: `string`

Defined in: [src/lib/types/tools.generated.ts:1317](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/types/tools.generated.ts#L1317)

ISO 4217 currency code

***

### aggregated\_totals

> **aggregated\_totals**: `object`

Defined in: [src/lib/types/tools.generated.ts:1321](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/types/tools.generated.ts#L1321)

Combined metrics across all returned media buys

#### impressions

> **impressions**: `number`

Total impressions delivered across all media buys

#### spend

> **spend**: `number`

Total amount spent across all media buys

#### clicks?

> `optional` **clicks**: `number`

Total clicks across all media buys (if applicable)

#### video\_completions?

> `optional` **video\_completions**: `number`

Total video completions across all media buys (if applicable)

#### media\_buy\_count

> **media\_buy\_count**: `number`

Number of media buys included in the response

***

### deliveries

> **deliveries**: `object`[]

Defined in: [src/lib/types/tools.generated.ts:1346](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/types/tools.generated.ts#L1346)

Array of delivery data for each media buy

#### media\_buy\_id

> **media\_buy\_id**: `string`

Publisher's media buy identifier

#### buyer\_ref?

> `optional` **buyer\_ref**: `string`

Buyer's reference identifier for this media buy

#### status

> **status**: `"active"` \| `"paused"` \| `"completed"` \| `"pending"` \| `"failed"`

Current media buy status

#### totals

> **totals**: `object`

Aggregate metrics for this media buy across all packages

##### totals.impressions

> **impressions**: `number`

Total impressions delivered

##### totals.spend

> **spend**: `number`

Total amount spent

##### totals.clicks?

> `optional` **clicks**: `number`

Total clicks (if applicable)

##### totals.ctr?

> `optional` **ctr**: `number`

Click-through rate (clicks/impressions)

##### totals.video\_completions?

> `optional` **video\_completions**: `number`

Total video completions (if applicable)

##### totals.completion\_rate?

> `optional` **completion\_rate**: `number`

Video completion rate (completions/impressions)

#### by\_package

> **by\_package**: `object`[]

Metrics broken down by package

#### daily\_breakdown?

> `optional` **daily\_breakdown**: `object`[]

Day-by-day delivery

***

### errors?

> `optional` **errors**: `Error`[]

Defined in: [src/lib/types/tools.generated.ts:1442](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/types/tools.generated.ts#L1442)

Task-specific errors and warnings (e.g., missing delivery data, reporting platform issues)
