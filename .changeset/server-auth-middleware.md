---
'@adcp/client': minor
---

Server-side authentication middleware: API key, OAuth JWT, or both.

AdCP agents MUST authenticate incoming requests (per the `security_baseline` storyboard in the universal track). This release adds first-class middleware so sellers can wire auth in ~5 lines.

**New**

- `verifyApiKey({ keys? | verify? })` — static or dynamic API-key authenticator.
- `verifyBearer({ jwksUri, issuer, audience, requiredScopes? })` — OAuth 2.0 JWT validation via `jose` + JWKS. Strict audience enforcement catches the "resource URL mismatch" class of bug. Defaults to an asymmetric-only algorithm allowlist (RS*/ES*/PS*/EdDSA) to block algorithm-confusion attacks, and extracts scopes from both `scope` (string) and `scp` (string | array) claims.
- `anyOf(a, b, ...)` — combinator for accepting API key OR OAuth. Wraps rejections in a sanitized `AuthError` so probing attackers can't learn expected-audience or token-shape details from error responses.
- `respondUnauthorized(req, res, opts)` — RFC 6750-compliant 401/403 with `WWW-Authenticate: Bearer`. `realm` defaults to `"mcp"` (stable) instead of the attacker-controlled `Host` header.
- `AuthError` — exported error class with a sanitized `publicMessage`; the underlying implementation error is preserved as `cause` for server-side logging.
- `ServeOptions.authenticate` — plug any authenticator into `serve()`; no request reaches the MCP transport without passing.
- `ServeOptions.publicUrl` — canonical https:// URL of the MCP endpoint. Required when `protectedResource` is configured. The RFC 9728 `resource` field, the RFC 6750 `resource_metadata` URL on 401 challenges, and the JWT audience all come from this — closes a Host-header phishing vector where a server would otherwise advertise whatever host a caller sent.
- `ServeOptions.protectedResource` — advertise OAuth 2.0 protected-resource metadata (RFC 9728) at `/.well-known/oauth-protected-resource<mountPath>`.
- MCP `AuthInfo` propagation — `serve()` sets `req.auth` from the auth principal (token, clientId, scopes, expiresAt, extra) so MCP tool handlers receive it via `extra.authInfo`. `createAdcpServer` handlers see it on `ctx.authInfo`.

**Skills**

- `build-seller-agent/SKILL.md` gains a full "Protecting your agent" section with API key, OAuth, and both-at-once examples, plus a conformance checklist.
- Short "Protecting your agent" section added to every other `build-*-agent` skill (signals, creative, retail-media, governance, si, brand-rights, generative-seller) so every agent-builder walks past the auth prompt on their way to validation.

**Dependency**

- Promoted `jose` from transitive to direct (it was already in the tree via `@modelcontextprotocol/sdk`).
