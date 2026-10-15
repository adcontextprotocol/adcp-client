---
'@adcp/sdk': patch
---

Experimental AdCP 3.3 Web Bot Auth fixes (follow-up to #3244), aligned with DR-0023 and WBA §5.5/§6.10, and interoperable with Cloudflare's `web-bot-auth`:

- `verifyWebBotAuth` needs only key discovery and a replay store. Revocation, bindings and the origin-binding fence move to the identity layer (`createIdentity33PrincipalResolver({ revocation })`); `isRevoked`, `requireFreshRevocation` and `deferAuthorizationErrors` are deprecated.
- Signature-path errors are WBA statuses and headers with the generic `AUTH_INVALID` body. A key-directory fetch failure is a discovery failure that never evicts cached keys and otherwise leaves the request unverified (403 with `Accept-Signature`). A revoked key is 403 without a challenge. Unknown revocation status leaves the identity unverified, and an origin serving no list cannot be bound for spend. Replay and history-store failures are `WebBotAuthUnavailableError`, answered 503 by the server integrations.
- Plain JWKS key directories are accepted, checked by thumbprint, unless `requireSignedDirectories`.
- `@target-uri` and `@authority` use the target URI as received. Default nonces are 64 bytes. RSA-PSS-SHA512 keys are supported. Interop tests and shared fixtures against `web-bot-auth@0.2.0` / `http-message-sig@0.3.0` are added.
- Replay caches keep a nonce through the inclusive end of the acceptance window (WBA, RFC 9421 request and webhook verifiers). Directory, signing-fetch and webhook-receiver bodies keep a UTF-8 BOM. Signed directories backdate `created` by 60 seconds and verifiers tolerate that skew. A request missing `Signature-Agent`, `Signature-Input` or `Signature` is a 403. `signWebBotAuth` refuses to replace existing signature fields unless `relay: true`.
- Type changes in the experimental surface: `WebBotAuthError.status` is `400 | 403 | 429`, `VerifiedSignatureDirectory` adds `signed`, `VerifyWebBotAuthOptions.isRevoked` and `webhookVerification.webBotAuth.isRevoked` are optional (the latter gains `revocation`), and `WebBotAuthUnavailableError` / `verifyKeyDirectory` are exported. RSA keys must be 2048–4096 bits with e = 65537.
