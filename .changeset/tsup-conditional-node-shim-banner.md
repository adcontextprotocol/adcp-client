---
"@adcp/sdk": patch
---

Fix: the ESM build no longer injects the `node:url`/`node:path`/`node:module` shim banner into every `.mjs` file. Only the (11) files that actually reference `__dirname`, `__filename`, or `require` in their body get it now; pure-data and pure-logic modules — including `enums.generated.mjs`, `inline-enums.generated.mjs`, and everything reachable from the zod-free `./enums` entry point — no longer carry dead Node-only imports that broke strict browser bundlers (Vite, `esbuild --platform=browser`).
