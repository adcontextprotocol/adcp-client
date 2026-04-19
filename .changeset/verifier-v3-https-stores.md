---
'@adcp/client': major
---

Verifier API v3 + HTTPS-fetching JWKS / revocation stores. Closes #583
(items 1 and 2) and closes #584.

## Breaking changes

**`verifyRequestSignature` return shape** — now a discriminated union:

```ts
type VerifyResult =
  | { status: 'verified'; keyid: string; agent_url?: string; verified_at: number }
  | { status: 'unsigned'; verified_at: number };
```

Pre-3.x returned a `VerifiedSigner` with `keyid: ''` as a sentinel when the
request was unsigned on an operation not in `required_for`. Consumers that
branched on `result.keyid === ''` must now branch on `result.status`.

`createExpressVerifier` updates `req.verifiedSigner` accordingly — the field
is set only when `status === 'verified'`. Handlers that read
`req.verifiedSigner !== undefined` continue to work (they were incorrect on
the old `keyid: ''` sentinel path, which we've now eliminated).

**`VerifyRequestOptions.operation` is now optional.** Passing it remains
the correct behavior for middleware-driven verification; when omitted, the
verifier treats the operation as "not in any `required_for`" and returns an
unsigned result. Use this for always-verify mode where the application
layer rejects the unsigned case itself.

**`ExpressMiddlewareOptions.resolveOperation` may now return `undefined`.**
Previously typed `(req) => string`. Callers that want to accept unsigned
requests for specific paths (health checks, discovery) can return
`undefined` to bypass `required_for` enforcement without losing verifier
coverage on signed paths.

## New

- **`HttpsJwksResolver(url, options)`** — fetches a JWKS from an HTTPS URL
  and caches it in memory. Key-unknown triggers a lazy refetch (honoring a
  30s minimum cooldown), so a counterparty rotating its keys is picked up
  without a process restart. Respects `ETag` (`If-None-Match`) and
  `Cache-Control: max-age`. Runs through `ssrfSafeFetch` so IMDS / private
  networks are refused.
- **`HttpsRevocationStore(url, options)`** — caches a `RevocationSnapshot`
  in memory and refreshes when `now > next_update`. Fails closed with
  `request_signature_revocation_stale` when the snapshot is past
  `next_update + graceSeconds` (default 300s). SSRF-guarded.
- **`request_signature_revocation_stale`** added to
  `RequestSignatureErrorCode`, with `failedStep: 9`. Middleware returns
  it as a 401 the same as any other verifier error.

## Migration

```ts
// Before (2.x):
if (verified.keyid) {
  // signed
}

// After (3.x):
if (result.status === 'verified') {
  // signed — result.keyid is non-empty
}
```
