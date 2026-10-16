---
'@adcp/sdk': patch
---

Signing: the RFC 9421 signer now serializes `Signature-Input` (`formatSignatureParams`), `Signature` and `Content-Digest` with `structured-headers`, the parser the verifier already uses, instead of string templates. The request-signing grader's parameter lists move to the serializer too.

For every value the profile can carry, the output is byte-identical. The request-signing, webhook and response vectors are unchanged. The AdCP 3.0/3.1 Base64URL byte-sequence form is not an RFC 8941 `sf-binary`, so it stays hand-written.

Input that could never verify is now refused up front instead of producing a malformed field:

- **Parameters:** a `keyid`, `nonce`, `alg` or `tag` containing a control character or non-ASCII throws `TypeError` from `formatSignatureParams`.
- **Labels:** a label that is not an RFC 8941 key (`^[a-z*][a-z0-9_.*-]*$`) throws `TypeError` before signing.
- **Clock:** a `now()` that does not return integer epoch seconds throws `TypeError` before signing.

A `"` or `\` in a string parameter is now escaped rather than ending the string, so it can no longer inject a second parameter.
