---
"@adcp/sdk": patch
---

Restore source array bounds on named Zod array references during schema generation, fixing the AdCP 3.3 beta.1 `TargetingOverlay.geo_countries` generation failure. Apply bounds at each use site so shared array aliases retain their existing behavior elsewhere, and keep unresolved or cyclic references fail-closed.
