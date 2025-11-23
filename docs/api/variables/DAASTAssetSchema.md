[**@adcp/client API Reference v3.1.0**](../README.md)

***

[@adcp/client API Reference](../globals.md) / DAASTAssetSchema

# Variable: DAASTAssetSchema

> `const` **DAASTAssetSchema**: `ZodUnion`\<readonly \[`ZodObject`\<\{ `delivery_type`: `ZodLiteral`\<`"url"`\>; `url`: `ZodString`; `daast_version`: `ZodOptional`\<`ZodUnion`\<readonly \[`ZodLiteral`\<`"1.0"`\>, `ZodLiteral`\<`"1.1"`\>\]\>\>; `duration_ms`: `ZodOptional`\<`ZodNumber`\>; `tracking_events`: `ZodOptional`\<`ZodArray`\<`ZodUnion`\<readonly \[`ZodLiteral`\<`"start"`\>, `ZodLiteral`\<`"firstQuartile"`\>, `ZodLiteral`\<`"midpoint"`\>, `ZodLiteral`\<`"thirdQuartile"`\>, `ZodLiteral`\<`"complete"`\>, `ZodLiteral`\<`"impression"`\>, `ZodLiteral`\<`"pause"`\>, `ZodLiteral`\<`"resume"`\>, `ZodLiteral`\<`"skip"`\>, `ZodLiteral`\<`"mute"`\>, `ZodLiteral`\<`"unmute"`\>\]\>\>\>; `companion_ads`: `ZodOptional`\<`ZodBoolean`\>; \}, `$strip`\>, `ZodObject`\<\{ `delivery_type`: `ZodLiteral`\<`"inline"`\>; `content`: `ZodString`; `daast_version`: `ZodOptional`\<`ZodUnion`\<readonly \[`ZodLiteral`\<`"1.0"`\>, `ZodLiteral`\<`"1.1"`\>\]\>\>; `duration_ms`: `ZodOptional`\<`ZodNumber`\>; `tracking_events`: `ZodOptional`\<`ZodArray`\<`ZodUnion`\<readonly \[`ZodLiteral`\<`"start"`\>, `ZodLiteral`\<`"firstQuartile"`\>, `ZodLiteral`\<`"midpoint"`\>, `ZodLiteral`\<`"thirdQuartile"`\>, `ZodLiteral`\<`"complete"`\>, `ZodLiteral`\<`"impression"`\>, `ZodLiteral`\<`"pause"`\>, `ZodLiteral`\<`"resume"`\>, `ZodLiteral`\<`"skip"`\>, `ZodLiteral`\<`"mute"`\>, `ZodLiteral`\<`"unmute"`\>\]\>\>\>; `companion_ads`: `ZodOptional`\<`ZodBoolean`\>; \}, `$strip`\>\]\>

Defined in: [src/lib/types/schemas.generated.ts:50](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/schemas.generated.ts#L50)
