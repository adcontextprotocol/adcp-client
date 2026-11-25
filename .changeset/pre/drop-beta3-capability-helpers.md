---
'@adcp/sdk': minor
---

Remove the AdCP 3.1.0-beta.3 `capability_ids` helpers from `@adcp/sdk/v2/projection` before 17.0 freezes them (#1899): `packageRefsForCapabilities`, `legacyFormatIdsForCapability`, `CapabilityIdsLookupError`, `CapabilityIdsLookupErrorCode` and `PackageCapabilityRefs`. They have been deprecated since SDK 8.1 and emit a `capability_ids` package field that beta.5 and later sellers reject. Use `packageRefsForFormatOptions` and `legacyFormatIdsForFormatOption`, which select by `format_option_id`. The migration guide maps each removed name.
