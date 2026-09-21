---
'@adcp/sdk': minor
---

Add `resolveVerifiedAcceptancePolicyProfiles`, registry-resolution options and public resolver/result types. Registry profiles become usable only after exact policy, version, canonical policy digest, embedded profile identity, and profile digest verification; failures remain explicitly unresolved with structured diagnostics.

Allow `RegistryClient.resolvePolicy()` callers to pass an `AbortSignal`, enabling bounded batch resolution without replacing the client's internal request timeout.

`ResolvedAcceptancePolicyDefault` now includes a `source: 'registry', resolution: 'resolved'` member, so exhaustive consumers should handle the verified registry case.
