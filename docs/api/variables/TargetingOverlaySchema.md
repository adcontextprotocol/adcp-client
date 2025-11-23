[**@adcp/client API Reference v3.1.0**](../README.md)

***

[@adcp/client API Reference](../globals.md) / TargetingOverlaySchema

# Variable: TargetingOverlaySchema

> `const` **TargetingOverlaySchema**: `ZodObject`\<\{ `geo_country_any_of`: `ZodOptional`\<`ZodArray`\<`ZodString`\>\>; `geo_region_any_of`: `ZodOptional`\<`ZodArray`\<`ZodString`\>\>; `geo_metro_any_of`: `ZodOptional`\<`ZodArray`\<`ZodString`\>\>; `geo_postal_code_any_of`: `ZodOptional`\<`ZodArray`\<`ZodString`\>\>; `axe_include_segment`: `ZodOptional`\<`ZodString`\>; `axe_exclude_segment`: `ZodOptional`\<`ZodString`\>; `frequency_cap`: `ZodOptional`\<`ZodObject`\<\{ `suppress_minutes`: `ZodNumber`; \}, `$strip`\>\>; \}, `$strip`\>

Defined in: [src/lib/types/schemas.generated.ts:340](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/schemas.generated.ts#L340)
