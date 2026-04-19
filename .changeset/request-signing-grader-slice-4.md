---
'@adcp/client': minor
---

Request-signing grader — Slice 4: signed test agent + framework wiring for
`request_signing` / `specialisms` capability advertisement.

**Framework — `AdcpCapabilitiesConfig`**

`createAdcpServer({ capabilities: { … } })` now accepts two fields previously
unreachable from the framework:

- `request_signing` — the RFC 9421 verifier capability block
  (`supported`, `covers_content_digest`, `required_for`, `warn_for`,
  `supported_for`). Emitted verbatim in `get_adcp_capabilities.request_signing`.
- `specialisms` — specialism claim list (e.g. `['signed-requests']`).
  Each entry maps to a compliance bundle under
  `/compliance/{version}/specialisms/{id}/`; the AAO runner resolves and
  executes the matching storyboards.

Without these, agents wanting to declare signed-requests support had to
fork the capability-assembly path. Now it's one-liner capability config.

**Framework — `serve.preTransport` hook**

`serve(createAgent, { preTransport })` accepts a pre-MCP-transport middleware
that runs after path-matching and before the MCP transport is connected. The
request body is buffered into `req.rawBody` before the hook fires so
signature verifiers can hash it. The transport receives the parsed JSON body
via `transport.handleRequest(req, res, parsedBody)` so the already-consumed
stream doesn't race.

Intended for transport-layer concerns — RFC 9421 signature verification
being the primary use case. Returning `true` signals the middleware handled
the response (e.g. a 401 with `WWW-Authenticate`); returning `false`
continues into MCP dispatch.

**Test agent — `test-agents/seller-agent-signed.ts`**

Minimal HTTP server pre-configured per the `signed-requests-runner`
test-kit contract:

- JWKS contains `test-ed25519-2026`, `test-es256-2026`, `test-gov-2026`,
  `test-revoked-2026` (from `compliance/cache/latest/test-vectors/
  request-signing/keys.json`).
- Revocation list pre-includes `test-revoked-2026`.
- Per-keyid replay cap = 100 (matches contract's
  `grading_target_per_keyid_cap_requests`).
- `required_for: ['create_media_buy']` — vector 001 surfaces
  `request_signature_required`.

Exposes `/get_adcp_capabilities` (unsigned, declares `supported: true` +
`specialisms: ['signed-requests']`) and accepts signed requests on any
other path, routing the operation name from the last path segment.

Run `PORT=3100 node test-agents/dist/seller-agent-signed.js` and grade it
with `node bin/adcp.js grade request-signing http://127.0.0.1:3100
--allow-http --skip-rate-abuse`. Current results against this agent:
**25/25 graded vectors pass, 3 skipped** (capability-profile + rate-abuse
opt-out). Validates the full grader → signer → verifier path end-to-end.

Note: the test agent is not an MCP agent — vectors target raw-HTTP AdCP
paths, and the RFC 9421 verifier is a transport-layer concern. An
MCP-aware grader (JSON-RPC envelope wrapping + single-endpoint routing)
is a separate scope; follow-up ticket to be filed.
