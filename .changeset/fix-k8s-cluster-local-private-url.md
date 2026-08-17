---
"@adcp/sdk": patch
---

`isLikelyPrivateUrl` now recognizes Kubernetes service DNS names (`.cluster.local` suffix) as private. Callers connecting to a managed internal agent whose URI ends in `.svc.cluster.local` (with or without the trailing FQDN dot) are granted `allowPrivateIp` automatically, without needing `ADCP_ALLOW_PRIVATE_AGENT_URL=1`.
