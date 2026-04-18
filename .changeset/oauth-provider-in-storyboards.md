---
'@adcp/client': minor
---

Thread OAuth tokens through the storyboard runner + `ADCPMultiAgentClient`.

Storyboards and other `ADCPMultiAgentClient`-based flows were bearer-only — saved OAuth tokens never reached the MCP transport, so OAuth-gated agents always failed with `Authentication required` and couldn't refresh on 401.

**New**

- `NonInteractiveFlowHandler` — an OAuth flow handler that lets the MCP SDK use and refresh saved tokens but refuses to open a browser. Throws an actionable error (`adcp --save-auth <alias> --oauth`) if a full authorization flow is attempted.
- `createNonInteractiveOAuthProvider(agent, { agentHint? })` — factory that builds an `MCPOAuthProvider` backed by the handler above. Use this in storyboard runs, scheduled jobs, and CI.
- `TestOptions.auth` gained a third variant: `{ type: 'oauth', tokens, client? }`. Pass saved OAuth tokens here and the test client builds the refresh-capable OAuth provider automatically.

**CLI**

- `adcp storyboard run <alias>` now picks up `oauth_tokens` from saved aliases and routes them through the OAuth provider, so the SDK can refresh on 401 instead of failing immediately.
- `resolveAgent` returns `oauthTokens` alongside `authToken` for command handlers that want the raw tokens.

**Runtime**

- `ProtocolClient.callTool` detects `agent.oauth_tokens` and routes MCP calls through `callMCPToolWithOAuth` with the non-interactive provider. Plain-bearer agents keep the cached-connection fast path.
- `SingleAgentClient.getAgentInfo()` — the hand-rolled MCP connection now routes through `connectMCP`, so both bearer and OAuth aliases work.

**Compatibility**

No breaking changes. Agents without `oauth_tokens` keep the existing bearer path. Existing `auth_token` and `auth.type: 'bearer'` call sites are unchanged.
