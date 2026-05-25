---
"@adcp/sdk": patch
---

Fix false-positive collision warnings in per-tool type extractor when the same type is emitted by both tools.generated and core.generated with different JSDoc but identical structure.
