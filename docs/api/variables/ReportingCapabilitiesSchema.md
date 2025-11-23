[**@adcp/client API Reference v3.1.0**](../README.md)

***

[@adcp/client API Reference](../globals.md) / ReportingCapabilitiesSchema

# Variable: ReportingCapabilitiesSchema

> `const` **ReportingCapabilitiesSchema**: `ZodObject`\<\{ `available_reporting_frequencies`: `ZodTuple`\<\[`ZodUnion`\<readonly \[`ZodLiteral`\<`"hourly"`\>, `ZodLiteral`\<`"daily"`\>, `ZodLiteral`\<`"monthly"`\>\]\>\], `ZodUnion`\<readonly \[`ZodLiteral`\<`"hourly"`\>, `ZodLiteral`\<`"daily"`\>, `ZodLiteral`\<`"monthly"`\>\]\>\>; `expected_delay_minutes`: `ZodNumber`; `timezone`: `ZodString`; `supports_webhooks`: `ZodBoolean`; `available_metrics`: `ZodArray`\<`ZodUnion`\<readonly \[`ZodLiteral`\<`"impressions"`\>, `ZodLiteral`\<`"spend"`\>, `ZodLiteral`\<`"clicks"`\>, `ZodLiteral`\<`"ctr"`\>, `ZodLiteral`\<`"video_completions"`\>, `ZodLiteral`\<`"completion_rate"`\>, `ZodLiteral`\<`"conversions"`\>, `ZodLiteral`\<`"viewability"`\>, `ZodLiteral`\<`"engagement_rate"`\>\]\>\>; \}, `$strip`\>

Defined in: [src/lib/types/schemas.generated.ts:316](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/schemas.generated.ts#L316)
