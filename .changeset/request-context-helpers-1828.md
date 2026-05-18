---
'@adcp/sdk': minor
---

signing: add `requestContextFromExpress` / `-Fetch` / `-Lambda` helpers (#1828)

Closes #1828. Makes the safe path the default path for constructing `ResponseLike.request` (and any other RFC 9421 binding that needs an originating-request URL) on each major Node platform.

The JSDoc warning on `ResponseLike.request.url` (shipped in #1823) flags the trap: under proxy termination, `req.protocol` lies and `req.get('host')` is attacker-controllable. JSDoc warnings rot. These helpers enforce the hardening at construction time.

```ts
import { requestContextFromExpress, signResponse } from '@adcp/sdk/signing/client';

app.post('/adcp/get_products', (req, res) => {
  const signed = signResponse(
    {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body,
      request: requestContextFromExpress(req, {
        hostAllowlist: ['seller.example.com'],
      }),
    },
    key
  );
  res.set(signed.headers).send(body);
});
```

**Three helpers:**

- `requestContextFromExpress(req, options)` — throws when `Host` is missing / not in `hostAllowlist`, or when `req.protocol` is not `https` (unless `forceHttps: false` for local dev). **You MUST configure `app.set('trust proxy', ...)`** with your trusted proxy IPs; the helper trusts what Express tells it.
- `requestContextFromFetch(request)` — passes through `method` + `url` from a WHATWG `Request`. Trivial; included for API symmetry. No proxy hardening needed (Workers / Deno / Bun terminate TLS at the edge and own URL construction).
- `requestContextFromLambda(event, options)` — reads `requestContext.domainName` for authority, `rawPath` + `rawQueryString` (v2 / ALB) or `path` + `queryStringParameters` (v1) for the target. Always emits `https://` — Lambda isn't HTTP-addressable through API Gateway / ALB. `hostAllowlist` catches multi-tenant API Gateway misroutes.

Exported from both `@adcp/sdk/signing/client` (signer-side adopters) and `@adcp/sdk/signing/server` (verifier-side adopters reconstructing the originating-request URL for `verifyResponseSignature`).

18 tests covering happy path, host-allowlist enforcement, protocol enforcement, query-string preservation + URL encoding, and an end-to-end Express helper → `signResponse` → `verifyResponseSignature` round-trip.
