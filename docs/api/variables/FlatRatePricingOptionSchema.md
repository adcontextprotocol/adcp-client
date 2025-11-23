[**@adcp/client API Reference v3.1.0**](../README.md)

***

[@adcp/client API Reference](../globals.md) / FlatRatePricingOptionSchema

# Variable: FlatRatePricingOptionSchema

> `const` **FlatRatePricingOptionSchema**: `ZodObject`\<\{ `pricing_option_id`: `ZodString`; `pricing_model`: `ZodLiteral`\<`"flat_rate"`\>; `rate`: `ZodNumber`; `currency`: `ZodString`; `is_fixed`: `ZodLiteral`\<`true`\>; `parameters`: `ZodOptional`\<`ZodObject`\<\{ `duration_hours`: `ZodOptional`\<`ZodNumber`\>; `sov_percentage`: `ZodOptional`\<`ZodNumber`\>; `loop_duration_seconds`: `ZodOptional`\<`ZodNumber`\>; `min_plays_per_hour`: `ZodOptional`\<`ZodNumber`\>; `venue_package`: `ZodOptional`\<`ZodString`\>; `estimated_impressions`: `ZodOptional`\<`ZodNumber`\>; `daypart`: `ZodOptional`\<`ZodString`\>; \}, `$strip`\>\>; `min_spend_per_package`: `ZodOptional`\<`ZodNumber`\>; \}, `$strip`\>

Defined in: [src/lib/types/schemas.generated.ts:282](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/schemas.generated.ts#L282)
