[**@adcp/client API Reference v3.1.0**](../README.md)

***

[@adcp/client API Reference](../globals.md) / GetMediaBuyDeliveryResponse

# Interface: GetMediaBuyDeliveryResponse

Defined in: [src/lib/types/tools.generated.ts:2755](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L2755)

Response payload for get_media_buy_delivery task

## Properties

### notification\_type?

> `optional` **notification\_type**: `"scheduled"` \| `"final"` \| `"delayed"` \| `"adjusted"`

Defined in: [src/lib/types/tools.generated.ts:2759](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L2759)

Type of webhook notification (only present in webhook deliveries): scheduled = regular periodic update, final = campaign completed, delayed = data not yet available, adjusted = resending period with updated data

***

### partial\_data?

> `optional` **partial\_data**: `boolean`

Defined in: [src/lib/types/tools.generated.ts:2763](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L2763)

Indicates if any media buys in this webhook have missing/delayed data (only present in webhook deliveries)

***

### unavailable\_count?

> `optional` **unavailable\_count**: `number`

Defined in: [src/lib/types/tools.generated.ts:2767](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L2767)

Number of media buys with reporting_delayed or failed status (only present in webhook deliveries when partial_data is true)

***

### sequence\_number?

> `optional` **sequence\_number**: `number`

Defined in: [src/lib/types/tools.generated.ts:2771](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L2771)

Sequential notification number (only present in webhook deliveries, starts at 1)

***

### next\_expected\_at?

> `optional` **next\_expected\_at**: `string`

Defined in: [src/lib/types/tools.generated.ts:2775](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L2775)

ISO 8601 timestamp for next expected notification (only present in webhook deliveries when notification_type is not 'final')

***

### reporting\_period

> **reporting\_period**: `object`

Defined in: [src/lib/types/tools.generated.ts:2779](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L2779)

Date range for the report. All periods use UTC timezone.

#### start

> **start**: `string`

ISO 8601 start timestamp in UTC (e.g., 2024-02-05T00:00:00Z)

#### end

> **end**: `string`

ISO 8601 end timestamp in UTC (e.g., 2024-02-05T23:59:59Z)

***

### currency

> **currency**: `string`

Defined in: [src/lib/types/tools.generated.ts:2792](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L2792)

ISO 4217 currency code

***

### aggregated\_totals?

> `optional` **aggregated\_totals**: `object`

Defined in: [src/lib/types/tools.generated.ts:2796](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L2796)

Combined metrics across all returned media buys. Only included in API responses (get_media_buy_delivery), not in webhook notifications.

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

### media\_buy\_deliveries

> **media\_buy\_deliveries**: `object`[]

Defined in: [src/lib/types/tools.generated.ts:2821](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L2821)

Array of delivery data for media buys. When used in webhook notifications, may contain multiple media buys aggregated by publisher. When used in get_media_buy_delivery API responses, typically contains requested media buys.

#### media\_buy\_id

> **media\_buy\_id**: `string`

Publisher's media buy identifier

#### buyer\_ref?

> `optional` **buyer\_ref**: `string`

Buyer's reference identifier for this media buy

#### status

> **status**: `"active"` \| `"paused"` \| `"completed"` \| `"pending"` \| `"failed"` \| `"reporting_delayed"`

Current media buy status. In webhook context, reporting_delayed indicates data temporarily unavailable.

#### expected\_availability?

> `optional` **expected\_availability**: `string`

When delayed data is expected to be available (only present when status is reporting_delayed)

#### is\_adjusted?

> `optional` **is\_adjusted**: `boolean`

Indicates this delivery contains updated data for a previously reported period. Buyer should replace previous period data with these totals.

#### pricing\_model?

> `optional` **pricing\_model**: `PricingModel`

#### totals

> **totals**: `DeliveryMetrics` & `object`

##### Type Declaration

###### effective\_rate?

> `optional` **effective\_rate**: `number`

Effective rate paid per unit based on pricing_model (e.g., actual CPM for 'cpm', actual cost per completed view for 'cpcv', actual cost per point for 'cpp')

#### by\_package

> **by\_package**: `DeliveryMetrics` & `object`[]

Metrics broken down by package

#### daily\_breakdown?

> `optional` **daily\_breakdown**: `object`[]

Day-by-day delivery

***

### errors?

> `optional` **errors**: `Error`[]

Defined in: [src/lib/types/tools.generated.ts:2896](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L2896)

Task-specific errors and warnings (e.g., missing delivery data, reporting platform issues)

***

### context?

> `optional` **context**: `object`

Defined in: [src/lib/types/tools.generated.ts:2900](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L2900)

Initiator-provided context echoed inside the task payload. Opaque metadata such as UI/session hints, correlation tokens, or tracking identifiers.
