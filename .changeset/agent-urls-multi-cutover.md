---
'@adcp/sdk': minor
---

feat(server): `TenantConfig.agentUrls: string[]` — accept traffic on multiple URLs simultaneously for DNS-cutover and vanity-domain deployments. Single-URL `agentUrl` keeps working unchanged; `agentUrls` is the new multi-URL form (first element is canonical for JWKS validation and status reporting; the rest are aliases). Setting both is a register error.

Closes #1087.
