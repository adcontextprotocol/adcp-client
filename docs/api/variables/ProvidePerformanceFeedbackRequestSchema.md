[**@adcp/client API Reference v3.1.0**](../README.md)

***

[@adcp/client API Reference](../globals.md) / ProvidePerformanceFeedbackRequestSchema

# Variable: ProvidePerformanceFeedbackRequestSchema

> `const` **ProvidePerformanceFeedbackRequestSchema**: `ZodObject`\<\{ `media_buy_id`: `ZodString`; `measurement_period`: `ZodObject`\<\{ `start`: `ZodString`; `end`: `ZodString`; \}, `$strip`\>; `performance_index`: `ZodNumber`; `package_id`: `ZodOptional`\<`ZodString`\>; `creative_id`: `ZodOptional`\<`ZodString`\>; `metric_type`: `ZodOptional`\<`ZodUnion`\<readonly \[`ZodLiteral`\<`"overall_performance"`\>, `ZodLiteral`\<`"conversion_rate"`\>, `ZodLiteral`\<`"brand_lift"`\>, `ZodLiteral`\<`"click_through_rate"`\>, `ZodLiteral`\<`"completion_rate"`\>, `ZodLiteral`\<`"viewability"`\>, `ZodLiteral`\<`"brand_safety"`\>, `ZodLiteral`\<`"cost_efficiency"`\>\]\>\>; `feedback_source`: `ZodOptional`\<`ZodUnion`\<readonly \[`ZodLiteral`\<`"buyer_attribution"`\>, `ZodLiteral`\<`"third_party_measurement"`\>, `ZodLiteral`\<`"platform_analytics"`\>, `ZodLiteral`\<`"verification_partner"`\>\]\>\>; `context`: `ZodOptional`\<`ZodObject`\<\{ \}, `$strip`\>\>; \}, `$strip`\>

Defined in: [src/lib/types/schemas.generated.ts:690](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/schemas.generated.ts#L690)
