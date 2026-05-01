---
'@adcp/sdk': minor
---

Make `TenantConfig.signingKey` optional + auto-wire it into webhook signing.

The SDK was stricter than the AdCP 3.x spec: `signed-requests` is a preview specialism and CLAUDE.md § Protocol-Wide Requirements explicitly classifies RFC 9421 HTTP Signatures as "optional but recommended." Adopters were forced to fabricate a `TenantSigningKey` (and stand up a published `/.well-known/brand.json`) before they could even register a tenant — and even then, the field's privateJwk wasn't auto-plumbed into the actual webhook signing pipeline, so adopters had to wire the same key TWICE (once on `TenantConfig.signingKey` for JWKS validation, once on `serverOptions.webhooks.signerKey` for outbound signatures).

This change does two things:

**1. `signingKey` is now optional.** When omitted, `runValidation` skips the JWKS roundtrip entirely and the tenant transitions straight from `pending` to `healthy` with `reason: 'unsigned (no signingKey)'`. AdCP 3.x treats request signing as optional, so adopters spiking the SDK before standing up KMS or publishing brand.json can ship without signing material. AdCP 4.0 will flip this back to required.

**2. When `signingKey` IS set, the registry auto-wires it into outbound webhook signing.** The privateJwk now flows into `serverOptions.webhooks.signerKey` automatically. Set the key once on `TenantConfig`, get JWKS validation + signed webhooks. Strict on `adcp_use`: the JWK MUST carry `adcp_use: "webhook-signing"` per AdCP key-purpose discriminator (adcp#2423). Adopters who wire their own webhook signer on `serverOptions.webhooks` (KMS-backed, distinct keys per tenant, etc.) pass through unaffected — explicit config wins and auto-wiring is skipped.

Supported JWK shapes for the auto-wire path: Ed25519 (`kty=OKP, crv=Ed25519`) and ECDSA P-256 (`kty=EC, crv=P-256`). RSA / EC P-384 throw with a remediation hint at register time.

Two helpers ship alongside:

- **`createSelfSignedTenantKey({ keyId? })`** — generates an Ed25519 keypair via `jose` and returns a `TenantSigningKey` already tagged with `adcp_use: "webhook-signing"` so it passes the auto-wire assertion out of the box. No env gating; generating a keypair isn't dangerous.
- **`createNoopJwksValidator()`** — validator that always returns `{ ok: true }`. Refuses to construct outside `NODE_ENV` ∈ {`'test'`, `'development'`} unless the operator sets `ADCP_NOOP_JWKS_ACK=1`. Mirrors the `idempotency: 'disabled'` allowlist gate — `NODE_ENV` defaults to unset in raw Lambda / custom containers / many K8s deployments, so a `=== 'production'` check would no-op in exactly the environments where a silent skip-validation start is most dangerous. The ack value must be the literal string `'1'`; `'true'` / `'yes'` lookalikes intentionally don't satisfy.

Migration: existing adopters who pass an Ed25519 / EC P-256 `signingKey` need to add `adcp_use: "webhook-signing"` to both `publicJwk` and `privateJwk`. Adopters with RSA keys must rotate to Ed25519 / EC P-256 (RSA isn't in the AdCP signing-algorithm set) OR wire their webhook signer explicitly on `serverOptions.webhooks` to bypass the auto-wire.

Migration note added to `docs/migration-5.x-to-6.x.md` § Common gotchas. New describe blocks in `test/server-decisioning-tenant-registry.test.js`: "unsigned tenants" (3.x optional path), "createSelfSignedTenantKey", "createNoopJwksValidator — NODE_ENV allowlist", "webhook-signing auto-wire" (auto-wire happy path + adcp_use enforcement + explicit-override bypass).
