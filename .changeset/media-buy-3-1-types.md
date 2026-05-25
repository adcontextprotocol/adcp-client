---
'@adcp/sdk': minor
---

fix(media-buy): use generated 3.1 types for `available_actions[]` surface

The hand-written wire-shape types in `src/lib/media-buy/types.ts` (`MediaBuyValidAction`, `MediaBuyActionMode`, `MediaBuyAvailableAction`, `ActionNotAllowedReason`, `ActionNotAllowedDetails`, and the SLA window) are deleted and replaced with re-exports from `src/lib/types/core.generated.ts` now that the AdCP 3.1.0-beta.3 schema cache produces them.

**Breaking type shape fix.** The previously-shipped `SlaWindow` was `{ unit, value, response_max? }`. The spec evolved to `SLAWindow` (caps, ISO acronym convention) with shape `{ response_max?, completion_max? }` where both are ISO 8601 duration strings. Adopters reading `available_actions[0].sla.response_max` against the prior type would have hit a runtime shape mismatch when sellers actually populated `sla`. `SLAWindow` is the canonical export; `SlaWindow` remains as a deprecated import-compatibility alias to the corrected generated shape.

Helper-local types stay: `LEGACY_COARSE_ACTIONS`, `LegacyCoarseAction`, `MediaBuyActionContext`, `UpdateMediaBuyRequestLike`. These are convenience subsets the preflight resolver reads against and aren't part of the wire schema.

`scripts/generate-media-buy-update-fields.ts` re-ran against the real 3.1.0-beta.3 cache. The generated `enumMetadata.update_fields` table is unchanged from the snapshot taken against the merged-but-pre-release upstream copy.

Preflight logic, boolean gates, `ActionNotAllowedError`, and the compat shim for `valid_actions[]` are unchanged.
