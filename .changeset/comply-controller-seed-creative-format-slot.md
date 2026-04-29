---
'@adcp/sdk': minor
---

`ComplyControllerConfig.seed.creative_format` slot. The `seed_creative_format` scenario already existed in the wire enum + `SEED_SCENARIOS` constants + `TestControllerStore.seedCreativeFormat`; the domain-grouped façade `ComplyControllerConfig.seed` was the only surface that didn't expose it. Adopters with v5 `seed_creative_format` adapters wired through `registerTestController` directly had no path through `createAdcpServerFromPlatform({ complyTest })` and were forced to drop to the lower-level surface. New `creative_format?: SeedAdapter<SeedCreativeFormatParams>` slot closes the gap; `SeedCreativeFormatParams` re-exported from `@adcp/sdk/testing`. Surfaced by training-agent v6 spike (F14).
