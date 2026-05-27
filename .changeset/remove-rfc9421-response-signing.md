---
'@adcp/sdk': minor
---

breaking: remove the preview RFC 9421 transport response-signing surface from the beta line

AdCP 3.x does not authorize generic RFC 9421 §2.2.9 transport response signing. The SDK no longer exports `signResponse`, `signResponseAsync`, `verifyResponseSignature`, `createResponseVerifier`, `ResponseSignatureError`, `RESPONSE_SIGNING_TAG`, `RESPONSE_MANDATORY_COMPONENTS`, `buildResponseSignatureBase`, `ResponseLike`, `prepareResponseSignature`, `finalizeResponseSignature`, `SignResponseOptions`, `PreparedResponseSignature`, `SignedResponse`, the response-verifier option/result types, or the `'response-signing'` JWK purpose.

Runtime helpers also reject the retired purpose: `pemToAdcpJwk({ adcp_use: 'response-signing' })` and `mintEphemeralEd25519Key({ adcp_use: 'response-signing' })` now throw, and `InMemorySigningProvider` preserves retired or unknown raw purpose strings so `signRequestAsync()` and `signWebhookAsync()` still fail closed instead of silently treating the key as unscoped.

Request signing and webhook signing are unchanged. There is no conformant AdCP 3.x replacement for generic transport response signing; future designated-task payload JWS support should land under a fresh spec-defined purpose and helper surface.
