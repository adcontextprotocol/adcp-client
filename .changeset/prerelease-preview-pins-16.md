---
'@adcp/sdk': patch
---

Keep stable AdCP pins on stable releases when a server's `adcpVersion` is a prerelease preview registered with `registerExternalSchemaRoot`. A release pin such as `3.3` or `3.4` no longer resolves onto the preview, and a prerelease pin must match an advertised prerelease exactly or get `VERSION_UNSUPPORTED`. MCP tool discovery reports the selected release in each framework tool's `_meta.adcp_version`. Backport of #3707.
