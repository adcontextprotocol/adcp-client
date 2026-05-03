---
'@adcp/sdk': patch
---

fix(codegen): preserve `asset_type` discriminator on `IndividualImageAsset` / `IndividualVideoAsset` / etc. (closes #1498)

The format-side asset slot types (`IndividualImageAsset`,
`IndividualVideoAsset`, `IndividualAudioAsset`, ...) were collapsing
to bare `BaseIndividualAsset` aliases because
`json-schema-to-typescript` flattened the schema's
`allOf: [{$ref: baseIndividualAsset}]` plus extra
`properties.asset_type.const` discriminator. Adopters writing
TS-clean code constructing one of these literals without `asset_type`
got a runtime `VALIDATION_ERROR` against the wire schema despite the
TS compiler being happy.

This change adds a codegen post-processor
(`applyIndividualAssetDiscriminators`) that rewrites the 14
`Individual*Asset = BaseIndividualAsset` aliases into discriminated
intersections:

```ts
export type IndividualImageAsset = BaseIndividualAsset & {
  asset_type: 'image';
  requirements?: ImageAssetRequirements;
};
```

Now TS catches the missing `asset_type` at compile time, matching
the wire-schema requirement.

Same treatment for `IndividualVideoAsset`, `IndividualAudioAsset`,
`IndividualTextAsset`, `IndividualMarkdownAsset`, `IndividualHtmlAsset`,
`IndividualCssAsset`, `IndividualJavaScriptAsset`, `IndividualVastAsset`,
`IndividualDaastAsset`, `IndividualUrlAsset`, `IndividualWebhookAsset`,
`IndividualBriefAsset`, `IndividualCatalogAsset`. The `requirements`
field is omitted on `tools.generated.ts` where the per-type
`*AssetRequirements` interface isn't redeclared.

**Compat:** Adopters who previously constructed these literals
without `asset_type` will now see a TS error. The wire validator
already rejected these at runtime, so the new TS error catches a
strictly pre-existing bug at build time. No runtime behavior change.
