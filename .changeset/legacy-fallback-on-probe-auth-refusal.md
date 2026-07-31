---
'@adcp/sdk': patch
---

Fall back to the legacy `initialize` handshake when a server refuses the
`server/discover` version-negotiation probe with 401/403 and the probe already
carried a static credential.

`mode: 'auto'` documents that "definitive legacy signals (and anything
unrecognized) fall back to the plain legacy `initialize` handshake", but the MCP
client's classifier treats 401/403 as the sole terminal probe outcome. A server
that rejects the modern discovery method while accepting the very same
credential on `initialize` and `tools/list` was therefore unreachable, and the
caller was told to supply an `auth_token` it was already sending.

The fallback is deliberately narrow. With no credential a probe 401 is the
server's own challenge and still reaches the caller, so the
`WWW-Authenticate`/RFC 9728 walk is unaffected; with an OAuth provider a 401
still propagates as the provider's cue to refresh. Only a static
token/header credential refused on the probe alone triggers the retry, and if
that credential really is bad the legacy connect fails on its own and surfaces
the server's 401.
