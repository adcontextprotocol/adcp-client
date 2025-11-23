[**@adcp/client API Reference v3.1.0**](../README.md)

***

[@adcp/client API Reference](../globals.md) / GetSignalsRequestSchema

# Variable: GetSignalsRequestSchema

> `const` **GetSignalsRequestSchema**: `ZodObject`\<\{ `signal_spec`: `ZodString`; `deliver_to`: `ZodObject`\<\{ `destinations`: `ZodTuple`\<\[`ZodUnion`\<readonly \[`ZodObject`\<\{ `type`: `ZodLiteral`\<...\>; `platform`: `ZodString`; `account`: `ZodOptional`\<...\>; \}, `$strip`\>, `ZodObject`\<\{ `type`: `ZodLiteral`\<...\>; `agent_url`: `ZodString`; `account`: `ZodOptional`\<...\>; \}, `$strip`\>\]\>\], `ZodUnion`\<readonly \[`ZodObject`\<\{ `type`: `ZodLiteral`\<`"platform"`\>; `platform`: `ZodString`; `account`: `ZodOptional`\<`ZodString`\>; \}, `$strip`\>, `ZodObject`\<\{ `type`: `ZodLiteral`\<`"agent"`\>; `agent_url`: `ZodString`; `account`: `ZodOptional`\<`ZodString`\>; \}, `$strip`\>\]\>\>; `countries`: `ZodArray`\<`ZodString`\>; \}, `$strip`\>; `filters`: `ZodOptional`\<`ZodObject`\<\{ `catalog_types`: `ZodOptional`\<`ZodArray`\<`ZodUnion`\<readonly \[`ZodLiteral`\<`"marketplace"`\>, `ZodLiteral`\<`"custom"`\>, `ZodLiteral`\<`"owned"`\>\]\>\>\>; `data_providers`: `ZodOptional`\<`ZodArray`\<`ZodString`\>\>; `max_cpm`: `ZodOptional`\<`ZodNumber`\>; `min_coverage_percentage`: `ZodOptional`\<`ZodNumber`\>; \}, `$strip`\>\>; `max_results`: `ZodOptional`\<`ZodNumber`\>; `context`: `ZodOptional`\<`ZodObject`\<\{ \}, `$strip`\>\>; \}, `$strip`\>

Defined in: [src/lib/types/schemas.generated.ts:796](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/schemas.generated.ts#L796)
