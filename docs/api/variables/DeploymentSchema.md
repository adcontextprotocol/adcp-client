[**@adcp/client API Reference v3.1.0**](../README.md)

***

[@adcp/client API Reference](../globals.md) / DeploymentSchema

# Variable: DeploymentSchema

> `const` **DeploymentSchema**: `ZodUnion`\<readonly \[`ZodObject`\<\{ `type`: `ZodLiteral`\<`"platform"`\>; `platform`: `ZodString`; `account`: `ZodOptional`\<`ZodString`\>; `is_live`: `ZodBoolean`; `activation_key`: `ZodOptional`\<`ZodUnion`\<readonly \[`ZodObject`\<\{ `type`: `ZodLiteral`\<`"segment_id"`\>; `segment_id`: `ZodString`; \}, `$strip`\>, `ZodObject`\<\{ `type`: `ZodLiteral`\<`"key_value"`\>; `key`: `ZodString`; `value`: `ZodString`; \}, `$strip`\>\]\>\>; `estimated_activation_duration_minutes`: `ZodOptional`\<`ZodNumber`\>; `deployed_at`: `ZodOptional`\<`ZodString`\>; \}, `$strip`\>, `ZodObject`\<\{ `type`: `ZodLiteral`\<`"agent"`\>; `agent_url`: `ZodString`; `account`: `ZodOptional`\<`ZodString`\>; `is_live`: `ZodBoolean`; `activation_key`: `ZodOptional`\<`ZodUnion`\<readonly \[`ZodObject`\<\{ `type`: `ZodLiteral`\<`"segment_id"`\>; `segment_id`: `ZodString`; \}, `$strip`\>, `ZodObject`\<\{ `type`: `ZodLiteral`\<`"key_value"`\>; `key`: `ZodString`; `value`: `ZodString`; \}, `$strip`\>\]\>\>; `estimated_activation_duration_minutes`: `ZodOptional`\<`ZodNumber`\>; `deployed_at`: `ZodOptional`\<`ZodString`\>; \}, `$strip`\>\]\>

Defined in: [src/lib/types/schemas.generated.ts:830](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/schemas.generated.ts#L830)
