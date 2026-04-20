---
'@adcp/client': patch
---

Emit a one-time `console.warn` when a client receives v2 capabilities — v2 is unsupported as of AdCP 3.0 GA (2026-04-20, adcp#2220). Suppress with `ADCP_ALLOW_V2=1` env var or `adcp --allow-v2` on the CLI. Functional behavior unchanged — v2 paths still execute, just loud about it.
