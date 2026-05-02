---
"@adcp/sdk": patch
---

fix(codegen): alias 6 jsts under-resolution artifacts after AdCP 3.0.4 asset-union landing

AdCP 3.0.2 introduced `core/assets/asset-union.json` (adcp#3462) as the canonical home for the asset-variant `oneOf`. The bundler still inlines the union at both `creative-asset.json` and `creative-manifest.json` call sites, and `json-schema-to-typescript` under-resolves the second compile pass — dropping the `asset_type` discriminator that the first pass preserved. Six survivors of `removeNumberedTypeDuplicates`'s byte-identity check:

| Type          | First pass (correct)                                  | Second pass (under-resolved)         |
|---------------|-------------------------------------------------------|--------------------------------------|
| `VASTAsset`   | `{ asset_type: 'vast'; …metadata… } & (delivery_union)` | `(delivery_union)` — lost wrapper    |
| `BriefAsset`  | `CreativeBrief & { asset_type: 'brief' }`             | `CreativeBrief` — lost discriminator |
| `DAASTAsset`, `CatalogAsset`, `AssetVariant`, `CreativeAsset` | … | … |

`applyKnownJstsAliases` runs after the byte-identity dedupe pass and rewrites each known artifact as `type Foo1 = Foo` with a `@deprecated` JSDoc. Type-level safe: the bundled response carries `asset_type` correctly at runtime, so the under-resolved type was strictly weaker than the wire format. The alias gives consumers the correctly-discriminated shape that matches what they receive on the wire. Zod codegen consumes the aliased types and emits matching schema aliases automatically.

Closes #1264.
