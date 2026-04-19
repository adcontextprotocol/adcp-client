---
'@adcp/client': patch
---

Signing: swap hand-rolled `Signature-Input` / `Signature` / `Content-Digest`
parsers for the maintained `structured-headers` library (RFC 8941 / RFC 9651).
Cuts ~90 lines of bespoke state-machine code and inherits the library's
coverage of the dictionary/inner-list/token/escape corners we weren't
exercising. AdCP-profile checks (required params, tag match, alg allowlist,
quoted-string typing for `nonce`/`keyid`/`alg`/`tag`, integer typing for
`created`/`expires`) stay in this package as thin typed wrappers. Signature
byte-sequence values remain base64url-tolerant, and `Content-Digest` keeps
its regex fallback so a malformed filler member (e.g. truncated `sha-512`)
does not mask the `sha-256` entry we verify against. Closes #581.
