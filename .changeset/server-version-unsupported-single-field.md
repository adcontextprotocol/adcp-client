---
"@adcp/sdk": patch
---

fix(server): reject single-field unsupported major versions in createAdcpServer

`createAdcpServer` now returns `VERSION_UNSUPPORTED` (with `supported_versions` in the error details) when a request carries only `adcp_major_version` or only `adcp_version` and the major is outside the server's advertised `major_versions`. Previously only dual-field disagreements were caught; a request with `adcp_major_version: 99` against a 3.0-pinned server would silently reach the handler. This makes the `error-compliance.yaml` `unsupported_major_version` storyboard step deterministic.
