---
"@adcp/client": minor
---

Add `linear_tv_platform` platform type for agents transacting linear TV inventory. Includes CPP and CPM pricing, reserved inventory model, and broadcast-specific creative workflow (ISCI codes via sync_creatives).

Add `get_media_buy_delivery` as an expected tool for all sales platform profiles. Every platform with a reporting track should support delivery data — this was previously only expected on DSP and generative DSP profiles.

Add behavioral characteristics (`inventory_model`, `pricing_models`) to all platform profiles. Add `cpc` pricing model for search and retail media platforms. Add `cpp` pricing model for linear TV.

Remove deprecated `FormatCategory` type, `CreativeFormatType` type, `findByType()` from `CreativeAgentClient`, and `findFormatsByType()` from `ADCPMultiAgentClient`. These were deprecated in favor of filtering by format assets directly.
