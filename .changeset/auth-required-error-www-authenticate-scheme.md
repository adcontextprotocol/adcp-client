---
'@adcp/sdk': minor
---

feat(errors): `AuthenticationRequiredError.challenge` surfaces `WWW-Authenticate` scheme for non-Bearer 401s (closes #1722)

When an MCP or A2A agent responds with a 401, the SDK now probes for the
`WWW-Authenticate` header and parses the challenge before throwing
`AuthenticationRequiredError`. The parsed challenge rides on the error so
**every** consumer (the CLI, LLM agents wrapping the SDK, dashboards,
programmatic callers) can branch on the auth scheme without re-fetching
or grep-matching error messages.

The error gains:

- `challenge?: AuthChallengeInfo` — `{ scheme, realm?, scope?, error?,
  error_description? }`, lowercased scheme per RFC 9110 §11.6.1.
- `suggestedScheme: string | undefined` getter — the lowercased scheme,
  intended for `error.suggestedScheme === 'basic'` checks.
- Scheme-aware default message: a Basic challenge produces a message
  naming both the SDK shape (`createTestClient({ auth: { type: 'basic',
  username, password } })`) and the CLI shape (`--auth user:pass
  --auth-scheme basic`); a Digest / Negotiate / NTLM challenge produces
  a generic "not natively supported" message with the scheme name; the
  legacy "provide auth_token" fallback is preserved for the no-challenge
  path so existing consumers don't regress.

Why this matters: before PR #1719, `AuthenticationRequiredError` always
said "No OAuth metadata available — provide auth_token in agent config."
That was right when Bearer/OAuth were the only options. After PR #1719
added CLI support for HTTP Basic, the same error surfaced for gateway-
fronted agents (Apigee, Kong, AWS API GW, nginx `auth_basic`) and the
message led adopters down a doomed OAuth path. The CLI's 401 handler
gained a Basic hint in #1719, but only because it parses the error
envelope itself. Every other consumer — including LLM agents using the
SDK directly — still saw the misleading message.

**Constructor signature is back-compat**: the new `challenge` parameter
is positional argument 4 (after `agentUrl`, `oauthMetadata`, `message`)
and defaults to `undefined`. Existing call sites (3 in the SDK; any
adopter code passing 1–3 args) work unchanged. The scheme-aware default
message only fires when a challenge is passed AND its scheme is
non-Bearer — Bearer challenges fall through to the OAuth-metadata branch
exactly as before.

**New helper**: `probeAuthChallenge(agentUrl, options)` exported from
`@adcp/sdk/auth/oauth` — fires a single unauthenticated `tools/list` and
returns the parsed challenge (or `null`). Reuses the same SSRF gate and
timeout policy as `discoverAuthorizationRequirements` so adopter
deployments don't need a second SSRF policy.

**Wired into three throw sites**:

- `SingleAgentClient.discoverMCPEndpoint` (the MCP discovery walk)
- `SingleAgentClient.discoverA2AEndpoint` (the A2A agent-card path)
- `ProtocolClient.callA2ATool` (the A2A in-flight 401 path)

All three now probe for the challenge when `discoverAuthorizationRequirements`
returns null (non-Bearer or PRM-missing 401) and pass it through to the
error envelope.

Tests added:
- `test/lib/authentication-required-error.test.js`: 6 new tests covering
  the Basic message shape, the non-Bearer-non-Basic generic message, the
  Bearer + OAuth-metadata fallthrough, the no-challenge legacy fallback,
  the custom-message override, and the `suggestedScheme` getter.
- `test/lib/probe-auth-challenge.test.js`: 5 tests against local 401
  servers covering Basic, Bearer, 200 OK, 401 without
  `WWW-Authenticate`, and unreachable host.

44/44 cross-suite regression passing (`cli-auth-scheme.test.js`,
`cli-oauth-flag.test.js`, `authentication-required-error.test.js`).

Source: protocol-expert review follow-up from PR #1719.
