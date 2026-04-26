---
"@adcp/client": minor
---

Add `pemToAdcpJwk` helper and improve GCP KMS signing example with lifecycle patterns and tripwire support

- `pemToAdcpJwk(pem, { kid, algorithm, adcp_use })` — new export from `@adcp/client/signing` that converts a public-key PEM to an AdCP JWK with correct JOSE `alg`, `adcp_use`, and `key_ops` fields. Protects against common footguns: using the AdCP wire alg name instead of the JOSE alg name, omitting `adcp_use`, or publishing `key_ops: ["sign"]` instead of `["verify"]`.
- `createGcpKmsSigningProviderLazy` — lazy-init variant of the GCP KMS example adapter. Uses a rejection-clearing in-flight promise to prevent thundering herd on concurrent first calls and avoids permanently caching transient init failures.
- `GcpKmsSigningProviderOptions.expectedPublicKeyPem` — optional tripwire: commits the expected SPKI bytes alongside the code and asserts at provider init that KMS returns the same public key, catching silent out-of-band rotations before they cause widespread verifier rejections.
- `SigningProvider.fingerprint` JSDoc: clarifies that the field may embed infra identifiers (e.g., GCP project ID) and recommends using `kid` for observability logs instead.
