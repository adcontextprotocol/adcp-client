---
'@adcp/sdk': patch
---

Capability discovery on a client pinned to a preview release (for example `adcpVersion: '3.3.0-rc.0'`) now returns the seller's answer at that release when the seller advertises it, so preview-only features are no longer read as undeclared (adcp-client#3765, #3715).

- **Re-probe at the pin.** Discovery for a preview pin still goes out unpinned first. When that answer lists the exact pin in `adcp.supported_versions` but was served at another release, the client asks once more, pinned to it, and uses the pinned answer. It applies to `getAdcpCapabilities()`, to the internal capability probe behind `getCapabilities()` and feature checks such as `supports('experimental:media_buy.collection_catalog')`, and to storyboard and `comply()` profiling. The pinned answer is what gets cached, including in a shared `discoveryCache`. A seller that does not list the exact pin is not re-probed and keeps its unpinned answer. `comply()`'s `major-only` fallback for older sellers is unchanged.
- **When the re-probe is skipped or falls back.** If the pinned request fails, the unpinned answer is returned, as with the existing stable-pin retry. An abort or timeout still propagates. A call with its own `operationId` is not re-probed, so the returned task keeps that id. A pin you choose yourself (`adcp_version` or `adcp_major_version` in params, or an explicit `versionEnvelope`) is sent as-is, with no re-probe or retry.
- **Seeing which release answered.** Read `result.metadata.adcpVersion` (the seller's echoed release, also `data.adcp_version`) and compare it with your pin at release precision. `result.metadata.wireAdcpVersion` is the pin the SDK sent, and is set on a re-probed answer. It is absent when a preview client's discovery went out unpinned. `getCapabilities()` reports the same release as `servedVersion`.
- **Per-call pin.** `getAdcpCapabilities({ adcp_version })` now accepts a full-semver value: `'3.3.0-rc.0'` is collapsed to the wire form `'3.3-rc.0'` before request validation, which used to reject it. Other values are passed to validation unchanged.

Storyboard runs pinned to a prerelease now build the agent profile from the pinned answer when the agent advertises the exact pin. Capability-gated prerelease storyboards then run against those agents instead of grading as `capability_unsupported`.
