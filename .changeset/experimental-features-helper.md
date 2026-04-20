---
'@adcp/client': minor
---

Add `experimental_features` support on capabilities (adcp-client#627).

`AdcpCapabilities` now carries an `experimentalFeatures?: string[]` field populated from the AdCP 3.0 GA `experimental_features` envelope on `get_adcp_capabilities` responses. New helper `supportsExperimentalFeature(caps, id)` lets consumers gate reliance on `x-status: experimental` surfaces (`brand.rights_lifecycle`, `governance.campaign`, `trusted_match.core`, etc.) on an explicit seller opt-in. `resolveFeature` handles the `experimental:<id>` namespace so `require()`/`supports()` flows work the same way they do for `ext:<name>` extensions.

The `custom` vendor-pricing variant and the `per_unit` catchup from AdCP 3.0 GA were already picked up in the previous types regeneration — no type-surface changes ship with this release.
