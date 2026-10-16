---
'@adcp/sdk': patch
---

Identity 3.3 (experimental): `signWebBotAuth` and `createSignedSignatureDirectory` now build the RFC 9421 signature base and serialize `Signature-Input` / `Signature` with Cloudflare's `http-message-sig` (Apache-2.0, already the interop reference) instead of hand-written code. `http-message-sig@0.3.0` moves from a dev dependency to a runtime dependency; it shares the pinned `structured-headers@2.0.3`. Output is byte-identical: the Cloudflare interop fixtures and the Web Bot Auth profile vectors are unchanged. Two signer-side edge cases differ: a target URL with a fragment is now signed without it (the fragment never reaches the wire, so such signatures previously failed verification), and a covered field with non-ASCII content is refused with the library's `SignatureError`. Verification is unchanged and stays hand-written until the wire rules in adcontextprotocol/adcp#7894 are final.
