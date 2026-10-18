---
'@adcp/sdk': minor
---

Experimental AdCP 3.3 identity: align Web Bot Auth verification with what Cloudflare's `web-bot-auth` accepts. These changes affect the experimental `@adcp/sdk/identity-3.3` surface only; the RFC 9421 profile is unchanged.

- **Other signatures are not read.** `verifyWebBotAuth` selects the one `Signature-Input` member tagged `web-bot-auth` and ignores members with other tags, which WBA section 5.2.2 allows. A second `web-bot-auth` member or a second `Signature-Agent` member is still a 403.
- **Unusable directory keys are ignored.** `verifyKeyDirectory` and `SignatureDirectoryResolver` skip a key the profile cannot use, such as a P-256 key, together with any signature it made (RFC 7517 section 5). Every usable key must still sign the directory. A directory with no usable key is a discovery failure. Such a directory used to be refused with `directory_unsupported_key`.
- **Ed25519 only.** Web Bot Auth signs and verifies with Ed25519 keys only, as Cloudflare's edge and Rust crate do. RSA-PSS-SHA512 is removed from request signing and verification, from key-directory publishing and verification, and from origin revocation lists, which are signed and verified as `EdDSA` only. `signWebBotAuth`, `createSignedSignatureDirectory`, `createWebBotAuthFetch`, `createSignedOriginRevocationList`, and the server and webhook wire-up refuse an RSA key. A request with `alg="rsa-pss-sha512"` is a 403, and a verifier ignores an RSA key in a directory. The `rsa-pss-sha512` branches are removed from the signing crypto helpers, which only Web Bot Auth used. ES256 stays on the AdCP RFC 9421 profile, which is unchanged.
