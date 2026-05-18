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
6 negative vectors (008, 009, 015, 016, 017, 028) failed with the
digest-gate error instead of running or skipping cleanly. Inverse on
`strict-forbidden`: 3 vectors (positive-002, negative-010, negative-028).

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

Closes #1840.
