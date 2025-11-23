[**@adcp/client API Reference v3.1.0**](../README.md)

***

[@adcp/client API Reference](../globals.md) / PushNotificationConfigSchema

# Variable: PushNotificationConfigSchema

> `const` **PushNotificationConfigSchema**: `ZodObject`\<\{ `url`: `ZodString`; `token`: `ZodOptional`\<`ZodString`\>; `authentication`: `ZodObject`\<\{ `schemes`: `ZodTuple`\<\[`ZodUnion`\<readonly \[`ZodLiteral`\<`"Bearer"`\>, `ZodLiteral`\<`"HMAC-SHA256"`\>\]\>\], `null`\>; `credentials`: `ZodString`; \}, `$strip`\>; \}, `$strip`\>

Defined in: [src/lib/types/schemas.generated.ts:464](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/schemas.generated.ts#L464)
