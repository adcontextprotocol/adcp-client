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
  Content-Digest headers covered by the signature, a non-ASCII
  authority (U-label), or userinfo on the `@authority` component.
- Step 8 binds sig-params `alg` to the resolved JWK's `alg`: a missing
  JWK `alg`, an alg mismatch, or inconsistent kty/crv per RFC 8037
  (EdDSA↔OKP) / RFC 7518 (ES256↔EC/P-256) all fail with
  `request_signature_key_purpose_invalid`.
- Compliance test-vector loader accepts `jwks_override` as an
  alternative to `jwks_ref`; the grader routes `jwks_override` vectors
  through the library verifier directly since a live HTTP probe can't
  mutate a target agent's JWKS per-vector.
