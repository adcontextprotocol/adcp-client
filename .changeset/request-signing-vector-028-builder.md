---
"@adcp/sdk": minor
---

storyboard(request-signing): add adversarial builder for vector 028 — `protocol_methods_required_for` gating

Vector 028 was added to the AdCP spec in [adcp#4326](https://github.com/adcontextprotocol/adcp/pull/4326) (the `request_signing.protocol_methods_*` namespace) and the conformance vector itself in [adcp#4327](https://github.com/adcontextprotocol/adcp/pull/4327). It grades whether a verifier that declares `protocol_methods_required_for: ["tasks/cancel"]` actually rejects unsigned `tasks/cancel` JSON-RPC POSTs with `request_signature_required`. Without an SDK-side adversarial builder, the storyboard runner errored out — `test-agent.adcontextprotocol.org` had to skip the vector via `skipVectors` until this lands.

This PR wires three pieces:

1. **`mcpOperationResolver` -adjacent passthrough mutator** in `src/lib/testing/storyboard/request-signing/builder.ts`. The vector's body is already a JSON-RPC envelope with `method: "tasks/cancel"` — NOT a `tools/call` envelope — so the standard MCP-mode `applyTransport` (which would wrap the body in `tools/call`) is wrong. The new `protocolMethodPassthrough` keeps the body verbatim and targets `baseUrl` directly when set.

2. **`VerifierCapabilityFixture` extended** with `protocol_methods_supported_for` / `protocol_methods_required_for`, and **`capabilityMismatch`** in `grader.ts` extended to gate on the new bucket. An agent that doesn't declare `protocol_methods_required_for: ["tasks/cancel"]` auto-skips vector 028 with `skip_reason: 'capability_profile_mismatch'` — same shape as the existing `required_for` gate.

3. **`vector-loader.ts` parses** the new `protocol_methods_*` fields off vector fixtures so the grader sees them when the cache ships vector 028.

Bumps to `minor` per signing-profile additivity rules. No breaking changes — agents that don't declare `protocol_methods_*` are unaffected; agents that do now get conformance grading.

Cross-namespace match prevention (a signed `tools/call` with `params.name: "tasks/cancel"` MUST NOT satisfy `protocol_methods_required_for`) is a server-side rule enforced at the verifier; the SDK's resolver doesn't construct such a probe.
