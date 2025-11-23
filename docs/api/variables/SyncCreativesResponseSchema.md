[**@adcp/client API Reference v3.1.0**](../README.md)

***

[@adcp/client API Reference](../globals.md) / SyncCreativesResponseSchema

# Variable: SyncCreativesResponseSchema

> `const` **SyncCreativesResponseSchema**: `ZodUnion`\<readonly \[`ZodObject`\<\{ `dry_run`: `ZodOptional`\<`ZodBoolean`\>; `creatives`: `ZodArray`\<`ZodObject`\<\{ `creative_id`: `ZodString`; `action`: `ZodUnion`\<readonly \[`ZodLiteral`\<`"created"`\>, `ZodLiteral`\<`"updated"`\>, `ZodLiteral`\<`"unchanged"`\>, `ZodLiteral`\<`"failed"`\>, `ZodLiteral`\<`"deleted"`\>\]\>; `platform_id`: `ZodOptional`\<`ZodString`\>; `changes`: `ZodOptional`\<`ZodArray`\<`ZodString`\>\>; `errors`: `ZodOptional`\<`ZodArray`\<`ZodString`\>\>; `warnings`: `ZodOptional`\<`ZodArray`\<`ZodString`\>\>; `preview_url`: `ZodOptional`\<`ZodString`\>; `expires_at`: `ZodOptional`\<`ZodString`\>; `assigned_to`: `ZodOptional`\<`ZodArray`\<`ZodString`\>\>; `assignment_errors`: `ZodOptional`\<`ZodRecord`\<`ZodString`, `ZodString`\>\>; \}, `$strip`\>\>; `context`: `ZodOptional`\<`ZodObject`\<\{ \}, `$strip`\>\>; \}, `$strip`\>, `ZodObject`\<\{ `errors`: `ZodTuple`\<\[`ZodObject`\<\{ `code`: `ZodString`; `message`: `ZodString`; `field`: `ZodOptional`\<`ZodString`\>; `suggestion`: `ZodOptional`\<`ZodString`\>; `retry_after`: `ZodOptional`\<`ZodNumber`\>; `details`: `ZodOptional`\<`ZodRecord`\<`ZodString`, `ZodUnknown`\>\>; \}, `$strip`\>\], `ZodObject`\<\{ `code`: `ZodString`; `message`: `ZodString`; `field`: `ZodOptional`\<`ZodString`\>; `suggestion`: `ZodOptional`\<`ZodString`\>; `retry_after`: `ZodOptional`\<`ZodNumber`\>; `details`: `ZodOptional`\<`ZodRecord`\<`ZodString`, `ZodUnknown`\>\>; \}, `$strip`\>\>; `context`: `ZodOptional`\<`ZodObject`\<\{ \}, `$strip`\>\>; \}, `$strip`\>\]\>

Defined in: [src/lib/types/schemas.generated.ts:516](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/schemas.generated.ts#L516)
