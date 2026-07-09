---
'@adcp/sdk': minor
---

Add a lean, zero-dependency `./enums` export. `import { EventTypeValues } from '@adcp/sdk/enums'` (and the other AdCP enum value arrays) now resolves to a zod-free entry point, so bundlers no longer pull the full `./types` barrel and zod (~1.84 MB) just to read an enum. Useful for zod-free consumers such as browser bundles. Re-exports the existing `types/enums.generated` (named unions) and `types/inline-enums.generated` (per-field unions) modules; no change to `./types`.
