---
---

Harness-only fix for the matrix grader (`scripts/manual-testing/agent-skill-storyboard.ts`) — closes stdin on the spawnSync invocation to prevent a 120s hang against agents that don't emit a webhook (issue #1237). No published-package change; `scripts/manual-testing/` is excluded from `package.json#files`.
