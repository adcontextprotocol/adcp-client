---
'@adcp/sdk': minor
---

signing: extend `SigningProvider` with optional `adcpUse` for async-path purpose binding (#1827)

Closes the asymmetry between sync and async signing paths flagged by the security + protocol reviews of #1823 / #1832. Sync helpers (`signRequest`, `signWebhook`, `signResponse`) refuse keys with wrong `adcp_use` via `assertKeyPurpose`. Async helpers (`signRequestAsync` / `signWebhookAsync` / `signResponseAsync`) could not enforce because `SigningProvider` exposed `keyid` + `algorithm` but no purpose binding — KMS adapters were unprotected against IAM-mistake cross-purpose reuse, the exact situation where signer-side defense-in-depth matters most.

```ts
import { signResponseAsync } from '@adcp/sdk/signing/client';

const provider = new InMemorySigningProvider({
  keyid: 'kid_42',
  algorithm: 'ed25519',
  privateKey: privateJwk,
  adcpUse: 'response-signing',  // NEW — enforced at the gate
});

await signResponseAsync(response, provider);
// Throws ResponseSignatureError('response_signature_key_purpose_invalid')
// if you call signRequestAsync or signWebhookAsync with this provider.
```

**Optional and backward-compatible.** Providers that omit `adcpUse` skip the gate — no breakage for adapters that pre-date this field. Adapter authors who want defense-in-depth set it; the async helpers then enforce purpose binding parallel to the sync path with the same error codes (`*_signature_key_purpose_invalid` at step 8).

`InMemorySigningProvider` auto-inherits `adcpUse` from `privateKey.adcp_use` when present, so keys minted via `pemToAdcpJwk({ adcp_use: ... })` get the binding for free. Explicit `adcpUse` option on the provider constructor takes precedence — useful when the test key material doesn't match the helper being exercised.

9 new tests across all three async helpers covering match / mismatch / explicit-override paths.
