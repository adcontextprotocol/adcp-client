---
'@adcp/sdk': patch
---

`createAdcpServerFromPlatform` now throws a `PlatformConfigError` when its options carry `capabilities`. The options type already omits `capabilities`, but JavaScript callers and casts could pass it, and the server silently ignored it, advertising the platform's own capabilities instead: `opts.capabilities.supported_versions` and `opts.capabilities.overrides` (for example `request_signing`) never reached `get_adcp_capabilities`. **JS callers that pass `capabilities` in the options must move it to the platform declaration** (`platform.capabilities.supported_versions`, `platform.capabilities.overrides`, …). The build-an-agent, signing and media-buy 3.2 compatibility guides showed the options form and now declare it on the platform. `createAdcpServer` still accepts `capabilities` in its config.
