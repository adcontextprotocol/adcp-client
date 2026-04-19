---
'@adcp/client': minor
---

OAuth DX: `adcp diagnose-auth` + introspection utilities.

Debugging an OAuth misconfiguration against an MCP agent previously took hours of manual wire-level probing. These utilities collapse that into a single command with ranked hypotheses — and expose the underlying primitives so consumers can introspect the handshake themselves.

**New CLI**

- `adcp diagnose-auth <alias|url>` — end-to-end diagnostic that probes RFC 9728 protected-resource metadata, RFC 8414 authorization-server metadata, decodes the saved access token, optionally attempts a refresh with a `resource` indicator (RFC 8707), and calls `tools/list` + a tool on the agent. Emits ranked hypotheses (H1 resource-URL mismatch, H2 refresh grant ignores `resource`, H4 401 without `WWW-Authenticate`, H5 token-audience mismatch, H6 agent accepts token but doesn't validate audience).
- `--json` for structured output, `--skip-refresh` / `--skip-tool-call` for read-only runs, `--tool NAME` to override the probe tool.

**New library exports (from `@adcp/client` and `@adcp/client/auth`)**

- `runAuthDiagnosis(agent, options)` — programmatic access to the diagnosis runner; returns `AuthDiagnosisReport` with per-step HTTP captures and ranked hypotheses.
- `parseWWWAuthenticate(header)` — parse an RFC 9110 / RFC 6750 challenge and surface `realm`, `error`, `error_description`, `scope`, and the RFC 9728 `resource_metadata` URL.
- `decodeAccessTokenClaims(token)` — unsigned JWT claim decoder for diagnostics. Returns `{ header, claims, signature }` or `null` for opaque tokens. Does not verify the signature.
- `validateTokenAudience(token, expectedResource)` — checks whether the `aud` claim matches an expected resource URL with URL normalization. Returns `{ ok, reason, actualAudience }`.
- `InvalidTokenError`, `InsufficientScopeError` — re-exported from `@modelcontextprotocol/sdk/server/auth/errors.js` so consumers can discriminate 401 causes with `instanceof` rather than string-matching error messages.

**Bugfix**

- `ssrfSafeFetch` now handles undici's `lookup` callback correctly when it's called with `{ all: true }` (undici's default on Node 22+ for HTTPS targets). The previous scalar-only callback path caused "Invalid IP address: undefined" errors on every external HTTPS probe.
