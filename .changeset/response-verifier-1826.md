---
'@adcp/sdk': minor
---

signing: add `verifyResponseSignature` for RFC 9421 §2.2.9 response verification (#1826)

Closes out the response-signing direction. `signResponse` (shipped in #1823)
emits the signed payload; `verifyResponseSignature` consumes it. Buyer
clients can now verify a seller's signed response before parsing the body
without reimplementing ~200 LOC of canonicalization.

```ts
import { verifyResponseSignature, StaticJwksResolver } from '@adcp/sdk/signing/server';

const result = await verifyResponseSignature(
  {
    status: 200,
    headers: response.headers,
    body: await response.text(),
    request: { method: 'POST', url: 'https://seller.example.com/adcp/get_products' },
  },
  {
    jwks: new StaticJwksResolver(sellerJwks),
    replayStore: new InMemoryReplayStore(),
    revocationStore: new InMemoryRevocationStore(),
  }
);
// result.status === 'verified', result.keyid === '<kid>'
```

13-step checklist mirroring `verifyWebhookSignature`:

1. Both signature headers present + parseable
2. Required params (`created`, `expires`, `nonce`, `keyid`, `alg`, `tag`)
3. Tag match (`adcp/response-signing/v1`, override via `requiredTag`)
4. Alg allowlist (Ed25519, ECDSA-P256-SHA256)
5. Window validity (expired / negative-window / future-created folded to
   `response_signature_window_invalid`)
6. Covered components include `RESPONSE_MANDATORY_COMPONENTS` (`@status`,
   `@authority`, `@target-uri`); `content-digest` required when body present
6a. `@target-uri` syntactic validation against the originating-request URL
    (rejects non-https / userinfo / fragment; loopback hosts exempt for
    local mock-server testing)
7. JWKS resolution by `keyid`
8. Key purpose — `adcp_use: 'response-signing'` + `verify` key_op. Split:
   missing/unscoped → `response_signature_key_purpose_invalid`; declared
   but wrong → `response_mode_mismatch`
9. Revocation
9a. Per-keyid rate abuse
10. Cryptographic verify (uses `buildResponseSignatureBase` + verbatim
    `signatureParamsValue` for cross-SDK byte-identity)
11. Content-Digest recompute match
13. Replay-nonce commit AFTER every earlier step passes — external traffic
    can't grow the replay cap because failed signatures don't reach commit

Same ordering invariants as the request and webhook verifiers (cheap
checks before JWKS resolution; revocation + rate-abuse before crypto;
replay commit last). Same security posture, same store semantics
(`InMemoryReplayStore` for single-process; pass an explicit shared store
for multi-replica).

`createResponseVerifier(options)` factory returns a bound verifier with
shared replay / revocation stores — call it once at wire-up and reuse for
every inbound response.

**Error codes added** (`ResponseSignatureErrorCode`):
`response_signature_header_malformed`, `response_signature_params_incomplete`,
`response_signature_tag_invalid`, `response_signature_alg_not_allowed`,
`response_signature_window_invalid`, `response_signature_components_incomplete`,
`response_target_uri_malformed`, `response_signature_key_unknown`,
`response_signature_key_purpose_invalid` (already shipped in #1825),
`response_mode_mismatch`, `response_signature_key_revoked`,
`response_signature_revocation_stale`, `response_signature_rate_abuse`,
`response_signature_invalid`, `response_signature_digest_mismatch`,
`response_signature_replayed`.

Same shape as `WebhookSignatureErrorCode` so adopters who already handle
the webhook taxonomy get muscle memory.
