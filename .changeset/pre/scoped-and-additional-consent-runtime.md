---
'@adcp/sdk': minor
---

Support vendor-scoped TCF consent and Additional Consent in universal macro compilation, translation, and dropped/frozen consent diagnostics. Preserve existing native tokens and reject multiple scoped consent occurrences with the exported MultipleVendorConsentMacrosError.

Run the merged AdCP 3.3 conformance fixture, including embedded native-value diagnostics. The SDK's protocol schema pin remains unchanged; generated declaration and capability support follows a future protocol schema upgrade.
