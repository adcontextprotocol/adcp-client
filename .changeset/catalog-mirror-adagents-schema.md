---
'@adcp/sdk': patch
---

Allow packaged catalog-era `adagents.json` schemas to validate community mirror catalogs with `authorized_agents: []`, while preserving the stricter non-empty authorization requirement for legacy authorization-only schema bundles.
