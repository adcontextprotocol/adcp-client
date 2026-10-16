---
'@adcp/sdk': patch
---

Signing: the RFC 9421 signer now serializes `Signature-Input` (`formatSignatureParams`), `Signature` and `Content-Digest` with `structured-headers` instead of string templates, as the request-signing grader does for parameter lists. Output is byte-identical for every value the profile can carry; the request-signing vectors and webhook signing vectors are unchanged. The AdCP 3.0/3.1 Base64URL byte-sequence form is not an RFC 8941 `sf-binary` and stays hand-written. Values that never formed a valid field now throw the serializer's error rather than producing a malformed header: a non-ASCII `keyid`/`nonce`/`tag`, a label that is not an RFC 8941 key on the 3.2 profile, or an integer outside the RFC 8941 range. A `"` or `\` in a string parameter is now escaped.
