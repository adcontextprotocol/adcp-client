---
'@adcp/client': minor
---

Add OAuth 2.0 client credentials (RFC 6749 §4.4) support to the library and CLI for machine-to-machine compliance testing. Addresses [adcontextprotocol/adcp#2677](https://github.com/adcontextprotocol/adcp/issues/2677).

**The problem.** Sales agents that authenticate via OAuth client credentials couldn't be tested with `@adcp/client` without a user manually exchanging credentials for a token and pasting the bearer in. Tokens expire; CI pipelines need a way to point the library at a token endpoint and let it handle refresh.

**Library-level auto-refresh.** `ProtocolClient.callTool` now re-exchanges the secret for a fresh access token before every call when `AgentConfig.oauth_client_credentials` is set (cached while valid — single POST on miss, no-op on warm cache). Concurrent callers for the same agent coalesce onto one refresh POST. On a mid-call 401 the client force-refreshes once and retries — covers the case where the AS rotates something out of band. Refreshed tokens persist via any attached `OAuthConfigStorage`.

**New `auth` type on `TestOptions`.** `createTestClient` / `ADCPMultiAgentClient` accept `{ type: 'oauth_client_credentials', credentials, tokens? }`. Storyboard runs, `adcp fuzz`, `adcp grade`, and any programmatic consumer get auto-refresh for free.

**CLI flags on `--save-auth`:**
```bash
adcp --save-auth my-agent https://agent.example.com \
  --oauth-token-url https://auth.example.com/token \
  --client-id abc123 --client-secret xyz789 \
  --scope adcp
```

Full subcommand help: `adcp --save-auth --help`.

**Secret storage.** Literal secrets land in `~/.adcp/config.json` (mode `0600`, directory `0700`). For CI, `--client-id-env` / `--client-secret-env` store a `$ENV:VAR_NAME` reference resolved at token-exchange time — nothing sensitive on disk:
```bash
adcp --save-auth my-agent https://agent.example.com \
  --oauth-token-url https://auth.example.com/token \
  --client-id-env CLIENT_ID --client-secret-env CLIENT_SECRET
```
Empty env-var values are rejected loudly (catches the common `.env` typo `CLIENT_SECRET=`).

**Audience binding (RFC 8707).** `AgentOAuthClientCredentials` accepts `resource?: string | string[]` (emitted as repeated `resource` form fields, RFC 8707) and `audience?: string` (the Auth0/Okta/Azure AD vendor parameter). Required for agents behind audience-validating proxies.

**Security hardening.**
- `token_endpoint` must be `https://` — `http://` is rejected with a typed `malformed` error before any request hits the wire. `http://localhost` and `http://127.0.0.1` are allowed for local dev.
- Userinfo URLs (`https://user:pass@auth.example.com/token`) are rejected — credentials belong in `client_id` / `client_secret`, not the URL, and leaking them via error messages and log aggregators is easy.
- SSRF guard: private-IP / loopback token endpoints are rejected unless the caller opts in with `allowPrivateIp: true`. The CLI opts in (operator-driven); the library trusts whatever the agent URL already trusts. Hosted consumers accepting untrusted configs get the guard for free.
- Basic auth encoding follows RFC 6749 §2.3.1 (form-urlencoded: space → `+`, `!'()*` percent-encoded) — not `encodeURIComponent`. Fixes interop with secrets containing those characters.
- `error_description` from the authorization server is control-character-stripped and truncated before being surfaced — defends against ANSI / CRLF injection from a hostile AS.

**`is401Error` now recognizes MCP SDK error shape** (`err.code === 401`). The MCP `StreamableHTTPClientTransport` throws errors with HTTP status on `.code`; the retry path for CC and auth-code flows was silently skipping them. Caught by the new integration test.

**CLI flags (all on `--save-auth`):**
- `--oauth-token-url <url>` — authorization server token endpoint (required)
- `--client-id <value>` / `--client-id-env <VAR>` — literal or env reference
- `--client-secret <value>` / `--client-secret-env <VAR>` — literal or env reference
- `--scope <scope>` — optional OAuth scope
- `--oauth-auth-method basic|body` — credential placement (default: `basic` per RFC 6749 §2.3.1)

**Programmatic API** under `@adcp/client/auth`:
- `exchangeClientCredentials(credentials, options?)` — one-shot token exchange
- `ensureClientCredentialsTokens(agent, options?)` — refresh-if-stale helper that updates `agent.oauth_tokens` in place (coalesces concurrent calls) and optionally persists via `OAuthConfigStorage`
- `ClientCredentialsExchangeError` — typed error with `kind: 'oauth' | 'malformed' | 'network'`, `oauthError`, `oauthErrorDescription`, `httpStatus`
- `MissingEnvSecretError` — typed error with `reason: 'unset' | 'empty'`
- `resolveSecret`, `isEnvSecretReference`, `toEnvSecretReference` — secret-resolution utilities
- `AgentOAuthClientCredentials` — type for the new `AgentConfig.oauth_client_credentials` field

The authorization-code flow (`--oauth`) and existing `auth_token` paths are unchanged. `createFileOAuthStorage` persists `oauth_client_credentials` alongside `oauth_tokens` so CLI and programmatic consumers share the same on-disk shape.
