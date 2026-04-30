---
'@adcp/sdk': patch
---

`createAdcpServerFromPlatform` now projects `compliance_testing.scenarios` onto `get_adcp_capabilities`. Previously the framework validated capability/adapter consistency (refusing the `complyTest`-without-capability or capability-without-`complyTest` shapes at construction) but never wrote the wire response — buyers calling `get_adcp_capabilities` saw an empty `compliance_testing: {}` block and the comply-track runner fired a warning on every call. Auto-derives scenarios from the wired adapter set (force + simulate; seeds deliberately not advertised, per the spec's narrowed wire enum). An explicit `capabilities.compliance_testing.scenarios` overrides auto-derivation when adopters want to advertise a subset. Internal `ComplianceTestingCapabilities.scenarios` type tightened to the wire's force-plus-simulate enum to match. Surfaced by training-agent v6 spike round 5 (Issue 4).
