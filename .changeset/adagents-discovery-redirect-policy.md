---
'@adcp/sdk': patch
---

Align adagents.json discovery HTTP redirect handling with the shared policy: follow same-registrable-domain redirects on the initial .well-known fetch, and refuse redirects from authoritative_location targets.
