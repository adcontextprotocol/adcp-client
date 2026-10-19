---
'@adcp/sdk': major
---

Remove AdCP 2 compatibility following its August 1, 2026 end of life. Agents declaring only AdCP 2, or missing the required AdCP 3 capability discovery tool, now fail with `VERSION_UNSUPPORTED` instead of routing through legacy adapters. Remove the AdCP 2 adapters, type exports, schema bundles, sync/codegen scripts, `allowV2` option, `ADCP_ALLOW_V2` override, and CLI `--allow-v2` flag. Existing AdCP 2 deployments must upgrade their agents or pin an older SDK release.

Derive agent major versions from `adcp.supported_versions` before consulting the deprecated `adcp.major_versions` field. Capability responses without either version declaration default to AdCP 3. AdCP 3.0 and 3.1 remain supported.
