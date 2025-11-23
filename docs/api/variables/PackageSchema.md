[**@adcp/client API Reference v3.1.0**](../README.md)

***

[@adcp/client API Reference](../globals.md) / PackageSchema

# Variable: PackageSchema

> `const` **PackageSchema**: `ZodObject`\<\{ `package_id`: `ZodString`; `buyer_ref`: `ZodOptional`\<`ZodString`\>; `product_id`: `ZodOptional`\<`ZodString`\>; `budget`: `ZodOptional`\<`ZodNumber`\>; `pacing`: `ZodOptional`\<`ZodUnion`\<readonly \[`ZodLiteral`\<`"even"`\>, `ZodLiteral`\<`"asap"`\>, `ZodLiteral`\<`"front_loaded"`\>\]\>\>; `pricing_option_id`: `ZodOptional`\<`ZodString`\>; `bid_price`: `ZodOptional`\<`ZodNumber`\>; `impressions`: `ZodOptional`\<`ZodNumber`\>; `targeting_overlay`: `ZodOptional`\<`ZodObject`\<\{ `geo_country_any_of`: `ZodOptional`\<`ZodArray`\<`ZodString`\>\>; `geo_region_any_of`: `ZodOptional`\<`ZodArray`\<`ZodString`\>\>; `geo_metro_any_of`: `ZodOptional`\<`ZodArray`\<`ZodString`\>\>; `geo_postal_code_any_of`: `ZodOptional`\<`ZodArray`\<`ZodString`\>\>; `axe_include_segment`: `ZodOptional`\<`ZodString`\>; `axe_exclude_segment`: `ZodOptional`\<`ZodString`\>; `frequency_cap`: `ZodOptional`\<`ZodObject`\<\{ `suppress_minutes`: `ZodNumber`; \}, `$strip`\>\>; \}, `$strip`\>\>; `creative_assignments`: `ZodOptional`\<`ZodArray`\<`ZodObject`\<\{ `creative_id`: `ZodString`; `weight`: `ZodOptional`\<`ZodNumber`\>; `placement_ids`: `ZodOptional`\<`ZodTuple`\<\[`ZodString`\], `ZodString`\>\>; \}, `$strip`\>\>\>; `format_ids_to_provide`: `ZodOptional`\<`ZodArray`\<`ZodObject`\<\{ `agent_url`: `ZodString`; `id`: `ZodString`; \}, `$strip`\>\>\>; `status`: `ZodUnion`\<readonly \[`ZodLiteral`\<`"draft"`\>, `ZodLiteral`\<`"active"`\>, `ZodLiteral`\<`"paused"`\>, `ZodLiteral`\<`"completed"`\>\]\>; \}, `$strip`\>

Defined in: [src/lib/types/schemas.generated.ts:862](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/schemas.generated.ts#L862)
