---
'@adcp/sdk': minor
---

signing: widen `AdcpUse` to include `'governance-signing'` (#1844)

The `AdcpUse` union now reads:

```ts
export type AdcpUse =
  | 'request-signing'
  | 'webhook-signing'
  | 'response-signing'
  | 'governance-signing';
```

AdCP deployments have been minting JWKs with `adcp_use: 'governance-signing'`
for JWS-signed governance context since governance-signing landed pre-7.0,
and the training agent publishes one in its aggregated JWKS today. JSON-level
consumers were unaffected (the JWK `adcp_use` field is open `string`), but
typed third-party verifiers narrowing on `AdcpUse` had to cast around the
missing member.

This is an additive enum widening — technically breaking only for exhaustive
narrowers; same semver disposition as #1823. The RFC 9421 helpers
(`signRequest` / `signWebhook` / `signResponse`) refuse to sign with a
`'governance-signing'` key, since governance signing is JWS-based and lives
on a different code path; a `signGovernanceContext` helper and matching
verifier surface remain out of scope for this change.
