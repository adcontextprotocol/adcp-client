---
'@adcp/sdk': minor
---

Add `canonicalAgentOrigin` to the signing client and server entry points and an optional signer-origin argument to JWKS resolver lookups. Brand resolver wrappers forward the context and preserve discovery metadata; capability-bound resolvers reject a mismatched origin before discovery or cached-key access. Existing one-argument lookups retain their behavior and exact agent URL identity.

Existing `canonicalizeOrigin`, `originsEqual`, and `identity.key_origins` comparisons now share the protocol's authority validation: a single trailing DNS root dot is removed, and malformed authorities are rejected instead of repaired by the URL parser.

Reject raw authority backslashes and control characters before URL parsing, and export `CanonicalizeError` with redacted origin-error input so malformed URLs cannot expose credentials in diagnostics.
Signer context also rejects percent-encoded hosts so escaped IDN characters cannot bypass the wire-side host check; producer normalization and existing context-free discovery retain their behavior.

These are foundations for the experimental AdCP 3.3 identity rollout (#3233). They do not enable Web Bot Auth signing or verification, change the wire pin, or confer authority on an origin.
