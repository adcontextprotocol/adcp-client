---
"@adcp/client": minor
---

Add `SigningProvider` abstraction for external key management (KMS/HSM/Vault)

Operators who want to keep private keys in AWS KMS / GCP KMS / Azure Key Vault /
Vault Transit can now implement the new `SigningProvider` interface and pass it
directly to the SDK — the private scalar never needs to be loaded into process memory.

New exports from `@adcp/client/signing/client`:
- `SigningProvider` interface — async `sign(Uint8Array): Promise<Uint8Array>` contract
- `AdcpSignAlg` type — shared `'ed25519' | 'ecdsa-p256-sha256'` union (replaces ad-hoc duplicates)
- `signRequestAsync(req, provider, opts)` — async variant of `signRequest`
- `signWebhookAsync(req, provider, opts)` — async variant of `signWebhook`
- `createSigningFetch` now accepts `SignerKey | SigningProvider` via overload
- `buildAgentSigningContextFromConfig(signing, agentUri, authToken?, opts?)` — builds a signing context directly from `AnyAgentSigningConfig`
- `isProviderConfig(signing)` — type guard for the provider arm

New exports from `@adcp/client/signing/testing`:
- `InMemorySigningProvider` — test double backed by a raw JWK; byte-identical to the sync path

New types in `@adcp/client/types`:
- `AgentProviderSigningConfig` — KMS-backed sibling of `AgentRequestSigningConfig`
- `AnyAgentSigningConfig = AgentRequestSigningConfig | AgentProviderSigningConfig`

`AgentConfig.request_signing` now accepts `AnyAgentSigningConfig`.

All existing `AgentRequestSigningConfig`, `signRequest`, `signWebhook`, and
`createSigningFetch(upstream, key)` call sites are unbroken.

See `examples/gcp-kms-signing-provider.ts` for a GCP Cloud KMS adapter.
