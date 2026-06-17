---
'@adcp/sdk': minor
---

Add `RegistryClient.saveBrandLogo()` as the canonical AAO brand-logo helper, normalize list responses to `assets` while preserving the legacy `logos` alias, and bridge creative asset errors to canonical `code` with deprecated `error_code` compatibility.
