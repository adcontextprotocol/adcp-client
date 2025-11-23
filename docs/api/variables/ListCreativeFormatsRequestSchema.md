[**@adcp/client API Reference v3.1.0**](../README.md)

***

[@adcp/client API Reference](../globals.md) / ListCreativeFormatsRequestSchema

# Variable: ListCreativeFormatsRequestSchema

> `const` **ListCreativeFormatsRequestSchema**: `ZodObject`\<\{ `format_ids`: `ZodOptional`\<`ZodArray`\<`ZodObject`\<\{ `agent_url`: `ZodString`; `id`: `ZodString`; \}, `$strip`\>\>\>; `type`: `ZodOptional`\<`ZodUnion`\<readonly \[`ZodLiteral`\<`"audio"`\>, `ZodLiteral`\<`"video"`\>, `ZodLiteral`\<`"display"`\>, `ZodLiteral`\<`"dooh"`\>\]\>\>; `asset_types`: `ZodOptional`\<`ZodArray`\<`ZodUnion`\<readonly \[`ZodLiteral`\<`"image"`\>, `ZodLiteral`\<`"video"`\>, `ZodLiteral`\<`"audio"`\>, `ZodLiteral`\<`"text"`\>, `ZodLiteral`\<`"html"`\>, `ZodLiteral`\<`"javascript"`\>, `ZodLiteral`\<`"url"`\>\]\>\>\>; `max_width`: `ZodOptional`\<`ZodNumber`\>; `max_height`: `ZodOptional`\<`ZodNumber`\>; `min_width`: `ZodOptional`\<`ZodNumber`\>; `min_height`: `ZodOptional`\<`ZodNumber`\>; `is_responsive`: `ZodOptional`\<`ZodBoolean`\>; `name_search`: `ZodOptional`\<`ZodString`\>; `context`: `ZodOptional`\<`ZodObject`\<\{ \}, `$strip`\>\>; \}, `$strip`\>

Defined in: [src/lib/types/schemas.generated.ts:442](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/schemas.generated.ts#L442)
