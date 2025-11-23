[**@adcp/client API Reference v3.1.0**](../README.md)

***

[@adcp/client API Reference](../globals.md) / ActivateSignalRequestSchema

# Variable: ActivateSignalRequestSchema

> `const` **ActivateSignalRequestSchema**: `ZodObject`\<\{ `signal_agent_segment_id`: `ZodString`; `destinations`: `ZodTuple`\<\[`ZodUnion`\<readonly \[`ZodObject`\<\{ `type`: `ZodLiteral`\<`"platform"`\>; `platform`: `ZodString`; `account`: `ZodOptional`\<`ZodString`\>; \}, `$strip`\>, `ZodObject`\<\{ `type`: `ZodLiteral`\<`"agent"`\>; `agent_url`: `ZodString`; `account`: `ZodOptional`\<`ZodString`\>; \}, `$strip`\>\]\>\], `ZodUnion`\<readonly \[`ZodObject`\<\{ `type`: `ZodLiteral`\<`"platform"`\>; `platform`: `ZodString`; `account`: `ZodOptional`\<`ZodString`\>; \}, `$strip`\>, `ZodObject`\<\{ `type`: `ZodLiteral`\<`"agent"`\>; `agent_url`: `ZodString`; `account`: `ZodOptional`\<`ZodString`\>; \}, `$strip`\>\]\>\>; `context`: `ZodOptional`\<`ZodObject`\<\{ \}, `$strip`\>\>; \}, `$strip`\>

Defined in: [src/lib/types/schemas.generated.ts:848](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/schemas.generated.ts#L848)
