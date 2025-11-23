[**@adcp/client API Reference v3.1.0**](../README.md)

***

[@adcp/client API Reference](../globals.md) / GetSignalsResponseSchema

# Variable: GetSignalsResponseSchema

> `const` **GetSignalsResponseSchema**: `ZodObject`\<\{ `signals`: `ZodArray`\<`ZodObject`\<\{ `signal_agent_segment_id`: `ZodString`; `name`: `ZodString`; `description`: `ZodString`; `signal_type`: `ZodUnion`\<readonly \[`ZodLiteral`\<`"marketplace"`\>, `ZodLiteral`\<`"custom"`\>, `ZodLiteral`\<`"owned"`\>\]\>; `data_provider`: `ZodString`; `coverage_percentage`: `ZodNumber`; `deployments`: `ZodArray`\<`ZodUnion`\<readonly \[`ZodObject`\<\{ `type`: `ZodLiteral`\<...\>; `platform`: `ZodString`; `account`: `ZodOptional`\<...\>; `is_live`: `ZodBoolean`; `activation_key`: `ZodOptional`\<...\>; `estimated_activation_duration_minutes`: `ZodOptional`\<...\>; `deployed_at`: `ZodOptional`\<...\>; \}, `$strip`\>, `ZodObject`\<\{ `type`: `ZodLiteral`\<...\>; `agent_url`: `ZodString`; `account`: `ZodOptional`\<...\>; `is_live`: `ZodBoolean`; `activation_key`: `ZodOptional`\<...\>; `estimated_activation_duration_minutes`: `ZodOptional`\<...\>; `deployed_at`: `ZodOptional`\<...\>; \}, `$strip`\>\]\>\>; `pricing`: `ZodObject`\<\{ `cpm`: `ZodNumber`; `currency`: `ZodString`; \}, `$strip`\>; \}, `$strip`\>\>; `errors`: `ZodOptional`\<`ZodArray`\<`ZodObject`\<\{ `code`: `ZodString`; `message`: `ZodString`; `field`: `ZodOptional`\<`ZodString`\>; `suggestion`: `ZodOptional`\<`ZodString`\>; `retry_after`: `ZodOptional`\<`ZodNumber`\>; `details`: `ZodOptional`\<`ZodRecord`\<`ZodString`, `ZodUnknown`\>\>; \}, `$strip`\>\>\>; `context`: `ZodOptional`\<`ZodObject`\<\{ \}, `$strip`\>\>; \}, `$strip`\>

Defined in: [src/lib/types/schemas.generated.ts:1163](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/schemas.generated.ts#L1163)
