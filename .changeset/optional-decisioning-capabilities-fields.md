---
"@adcp/sdk": patch
---

Make `DecisioningCapabilities.creative_agents`, `channels`, and `pricingModels` optional. Signals-only platforms (`signal-marketplace`, `signal-owned`) sell audience data access, not media inventory — they don't compose with creative agents, don't sell media channels, and don't use channel-level pricing models. Forcing empty-array declarations was surprise friction for adopters building signals adapters. Adds a compile-time type-check asserting signals-only capabilities compile without these fields.
