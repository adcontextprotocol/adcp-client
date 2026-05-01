---
'@adcp/sdk': patch
---

Cross-link the merged spec decision (adcp#3742, "synchronous response bodies are not signed — by design") in `TenantConfig.signingKey`'s JSDoc, and add a "Self-signed dev path" recipe to `docs/guides/SIGNING-GUIDE.md`.

The field's prior doc described the signing scope as "RFC 9421 response signing" — that wording predated the spec decision and didn't match what the SDK actually does. Updated to reflect: scope is webhook-signing only; the synchronous tools/call reply is not signed at the body level by deliberate design (TLS for sync, signed webhooks for async); adopters needing attestable artifacts for synchronous flows use the request-the-webhook pattern. Doc points at `docs/building/understanding/security-model.mdx` § "What gets signed — and what doesn't" for the canonical reasoning.

The signing guide now carries the worked recipe for the multi-tenant self-signed dev loop: `createTenantRegistry` + `createSelfSignedTenantKey()` + `createNoopJwksValidator()` (gated to `NODE_ENV` ∈ {test, development} unless `ADCP_NOOP_JWKS_ACK=1`). Production promotion path covered (publish JWK to brand.json, swap in-memory key for KMS-backed `SigningProvider`). Plus the omit-key path for adopters who aren't ready to sign yet.

No behavior change.
