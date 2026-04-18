---
'@adcp/client': minor
---

Server-side authentication middleware: API key, OAuth JWT, or both.

AdCP agents MUST authenticate incoming requests (per the `security_baseline` storyboard in the universal track). This release adds first-class middleware so sellers can wire auth in ~5 lines.

**New**

- `verifyApiKey({ keys? | verify? })` — static or dynamic API-key authenticator.
- `verifyBearer({ jwksUri, issuer, audience, requiredScopes? })` — OAuth 2.0 JWT validation via `jose` + JWKS. Strict audience enforcement catches the "resource URL mismatch" class of bug.
- `anyOf(a, b, ...)` — combinator for accepting API key OR OAuth.
- `respondUnauthorized(req, res, opts)` — RFC 6750-compliant 401/403 with `WWW-Authenticate: Bearer`.
- `ServeOptions.authenticate` — plug any authenticator into `serve()`; no request reaches the MCP transport without passing.
- `ServeOptions.protectedResource` — advertise OAuth 2.0 protected-resource metadata (RFC 9728) at `/.well-known/oauth-protected-resource<mountPath>`. The `resource` field is auto-derived from the request host (honoring `X-Forwarded-Proto`) so buyer clients always get the correct RFC 8707 audience.

**Skills**

- `build-seller-agent/SKILL.md` gains a full "Protecting your agent" section with API key, OAuth, and both-at-once examples, plus a conformance checklist.
- Short "Protecting your agent" section added to every other `build-*-agent` skill (signals, creative, retail-media, governance, si, brand-rights, generative-seller) so every agent-builder walks past the auth prompt on their way to validation.

**Dependency**

- Promoted `jose` from transitive to direct (it was already in the tree via `@modelcontextprotocol/sdk`).
