[**@adcp/client API Reference v3.1.0**](../README.md)

***

[@adcp/client API Reference](../globals.md) / ActivateSignalResponseSchema

# Variable: ActivateSignalResponseSchema

> `const` **ActivateSignalResponseSchema**: `ZodUnion`\<readonly \[`ZodObject`\<\{ `deployments`: `ZodArray`\<`ZodUnion`\<readonly \[`ZodObject`\<\{ `type`: `ZodLiteral`\<`"platform"`\>; `platform`: `ZodString`; `account`: `ZodOptional`\<`ZodString`\>; `is_live`: `ZodBoolean`; `activation_key`: `ZodOptional`\<`ZodUnion`\<...\>\>; `estimated_activation_duration_minutes`: `ZodOptional`\<`ZodNumber`\>; `deployed_at`: `ZodOptional`\<`ZodString`\>; \}, `$strip`\>, `ZodObject`\<\{ `type`: `ZodLiteral`\<`"agent"`\>; `agent_url`: `ZodString`; `account`: `ZodOptional`\<`ZodString`\>; `is_live`: `ZodBoolean`; `activation_key`: `ZodOptional`\<`ZodUnion`\<...\>\>; `estimated_activation_duration_minutes`: `ZodOptional`\<`ZodNumber`\>; `deployed_at`: `ZodOptional`\<`ZodString`\>; \}, `$strip`\>\]\>\>; `context`: `ZodOptional`\<`ZodObject`\<\{ \}, `$strip`\>\>; \}, `$strip`\>, `ZodObject`\<\{ `errors`: `ZodTuple`\<\[`ZodObject`\<\{ `code`: `ZodString`; `message`: `ZodString`; `field`: `ZodOptional`\<`ZodString`\>; `suggestion`: `ZodOptional`\<`ZodString`\>; `retry_after`: `ZodOptional`\<`ZodNumber`\>; `details`: `ZodOptional`\<`ZodRecord`\<`ZodString`, `ZodUnknown`\>\>; \}, `$strip`\>\], `ZodObject`\<\{ `code`: `ZodString`; `message`: `ZodString`; `field`: `ZodOptional`\<`ZodString`\>; `suggestion`: `ZodOptional`\<`ZodString`\>; `retry_after`: `ZodOptional`\<`ZodNumber`\>; `details`: `ZodOptional`\<`ZodRecord`\<`ZodString`, `ZodUnknown`\>\>; \}, `$strip`\>\>; `context`: `ZodOptional`\<`ZodObject`\<\{ \}, `$strip`\>\>; \}, `$strip`\>\]\>

Defined in: [src/lib/types/schemas.generated.ts:854](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/schemas.generated.ts#L854)
