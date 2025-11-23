[**@adcp/client API Reference v3.1.0**](../README.md)

***

[@adcp/client API Reference](../globals.md) / ProvidePerformanceFeedbackResponseSchema

# Variable: ProvidePerformanceFeedbackResponseSchema

> `const` **ProvidePerformanceFeedbackResponseSchema**: `ZodUnion`\<readonly \[`ZodObject`\<\{ `success`: `ZodLiteral`\<`true`\>; `context`: `ZodOptional`\<`ZodObject`\<\{ \}, `$strip`\>\>; \}, `$strip`\>, `ZodObject`\<\{ `errors`: `ZodTuple`\<\[`ZodObject`\<\{ `code`: `ZodString`; `message`: `ZodString`; `field`: `ZodOptional`\<`ZodString`\>; `suggestion`: `ZodOptional`\<`ZodString`\>; `retry_after`: `ZodOptional`\<`ZodNumber`\>; `details`: `ZodOptional`\<`ZodRecord`\<`ZodString`, `ZodUnknown`\>\>; \}, `$strip`\>\], `ZodObject`\<\{ `code`: `ZodString`; `message`: `ZodString`; `field`: `ZodOptional`\<`ZodString`\>; `suggestion`: `ZodOptional`\<`ZodString`\>; `retry_after`: `ZodOptional`\<`ZodNumber`\>; `details`: `ZodOptional`\<`ZodRecord`\<`ZodString`, `ZodUnknown`\>\>; \}, `$strip`\>\>; `context`: `ZodOptional`\<`ZodObject`\<\{ \}, `$strip`\>\>; \}, `$strip`\>\]\>

Defined in: [src/lib/types/schemas.generated.ts:704](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/schemas.generated.ts#L704)
