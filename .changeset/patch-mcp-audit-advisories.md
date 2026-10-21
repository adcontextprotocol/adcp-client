---
'@adcp/sdk': patch
---

Patch MCP SDK dependencies for newly published advisories: `@modelcontextprotocol/server` and `@modelcontextprotocol/client` move from 2.2.0 to 2.3.1. The dev-only transitives `launch-editor` (via `@changesets/cli`) and `markdown-it` (via `typedoc`) are pinned to patched releases through `overrides`, and `hono` is refreshed to 4.13.13 in the lockfile. `npm audit --audit-level=high` is clean again.
