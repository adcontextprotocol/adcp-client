---
'@adcp/client': patch
---

Pin `@latest` in all documented `npx @adcp/client` invocations. Unpinned `npx` reuses stale cached versions indefinitely, so users silently run old CLI code and miss bug fixes.
