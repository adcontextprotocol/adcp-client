---
'@adcp/sdk': patch
---

OAuth diagnostics: `decodeAccessTokenClaims` now decodes the JWT header and claims with `jose` (`decodeProtectedHeader`, `decodeJwt`) instead of a hand-written base64url decoder, and `adcp diagnose-auth` checks the audience of the token it already decoded rather than re-encoding it into a synthetic JWT. The function still never verifies a signature. Tokens that are not RFC 7515 compact serializations now return `null` (reported as opaque) instead of being decoded leniently. That covers segments with characters outside the base64url alphabet (including a standard-alphabet header), non-UTF-8 JSON, and a claims set that is not a JSON object. Well-formed JWTs decode exactly as before.
