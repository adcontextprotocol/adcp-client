[**@adcp/client API Reference v3.1.0**](../README.md)

***

[@adcp/client API Reference](../globals.md) / CreateMediaBuyRequest

# Interface: CreateMediaBuyRequest

Defined in: [src/lib/types/tools.generated.ts:1588](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L1588)

Request parameters for creating a media buy

## Properties

### buyer\_ref

> **buyer\_ref**: `string`

Defined in: [src/lib/types/tools.generated.ts:1592](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L1592)

Buyer's reference identifier for this media buy

***

### packages

> **packages**: [`PackageRequest`](PackageRequest.md)[]

Defined in: [src/lib/types/tools.generated.ts:1596](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L1596)

Array of package configurations

***

### brand\_manifest

> **brand\_manifest**: `BrandManifestReference1`

Defined in: [src/lib/types/tools.generated.ts:1597](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L1597)

***

### po\_number?

> `optional` **po\_number**: `string`

Defined in: [src/lib/types/tools.generated.ts:1601](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L1601)

Purchase order number for tracking

***

### start\_time

> **start\_time**: `string`

Defined in: [src/lib/types/tools.generated.ts:1602](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L1602)

***

### end\_time

> **end\_time**: `string`

Defined in: [src/lib/types/tools.generated.ts:1606](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L1606)

Campaign end date/time in ISO 8601 format

***

### reporting\_webhook?

> `optional` **reporting\_webhook**: `PushNotificationConfig` & `object`

Defined in: [src/lib/types/tools.generated.ts:1607](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L1607)

#### Type Declaration

##### reporting\_frequency

> **reporting\_frequency**: `"hourly"` \| `"daily"` \| `"monthly"`

Frequency for automated reporting delivery. Must be supported by all products in the media buy.

##### requested\_metrics?

> `optional` **requested\_metrics**: (`"impressions"` \| `"spend"` \| `"clicks"` \| `"ctr"` \| `"video_completions"` \| `"completion_rate"` \| `"conversions"` \| `"viewability"` \| `"engagement_rate"`)[]

Optional list of metrics to include in webhook notifications. If omitted, all available metrics are included. Must be subset of product's available_metrics.

***

### context?

> `optional` **context**: `object`

Defined in: [src/lib/types/tools.generated.ts:1630](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L1630)

Initiator-provided context included in the request payload. Agentsmust echo this value back unchanged in responses and webhooks. Use for UI/session hints, correlation tokens, or tracking metadata.
