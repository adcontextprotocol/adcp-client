---
"@adcp/client": minor
---

feat(signing): add SigningProvider abstraction for KMS-backed RFC 9421 signing

Adds a pluggable `SigningProvider` interface so private keys can live in a
managed key store (GCP KMS, AWS KMS, Azure Key Vault, HashiCorp Vault Transit)
instead of process memory. The async `sign(payload)` boundary matches RFC
9421 §3.1 — the SDK produces the canonical signature base, the provider
returns wire-format signature bytes.

New surface:
- `SigningProvider` interface and `AdcpSignAlg` type (exported from
  `@adcp/client/signing`).
- `signRequestAsync` / `signWebhookAsync` — async variants that accept a
  provider; sync `signRequest` / `signWebhook` are unchanged.
- `createSigningFetchAsync(upstream, provider, options)` — async-signing
  fetch wrapper, paired with the existing sync `createSigningFetch`. Two
  symbols rather than one overload so the latency-cost distinction is
  visible at integration time.
- `derEcdsaToP1363(der, componentLen)` — DER → IEEE P1363 ECDSA signature
  converter for KMS adapters whose `sign` API returns DER (GCP, AWS, Azure).
- `SigningProviderAlgorithmMismatchError` — typed error adapters throw when
  the declared algorithm doesn't match the underlying key, so misconfigurations
  fail fast at adapter construction rather than producing signatures verifiers
  reject downstream.
- `@adcp/client/signing/testing` sub-path exporting `InMemorySigningProvider`
  and `signerKeyToProvider`. Constructor refuses to instantiate when
  `NODE_ENV=production` unless `ADCP_ALLOW_IN_MEMORY_SIGNER=1` is set.

`AgentRequestSigningConfig` is now a discriminated union on `kind`:
- `kind: 'inline'` (default — `kind` is optional on this shape so existing
  literals work unchanged) holds a private JWK in process.
- `kind: 'provider'` delegates `sign()` to a `SigningProvider`.

`buildAgentSigningContext` defensively hashes the provider-supplied
`fingerprint` together with `algorithm` and `kid` before composing
transport- and capability-cache keys, preserving the multi-tenant isolation
property the in-memory path has always provided. The signing identity is
snapshotted at context-build time so a provider object whose fields drift
between build and outbound request cannot desynchronize the on-wire `keyid`
from the cache key the connection was bound to.

**Behavior change for non-UTF-8 byte bodies:** `createSigningFetch` and
`createSigningFetchAsync` now throw `TypeError` on `Uint8Array` /
`ArrayBuffer` request bodies that aren't valid UTF-8. Previously, invalid
bytes were silently replaced with U+FFFD by `Buffer.toString('utf8')` —
verification still passed because the wire and the digest agreed on the
lossy string, but the seller received mangled content. Callers hitting
this should pass a string body, ensure their bytes are UTF-8, or sign
manually with `signRequest` / `signRequestAsync` against the exact wire
bytes they intend to send. Error message names the escape hatch.

Wire format unchanged. No AdCP version bump.

A reference GCP KMS adapter ships at `examples/gcp-kms-signing-provider.ts`,
type-checked under `npm run typecheck:examples`. AWS KMS and Azure Key Vault
adapters can mirror the same pattern; users `npm i` the cloud SDK they need.

See adcontextprotocol/adcp-client#1009.
