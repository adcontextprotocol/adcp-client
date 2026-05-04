---
'@adcp/sdk': patch
---

`npm run build:lib` now runs `schemas:ensure` before the wire-spec-fields codegen. The codegen reads from `schemas/cache/{version}/` (gitignored, populated by `sync-schemas`), so building on a fresh checkout — or from a CI workflow that doesn't explicitly sync schemas first — would fail with `schema cache not found`. `schemas:ensure` is the idempotent guard the pretest hook already uses; ~10ms when the cache is present, syncs only when missing. Fixes the Release workflow which calls `build:lib` directly.
