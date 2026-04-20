---
'@adcp/client': minor
---

`BrandJsonJwksResolver` — discover a sender's webhook-signing keys from their `brand.json`.

Receiver-side ergonomic: instead of pre-configuring a `jwks_uri` per counterparty, point the verifier at the sender's `brand.json` and the resolver walks `agents[]`, extracts the right `jwks_uri`, and delegates caching to `HttpsJwksResolver`. Delivers the `brand.json → JWKS auto-resolver` piece of the #631 follow-up list.

**New**

- `BrandJsonJwksResolver` — implements `JwksResolver`, pluggable into `verifyWebhookSignature.jwks` (or `verifyRequestSignature.jwks`).
- `BrandJsonResolverError` + `BrandJsonResolverErrorCode` — typed error surface (`invalid_url`, `invalid_house`, `redirect_loop`, `redirect_depth_exceeded`, `fetch_failed`, `invalid_body`, `schema_invalid`, `agent_not_found`, `agent_ambiguous`, `jwks_origin_mismatch`). Verifier callers can fold transient failures into `webhook_signature_key_unknown` without parsing error message strings.
- `BrandAgentType`, `BrandJsonJwksResolverOptions` — selector types (agent type plus optional `agentId` / `brandId`).

**Behavior**

- Follows `authoritative_location` and `house` redirect variants up to `maxRedirects` hops (default 3); loops and depth-exceeded chains are rejected explicitly.
- Structurally validates every redirect target (scheme, no userinfo, no fragments smuggled into loop detection) before dispatch; the `house` string variant is gated on a bare-hostname regex so an attacker-supplied brand.json can't inject userinfo or paths via the `https://${house}/…` interpolation.
- Honors the spec fallback: when `jwks_uri` is absent on the selected agent, defaults to `/.well-known/jwks.json` on the origin of the agent's `url` — **but only when that origin matches the final brand.json origin**. Cross-origin fallback is rejected with `jwks_origin_mismatch`; publishers hosting their agent on a different origin must declare an explicit `jwks_uri`.
- Brand.json cache tracks `ETag` + `Cache-Control: max-age` (capped by `maxAgeSeconds`, default 1h). Unknown `kid` cascades: the inner JWKS refreshes first; if still unknown and the brand.json cooldown has elapsed, brand.json re-resolves to pick up a rotated `jwks_uri`.
- Ambiguous selectors (multiple agents of the same type, no `agentId`) throw `agent_ambiguous` with a clear error listing the candidate ids.
- All fetches go through `ssrfSafeFetch`, so an attacker-supplied brand.json or JWKS URL can't resolve to the receiver's private network or IMDS.

**Example**

```typescript
import { BrandJsonJwksResolver, verifyWebhookSignature, InMemoryReplayStore, InMemoryRevocationStore } from '@adcp/client/signing';

const jwks = new BrandJsonJwksResolver('https://publisher.example/.well-known/brand.json', {
  agentType: 'sales',
});

await verifyWebhookSignature(request, {
  jwks,
  replayStore: new InMemoryReplayStore(),
  revocationStore: new InMemoryRevocationStore(),
});
```
