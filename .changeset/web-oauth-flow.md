---
'@adcp/sdk': minor
---

feat(auth): add web (server-side) OAuth flow helpers

`@adcp/sdk` already shipped `CLIFlowHandler` for single-process loopback
flows and `NonInteractiveFlowHandler` for refresh-only contexts. There
was no helper for **web servers** where `/oauth/start` and
`/oauth/callback` may hit different processes. Every server consumer
reinvented this layer and several got it wrong — skipping
`/.well-known/oauth-protected-resource` (RFC 9728), guessing the RFC
8707 `resource` indicator locally instead of reading PRM, forgetting to
forward `resource` on token exchange, etc.

This release adds:

- `startWebOAuthFlow(opts)` → `{ authorizationUrl, state, expiresAt }`
- `completeWebOAuthFlow(opts)` → `{ tokens, carry, persisted, agentId, agentUrl }`
- `safeReturnTo(value, opts?)` — open-redirect guard for `carry.return_to`
- `PendingWebFlowStore` interface (consumer-supplied — Postgres, Redis, KV)
- `InMemoryPendingFlowStore` reference impl for tests / single-instance dev
- `DEFAULT_WEB_FLOW_TTL_MS` exported constant
- Error classes: `InvalidOrExpiredFlowError`, `StateMismatchError`,
  `TokenExchangeError` (carries `oauthErrorCode`, redacted `body`),
  `ProtectedResourceMetadataError`, `AgentVanishedDuringFlowError`,
  `ConfidentialClientNotAllowedError`

Discovery, PKCE, URL construction, and token exchange are delegated to
the MCP SDK's `client/auth.js` primitives, so PRM-first resolution,
SEP-835 scope priority, and `resource` forwarding on refresh come for
free.

Security defaults the design enforces:

- PRM `resource` validated against agent origin via
  `checkResourceAllowed` — a poisoned PRM cannot point the audience at
  a third-party origin.
- PRM 404s fall back to local resource derivation; connection / parse /
  5xx errors throw rather than silently downgrade.
- Dynamic client registration that returns `client_secret` is rejected
  unless the caller opts in via `allowConfidentialClient: true`.
- `expectedState` parameter on `completeWebOAuthFlow` binds the flow to
  the caller's browser session (CSRF defense).
- `TokenExchangeError.body` is redacted for `access_token`,
  `refresh_token`, `id_token`, `token` field names.
- `agentStorage.loadAgent` returning undefined after a successful
  exchange throws `AgentVanishedDuringFlowError` rather than silently
  dropping tokens.

Pure addition — no changes to `MCPOAuthProvider`, `CLIFlowHandler`, or
`NonInteractiveFlowHandler`.
