---
---

Test-only change — locks `@deprecated` JSDoc emission from `json-schema-to-typescript` so the next time AdCP adds a `deprecated: true` property (e.g., adcp#4904 on `CreateMediaBuySuccess.status` / `UpdateMediaBuySuccess.status`) the codegen regression surfaces before the type ships. No library/CLI behavior change; no release needed. Fixes #1915.
