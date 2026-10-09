---
'@adcp/sdk': minor
---

Add `assertPendingWebFlowStoreRoundTrip` from `@adcp/sdk/testing` so custom OAuth stores can detect dropped SDK fields, invalid Date revival, and consume contract violations in CI, with optional adopter-owned agent IDs and carry fixtures. Add `serializePendingWebFlow` and `parsePendingWebFlow` from `@adcp/sdk/auth` to validate JSON strings or decoded JSON payloads while retaining unknown fields and client metadata. Treat flows at their exact expiry deadline as expired in the reference store and callback. Document durable-store integration and restarting legacy flows without issuer bindings.
