---
'@adcp/sdk': minor
---

feat(types): tighten `Format.assets` typing and emit named slot unions + Zod schemas

Closes adcontextprotocol/adcp-client#1652.

The codegen post-processor that restored the `asset_type` discriminator on `Individual*Asset` slot types (#1498) now also:

- Imports the `*AssetRequirements` types into `tools.generated.ts` from `core.generated.ts`, so the per-slot `requirements?:` field is preserved on every `IndividualImageAsset` / `IndividualVideoAsset` / … exported from the tools surface (previously missing — a downstream cast pattern).
- Restores the same `asset_type` + `requirements` discriminator on the 12 `Group*Asset` shapes inside `RepeatableGroupAsset.assets[]`.
- Emits named `IndividualAssetSlot`, `GroupAssetSlot`, and `FormatAssetSlot` unions in both `core.generated.ts` and `tools.generated.ts`, and tightens `Format.assets?: FormatAssetSlot[]` and `RepeatableGroupAsset.assets: GroupAssetSlot[]` to reference them.
- ts-to-zod picks up the named unions, so the generated schemas now include `IndividualAssetSlotSchema`, `GroupAssetSlotSchema`, `FormatAssetSlotSchema`, and per-type `IndividualImageAssetSchema { asset_type, requirements }` / `GroupImageAssetSchema { asset_type, requirements }` carrying the requirements branch.

Consumer impact:

- `Format.assets[i]` narrows correctly: `slot.asset_type === 'image'` now gives `slot.requirements: ImageAssetRequirements | undefined` for free. The cast pattern from #1652's worked example goes away.
- New runtime-validation entry points: import `IndividualAssetSlotSchema`, `GroupAssetSlotSchema`, or `FormatAssetSlotSchema` from `@adcp/sdk` instead of forking a local `z.union([...])` over the per-type schemas.
- The hand-authored `src/lib/types/format-asset-slots.ts` shim is reduced to thin `*Slot` aliases over the codegen names. Consumers importing `IndividualImageAssetSlot` etc. continue to work; the underlying type is now identical to the spec-derived `IndividualImageAsset`. **Optionality note:** the prior hand-authored shim modeled `requirements` as required on the `*Slot` types; it is now optional (`?:`) to match the spec, where the field appears in `properties` but never in `required`. Adopters that destructured `slot.requirements` and treated the value as defined will need to handle `undefined` or assert.
- Two no-op group builders (`briefGroupAsset`, `catalogGroupAsset`) are removed from `@adcp/sdk`'s public exports. The spec doesn't include `brief` or `catalog` in `RepeatableGroupAsset.assets[].oneOf`, so calling these always produced an object that would fail wire-schema validation. Treated as a bug-fix removal under the minor bump rather than a breaking contract change. The 12 valid `*GroupAsset` builders (and their `FormatAsset.group*` namespace entries) are unchanged.
