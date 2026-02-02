---
"@adcp/client": minor
---

Add OAuth support for MCP servers

- New OAuth module in `src/lib/auth/oauth/` with pluggable flow handlers
- `MCPOAuthProvider` implements MCP SDK's `OAuthClientProvider` interface
- `CLIFlowHandler` for browser-based OAuth with local callback server
- OAuth tokens stored directly in AgentConfig alongside static auth tokens
- CLI flags: `--oauth` for OAuth auth, `--clear-oauth` to clear tokens
- `--save-auth <alias> <url> --oauth` to save agents with OAuth
- Auto-detection of OAuth requirement when MCP servers return UnauthorizedError
- Helper functions: `hasValidOAuthTokens`, `clearOAuthTokens`, `getEffectiveAuthToken`
- Security fix: use spawn instead of exec for browser open to prevent command injection
