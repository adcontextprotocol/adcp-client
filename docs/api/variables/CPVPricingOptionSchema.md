[**@adcp/client API Reference v3.1.0**](../README.md)

***

[@adcp/client API Reference](../globals.md) / CPVPricingOptionSchema

# Variable: CPVPricingOptionSchema

> `const` **CPVPricingOptionSchema**: `ZodObject`\<\{ `pricing_option_id`: `ZodString`; `pricing_model`: `ZodLiteral`\<`"cpv"`\>; `rate`: `ZodNumber`; `currency`: `ZodString`; `is_fixed`: `ZodLiteral`\<`true`\>; `parameters`: `ZodObject`\<\{ `view_threshold`: `ZodUnion`\<readonly \[`ZodNumber`, `ZodObject`\<\{ `duration_seconds`: `ZodNumber`; \}, `$strip`\>\]\>; \}, `$strip`\>; `min_spend_per_package`: `ZodOptional`\<`ZodNumber`\>; \}, `$strip`\>

Defined in: [src/lib/types/schemas.generated.ts:255](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/schemas.generated.ts#L255)
