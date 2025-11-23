[**@adcp/client API Reference v3.1.0**](../README.md)

***

[@adcp/client API Reference](../globals.md) / CPMAuctionPricingOptionSchema

# Variable: CPMAuctionPricingOptionSchema

> `const` **CPMAuctionPricingOptionSchema**: `ZodObject`\<\{ `pricing_option_id`: `ZodString`; `pricing_model`: `ZodLiteral`\<`"cpm"`\>; `currency`: `ZodString`; `is_fixed`: `ZodLiteral`\<`false`\>; `price_guidance`: `ZodObject`\<\{ `floor`: `ZodNumber`; `p25`: `ZodOptional`\<`ZodNumber`\>; `p50`: `ZodOptional`\<`ZodNumber`\>; `p75`: `ZodOptional`\<`ZodNumber`\>; `p90`: `ZodOptional`\<`ZodNumber`\>; \}, `$strip`\>; `min_spend_per_package`: `ZodOptional`\<`ZodNumber`\>; \}, `$strip`\>

Defined in: [src/lib/types/schemas.generated.ts:198](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/schemas.generated.ts#L198)
