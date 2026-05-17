---
'@adcp/sdk': minor
---

signing: add `signResponse` for RFC 9421 §2.2.9 response signing (#1822)

Rounds out the signing surface — `signRequest` (buyer→server), `signWebhook`
(server→receiver), and now `signResponse` (server→buyer) all share the same
prepare/finalize shape and `SigningProvider` async path.

```ts
import { signResponse, type ResponseLike } from '@adcp/sdk/signing/client';

const response: ResponseLike = {
  status: 200,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ products: [...] }),
  // Originating request — needed to bind @authority back to its origin.
  request: { method: 'POST', url: 'https://seller.example.com/adcp/get_products' },
};

const signed = signResponse(response, key);
// signed.headers now carries Signature, Signature-Input, Content-Digest.
```

Covered components default to `['@status', '@authority', '@target-uri']`,
plus `content-type` + `content-digest` automatically when the response
carries a body. `@target-uri` is in the defaults (not opt-in) so a
multi-tenant seller can't emit signatures interchangeable across endpoints
sharing the same authority — matches RFC 9421 §B.2.5 examples. Callers
that need to extend the covered set further (`@method`, custom headers)
opt in via `additionalComponents`.

**Asymmetry vs `signRequest`.** Response-signing defaults `coverContentDigest`
to `true` when the response has a body (opt-out); request-signing requires
an explicit `coverContentDigest: true` (opt-in). The asymmetry is deliberate:
an unbound response body is the most common cross-purpose footgun for
response signing (attacker can swap payload but keep headers + signature).
Webhook signing also forces content-digest unconditionally for the same
reason.

Async + KMS-shaped path: `signResponseAsync(response, provider)` delegates the
crypto to the existing `SigningProvider` interface; the prepare/finalize split
(`prepareResponseSignature` / `finalizeResponseSignature`) is exported for
callers that need to hand the canonical base to an external signer.

Tag: `adcp/response-signing/v1`. **Wire-format contract is provisional**
until `verifyResponseSignature` (follow-up) lands and is exercised against
external SDK implementations. The `v1` suffix gives a clean break path —
any breaking change ships as `v2` and verifiers reject `v1`. Adopters
shipping signed responses today should pin a major SDK version. `AdcpUse`
extended with `'response-signing'` so JWK metadata can declare the binding
now.

**Note on `AdcpUse` widening:** the `AdcpUse` union now includes
`'response-signing'`. Consumers with exhaustive `switch (use)` blocks
backed by `never` checks will need to add a `case 'response-signing':`
arm. Pragmatically a minor bump — the runtime surface is purely additive
and no existing call site changes — but exhaustive narrowers must opt-in
to handle the new member.

**Signer-side `adcp_use` purpose binding (closes #1825).** All three sync
signer entry points now refuse keys whose `adcp_use` doesn't match the
helper:

- `signRequest` requires `adcp_use: 'request-signing'`
- `signWebhook` requires `adcp_use: 'webhook-signing'`
- `signResponse` requires `adcp_use: 'response-signing'`

Mismatch (including a missing `adcp_use`) throws at the signer with the
same error code the verifier raises at step 8 (`*_signature_key_purpose_invalid`),
so misconfiguration surfaces at configuration time rather than at the
receiver. Production callers using `pemToAdcpJwk({ adcp_use: ... })` to
mint keys are already correct by construction; anyone reusing a key
across purposes will get a clear remediation message.

Test-vector authors that need to *deliberately* sign with a wrong-purpose
key (e.g. AdCP negative-vector 009 cross-purpose rejection) can compose
the lower-level `prepareRequestSignature` + `finalizeRequestSignature`
helpers directly — those take a `SignatureIdentity` and skip the gate
because they're designed for KMS-shaped async paths where purpose
binding happens via the `SigningProvider`. The internal storyboard
builder uses this composition pattern; see
`src/lib/testing/storyboard/request-signing/builder.ts` for the
canonical shape.
