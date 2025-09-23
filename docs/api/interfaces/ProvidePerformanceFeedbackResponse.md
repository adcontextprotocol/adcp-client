[**@adcp/client API Reference v2.0.0**](../README.md)

***

[@adcp/client API Reference](../README.md) / ProvidePerformanceFeedbackResponse

# Interface: ProvidePerformanceFeedbackResponse

Defined in: [src/lib/types/tools.generated.ts:1562](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/types/tools.generated.ts#L1562)

Response payload for provide_performance_feedback task

## Properties

### adcp\_version

> **adcp\_version**: `string`

Defined in: [src/lib/types/tools.generated.ts:1566](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/types/tools.generated.ts#L1566)

AdCP schema version used for this response

***

### success

> **success**: `boolean`

Defined in: [src/lib/types/tools.generated.ts:1570](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/types/tools.generated.ts#L1570)

Whether the performance feedback was successfully received

***

### message?

> `optional` **message**: `string`

Defined in: [src/lib/types/tools.generated.ts:1574](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/types/tools.generated.ts#L1574)

Optional human-readable message about the feedback processing

***

### errors?

> `optional` **errors**: `Error`[]

Defined in: [src/lib/types/tools.generated.ts:1578](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/types/tools.generated.ts#L1578)

Task-specific errors and warnings (e.g., invalid measurement period, missing campaign data)
