---
'@adcp/sdk': patch
---

Harden `RegistryClient` transport defaults with timeout, max body size, redirect policy, and injectable fetch options. The default registry host now uses the canonical upstream registry, and callers pinned to the legacy host can either update `baseUrl` or opt into `redirect: 'follow'`.

Regenerate registry OpenAPI types so `CreateAdagentsRequest` accepts catalog metadata fields for community mirror manifests, while preserving backward-compatible `listAgents()`/`listPublishers()` source summaries and the legacy `type: 'si'` list-agent filter. Add CI drift checks that regenerate registry types from the bundled upstream registry OpenAPI before validating generated files.
