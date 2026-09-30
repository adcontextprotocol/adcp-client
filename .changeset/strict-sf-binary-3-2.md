---
'@adcp/sdk': patch
---

fix(signing): reject Base64URL sf-binary under the AdCP 3.2 request-signing profile (#3073).

A verifier pinned to AdCP 3.2 (`adcpVersion`, or the `createAdcpServer` auto-wired verifier on a 3.2 server) now parses `Signature` and `Content-Digest` only as RFC 8941 padded standard Base64, regardless of `covers_content_digest`. A Base64URL `Signature` fails with `request_signature_header_malformed` at checklist step 1, before the window and crypto checks, so `profile-3.2/negative/001-base64url-sf-binary` passes even when graded at a live clock. A Base64URL or unpadded `Content-Digest` fails with `request_signature_header_malformed` instead of `request_signature_digest_mismatch`. The whole `Signature` dictionary is parsed strictly, and standard Base64 whose byte length needs no `=` padding is now accepted.

This removes the SDK 14 rolling-upgrade fallback in which a 3.2-pinned verifier with internal `covers_content_digest: 'either'` also accepted SDK 13 Base64URL signatures. The spec forbids a 3.2 verifier from retrying a legacy token. Serve legacy signers from an endpoint pinned to 3.0/3.1 instead. Verifiers pinned to 3.0/3.1 and unpinned verifiers keep accepting both serializations. Endpoints that advertise 3.2 must pass a trusted `adcpVersion`: an unpinned verifier cannot tell a legacy request from the 3.2 negative vector.
