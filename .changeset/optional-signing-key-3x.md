---
'@adcp/sdk': minor
---

Make `TenantConfig.signingKey` optional in 3.x.

The SDK was stricter than the AdCP 3.x spec: `signed-requests` is a preview specialism and CLAUDE.md § Protocol-Wide Requirements explicitly classifies RFC 9421 HTTP Signatures as "optional but recommended." Adopters were forced to fabricate a `TenantSigningKey` (and stand up a published `/.well-known/brand.json`) before they could even register a tenant — the privateJwk wasn't actually wired into a response-signing path on this surface, so the requirement was strictly worse than spec.

When `signingKey` is omitted, `runValidation` skips the JWKS roundtrip entirely and the tenant transitions straight from `pending` to `healthy` with `reason: 'unsigned (no signingKey)'`. Existing adopters who pass `signingKey` keep working unchanged — this is a non-breaking relaxation. AdCP 4.0 will flip `signingKey` back to required.

Two helpers ship alongside for adopters who do want to exercise the signing path locally:

- **`createSelfSignedTenantKey({ keyId? })`** — generates an Ed25519 keypair via `jose` and returns a `TenantSigningKey`. No env gating; generating a keypair isn't dangerous on its own.
- **`createNoopJwksValidator()`** — validator that always returns `{ ok: true }`. Refuses to construct outside `NODE_ENV` ∈ {`'test'`, `'development'`} unless the operator sets `ADCP_NOOP_JWKS_ACK=1`. Mirrors the `idempotency: 'disabled'` allowlist gate — `NODE_ENV` defaults to unset in raw Lambda / custom containers / many K8s deployments, so a `=== 'production'` check would no-op in exactly the environments where a silent skip-validation start is most dangerous. The ack value must be the literal string `'1'`; `'true'` / `'yes'` lookalikes intentionally don't satisfy.

Migration note added to `docs/migration-5.x-to-6.x.md` § Common gotchas. See also the new "TenantRegistry — unsigned tenants (signingKey optional in 3.x)" describe block in `test/server-decisioning-tenant-registry.test.js` for the expected shapes.
