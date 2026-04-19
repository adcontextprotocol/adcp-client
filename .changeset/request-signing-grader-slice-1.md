---
'@adcp/client': minor
---

Request-signing conformance grader — Slice 1: vector loader + adversarial builder.

Internal module at `src/lib/testing/storyboard/request-signing/` that consumes the
RFC 9421 conformance vectors and test keypairs shipped in
`compliance/cache/{version}/test-vectors/request-signing/`. Walks the positive/
and negative/ directories, parses each fixture into typed `PositiveVector` /
`NegativeVector` values (including the `requires_contract` field for stateful
vectors 016/017/020 once upstream adcp#2353 lands in `latest.tgz`), and loads
`keys.json` with the private scalars needed for dynamic re-signing.

Adversarial builder registers one mutation per negative vector (20 total). Each
mutation starts from a freshly-signed baseline via `src/lib/signing/signer.ts`
and applies the single documented mutation — wrong tag, expired window,
missing covered component, content-digest mismatch, malformed Signature-Input,
etc. — so the grader can send real requests to a live verifier rather than
replaying stale `reference_now` signatures. Stateful vectors (016 replay, 017
revoked, 020 rate-abuse) produce a single well-formed request; the storyboard
runner will orchestrate repeat/flood/revoked-keyid behavior around them per
the signed-requests-runner test-kit contract (coming in Slice 2).

Not yet public API — consumed by the in-progress storyboard runner phase.
