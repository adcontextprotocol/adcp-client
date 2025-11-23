[**@adcp/client API Reference v3.1.0**](../README.md)

***

[@adcp/client API Reference](../globals.md) / PreviewCreativeResponseSchema

# Variable: PreviewCreativeResponseSchema

> `const` **PreviewCreativeResponseSchema**: `ZodUnion`\<readonly \[`ZodObject`\<\{ `response_type`: `ZodLiteral`\<`"single"`\>; `previews`: `ZodTuple`\<\[`ZodObject`\<\{ `preview_id`: `ZodString`; `renders`: `ZodTuple`\<\[`ZodUnion`\<...\>\], `ZodUnion`\<readonly \[..., ..., ...\]\>\>; `input`: `ZodObject`\<\{ `name`: `ZodString`; `macros`: `ZodOptional`\<...\>; `context_description`: `ZodOptional`\<...\>; \}, `$strip`\>; \}, `$strip`\>\], `ZodObject`\<\{ `preview_id`: `ZodString`; `renders`: `ZodTuple`\<\[`ZodUnion`\<readonly \[..., ..., ...\]\>\], `ZodUnion`\<readonly \[`ZodObject`\<..., ...\>, `ZodObject`\<..., ...\>, `ZodObject`\<..., ...\>\]\>\>; `input`: `ZodObject`\<\{ `name`: `ZodString`; `macros`: `ZodOptional`\<`ZodRecord`\<..., ...\>\>; `context_description`: `ZodOptional`\<`ZodString`\>; \}, `$strip`\>; \}, `$strip`\>\>; `interactive_url`: `ZodOptional`\<`ZodString`\>; `expires_at`: `ZodString`; `context`: `ZodOptional`\<`ZodObject`\<\{ \}, `$strip`\>\>; \}, `$strip`\>, `ZodObject`\<\{ `response_type`: `ZodLiteral`\<`"batch"`\>; `results`: `ZodTuple`\<\[`ZodUnion`\<readonly \[`ZodObject`\<\{ `success`: `ZodOptional`\<...\>; \}, `$strip`\>, `ZodObject`\<\{ `success`: `ZodOptional`\<...\>; \}, `$strip`\>\]\>\], `ZodUnion`\<readonly \[`ZodObject`\<\{ `success`: `ZodOptional`\<`ZodLiteral`\<...\>\>; \}, `$strip`\>, `ZodObject`\<\{ `success`: `ZodOptional`\<`ZodLiteral`\<...\>\>; \}, `$strip`\>\]\>\>; `context`: `ZodOptional`\<`ZodObject`\<\{ \}, `$strip`\>\>; \}, `$strip`\>\]\>

Defined in: [src/lib/types/schemas.generated.ts:1127](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/schemas.generated.ts#L1127)
