---
---

Test-only: `request-signing-grader-mcp` test now binds both reference agent instances to ephemeral ports (PORT=0) instead of hardcoded 3111/3112. Fixes adcp-client#884 — parallel test workers and leftover zombies from earlier runs used to collide on port 3112, surfacing as `MCP agent exited with code 1 before signaling ready` on the rate-abuse subtest. No library change; no release needed.
