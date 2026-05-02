---
"@adcp/sdk": patch
---

Re-export SI and signals helper types from `@adcp/sdk/types`: `SICapabilities`, `SIIdentity`, `SISessionStatus`, `SIUIElement`, `SignalFilters`, `SignalTargeting`. Adopters typing handler internals no longer need to reach into `tools.generated`. `AssetVariant` is intentionally excluded — it is the same union as `AssetInstance` (already exported); use `AssetInstance`.
