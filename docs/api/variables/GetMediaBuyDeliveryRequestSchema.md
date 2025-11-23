[**@adcp/client API Reference v3.1.0**](../README.md)

***

[@adcp/client API Reference](../globals.md) / GetMediaBuyDeliveryRequestSchema

# Variable: GetMediaBuyDeliveryRequestSchema

> `const` **GetMediaBuyDeliveryRequestSchema**: `ZodObject`\<\{ `media_buy_ids`: `ZodOptional`\<`ZodArray`\<`ZodString`\>\>; `buyer_refs`: `ZodOptional`\<`ZodArray`\<`ZodString`\>\>; `status_filter`: `ZodOptional`\<`ZodUnion`\<readonly \[`ZodUnion`\<readonly \[`ZodLiteral`\<`"active"`\>, `ZodLiteral`\<`"pending"`\>, `ZodLiteral`\<`"paused"`\>, `ZodLiteral`\<`"completed"`\>, `ZodLiteral`\<`"failed"`\>, `ZodLiteral`\<`"all"`\>\]\>, `ZodArray`\<`ZodUnion`\<readonly \[`ZodLiteral`\<`"active"`\>, `ZodLiteral`\<`"pending"`\>, `ZodLiteral`\<`"paused"`\>, `ZodLiteral`\<`"completed"`\>, `ZodLiteral`\<`"failed"`\>\]\>\>\]\>\>; `start_date`: `ZodOptional`\<`ZodString`\>; `end_date`: `ZodOptional`\<`ZodString`\>; `context`: `ZodOptional`\<`ZodObject`\<\{ \}, `$strip`\>\>; \}, `$strip`\>

Defined in: [src/lib/types/schemas.generated.ts:634](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/schemas.generated.ts#L634)
