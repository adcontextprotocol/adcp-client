---
'@adcp/sdk': patch
---

Identity 3.3 (experimental): `signWebBotAuth` and `createSignedSignatureDirectory` now build the RFC 9421 signature base and serialize `Signature-Input` / `Signature` with Cloudflare's `http-message-sig` (Apache-2.0, the package the interop tests already use) instead of hand-written code. `http-message-sig@0.3.0` moves from a dev dependency to a runtime dependency. It depends on `structured-headers@2.0.3`, the exact version the SDK pins, so one copy is installed; bump the two together.

Signed output is byte-identical: the Cloudflare interop fixtures and the Web Bot Auth profile vectors are unchanged, and relays still refuse to sign over earlier signatures the profile cannot verify. Signer-side differences, all for input that never verified:

- A target URL with a fragment is signed without it. The fragment never reaches the wire, so these signatures used to fail verification.
- A covered field that is not RFC 9110 field content (control characters, non-ASCII) or a method that is not a token now throws `WebBotAuthError` (400, `component_value`) instead of being signed.
- A non-finite `now()` throws `TypeError('Invalid Web Bot Auth clock')`.

Verification is unchanged. It stays hand-written until adcontextprotocol/adcp#7894 settles the wire rules.
