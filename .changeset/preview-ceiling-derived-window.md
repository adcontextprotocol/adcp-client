---
'@adcp/sdk': patch
---

`createAdcpServer` with a prerelease `adcpVersion` and no `capabilities.supported_versions` no longer advertises or negotiates a different prerelease that the SDK packages. The derived window is the stable releases plus the configured preview, so a seller that registers its own preview bundle does not also serve the SDK's. The `adcpVersion` docs now state that handlers run in the ceiling release for every caller, so raising the ceiling to a preview changes the shape handlers return for older pins.
