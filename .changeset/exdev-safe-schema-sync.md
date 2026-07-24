---
'@adcp/sdk': patch
---

Fix `sync-schemas` crashes with `EXDEV` in Docker overlayfs builds by falling back to copy-and-delete for directory moves, and preserve the original error in fallback diagnostics.
