---
'@adcp/sdk': patch
---

Preserve sanitized transport response headers when fetch implementations use a different Undici `Headers` constructor than Node's global fetch.
