---
"@adcp/client": patch
---

Address SigningProvider first-adopter friction (#1022 from #3283 KMS integration)

Six small additions surfaced by the first KMS-backed SigningProvider deployment. All additive — no breaking changes, no wire-format changes.

- **`pemToAdcpJwk(pem, { kid, algorithm, adcp_use })`** — new export from `@adcp/client/signing` (via `src/lib/signing/jwks-helpers.ts`). Converts a public-key PEM to an AdCP JWK with the fields that matter for publication at `/.well-known/jwks.json`: `alg` uses the JOSE name (`"EdDSA"` / `"ES256"`), not the AdCP wire identifier — confusing the two is the most common footgun and silently produces `request_signature_key_purpose_invalid` at step 8. `adcp_use` is required by AdCP verifiers at step 8 (hard gate). `key_ops: ["verify"]` because the published JWK is the public half. Throws `TypeError` on private-key PEM input (credential leak guard) and on unsupported algorithm values.
- **`createGcpKmsSigningProviderLazy`** (example) — synchronous variant of the eager factory. Defers `getPublicKey` to the first `sign()` call. Uses rejection-clearing in-flight promise dedup to prevent thundering herd on concurrent first calls and avoid permanently caching transient init failures.
- **`expectedPublicKeyPem` tripwire** (example) — optional field on `GcpKmsSigningProviderOptions` (both factories). Compares SPKI bytes at init time; throws explicitly when KMS returns null PEM with the tripwire set (no silent bypass). Catches out-of-band key rotations before they cause widespread verifier `request_signature_key_unknown` failures.
- **`SigningProvider.fingerprint` JSDoc** — clarifies that the field may embed infra identifiers (e.g., GCP project ID via the version resource name) and recommends `kid` for shared observability pipelines.
- **Multi-purpose key publication guidance** — example JSDoc now points at the JWKS-shape guidance (two JWK entries with different `kid` values and matching key bytes, tagged `adcp_use: 'request-signing'` / `'webhook-signing'`). Cryptographically safe via RFC 9421's `tag` profile isolation.
- **`jwks_uri` informational override** — new optional field on `AgentRequestSigningOperationOverrides` (visible on both inline and provider config shapes). Mirrors what brand.json publishes for split-domain setups where the JWKS lives off the conventional `${agent_url}/.well-known/jwks.json` path. Carried for self-describing config + audit logs; the SDK doesn't consume it for signing (verifiers walk brand.json from `agent_url`).
