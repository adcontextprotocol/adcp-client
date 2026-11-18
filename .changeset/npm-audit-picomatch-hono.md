---
'@adcp/sdk': patch
---

Internal dependency security updates; no API or behavior change. The lockfile moves `hono` 4.13.13 to 4.13.19, `@hono/node-server` 1.19.17 to 1.19.19 and `fast-xml-parser` 5.11.2 to 5.12.1 for newly published advisories. The CI security audit now runs `scripts/security-audit.mjs`, which still fails on every high or critical advisory except GHSA-fc5q-39xc-vjpf (picomatch ReDoS), which has no patched release and is reached only through build, lint and release tooling.
