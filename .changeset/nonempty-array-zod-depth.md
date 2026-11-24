---
'@adcp/sdk': patch
---

Keep `z.infer` of the exported Zod schemas within TypeScript's instantiation depth (#3472). Slicing, mapping or spreading arrays of `z.infer<typeof GetMediaBuyDeliveryResponseSchema>`, and inferring `InstallmentDeliveryMetricsSchema`, failed with TS2589 since 17.0.0-beta.2.

- `NonemptyArraySchema<T>` is now a `z.ZodArray<T>` whose internals carry the `[T, ...T[]]` input and output, instead of a `z.ZodType` of the tuple that instantiated every ZodType member with the full element type. `z.infer` and `z.input` results are unchanged, and the schema is now assignable wherever a `z.ZodArray<T>` is expected. Its internals type, `NonemptyArrayInternals<T>`, is exported next to it.
- `PublishedPostAssetSchema` carried nine identical copies of its object and union operands, which pushed `z.infer` of `CollectionSchema`, `CollectionPayloadSchema`, `ListCollectionsResponseSchema`, `ListProductsResponseSchema`, `RegistryFeedResponseSchema` and `ResponseCollectionSchema` past the depth limit. The generator now collapses them; validation is unchanged.

Exporting `.meta()` or `.describe()` of the largest schemas without a type annotation can still hit TS7056 in declaration emit; annotate it as `typeof TheSchema` (see `docs/ZOD-SCHEMAS.md`).
