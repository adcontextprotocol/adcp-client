---
'@adcp/client': minor
---

**Add `${Parent}_${Property}Values` const arrays for inline anonymous string-literal unions** (closes #932).

Companion to the named-enum exports landed in 5.17 (PR #931). The earlier shipment covered every spec enum that has a stable named type (`MediaChannelValues`, `PacingValues`, etc., 122 total). This release adds the inline anonymous unions that don't have stable named types in the generated TypeScript — exactly the cases where consumers were re-declaring spec literal sets in their own validation code:

```ts
// Before — drift bait, hand-maintained on the consumer side.
const VALID_IMAGE_FORMATS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'avif', 'tiff', 'pdf', 'eps']);
const VALID_VIDEO_CONTAINERS = new Set(['mp4', 'webm', 'mov', 'avi', 'mkv']);

// After — authoritative, drift-detected.
import {
  ImageAssetRequirements_FormatsValues,
  VideoAssetRequirements_ContainersValues,
} from '@adcp/client/types';
```

**Naming convention.** Every `z.union([z.literal(...), ...])` (or its `z.array(...)`-wrapped variant) inside a named object schema gets a corresponding export named `${ParentSchema}_${PropertyName}Values`, where the property name is PascalCased. Property paths that reference a named enum (e.g. `unit: DimensionUnitSchema.optional()`) are intentionally skipped — use the matching `${TypeName}Values` from `enums.generated.ts`.

**Coverage.** 104 inline-union arrays exported across 51 parent schemas. User-flagged cases all included: `ImageAssetRequirements_FormatsValues`, `VideoAssetRequirements_FormatsValues` / `_ContainersValues` / `_CodecsValues`, `AudioAssetRequirements_FormatsValues` / `_ChannelsValues`, plus video frame-rate/scan-type/GOP-type discriminators, audio channel layouts, account scopes, payment terms, and many more.

**Implementation.** New script `scripts/generate-inline-enum-arrays.ts` walks the compiled Zod schemas via runtime introspection (Zod 4 `_def`) rather than regex on the generated TS — cleaner and future-proofs against codegen output format changes. Output goes to `src/lib/types/inline-enums.generated.ts`. Wired into the existing `generate-zod-schemas` script (runs after Zod codegen, since it depends on Zod schemas being current). The new test `test/lib/inline-enum-arrays.test.js` cross-validates every emitted array against the parent Zod schema property — if either side drifts, the test fails fast.

**Behavior unchanged for existing consumers.** Pure addition; no public-API rename, no breaking change to `enums.generated.ts`. Adapters can drop their hand-maintained `VALID_IMAGE_FORMATS`-style constants in a follow-up.
