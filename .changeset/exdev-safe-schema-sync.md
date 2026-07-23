---
"@adcp/sdk": patch
---

Fixed `sync-schemas` crashing with EXDEV inside docker builds. Directory renames now fall back to copy+delete when `renameSync` fails on overlayfs lower-layer directories. Also corrects the misleading "was not reachable" fallback warning to include the original error.
