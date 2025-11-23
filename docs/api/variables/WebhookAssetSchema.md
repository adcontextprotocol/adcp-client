[**@adcp/client API Reference v3.1.0**](../README.md)

***

[@adcp/client API Reference](../globals.md) / WebhookAssetSchema

# Variable: WebhookAssetSchema

> `const` **WebhookAssetSchema**: `ZodObject`\<\{ `url`: `ZodString`; `method`: `ZodOptional`\<`ZodUnion`\<readonly \[`ZodLiteral`\<`"GET"`\>, `ZodLiteral`\<`"POST"`\>\]\>\>; `timeout_ms`: `ZodOptional`\<`ZodNumber`\>; `supported_macros`: `ZodOptional`\<`ZodArray`\<`ZodString`\>\>; `required_macros`: `ZodOptional`\<`ZodArray`\<`ZodString`\>\>; `response_type`: `ZodUnion`\<readonly \[`ZodLiteral`\<`"html"`\>, `ZodLiteral`\<`"json"`\>, `ZodLiteral`\<`"xml"`\>, `ZodLiteral`\<`"javascript"`\>\]\>; `security`: `ZodObject`\<\{ `method`: `ZodUnion`\<readonly \[`ZodLiteral`\<`"hmac_sha256"`\>, `ZodLiteral`\<`"api_key"`\>, `ZodLiteral`\<`"none"`\>\]\>; `hmac_header`: `ZodOptional`\<`ZodString`\>; `api_key_header`: `ZodOptional`\<`ZodString`\>; \}, `$strip`\>; \}, `$strip`\>

Defined in: [src/lib/types/schemas.generated.ts:712](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/schemas.generated.ts#L712)
