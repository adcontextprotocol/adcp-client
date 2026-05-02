---
"@adcp/sdk": minor
---

Make `DecisioningCapabilities.creative_agents`, `channels`, and `pricingModels` optional. Signals-only platforms (`signal-marketplace`, `signal-owned`) sell audience data access, not media inventory — they don't compose with creative agents, don't sell media channels, and don't use channel-level pricing models. Forcing empty-array declarations was surprise friction for adopters building signals adapters.

`validatePlatform` (called by `createAdcpServerFromPlatform`) now throws `PlatformConfigError` when any `sales-*` specialism is claimed and `channels` or `pricingModels` is absent — platforms that previously passed without these fields will fail at construction time.
