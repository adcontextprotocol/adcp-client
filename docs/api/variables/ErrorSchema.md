[**@adcp/client API Reference v3.1.0**](../README.md)

***

[@adcp/client API Reference](../globals.md) / ErrorSchema

# Variable: ErrorSchema

> `const` **ErrorSchema**: `ZodObject`\<\{ `code`: `ZodString`; `message`: `ZodString`; `field`: `ZodOptional`\<`ZodString`\>; `suggestion`: `ZodOptional`\<`ZodString`\>; `retry_after`: `ZodOptional`\<`ZodNumber`\>; `details`: `ZodOptional`\<`ZodRecord`\<`ZodString`, `ZodUnknown`\>\>; \}, `$strip`\>

Defined in: [src/lib/types/schemas.generated.ts:433](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/schemas.generated.ts#L433)
