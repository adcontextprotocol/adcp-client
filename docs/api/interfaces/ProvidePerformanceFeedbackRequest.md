[**@adcp/client API Reference v3.1.0**](../README.md)

***

[@adcp/client API Reference](../globals.md) / ProvidePerformanceFeedbackRequest

# Interface: ProvidePerformanceFeedbackRequest

Defined in: [src/lib/types/tools.generated.ts:3119](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L3119)

Request payload for provide_performance_feedback task

## Properties

### media\_buy\_id

> **media\_buy\_id**: `string`

Defined in: [src/lib/types/tools.generated.ts:3123](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L3123)

Publisher's media buy identifier

***

### measurement\_period

> **measurement\_period**: `object`

Defined in: [src/lib/types/tools.generated.ts:3127](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L3127)

Time period for performance measurement

#### start

> **start**: `string`

ISO 8601 start timestamp for measurement period

#### end

> **end**: `string`

ISO 8601 end timestamp for measurement period

***

### performance\_index

> **performance\_index**: `number`

Defined in: [src/lib/types/tools.generated.ts:3140](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L3140)

Normalized performance score (0.0 = no value, 1.0 = expected, >1.0 = above expected)

***

### package\_id?

> `optional` **package\_id**: `string`

Defined in: [src/lib/types/tools.generated.ts:3144](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L3144)

Specific package within the media buy (if feedback is package-specific)

***

### creative\_id?

> `optional` **creative\_id**: `string`

Defined in: [src/lib/types/tools.generated.ts:3148](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L3148)

Specific creative asset (if feedback is creative-specific)

***

### metric\_type?

> `optional` **metric\_type**: `"completion_rate"` \| `"viewability"` \| `"conversion_rate"` \| `"overall_performance"` \| `"brand_lift"` \| `"click_through_rate"` \| `"brand_safety"` \| `"cost_efficiency"`

Defined in: [src/lib/types/tools.generated.ts:3152](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L3152)

The business metric being measured

***

### feedback\_source?

> `optional` **feedback\_source**: `"buyer_attribution"` \| `"third_party_measurement"` \| `"platform_analytics"` \| `"verification_partner"`

Defined in: [src/lib/types/tools.generated.ts:3164](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L3164)

Source of the performance data

***

### context?

> `optional` **context**: `object`

Defined in: [src/lib/types/tools.generated.ts:3168](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L3168)

Initiator-provided context included in the request payload. Agentsmust echo this value back unchanged in responses and webhooks. Use for UI/session hints, correlation tokens, or tracking metadata.
