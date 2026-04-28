---
'@adcp/sdk': minor
'@adcp/client': minor
---

feat: add `adcpVersion` constructor option on client + server surfaces

`SingleAgentClient`, `AgentClient`, `ADCPMultiAgentClient`, and `createAdcpServer` now accept an `adcpVersion?: AdcpVersion | (string & {})` option that surfaces via a new `getAdcpVersion()` instance method. Typed as a union of `COMPATIBLE_ADCP_VERSIONS` literals plus an open-string escape hatch so editors autocomplete canonical values without forcing a closed enum.

Defaults to the SDK's pinned `ADCP_VERSION` (currently `'3.0.1'`) when omitted. Pin to an older stable (`'3.0.0'`) or opt into a beta channel (`'3.1.0-beta.1'`) once the corresponding registry ships.

Validated at construction time via `resolveAdcpVersion`: pins whose derived major differs from `ADCP_MAJOR_VERSION` throw `ConfigurationError` with a roadmap-aware message pointing at Stage 3. This fence keeps Stage 2's wire emission honest while the global `ADCP_MAJOR_VERSION` constant still drives the `adcp_major_version` request field — within major 3, every accepted pin agrees with the wire.

Plumbing surface only — Stage 2 of the multi-version refactor. The configured value is exposed and propagated, but validators and schema selection still key off the global `ADCP_VERSION` constant. Stage 3 wires per-instance schema loading off this getter so cross-version testing (a 3.0 client speaking to a 3.1 server in the same process) works without npm aliases.

`AdcpServerConfig.adcpVersion` is independent of `AdcpServerConfig.version`; the latter is the publisher's app version, the former is the AdCP protocol version on the wire.
