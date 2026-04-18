---
'@adcp/client': minor
---

RFC 9421 request-signing profile (AdCP 3.0 optional). Adds `@adcp/client/signing`
with signer, verifier, Express-shaped middleware, pluggable JWKS/replay/revocation
stores, and typed error taxonomy (`RequestSignatureError`). Passes all 28 spec
conformance vectors shipped in `compliance/cache/latest/test-vectors/request-signing/`
(one positive vector currently skipped pending upstream adcp#2335 tarball
republish — test auto-unskips when `npm run sync-schemas` pulls the fixed
vector). Verifier uses the received `Signature-Input` substring verbatim when
rebuilding the signature base, so peers emitting params in any legal RFC 8941
order remain byte-identical. Replay TTL floored at one max-window + skew so
short-validity signers can't escape the replay horizon. Content-Digest parses
as an RFC 9530 dictionary (accepts `sha-256` alongside other algorithms).
JWKS-returns-wrong-kid and Content-Length-without-rawBody both reject as typed
errors. New CLI: `adcp signing generate-key` (suppresses private JWK from
stdout when `--private-out` is set) and `adcp signing verify-vector`.
