---
'@adcp/sdk': patch
---

Capability discovery now validates `get_adcp_capabilities` against the release the seller served instead of the caller's pin (#3278). A 3.0 pin cannot carry `adcp_version`, so the SDK sends only `adcp_major_version: 3`. The seller then serves its highest 3.x release and echoes it in `adcp_version`, and the versioning spec says buyers validate against that echo. `discoverAgentProfile` (used by `testCapabilityDiscovery`, `comply()` and the storyboard runner) and `TaskExecutor` validated a 3.2 response strictly against 3.0. A conformant agent got false `capabilities_schema_issues` (for example `media_buy.features.bidding_policy must be boolean`, or the closed 3.0 `compliance_testing.scenarios` enum), and `getAdcpCapabilities()` failed in strict mode. Both now use the echoed release when it is in the pin's major and the SDK bundles its schema. They fall back to the pin when the echo is missing, from another major, or not bundled. Validation stays strict.
