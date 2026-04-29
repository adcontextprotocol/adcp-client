---
'@adcp/sdk': patch
---

`createAdcpServerFromPlatform` now projects `capabilities.supportedBillings` onto the wire `get_adcp_capabilities.account.supported_billing` block. Without this, retail-media adopters that declared `['operator']` saw their buyers default-route through agent-billed pass-through flows. Same projection seam as the F9 `require_operator_auth` fix. Surfaced by training-agent v6 spike (F5).
