[**@adcp/client API Reference v2.0.0**](../README.md)

***

[@adcp/client API Reference](../README.md) / ProvidePerformanceFeedbackRequest

# Interface: ProvidePerformanceFeedbackRequest

Defined in: [src/lib/types/tools.generated.ts:1505](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/types/tools.generated.ts#L1505)

Request payload for provide_performance_feedback task

## Properties

### adcp\_version?

> `optional` **adcp\_version**: `string`

Defined in: [src/lib/types/tools.generated.ts:1509](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/types/tools.generated.ts#L1509)

AdCP schema version for this request

***

### media\_buy\_id

> **media\_buy\_id**: `string`

Defined in: [src/lib/types/tools.generated.ts:1513](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/types/tools.generated.ts#L1513)

Publisher's media buy identifier

***

### measurement\_period

> **measurement\_period**: `object`

Defined in: [src/lib/types/tools.generated.ts:1517](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/types/tools.generated.ts#L1517)

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

Defined in: [src/lib/types/tools.generated.ts:1530](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/types/tools.generated.ts#L1530)

Normalized performance score (0.0 = no value, 1.0 = expected, >1.0 = above expected)

***

### package\_id?

> `optional` **package\_id**: `string`

Defined in: [src/lib/types/tools.generated.ts:1534](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/types/tools.generated.ts#L1534)

Specific package within the media buy (if feedback is package-specific)

***

### creative\_id?

> `optional` **creative\_id**: `string`

Defined in: [src/lib/types/tools.generated.ts:1538](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/types/tools.generated.ts#L1538)

Specific creative asset (if feedback is creative-specific)

***

### metric\_type?

> `optional` **metric\_type**: `"overall_performance"` \| `"conversion_rate"` \| `"brand_lift"` \| `"click_through_rate"` \| `"completion_rate"` \| `"viewability"` \| `"brand_safety"` \| `"cost_efficiency"`

Defined in: [src/lib/types/tools.generated.ts:1542](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/types/tools.generated.ts#L1542)

The business metric being measured

***

### feedback\_source?

> `optional` **feedback\_source**: `"buyer_attribution"` \| `"third_party_measurement"` \| `"platform_analytics"` \| `"verification_partner"`

Defined in: [src/lib/types/tools.generated.ts:1554](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/types/tools.generated.ts#L1554)

Source of the performance data
