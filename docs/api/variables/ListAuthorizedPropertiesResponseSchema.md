[**@adcp/client API Reference v3.1.0**](../README.md)

***

[@adcp/client API Reference](../globals.md) / ListAuthorizedPropertiesResponseSchema

# Variable: ListAuthorizedPropertiesResponseSchema

> `const` **ListAuthorizedPropertiesResponseSchema**: `ZodObject`\<\{ `publisher_domains`: `ZodTuple`\<\[`ZodString`\], `ZodString`\>; `primary_channels`: `ZodOptional`\<`ZodTuple`\<\[`ZodUnion`\<readonly \[`ZodLiteral`\<`"display"`\>, `ZodLiteral`\<`"video"`\>, `ZodLiteral`\<`"audio"`\>, `ZodLiteral`\<`"native"`\>, `ZodLiteral`\<`"dooh"`\>, `ZodLiteral`\<`"ctv"`\>, `ZodLiteral`\<`"podcast"`\>, `ZodLiteral`\<`"retail"`\>, `ZodLiteral`\<`"social"`\>\]\>\], `ZodUnion`\<readonly \[`ZodLiteral`\<`"display"`\>, `ZodLiteral`\<`"video"`\>, `ZodLiteral`\<`"audio"`\>, `ZodLiteral`\<`"native"`\>, `ZodLiteral`\<`"dooh"`\>, `ZodLiteral`\<`"ctv"`\>, `ZodLiteral`\<`"podcast"`\>, `ZodLiteral`\<`"retail"`\>, `ZodLiteral`\<`"social"`\>\]\>\>\>; `primary_countries`: `ZodOptional`\<`ZodTuple`\<\[`ZodString`\], `ZodString`\>\>; `portfolio_description`: `ZodOptional`\<`ZodString`\>; `advertising_policies`: `ZodOptional`\<`ZodString`\>; `last_updated`: `ZodOptional`\<`ZodString`\>; `errors`: `ZodOptional`\<`ZodArray`\<`ZodObject`\<\{ `code`: `ZodString`; `message`: `ZodString`; `field`: `ZodOptional`\<`ZodString`\>; `suggestion`: `ZodOptional`\<`ZodString`\>; `retry_after`: `ZodOptional`\<`ZodNumber`\>; `details`: `ZodOptional`\<`ZodRecord`\<`ZodString`, `ZodUnknown`\>\>; \}, `$strip`\>\>\>; `context`: `ZodOptional`\<`ZodObject`\<\{ \}, `$strip`\>\>; \}, `$strip`\>

Defined in: [src/lib/types/schemas.generated.ts:1062](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/schemas.generated.ts#L1062)
