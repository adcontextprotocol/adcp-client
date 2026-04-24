---
"@adcp/client": patch
---

CI: `ci:docs-check` now ignores the `> @adcp/client v<version>` / `> Library: @adcp/client v<version>` header when diffing generated agent docs, matching how the `> Generated at:` header is already ignored. Closes #881 — previously every version bump forced a doc regeneration commit even when no real content changed.
