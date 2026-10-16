---
'@adcp/sdk': patch
---

OAuth diagnostics: `decodeAccessTokenClaims` now decodes the JWT header and claims with `jose` (`decodeProtectedHeader`, `decodeJwt`) instead of a hand-written base64url decoder. `adcp diagnose-auth` now checks the audience of the token it already decoded instead of re-encoding it into a synthetic JWT. As before, nothing is verified. Well-formed JWTs decode exactly as before.

Tokens that are not RFC 7515 compact serializations now return `null` and are reported as opaque, instead of being decoded leniently. That covers:

- segments with characters outside the base64url alphabet, including a standard-alphabet header;
- non-UTF-8 JSON;
- a header or claims set that is not a JSON object.

The `@adcp/sdk/auth` entry point now loads `jose` when it is imported. The other entry points already did. `jose` is ESM-only, so this entry, like the others, needs a runtime that supports `require(esm)` when loaded from CommonJS, which the declared Node engines do.
