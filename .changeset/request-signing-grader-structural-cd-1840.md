---
'@adcp/sdk': patch
---

request-signing grader: skip vectors whose actual `Signature-Input` shape is structurally incompatible with the agent's `covers_content_digest` policy (#1840)

Previously, `capabilityMismatch` treated vector-side
`covers_content_digest: 'either'` as universally permissive — runnable
against any agent. But a vector whose actual `Signature-Input` does not
cover `content-digest` is rejected by a `'required'` verifier with
`request_signature_components_incomplete` before the vector's intended
error path can fire (inverse for `'forbidden'`). Result: against a
`strict-required` agent, 7 positive vectors (001, 003-004, 009-012) and
5 negative vectors (008, 009, 015, 016, 017) failed with the digest-gate
error instead of running or skipping cleanly. Inverse on
`strict-forbidden`: 3 vectors (positive-002, negative-010, negative-023).

The grader now parses each vector's `Signature-Input` and auto-skips
vectors whose signed components are structurally incompatible with the
agent's declared policy (`covers_content_digest`). Skips surface as
`skip_reason: 'capability_profile_mismatch'` with a diagnostic that names
the structural reason. Applies to both the `agentCapability` and
`agentContentDigestPolicy` options; the latter now covers positive
vectors too (it was previously negative-only).

Vectors whose `Signature-Input` is absent (e.g. negative/001
no-signature-header) or malformed (negative/011, 021) are unaffected —
the verifier short-circuits before the components check, so the shape
check doesn't apply.

## Operator note — coverage trade-off

Five security-critical error families currently ship vectors that sign
**without** `content-digest`:
`request_signature_key_unknown` (neg/008),
`request_signature_key_purpose_invalid` (neg/009),
`request_signature_invalid` (neg/015),
`request_signature_replayed` (neg/016), and
`request_signature_key_revoked` (neg/017). Under this fix, all five are
auto-skipped against agents that declare
`covers_content_digest: 'required'`. The agent's verifier still enforces
those checks at runtime, but the conformance grader no longer probes
them for required-mode profiles. Companion vectors that sign WITH
`content-digest` are needed upstream (tracking at
adcontextprotocol/adcp#4720). Until those land, operators running
required-mode agents should pair this grader with the library-level
`test/request-signing-vectors.test.js` suite for full coverage of those
error paths.

Closes #1840.
