---
'@adcp/client': minor
---

Zero-config OAuth: auto-discovery on 401 + actionable `NeedsAuthorizationError`.

Closes the remaining item from #563. Calling an OAuth-gated MCP agent without saved credentials used to bubble up a generic 401 or `UnauthorizedError`. Now the library automatically walks RFC 9728 protected-resource metadata + RFC 8414 authorization-server metadata from the server's `WWW-Authenticate` challenge and throws a structured `NeedsAuthorizationError` with everything a caller needs to recover — no re-probing required.

**New exports**

- `NeedsAuthorizationError` — thrown automatically by `ProtocolClient.callTool` / `ADCPMultiAgentClient` when an MCP agent returns a 401 Bearer challenge and no saved tokens can satisfy it. Carries `agentUrl`, `resource`, `resourceMetadataUrl`, `authorizationServer`, `authorizationEndpoint`, `tokenEndpoint`, `registrationEndpoint`, `scopesSupported`, and the parsed challenge.
- `discoverAuthorizationRequirements(agentUrl, options?)` — programmatic access to the same walk. Returns `null` if the agent responds 200 without auth or 401 without a Bearer challenge.
- `createFileOAuthStorage({ configPath, agentKey? })` — file-backed `OAuthConfigStorage` against the `adcp` CLI's agents.json format. Atomic writes via write-then-rename; preserves non-OAuth fields on save. `agentKey` override keys all writes under a fixed alias regardless of `agent.id` (CLI pattern).
- `bindAgentStorage(agent, storage)` / `getAgentStorage(agent)` — per-agent `WeakMap` binding that threads an `OAuthConfigStorage` through `ProtocolClient.callTool` without changing its signature.

**Behavior changes**

- `ProtocolClient.callTool` now catches 401-shaped errors from both the OAuth-token path and the plain-bearer path and, if the agent returns a Bearer challenge, throws `NeedsAuthorizationError` instead of the generic error. Non-401 errors propagate unchanged.
- When `agent.oauth_tokens` is present and storage has been bound via `bindAgentStorage`, the non-interactive OAuth provider now receives the storage so refreshed tokens persist to disk.
- `adcp <alias> <tool>` automatically binds file-backed storage for saved OAuth aliases and prints an actionable prompt when authorization is required.

**Not breaking**

Existing callers that construct their own OAuth providers keep working. Existing bearer-only agents keep working. The only visible change on the error path is a more informative error class where `UnauthorizedError` would have propagated before.
