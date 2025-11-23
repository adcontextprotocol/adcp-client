[**@adcp/client API Reference v3.1.0**](../README.md)

***

[@adcp/client API Reference](../globals.md) / DeliveryMetricsSchema

# Variable: DeliveryMetricsSchema

> `const` **DeliveryMetricsSchema**: `ZodIntersection`\<`ZodRecord`\<`ZodString`, `ZodUnknown`\>, `ZodObject`\<\{ `impressions`: `ZodOptional`\<`ZodNumber`\>; `spend`: `ZodOptional`\<`ZodNumber`\>; `clicks`: `ZodOptional`\<`ZodNumber`\>; `ctr`: `ZodOptional`\<`ZodNumber`\>; `views`: `ZodOptional`\<`ZodNumber`\>; `completed_views`: `ZodOptional`\<`ZodNumber`\>; `completion_rate`: `ZodOptional`\<`ZodNumber`\>; `conversions`: `ZodOptional`\<`ZodNumber`\>; `leads`: `ZodOptional`\<`ZodNumber`\>; `grps`: `ZodOptional`\<`ZodNumber`\>; `reach`: `ZodOptional`\<`ZodNumber`\>; `frequency`: `ZodOptional`\<`ZodNumber`\>; `quartile_data`: `ZodOptional`\<`ZodObject`\<\{ `q1_views`: `ZodOptional`\<`ZodNumber`\>; `q2_views`: `ZodOptional`\<`ZodNumber`\>; `q3_views`: `ZodOptional`\<`ZodNumber`\>; `q4_views`: `ZodOptional`\<`ZodNumber`\>; \}, `$strip`\>\>; `dooh_metrics`: `ZodOptional`\<`ZodObject`\<\{ `loop_plays`: `ZodOptional`\<`ZodNumber`\>; `screens_used`: `ZodOptional`\<`ZodNumber`\>; `screen_time_seconds`: `ZodOptional`\<`ZodNumber`\>; `sov_achieved`: `ZodOptional`\<`ZodNumber`\>; `calculation_notes`: `ZodOptional`\<`ZodString`\>; `venue_breakdown`: `ZodOptional`\<`ZodArray`\<`ZodObject`\<\{ `venue_id`: `ZodString`; `venue_name`: `ZodOptional`\<...\>; `venue_type`: `ZodOptional`\<...\>; `impressions`: `ZodNumber`; `loop_plays`: `ZodOptional`\<...\>; `screens_used`: `ZodOptional`\<...\>; \}, `$strip`\>\>\>; \}, `$strip`\>\>; \}, `$strip`\>\>

Defined in: [src/lib/types/schemas.generated.ts:645](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/schemas.generated.ts#L645)
