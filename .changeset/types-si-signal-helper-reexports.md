---
"@adcp/sdk": patch
---

Re-export SI and signals helper types from `@adcp/sdk/types`: `SICapabilities`, `SIIdentity`, `SISessionStatus`, `SIUIElement`, `SignalFilters`, `SignalTargeting`. Adopters typing handler internals no longer need to reach into `tools.generated`. `AssetVariant` is intentionally excluded — it is a narrower generated union (omits `AudioAsset`); prefer the curated `AssetInstance` union already exported from `@adcp/sdk/types`.
