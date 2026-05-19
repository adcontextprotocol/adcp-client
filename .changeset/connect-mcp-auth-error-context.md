---
'@adcp/sdk': patch
---

fix(mcp): connectMCP 401 errors now carry auth-scheme context

When `connectMCP` received a non-OAuth 401 from an agent, the rethrown error was a bare `Error POSTing to endpoint (HTTP 401): unauthorized` — no signal of which auth scheme the SDK actually selected, no remediation hint. The #1864 reporter cited this as a 30+ minute debugging cost: the bug landed at the precheck path, the failure mode was a silent 401, and the on-screen evidence pointed away from the actual cause.

Non-OAuth 401s are now wrapped with:

- `error.code === 'MCP_AUTH_REJECTED'` — programmatic dispatch tag.
- `error.scheme` — one of `'bearer' | 'header' | 'oauth' | 'none'`. Tells the caller what the SDK actually put on the wire so they can diff against curl / the gateway's expectations.
- `error.agentUrl` — the URL that rejected the credential.
- `error.cause` — the original transport error, so existing `is401Error` / `err.status` checks downstream still resolve.
- A scheme-specific hint in `error.message` (e.g. `--auth-scheme basic`, `verify the bearer token`, `OAuth provider returned tokens that the agent rejected`).

Credential values are never included in the error message — verified by a regression test that asserts both the raw `Bearer …` and the decoded basic-auth payload are absent from the thrown message string.

OAuth `UnauthorizedError` propagation (the SDK's flow-initiation signal) is unchanged. Closes #1869.
