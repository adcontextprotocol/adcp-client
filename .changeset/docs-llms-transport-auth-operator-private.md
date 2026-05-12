---
'@adcp/sdk': patch
---

docs(llms): add Transport auth section clarifying operator-private posture (closes #1724)

Add a "Transport auth" section to `docs/llms.txt` (immediately after Quick
Start) clarifying that AdCP is auth-scheme-agnostic at the transport
layer. The protocol carries JSON-RPC over HTTP; how the outer envelope
is gated is an operator-private deployment choice — bearer, OAuth, mTLS,
AWS SigV4 at the edge, IP allow-lists, or RFC 7617 HTTP Basic for
gateway-fronted agents (Apigee, Kong, AWS API Gateway, nginx
auth_basic). `get_adcp_capabilities` does NOT advertise accepted auth
schemes; coupling the protocol to infrastructure permutations would
invite "auth_methods" PRs every time someone adds a new gateway shape.

Calls out the discovery vector explicitly: `WWW-Authenticate` (RFC 9110
§11.6.1) and PRM (RFC 9728), already consumed by
`src/lib/auth/oauth/diagnose.ts`. Basic-fronted agents emit
`WWW-Authenticate: Basic realm="…"` on a 401; consumers should branch on
the challenge scheme rather than retrying Bearer indefinitely.

Closes the documentation gap surfaced by the protocol-expert review of
PR #1719 (`--auth-scheme bearer|basic` for the CLI). Pre-empts the
"should we add `auth_methods` to capabilities?" PR that someone will
eventually open.

Doc-only change. No code or behavior impact.
