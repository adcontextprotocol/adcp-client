---
"@adcp/client": minor
---

feat(signing): add `signerProvider` option to `createWebhookEmitter` for KMS-backed webhook signing

Adopters who moved request signing to a managed key store (GCP KMS, AWS KMS, Azure Key Vault) via the 5.20.0 `SigningProvider` abstraction previously still had to hold a private JWK in process for webhook signing, defeating the KMS threat model.

`WebhookEmitterOptions` now accepts `signerProvider?: SigningProvider` as a KMS-backed alternative to `signerKey`. Internally, the emitter routes to `signWebhookAsync` when a provider is set and `signWebhook` when a `signerKey` is set. Exactly one must be provided; construction throws `TypeError` if neither or both are given.

All existing emitter semantics (retries, idempotency-key stability, content-digest, redirect policy) are identical between the two paths — only the signing dispatch differs.

**Migration note:** `signerKey` changes from required to optional at the TypeScript type level. Existing callers that pass `signerKey` are unaffected. Callers who forward `WebhookEmitterOptions` and rely on `signerKey` being a required field in their own type signatures should update those types.

**JWKS note:** The JWK published at `jwks_uri` for the key wrapped by a `signerProvider` MUST carry `adcp_use: "webhook-signing"` — receivers validate key purpose against this field.
