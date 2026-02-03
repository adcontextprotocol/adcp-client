---
"@adcp/client": patch
---

Add OAuth support to CLI test command

- Add `--oauth` flag to test command for OAuth-protected MCP agents
- Send both `Authorization: Bearer` and `x-adcp-auth` headers in MCP requests (standard OAuth header + legacy AdCP for backwards compatibility)
- Add token expiry check before running tests with saved OAuth tokens
