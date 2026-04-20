---
'@adcp/client': minor
---

Add `requireSignatureWhenPresent(signatureAuth, fallbackAuth)` — presence-gated composition for RFC 9421 signatures (#659)

`anyOf(verifyApiKey, verifySignatureAsAuthenticator)` has either-or
semantics: a request with a valid bearer and a present-but-invalid
signature is accepted because `anyOf` catches the sig adapter's
`AuthError` and falls through. That's wrong for the `signed-requests`
specialism, whose conformance vectors include negatives like
`request_signature_revoked` and `request_signature_window_invalid`
that must reject even when a bearer is also supplied.

`requireSignatureWhenPresent` encodes the spec-compliant contract:

| RFC 9421 signature header present? | Outcome                           |
|------------------------------------|-----------------------------------|
| yes                                | signature authenticator runs; principal / `AuthError` / `null→AuthError` is final — fallback never runs |
| no                                 | fallback runs verbatim            |

Presence is detected from either `Signature-Input` OR `Signature` — a
request with only one of the pair is malformed but still signed intent
and MUST NOT silently fall through to bearer. The existing
`verifySignatureAsAuthenticator` adapter now recognizes the same pair
(previously it required `Signature-Input`; a solo `Signature` header
incorrectly fell through).

The composed authenticator propagates `AUTH_NEEDS_RAW_BODY` when either
branch needs it, so `serve()` still buffers `req.rawBody` ahead of
authentication.

**Composition guard**: the returned authenticator is tagged
`AUTH_PRESENCE_GATED`; `anyOf` throws at wire-up time when any child
carries the tag, because wrapping would re-open the bypass the gate
exists to prevent. Invert the order instead:
`requireSignatureWhenPresent(sig, anyOf(bearer, apiKey))`.

```ts
import {
  serve,
  anyOf,
  verifyApiKey,
  verifyBearer,
  verifySignatureAsAuthenticator,
  requireSignatureWhenPresent,
} from '@adcp/client/server';

serve(createAgent, {
  authenticate: requireSignatureWhenPresent(
    verifySignatureAsAuthenticator({ jwks, replayStore, revocationStore, capability, resolveOperation }),
    anyOf(verifyApiKey({ keys }), verifyBearer({ jwksUri, issuer, audience })),
  ),
});
```

New public exports: `requireSignatureWhenPresent`, `AUTH_PRESENCE_GATED`,
`tagAuthenticatorPresenceGated`, `isAuthenticatorPresenceGated`.
