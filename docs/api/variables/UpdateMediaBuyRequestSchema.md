[**@adcp/client API Reference v3.1.0**](../README.md)

***

[@adcp/client API Reference](../globals.md) / UpdateMediaBuyRequestSchema

# Variable: UpdateMediaBuyRequestSchema

> `const` **UpdateMediaBuyRequestSchema**: `ZodIntersection`\<`ZodObject`\<\{ `media_buy_id`: `ZodOptional`\<`ZodString`\>; `buyer_ref`: `ZodOptional`\<`ZodString`\>; `active`: `ZodOptional`\<`ZodBoolean`\>; `start_time`: `ZodOptional`\<`ZodUnion`\<readonly \[`ZodLiteral`\<`"asap"`\>, `ZodString`\]\>\>; `end_time`: `ZodOptional`\<`ZodString`\>; `packages`: `ZodOptional`\<`ZodArray`\<`ZodUnion`\<readonly \[`ZodRecord`\<`ZodString`, `ZodUnknown`\>, `ZodRecord`\<`ZodString`, `ZodUnknown`\>\]\>\>\>; `push_notification_config`: `ZodOptional`\<`ZodObject`\<\{ `url`: `ZodString`; `token`: `ZodOptional`\<`ZodString`\>; `authentication`: `ZodObject`\<\{ `schemes`: `ZodTuple`\<\[`ZodUnion`\<...\>\], `null`\>; `credentials`: `ZodString`; \}, `$strip`\>; \}, `$strip`\>\>; `context`: `ZodOptional`\<`ZodObject`\<\{ \}, `$strip`\>\>; \}, `$strip`\>, `ZodRecord`\<`ZodString`, `ZodUnknown`\>\>

Defined in: [src/lib/types/schemas.generated.ts:1014](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/schemas.generated.ts#L1014)
