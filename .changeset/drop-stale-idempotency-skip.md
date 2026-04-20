---
'@adcp/client': minor
---

Request-signing verifier: tighten RFC 9421 conformance against new spec
vectors (#2323) and adcp#2468.

- `@target-uri` canonicalization now decodes percent-encoded unreserved
  bytes (RFC 3986 §6.2.2.2) so `%7E` and `~` produce a byte-identical
  signature base.
- Verifier rejects at step 1 when a signed request carries duplicate
  Signature-Input dictionary keys, multi-valued Content-Type or
  Content-Digest headers covered by the signature, or a non-ASCII
  authority (U-label).
- Step 8 key-purpose check enforces JWK alg/kty/crv consistency (RFC
  8037 / RFC 7518) — a JWK declaring `alg=EdDSA` with `kty=EC` is
  rejected with `request_signature_key_purpose_invalid`.
- Compliance test-vector loader accepts `jwks_override` as an
  alternative to `jwks_ref` for vectors shipping an inline, deliberately
  malformed JWK.
