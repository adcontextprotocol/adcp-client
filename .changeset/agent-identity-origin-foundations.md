---
'@adcp/sdk': minor
---

Add `canonicalAgentOrigin` to the signing client and server entry points and an optional signer-origin argument to JWKS resolver lookups. Brand resolver wrappers forward the context and preserve discovery metadata; capability-bound resolvers reject a mismatched origin before discovery or cached-key access. Existing one-argument lookups retain their behavior and exact agent URL identity.

Existing `canonicalizeOrigin`, `originsEqual`, and `identity.key_origins` comparisons now share the protocol's authority validation: a single trailing DNS root dot is removed, and malformed authorities are rejected instead of repaired by the URL parser.

These are foundations for the experimental AdCP 3.3 identity rollout (#3233). They do not enable Web Bot Auth signing or verification, change the wire pin, or confer authority on an origin.
