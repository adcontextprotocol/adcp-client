---
"@adcp/sdk": minor
---

Add `mintEphemeralSigningKey()` to `@adcp/sdk/signing/testing`.

Exports `mintEphemeralSigningKey(opts?)` and `EphemeralSigningKey` from
`@adcp/sdk/signing/testing`. The helper generates an ephemeral Ed25519
keypair and returns both halves as fully-shaped `AdcpJsonWebKey` values
(with `kid`, `alg: 'EdDSA'`, `use: 'sig'`, `adcp_use`, and `key_ops` set
correctly) — eliminating the manual Node `JsonWebKey.kty?: string` →
`AdcpJsonWebKey.kty: string` reshape that every dev/test agent had to write
by hand. Defaults to `adcp_use: 'webhook-signing'`; pass
`{ adcp_use: 'request-signing' }` for buyer-to-seller test keys.

Also fixes a dangling `testJwk` reference in `SIGNING-GUIDE.md` §Testing
that left callers without a concrete key-generation example.
