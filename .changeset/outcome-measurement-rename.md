---
'@adcp/sdk': major
---

fix(types): handle `OutcomeMeasurement` → `OutcomeMeasurementDeprecated` rename (AdCP 3.1.0-beta.2)

3.1.0-beta.2 renamed the `OutcomeMeasurement` interface to `OutcomeMeasurementDeprecated` to signal the surface is on the 4.0 removal track. The rename broke the index.ts re-export and the compat.ts `Measurement` alias.

**Adopter-facing:** purely additive. The original `OutcomeMeasurement` name continues to resolve (re-exported from `OutcomeMeasurementDeprecated`); adopters who imported the old name keep working unchanged. New code SHOULD import `OutcomeMeasurementDeprecated` to make the deprecation visible at the call site.

Part of the #1902 8.0-beta sweep (closes one of the 5 structural breaks listed in the foundation PR).
