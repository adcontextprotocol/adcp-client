---
'@adcp/sdk': major
'@adcp/eslint-plugin': patch
---

Move AdCP 3.2's A2A transport to the official A2A 1.0 SDK and normative profile extension, while retaining wire compatibility with 0.3 agents through the 1.0 SDK's compatibility layer. This replaces the `@a2a-js/sdk` 0.3 peer range with 1.x; adopters must upgrade that peer dependency. Refresh core runtime and development dependencies to current Node 20-compatible releases, including the latest MCP 1.x SDK, fast-check 4, and Redis 6 support.
