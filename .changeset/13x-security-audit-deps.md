---
'@adcp/sdk': patch
---

Update dependencies to clear the security audit on the 13.x line. The exact runtime pins `@modelcontextprotocol/client` and `@modelcontextprotocol/server` move from 2.0.0 to 2.3.1, a non-major bump to the same pins `main` uses. It patches GHSA-6qxp-vccf-f47h, GHSA-jm63-cq47-j5jp, GHSA-46jr-4wx8-v453, GHSA-rvq5-wwqv-78pq and GHSA-6prh-2h8m-c8cw. The lockfile picks up patched in-range releases of `undici`, `zod`, `body-parser`, `proxy-addr`, `markdown-it`, `hono`, `fast-uri` and `ip-address`. The development copy of the legacy `@modelcontextprotocol/sdk` moves to ^1.32.2; its peer range is unchanged. `npm audit` now reports 0 vulnerabilities. No public API changes.
