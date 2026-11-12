---
'@adcp/sdk': patch
---

Capability discovery reaches sellers that do not advertise the client's preview release, or that gate the MCP `server/discover` probe.

- `getAdcpCapabilities()` no longer sends a preview pin such as `3.3-beta.5`. A preview pin is sent only to a seller that advertises that exact release, so preview discovery goes out unpinned, as the internal capability probe already did. A stable pin the seller refuses with `VERSION_UNSUPPORTED` is retried once unpinned. A pin you choose yourself (`adcp_version` or `adcp_major_version` in params, or an explicit `versionEnvelope`) is sent as-is, and the seller's refusal comes back with its `supported_versions` in `adcpError.details`.
- Testing and storyboard profile discovery follow the same rule. A 3.0-only seller tested on a preview pin is now profiled. `comply()` then fails with `CapabilityResolutionError` (`code: 'unsupported_adcp_version'`) naming the seller's `supported_versions`, instead of reporting "Agent unreachable — VERSION_UNSUPPORTED". `applyAdcpVersionRunOptions()` and `applyStoryboardVersionOptions()` now leave `versionEnvelope` unset for AdCP 3 runs. That is the SDK default, which still sends the full envelope on ordinary calls, and it no longer counts as an explicit choice that pins discovery. Tests that set `versionEnvelope` keep their pinned discovery probe.
- A client with no credential now falls back to legacy MCP `initialize` when a seller answers `401`/`403` on `server/discover` alone, as a client with a static credential already did. AdCP capability discovery is anonymous, so the seller is discovered. If `initialize` is refused too, or fails for an unrelated reason, the seller's `401` and `WWW-Authenticate` challenge reach the caller as before. OAuth-provider clients are unchanged.
